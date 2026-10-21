import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createApp, type SecurityAuditEvent } from "../src/app.ts";
import { SESSION_IDLE_SECONDS, SESSION_SECONDS, type ServerConfig } from "../src/config.ts";
import { publicMediaResponse, type Fetcher } from "../src/gateway.ts";
import { SESSION_COOKIE, TRANSACTION_COOKIE } from "../src/security.ts";
import type { CanvasStorage } from "../src/storage.ts";

const fixtures: { storage: CanvasStorage; directory: string }[] = [];
afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
        fixture.storage.close();
        const resolved = realpathSync(fixture.directory);
        if (dirname(resolved) !== realpathSync(tmpdir()) || !basename(resolved).startsWith("canvas-server-test-")) throw new Error("Refusing to delete an unexpected test directory");
        rmSync(resolved, { recursive: true, force: true });
    }
});

function setup() {
    const directory = mkdtempSync(join(tmpdir(), "canvas-server-test-"));
    const config: ServerConfig = { origin: "https://canvas.example", gatewayUrl: "http://new-api.internal", gatewayPublicUrl: "https://gateway.example", clientId: "infinite-canvas", clientSecret: "test-client-secret", encryptionKey: randomBytes(32).toString("base64"), dataDir: directory };
    let currentTime = 1_800_000_000;
    const calls: { path: string; url: string; init?: RequestInit; json?: Record<string, unknown> }[] = [];
    const grants = new Map<string, { active: boolean; reason?: string; user: { id: number; subject: string; username: string; display_name: string }; expires_at: number }>();
    const subjects = new Map<number, string>();
    let paidFailure = false;
    let introspectionStatus = 200;
    let failStream = false;
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
    const service = createApp(config, { fetch: transport, publicResource: resource, audit: (event) => { auditEvents.push(event); }, now: () => currentTime });
    const fixture = { ...service, directory, config, grants, subjects, calls, transport, resourceCalls, auditEvents, clock: () => currentTime, time: (seconds: number) => { currentTime += seconds; }, failPaid: () => { paidFailure = true; }, failStream: () => { failStream = true; }, introspectStatus: (status: number) => { introspectionStatus = status; } };
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

    test("enforces origin and CSRF and uses revision CAS without crossing owners", async () => {
        const f = setup();
        const a = await login(f, 1);
        const b = await login(f, 2);
        const url = `${f.config.origin}/api/data/canvas`;
        const body = JSON.stringify({ value: { projects: ["A private project"] }, revision: 0 });
        expect((await f.app.request(url, { method: "PUT", body, headers: { Cookie: a.cookie, Origin: f.config.origin, "Content-Type": "application/json" } })).status).toBe(403);
        expect((await f.app.request(url, { method: "PUT", body, headers: { ...headers(f, a), Origin: "https://sibling.example" } })).status).toBe(403);
        const saved = await f.app.request(url, { method: "PUT", body, headers: headers(f, a) });
        expect(saved.status).toBe(200);
        expect((await saved.json()).revision).toBe(1);
        expect((await f.app.request(url, { method: "PUT", body, headers: headers(f, a) })).status).toBe(409);
        const other = await f.app.request(url, { headers: { Cookie: b.cookie } });
        expect(await other.json()).toEqual({ value: null, revision: 0 });
        expect((await f.app.request(url)).status).toBe(401);
        expect((await f.app.request(url, { headers: { Cookie: a.cookie, "Sec-Fetch-Site": "same-site" } })).status).toBe(403);
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

    test("keeps files private, allocates opaque identifiers and handles byte ranges", async () => {
        const f = setup();
        const a = await login(f, 1);
        const b = await login(f, 2);
        const form = new FormData();
        form.set("file", new File(["private-image"], "../../dangerous.svg", { type: "image/svg+xml" }));
        form.set("kind", "image");
        const uploadHeaders = headers(f, a);
        delete uploadHeaders["Content-Type"];
        const upload = await f.app.request(`${f.config.origin}/api/files`, { method: "POST", headers: uploadHeaders, body: form });
        expect(upload.status).toBe(201);
        const file = await upload.json() as { id: string; url: string; storageKey: string };
        expect(file.id).toMatch(/^[a-f\d-]+$/);
        const read = await f.app.request(`${f.config.origin}${file.url}`, { headers: { Cookie: a.cookie, Range: "bytes=0-6" } });
        expect(read.status).toBe(206);
        expect(await read.text()).toBe("private");
        expect(read.headers.get("content-disposition")).toBe("attachment");
        expect(read.headers.get("content-security-policy")).toContain("sandbox");
        expect((await f.app.request(`${f.config.origin}${file.url}`, { headers: { Cookie: b.cookie } })).status).toBe(404);
        expect((await f.app.request(`${f.config.origin}${file.url}`, { method: "DELETE", headers: headers(f, b) })).status).toBe(404);
        expect((await f.app.request(`${f.config.origin}${file.url}`)).status).toBe(401);
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
        const records = await (await f.app.request(`${f.config.origin}/api/generations`, { headers: { Cookie: a.cookie } })).json();
        expect(records.records[0].status).toBe("succeeded");
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

    test("persists async ownership and records unknown execution without automatically charging twice", async () => {
        const f = setup();
        const a = await login(f, 1);
        const b = await login(f, 2);
        const create = await f.app.request(`${f.config.origin}/api/ai/v1/videos`, { method: "POST", headers: headers(f, a), body: JSON.stringify({ model: "allowed-video", prompt: "video" }) });
        expect(create.status).toBe(202);
        expect((await f.app.request(`${f.config.origin}/api/ai/v1/videos/video_123`, { headers: { Cookie: a.cookie } })).status).toBe(200);
        expect((await f.app.request(`${f.config.origin}/api/ai/v1/videos/video_123`, { headers: { Cookie: b.cookie } })).status).toBe(404);
        f.failPaid();
        const failed = await f.app.request(`${f.config.origin}/api/ai/v1/images/generations`, { method: "POST", headers: headers(f, a), body: JSON.stringify({ model: "allowed-image", prompt: "image" }) });
        expect(failed.status).toBe(502);
        expect(f.calls.filter((call) => call.path === "/v1/images/generations")).toHaveLength(1);
        const rows = f.storage.db.query("SELECT status FROM generations WHERE kind = 'image'").all();
        expect(rows).toEqual([{ status: "execution_unknown" }]);
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

    test("fails closed during authorization outages and keeps private state across a database reopen", async () => {
        const f = setup();
        const a = await login(f, 1);
        const put = await f.app.request(`${f.config.origin}/api/data/canvas`, { method: "PUT", headers: headers(f, a), body: JSON.stringify({ revision: 0, value: { projects: ["persistent"] } }) });
        expect(put.status).toBe(200);
        f.introspectStatus(503);
        expect((await f.app.request(`${f.config.origin}/api/data/canvas`, { headers: { Cookie: a.cookie } })).status).toBe(503);
        f.introspectStatus(200);
        f.storage.close();
        Object.assign(f, createApp(f.config, { fetch: f.transport, audit: (event) => { f.auditEvents.push(event); }, now: f.clock }));
        const restored = await f.app.request(`${f.config.origin}/api/data/canvas`, { headers: { Cookie: a.cookie } });
        expect(restored.status).toBe(200);
        expect(await restored.json()).toEqual({ value: { projects: ["persistent"] }, revision: 1 });
    });

    test("serves historical async media only through the current grant after a new authorization", async () => {
        const f = setup();
        const a = await login(f, 1);
        const accepted = await f.app.request(`${f.config.origin}/api/ai/v1/images/generations_async`, { method: "POST", headers: headers(f, a), body: JSON.stringify({ model: "allowed-image" }) });
        expect(accepted.status).toBe(202);
        expect((await accepted.json()).query_url).toBe("/api/ai/v1/images/tasks_async/asyncimg_123");
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

    test("records an upstream SSE error as failed while retaining the original stream", async () => {
        const f = setup();
        const a = await login(f, 1);
        f.failStream();
        const stream = await f.app.request(`${f.config.origin}/api/ai/v1/responses`, { method: "POST", headers: headers(f, a), body: JSON.stringify({ model: "allowed-text", input: "hello" }) });
        expect(await stream.text()).toContain("response.failed");
        const rows = await (await f.app.request(`${f.config.origin}/api/generations`, { headers: { Cookie: a.cookie } })).json();
        expect(rows.records[0].status).toBe("failed");
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
        expect(f.resourceCalls).toHaveLength(2);
    });

    test("never assigns an old owner's canvas to a recreated account with the same numeric ID", async () => {
        const f = setup();
        const old = await login(f, 1);
        await f.app.request(`${f.config.origin}/api/data/canvas`, { method: "PUT", headers: headers(f, old), body: JSON.stringify({ value: { projects: ["old account secret"] }, revision: 0 }) });
        const nextSubject = `ics_${randomBytes(16).toString("hex")}`;
        f.subjects.set(1, nextSubject);
        for (const grant of f.grants.values()) if (grant.user.id === 1) grant.user.subject = nextSubject;
        const recreated = await login(f, 1);
        const result = await f.app.request(`${f.config.origin}/api/data/canvas`, { headers: { Cookie: recreated.cookie } });
        expect(await result.json()).toEqual({ value: null, revision: 0 });
        expect((await f.app.request(`${f.config.origin}/api/data/canvas`, { headers: { Cookie: old.cookie } })).status).toBe(401);
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
});
