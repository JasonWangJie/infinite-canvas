import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createApp, type SecurityAuditEvent } from "../src/app.ts";
import { SESSION_IDLE_SECONDS, SESSION_SECONDS, type ServerConfig } from "../src/config.ts";
import { publicMediaResponse, type Fetcher } from "../src/gateway.ts";
import { SESSION_COOKIE, TRANSACTION_COOKIE } from "../src/security.ts";
import type { CanvasStorage } from "../src/storage.ts";

const fixtures: { storage: CanvasStorage; directory: string; revokePending: () => Promise<void> }[] = [];
afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
        await fixture.revokePending();
        fixture.storage.close();
        const resolved = realpathSync(fixture.directory);
        if (dirname(resolved) !== realpathSync(tmpdir()) || !basename(resolved).startsWith("canvas-server-test-")) throw new Error("Refusing to delete an unexpected test directory");
        rmSync(resolved, { recursive: true, force: true });
    }
});

type Intercept = (path: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;
function setup(options: { publicMedia?: typeof publicMediaResponse } = {}) {
    const directory = mkdtempSync(join(tmpdir(), "canvas-server-test-"));
    const config: ServerConfig = { origin: "https://canvas.example", gatewayUrl: "http://new-api.internal", gatewayPublicUrl: "https://gateway.example", clientId: "infinite-canvas", clientSecret: "test-client-secret", encryptionKey: randomBytes(32).toString("base64"), dataDir: directory };
    let currentTime = 1_800_000_000;
    const calls: { path: string; url: string; init?: RequestInit; json?: Record<string, unknown> }[] = [];
    const grants = new Map<string, { active: boolean; reason?: string; user: { id: number; subject: string; username: string; display_name: string }; expires_at: number }>();
    const subjects = new Map<number, string>();
    const taskOwners = new Map<string, string>();
    let paidFailure = false;
    let introspectionStatus = 200;
    let failStream = false;
    let intercept: Intercept | undefined;
    const resourceCalls: string[] = [];
    const auditEvents: SecurityAuditEvent[] = [];
    const resource = async (source: string, content: "media" | "json") => {
        resourceCalls.push(source);
        return content === "json" ? Response.json([{ id: "prompt-1", title: "Prompt", prompt: "Draw", coverUrl: "https://images.example/cover.png", referenceImageUrls: ["https://images.example/reference.png"] }]) : new Response("private-prompt-image", { headers: { "Content-Type": "image/png" } });
    };
    const transport: Fetcher = async (input, init) => {
        const path = new URL(String(input)).pathname;
        const json = typeof init?.body === "string" && path.includes("/integrations/") ? JSON.parse(init.body) : undefined;
        calls.push({ path, url: String(input), init, json });
        const requestHeaders = new Headers(init?.headers);
        const taskGrant = grants.get(requestHeaders.get("X-Infinite-Canvas-Grant") || (requestHeaders.get("Authorization") || "").replace(/^Bearer ic_server-key-/, ""));
        const requestedTask = /^\/v1\/videos\/([^/]+)(?:\/content)?$/.exec(path)?.[1] || /^\/api\/integrations\/canvas\/history\/(?:images|media)\/([^/]+)/.exec(path)?.[1];
        // Model the existing New API owner check, which is authoritative after
        // Canvas stops keeping its own generation table.
        if (requestedTask && (!taskGrant?.active || taskOwners.get(requestedTask) !== taskGrant.user.subject)) return new Response(null, { status: 404 });
        if (init?.method === "POST" && taskGrant) {
            if (path.endsWith("/images/generations_async")) taskOwners.set("asyncimg_123", taskGrant.user.subject);
            if (path === "/v1/videos") taskOwners.set("video_123", taskGrant.user.subject);
        }
        const intercepted = await intercept?.(path, init);
        if (intercepted) return intercepted;
        if (path.endsWith("/exchange")) {
            const id = Number(String(json?.code).split("-")[1]);
            const grantId = `grant-${calls.length}`;
            const subject = subjects.get(id) || `ics_${String(id).padStart(32, "0")}`;
            subjects.set(id, subject);
            const grant = { active: true, user: { id, subject, username: `user-${id}`, display_name: `用户 ${id}` }, expires_at: currentTime + SESSION_SECONDS };
            grants.set(grantId, grant);
            return Response.json({ grant_id: grantId, api_key: `ic_server-key-${grantId}`, user: grant.user, expires_at: grant.expires_at });
        }
        if (path.endsWith("/introspect")) return introspectionStatus === 200 ? Response.json(grants.get(String(json?.grant_id)) || { active: false }) : Response.json({ error: "temporarily unavailable" }, { status: introspectionStatus });
        if (path.endsWith("/revoke")) {
            const grant = grants.get(String(json?.grant_id));
            if (grant) grant.active = false;
            return new Response(null, { status: 204 });
        }
        if (path === "/v1/models") return Response.json({ data: [{ id: "allowed-image", supported_endpoint_types: ["image-generation"] }, { id: "allowed-text", supported_endpoint_types: ["openai-response", "openai"] }, { id: "allowed-video", supported_endpoint_types: ["openai-video"] }, { id: "allowed-gemini", supported_endpoint_types: ["gemini"] }] });
        if (path === "/v1beta/models/allowed-gemini:streamGenerateContent") return new Response("data: {\"candidates\":[{\"finishReason\":\"STOP\",\"content\":{\"parts\":[{\"text\":\"hello-gemini\"}]}}]}\n\n", { headers: { "Content-Type": "text/event-stream" } });
        if (path.endsWith("/images/generations_async")) return Response.json({ task_id: "asyncimg_123", query_url: "https://gateway.example/v1/images/tasks_async/asyncimg_123" }, { status: 202 });
        if (path.endsWith("/history/images/asyncimg_123")) return Response.json({ status: "succeeded", data: [{ url: "/api/integrations/canvas/history/images/asyncimg_123/content/0" }] });
        if (path.endsWith("/history/images/asyncimg_123/content/0")) return new Response("private-result", { headers: { "Content-Type": "image/png" } });
        if (paidFailure && init?.method === "POST") throw new Error("network interrupted");
        if (path === "/v1/videos" && init?.method === "POST") return Response.json({ id: "video_123", status: "queued" }, { status: 202 });
        if (path === "/v1/videos/video_123") return Response.json({ id: "video_123", status: "completed" });
        if (path.endsWith("/content")) return new Response("video-bytes", { headers: { "Content-Type": "video/mp4" } });
        if (path === "/v1/responses") return new Response(failStream ? "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n\n" : "event: response.output_text.delta\ndata: {\"delta\":\"hello\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\"}\n\n", { headers: { "Content-Type": "text/event-stream" } });
        return Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
    };
    const service = createApp(config, { fetch: transport, publicResource: resource, publicMedia: options.publicMedia, audit: (event) => { auditEvents.push(event); }, now: () => currentTime });
    const fixture = { ...service, directory, config, grants, subjects, calls, transport, resourceCalls, auditEvents, clock: () => currentTime, time: (seconds: number) => { currentTime += seconds; }, failPaid: () => { paidFailure = true; }, failStream: () => { failStream = true; }, introspectStatus: (status: number) => { introspectionStatus = status; }, intercept: (handler: Intercept) => { intercept = handler; } };
    fixtures.push(fixture);
    return fixture;
}

function cookieValue(response: Response, name: string): string {
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
    expect(cookie).toBeDefined();
    return cookie!.split(";")[0];
}

async function login(fixture: ReturnType<typeof setup>, id: number) {
    const start = await fixture.app.request(`${fixture.config.origin}/auth/start`);
    const location = new URL(start.headers.get("location")!);
    const callback = await fixture.app.request(`${fixture.config.origin}/auth/callback?code=user-${id}&state=${location.searchParams.get("state")}`, { headers: { Cookie: cookieValue(start, TRANSACTION_COOKIE) } });
    expect(callback.status).toBe(303);
    const cookie = cookieValue(callback, SESSION_COOKIE);
    const state = await fixture.app.request(`${fixture.config.origin}/api/session`, { headers: { Cookie: cookie } });
    expect(state.status).toBe(200);
    const session = await state.json() as { csrf_token: string; expires_at: number };
    return { cookie, csrf: session.csrf_token, expires: session.expires_at };
}

function headers(fixture: ReturnType<typeof setup>, session: { cookie: string; csrf: string }): Record<string, string> {
    return { Cookie: session.cookie, Origin: fixture.config.origin, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" };
}

describe("Canvas authorization and owner isolation", () => {
    test("shows a safe recovery page for a browser exchange failure without replaying the callback", async () => {
        const f = setup();
        f.intercept((path) => path.endsWith("/exchange") ? Response.json({ message: "private upstream response" }, { status: 401 }) : undefined);
        const start = await f.app.request(`${f.config.origin}/auth/start`);
        const target = new URL(start.headers.get("location")!);
        const state = target.searchParams.get("state")!;
        const cookie = cookieValue(start, TRANSACTION_COOKIE);
        const callback = `${f.config.origin}/auth/callback?${new URLSearchParams({ code: "private-callback-code", state, return_to: "https://evil.example" })}`;
        const response = await f.app.request(callback, { headers: { Cookie: cookie, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } });
        expect(response.status).toBe(401);
        expect(response.headers.get("content-type")).toContain("text/html");
        const page = await response.text();
        expect(page).toContain("未能完成画布授权");
        expect(page).toContain("AUTH_EXCHANGE_FAILED");
        expect(page).toContain('href="/auth/start"');
        expect(page).toContain('href="https://gateway.example"');
        expect(page).toContain("重新授权");
        expect(page).toContain("联系管理员");
        expect(page).toContain('name="viewport"');
        expect(page).toContain("prefers-color-scheme: dark");
        expect(page).not.toContain("<script");
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        const nonce = /<style nonce="([A-Za-z0-9_-]+)">/.exec(page)?.[1];
        expect(nonce).toBeDefined();
        expect(response.headers.get("content-security-policy")).toContain(`style-src 'nonce-${nonce}'`);
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
        expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
        const exchange = f.calls.find((call) => call.path.endsWith("exchange"))!;
        for (const secret of ["private-callback-code", "private upstream response", state, cookie.split("=")[1], String(exchange.json?.code_verifier), f.config.clientSecret, "evil.example"]) {
            expect(page).not.toContain(secret);
            expect(JSON.stringify(f.auditEvents)).not.toContain(secret);
        }
        expect(response.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
        expect(f.storage.db.query("SELECT * FROM sessions").all()).toHaveLength(0);
        const replay = await f.app.request(callback, { headers: { Cookie: cookie, Accept: "text/html" } });
        expect(replay.status).toBe(400);
        expect(await replay.text()).toContain("AUTH_TRANSACTION_INVALID");
        expect(f.calls.filter((call) => call.path.endsWith("exchange"))).toHaveLength(1);
        const retry = await f.app.request(`${f.config.origin}/auth/start`);
        expect(retry.status).toBe(303);
        expect(new URL(retry.headers.get("location")!).searchParams.get("state")).not.toBe(state);
    });

    test("offers fresh authorization for expired browser callbacks without contacting the gateway", async () => {
        const f = setup();
        const start = await f.app.request(`${f.config.origin}/auth/start`);
        const target = new URL(start.headers.get("location")!);
        f.time(301);
        const response = await f.app.request(`${f.config.origin}/auth/callback?code=expired-code&state=${target.searchParams.get("state")}`, { headers: { Cookie: cookieValue(start, TRANSACTION_COOKIE), "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } });
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain("text/html");
        const page = await response.text();
        expect(page).toContain("授权链接已失效");
        expect(page).toContain('href="/auth/start"');
        expect(f.calls.filter((call) => call.path.endsWith("exchange"))).toHaveLength(0);
    });

    test("keeps JSON errors for API requests and non-HTML authorization clients", async () => {
        const f = setup();
        for (const accept of [undefined, "application/json", "text/html;q=0,application/json", "*/*"]) {
            const response = await f.app.request(`${f.config.origin}/auth/callback`, { headers: accept ? { Accept: accept, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } : {} });
            expect(response.status).toBe(400);
            expect(response.headers.get("content-type")).toContain("application/json");
            expect((await response.json()).error.code).toBe("AUTH_TRANSACTION_INVALID");
        }
        const api = await f.app.request(`${f.config.origin}/api/session`, { headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } });
        expect(api.status).toBe(401);
        expect(api.headers.get("content-type")).toContain("application/json");
        expect((await api.json()).error.code).toBe("AUTH_REQUIRED");
    });

    test("shows a generic browser recovery page when starting authorization cannot access storage", async () => {
        const f = setup();
        f.storage.db.query("DROP TABLE login_transactions").run();
        const response = await f.app.request(`${f.config.origin}/auth/start`, { headers: { Accept: "text/html" } });
        expect(response.status).toBe(500);
        expect(response.headers.get("content-type")).toContain("text/html");
        const page = await response.text();
        expect(page).toContain("INTERNAL_ERROR");
        expect(page).toContain('href="/auth/start"');
        expect(page).not.toContain("login_transactions");
        expect(page).not.toContain(f.directory);
    });

    test("binds a one-use callback to state and S256, stores only encrypted credentials and secure cookies", async () => {
        const f = setup();
        const start = await f.app.request(`${f.config.origin}/auth/start?return_to=https://evil.example`);
        expect(start.status).toBe(303);
        const target = new URL(start.headers.get("location")!);
        expect(target.origin).toBe("https://gateway.example");
        expect(target.searchParams.get("redirect_uri")).toBe(`${f.config.origin}/auth/callback`);
        expect(target.searchParams.get("code_challenge_method")).toBe("S256");
        const cookie = cookieValue(start, TRANSACTION_COOKIE);
        const bad = await f.app.request(`${f.config.origin}/auth/callback?code=user-1&state=wrong`, { headers: { Cookie: cookie } });
        expect(bad.status).toBe(400);
        expect(f.calls.filter((call) => call.path.endsWith("exchange"))).toHaveLength(0);
        const callback = `${f.config.origin}/auth/callback?code=user-1&state=${target.searchParams.get("state")}`;
        const [one, two] = await Promise.all([f.app.request(callback, { headers: { Cookie: cookie } }), f.app.request(callback, { headers: { Cookie: cookie } })]);
        expect([one.status, two.status].sort()).toEqual([303, 400]);
        const success = one.status === 303 ? one : two;
        expect(success.headers.getSetCookie().join(";")).toContain("HttpOnly");
        expect(success.headers.getSetCookie().join(";")).toContain("Secure");
        expect(success.headers.getSetCookie().join(";")).toContain("SameSite=Lax");
        expect(success.headers.get("location")).toBe("/");
        const exchange = f.calls.find((call) => call.path.endsWith("exchange"))!;
        expect(createHash("sha256").update(String(exchange.json?.code_verifier)).digest("base64url")).toBe(target.searchParams.get("code_challenge")!);
        const rows = f.storage.db.query("SELECT * FROM sessions").all();
        expect(JSON.stringify(rows)).not.toContain("ic_server-key");
        expect(JSON.stringify(rows)).not.toContain(cookieValue(success, SESSION_COOKIE).split("=")[1]);
        expect(success.headers.get("referrer-policy")).toBe("no-referrer");
        expect(f.auditEvents.some((event) => event.action === "sso.login" && event.result === "success" && event.user_id === 1)).toBe(true);
        const audit = JSON.stringify(f.auditEvents);
        for (const secret of [String(exchange.json?.code_verifier), target.searchParams.get("state")!, cookie.split("=")[1], f.config.clientSecret, "ic_server-key"]) expect(audit).not.toContain(secret);
    });

    test("rejects expired transactions without attempting a code exchange", async () => {
        const f = setup();
        const start = await f.app.request(`${f.config.origin}/auth/start`);
        f.time(301);
        const target = new URL(start.headers.get("location")!);
        const response = await f.app.request(`${f.config.origin}/auth/callback?code=user-1&state=${target.searchParams.get("state")}`, { headers: { Cookie: cookieValue(start, TRANSACTION_COOKIE) } });
        expect(response.status).toBe(400);
        expect(f.calls.filter((call) => call.path.endsWith("exchange"))).toHaveLength(0);
    });

    test("disables all document and generation persistence APIs while retaining origin and CSRF checks", async () => {
        const f = setup();
        const a = await login(f, 1);
        const url = `${f.config.origin}/api/data/canvas`;
        const body = JSON.stringify({ value: { projects: ["browser-only project"] }, revision: 0 });
        expect((await f.app.request(url, { method: "PUT", body, headers: { Cookie: a.cookie, Origin: f.config.origin, "Content-Type": "application/json" } })).status).toBe(403);
        expect((await f.app.request(url, { method: "PUT", body, headers: { ...headers(f, a), Origin: "https://sibling.example" } })).status).toBe(403);
        for (const [method, path] of [["GET", "/api/data/canvas"], ["PUT", "/api/data/assets"], ["GET", "/api/generations"], ["POST", "/api/generations"], ["GET", "/api/generations/old-id"], ["PUT", "/api/generations/old-id"], ["DELETE", "/api/generations/old-id"], ["POST", "/api/generations/old-id/recover"]]) {
            const response = await f.app.request(`${f.config.origin}${path}`, { method, headers: headers(f, a), ...(["POST", "PUT"].includes(method) ? { body } : {}) });
            expect(response.status).toBe(404);
        }
        expect((await f.app.request(url)).status).toBe(401);
        expect((await f.app.request(url, { headers: { Cookie: a.cookie, "Sec-Fetch-Site": "same-site" } })).status).toBe(403);
        expect(f.storage.db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([
            { name: "login_transactions" }, { name: "pending_revocations" }, { name: "sessions" }, { name: "users" },
        ]);
    });

    test("checks live grants on data reads and terminates logout, idle and absolute sessions", async () => {
        const f = setup();
        const a = await login(f, 1);
        const logout = await f.app.request(`${f.config.origin}/api/logout`, { method: "POST", headers: headers(f, a) });
        expect(logout.status).toBe(204);
        expect((await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: a.cookie } })).status).toBe(401);
        expect([...f.grants.values()].some((grant) => !grant.active)).toBe(true);
        const idle = await login(f, 1);
        f.time(SESSION_IDLE_SECONDS - 1);
        expect((await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: idle.cookie } })).status).toBe(200);
        f.time(1);
        expect((await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: idle.cookie } })).status).toBe(401);
        const disabled = await login(f, 2);
        for (const grant of f.grants.values()) if (grant.user.id === 2) { grant.active = false; grant.reason = "user_disabled"; }
        const denied = await f.app.request(`${f.config.origin}/api/data/canvas`, { headers: { Cookie: disabled.cookie } });
        expect(denied.status).toBe(401);
        expect((await denied.json()).error.code).toBe("USER_DISABLED");
        const absolute = await login(f, 3);
        f.time(SESSION_SECONDS);
        expect((await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: absolute.cookie, "X-Canvas-Activity": "1" } })).status).toBe(401);
    });

    test("rejects file uploads and legacy file access without creating a media directory", async () => {
        const f = setup();
        const a = await login(f, 1);
        const form = new FormData();
        form.set("file", new File(["browser-only-image"], "image.png", { type: "image/png" }));
        form.set("kind", "image");
        const uploadHeaders = headers(f, a);
        delete uploadHeaders["Content-Type"];
        expect((await f.app.request(`${f.config.origin}/api/files`, { method: "POST", headers: uploadHeaders, body: form })).status).toBe(404);
        expect((await f.app.request(`${f.config.origin}/api/files`, { headers: { Cookie: a.cookie } })).status).toBe(404);
        for (const method of ["GET", "HEAD", "DELETE"]) {
            expect((await f.app.request(`${f.config.origin}/api/files/image%3Aold-id`, { method, headers: headers(f, a) })).status).toBe(404);
        }
        expect(existsSync(join(f.directory, "files"))).toBe(false);
        expect(readdirSync(f.directory).every((name) => /^canvas\.sqlite(?:-wal|-shm)?$/.test(name))).toBe(true);
    });

    test("does not migrate or remove legacy user data when opening an existing authorization database", async () => {
        const f = setup();
        const a = await login(f, 1);
        mkdirSync(join(f.directory, "files"));
        writeFileSync(join(f.directory, "files", "legacy-image"), "old bytes untouched");
        f.storage.db.exec("CREATE TABLE documents(owner TEXT, domain TEXT, value TEXT, revision INTEGER)");
        f.storage.db.query("INSERT INTO documents VALUES (?,?,?,?)").run("legacy-owner", "canvas", "old document untouched", 1);
        await f.revokePending();
        f.storage.close();
        Object.assign(f, createApp(f.config, { fetch: f.transport, audit: (event) => { f.auditEvents.push(event); }, now: f.clock }));
        expect(readFileSync(join(f.directory, "files", "legacy-image"), "utf8")).toBe("old bytes untouched");
        expect(f.storage.db.query("SELECT value FROM documents").all()).toEqual([{ value: "old document untouched" }]);
        expect((await f.app.request(`${f.config.origin}/api/data/canvas`, { headers: { Cookie: a.cookie } })).status).toBe(404);
        expect((await f.app.request(`${f.config.origin}/api/files/legacy-image`, { headers: { Cookie: a.cookie } })).status).toBe(404);
    });

    test("keeps AI credentials server-side, checks models, streams SSE and rejects arbitrary paths", async () => {
        const f = setup();
        const a = await login(f, 1);
        const invoke = (path: string, model: string) => f.app.request(`${f.config.origin}/api/ai${path}`, { method: "POST", headers: { ...headers(f, a), Authorization: "Bearer browser-injected", "X-Infinite-Canvas-Client": "forged", "New-Api-User": "2", "X-Channel-Id": "99" }, body: JSON.stringify({ model, input: "hello" }) });
        expect((await invoke("/v1/images/generations", "forbidden")).status).toBe(403);
        expect((await invoke("/v1/responses", "allowed-image")).status).toBe(403);
        const stream = await invoke("/v1/responses", "allowed-text");
        expect(stream.status).toBe(200);
        expect(stream.headers.get("content-type")).toBe("text/event-stream");
        expect(await stream.text()).toContain("hello");
        expect(stream.headers.get("X-Canvas-Generation-Id")).toBeNull();
        const relayed = f.calls.find((call) => call.path === "/v1/responses")!;
        const forwarded = new Headers(relayed.init?.headers);
        expect(forwarded.get("Authorization")).toStartWith("Bearer ic_server-key");
        expect(forwarded.get("X-Infinite-Canvas-Client")).toBe(`Basic ${Buffer.from("infinite-canvas:test-client-secret").toString("base64")}`);
        expect(forwarded.has("Cookie")).toBe(false);
        expect(forwarded.has("New-Api-User")).toBe(false);
        expect(forwarded.has("X-Channel-Id")).toBe(false);
        expect((await invoke("/proxy?url=https://evil.example", "allowed-text")).status).toBe(403);
        expect((await invoke("/v1/responses?key=anything", "allowed-text")).status).toBe(403);
        const gemini = await f.app.request(`${f.config.origin}/api/ai/v1beta/models/allowed-gemini:streamGenerateContent?alt=sse`, { method: "POST", headers: headers(f, a), body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }) });
        expect(gemini.status).toBe(200);
        expect(await gemini.text()).toContain("hello-gemini");
        expect(f.calls.find((call) => call.path.includes("streamGenerateContent"))?.url).toBe("http://new-api.internal/v1beta/models/allowed-gemini:streamGenerateContent?alt=sse");
    });

    test("correlates model stages with a fresh server request ID without exposing request or upstream header content", async () => {
        const f = setup();
        const a = await login(f, 1);
        f.intercept((path) => path === "/v1/images/generations" ? Response.json({ data: [{ b64_json: "aW1hZ2U=" }] }, { headers: { "X-Request-Id": "private-upstream-value", "Server-Timing": 'private;desc="upstream-content"' } }) : undefined);
        const previousCalls = f.calls.length;
        const response = await f.app.request(`${f.config.origin}/api/ai/v1/images/generations`, { method: "POST", headers: { ...headers(f, a), "X-Request-Id": "client-controlled-value" }, body: JSON.stringify({ model: "allowed-image", prompt: "private-prompt-value" }) });
        expect(response.status).toBe(200);
        const requestId = response.headers.get("X-Request-Id");
        expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(response.headers.get("Server-Timing")).toMatch(/^authorization;dur=\d+\.\d{2}, model_validation;dur=\d+\.\d{2}, upstream_headers;dur=\d+\.\d{2}$/);
        const calls = f.calls.slice(previousCalls);
        expect(calls.map((call) => call.path)).toEqual(["/api/integrations/canvas/introspect", "/v1/models", "/v1/images/generations"]);
        for (const call of calls) expect(new Headers(call.init?.headers).get("X-Request-Id")).toBe(requestId);
        const observable = JSON.stringify({ headers: Object.fromEntries(response.headers), audit: f.auditEvents });
        for (const secret of ["private-upstream-value", "upstream-content", "client-controlled-value", "private-prompt-value", "ic_server-key", f.config.clientSecret, a.csrf]) expect(observable).not.toContain(secret);
        const models = await f.app.request(`${f.config.origin}/api/models`, { headers: { Cookie: a.cookie } });
        expect(models.headers.get("X-Request-Id")).not.toBe(requestId);
        expect(models.headers.get("Server-Timing")).toMatch(/^authorization;dur=\d+\.\d{2}, upstream_headers;dur=\d+\.\d{2}$/);
    });

    test("exposes only stages reached before authorization or model rejection", async () => {
        const f = setup();
        const path = `${f.config.origin}/api/ai/v1/images/generations`;
        const denied = await f.app.request(path, { method: "POST", headers: { Origin: f.config.origin, "X-Request-Id": "client-controlled-value" } });
        expect(denied.status).toBe(401);
        expect(denied.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
        expect(denied.headers.get("Server-Timing")).toMatch(/^authorization;dur=\d+\.\d{2}$/);
        expect(f.calls).toHaveLength(0);
        const a = await login(f, 1);
        const forbidden = await f.app.request(path, { method: "POST", headers: headers(f, a), body: JSON.stringify({ model: "private-forbidden-model", prompt: "private-prompt-value" }) });
        expect(forbidden.status).toBe(403);
        expect(forbidden.headers.get("X-Request-Id")).not.toBe(denied.headers.get("X-Request-Id"));
        expect(forbidden.headers.get("Server-Timing")).toMatch(/^authorization;dur=\d+\.\d{2}, model_validation;dur=\d+\.\d{2}$/);
        expect(f.calls.some((call) => call.path === "/v1/images/generations")).toBe(false);
        const observable = JSON.stringify({ denied: await denied.json(), forbidden: await forbidden.json(), headers: Object.fromEntries(forbidden.headers), audit: f.auditEvents });
        for (const secret of ["client-controlled-value", "private-forbidden-model", "private-prompt-value", "ic_server-key", f.config.clientSecret, a.csrf]) expect(observable).not.toContain(secret);
    });

    test("returns timing and SSE headers before the upstream stream ends", async () => {
        const f = setup();
        const a = await login(f, 1);
        let upstream!: ReadableStreamDefaultController<Uint8Array>;
        f.intercept((path) => path === "/v1/responses" ? new Response(new ReadableStream<Uint8Array>({ start(controller) {
            upstream = controller;
            controller.enqueue(new TextEncoder().encode('data: {"delta":"first"}\n\n'));
        } }), { headers: { "Content-Type": "text/event-stream" } }) : undefined);
        const response = await f.app.request(`${f.config.origin}/api/ai/v1/responses`, { method: "POST", headers: headers(f, a), body: JSON.stringify({ model: "allowed-text", stream: true }) });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("text/event-stream");
        expect(response.headers.get("Server-Timing")).toMatch(/upstream_headers;dur=\d+\.\d{2}$/);
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
        upstream.close();
        expect((await reader.read()).done).toBe(true);
        expect(f.calls.filter((call) => call.path === "/v1/responses")).toHaveLength(1);
    });

    test("forwards original task IDs through New API ownership checks and never retries unknown paid execution", async () => {
        const f = setup();
        const a = await login(f, 1);
        const b = await login(f, 2);
        const create = await f.app.request(`${f.config.origin}/api/ai/v1/videos`, { method: "POST", headers: headers(f, a), body: JSON.stringify({ model: "allowed-video", prompt: "video" }) });
        expect(create.status).toBe(202);
        expect(await create.json()).toEqual({ id: "video_123", status: "queued" });
        expect((await f.app.request(`${f.config.origin}/api/ai/v1/videos/video_123`, { headers: { Cookie: a.cookie } })).status).toBe(200);
        expect((await f.app.request(`${f.config.origin}/api/ai/v1/videos/video_123`, { headers: { Cookie: b.cookie } })).status).toBe(404);
        f.failPaid();
        const failed = await f.app.request(`${f.config.origin}/api/ai/v1/images/generations`, { method: "POST", headers: headers(f, a), body: JSON.stringify({ model: "allowed-image", prompt: "image" }) });
        expect(failed.status).toBe(502);
        expect(failed.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
        expect(failed.headers.get("Server-Timing")).toMatch(/upstream_headers;dur=\d+\.\d{2}$/);
        expect(f.calls.filter((call) => call.path === "/v1/images/generations")).toHaveLength(1);
        expect((await failed.json()).error.code).toBe("EXECUTION_UNKNOWN");
        expect(existsSync(join(f.directory, "files"))).toBe(false);
    });

    test("rejects loopback, link-local and IPv4-mapped private result addresses", async () => {
        for (const target of ["http://127.0.0.1/secret", "http://169.254.169.254/meta", "http://[::1]/secret", "http://[::ffff:127.0.0.1]/secret", "file:///etc/passwd"]) await expect(publicMediaResponse(target)).rejects.toThrow();
    });

    test("preserves multipart editing bytes and explicit zero values", async () => {
        const f = setup();
        const a = await login(f, 1);
        const form = new FormData();
        form.set("model", "allowed-image");
        form.set("n", "0");
        form.append("image[]", new File([new Uint8Array([0, 1, 2, 255])], "reference.png", { type: "image/png" }));
        const requestHeaders = headers(f, a);
        delete requestHeaders["Content-Type"];
        const result = await f.app.request(`${f.config.origin}/api/ai/v1/images/edits`, { method: "POST", headers: requestHeaders, body: form });
        expect(result.status).toBe(200);
        const forwarded = f.calls.find((call) => call.path === "/v1/images/edits")!;
        const original = new Request("https://fixture.example", { method: "POST", body: forwarded.init!.body, headers: forwarded.init!.headers });
        const decoded = await original.formData();
        expect(decoded.get("n")).toBe("0");
        expect(new Uint8Array(await (decoded.get("image[]") as File).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
    });

    test("fails closed during authorization outages and keeps only authorization state across reopen", async () => {
        const f = setup();
        const a = await login(f, 1);
        f.introspectStatus(503);
        expect((await f.app.request(`${f.config.origin}/api/models`, { headers: { Cookie: a.cookie } })).status).toBe(503);
        f.introspectStatus(200);
        await f.revokePending();
        f.storage.close();
        Object.assign(f, createApp(f.config, { fetch: f.transport, audit: (event) => { f.auditEvents.push(event); }, now: f.clock }));
        const restored = await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: a.cookie } });
        expect(restored.status).toBe(200);
        expect((await restored.json()).csrf_token).toBe(a.csrf);
        expect((await f.app.request(`${f.config.origin}/api/data/canvas`, { headers: { Cookie: a.cookie } })).status).toBe(404);
        expect(existsSync(join(f.directory, "files"))).toBe(false);
    });

    test("serves historical async media only through the current grant after a new authorization", async () => {
        const f = setup();
        const a = await login(f, 1);
        const accepted = await f.app.request(`${f.config.origin}/api/ai/v1/images/generations_async`, { method: "POST", headers: headers(f, a), body: JSON.stringify({ model: "allowed-image" }) });
        expect(accepted.status).toBe(202);
        expect((await accepted.json()).query_url).toBe("/api/ai/v1/images/tasks_async/asyncimg_123");
        await f.revokePending();
        f.storage.close();
        Object.assign(f, createApp(f.config, { fetch: f.transport, audit: (event) => { f.auditEvents.push(event); }, now: f.clock }));
        await f.app.request(`${f.config.origin}/api/logout`, { method: "POST", headers: headers(f, a) });
        const renewed = await login(f, 1);
        const history = await f.app.request(`${f.config.origin}/api/ai/v1/images/tasks_async/asyncimg_123`, { headers: { Cookie: renewed.cookie } });
        expect(history.status).toBe(200);
        const body = await history.json();
        expect(body.data[0].url).toBe("/api/ai/v1/images/tasks_async/asyncimg_123/content/0");
        const genericMedia = await f.app.request(`${f.config.origin}/api/ai/v1/media/tasks_async/asyncimg_123`, { headers: { Cookie: renewed.cookie } });
        expect(genericMedia.status).toBe(200);
        expect((await genericMedia.json()).data[0].url).toBe("/api/ai/v1/images/tasks_async/asyncimg_123/content/0");
        const forwarded = f.calls.findLast((call) => call.path.endsWith("/history/images/asyncimg_123"))!;
        const proof = new Headers(forwarded.init?.headers);
        expect(proof.get("Authorization")).toStartWith("Basic ");
        expect(proof.get("X-Infinite-Canvas-Grant")).toBe([...f.grants.keys()].at(-1)!);
        const b = await login(f, 2);
        expect((await f.app.request(`${f.config.origin}/api/ai/v1/images/tasks_async/asyncimg_123/content/0`, { headers: { Cookie: b.cookie } })).status).toBe(404);
    });

    test("retains upstream SSE terminal errors without recording or retrying them", async () => {
        const f = setup();
        const a = await login(f, 1);
        f.failStream();
        const stream = await f.app.request(`${f.config.origin}/api/ai/v1/responses`, { method: "POST", headers: headers(f, a), body: JSON.stringify({ model: "allowed-text", input: "hello" }) });
        expect(await stream.text()).toContain("response.failed");
        expect(stream.headers.get("X-Canvas-Generation-Id")).toBeNull();
        expect(f.calls.filter((call) => call.path === "/v1/responses")).toHaveLength(1);
    });

    test("limits prompt catalogs to the fixed source registry and owns every lazy image capability", async () => {
        const f = setup();
        const a = await login(f, 1);
        const b = await login(f, 2);
        expect((await f.app.request(`${f.config.origin}/api/prompt-catalog/arbitrary`, { headers: { Cookie: a.cookie } })).status).toBe(404);
        expect(f.resourceCalls).toHaveLength(0);
        const catalog = await f.app.request(`${f.config.origin}/api/prompt-catalog/awesome-gpt-image`, { headers: { Cookie: a.cookie } });
        expect(catalog.status).toBe(200);
        const entries = await catalog.json();
        expect(entries[0].coverUrl).toStartWith("/api/prompt-assets/");
        expect(JSON.stringify(entries)).not.toContain("https://images.example");
        expect(f.resourceCalls).toEqual(["https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/awesome-gpt-image.json"]);
        expect((await f.app.request(`${f.config.origin}${entries[0].coverUrl}`, { headers: { Cookie: b.cookie } })).status).toBe(404);
        const image = await f.app.request(`${f.config.origin}${entries[0].coverUrl}`, { headers: { Cookie: a.cookie } });
        expect(image.status).toBe(200);
        expect(await image.text()).toBe("private-prompt-image");
        expect(image.headers.get("location")).toBeNull();
        expect(image.headers.get("content-security-policy")).toContain("sandbox");
        await f.app.request(`${f.config.origin}${entries[0].coverUrl}`, { headers: { Cookie: a.cookie } });
        expect(f.resourceCalls).toHaveLength(3);
        expect(existsSync(join(f.directory, "files"))).toBe(false);
    });

    test("never assigns old media capabilities to a recreated account with the same numeric ID", async () => {
        const f = setup();
        const old = await login(f, 1);
        const catalog = await (await f.app.request(`${f.config.origin}/api/prompt-catalog/awesome-gpt-image`, { headers: { Cookie: old.cookie } })).json();
        const nextSubject = `ics_${randomBytes(16).toString("hex")}`;
        f.subjects.set(1, nextSubject);
        for (const grant of f.grants.values()) if (grant.user.id === 1) grant.user.subject = nextSubject;
        const recreated = await login(f, 1);
        expect((await f.app.request(`${f.config.origin}${catalog[0].coverUrl}`, { headers: { Cookie: recreated.cookie } })).status).toBe(404);
        expect((await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: old.cookie } })).status).toBe(401);
    });

    test("does not let a late old-session failure delete a newer browser cookie", async () => {
        const f = setup();
        const a = await login(f, 1);
        const initial = await (await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: a.cookie } })).json();
        expect(initial.session_tag).toMatch(/^[a-f0-9]{64}$/);
        expect(initial.session_tag).not.toBe(a.cookie.split("=")[1]);
        const b = await login(f, 2);
        const current = await (await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: b.cookie } })).json();
        expect(current.session_tag).not.toBe(initial.session_tag);
        const switched = await f.app.request(`${f.config.origin}/api/data/canvas`, { headers: { Cookie: b.cookie, "X-Canvas-Session-Tag": initial.session_tag } });
        expect(switched.status).toBe(401);
        expect((await switched.json()).error.code).toBe("SESSION_CHANGED");
        expect(switched.headers.getSetCookie()).toEqual([]);
        for (const grant of f.grants.values()) if (grant.user.id === 1) grant.active = false;
        const late = await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: a.cookie } });
        expect(late.status).toBe(401);
        expect(late.headers.getSetCookie()).toEqual([]);
        expect((await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: b.cookie } })).status).toBe(200);
        expect((await f.app.request(`${f.config.origin}/api/logout`, { method: "POST", headers: { ...headers(f, a), Cookie: b.cookie } })).status).toBe(403);
    });

    test("logs out locally during gateway outages while enforcing CSRF and draining revocations once", async () => {
        const f = setup();
        const a = await login(f, 1);
        const b = await login(f, 2);
        const revocation = Promise.withResolvers<Response>();
        f.introspectStatus(503);
        f.intercept((path) => path.endsWith("/revoke") ? revocation.promise : undefined);
        try {
            const endpoint = `${f.config.origin}/api/logout`;
            expect((await f.app.request(endpoint, { method: "POST", headers: { ...headers(f, a), "X-CSRF-Token": "wrong" } })).status).toBe(403);
            expect((await f.app.request(endpoint, { method: "POST", headers: { ...headers(f, a), Origin: "https://evil.example" } })).status).toBe(403);
            const introspections = f.calls.filter((call) => call.path.endsWith("/introspect")).length;
            const logout = await f.app.request(endpoint, { method: "POST", headers: headers(f, a) });
            expect(logout.status).toBe(204);
            expect(logout.headers.getSetCookie().join(";")).toContain(`${SESSION_COOKIE}=`);
            expect(logout.headers.getSetCookie().join(";")).toContain("Max-Age=0");
            expect(f.calls.filter((call) => call.path.endsWith("/introspect"))).toHaveLength(introspections);
            expect((await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: a.cookie } })).status).toBe(401);
            expect(f.storage.db.query("SELECT grant_id FROM pending_revocations").all()).toHaveLength(1);
            f.introspectStatus(200);
            expect((await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: b.cookie } })).status).toBe(200);
            expect((await f.app.request(`${f.config.origin}/auth/start`)).status).toBe(303);
            expect(f.calls.filter((call) => call.path.endsWith("/revoke"))).toHaveLength(1);
            revocation.resolve(new Response(null, { status: 204 }));
            await f.revokePending();
            expect(f.storage.db.query("SELECT grant_id FROM pending_revocations").all()).toHaveLength(0);
        } finally {
            revocation.resolve(new Response(null, { status: 204 }));
        }
    });

    test.each([false, true])("drains a concurrent logout without retrying the first grant in the same run (first fails: %s)", async (failFirst) => {
        const f = setup();
        const a = await login(f, 1);
        const b = await login(f, 2);
        const [firstGrant, secondGrant] = [...f.grants.keys()];
        await f.revokePending();
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let first = true;
        f.intercept(async (path, init) => {
            if (!path.endsWith("/revoke") || JSON.parse(String(init?.body)).grant_id !== firstGrant || !first) return;
            first = false;
            started.resolve();
            await release.promise;
            if (failFirst) return new Response(null, { status: 503 });
        });
        try {
            const endpoint = `${f.config.origin}/api/logout`;
            expect((await f.app.request(endpoint, { method: "POST", headers: headers(f, a) })).status).toBe(204);
            await started.promise;
            const draining = f.revokePending();
            const second = await f.app.request(endpoint, { method: "POST", headers: headers(f, b) });
            expect(second.status).toBe(204);
            expect(second.headers.getSetCookie().join(";")).toContain("Max-Age=0");
            for (const session of [a, b]) expect((await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: session.cookie } })).status).toBe(401);
            expect(f.storage.db.query("SELECT hash FROM sessions").all()).toHaveLength(0);
            expect(f.calls.filter((call) => call.path.endsWith("/revoke")).map((call) => call.json?.grant_id)).toEqual([firstGrant]);
            release.resolve();
            await draining;
            expect(f.calls.filter((call) => call.path.endsWith("/revoke")).map((call) => call.json?.grant_id)).toEqual([firstGrant, secondGrant]);
            expect(f.grants.get(secondGrant)?.active).toBe(false);
            expect(f.storage.db.query("SELECT grant_id FROM pending_revocations").all()).toEqual(failFirst ? [{ grant_id: firstGrant }] : []);
            if (failFirst) {
                await f.revokePending();
                expect(f.calls.filter((call) => call.path.endsWith("/revoke")).map((call) => call.json?.grant_id)).toEqual([firstGrant, secondGrant, firstGrant]);
                expect(f.grants.get(firstGrant)?.active).toBe(false);
                expect(f.storage.db.query("SELECT grant_id FROM pending_revocations").all()).toEqual([]);
            }
        } finally {
            release.resolve();
        }
    });

    test("a grant queued as an empty drain ends starts another drain", async () => {
        const f = setup();
        const a = await login(f, 1);
        await f.revokePending();
        const session = f.storage.db.query("SELECT * FROM sessions").get() as NonNullable<ReturnType<CanvasStorage["session"]>>;
        const ending = f.revokePending();
        const next = Promise.resolve().then(() => {
            f.storage.retire(session);
            return f.revokePending();
        });
        await Promise.all([ending, next]);
        expect(f.calls.filter((call) => call.path.endsWith("/revoke")).map((call) => call.json?.grant_id)).toEqual([session.grant_id]);
        expect(f.grants.get(session.grant_id)?.active).toBe(false);
        expect(f.storage.db.query("SELECT grant_id FROM pending_revocations").all()).toEqual([]);
        expect((await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: a.cookie } })).status).toBe(401);
    });

    test("late passive introspection cannot roll back activity or recreate a logged-out session", async () => {
        const f = setup();
        const a = await login(f, 1);
        f.time(SESSION_IDLE_SECONDS - 10);
        let delayed = Promise.withResolvers<Response>();
        let started = Promise.withResolvers<void>();
        f.intercept((path, init) => {
            if (!path.endsWith("/introspect") || JSON.parse(String(init?.body)).activity) return;
            started.resolve();
            return delayed.promise;
        });
        const passive = f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: a.cookie } });
        await started.promise;
        f.time(1);
        const active = await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: a.cookie, "X-Canvas-Activity": "1" } });
        expect(active.status).toBe(200);
        delayed.resolve(Response.json([...f.grants.values()][0]));
        expect((await passive).status).toBe(200);
        f.time(9);
        expect((await f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: a.cookie, "X-Canvas-Activity": "1" } })).status).toBe(200);

        delayed = Promise.withResolvers<Response>();
        started = Promise.withResolvers<void>();
        const late = f.app.request(`${f.config.origin}/api/session`, { headers: { Cookie: a.cookie } });
        await started.promise;
        const previouslyActive = { ...[...f.grants.values()][0] };
        expect((await f.app.request(`${f.config.origin}/api/logout`, { method: "POST", headers: headers(f, a) })).status).toBe(204);
        delayed.resolve(Response.json(previouslyActive));
        expect((await late).status).toBe(401);
        expect(f.storage.db.query("SELECT hash FROM sessions").all()).toHaveLength(0);
    });

    test.each(["openai", "gemini"])("streams trusted %s result capabilities across restart without archiving or repeating generation", async (format) => {
        const mediaCalls: string[] = [];
        let mediaAvailable = false;
        const media: typeof publicMediaResponse = async (source) => {
            mediaCalls.push(source);
            if (!mediaAvailable) throw new Error("temporary media failure");
            return new Response("remote-image", { headers: { "Content-Type": "image/png" } });
        };
        const f = setup({ publicMedia: media });
        const a = await login(f, 1);
        const b = await login(f, 2);
        const signedUrl = "https://images.example/private-result.png?signature=upstream-secret";
        const path = format === "gemini" ? "/v1beta/models/allowed-gemini:generateContent" : "/v1/images/generations";
        const payload = format === "gemini"
            ? { candidates: [{ finishReason: "STOP", content: { parts: [{ fileData: { mimeType: "image/png", fileUri: signedUrl } }, { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] } }] }
            : { created: 123, data: [{ url: signedUrl, revised_prompt: "result prompt" }, { b64_json: "aW1hZ2U=" }] };
        f.intercept((target) => target === path ? Response.json(payload) : undefined);
        const response = await f.app.request(`${f.config.origin}/api/ai${path}`, { method: "POST", headers: headers(f, a), body: JSON.stringify(format === "gemini" ? { contents: [{ parts: [{ text: "browser keeps paid result" }] }] } : { model: "allowed-image", prompt: "browser keeps paid result" }) });
        expect(response.status).toBe(200);
        expect(response.headers.get("X-Canvas-Generation-Id")).toBeNull();
        const result = await response.json();
        if (format === "gemini") {
            expect(result.candidates[0].finishReason).toBe("STOP");
            expect(result.candidates[0].content.parts[0].fileData.mimeType).toBe("image/png");
            expect(result.candidates[0].content.parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } });
        } else {
            expect(result.created).toBe(123);
            expect(result.data[0].revised_prompt).toBe("result prompt");
            expect(result.data[1]).toEqual({ b64_json: "aW1hZ2U=" });
        }
        const resultUrl = format === "gemini" ? result.candidates[0].content.parts[0].fileData.fileUri : result.data[0].url;
        expect(resultUrl).toMatch(/^\/api\/result-media\/[A-Za-z0-9_-]+$/);
        expect(JSON.stringify(result)).not.toContain(signedUrl);
        expect(mediaCalls).toEqual([]);
        const mediaURL = `${f.config.origin}${resultUrl}`;
        expect((await f.app.request(mediaURL, { headers: { Cookie: b.cookie } })).status).toBe(404);
        expect((await f.app.request(mediaURL)).status).toBe(401);
        expect((await f.app.request(`${f.config.origin}/api/result-media/forged`, { headers: { Cookie: a.cookie } })).status).toBe(404);
        expect((await f.app.request(`${f.config.origin}/api/result-media/forged?url=https://evil.example`, { headers: { Cookie: a.cookie } })).status).toBe(404);
        expect((await f.app.request(`${f.config.origin}${resultUrl.replace("result-media", "prompt-assets")}`, { headers: { Cookie: a.cookie } })).status).toBe(404);
        expect((await f.app.request(mediaURL, { headers: { Cookie: a.cookie } })).status).toBe(500);
        await f.revokePending();
        f.storage.close();
        Object.assign(f, createApp(f.config, { fetch: f.transport, publicMedia: media, audit: (event) => { f.auditEvents.push(event); }, now: f.clock }));
        await f.app.request(`${f.config.origin}/api/logout`, { method: "POST", headers: headers(f, a) });
        const renewed = await login(f, 1);
        mediaAvailable = true;
        const recovered = await f.app.request(mediaURL, { headers: { Cookie: renewed.cookie } });
        expect(recovered.status).toBe(200);
        expect(await recovered.text()).toBe("remote-image");
        expect(recovered.headers.get("content-security-policy")).toContain("sandbox");
        expect(mediaCalls).toEqual([signedUrl, signedUrl]);
        expect(f.calls.filter((call) => call.path === path)).toHaveLength(1);
        expect(existsSync(join(f.directory, "files"))).toBe(false);
        expect((await f.app.request(`${f.config.origin}/api/generations`, { headers: { Cookie: renewed.cookie } })).status).toBe(404);
    });

    test.each(["openai", "gemini"])("applies public-network checks when a trusted %s result capability is read", async (format) => {
        const f = setup();
        const a = await login(f, 1);
        const path = format === "gemini" ? "/v1beta/models/allowed-gemini:generateContent" : "/v1/images/generations";
        const payload = format === "gemini" ? { candidates: [{ content: { parts: [{ fileData: { fileUri: "http://127.0.0.1/private" } }] } }] } : { data: [{ url: "http://127.0.0.1/private" }] };
        f.intercept((target) => target === path ? Response.json(payload) : undefined);
        const generated = await f.app.request(`${f.config.origin}/api/ai${path}`, { method: "POST", headers: headers(f, a), body: JSON.stringify(format === "gemini" ? { contents: [] } : { model: "allowed-image" }) });
        expect(generated.status).toBe(200);
        const result = await generated.json();
        const resultUrl = format === "gemini" ? result.candidates[0].content.parts[0].fileData.fileUri : result.data[0].url;
        const download = await f.app.request(`${f.config.origin}${resultUrl}`, { headers: { Cookie: a.cookie } });
        expect(download.status).toBe(502);
        expect((await download.json()).error.code).toBe("MEDIA_URL_REJECTED");
        expect(existsSync(join(f.directory, "files"))).toBe(false);
    });

    test("streams video content and selected public redirects without caching either response", async () => {
        const downloads: string[] = [];
        const f = setup({ publicMedia: async (source) => {
            downloads.push(source);
            return new Response("redirected-video", { headers: { "Content-Type": "video/mp4" } });
        } });
        const a = await login(f, 1);
        await f.app.request(`${f.config.origin}/api/ai/v1/videos`, { method: "POST", headers: headers(f, a), body: JSON.stringify({ model: "allowed-video" }) });
        const path = `${f.config.origin}/api/ai/v1/videos/video_123/content`;
        f.intercept((target, init) => target === "/v1/videos/video_123/content" ? new Response(init?.method === "HEAD" ? null : "part", { status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 2-5/10", "Accept-Ranges": "bytes" } }) : undefined);
        const partial = await f.app.request(path, { headers: { Cookie: a.cookie, Range: "bytes=2-5" } });
        expect(partial.status).toBe(206);
        expect(partial.headers.get("Content-Range")).toBe("bytes 2-5/10");
        expect(await partial.text()).toBe("part");
        expect(new Headers(f.calls.findLast((call) => call.path === "/v1/videos/video_123/content")!.init?.headers).get("Range")).toBe("bytes=2-5");
        f.intercept((target) => target === "/v1/videos/video_123/content" ? new Response(null, { status: 302, headers: { Location: "https://video.example/result.mp4" } }) : undefined);
        const redirected = await f.app.request(path, { headers: { Cookie: a.cookie } });
        expect(redirected.headers.get("Location")).toBeNull();
        expect(await redirected.text()).toBe("redirected-video");
        expect(downloads).toEqual(["https://video.example/result.mp4"]);
        expect(existsSync(join(f.directory, "files"))).toBe(false);
        expect(f.calls.filter((call) => call.path === "/v1/videos")).toHaveLength(1);
    });

    test("preserves conditional media reads, async idempotency and polling metadata", async () => {
        const f = setup();
        const a = await login(f, 1);
        let conditionalStatus = 304;
        f.intercept((path) => {
            if (path === "/v1/images/generations_async") return Response.json({ task_id: "asyncimg_123" }, { status: 202, headers: { "Retry-After": "7" } });
            if (path.endsWith("/history/images/asyncimg_123")) return Response.json({ status: "pending" }, { headers: { "Retry-After": "9" } });
            if (path.endsWith("/history/images/asyncimg_123/content/0") || path === "/v1/videos/video_123/content") return new Response(null, { status: conditionalStatus, headers: { "Content-Type": "image/png", ETag: '"result-version"', Location: "https://evil.example" } });
        });
        const accepted = await f.app.request(`${f.config.origin}/api/ai/v1/images/generations_async`, { method: "POST", headers: { ...headers(f, a), "Idempotency-Key": "image-intent-1" }, body: JSON.stringify({ model: "allowed-image" }) });
        expect(accepted.status).toBe(202);
        expect(accepted.headers.get("Retry-After")).toBe("7");
        expect(await accepted.json()).toEqual({ task_id: "asyncimg_123" });
        const submitted = f.calls.findLast((call) => call.path === "/v1/images/generations_async")!;
        expect(new Headers(submitted.init?.headers).get("Idempotency-Key")).toBe("image-intent-1");
        const polled = await f.app.request(`${f.config.origin}/api/ai/v1/images/tasks_async/asyncimg_123`, { headers: { Cookie: a.cookie } });
        expect(polled.status).toBe(200);
        expect(polled.headers.get("Retry-After")).toBe("9");
        expect(await polled.json()).toEqual({ status: "pending" });
        expect((await f.app.request(`${f.config.origin}/api/ai/v1/videos`, { method: "POST", headers: headers(f, a), body: JSON.stringify({ model: "allowed-video" }) })).status).toBe(202);
        for (const path of ["/api/ai/v1/images/tasks_async/asyncimg_123/content/0", "/api/ai/v1/videos/video_123/content"]) {
            const response = await f.app.request(`${f.config.origin}${path}`, { headers: { Cookie: a.cookie, "If-None-Match": '"result-version"' } });
            expect(response.status).toBe(304);
            expect(response.headers.get("ETag")).toBe('"result-version"');
            expect(response.headers.get("Location")).toBeNull();
            expect(await response.text()).toBe("");
        }
        conditionalStatus = 302;
        expect((await f.app.request(`${f.config.origin}/api/ai/v1/images/tasks_async/asyncimg_123/content/0`, { headers: { Cookie: a.cookie } })).status).toBe(502);
    });
});
