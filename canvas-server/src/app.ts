import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { LOGIN_TRANSACTION_SECONDS, SESSION_IDLE_SECONDS, SESSION_SECONDS, type ServerConfig } from "./config.ts";
import { Gateway, GatewayError, publicMediaResponse, publicResourceResponse, type Fetcher, type Grant, type GrantState } from "./gateway.ts";
import { CredentialVault, digest, equalSecret, randomSecret, SESSION_COOKIE, TRANSACTION_COOKIE } from "./security.ts";
import { CanvasStorage, type LoginRow, type SessionRow } from "./storage.ts";

type Env = { Variables: { session: SessionRow; apiKey: string } };
export type SecurityAuditEvent = { timestamp: string; component: string; app: string; action: string; result: "success" | "failure"; code?: string; user_id?: number; subject_ref?: string; grant_ref?: string };
const cookieOptions = { secure: true, httpOnly: true, sameSite: "Lax" as const, path: "/" };
const safeId = /^[A-Za-z0-9_-]+$/;
// Matches the existing gateway taskArtifactKeyPattern contract.
const safeArtifact = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const safeSubject = /^ics_[a-f0-9]{32}$/;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const grantFailures: Record<string, [string, string]> = {
    user_disabled: ["USER_DISABLED", "当前用户已被禁用，请联系管理员"],
    user_deleted: ["USER_DISABLED", "当前用户已被删除，请联系管理员"],
    session_expired: ["AUTH_EXPIRED", "New API 登录会话已过期，请重新登录授权"],
    grant_expired: ["AUTH_EXPIRED", "画布授权已到期，请重新进入画布"],
    idle_expired: ["AUTH_EXPIRED", "长时间未操作，画布授权已过期，请重新进入画布"],
    session_revoked: ["AUTH_REVOKED", "New API 登录会话已退出或被撤销，请重新授权"],
    grant_revoked: ["AUTH_REVOKED", "画布授权已被撤销，请重新授权"],
    security_changed: ["AUTH_SECURITY_CHANGED", "账号安全设置已变更，请重新登录授权"],
};
const promptSources = new Set(["banana-prompt-quicker", "davidwu-gpt-image2-prompts", "freestylefly-gpt-image-2", "awesome-gpt-image", "awesome-gpt4o-image-prompts", "youmind-gpt-image-2", "youmind-nano-banana-pro"]);
const securityHeaders = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
};

export function createApp(config: ServerConfig, options: { storage?: CanvasStorage; fetch?: Fetcher; now?: () => number; publicResource?: typeof publicResourceResponse; publicMedia?: typeof publicMediaResponse; audit?: (event: SecurityAuditEvent) => void } = {}) {
    const storage = options.storage || new CanvasStorage(config.dataDir);
    const db = storage.db;
    const gateway = new Gateway(config, options.fetch);
    const vault = new CredentialVault(config.encryptionKey);
    const now = options.now || (() => Math.floor(Date.now() / 1000));
    const publicResource = options.publicResource || publicResourceResponse;
    const publicMedia = options.publicMedia || publicMediaResponse;
    const app = new Hono<Env>();
    const audit = (action: string, result: "success" | "failure", session?: SessionRow, code?: string, grantId?: string) => {
        const user = session ? JSON.parse(session.user_json) as { id: number; subject: string } : undefined;
        const event: SecurityAuditEvent = { timestamp: new Date(now() * 1000).toISOString(), component: "infinite-canvas", app: config.clientId, action, result };
        if (code) event.code = code;
        if (user) { event.user_id = user.id; event.subject_ref = digest(`canvas-audit-subject\0${user.subject}`).slice(0, 16); }
        if (grantId) event.grant_ref = digest(`canvas-audit-grant\0${grantId}`).slice(0, 16);
        if (options.audit) options.audit(event);
        else console.info(JSON.stringify(event));
    };

    let revoking: Promise<void> | undefined;
    const revokePending = (): Promise<void> => {
        if (revoking) return revoking;
        revoking = Promise.resolve().then(async () => {
            const attempted = new Set<string>();
            try {
                for (;;) {
                    const pending = (db.query("SELECT grant_id FROM pending_revocations").all() as { grant_id: string }[]).filter((row) => !attempted.has(row.grant_id));
                    if (!pending.length) return;
                    for (const row of pending) {
                        attempted.add(row.grant_id);
                        try {
                            await gateway.control("revoke", { grant_id: row.grant_id });
                            db.query("DELETE FROM pending_revocations WHERE grant_id = ?").run(row.grant_id);
                            audit("grant.revoke", "success", undefined, undefined, row.grant_id);
                        } catch {
                            audit("grant.revoke", "failure", undefined, "GATEWAY_REVOCATION_PENDING", row.grant_id);
                            // Failed entries wait for the next opportunity. New
                            // entries join this drain without retrying old failures.
                        }
                    }
                }
            } catch {
                audit("grant.revoke", "failure", undefined, "GATEWAY_REVOCATION_PENDING");
            } finally {
                // Release in the same turn as the empty check, before callers
                // can enqueue more work against a promise that has already ended.
                revoking = undefined;
            }
        });
        return revoking;
    };

    app.use("*", async (c, next) => {
        for (const [name, value] of Object.entries(securityHeaders)) c.header(name, value);
        // TLS may terminate at the dedicated Canvas Nginx ingress. Do not trust
        // arbitrary forwarded headers to select the application's public origin.
        if (c.req.path !== "/health" && new URL(c.req.url).host !== new URL(config.origin).host) return c.json({ error: { code: "ORIGIN_FORBIDDEN", message: "访问地址与画布配置不一致" } }, 403);
        await next();
        // Raw streaming/file Response objects replace prepared Hono headers.
        // Apply the security policy to the final response as well.
        for (const [name, value] of Object.entries(securityHeaders)) c.header(name, value);
    });

    app.onError((error, c) => {
        if (error instanceof GatewayError) {
            audit(c.req.path.startsWith("/auth/") ? "sso.login" : "authorization", "failure", c.get("session"), error.code);
            return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
        }
        if (error instanceof SyntaxError) return c.json({ error: { code: "INVALID_JSON", message: "请求格式无效" } }, 400);
        // Avoid logging request bodies, callback query strings, credentials or
        // exception messages that might contain an outbound URL or token.
        audit(c.req.path.startsWith("/auth/") ? "sso.login" : "request", "failure", c.get("session"), "INTERNAL_ERROR");
        console.error("Canvas request failed", { method: c.req.method, route: c.req.routePath });
        return c.json({ error: { code: "INTERNAL_ERROR", message: "画布服务暂不可用" } }, 500);
    });

    app.get("/health", (c) => c.json({ ok: true }));

    app.get("/auth/start", async (c) => {
        void revokePending();
        const transaction = randomSecret();
        const state = randomSecret();
        const verifier = randomSecret();
        const hash = digest(transaction);
        db.query("DELETE FROM login_transactions WHERE expires_at <= ?").run(now());
        db.query("INSERT INTO login_transactions VALUES (?,?,?,?)").run(hash, digest(state), await vault.seal(verifier, hash), now() + LOGIN_TRANSACTION_SECONDS);
        setCookie(c, TRANSACTION_COOKIE, transaction, { ...cookieOptions, maxAge: LOGIN_TRANSACTION_SECONDS });
        const authorization = new URL(`${config.gatewayPublicUrl}/canvas/authorize`);
        authorization.searchParams.set("client_id", config.clientId);
        authorization.searchParams.set("redirect_uri", `${config.origin}/auth/callback`);
        authorization.searchParams.set("state", state);
        authorization.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
        authorization.searchParams.set("code_challenge_method", "S256");
        audit("sso.start", "success");
        return c.redirect(authorization.href, 303);
    });

    app.get("/auth/callback", async (c) => {
        const transaction = getCookie(c, TRANSACTION_COOKIE);
        const states = c.req.queries("state");
        const codes = c.req.queries("code");
        if (!transaction || states?.length !== 1 || codes?.length !== 1 || !states[0] || !codes[0]) throw new GatewayError("AUTH_TRANSACTION_INVALID", 400, "授权事务无效，请重新进入画布");
        const hash = digest(transaction);
        const login = db.query("DELETE FROM login_transactions WHERE hash = ? AND state_hash = ? AND expires_at > ? RETURNING *").get(hash, digest(states[0]), now()) as LoginRow | null;
        if (!login) throw new GatewayError("AUTH_TRANSACTION_INVALID", 400, "授权事务已过期或被使用，请重新进入画布");
        deleteCookie(c, TRANSACTION_COOKIE, cookieOptions);
        const grant = await gateway.control<Grant>("exchange", { code: codes[0], redirect_uri: `${config.origin}/auth/callback`, code_verifier: await vault.open(login.verifier, hash) });
        if (!grant.grant_id || !grant.api_key || !Number.isSafeInteger(grant.user?.id) || grant.user.id <= 0 || typeof grant.user.subject !== "string" || !safeSubject.test(grant.user.subject) || !Number.isFinite(grant.expires_at) || grant.expires_at <= now()) throw new GatewayError("GATEWAY_PROTOCOL_ERROR", 502, "网关授权响应无效");
        const secret = randomSecret();
        const sessionHash = digest(secret);
        const previous = getCookie(c, SESSION_COOKIE);
        if (previous) {
            const old = storage.session(digest(previous));
            if (old) storage.retire(old);
        }
        try {
            const session: SessionRow = { hash: sessionHash, owner: `${new URL(config.gatewayPublicUrl).origin}|${grant.user.subject}`, grant_id: grant.grant_id, credential: await vault.seal(grant.api_key, sessionHash), csrf: randomSecret(), user_json: JSON.stringify(grant.user), expires_at: Math.min(now() + SESSION_SECONDS, grant.expires_at), last_active: now() };
            storage.createSession(session);
            c.set("session", session);
        } catch {
            db.query("INSERT OR IGNORE INTO pending_revocations VALUES (?)").run(grant.grant_id);
            void revokePending();
            throw new GatewayError("SESSION_SAVE_FAILED", 503, "画布会话保存失败，请重新授权");
        }
        void revokePending();
        setCookie(c, SESSION_COOKIE, secret, { ...cookieOptions, maxAge: Math.min(SESSION_SECONDS, grant.expires_at - now()) });
        audit("sso.login", "success", c.get("session"));
        return c.redirect("/", 303);
    });

    app.use("/api/*", async (c, next) => {
        const origin = c.req.header("Origin");
        const site = c.req.header("Sec-Fetch-Site");
        if ((origin && origin !== config.origin) || (site && !["same-origin", "none"].includes(site))) throw new GatewayError("ORIGIN_FORBIDDEN", 403, "请求来源不受允许");
        const cookie = getCookie(c, SESSION_COOKIE);
        const session = cookie ? storage.session(digest(cookie)) : null;
        if (!session) throw new GatewayError("AUTH_REQUIRED", 401, "请从 New API 进入 AI 无限画布");
        c.set("session", session);
        const expectedSession = c.req.header("X-Canvas-Session-Tag");
        if (expectedSession && !equalSecret(expectedSession, digest(`canvas-public-session-tag\0${session.hash}`))) throw new GatewayError("SESSION_CHANGED", 401, "画布登录身份已切换，请重新加载");
        const writing = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
        if (writing && (origin !== config.origin || !equalSecret(c.req.header("X-CSRF-Token") || "", session.csrf))) throw new GatewayError("CSRF_INVALID", 403, "请求校验失败，请刷新画布");
        // Local logout must remain available during a gateway outage. It still
        // requires the current cookie, session tag, origin and CSRF token.
        if (c.req.method === "POST" && c.req.path === "/api/logout") {
            await next();
            return;
        }
        if (session.expires_at <= now() || session.last_active + SESSION_IDLE_SECONDS <= now()) {
            storage.retire(session);
            void revokePending();
            throw new GatewayError("AUTH_EXPIRED", 401, "画布会话已过期，请重新授权");
        }
        // Polling, streaming reads and background bootstrap do not count as user activity.
        const activity = c.req.header("X-Canvas-Activity") === "1" || writing && c.req.path !== "/api/logout";
        const activityAt = now();
        let state: GrantState;
        try {
            state = await gateway.control<GrantState>("introspect", { grant_id: session.grant_id, activity });
        } catch (error) {
            if (error instanceof GatewayError && error.status === 401) {
                storage.retire(session);
            }
            throw error;
        }
        const currentUser = JSON.parse(session.user_json) as { id: number; subject: string };
        if (!state.active || state.user?.id !== currentUser.id || typeof state.user.subject !== "string" || !safeSubject.test(state.user.subject) || state.user.subject !== currentUser.subject || session.owner !== `${new URL(config.gatewayPublicUrl).origin}|${state.user.subject}` || !state.expires_at || state.expires_at <= now()) {
            storage.retire(session);
            void revokePending();
            const [code, message] = grantFailures[state.reason || ""] || ["AUTH_REVOKED", "授权已失效，请重新从 New API 进入画布"];
            throw new GatewayError(code, 401, message);
        }
        // Passive reads never write activity. Concurrent activity can only move
        // forwards; expiry can only shorten, and logout cannot be resurrected.
        const updated = activity
            ? db.query("UPDATE sessions SET last_active = MAX(last_active, ?), expires_at = MIN(expires_at, ?), user_json = ? WHERE hash = ? RETURNING *").get(activityAt, state.expires_at, JSON.stringify(state.user), session.hash) as SessionRow | null
            : db.query("UPDATE sessions SET expires_at = MIN(expires_at, ?), user_json = ? WHERE hash = ? RETURNING *").get(state.expires_at, JSON.stringify(state.user), session.hash) as SessionRow | null;
        if (!updated) throw new GatewayError("AUTH_REVOKED", 401, "画布会话已退出");
        c.set("session", updated);
        c.set("apiKey", await vault.open(session.credential, session.hash));
        void revokePending();
        await next();
    });

    app.get("/api/session", (c) => {
        const session = c.get("session");
        return c.json({ user: JSON.parse(session.user_json), csrf_token: session.csrf, session_tag: digest(`canvas-public-session-tag\0${session.hash}`), expires_at: session.expires_at });
    });

    app.post("/api/logout", async (c) => {
        storage.retire(c.get("session"));
        deleteCookie(c, SESSION_COOKIE, cookieOptions);
        void revokePending();
        audit("session.logout", "success", c.get("session"));
        return c.body(null, 204);
    });

    // Only trusted gateway results and registry catalogs can issue these URLs.
    // The capability contains its source, so neither user content nor a lookup
    // table needs to survive on the Canvas server between requests.
    const mediaCapability = async (owner: string, source: string, purpose: "prompt-asset" | "result-media") => {
        const sealed = await vault.seal(source, `${purpose}\0${owner}`);
        return `/api/${purpose === "prompt-asset" ? "prompt-assets" : purpose}/${Buffer.from(sealed, "base64").toString("base64url")}`;
    };

    const gatewayMediaUrls = async (owner: string, value: unknown, nativeVideoId?: string | null): Promise<unknown> => {
        if (Array.isArray(value)) return Promise.all(value.map((child) => gatewayMediaUrls(owner, child, nativeVideoId)));
        if (!value || typeof value !== "object") return value;
        const object = { ...value as Record<string, unknown> };
        for (const [key, child] of Object.entries(object)) {
            if (["url", "view_url", "content_url", "video_url", "result_url", "fileUri"].includes(key) && typeof child === "string" && /^https?:\/\//i.test(child)) {
                if (nativeVideoId) {
                    object[key] = `/api/ai/v1/videos/${nativeVideoId}/content`;
                    continue;
                }
                const source = new URL(child);
                if ([new URL(config.gatewayUrl).origin, new URL(config.gatewayPublicUrl).origin].includes(source.origin)) {
                    if (!/^\/v1\/videos\/[A-Za-z0-9_-]+\/content$/.test(source.pathname) || source.search) throw new GatewayError("MEDIA_BRIDGE_REQUIRED", 502, "此异步媒体需要网关授权内容桥");
                    // New API validates ownership on every authenticated task read.
                    object[key] = `/api/ai${source.pathname}`;
                } else object[key] = await mediaCapability(owner, child, "result-media");
            } else object[key] = await gatewayMediaUrls(owner, child, nativeVideoId);
        }
        return object;
    };

    const capabilityMedia = async (c: Context<Env>, purpose: "prompt-asset" | "result-media") => {
        const token = c.req.param("token") || "";
        if (!safeId.test(token) || new URL(c.req.url).search) return c.notFound();
        let source: string;
        try {
            source = await vault.open(Buffer.from(token, "base64url").toString("base64"), `${purpose}\0${c.get("session").owner}`);
        } catch { return c.notFound(); }
        const response = purpose === "prompt-asset" ? await publicResource(source, "media", c.req.raw.signal) : await publicMedia(source, c.req.raw.signal);
        return new Response(response.body, { status: response.status, headers: { "Content-Type": response.headers.get("Content-Type")! } });
    };
    app.get("/api/result-media/:token", (c) => capabilityMedia(c, "result-media"));
    app.get("/api/prompt-assets/:token", (c) => capabilityMedia(c, "prompt-asset"));

    app.get("/api/prompt-catalog/:id", async (c) => {
        const id = c.req.param("id");
        if (!promptSources.has(id) || new URL(c.req.url).search) return c.notFound();
        const source = `https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/${id}.json`;
        const response = await publicResource(source, "json", c.req.raw.signal);
        let entries: unknown;
        try { entries = await response.json(); } catch { throw new GatewayError("PROMPT_CATALOG_INVALID", 502, "提示词库返回格式无效"); }
        if (!Array.isArray(entries)) throw new GatewayError("PROMPT_CATALOG_INVALID", 502, "提示词库返回格式无效");
        const owner = c.get("session").owner;
        const registerAsset = async (value: unknown) => {
            if (typeof value !== "string" || !value) return "";
            let url: URL;
            try { url = new URL(value, source); } catch { return ""; }
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
            return mediaCapability(owner, url.href, "prompt-asset");
        };
        for (const entry of entries) {
            if (!entry || typeof entry !== "object") continue;
            entry.coverUrl = await registerAsset(entry.coverUrl);
            entry.referenceImageUrls = Array.isArray(entry.referenceImageUrls) ? (await Promise.all(entry.referenceImageUrls.map(registerAsset))).filter(Boolean) : [];
        }
        return c.json(entries);
    });

    app.get("/api/models", async (c) => {
        const response = await gateway.relay("/v1/models", c.get("apiKey"), { signal: c.req.raw.signal });
        if (redirectStatuses.has(response.status)) throw new GatewayError("GATEWAY_REDIRECT_REJECTED", 502, "网关不应重定向模型请求");
        return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json" } });
    });

    const historyContent = async (c: Context<Env>) => {
        const kind = c.req.param("kind") || "";
        const taskId = c.req.param("task") || "";
        const artifact = c.req.param("artifact");
        if (!["images", "media"].includes(kind) || !safeId.test(taskId) || artifact && !safeArtifact.test(artifact) || new URL(c.req.url).search) return c.notFound();
        const session = c.get("session");
        const historyKind = kind === "media" && taskId.startsWith("asyncimg_") ? "images" : kind;
        const path = `/${historyKind}/${taskId}${artifact ? `/content/${artifact}` : ""}`;
        const headers = new Headers();
        for (const name of ["Range", "If-Range", "If-None-Match", "If-Modified-Since"]) {
            const value = c.req.header(name);
            if (value) headers.set(name, value);
        }
        const response = await gateway.history(path, session.grant_id, { method: c.req.method, headers, signal: c.req.raw.signal });
        if (redirectStatuses.has(response.status)) throw new GatewayError("GATEWAY_REDIRECT_REJECTED", 502, "授权内容桥不应重定向");
        const outbound = new Headers();
        for (const name of ["Content-Type", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Retry-After"]) {
            const value = response.headers.get(name);
            if (value) outbound.set(name, value);
        }
        if (artifact || !response.ok || c.req.method === "HEAD") return new Response(c.req.method === "HEAD" ? null : response.body, { status: response.status, headers: outbound });
        let result: { data?: Record<string, unknown>[]; status?: string };
        try { result = await response.json() as typeof result; } catch { throw new GatewayError("GATEWAY_PROTOCOL_ERROR", 502, "网关历史任务响应格式无效"); }
        for (const entry of result.data || []) {
            for (const key of ["url", "view_url"]) {
                const raw = entry[key];
                if (typeof raw !== "string") continue;
                const expected = `/api/integrations/canvas/history/${historyKind}/${taskId}/content/`;
                if (!raw.startsWith(expected) || !safeArtifact.test(raw.slice(expected.length))) throw new GatewayError("MEDIA_BRIDGE_INVALID", 502, "授权媒体地址无效");
                entry[key] = `/api/ai/v1/${historyKind}/tasks_async/${taskId}/content/${raw.slice(expected.length)}`;
            }
        }
        return new Response(JSON.stringify(result), { status: response.status, headers: outbound });
    };
    app.on(["GET", "HEAD"], "/api/ai/v1/:kind/tasks_async/:task", historyContent);
    app.on(["GET", "HEAD"], "/api/ai/v1/:kind/tasks_async/:task/content/:artifact", historyContent);

    app.all("/api/ai/*", async (c) => {
        const path = c.req.path.slice("/api/ai".length);
        const post = c.req.method === "POST";
        const read = ["GET", "HEAD"].includes(c.req.method);
        const video = /^\/v1\/videos\/([A-Za-z0-9_-]+)(\/content)?$/.exec(path);
        const gemini = /^\/v1beta\/models\/([A-Za-z0-9._:-]+):(generateContent|streamGenerateContent)$/.exec(path);
        const allowed = post && (["/v1/responses", "/v1/chat/completions", "/v1/images/generations", "/v1/images/edits", "/v1/audio/speech", "/v1/videos", "/v1/images/generations_async", "/v1/images/edits_async", "/v1/videos/generations_async", "/v1/videos/edits_async", "/v1/videos/extensions_async"].includes(path) || gemini) || read && video;
        const query = new URL(c.req.url);
        const geminiSse = gemini?.[2] === "streamGenerateContent" && [...query.searchParams].length === 1 && query.searchParams.get("alt") === "sse";
        if (!allowed || query.search && !geminiSse) throw new GatewayError("AI_ENDPOINT_FORBIDDEN", 403, "画布不支持此模型接口或查询参数");
        const session = c.get("session");
        const headers = new Headers();
        // Construct an allowlist rather than copying any browser credential,
        // identity, channel, forwarding or application-proof header.
        for (const name of ["Content-Type", "Accept", "Range", "If-Range", "If-None-Match", "If-Modified-Since"]) {
            const value = c.req.header(name);
            if (value) headers.set(name, value);
        }
        if (post && path.endsWith("_async")) {
            const idempotencyKey = c.req.header("Idempotency-Key");
            if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
        }
        let body: ArrayBuffer | undefined;
        let model: string | undefined = gemini?.[1];
        if (post) {
            const contentType = c.req.header("Content-Type") || "";
            if (contentType.startsWith("multipart/form-data")) {
                const form = await c.req.raw.clone().formData();
                const value = form.get("model");
                if (typeof value === "string") model = value;
            } else if (contentType.startsWith("application/json")) {
                const json = await c.req.raw.clone().json() as { model?: unknown };
                if (gemini && json.model !== undefined && json.model !== model) throw new GatewayError("MODEL_MISMATCH", 400, "模型路径与请求参数不一致");
                if (!gemini && typeof json.model === "string") model = json.model;
            }
            if (!model) throw new GatewayError("MODEL_REQUIRED", 400, "请选择要调用的模型");
            const models = await gateway.relay("/v1/models", c.get("apiKey"), { signal: c.req.raw.signal });
            if (!models.ok) return new Response(models.body, { status: models.status, headers: { "Content-Type": "application/json" } });
            let listing: { data?: { id: string; supported_endpoint_types?: string[] }[] };
            try { listing = await models.json() as typeof listing; } catch { throw new GatewayError("GATEWAY_PROTOCOL_ERROR", 502, "网关模型列表响应格式无效"); }
            if (!listing || !Array.isArray(listing.data)) throw new GatewayError("GATEWAY_PROTOCOL_ERROR", 502, "网关模型列表响应格式无效");
            const selected = listing.data.find((entry) => entry.id === model);
            if (!selected) throw new GatewayError("MODEL_FORBIDDEN", 403, "当前用户无权调用此模型");
            const endpoint = gemini ? "gemini" : path.includes("/images/") ? "image-generation" : path.includes("/videos") ? "openai-video" : path === "/v1/responses" ? "openai-response" : "openai";
            // Audio has no separate endpoint metadata in the current gateway;
            // retain its OpenAI category and let the gateway validate audio
            // protocol support. Never turn a model-name guess into permission.
            if (!Array.isArray(selected.supported_endpoint_types) || !selected.supported_endpoint_types.includes(endpoint)) throw new GatewayError("MODEL_ENDPOINT_FORBIDDEN", 403, "当前模型不支持所选调用接口");
            body = await c.req.raw.arrayBuffer();
        }
        let response: Response;
        try {
            response = await gateway.relay(path + query.search, c.get("apiKey"), { method: c.req.method, headers, body, signal: c.req.raw.signal });
        } catch {
            throw new GatewayError("EXECUTION_UNKNOWN", 502, "请求结果未知，请查询原任务，不要重复提交付费请求");
        }
        if (redirectStatuses.has(response.status)) {
            if (read && video?.[2] === "/content" && response.headers.get("location")) {
                const target = new URL(response.headers.get("location")!, config.gatewayUrl);
                if ([new URL(config.gatewayUrl).origin, new URL(config.gatewayPublicUrl).origin].includes(target.origin)) throw new GatewayError("MEDIA_BRIDGE_REQUIRED", 502, "此视频需要网关授权内容桥");
                // Stream only a redirect selected by the authenticated gateway,
                // without gateway or browser credentials and without a disk copy.
                const media = await publicMedia(target.href, c.req.raw.signal);
                if (c.req.method === "HEAD") await media.body?.cancel();
                return new Response(c.req.method === "HEAD" ? null : media.body, { status: media.status, headers: { "Content-Type": media.headers.get("Content-Type")! } });
            }
            throw new GatewayError("GATEWAY_REDIRECT_REJECTED", 502, "网关重定向已被阻止，请查询原任务");
        }
        const outbound = new Headers();
        for (const name of ["Content-Type", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "X-Request-Id", "Retry-After"]) {
            const value = response.headers.get(name);
            if (value) outbound.set(name, value);
        }
        if (response.status === 304) return new Response(null, { status: 304, headers: outbound });
        if (response.headers.get("content-type")?.includes("application/json")) {
            let result: Record<string, unknown>;
            try {
                result = await response.json() as Record<string, unknown>;
                if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid gateway response");
            } catch {
                throw new GatewayError("GATEWAY_PROTOCOL_ERROR", 502, "网关返回了无效结果，请查询原任务，不要重复提交");
            }
            const taskId = typeof result.id === "string" && path === "/v1/videos" ? result.id : typeof result.task_id === "string" ? result.task_id : null;
            if (taskId && typeof result.query_url === "string") {
                const query = new URL(result.query_url, config.gatewayUrl);
                if (query.pathname === `/v1/images/tasks_async/${taskId}` || query.pathname === `/v1/media/tasks_async/${taskId}`) result.query_url = `/api/ai${query.pathname}`;
                else delete result.query_url;
            }
            // Preserve task IDs and inline results. Only replace remote media URLs
            // with owner-bound streaming capabilities; the browser saves the bytes.
            if (response.ok) result = await gatewayMediaUrls(session.owner, result, path === "/v1/videos" ? taskId : video?.[1]) as Record<string, unknown>;
            return new Response(JSON.stringify(result), { status: response.status, headers: outbound });
        }
        if (!response.body || !post || !response.ok) return new Response(c.req.method === "HEAD" ? null : response.body, { status: response.status, headers: outbound });
        const reader = response.body.getReader();
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    let current = storage.session(session.hash);
                    if (!current || current.expires_at <= now() || current.last_active + SESSION_IDLE_SECONDS <= now()) {
                        await reader.cancel();
                        controller.error(new Error("Canvas session ended"));
                        return;
                    }
                    const chunk = await reader.read();
                    current = storage.session(session.hash);
                    if (!current || current.expires_at <= now() || current.last_active + SESSION_IDLE_SECONDS <= now()) {
                        await reader.cancel();
                        controller.error(new Error("Canvas session ended"));
                        return;
                    }
                    if (chunk.done) controller.close();
                    else controller.enqueue(chunk.value);
                } catch {
                    controller.error(new Error("Generation stream interrupted; do not automatically retry"));
                }
            },
            async cancel() { await reader.cancel(); },
        });
        return new Response(stream, { status: response.status, headers: outbound });
    });

    return { app, storage, gateway, revokePending };
}
