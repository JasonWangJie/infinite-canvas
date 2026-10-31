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
import * as imageTaskRecords from "@/services/image-task-records";

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
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
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
    const queryClient = new QueryClient();
    const router = createMemoryRouter([{ path: "/canvas/:id", element: React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(App, {}, React.createElement(CanvasPage))) }, { path: "/image", element: React.createElement("div", {}, "Original image task") }], { initialEntries: ["/canvas/a"] });
    const close = async () => {
        await React.act(async () => {
            root.unmount();
        });
        queryClient.clear();
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
    const button = [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].find((item) => ["canvas.node.retry", "managed.resumeImage", "managed.recoverImage", "managed.regenerateImageTask", "managed.verifyImageTask"].map((key) => i18n.t(key)).includes(item.textContent || ""));
    expect(Boolean(button)).toBe(true);
    await fixture.act(async () => button!.click());
}

function isConfigGenerateButton(button: HTMLButtonElement) {
    return ["image", "video"].some((mode) => button.getAttribute("aria-label") === i18n.t("canvas.promptPanel.generateMode", { mode: i18n.t(`canvas.nodeTypes.${mode}`) }));
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

test.each(["generated-image", "video-config", "removed-reference"])("canvas video retry keeps the current %s inputs and then resumes its saved task by GET only", async (source) => {
    const projects = videoProjects({ status: "error", prompt: "animate the tree", model: config.model, videoMode: "reference", references: ["image:old-reference"] });
    const base = { position: { x: -240, y: 0 }, width: 100, height: 100 };
    projects[0].nodes.push(
        { ...base, id: "image-config", type: "config", title: "Image config", metadata: { prompt: "draw the tree", generationMode: "image", model: config.model } },
        { ...base, id: "reference-image", type: "image", title: "Reference image", metadata: { status: "success", content: "blob:reference-image", naturalWidth: 100, naturalHeight: 100, mimeType: "image/png" } },
    );
    projects[0].connections = [{ id: "image-result", fromNodeId: "image-config", toNodeId: "reference-image" }];
    if (source === "video-config") {
        projects[0].nodes.push({ ...base, id: "video-config", type: "config", title: "Video config", metadata: { prompt: "animate from the video config", generationMode: "video", model: config.model, videoMode: "reference" } });
        projects[0].connections.push({ id: "video-input", fromNodeId: "reference-image", toNodeId: "video-config" }, { id: "video-result", fromNodeId: "video-config", toNodeId: "shared-node" });
    } else if (source === "generated-image") projects[0].connections.push({ id: "video-input", fromNodeId: "reference-image", toNodeId: "shared-node" });
    const image = spyOn(imageStorage, "imageToDataUrl").mockResolvedValue("data:image/png;base64,aW1hZ2U=");
    let submitted: FormData | undefined;
    poll = async (request) => {
        if (request.method === "post") {
            submitted = request.data as FormData;
            return response(request, { id: "reference-retry-task" });
        }
        throw new Error("temporary query failure");
    };
    const fixture = await canvasVideoFixture(projects);
    try {
        await retryCanvasVideo(fixture);
        expect(submitted).toBeInstanceOf(FormData);
        expect(submitted!.get("prompt")).toBe(source === "video-config" ? "animate from the video config" : "animate the tree");
        const references = submitted!.getAll("images") as File[];
        expect(references).toHaveLength(source === "removed-reference" ? 0 : 1);
        if (references.length) expect(await references[0].text()).toBe("image");
        if (source === "removed-reference") expect(image).not.toHaveBeenCalled();
        expect(fixture.useCanvasStore.getState().openProject("a")!.nodes[0].metadata).toMatchObject({ videoSubmissionUnknown: false, videoTaskId: "reference-retry-task" });
        await retryCanvasVideo(fixture);
        expect(requests).toEqual([
            { method: "post", url: "/api/ai/v1/videos" },
            { method: "get", url: "/api/ai/v1/videos/reference-retry-task" },
            { method: "get", url: "/api/ai/v1/videos/reference-retry-task" },
        ]);
    } finally { await fixture.close(); image.mockRestore(); }
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
        const generate = [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].find(isConfigGenerateButton);
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

test("canvas image keeps a received result recoverable when its final canvas save fails, then saves it without another POST", async () => {
    const stored = { url: "blob:canvas-save-image", storageKey: "image:canvas-save", width: 320, height: 160, bytes: 5, mimeType: "image/png" };
    const upload = spyOn(imageStorage, "uploadImage").mockResolvedValue(stored);
    const read = spyOn(imageStorage, "readStoredImage").mockResolvedValue(stored);
    let failCanvasSave = false;
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => String(input) === "/api/data/canvas" && init?.method === "PUT" && failCanvasSave
        ? Response.json({ error: { message: "canvas storage unavailable" } }, { status: 503 })
        : transport(input, init)) as typeof fetch;
    poll = async (request) => { failCanvasSave = true; return response(request, { data: [{ b64_json: "aW1hZ2U=" }] }); };
    const fixture = await canvasVideoFixture(imageProjects());
    try {
        await retryCanvasVideo(fixture);
        const pending = fixture.useCanvasStore.getState().openProject("a")!.nodes[0];
        expect(pending.metadata).toMatchObject({ status: "error", content: stored.url });
        expect(typeof pending.metadata?.imageTaskRecordId).toBe("string");
        const retained = await readImageTaskRecords();
        expect(Object.keys(retained)).toContain(pending.metadata!.imageTaskRecordId!);
        expect(retained[pending.metadata!.imageTaskRecordId!].status).toBe("succeeded");
        failCanvasSave = false;
        await retryCanvasVideo(fixture);
        const recovered = fixture.useCanvasStore.getState().openProject("a")!.nodes[0];
        expect(recovered.metadata).toMatchObject({ status: "success", content: stored.url });
        expect(recovered.metadata?.imageTaskRecordId).toBeUndefined();
        expect(requests).toEqual([{ method: "post", url: "/api/ai/v1/images/generations" }]);
        expect(upload).toHaveBeenCalledTimes(1);
        expect((documents.canvas.value as { state: { projects: CanvasProject[] } }).state.projects[0].nodes[0].metadata?.imageTaskRecordId).toBeUndefined();
    } finally { await fixture.close(); upload.mockRestore(); read.mockRestore(); }
});

test.each([false, true])("canvas image checkbox async=%s selects the protocol and restores its saved task without another POST", async (asyncMode) => {
    const projects = imageProjects({ status: "idle", prompt: "draw a tree", generationMode: "image", count: 1 });
    projects[0].nodes[0].type = "config";
    projects[0].nodes[0].position.x = -240;
    const stored = { url: "blob:checkbox-image", storageKey: "image:checkbox", width: 320, height: 160, bytes: 5, mimeType: "image/png" };
    const upload = spyOn(imageStorage, "uploadImage").mockResolvedValue(stored);
    const read = spyOn(imageStorage, "readStoredImage").mockResolvedValue(stored);
    const asyncRequests: string[] = [];
    const transport = globalThis.fetch;
    let ready = false;
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path.endsWith("/images/generations_async")) {
            asyncRequests.push(`${init?.method || "GET"} ${path}`);
            const saved = (documents.canvas.value as { state: { projects: CanvasProject[] } }).state.projects.find((project) => project.id === "a")!;
            const child = saved.nodes.find((node) => node.type === "image")!;
            expect(child.metadata?.imageAsync).toBe(true);
            const recordId = child.metadata?.images?.[0].imageTaskRecordId;
            expect(Boolean(recordId)).toBe(true);
            expect((await readImageTaskRecords())[recordId!]).toMatchObject({ status: "submitting", task_id: null });
            return Response.json({ task_id: "asyncimg_checkbox" }, { status: 202 });
        }
        if (path.endsWith("/images/tasks_async/asyncimg_checkbox")) {
            asyncRequests.push(`${init?.method || "GET"} ${path}`);
            return Response.json(ready ? { status: "succeeded", data: [{ b64_json: "aW1hZ2U=" }] } : { status: "running" });
        }
        return transport(input, init);
    }) as typeof fetch;
    poll = async (request) => response(request, { data: [{ b64_json: "aW1hZ2U=" }] });
    const fixture = await canvasVideoFixture(projects);
    try {
        const checkbox = fixture.container.querySelector<HTMLInputElement>("[data-node-id='shared-node'] input[type='checkbox']")!;
        expect(Boolean(checkbox)).toBe(true);
        expect(checkbox.checked).toBe(false);
        if (asyncMode) await fixture.act(async () => checkbox.click());
        expect(checkbox.checked).toBe(asyncMode);
        const generate = [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].find(isConfigGenerateButton)!;
        expect(generate.disabled).toBe(false);
        await fixture.act(async () => generate.click());
        const child = fixture.useCanvasStore.getState().openProject("a")!.nodes.find((node) => node.type === "image")!;
        if (!asyncMode) {
            expect(requests).toEqual([{ method: "post", url: "/api/ai/v1/images/generations" }]);
            expect(asyncRequests).toEqual([]);
            expect(child.metadata?.content).toBe(stored.url);
        } else {
            expect(requests).toEqual([]);
            expect(asyncRequests).toEqual(["POST /api/ai/v1/images/generations_async"]);
            const recordId = child.metadata?.images?.[0].imageTaskRecordId;
            expect((await readImageTaskRecords())[recordId!].task_id).toBe("asyncimg_checkbox");
            await fixture.act(async () => { await fixture.router.navigate("/canvas/b"); });
            await fixture.act(async () => { await fixture.router.navigate("/canvas/a"); });
            ready = true;
            const query = [...fixture.container.querySelectorAll<HTMLButtonElement>(`[data-node-id='${child.id}'] button`)].find((button) => button.textContent === i18n.t("managed.resumeImage"))!;
            expect(Boolean(query)).toBe(true);
            await fixture.act(async () => query.click());
            const restored = fixture.useCanvasStore.getState().openProject("a")!.nodes.find((node) => node.id === child.id)!;
            expect(restored.metadata?.content).toBe(stored.url);
            expect(restored.metadata?.images?.[0].imageTaskRecordId).toBeUndefined();
            expect(asyncRequests).toEqual(["POST /api/ai/v1/images/generations_async", "GET /api/ai/v1/images/tasks_async/asyncimg_checkbox", "GET /api/ai/v1/images/tasks_async/asyncimg_checkbox"]);
        }
        expect(upload).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); upload.mockRestore(); read.mockRestore(); }
});

test("canvas image confirmed rejection keeps its history and permits an explicit new task", async () => {
    poll = async (request) => { throw new axios.AxiosError("rejected", "ERR_BAD_REQUEST", request, undefined, { ...response(request, { error: { message: "rejected" } }), status: 400 }); };
    const fixture = await canvasVideoFixture(imageProjects());
    try {
        await retryCanvasVideo(fixture);
        const previous = fixture.useCanvasStore.getState().openProject("a")?.nodes[0].metadata?.imageTaskRecordId;
        expect(typeof previous).toBe("string");
        expect(fixture.container.textContent).toContain(i18n.t("managed.regenerateImageTask"));
        await retryCanvasVideo(fixture);
        expect(requests).toHaveLength(2);
        expect(Object.keys(await readImageTaskRecords())).toHaveLength(2);
        expect((await readImageTaskRecords())[previous!].status).toBe("failed");
    } finally { await fixture.close(); }
});

test("a stale query action cannot restart a failed async image until the user explicitly chooses a new task", async () => {
    const oldId = "failed-original";
    const source = { kind: "canvas", canvasId: "a", nodeId: "shared-node" };
    const old = { id: oldId, task_id: "asyncimg_original", status: "pending", created_at: 123, value: { model: "image-model", source } };
    documents["image-tasks"] = { revision: 1, value: { [oldId]: old } };
    const calls: string[] = [];
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path.endsWith("/images/tasks_async/asyncimg_original")) { calls.push(`GET ${path}`); return Response.json({ status: "running" }); }
        if (path.endsWith("/images/generations_async")) {
            calls.push(`POST ${path}`);
            const records = await readImageTaskRecords();
            const next = Object.values(records).find((record) => record.id !== oldId)!;
            expect(next.value.source).toEqual(source);
            return Response.json({ task_id: "asyncimg_new" }, { status: 202 });
        }
        return transport(input, init);
    }) as typeof fetch;
    const fixture = await canvasVideoFixture(imageProjects({ status: "error", prompt: "draw a tree", imageAsync: true, imageTaskRecordId: oldId, imageTaskState: "pending" }));
    try {
        expect(fixture.container.querySelector("[data-image-task-state='pending']")).not.toBeNull();
        await fixture.act(async () => writeDocument("image-tasks", { [oldId]: { ...old, status: "failed", value: { ...old.value, result: { status: "failed", error_message: "provider rejected" } } } }));
        await retryCanvasVideo(fixture);
        expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
        expect(fixture.container.textContent).toContain(i18n.t("managed.regenerateImageTask"));
        expect(fixture.useCanvasStore.getState().openProject("a")!.nodes[0].metadata?.imageTaskRecordId).toBe(oldId);
        await retryCanvasVideo(fixture);
        const records = await readImageTaskRecords();
        expect(calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /api/ai/v1/images/generations_async"]);
        expect(Object.keys(records)).toHaveLength(2);
        expect(records[oldId]).toEqual({ ...old, status: "failed", value: { ...old.value, result: { status: "failed", error_message: "provider rejected" } } });
        const current = fixture.useCanvasStore.getState().openProject("a")!.nodes[0];
        expect(current.metadata?.imageTaskRecordId).not.toBe(oldId);
        expect(current.metadata?.imageTaskState).toBe("pending");
        expect(fixture.container.querySelector("[data-image-task-state='pending']")).not.toBeNull();
        expect(requests).toEqual([]);
    } finally { await fixture.close(); }
});

test("a batch aggregate query selects its pending slot even when the first slot failed and never submits a new image", async () => {
    const images = [
        { id: "failed", status: "error" as const, imageTaskRecordId: "failed", imageTaskState: "failed" as const },
        { id: "pending", status: "idle" as const, imageTaskRecordId: "pending", imageTaskState: "pending" as const },
    ].map((image) => ({ ...image, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "image/png" }));
    documents["image-tasks"] = { revision: 1, value: {
        failed: { id: "failed", task_id: "asyncimg_failed", status: "failed", value: {} },
        pending: { id: "pending", task_id: "asyncimg_pending", status: "pending", value: {} },
    } };
    const calls: string[] = [];
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path.includes("/api/ai/")) {
            calls.push(`${init?.method || "GET"} ${path}`);
            if (path.endsWith("/images/tasks_async/asyncimg_pending")) return Response.json({ status: "running" });
            throw new Error("The aggregate query must never select the failed slot or create a task");
        }
        return transport(input, init);
    }) as typeof fetch;
    const fixture = await canvasVideoFixture(imageProjects({ status: "error", prompt: "batch", imageAsync: true, images }));
    try {
        const initialQueries = calls.length;
        const card = fixture.container.querySelector<HTMLElement>("[data-node-id='shared-node'] > .relative")!;
        await fixture.act(async () => {
            card.dispatchEvent(new browser.MouseEvent("mousedown", { bubbles: true, button: 0 }));
            window.dispatchEvent(new browser.MouseEvent("mouseup", { bubbles: true, button: 0 }));
        });
        const query = [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-panel='shared-node'] button")].find((button) => [i18n.t("managed.resumeImage"), i18n.t("managed.queryAllImages")].includes(button.getAttribute("aria-label") || ""))!;
        expect(Boolean(query)).toBe(true);
        await fixture.act(async () => query.click());
        expect(calls.slice(initialQueries)).toEqual(["GET /api/ai/v1/images/tasks_async/asyncimg_pending"]);
        expect(Object.keys(await readImageTaskRecords())).toEqual(["failed", "pending"]);
        expect(fixture.useCanvasStore.getState().openProject("a")!.nodes[0].metadata?.images?.map((image) => image.imageTaskRecordId)).toEqual(["failed", "pending"]);
        expect(requests).toEqual([]);
    } finally { await fixture.close(); }
});

test("an explicit new-task action with a slow local read cannot replace a newer active intent", async () => {
    const original = { id: "original-failed", task_id: "asyncimg_failed", status: "failed", value: {} };
    const replacement = { id: "replacement", task_id: "asyncimg_replacement", status: "pending", value: {} };
    documents["image-tasks"] = { revision: 1, value: { [original.id]: original, [replacement.id]: replacement } };
    const fixture = await canvasVideoFixture(imageProjects({ status: "error", prompt: "tree", imageAsync: true, imageTaskRecordId: original.id, imageTaskState: "failed" }));
    const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    const realRead = imageTaskRecords.readImageTaskRecords;
    let blockRead = true;
    const read = spyOn(imageTaskRecords, "readImageTaskRecords").mockImplementation(async () => {
        const records = await realRead();
        if (blockRead) { blockRead = false; started.resolve(); await gate.promise; }
        return records;
    });
    try {
        await retryCanvasVideo(fixture);
        await started.promise;
        const { useAgentStore } = await import("@/stores/use-agent-store");
        await fixture.act(async () => { useAgentStore.getState().canvasContext!.applyOps([{ type: "update_node", id: "shared-node", metadata: { imageTaskRecordId: replacement.id, imageTaskState: "pending" } }]); });
        await fixture.act(async () => gate.resolve());
        expect(fixture.useCanvasStore.getState().openProject("a")!.nodes[0].metadata?.imageTaskRecordId).toBe(replacement.id);
        expect(Object.keys(await realRead())).toEqual([original.id, replacement.id]);
        expect(requests).toEqual([]);
        expect(fileRequests.filter((request) => request.includes("/api/ai/"))).toEqual([]);
    } finally { gate.resolve(); read.mockRestore(); await fixture.close(); }
});

test.each(["query", "save"])("canvas batch %s-all processes only original intents and preserves every result history", async (action) => {
    const ids = ["first", "second"];
    const images = ids.map((id) => ({ id, status: "error" as const, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "image/png", imageTaskRecordId: id, imageTaskState: action === "query" ? "pending" as const : "storage_failed" as const }));
    const records = Object.fromEntries(ids.map((id, index) => [id, { id, task_id: action === "query" ? `asyncimg_${id}` : null, status: action === "query" ? "pending" : "succeeded", created_at: 123 + index, value: { model: "image-model", source: { kind: "canvas", canvasId: "a", nodeId: "shared-node", slotId: id }, ...(action === "save" ? { result: { data: [{ b64_json: id === "first" ? "Zmlyc3Q=" : "c2Vjb25k" }] } } : {}) } }]));
    documents["image-tasks"] = { revision: 1, value: records };
    const stored = (key: string) => ({ url: `blob:${key}`, storageKey: key, width: 320, height: 160, bytes: 5, mimeType: "image/png" });
    const upload = spyOn(imageStorage, "uploadImage").mockImplementation(async (input) => stored(String(input).includes("Zmlyc3Q=") ? "image:first" : "image:second"));
    const read = spyOn(imageStorage, "readStoredImage").mockImplementation(async (key) => stored(key));
    const calls: string[] = [];
    const transport = globalThis.fetch;
    let phase = 0;
    let canvasSaveFails = false;
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (canvasSaveFails && path === "/api/data/canvas" && init?.method === "PUT") return Response.json({ error: { message: "canvas save unavailable" } }, { status: 503 });
        if (path.includes("/images/tasks_async/")) {
            calls.push(`${init?.method || "GET"} ${path}`);
            if (!phase) return Response.json({ status: "running" });
            if (phase === 1 && path.endsWith("asyncimg_second")) return Response.json({ error: { message: "temporary polling failure" } }, { status: 503 });
            return Response.json({ status: "succeeded", data: [{ b64_json: path.endsWith("asyncimg_first") ? "Zmlyc3Q=" : "c2Vjb25k" }] });
        }
        return transport(input, init);
    }) as typeof fetch;
    const fixture = await canvasVideoFixture(imageProjects({ status: "error", prompt: "batch", images }));
    const allLabel = i18n.t(action === "query" ? "managed.queryAllImages" : "managed.recoverAllImages");
    const allButton = () => [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].find((button) => button.textContent === allLabel)!;
    try {
        phase = 1;
        canvasSaveFails = action === "save";
        expect(Boolean(allButton())).toBe(true);
        await fixture.act(async () => allButton().click());
        if (action === "query") {
            expect(fixture.useCanvasStore.getState().openProject("a")!.nodes[0].metadata?.images?.[0].status).toBe("success");
            expect(fixture.useCanvasStore.getState().openProject("a")!.nodes[0].metadata?.images?.[1].imageTaskState).toBe("pending");
            phase = 2;
            await fixture.act(async () => allButton().click());
            expect(calls.filter((call) => call.endsWith("asyncimg_first"))).toHaveLength(2);
        } else {
            expect(fixture.useCanvasStore.getState().openProject("a")!.nodes[0].metadata?.images?.map((image) => image.imageTaskRecordId)).toEqual(ids);
            canvasSaveFails = false;
            await fixture.act(async () => allButton().click());
        }
        const node = fixture.useCanvasStore.getState().openProject("a")!.nodes[0];
        expect(node.metadata?.images?.map((image) => image.status)).toEqual(["success", "success"]);
        expect(node.metadata?.images?.map((image) => image.imageTaskRecordId)).toEqual([undefined, undefined]);
        expect(upload).toHaveBeenCalledTimes(2);
        const retained = await readImageTaskRecords();
        expect(Object.values(retained).map((record) => record.value.source?.slotId)).toEqual(ids);
        expect(Object.values(retained).map((record) => record.created_at)).toEqual([123, 124]);
        expect(calls.every((call) => call.startsWith("GET"))).toBe(true);
        expect(requests).toEqual([]);
    } finally { await fixture.close(); upload.mockRestore(); read.mockRestore(); }
});

test("a newly generated async batch without polling hints can query all repeatedly and restore results without another POST", async () => {
    const projects = imageProjects({ status: "idle", prompt: "draw trees", generationMode: "image", imageAsync: true, count: 3 });
    projects[0].nodes[0].type = "config";
    projects[0].nodes[0].position.x = -240;
    const stored = { url: "blob:generated-batch", storageKey: "image:generated-batch", width: 320, height: 160, bytes: 5, mimeType: "image/png" };
    const upload = spyOn(imageStorage, "uploadImage").mockResolvedValue(stored);
    const read = spyOn(imageStorage, "readStoredImage").mockResolvedValue(stored);
    const transport = globalThis.fetch;
    const calls: string[] = [];
    const queryGate = Promise.withResolvers<void>();
    let gated = true, ready = false;
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path.endsWith("/images/generations_async")) {
            calls.push(`POST ${path}`);
            const intentId = new Headers(init?.headers).get("Idempotency-Key")!;
            const record = (await readImageTaskRecords())[intentId];
            expect(record.value.source?.canvasId).toBe("a");
            expect(typeof record.value.source?.slotId).toBe("string");
            const canvas = (documents.canvas.value as { state: { projects: CanvasProject[] } }).state.projects.find((project) => project.id === "a")!;
            expect(canvas.nodes.find((node) => node.id === record.value.source?.nodeId)?.metadata?.images?.find((image) => image.id === record.value.source?.slotId)?.imageTaskRecordId).toBe(intentId);
            return Response.json({ task_id: `asyncimg_${intentId}` }, { status: 202 });
        }
        if (path.includes("/images/tasks_async/")) {
            calls.push(`GET ${path}`);
            if (gated) await queryGate.promise;
            return Response.json(ready ? { status: "succeeded", data: [{ b64_json: "aW1hZ2U=" }] } : { status: "running" });
        }
        return transport(input, init);
    }) as typeof fetch;
    const fixture = await canvasVideoFixture(projects);
    try {
        const generate = [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].find(isConfigGenerateButton)!;
        await fixture.act(async () => generate.click());
        const child = fixture.useCanvasStore.getState().openProject("a")!.nodes.find((node) => node.type === "image")!;
        const queryAll = () => [...fixture.container.querySelectorAll<HTMLButtonElement>(`[data-node-id='${child.id}'] button`)].find((button) => button.textContent === i18n.t("managed.queryAllImages"))!;
        expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(3);
        expect(calls.filter((call) => call.startsWith("GET"))).toHaveLength(0);
        await fixture.act(async () => { queryAll().click(); queryAll().click(); });
        expect(queryAll().disabled).toBe(true);
        expect(calls.filter((call) => call.startsWith("GET"))).toHaveLength(1);
        gated = false;
        await fixture.act(async () => queryGate.resolve());
        expect(calls.filter((call) => call.startsWith("GET"))).toHaveLength(3);
        await fixture.act(async () => queryAll().click());
        expect(calls.filter((call) => call.startsWith("GET"))).toHaveLength(6);
        ready = true;
        const card = fixture.container.querySelector<HTMLElement>(`[data-node-id='${child.id}'] > .relative`)!;
        await fixture.act(async () => {
            card.dispatchEvent(new browser.MouseEvent("mousedown", { bubbles: true, button: 0 }));
            window.dispatchEvent(new browser.MouseEvent("mouseup", { bubbles: true, button: 0 }));
        });
        const panelAction = [...fixture.container.querySelectorAll<HTMLButtonElement>(`[data-node-panel='${child.id}'] button`)].find((button) => [i18n.t("managed.resumeImage"), i18n.t("managed.queryAllImages")].includes(button.getAttribute("aria-label") || ""))!;
        expect(Boolean(panelAction)).toBe(true);
        await fixture.act(async () => panelAction.click());
        expect(calls.filter((call) => call.startsWith("GET"))).toHaveLength(9);
        expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(3);
        const completed = fixture.useCanvasStore.getState().openProject("a")!.nodes.find((node) => node.id === child.id)!;
        expect(completed.metadata?.images?.map((image) => image.status)).toEqual(["success", "success", "success"]);
        expect(completed.metadata?.images?.map((image) => image.imageTaskRecordId)).toEqual([undefined, undefined, undefined]);
        expect(upload).toHaveBeenCalledTimes(3);
        expect(requests).toEqual([]);
    } finally { queryGate.resolve(); await fixture.close(); upload.mockRestore(); read.mockRestore(); }
});

test.each([false, true])("canvas image protocol toggles are local and rapid generation clicks pay only once with async=%s", async (asyncMode) => {
    const projects = imageProjects({ status: "idle", prompt: "draw a tree", generationMode: "image", count: 1 });
    projects[0].nodes[0].type = "config";
    projects[0].nodes[0].position.x = -240;
    const gate = Promise.withResolvers<void>();
    const calls: string[] = [];
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path.endsWith("/images/generations_async")) {
            calls.push(`${init?.method || "GET"} ${path}`);
            await gate.promise;
            return Response.json({ task_id: "asyncimg_rapid" }, { status: 202 });
        }
        return transport(input, init);
    }) as typeof fetch;
    poll = async (request) => { await gate.promise; throw new axios.AxiosError("response lost", "ERR_NETWORK", request); };
    const fixture = await canvasVideoFixture(projects);
    try {
        const checkbox = fixture.container.querySelector<HTMLInputElement>("[data-node-id='shared-node'] input[type='checkbox']")!;
        expect(checkbox.checked).toBe(false);
        await fixture.act(async () => checkbox.click());
        expect(checkbox.checked).toBe(true);
        await fixture.act(async () => checkbox.click());
        expect(checkbox.checked).toBe(false);
        if (asyncMode) await fixture.act(async () => checkbox.click());
        expect(requests).toEqual([]);
        expect(calls).toEqual([]);
        const generate = [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].find(isConfigGenerateButton)!;
        await fixture.act(async () => { generate.click(); generate.click(); });
        expect(checkbox.disabled).toBe(true);
        expect(fixture.container.textContent).not.toContain(i18n.t("managed.imageTaskPending"));
        expect(fixture.container.textContent).not.toContain(i18n.t("managed.queryAllImages"));
        await fixture.act(async () => checkbox.click());
        expect(checkbox.checked).toBe(asyncMode);
        expect(requests).toHaveLength(asyncMode ? 0 : 1);
        expect(calls).toHaveLength(asyncMode ? 1 : 0);
        await fixture.act(async () => gate.resolve());
        expect(requests).toHaveLength(asyncMode ? 0 : 1);
        expect(calls).toHaveLength(asyncMode ? 1 : 0);
        expect(fixture.useCanvasStore.getState().openProject("a")!.nodes.filter((node) => node.type === "image")).toHaveLength(1);
    } finally { gate.resolve(); await fixture.close(); }
});

test.each([false, true])("a text reference enables an image node with an empty prompt, including grouped=%s", async (grouped) => {
    const projects = imageProjects({ status: "idle", prompt: "" });
    const text: CanvasNodeData = { id: "reference-text", type: "text", title: "reference", position: { x: -160, y: 0 }, width: 100, height: 100, metadata: { content: "a tree beside a river", ...(grouped ? { groupId: "reference-group" } : {}) } };
    projects[0].nodes.push(text);
    if (grouped) projects[0].nodes.push({ id: "reference-group", type: "group", title: "references", position: { x: -180, y: -20 }, width: 160, height: 160, metadata: {} });
    projects[0].connections.push({ id: "reference-connection", fromNodeId: grouped ? "reference-group" : text.id, toNodeId: "shared-node" });
    const fixture = await canvasVideoFixture(projects);
    try {
        const card = fixture.container.querySelector<HTMLElement>("[data-node-id='shared-node'] > .relative")!;
        await fixture.act(async () => {
            card.dispatchEvent(new browser.MouseEvent("mousedown", { bubbles: true, button: 0 }));
            window.dispatchEvent(new browser.MouseEvent("mouseup", { bubbles: true, button: 0 }));
        });
        const panel = fixture.container.querySelector<HTMLElement>("[data-node-panel='shared-node']")!;
        expect(Boolean(panel)).toBe(true);
        expect(panel.querySelector<HTMLElement>("[role='textbox']")?.textContent).toBe("");
        expect(panel.querySelectorAll(`button[aria-label='${i18n.t("canvas.references.disconnect")}']`)).toHaveLength(1);
        expect(Boolean(panel.querySelector("svg.lucide-file-text"))).toBe(true);
        const { buildNodeGenerationContext } = await import("@/components/canvas/canvas-node-generation");
        expect(buildNodeGenerationContext("shared-node", projects[0].nodes, projects[0].connections, "").prompt).toContain(text.metadata!.content!);
        const generate = panel.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("canvas.promptPanel.generateMode", { mode: i18n.t("canvas.nodeTypes.image") })}']`)!;
        expect(generate.disabled).toBe(false);
        expect(requests).toEqual([]);
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

test("a synchronous canvas batch submits n=2 once with one saved intent and unknown recovery cannot submit again", async () => {
    const projects = imageProjects({ status: "idle", prompt: "batch", generationMode: "image", count: 2 });
    projects[0].nodes[0].type = "config";
    projects[0].nodes[0].position.x = -240;
    poll = async (request) => {
        const saved = (documents.canvas.value as { state: { projects: CanvasProject[] } }).state.projects.find((project) => project.id === "a")!;
        const child = saved.nodes.find((node) => node.type === "image")!;
        expect(Boolean(child)).toBe(true);
        expect(saved.connections).toHaveLength(1);
        expect(JSON.parse(String(request.data)).n).toBe(2);
        expect(child.metadata?.images).toHaveLength(2);
        expect(child.metadata?.images?.every((image) => !image.imageTaskRecordId)).toBe(true);
        const records = Object.values(await readImageTaskRecords());
        expect(records).toHaveLength(1);
        expect(child.metadata?.imageTaskRecordId).toBe(records[0].id);
        expect(records[0]).toMatchObject({ status: "pending", value: { source: { kind: "canvas", canvasId: "a", nodeId: child.id } } });
        expect(records[0].value.source?.slotId).toBeUndefined();
        throw new axios.AxiosError("response lost", "ERR_NETWORK", request);
    };
    const fixture = await canvasVideoFixture(projects);
    try {
        const generate = [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].find(isConfigGenerateButton);
        expect(Boolean(generate)).toBe(true);
        await fixture.act(async () => generate!.click());
        const child = fixture.useCanvasStore.getState().openProject("a")!.nodes.find((node) => node.type === "image")!;
        expect(child.metadata!.images!.map((image) => image.status)).toEqual(["idle", "idle"]);
        expect(child.metadata?.imageTaskState).toBe("unknown");
        expect(Object.values(await readImageTaskRecords()).map((record) => record.status)).toEqual(["execution_unknown"]);
        expect(requests).toEqual([{ method: "post", url: "/api/ai/v1/images/generations" }]);
        const query = [...fixture.container.querySelectorAll<HTMLButtonElement>(`[data-node-id='${child.id}'] button`)].find((button) => button.textContent === i18n.t("managed.verifyImageTask"));
        expect(Boolean(query)).toBe(true);
        await fixture.act(async () => query!.click());
        expect(fixture.router.state.location.pathname).toBe("/image");
        expect(requests).toHaveLength(1);
    } finally { await fixture.close(); }
});

test.each(["none", "media", "canvas"])("a synchronous canvas n=2 response retains both images after %s storage failure without another POST", async (failure) => {
    const projects = imageProjects({ status: "idle", prompt: "two trees", generationMode: "image", count: 2 });
    projects[0].nodes[0].type = "config";
    projects[0].nodes[0].position.x = -240;
    const stored = (key: string) => ({ url: `blob:${key}`, storageKey: key, width: key === "image:first" ? 320 : 160, height: key === "image:first" ? 160 : 320, bytes: 5, mimeType: "image/png" });
    let failMediaSave = failure === "media", failCanvasSave = false;
    const upload = spyOn(imageStorage, "uploadImage").mockImplementation(async (input) => {
        const key = String(input).includes("Zmlyc3Q=") ? "image:first" : "image:second";
        if (key === "image:second" && failMediaSave) { failMediaSave = false; throw new Error("second image storage unavailable"); }
        return stored(key);
    });
    const read = spyOn(imageStorage, "readStoredImage").mockImplementation(async (key) => stored(key));
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => String(input) === "/api/data/canvas" && init?.method === "PUT" && failCanvasSave
        ? Response.json({ error: { message: "canvas storage unavailable" } }, { status: 503 })
        : transport(input, init)) as typeof fetch;
    let slotIds: string[] = [];
    poll = async (request) => {
        expect(JSON.parse(String(request.data)).n).toBe(2);
        const saved = (documents.canvas.value as { state: { projects: CanvasProject[] } }).state.projects.find((project) => project.id === "a")!;
        const child = saved.nodes.find((node) => node.type === "image")!;
        slotIds = child.metadata!.images!.map((image) => image.id);
        expect(slotIds).toHaveLength(2);
        const records = Object.values(await readImageTaskRecords());
        expect(records).toHaveLength(1);
        expect(child.metadata?.imageTaskRecordId).toBe(records[0].id);
        expect(records[0].value.source).toEqual({ kind: "canvas", canvasId: "a", nodeId: child.id });
        failCanvasSave = failure === "canvas";
        return response(request, { data: [{ b64_json: "Zmlyc3Q=" }, { b64_json: "c2Vjb25k" }] });
    };
    const fixture = await canvasVideoFixture(projects);
    try {
        const generate = [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].find(isConfigGenerateButton)!;
        expect(Boolean(generate)).toBe(true);
        await fixture.act(async () => generate.click());
        let child = fixture.useCanvasStore.getState().openProject("a")!.nodes.find((node) => node.type === "image")!;
        const records = Object.values(await readImageTaskRecords());
        expect(records).toHaveLength(1);
        expect(records[0].value.result?.data).toHaveLength(2);
        if (failure !== "none") {
            expect(child.metadata?.imageTaskRecordId).toBe(records[0].id);
            expect(child.metadata?.imageTaskState).toBe("storage_failed");
            failCanvasSave = false;
            const recover = [...fixture.container.querySelectorAll<HTMLButtonElement>(`[data-node-id='${child.id}'] button`)].find((button) => button.textContent === i18n.t("managed.recoverAllImages"))!;
            expect(Boolean(recover)).toBe(true);
            await fixture.act(async () => recover.click());
            child = fixture.useCanvasStore.getState().openProject("a")!.nodes.find((node) => node.id === child.id)!;
        }
        expect(child.metadata?.images?.map((image) => image.storageKey)).toEqual(["image:first", "image:second"]);
        expect(child.metadata?.images?.map((image) => image.id)).toEqual(slotIds);
        expect(child.metadata?.images?.map((image) => image.status)).toEqual(["success", "success"]);
        expect(child.metadata?.primaryImageId).toBe(slotIds[0]);
        expect(child.metadata?.content).toBe("blob:image:first");
        expect(child.metadata?.imageTaskRecordId).toBeUndefined();
        expect(child.metadata?.imageTaskState).toBeUndefined();
        expect(requests).toEqual([{ method: "post", url: "/api/ai/v1/images/generations" }]);
        expect(upload).toHaveBeenCalledTimes(failure === "media" ? 3 : 2);
        const saved = (documents.canvas.value as { state: { projects: CanvasProject[] } }).state.projects.find((project) => project.id === "a")!.nodes.find((node) => node.id === child.id)!;
        expect(saved.metadata?.images?.map((image) => image.storageKey)).toEqual(["image:first", "image:second"]);
        expect(saved.metadata?.imageTaskRecordId).toBeUndefined();
        expect(Object.keys(await readImageTaskRecords())).toEqual([records[0].id]);
    } finally { failCanvasSave = false; await fixture.close(); upload.mockRestore(); read.mockRestore(); }
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
        const queries = () => [...fixture.container.querySelectorAll<HTMLButtonElement>("[data-node-id='shared-node'] button")].filter((button) => button.textContent === i18n.t(status === "succeeded" ? "managed.recoverImage" : "managed.verifyImageTask"));
        expect(queries()).toHaveLength(2);
        if (status === "execution_unknown") {
            await fixture.act(async () => queries()[0].click());
            expect(fixture.router.state.location.pathname).toBe("/image");
            const unchanged = fixture.useCanvasStore.getState().openProject("a")!.nodes[0];
            expect(unchanged.metadata?.content).toBe(primary.content);
            expect(unchanged.metadata?.images?.slice(1).map((image) => image.imageTaskRecordId)).toEqual(["slot-1", "slot-2"]);
            expect(requests).toEqual([]);
            return;
        }
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
