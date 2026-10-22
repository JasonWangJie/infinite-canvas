import { afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { browser } from "../../../tests/browser";
import { mockBrowserDocuments } from "../../../tests/local-document-fixture";
import { mockBrowserFiles } from "../../../tests/local-file-fixture";
import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { endCanvasSession, readCanvasSession } from "@/services/api/canvas-client";
import { readDocument, writeDocument } from "@/services/canvas-data";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { deleteVideoGenerationLogs, logStore, resumeVideoGeneration, type GenerationLog } from "./generation-log";
import { createVideoGenerationTask, VideoGenerationUncertainError } from "@/services/api/video";
import i18n from "@/i18n";
import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import * as imageStorage from "@/services/image-storage";
import { readImageTaskRecords } from "@/services/image-task-records";

const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
const session = { user: { id: "video-user", subject: `ics_${"a".repeat(32)}`, username: "video" }, csrf_token: "csrf", session_tag: "video-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
const config = {
    ...defaultConfig,
    baseUrl: "/api/ai",
    model: "gateway::video-model",
    videoModel: "gateway::video-model",
    channels: [{ id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai" as const, models: [{ name: "video-model", capability: "video" as const, endpointTypes: ["openai-video"] }] }],
};
const requests: Array<{ method?: string; url?: string }> = [];
const fileRequests: string[] = [];
let documents: Record<string, { value: unknown; revision: number }>;
let uploadFails = false;
let uploadGate: Promise<void> | undefined;
let notifyUpload: (() => void) | undefined;
let poll: (request: InternalAxiosRequestConfig) => Promise<AxiosResponse>;
let browserDocuments: ReturnType<typeof mockBrowserDocuments>;
let browserFiles: ReturnType<typeof mockBrowserFiles>;

// Load the real canvas outside individual behavior tests; its first module graph is large.
beforeAll(async () => { await import("@/pages/canvas/project"); }, 60000);

function response(request: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
    return { data, status: 200, statusText: "OK", headers: {}, config: request };
}
function log(): GenerationLog {
    return {
        id: "log-1",
        createdAt: Date.now(),
        title: "test",
        prompt: "test",
        time: "now",
        model: config.model,
        config,
        references: [],
        durationMs: 0,
        size: "1280x720",
        resolution: "720",
        seconds: "5",
        status: "pending",
        task: { id: "task-existing", provider: "openai", model: config.model },
    };
}

beforeEach(async () => {
    endCanvasSession();
    localStorage.clear();
    requests.length = 0;
    fileRequests.length = 0;
    documents = { "video-workbench": { value: { "log-1": log() }, revision: 1 } };
    uploadFails = false;
    uploadGate = undefined;
    notifyUpload = undefined;
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/session") return Response.json(session);
        if (path.startsWith("/api/data/")) {
            const domain = path.slice("/api/data/".length);
            if (init?.method === "PUT") {
                const body = JSON.parse(String(init.body));
                documents[domain] = { value: body.value, revision: body.revision + 1 };
            }
            return Response.json(documents[domain] || { value: null, revision: 0 });
        }
        fileRequests.push(`${init?.method || "GET"} ${path}`);
        if (path === "/api/files" && init?.method === "POST") {
            notifyUpload?.();
            await uploadGate;
            return uploadFails
                ? Response.json({ error: { message: "storage temporarily unavailable" } }, { status: 503 })
                : Response.json({ id: "video-file", storageKey: "media:shared", url: "blob:mock-video", mimeType: "video/mp4", bytes: 5 });
        }
        return new Response("video");
    }) as typeof fetch;
    browserDocuments = mockBrowserDocuments();
    browserFiles = mockBrowserFiles();
    poll = async (request) => response(request, { id: "task-existing", status: "completed" });
    axios.defaults.adapter = async (request) => {
        requests.push({ method: request.method, url: request.url });
        if (request.url?.endsWith("/content")) return response(request, new Blob(["video"], { type: "application/octet-stream" }));
        return poll(request);
    };
    await readCanvasSession();
    useConfigStore.setState({ config });
});

afterEach(() => {
    endCanvasSession();
    browserDocuments.restore();
    browserFiles.restore();
    globalThis.fetch = originalFetch;
    axios.defaults.adapter = originalAdapter;
    void browser;
});

test("a transient query failure preserves the task and resuming only queries the original task", async () => {
    poll = async () => {
        throw new Error("temporary 503");
    };
    const paused = await resumeVideoGeneration(log(), config);
    expect(paused.status).toBe("paused");
    expect((await logStore.getItem<GenerationLog>(paused.id))?.task?.id).toBe("task-existing");
    poll = async (request) => response(request, { id: "task-existing", status: "completed" });
    const completed = await resumeVideoGeneration(paused, config);
    expect(completed.status).toBe("success");
    expect(completed.video?.storageKey).toBe("media:shared");
    expect(requests.every((request) => request.method === "get" && request.url?.startsWith("/api/ai/v1/videos/task-existing"))).toBe(true);
    expect(fileRequests).toEqual(["POST /api/files"]);
});

test("a session change during video preparation stops submission before the paid request", async () => {
    const request = createVideoGenerationTask(config, "prompt");
    endCanvasSession();
    await expect(request).rejects.toThrow();
    expect(requests).toEqual([]);
});

test("an already aborted video intent is a local failure without submission", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await createVideoGenerationTask(config, "prompt", [], { signal: controller.signal }).catch((error) => error);
    expect(error).toBeInstanceOf(DOMException);
    expect(error).not.toBeInstanceOf(VideoGenerationUncertainError);
    expect(requests).toEqual([]);
});

test.each(["/api/result-media/signed_result-token", "/api/ai/v1/videos/task-existing/content"])("a completed response containing %s downloads through the authenticated gateway", async (url) => {
    poll = async (request) => response(request, { id: "task-existing", status: "succeeded", content: { video_url: url } });
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        if (String(input) === url) expect(new Headers(init?.headers).get("X-Canvas-Session-Tag")).toBe("video-session");
        return transport(input, init);
    }) as typeof fetch;
    const result = await resumeVideoGeneration(log(), config);
    expect(result.status).toBe("success");
    expect(result.video?.storageKey).toBe("media:shared");
    expect(requests).toEqual([{ method: "get", url: "/api/ai/v1/videos/task-existing" }]);
    expect(fileRequests).toEqual([`GET ${url}`, "POST /api/files"]);
});

test.each(["failed", "cancelled"])("an explicit upstream %s state is terminal", async (status) => {
    poll = async (request) => response(request, { id: "task-existing", status, error: { message: "provider rejected the request" } });
    const result = await resumeVideoGeneration(log(), config);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("provider rejected the request");
    expect(fileRequests).toEqual([]);
});

test("a storage failure can resume from the original successful upstream task", async () => {
    uploadFails = true;
    const paused = await resumeVideoGeneration(log(), config);
    expect(paused.status).toBe("paused");
    expect(paused.task?.id).toBe("task-existing");
    uploadFails = false;
    expect((await resumeVideoGeneration(paused, config)).status).toBe("success");
    expect(requests.every((request) => request.method === "get")).toBe(true);
});

test("resuming an already stored video only saves its history without downloading or uploading again", async () => {
    const saved: GenerationLog = { ...log(), status: "paused", video: { id: "video", url: "blob:mock-video", storageKey: "media:shared", durationMs: 1000, width: 1280, height: 720, bytes: 5, mimeType: "video/mp4" } };
    const result = await resumeVideoGeneration(saved, config);
    expect(result.status).toBe("success");
    expect((await logStore.getItem<GenerationLog>(saved.id))?.video?.storageKey).toBe("media:shared");
    expect(requests).toEqual([]);
    expect(fileRequests).toEqual([]);
});

test("concurrent observers share one task recovery and deleted history stays deleted", async () => {
    let finish!: () => void;
    let queried!: () => void;
    const started = new Promise<void>((resolve) => {
        queried = resolve;
    });
    poll = async (request) => {
        queried();
        await new Promise<void>((resolve) => {
            finish = resolve;
        });
        return response(request, { id: "task-existing", status: "completed" });
    };
    await writeDocument("assets", { video: { storageKey: "media:shared" } });
    await writeDocument("canvas", { node: { storageKey: "media:shared" } });
    const first = resumeVideoGeneration(log(), config);
    const second = resumeVideoGeneration(log(), config);
    expect(first).toBe(second);
    await started;
    await deleteVideoGenerationLogs(["log-1"]);
    finish();
    await Promise.all([first, second]);
    expect(await logStore.getItem("log-1")).toBeNull();
    expect(await readDocument("assets")).toEqual({ video: { storageKey: "media:shared" } });
    expect(await readDocument("canvas")).toEqual({ node: { storageKey: "media:shared" } });
    expect(fileRequests).toEqual(["POST /api/files"]);
    expect(requests).toHaveLength(2);
});

test("a stale recovery action does not recreate deleted history or query its task", async () => {
    await deleteVideoGenerationLogs(["log-1"]);
    const result = await resumeVideoGeneration(log(), config);
    expect(result.status).toBe("paused");
    expect(await logStore.getItem("log-1")).toBeNull();
    expect(requests).toEqual([]);
    expect(fileRequests).toEqual([]);
});

test("switching sessions stops recovery before it can upload the old user's result", async () => {
    let finish!: () => void;
    let queried!: () => void;
    const started = new Promise<void>((resolve) => {
        queried = resolve;
    });
    poll = async (request) => {
        queried();
        await new Promise<void>((resolve) => {
            finish = resolve;
        });
        return response(request, { id: "task-existing", status: "completed" });
    };
    const recovery = resumeVideoGeneration(log(), config);
    await started;
    endCanvasSession();
    finish();
    await recovery;
    expect(fileRequests).toEqual([]);
    expect((documents["video-workbench"].value as Record<string, GenerationLog>)["log-1"].status).toBe("pending");
});

async function canvasVideoFixture(projects: CanvasProject[]) {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { createMemoryRouter, RouterProvider } = await import("react-router-dom");
    const globals = {
        __APP_VERSION__: "test",
        __APP_RELEASES__: [],
        IS_REACT_ACT_ENVIRONMENT: true,
        ResizeObserver: class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
        requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
        cancelAnimationFrame: clearTimeout,
    };
    const browserGlobals = [
        "Element",
        "HTMLElement",
        "HTMLAnchorElement",
        "HTMLImageElement",
        "HTMLVideoElement",
        "MouseEvent",
        "XMLHttpRequest",
        "SVGElement",
        "HTMLInputElement",
        "HTMLTextAreaElement",
        "HTMLSelectElement",
        "ShadowRoot",
        "DocumentFragment",
        "MutationObserver",
        "Node",
        "navigator",
        "getComputedStyle",
    ];
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of [...Object.entries(globals), ...browserGlobals.map((key) => [key, Reflect.get(browser, key)] as const)]) {
        previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const previousMatchMedia = browser.matchMedia;
    browser.matchMedia = () => ({
        matches: false,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
            return true;
        },
        media: "",
        onchange: null,
    });
    const pluginLoader = { ...(await import("@/lib/canvas/plugin-loader")) };
    mock.module("@/lib/canvas/plugin-loader", () => ({ ...pluginLoader, ensurePluginsLoaded: async () => {} }));
    const { App } = await import("antd");
    const { default: CanvasPage } = await import("@/pages/canvas/project");
    const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
    useCanvasStore.setState({ hydrated: true, projects, deletedProjects: [] });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const router = createMemoryRouter([{ path: "/canvas/:id", element: React.createElement(App, {}, React.createElement(CanvasPage)) }], { initialEntries: ["/canvas/a"] });
    const close = async () => {
        await React.act(async () => {
            root.unmount();
        });
        container.remove();
        mock.module("@/lib/canvas/plugin-loader", () => pluginLoader);
        browser.matchMedia = previousMatchMedia;
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    };
    await React.act(async () => root.render(React.createElement(RouterProvider, { router })));
    return { act: React.act, router, container, useCanvasStore, close };
}

function videoProjects(metadata: CanvasNodeData["metadata"]): CanvasProject[] {
    const base = { title: "project", createdAt: "now", updatedAt: "now", connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines" as const, showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
    const node = { id: "shared-node", type: "video" as const, title: "video", position: { x: 0, y: 0 }, width: 100, height: 100 };
    return [
        { ...base, id: "a", nodes: [{ ...node, metadata }] },
        { ...base, id: "b", nodes: [{ ...node, metadata: { status: "success", content: "blob:mock-original-b" } }] },
    ];
}

async function retryCanvasVideo(fixture: Awaited<ReturnType<typeof canvasVideoFixture>>) {
    const button = [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].find((item) => [i18n.t("canvas.node.retry"), i18n.t("managed.resumeImage")].includes(item.textContent || ""));
    expect(Boolean(button)).toBe(true);
    await fixture.act(async () => button!.click());
}

async function undoCanvasVideo(fixture: Awaited<ReturnType<typeof canvasVideoFixture>>) {
    await fixture.act(async () => { window.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })); });
    await fixture.act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

test("switching canvas projects while video storage is pending cannot overwrite the destination project", async () => {
    let finishStorage!: () => void;
    uploadGate = new Promise<void>((resolve) => { finishStorage = resolve; });
    const uploading = new Promise<void>((resolve) => { notifyUpload = resolve; });
    const fixture = await canvasVideoFixture(videoProjects({ status: "loading", model: config.model, videoTaskId: "task-existing", videoTaskProvider: "openai" }));
    try {
        await uploading;
        await fixture.act(async () => { await fixture.router.navigate("/canvas/b"); });
        await fixture.act(async () => { finishStorage(); });
        expect(fixture.useCanvasStore.getState().openProject("b")?.nodes[0].metadata?.content).toBe("blob:mock-original-b");
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes[0].metadata?.videoTaskId).toBe("task-existing");
    } finally {
        finishStorage();
        await fixture.close();
    }
});

test("canvas video saves its unknown intent before POST and never retries it after a lost response or reload", async () => {
    poll = async () => {
        const saved = documents.canvas.value as { state: { projects: CanvasProject[] } };
        expect(saved.state.projects.find((project) => project.id === "a")?.nodes[0].metadata?.videoSubmissionUnknown).toBe(true);
        throw new axios.AxiosError("response lost", "ERR_NETWORK");
    };
    const fixture = await canvasVideoFixture(videoProjects({ status: "error", prompt: "new video", model: config.model }));
    try {
        await retryCanvasVideo(fixture);
        expect(requests).toEqual([{ method: "post", url: "/api/ai/v1/videos" }]);
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes[0].metadata?.videoSubmissionUnknown).toBe(true);
        await undoCanvasVideo(fixture);
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes[0].metadata?.videoSubmissionUnknown).toBe(true);
        await retryCanvasVideo(fixture);
        await fixture.act(async () => { await fixture.router.navigate("/canvas/b"); });
        await fixture.act(async () => { await fixture.router.navigate("/canvas/a"); });
        expect(fixture.container.textContent).toContain(i18n.t("managed.imageTaskUnknown"));
        await retryCanvasVideo(fixture);
        expect(requests).toHaveLength(1);
    } finally { await fixture.close(); }
});

test("canvas video does not POST when the intent cannot be saved", async () => {
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => String(input) === "/api/data/canvas" && init?.method === "PUT"
        ? Response.json({ error: { message: "QuotaExceededError" } }, { status: 503 })
        : transport(input, init)) as typeof fetch;
    const fixture = await canvasVideoFixture(videoProjects({ status: "error", prompt: "new video", model: config.model }));
    try {
        await retryCanvasVideo(fixture);
        expect(requests).toEqual([]);
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes[0].metadata?.videoSubmissionUnknown).toBe(false);
        expect(fixture.container.textContent).toContain("QuotaExceededError");
    } finally { await fixture.close(); }
});

test("a known canvas video task is saved before querying and explicit creation rejection remains retryable", async () => {
    let rejected = false;
    poll = async (request) => {
        if (request.method === "post") {
            if (!rejected) {
                rejected = true;
                throw new axios.AxiosError("bad prompt", "ERR_BAD_REQUEST", request, undefined, { ...response(request, { error: { message: "bad prompt" } }), status: 400 });
            }
            return response(request, { id: "created-task" });
        }
        const saved = documents.canvas.value as { state: { projects: CanvasProject[] } };
        expect(saved.state.projects.find((project) => project.id === "a")?.nodes[0].metadata).toMatchObject({ videoSubmissionUnknown: false, videoTaskId: "created-task" });
        return response(request, { id: "created-task", status: "completed" });
    };
    const fixture = await canvasVideoFixture(videoProjects({ status: "error", prompt: "new video", model: config.model }));
    try {
        await retryCanvasVideo(fixture);
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes[0].metadata?.videoSubmissionUnknown).toBe(false);
        await retryCanvasVideo(fixture);
        expect(requests).toEqual([
            { method: "post", url: "/api/ai/v1/videos" }, { method: "post", url: "/api/ai/v1/videos" },
            { method: "get", url: "/api/ai/v1/videos/created-task" }, { method: "get", url: "/api/ai/v1/videos/created-task/content" },
        ]);
    } finally { await fixture.close(); }
});

test("a config node saves its newly created video child and connection before submission", async () => {
    const projects = videoProjects({ status: "idle", prompt: "new child", generationMode: "video", model: config.model });
    projects[0].nodes[0].type = "config";
    poll = async (request) => {
        const saved = (documents.canvas.value as { state: { projects: CanvasProject[] } }).state.projects.find((project) => project.id === "a")!;
        const child = saved.nodes.find((node) => node.type === "video")!;
        expect(Boolean(child)).toBe(true);
        expect(saved.connections).toHaveLength(1);
        expect(saved.connections[0]).toMatchObject({ fromNodeId: "shared-node", toNodeId: child.id });
        if (request.method === "post") {
            expect(child.metadata?.videoSubmissionUnknown).toBe(true);
            return response(request, { id: "created-child" });
        }
        expect(child.metadata?.videoTaskId).toBe("created-child");
        return response(request, { id: "created-child", status: "completed" });
    };
    const fixture = await canvasVideoFixture(projects);
    try {
        const generate = [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].find((button) => button.textContent === i18n.t("canvas.configNode.generate"));
        expect(Boolean(generate)).toBe(true);
        await fixture.act(async () => generate!.click());
        expect(requests).toEqual([
            { method: "post", url: "/api/ai/v1/videos" },
            { method: "get", url: "/api/ai/v1/videos/created-child" },
            { method: "get", url: "/api/ai/v1/videos/created-child/content" },
        ]);
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes.find((node) => node.type === "video")?.metadata?.content).toBe("blob:mock-video");
    } finally { await fixture.close(); }
});

test.each(["project", "session", "delete"])("a %s change while saving a canvas video intent stops the paid POST", async (change) => {
    const fixture = await canvasVideoFixture(videoProjects({ status: "error", prompt: "new video", model: config.model }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let saving!: () => void;
    const started = new Promise<void>((resolve) => { saving = resolve; });
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        if (String(input) === "/api/data/canvas" && init?.method === "PUT") { saving(); await gate; }
        return transport(input, init);
    }) as typeof fetch;
    try {
        await retryCanvasVideo(fixture);
        await started;
        if (change === "project") await fixture.act(async () => { await fixture.router.navigate("/canvas/b"); });
        else if (change === "session") await fixture.act(async () => { endCanvasSession(); });
        else {
            await fixture.act(async () => { window.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true })); });
            await fixture.act(async () => { window.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
        }
        await fixture.act(async () => { release(); });
        expect(requests).toEqual([]);
        if (change === "delete") expect(fixture.useCanvasStore.getState().openProject("a")?.nodes).toHaveLength(0);
        if (change === "project") expect(fixture.useCanvasStore.getState().openProject("b")?.nodes[0].metadata?.content).toBe("blob:mock-original-b");
    } finally { release(); await fixture.close(); }
});

test("deleting a canvas video node during submission does not recreate it or start polling", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    poll = async (request) => { await gate; return response(request, { id: "removed-video" }); };
    const fixture = await canvasVideoFixture(videoProjects({ status: "error", prompt: "new video", model: config.model }));
    try {
        await retryCanvasVideo(fixture);
        expect(requests).toEqual([{ method: "post", url: "/api/ai/v1/videos" }]);
        await fixture.act(async () => { window.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true })); });
        await fixture.act(async () => { window.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
        await fixture.act(async () => { release(); });
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes).toHaveLength(0);
        expect(requests).toHaveLength(1);
        expect(fileRequests).toEqual([]);
    } finally { release(); await fixture.close(); }
});

test("undo preserves a known video task for GET-only recovery and can still remove and restore its node", async () => {
    poll = async (request) => {
        if (request.method === "post") return response(request, { id: "known-video" });
        throw new Error("temporary query failure");
    };
    const fixture = await canvasVideoFixture(videoProjects({ status: "error", prompt: "new video", model: config.model }));
    try {
        await retryCanvasVideo(fixture);
        await undoCanvasVideo(fixture);
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes[0].metadata?.videoTaskId).toBe("known-video");
        await retryCanvasVideo(fixture);
        expect(requests).toEqual([
            { method: "post", url: "/api/ai/v1/videos" },
            { method: "get", url: "/api/ai/v1/videos/known-video" },
            { method: "get", url: "/api/ai/v1/videos/known-video" },
        ]);
        await fixture.act(async () => { window.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true })); });
        await fixture.act(async () => { window.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes).toHaveLength(0);
        await undoCanvasVideo(fixture);
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes[0].metadata?.videoTaskId).toBe("known-video");
        expect(requests).toHaveLength(3);
    } finally { await fixture.close(); }
});
function imageProjects(metadata: CanvasNodeData["metadata"] = { status: "error", prompt: "new image" }) {
    const model = "gateway::image-model";
    useConfigStore.setState({ config: { ...config, model, imageModel: model, channels: [{ ...config.channels[0], models: [{ name: "image-model", capability: "image", endpointTypes: ["image-generation"] }] }] } });
    const projects = videoProjects({ ...metadata, model });
    projects[0].nodes[0].type = "image";
    return projects;
}

test("canvas image persists its original intent and unknown recovery never POSTs after undo or navigation", async () => {
    poll = async (request) => {
        const saved = (documents.canvas.value as { state: { projects: CanvasProject[] } }).state.projects.find((project) => project.id === "a")!;
        const recordId = saved.nodes[0].metadata?.imageTaskRecordId;
        expect(Boolean(recordId)).toBe(true);
        expect((await readImageTaskRecords())[recordId!].status).toBe("pending");
        throw new axios.AxiosError("please retry later", "ERR_BAD_RESPONSE", request, undefined, { ...response(request, { error: { message: "please retry later" } }), status: 504 });
    };
    const fixture = await canvasVideoFixture(imageProjects());
    try {
        await retryCanvasVideo(fixture);
        expect(requests).toEqual([{ method: "post", url: "/api/ai/v1/images/generations" }]);
        expect(fixture.container.textContent).toContain(i18n.t("managed.imageTaskUnknown"));
        expect(fixture.container.textContent).not.toContain("please retry later");
        const id = fixture.useCanvasStore.getState().openProject("a")?.nodes[0].metadata?.imageTaskRecordId;
        await undoCanvasVideo(fixture);
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes[0].metadata?.imageTaskRecordId).toBe(id);
        await retryCanvasVideo(fixture);
        await fixture.act(async () => { await fixture.router.navigate("/canvas/b"); });
        await fixture.act(async () => { await fixture.router.navigate("/canvas/a"); });
        await retryCanvasVideo(fixture);
        expect(requests).toHaveLength(1);
    } finally { await fixture.close(); }
});

test("canvas image recovers a received result after local image storage failed without paying again", async () => {
    const stored = { url: "blob:recovered-image", storageKey: "image:recovered", width: 320, height: 160, bytes: 5, mimeType: "image/png" };
    const upload = spyOn(imageStorage, "uploadImage").mockRejectedValueOnce(new Error("image storage unavailable")).mockResolvedValue(stored);
    const read = spyOn(imageStorage, "readStoredImage").mockResolvedValue(stored);
    poll = async (request) => response(request, { data: [{ b64_json: "aW1hZ2U=" }] });
    const fixture = await canvasVideoFixture(imageProjects());
    try {
        await retryCanvasVideo(fixture);
        const before = fixture.useCanvasStore.getState().openProject("a")?.nodes[0];
        expect(before?.metadata?.status).toBe("error");
        expect((await readImageTaskRecords())[before!.metadata!.imageTaskRecordId!].status).toBe("succeeded");
        await retryCanvasVideo(fixture);
        const recovered = fixture.useCanvasStore.getState().openProject("a")?.nodes[0];
        expect(recovered?.metadata).toMatchObject({ content: stored.url, storageKey: stored.storageKey, status: "success" });
        expect(recovered?.metadata?.imageTaskRecordId).toBeUndefined();
        expect(recovered!.width / recovered!.height).toBe(2);
        expect(requests).toHaveLength(1);
        expect(upload).toHaveBeenCalledTimes(2);
        expect(read).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); upload.mockRestore(); read.mockRestore(); }
});

test("canvas image blocks POST if its intent cannot be linked to the saved canvas", async () => {
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => String(input) === "/api/data/canvas" && init?.method === "PUT"
        ? Response.json({ error: { message: "QuotaExceededError" } }, { status: 503 })
        : transport(input, init)) as typeof fetch;
    const fixture = await canvasVideoFixture(imageProjects());
    try {
        await retryCanvasVideo(fixture);
        expect(requests).toEqual([]);
        expect(fixture.container.textContent).toContain("QuotaExceededError");
        expect(Object.values(await readImageTaskRecords()).map((record) => record.status)).toEqual(["failed"]);
    } finally { await fixture.close(); }
});

test("canvas image confirmed rejection clears the intent and remains retryable", async () => {
    poll = async (request) => { throw new axios.AxiosError("rejected", "ERR_BAD_REQUEST", request, undefined, { ...response(request, { error: { message: "rejected" } }), status: 400 }); };
    const fixture = await canvasVideoFixture(imageProjects());
    try {
        await retryCanvasVideo(fixture);
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes[0].metadata?.imageTaskRecordId).toBeUndefined();
        await retryCanvasVideo(fixture);
        expect(requests).toHaveLength(2);
    } finally { await fixture.close(); }
});

test.each(["project", "session", "delete"])("a %s change while saving a canvas image intent stops its paid POST", async (change) => {
    const fixture = await canvasVideoFixture(imageProjects());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let saving!: () => void;
    const started = new Promise<void>((resolve) => { saving = resolve; });
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        if (String(input) === "/api/data/canvas" && init?.method === "PUT") { saving(); await gate; }
        return transport(input, init);
    }) as typeof fetch;
    try {
        await retryCanvasVideo(fixture);
        await started;
        if (change === "project") await fixture.act(async () => { await fixture.router.navigate("/canvas/b"); });
        else if (change === "session") await fixture.act(async () => { endCanvasSession(); });
        else {
            await fixture.act(async () => { window.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true })); });
            await fixture.act(async () => { window.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
        }
        await fixture.act(async () => { release(); });
        expect(requests).toEqual([]);
        if (change === "delete") expect(fixture.useCanvasStore.getState().openProject("a")?.nodes).toHaveLength(0);
        if (change === "project") expect(fixture.useCanvasStore.getState().openProject("b")?.nodes[0].metadata?.content).toBe("blob:mock-original-b");
    } finally { release(); await fixture.close(); }
});

test("canvas logout queues the latest viewport before its debounce and ignores ended sessions", async () => {
    const projects = videoProjects({ status: "idle" });
    projects[0].viewport = { x: 70, y: 50, k: 2 };
    const fixture = await canvasVideoFixture(projects);
    try {
        const reset = fixture.container.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("canvas.resetView")}']`)!;
        await fixture.act(async () => reset.click());
        expect(fixture.useCanvasStore.getState().openProject("a")?.viewport.k).toBe(2);
        await fixture.act(async () => { window.dispatchEvent(new CustomEvent("canvas-before-logout")); });
        expect(fixture.useCanvasStore.getState().openProject("a")?.viewport.k).toBe(1);
        await fixture.act(async () => {
            endCanvasSession();
            fixture.useCanvasStore.setState({ hydrated: true, projects, deletedProjects: [] });
            window.dispatchEvent(new CustomEvent("canvas-before-logout"));
        });
        expect(fixture.useCanvasStore.getState().openProject("a")?.viewport.k).toBe(2);
    } finally { await fixture.close(); }
});

test("canvas batch images persist a separate intent per slot and querying an unknown slot cannot submit again", async () => {
    const projects = imageProjects({ status: "idle", prompt: "batch", generationMode: "image", count: 2 });
    projects[0].nodes[0].type = "config";
    projects[0].nodes[0].position.x = -240;
    poll = async (request) => {
        const saved = (documents.canvas.value as { state: { projects: CanvasProject[] } }).state.projects.find((project) => project.id === "a")!;
        const child = saved.nodes.find((node) => node.type === "image")!;
        expect(Boolean(child)).toBe(true);
        expect(saved.connections).toHaveLength(1);
        const ids = child.metadata!.images!.map((image) => image.imageTaskRecordId);
        expect(ids.every(Boolean)).toBe(true);
        expect(new Set(ids).size).toBe(2);
        throw new axios.AxiosError("response lost", "ERR_NETWORK", request);
    };
    const fixture = await canvasVideoFixture(projects);
    try {
        const generate = [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].find((button) => button.textContent === i18n.t("canvas.configNode.generate"));
        expect(Boolean(generate)).toBe(true);
        await fixture.act(async () => generate!.click());
        const child = fixture.useCanvasStore.getState().openProject("a")!.nodes.find((node) => node.type === "image")!;
        expect(child.metadata!.images!.map((image) => image.status)).toEqual(["error", "error"]);
        expect(new Set(child.metadata!.images!.map((image) => image.imageTaskRecordId)).size).toBe(2);
        expect(requests).toHaveLength(2);
        const query = [...fixture.container.querySelectorAll<HTMLButtonElement>(`[data-node-id='${child.id}'] button`)].find((button) => button.textContent === i18n.t("managed.resumeImage"));
        expect(Boolean(query)).toBe(true);
        await fixture.act(async () => query!.click());
        expect(requests).toHaveLength(2);
    } finally { await fixture.close(); }
});

test.each(["execution_unknown", "succeeded"])("batch %s recovery retains the successful primary and skipped sibling remains recoverable", async (status) => {
    const primary = { id: "primary", status: "success" as const, content: "blob:original-primary", naturalWidth: 100, naturalHeight: 100, bytes: 5, mimeType: "image/png" };
    const failed = (id: string) => ({ id, status: "error" as const, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "", imageTaskRecordId: id });
    const projects = imageProjects({ status: "success", content: primary.content, prompt: "batch", primaryImageId: primary.id, images: [primary, failed("slot-1"), failed("slot-2")] });
    documents["image-tasks"] = { revision: 1, value: Object.fromEntries(["slot-1", "slot-2"].map((id) => [id, { id, task_id: null, status, value: status === "succeeded" ? { result: { data: [{ url: `data:image/png;base64,${id}` }] } } : {} }])) };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stored = (key: string) => ({ url: `blob:${key}`, storageKey: key, width: 320, height: 160, bytes: 5, mimeType: "image/png" });
    const upload = spyOn(imageStorage, "uploadImage").mockImplementation(async (value) => { await gate; return stored(`image:${String(value).split(",")[1]}`); });
    const read = spyOn(imageStorage, "readStoredImage").mockImplementation(async (key) => stored(key));
    const fixture = await canvasVideoFixture(projects);
    try {
        const expand = fixture.container.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("canvas.node.batchCollapsed")}']`)!;
        expect(Boolean(expand)).toBe(true);
        await fixture.act(async () => expand.click());
        const queries = () => [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].filter((button) => button.textContent === i18n.t("managed.resumeImage"));
        expect(queries()).toHaveLength(2);
        await fixture.act(async () => { for (const query of queries()) query.click(); });
        if (status === "succeeded") expect(upload).toHaveBeenCalledTimes(1);
        else expect(upload).not.toHaveBeenCalled();
        await fixture.act(async () => { release(); });
        let node = fixture.useCanvasStore.getState().openProject("a")!.nodes[0];
        expect(node.metadata?.content).toBe(primary.content);
        expect(node.metadata?.images?.[0]).toEqual(primary);
        expect(node.metadata?.images?.[2].imageTaskRecordId).toBe("slot-2");
        expect(queries()).toHaveLength(status === "succeeded" ? 1 : 2);
        await fixture.act(async () => queries().at(-1)!.click());
        node = fixture.useCanvasStore.getState().openProject("a")!.nodes[0];
        expect(node.metadata?.content).toBe(primary.content);
        expect(node.metadata?.primaryImageId).toBe(primary.id);
        expect(node.metadata?.images?.[0]).toEqual(primary);
        expect(node.metadata?.images?.slice(1).map((image) => image.status)).toEqual(status === "succeeded" ? ["success", "success"] : ["error", "error"]);
        expect(requests).toEqual([]);
    } finally { release(); await fixture.close(); upload.mockRestore(); read.mockRestore(); }
});

test("canvas resumes a removed video model by original task GET and keeps its original model metadata", async () => {
    useConfigStore.setState({ config: { ...config, channels: [], models: [] } });
    const fixture = await canvasVideoFixture(videoProjects({ status: "loading", prompt: "video", model: "gateway::removed-model", videoTaskId: "task-existing", videoTaskProvider: "openai" }));
    try {
        expect(requests.every((request) => request.method === "get")).toBe(true);
        expect(requests.length).toBeGreaterThan(0);
        expect(fixture.useCanvasStore.getState().openProject("a")?.nodes[0].metadata).toMatchObject({ model: "gateway::removed-model", status: "success", content: "blob:mock-video" });
    } finally { await fixture.close(); }
});
