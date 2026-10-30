import { beforeEach, afterEach, afterAll, describe, expect, test } from "bun:test";
import { browser } from "../../tests/browser";
import { mockBrowserDocuments } from "../../tests/local-document-fixture";
import { mockBrowserFiles } from "../../tests/local-file-fixture";
const originalFetch = globalThis.fetch;
const client = await import("./api/canvas-client");
const data = await import("./canvas-data");
const packages = await import("./package-import");
const sanitizers = await import("../../../plugins/canvas/sdk/src/sanitize");
const calls: Array<{ path: string; init?: RequestInit }> = [];
const session = { user: { id: "user-a", subject: `ics_${"a".repeat(32)}`, username: "alice" }, csrf_token: "csrf-a", session_tag: "public-session-a", expires_at: Math.floor(Date.now() / 1000) + 60 };
let browserDocuments: ReturnType<typeof mockBrowserDocuments>;
let browserFiles: ReturnType<typeof mockBrowserFiles> | undefined;

function respond(value: unknown, status = 200) {
    return Response.json(value, { status });
}
function mockFetch(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = ((path: string, init?: RequestInit) => {
        calls.push({ path: String(path), init });
        return Promise.resolve(handler(String(path), init));
    }) as typeof fetch;
}
async function authorize() {
    await client.readCanvasSession();
    calls.length = 0;
}

beforeEach(() => {
    client.endCanvasSession();
    localStorage.clear();
    calls.length = 0;
    mockFetch((path) => (path === "/api/session" ? respond(session) : respond({ value: null, revision: 0 })));
    browserDocuments = mockBrowserDocuments();
});
afterEach(() => {
    client.endCanvasSession();
    browserDocuments.restore();
    browserFiles?.restore();
    browserFiles = undefined;
});
afterAll(() => {
    globalThis.fetch = originalFetch;
});

describe("managed session and storage boundary", () => {
    test("does not read private state before authorization or accept external AI destinations", async () => {
        const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
        expect(useCanvasStore.getState().hydrated).toBe(false);
        expect(await data.readDocument("canvas")).toBeNull();
        await expect(client.canvasFetch("/api/data/canvas")).rejects.toThrow("授权");
        await expect(client.canvasFetch("https://other.example/v1/responses")).rejects.toThrow("同源");
        expect(calls).toEqual([]);
        await authorize();
        await expect(client.readPrivateBlob("https://other.example/image.png")).rejects.toThrow("远程素材");
        expect(calls).toEqual([]);
    });

    test("keeps generation and multipart editing on the authenticated gateway", async () => {
        await authorize();
        let document = { value: null as unknown, revision: 0 };
        mockFetch((path, init) => {
            if (path !== "/api/data/image-tasks") return respond({ value: null, revision: 0 });
            if (init?.method === "PUT") {
                const body = JSON.parse(String(init.body));
                expect(body.revision).toBe(document.revision);
                document = { value: body.value, revision: document.revision + 1 };
            }
            return respond(document);
        });
        const { useConfigStore, defaultConfig } = await import("@/stores/use-config-store");
        const config = {
            ...defaultConfig,
            baseUrl: "https://untrusted.example",
            apiKey: "must-never-send",
            model: "gateway::gpt-image-test",
            imageModel: "gateway::gpt-image-test",
            channels: [{ id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai" as const, models: [{ name: "gpt-image-test", capability: "image" as const, endpointTypes: ["image-generation"] }] }],
            models: ["gateway::gpt-image-test"],
        };
        useConfigStore.setState({ config });
        const axios = (await import("axios")).default;
        const previous = axios.defaults.adapter;
        const requests: Array<{ url?: string; body: unknown; authorization: unknown; csrf: unknown }> = [];
        axios.defaults.adapter = async (request) => {
            requests.push({ url: request.url, body: request.data, authorization: request.headers.get("Authorization"), csrf: request.headers.get("X-CSRF-Token") });
            return { config: request, data: { data: [{ b64_json: "aW1hZ2U=" }] }, status: 200, statusText: "OK", headers: {} };
        };
        try {
            const image = await import("@/services/api/image");
            await image.requestGeneration(config, "create");
            await image.requestEdit(config, "edit", [{ id: "reference", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" }]);
            expect(requests.map((request) => request.url)).toEqual(["/api/ai/v1/images/generations", "/api/ai/v1/images/edits"]);
            expect(requests.every((request) => request.authorization == null && request.csrf === "csrf-a")).toBe(true);
            expect(JSON.parse(requests[0].body as string).model).toBe("gpt-image-test");
            expect((requests[1].body as FormData).get("model")).toBe("gpt-image-test");
            expect((requests[1].body as FormData).get("image")).toBeInstanceOf(File);
            const tasks = Object.values(document.value as Record<string, { status: string; value: { result?: { data?: unknown[] } } }>);
            expect(tasks).toHaveLength(2);
            expect(tasks.every((task) => task.status === "succeeded" && task.value.result?.data?.length === 1)).toBe(true);
        } finally {
            axios.defaults.adapter = previous;
        }
    });

    test("attaches CSRF only to authenticated writes and rejects revoked sessions", async () => {
        await authorize();
        mockFetch(() => respond({ ok: true }));
        await client.canvasJson("/api/data/canvas", { method: "PUT", body: "{}" });
        expect(new Headers(calls[0].init?.headers).get("X-CSRF-Token")).toBe("csrf-a");
        mockFetch(() => respond({ error: { message: "expired" } }, 401));
        await expect(client.canvasJson("/api/data/canvas")).rejects.toThrow("expired");
        expect(client.currentSession()).toBeNull();
    });

    test("parses Responses SSE and keeps video creation, polling and content private", async () => {
        await authorize();
        const { useConfigStore, defaultConfig } = await import("@/stores/use-config-store");
        const config = {
            ...defaultConfig,
            model: "gateway::test-model",
            channels: [{ id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai" as const, models: [{ name: "test-model", capability: "text" as const, capabilities: ["text" as const, "video" as const], endpointTypes: ["openai-response", "openai-video"] }] }],
            models: ["gateway::test-model"],
        };
        useConfigStore.setState({ config });
        mockFetch((path) =>
            path === "/api/ai/v1/responses"
                ? new Response('data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.completed","response":{"output_text":"hello"}}\n\n', { headers: { "Content-Type": "text/event-stream" } })
                : respond({ value: null, revision: 0 }),
        );
        const { requestImageQuestion } = await import("@/services/api/image");
        const deltas: string[] = [];
        expect(await requestImageQuestion(config, [{ role: "user", content: "hi" }], (text) => deltas.push(text))).toBe("hello");
        expect(deltas).toEqual(["hello"]);
        const axios = (await import("axios")).default;
        const previous = axios.defaults.adapter;
        const paths: string[] = [];
        axios.defaults.adapter = async (request) => {
            paths.push(request.url!);
            const result = request.url!.endsWith("/content") ? new Blob(["video"], { type: "video/mp4" }) : request.method === "post" ? { id: "task" } : { id: "task", status: "completed" };
            return { config: request, data: result, status: 200, statusText: "OK", headers: {} };
        };
        try {
            const video = await import("@/services/api/video");
            const task = await video.createVideoGenerationTask(config, "video");
            const state = await video.pollVideoGenerationTask(config, task);
            expect(state.status).toBe("completed");
            expect(paths).toEqual(["/api/ai/v1/videos", "/api/ai/v1/videos/task", "/api/ai/v1/videos/task/content"]);
        } finally {
            axios.defaults.adapter = previous;
        }
    });

    test("uses gateway endpoint metadata for Chat Completions and native Gemini text", async () => {
        await authorize();
        const { useConfigStore, defaultConfig } = await import("@/stores/use-config-store");
        const { requestImageQuestion } = await import("@/services/api/image");
        for (const entry of [
            { model: "chat-test", endpoint: "openai", path: "/api/ai/v1/chat/completions", stream: 'data: {"choices":[{"delta":{"content":"chat"}}]}\n\n', expected: "chat" },
            { model: "gemini-test", endpoint: "gemini", path: "/api/ai/v1beta/models/gemini-test:streamGenerateContent?alt=sse", stream: 'data: {"candidates":[{"content":{"parts":[{"text":"gemini"}]}}]}\n\n', expected: "gemini" },
        ]) {
            const config = {
                ...defaultConfig,
                model: `gateway::${entry.model}`,
                channels: [{ id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai" as const, models: [{ name: entry.model, capability: "text" as const, endpointTypes: [entry.endpoint] }] }],
                models: [`gateway::${entry.model}`],
            };
            useConfigStore.setState({ config });
            const paths: string[] = [];
            mockFetch((path) => {
                if (path.startsWith("/api/ai/")) {
                    paths.push(path);
                    return new Response(entry.stream, { headers: { "Content-Type": "text/event-stream" } });
                }
                return respond({ value: null, revision: 0 });
            });
            expect(await requestImageQuestion(config, [{ role: "user", content: "hi" }], () => {})).toBe(entry.expected);
            expect(paths).toEqual([entry.path]);
        }
    });

    test("serializes independent log updates without dropping records", async () => {
        await authorize();
        let doc = { value: null as unknown, revision: 0 };
        mockFetch((_path, init) => {
            if (init?.method !== "PUT") return respond(doc);
            const body = JSON.parse(String(init.body));
            expect(body.revision).toBe(doc.revision);
            doc = { value: body.value, revision: doc.revision + 1 };
            return respond(doc);
        });
        const logs = data.createRecordStore("image-workbench");
        await Promise.all([logs.setItem("first", { result: "one" }), logs.setItem("second", { result: "two" })]);
        expect(doc.value).toEqual({ first: { result: "one" }, second: { result: "two" } });
        expect(doc.revision).toBe(2);
    });

    test("stops saving after a revision conflict instead of overwriting another tab", async () => {
        await authorize();
        mockFetch((_path, init) => (init?.method === "PUT" ? respond({ error: { message: "conflict" } }, 409) : respond({ value: { original: true }, revision: 2 })));
        await expect(data.writeDocument("canvas", { stale: true })).rejects.toThrow("conflict");
        await expect(data.writeDocument("canvas", { another: true })).rejects.toThrow("其他页面");
        expect(calls.filter((call) => call.init?.method === "PUT")).toHaveLength(1);
    });

    test("discards a response arriving after sign out", async () => {
        await authorize();
        let finish!: (response: Response) => void;
        mockFetch(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = client.canvasJson("/api/data/canvas");
        client.endCanvasSession();
        finish(respond({ private: true }));
        await expect(pending).rejects.toThrow("会话已改变");
    });

    test("another tab switching identity clears private state and rejects late responses", async () => {
        await authorize();
        await import("./canvas-bootstrap");
        const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
        useCanvasStore.getState().createProject("private A");
        expect(localStorage.getItem("infinite-canvas:session-tag")).toBe("public-session-a");
        expect([...Array(localStorage.length)].map((_, index) => localStorage.getItem(localStorage.key(index)!)).join(" ")).not.toContain("csrf-a");
        let finish!: (response: Response) => void;
        mockFetch(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = client.canvasJson("/api/data/canvas");
        localStorage.setItem("infinite-canvas:session-tag", "public-session-b");
        window.dispatchEvent(new browser.StorageEvent("storage", { key: "infinite-canvas:session-tag", newValue: "public-session-b" }));
        expect(client.currentSession()).toBeNull();
        expect(useCanvasStore.getState().projects).toEqual([]);
        finish(respond({ private: "A" }));
        await expect(pending).rejects.toThrow("会话已改变");
    });

    test("a same-session tab does not sign out peers and stale logout cannot sign out a new session", async () => {
        await authorize();
        window.dispatchEvent(new browser.StorageEvent("storage", { key: "infinite-canvas:session-tag", newValue: "public-session-a" }));
        expect(client.currentSession()?.user.subject).toBe(session.user.subject);
        window.dispatchEvent(new browser.StorageEvent("storage", { key: "infinite-canvas:logout-tag", newValue: "old-session" }));
        expect(client.currentSession()).not.toBeNull();
        window.dispatchEvent(new browser.StorageEvent("storage", { key: "infinite-canvas:logout-tag", newValue: "public-session-a" }));
        expect(client.currentSession()).toBeNull();
    });

    test("an old bootstrap response cannot replace a newer shared session tag", async () => {
        localStorage.setItem("infinite-canvas:session-tag", "public-session-a");
        let finish!: (response: Response) => void;
        mockFetch(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = client.readCanvasSession();
        localStorage.setItem("infinite-canvas:session-tag", "public-session-b");
        finish(respond(session));
        await expect(pending).rejects.toThrow("其他标签页");
        expect(localStorage.getItem("infinite-canvas:session-tag")).toBe("public-session-b");
        expect(client.currentSession()).toBeNull();
    });

    test("late unauthorized responses cannot end a replacement session", async () => {
        await authorize();
        let finish!: (response: Response) => void;
        mockFetch(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = client.canvasJson("/api/data/canvas");
        client.endCanvasSession();
        const replacement = { ...session, session_tag: "public-session-b", csrf_token: "csrf-b" };
        mockFetch(() => respond(replacement));
        await client.readCanvasSession();
        finish(respond({ error: { message: "old authorization expired" } }, 401));
        await expect(pending).rejects.toThrow("会话已改变");
        expect(client.currentSession()?.session_tag).toBe("public-session-b");
    });

    test("session checks preserve the active session on temporary failures and terminate confirmed expiry", async () => {
        await authorize();
        const epoch = client.sessionEpoch();
        for (const status of [429, 503]) {
            mockFetch(() => respond({ error: { message: "temporarily unavailable" } }, status));
            await expect(client.readCanvasSession()).rejects.toMatchObject({ retryable: true, status });
            expect(client.currentSession()).toEqual(session);
            expect(client.sessionEpoch()).toBe(epoch);
        }
        mockFetch(() => {
            throw new TypeError("Failed to fetch");
        });
        await expect(client.readCanvasSession(true)).rejects.toMatchObject({ retryable: true });
        expect(client.currentSession()).toEqual(session);
        mockFetch(() => respond({ ...session, expires_at: Math.floor(Date.now() / 1000) - 1 }));
        await expect(client.readCanvasSession()).rejects.toMatchObject({ retryable: false });
        expect(client.currentSession()).toBeNull();
    });

    test("a delayed session-check rejection cannot invalidate a replacement login", async () => {
        await authorize();
        const delayed = Promise.withResolvers<Response>();
        mockFetch(() => delayed.promise);
        const pending = client.readCanvasSession();
        client.endCanvasSession();
        const replacement = { ...session, session_tag: "public-session-b", csrf_token: "csrf-b" };
        mockFetch(() => respond(replacement));
        await client.readCanvasSession();
        delayed.resolve(respond({ error: { message: "old authorization expired" } }, 401));
        await expect(pending).rejects.toThrow("会话已改变");
        expect(client.currentSession()?.session_tag).toBe("public-session-b");
    });

    test("bootstrap retries without showing private UI and transient rechecks retain the mounted draft and AI request", async () => {
        const { act, createElement } = await import("react");
        const { createRoot } = await import("react-dom/client");
        const { ClientRootInit } = await import("./../components/layout/client-root-init");
        const i18n = (await import("@/i18n")).default;
        const globals = { HTMLElement: browser.HTMLElement, SVGElement: browser.SVGElement, Element: browser.Element, ShadowRoot: browser.ShadowRoot, getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true };
        const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
        for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        let status = 503;
        const slow = Promise.withResolvers<Response>();
        let requestSignal: AbortSignal | undefined;
        mockFetch((path, init) => {
            if (path === "/api/session") return status === 200 ? respond(session) : respond({ error: { message: "session unavailable" } }, status);
            if (path === "/api/slow") {
                requestSignal = init?.signal || undefined;
                return slow.promise;
            }
            if (path === "/api/models") return respond({ data: [] });
            return respond(init?.method === "PUT" ? JSON.parse(String(init.body)) : { value: null, revision: 0 });
        });
        try {
            await act(async () => root.render(createElement(ClientRootInit, { children: createElement("input", { "data-draft": true, defaultValue: "unsaved draft" }) })));
            expect(container.querySelector("[data-draft]")).toBeNull();
            expect(client.currentSession()).toBeNull();
            const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.replace(/\s/g, "") === i18n.t("workbench.retry"));
            expect(retry).toBeDefined();
            status = 200;
            await act(async () => retry!.click());
            const draft = container.querySelector("[data-draft]") as HTMLInputElement;
            expect(draft?.value).toBe("unsaved draft");
            const pending = client.canvasJson("/api/slow");
            status = 503;
            await act(async () => window.dispatchEvent(new browser.Event("focus")));
            expect(client.currentSession()?.session_tag).toBe(session.session_tag);
            expect(container.querySelector("[data-draft]")).toBe(draft);
            expect(requestSignal?.aborted).toBe(false);
            expect(container.textContent).toContain(i18n.t("managed.connectionInterrupted"));
            status = 200;
            await act(async () => window.dispatchEvent(new browser.Event("focus")));
            expect(container.textContent).not.toContain(i18n.t("managed.connectionInterrupted"));
            slow.resolve(respond({ completed: true }));
            expect(await pending).toEqual({ completed: true });
            status = 401;
            await act(async () => window.dispatchEvent(new browser.Event("focus")));
            expect(client.currentSession()).toBeNull();
            expect(container.querySelector("[data-draft]")).toBeNull();
        } finally {
            slow.resolve(respond({ completed: true }));
            await act(async () => root.unmount());
            container.remove();
            if (visibility) Object.defineProperty(document, "visibilityState", visibility);
            else Reflect.deleteProperty(document, "visibilityState");
            for (const [key, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        }
    });

    test("hydrates the actual stores only after authorization and loads gateway models", async () => {
        await authorize();
        mockFetch((path) => (path === "/api/models" ? respond({ data: [{ id: "gpt-image-test", supported_endpoint_types: ["image-generation"] }] }) : respond({ value: null, revision: 0 })));
        const { hydrateCanvasSession } = await import("./canvas-bootstrap");
        await hydrateCanvasSession(session);
        const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
        const { useAssetStore } = await import("@/stores/use-asset-store");
        const { useConfigStore } = await import("@/stores/use-config-store");
        expect(useCanvasStore.getState().hydrated).toBe(true);
        expect(useAssetStore.getState().hydrated).toBe(true);
        expect(useConfigStore.getState().config.models).toEqual(["gateway::gpt-image-test"]);
    });
});

describe("private package and trusted content compatibility", () => {
    test("a canvas package finishing its read after account replacement cannot upload or import into the new account", async () => {
        const { act, createElement } = await import("react");
        const { createRoot } = await import("react-dom/client");
        const { App, ConfigProvider } = await import("antd");
        const { MemoryRouter } = await import("react-router-dom");
        const { zipSync } = await import("fflate");
        const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
        const globals = { HTMLAnchorElement: browser.HTMLAnchorElement, HTMLElement: browser.HTMLElement, SVGElement: browser.SVGElement, Element: browser.Element, ShadowRoot: browser.ShadowRoot, getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } };
        const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
        for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        const matchMedia = browser.matchMedia;
        browser.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, media: "", onchange: null });
        useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: true });
        await authorize();
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const pending = Promise.withResolvers<ArrayBuffer>();
        const file = new File([], "private-canvas.zip");
        let reads = 0;
        Object.defineProperty(file, "arrayBuffer", { value: () => { reads += 1; return pending.promise; } });
        const archive = zipSync({
            "projects.json": new TextEncoder().encode(JSON.stringify({ app: "infinite-canvas", version: 3, projects: [{ project: { id: "old-owner-project", title: "Private project", nodes: [], connections: [] }, files: [{ storageKey: "image:old", path: "files/private.png", mimeType: "image/png" }] }] })),
            "files/private.png": new TextEncoder().encode("private image"),
        });
        try {
            const { default: CanvasPage } = await import("@/pages/canvas");
            await act(async () => root.render(createElement(MemoryRouter, null, createElement(ConfigProvider, { theme: { token: { motion: false } } }, createElement(App, null, createElement(CanvasPage))))));
            const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
            expect(input).not.toBeNull();
            Object.defineProperty(input, "files", { configurable: true, value: [file] });
            await act(async () => input.dispatchEvent(new browser.Event("change", { bubbles: true })));
            expect(reads).toBe(1);
            await act(async () => {
                client.endCanvasSession();
                mockFetch(() => respond({ ...session, user: { ...session.user, id: "user-b", subject: `ics_${"b".repeat(32)}` }, session_tag: "public-session-b" }));
                await client.readCanvasSession();
                useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: true });
            });
            calls.length = 0;
            await act(async () => pending.resolve(archive.buffer as ArrayBuffer));
            expect(useCanvasStore.getState().projects).toEqual([]);
            expect(calls).toEqual([]);
        } finally {
            pending.resolve(archive.buffer as ArrayBuffer);
            await act(async () => root.unmount());
            container.remove();
            client.endCanvasSession();
            useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
            browser.matchMedia = matchMedia;
            for (const [key, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        }
    });

    test("imports allocate new resources and preserve unknown node fields and connections", async () => {
        await authorize();
        browserFiles = mockBrowserFiles();
        mockFetch(() => respond({ id: "new", storageKey: "image:new", url: "blob:mock-new", mimeType: "image/png", bytes: 3 }));
        const mapping = await packages.importPackageFiles([{ storageKey: "image:old", path: "files/source.png", mimeType: "image/png" }], new Map([["files/source.png", new Blob(["png"], { type: "image/png" })]]));
        const project = {
            owner: "attacker",
            nodes: [{ id: "node", type: "unknown:node", extra: { retain: true }, metadata: { storageKey: "image:old", content: "blob:old", references: ["image:old"] } }],
            connections: [{ id: "edge", fromNodeId: "node", toNodeId: "other" }],
        };
        const imported = packages.remapPackageResources(project, mapping);
        expect(imported).not.toHaveProperty("owner");
        expect(imported.nodes[0]).toEqual({ id: "node", type: "unknown:node", extra: { retain: true }, metadata: { storageKey: "image:new", content: "blob:mock-new", references: ["image:new"] } });
        expect(imported.connections).toEqual(project.connections);
        await expect(packages.importPackageFiles([{ storageKey: "image:missing", path: "missing.png", mimeType: "image/png" }], new Map())).rejects.toThrow("缺少素材");
    });

    test("SVG preserves vector shapes while removing scripts, events, foreignObject and references", () => {
        const output = sanitizers.sanitizeSvg(
            '<svg onload="alert(1)"><rect width="20" height="10"/><script>alert(1)</script><foreignObject><div>unsafe</div></foreignObject><a href="javascript:alert(1)"><text>link</text></a><use href="https://evil.example/x.svg#x"/><animate attributeName="href" values="javascript:alert(1)"/></svg>',
        );
        expect(output).toContain("<rect");
        expect(output).not.toMatch(/onload|script|foreignObject|javascript:|<use|<animate|href=/i);
    });

    test("Markdown keeps ordinary content while stripping raw HTML execution", () => {
        const output = sanitizers.renderSafeMarkdown('# Heading\n\n**text**\n\n<img src=x onerror="alert(1)"><a href="javascript:alert(1)">bad</a><iframe srcdoc="<script>alert(1)</script>"></iframe>');
        expect(output).toContain("<h1>Heading</h1>");
        expect(output).toContain("<strong>text</strong>");
        expect(output).not.toMatch(/onerror|javascript:|iframe|script/i);
    });
});
