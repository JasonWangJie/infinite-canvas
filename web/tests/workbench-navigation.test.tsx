import { browser } from "./browser";
import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import axios from "axios";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import i18n from "@/i18n";
import { endCanvasSession, readCanvasSession } from "@/services/api/canvas-client";
import { getDocumentDraft, readDocument, retryDocument, writeDocument } from "@/services/canvas-data";
import { readStoredImage } from "@/services/image-storage";
import * as imageStorage from "@/services/image-storage";
import * as imageApi from "@/services/api/image";
import * as fileStorage from "@/services/file-storage";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useWorkbenchHistoryFilterStore } from "@/stores/use-workbench-history-filter-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { deleteVideoGenerationLogs } from "@/pages/video/generation-log";
import { runSiteTool } from "@/lib/agent/agent-site-tools";

const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
const session = { user: { id: 1, subject: `ics_${"a".repeat(32)}`, username: "alice" }, csrf_token: "csrf", session_tag: "history-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
const config = {
    ...defaultConfig,
    model: "gateway::image-model", imageModel: "gateway::image-model", videoModel: "gateway::video-model",
    channels: [{ id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai" as const, models: [
        { name: "image-model", capability: "image" as const, endpointTypes: ["image-generation"] },
        { name: "video-model", capability: "video" as const, endpointTypes: ["openai-video"] },
    ] }],
};
let documents: Record<string, { value: unknown; revision: number }>;
let requests: { path: string; method: string }[];
let localDocuments: ReturnType<typeof mockBrowserDocuments>;
let localFiles: ReturnType<typeof mockBrowserFiles>;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let oldMatchMedia: typeof browser.matchMedia;

function log(id: string, prompt: string, status = "success") {
    return { id, title: id, prompt, status, createdAt: id === "alpha" ? 2 : 1, time: "now", model: id === "alpha" ? "gateway::image-model" : "gateway::other-model", config, references: [], durationMs: 0, images: [], imageCount: 1, successCount: status === "success" ? 1 : 0, failCount: status === "failed" ? 1 : 0, size: "1024x1024", quality: "auto", resolution: "720", seconds: "5" };
}

beforeAll(async () => {
    await import("@/pages/image");
    await import("@/pages/video");
});

beforeEach(async () => {
    endCanvasSession();
    localStorage.clear();
    localDocuments = mockBrowserDocuments();
    localFiles = mockBrowserFiles();
    documents = {
        "image-tasks": { value: {}, revision: 1 },
        "image-workbench": { value: { alpha: log("alpha", "sunrise mountain"), beta: log("beta", "night river", "failed") }, revision: 1 },
        "video-workbench": { value: { alpha: log("alpha", "slow camera"), beta: log("beta", "fast camera", "paused") }, revision: 1 },
    };
    requests = [];
    const globals = {
        HTMLAnchorElement: browser.HTMLAnchorElement, MouseEvent: browser.MouseEvent, XMLHttpRequest: browser.XMLHttpRequest, navigator: browser.navigator,
        HTMLElement: browser.HTMLElement, Element: browser.Element, SVGElement: browser.SVGElement, ShadowRoot: browser.ShadowRoot,
        HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement, HTMLSelectElement: browser.HTMLSelectElement,
        DocumentFragment: browser.DocumentFragment, Event: browser.Event,
        Node: browser.Node, MutationObserver: browser.MutationObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
        IS_REACT_ACT_ENVIRONMENT: true,
        ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
        requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    };
    descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    oldMatchMedia = browser.matchMedia;
    browser.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, media: "", onchange: null });
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        requests.push({ path, method: init?.method || "GET" });
        if (path === "/api/session") return Response.json(session);
        if (path.startsWith("/api/data/")) {
            const domain = decodeURIComponent(path.slice("/api/data/".length));
            if (init?.method === "PUT") {
                const body = JSON.parse(String(init.body));
                documents[domain] = { value: body.value, revision: body.revision + 1 };
            }
            return Response.json(documents[domain] || { value: null, revision: 0 });
        }
        if (path === "/api/files" && init?.method === "POST") return Response.json({ id: "saved", storageKey: "image:saved", url: "/api/files/image%3Asaved", bytes: 5, mimeType: "image/png" });
        if (path.startsWith("/api/files/")) return new Response("image", { headers: { "Content-Type": "image/png" } });
        if (path === "/api/result-media/original") return new Response("image", { headers: { "Content-Type": "image/png" } });
        throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;
    axios.defaults.adapter = async () => { throw new Error("History navigation must not generate"); };
    await readCanvasSession();
    useConfigStore.setState({ config });
});

afterEach(async () => {
    try {
        if (root) await act(async () => root!.unmount());
    } finally {
        root = undefined;
        container?.remove();
        container = undefined;
        endCanvasSession();
        localDocuments?.restore();
        localFiles?.restore();
        useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
        useAssetStore.setState({ assets: [], hydrated: false });
        globalThis.fetch = originalFetch;
        axios.defaults.adapter = originalAdapter;
        browser.matchMedia = oldMatchMedia;
        for (const [key, descriptor] of descriptors || []) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});

async function renderPage(path: string) {
    const { default: ImagePage } = await import("@/pages/image");
    const { default: VideoPage } = await import("@/pages/video");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrap = (page: React.ReactNode) => <QueryClientProvider client={queryClient}><ConfigProvider theme={{ token: { motion: false } }}><App message={{ duration: 0 }}>{page}</App></ConfigProvider></QueryClientProvider>;
    const router = createMemoryRouter([{ path: "/image", element: wrap(<ImagePage />) }, { path: "/video", element: wrap(<VideoPage />) }], { initialEntries: [path] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    return router;
}

async function click(key: string, within: ParentNode = container!) {
    const button = [...within.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.replace(/\s/g, "") === i18n.t(key).replace(/\s/g, ""));
    expect(button).toBeDefined();
    await act(async () => button!.click());
}

async function selectAllResults() {
    const label = [...container!.querySelectorAll("label")].find((element) => element.textContent?.trim() === i18n.t("resultToCanvas.selectAllResults"));
    const checkbox = label?.querySelector<HTMLInputElement>("input");
    expect(checkbox).toBeDefined();
    await act(async () => checkbox!.click());
}

async function chooseReferences(files: File[]) {
    const input = container!.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => input.dispatchEvent(new browser.Event("change", { bubbles: true })));
}

function importedImage(name: string) {
    return { url: `blob:${name}`, storageKey: `image:${name}`, width: 20, height: 10, bytes: 10, mimeType: "image/png" };
}

test.each(["image", "video"])("%s reference import retains successful files, names failures and blocks generation until settled", async (page) => {
    const pending = Promise.withResolvers<imageStorage.UploadedImage>();
    const upload = spyOn(imageStorage, "uploadImage").mockImplementation(async (file) => {
        if ((file as File).name === "broken.png") throw new Error("decode failed");
        return pending.promise;
    });
    let modelCalls = 0;
    axios.defaults.adapter = async () => { modelCalls += 1; throw new Error("must not submit during import"); };
    try {
        await renderPage(`/${page}?log=alpha`);
        const generate = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === i18n.t("workbench.generate"))!;
        expect(generate.disabled).toBe(false);
        await chooseReferences([new File(["good"], "good.png", { type: "image/png" }), new File(["bad"], "broken.png", { type: "image/png" })]);
        expect(upload).toHaveBeenCalledTimes(2);
        expect(generate.disabled).toBe(true);
        expect(container!.textContent).toContain(i18n.t("workbench.importingReferences"));
        await act(async () => generate.click());
        expect(modelCalls).toBe(0);
        await act(async () => pending.resolve(importedImage("good.png")));
        expect(container!.querySelector('img[alt="good.png"]')?.getAttribute("src")).toBe("blob:good.png");
        expect(container!.querySelector('img[alt="broken.png"]')).toBeNull();
        expect(document.body.textContent).toContain("broken.png：decode failed");
        expect(generate.disabled).toBe(false);
        expect(modelCalls).toBe(0);
    } finally { upload.mockRestore(); }
});

test.each(["image", "video"])("%s rejects an agent run during import without attaching its task to the next manual run", async (page) => {
    const pending = Promise.withResolvers<imageStorage.UploadedImage>();
    const upload = spyOn(imageStorage, "uploadImage").mockImplementation(() => pending.promise);
    const updateTask = useWorkbenchAgentStore.getState().updateTask;
    const updates: string[] = [];
    useWorkbenchAgentStore.setState({ imageCommand: null, videoCommand: null, tasks: [], updateTask: (id, patch) => { updates.push(id); updateTask(id, patch); } });
    let modelCalls = 0;
    axios.defaults.adapter = async () => { modelCalls += 1; throw new Error("manual submission failed"); };
    try {
        await renderPage(`/${page}?log=alpha`);
        await chooseReferences([new File(["image"], "pending.png", { type: "image/png" })]);
        let taskId: string | undefined;
        await act(async () => {
            const store = useWorkbenchAgentStore.getState();
            taskId = (page === "image" ? store.dispatchImage : store.dispatchVideo)({ prompt: "agent prompt", run: true });
        });
        expect(useWorkbenchAgentStore.getState().tasks.find((task) => task.id === taskId)?.status).toBe("failed");
        expect(updates).toEqual([taskId!]);
        expect(modelCalls).toBe(0);
        await act(async () => pending.resolve(importedImage("pending.png")));
        expect(modelCalls).toBe(0);
        const removeReference = container!.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t(page === "image" ? "imageWorkbench.removeReference" : "videoWorkbench.removeImage")}"]`)!;
        await act(async () => removeReference.click());
        await click("workbench.generate");
        expect(modelCalls).toBe(1);
        expect(updates).toEqual([taskId!]);
        expect(useWorkbenchAgentStore.getState().tasks.find((task) => task.id === taskId)?.status).toBe("failed");
    } finally {
        upload.mockRestore();
        await act(async () => useWorkbenchAgentStore.setState({ imageCommand: null, videoCommand: null, tasks: [], updateTask }));
    }
});

for (const page of ["image", "video"]) {
    test.each(["denied", "empty"])(`${page} clipboard %s is reported without importing or submitting`, async (result) => {
        const previous = Object.getOwnPropertyDescriptor(browser.navigator, "clipboard");
        const upload = spyOn(imageStorage, "uploadImage");
        Object.defineProperty(browser.navigator, "clipboard", { configurable: true, value: { read: async () => {
            if (result === "denied") throw new DOMException("clipboard permission denied", "NotAllowedError");
            return [{ types: ["text/plain"] }];
        } } });
        try {
            await renderPage(`/${page}?log=alpha`);
            await click("workbench.clipboard");
            expect(document.body.textContent).toContain(result === "denied" ? "clipboard permission denied" : i18n.t("imageWorkbench.clipboardEmpty"));
            expect(upload).not.toHaveBeenCalled();
            expect(requests.some((request) => request.path.startsWith("/api/ai/") || request.method === "POST")).toBe(false);
            expect(container!.textContent).not.toContain(i18n.t("workbench.importingReferences"));
        } finally {
            upload.mockRestore();
            if (previous) Object.defineProperty(browser.navigator, "clipboard", previous);
            else Reflect.deleteProperty(browser.navigator, "clipboard");
        }
    });

    test.each(["navigation", "history", "session"])(`${page} reference import discards a late result after %s`, async (change) => {
        const pending = Promise.withResolvers<imageStorage.UploadedImage>();
        let signal: AbortSignal | undefined;
        const upload = spyOn(imageStorage, "uploadImage").mockImplementation((_file, options) => { signal = options?.signal; return pending.promise; });
        try {
            const router = await renderPage(`/${page}?log=alpha`);
            await chooseReferences([new File(["late"], "late.png", { type: "image/png" })]);
            expect(upload).toHaveBeenCalledTimes(1);
            if (change === "navigation") await act(async () => router.navigate(`/${page === "image" ? "video" : "image"}?log=alpha`));
            if (change === "history") await act(async () => router.navigate(`/${page}?log=beta`));
            if (change === "session") await act(async () => { endCanvasSession(); await readCanvasSession(); });
            if (change !== "history") expect(signal?.aborted).toBe(true);
            await act(async () => pending.resolve(importedImage("late.png")));
            expect(container!.querySelector('img[alt="late.png"]')).toBeNull();
            expect(requests.some((request) => request.method === "POST")).toBe(false);
        } finally { upload.mockRestore(); }
    });
}

test.each(["image", "video"])("%s history lists metadata first and loads only the opened record's media", async (page) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
    Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: class { observe() {} disconnect() {} } });
    const resolveImage = spyOn(imageStorage, "resolveImageUrl").mockImplementation(async (key) => `blob:${key}`);
    const resolveVideo = spyOn(fileStorage, "resolveMediaUrl").mockImplementation(async (key) => `blob:${key}`);
    const preview = spyOn(imageStorage, "ensureImagePreview").mockResolvedValue(undefined);
    documents[`${page}-workbench`].value = Object.fromEntries(["alpha", "beta"].map((id) => [id, {
        ...log(id, `${id} media`), model: page === "image" ? config.imageModel : config.videoModel,
        references: [{ id, name: `${id}.png`, type: "image/png", storageKey: `image:ref-${id}`, dataUrl: "" }],
        images: [{ id, storageKey: `image:${id}`, dataUrl: "", width: 20, height: 10, bytes: 10, durationMs: 0 }],
        video: { url: "", storageKey: `media:${id}`, width: 20, height: 10, bytes: 10, mimeType: "video/mp4" },
    }]));
    try {
        await renderPage(`/${page}`);
        expect(resolveImage).not.toHaveBeenCalled();
        expect(resolveVideo).not.toHaveBeenCalled();
        expect(preview).not.toHaveBeenCalled();
        const card = [...container!.querySelectorAll<HTMLButtonElement>("aside button")].find((button) => button.textContent?.includes("alpha"))!;
        expect(card).toBeDefined();
        await act(async () => card.click());
        expect(container!.querySelector('img[alt="alpha.png"]')?.getAttribute("src")).toBe("blob:image:ref-alpha");
        expect(resolveImage.mock.calls.some(([key]) => key === "image:ref-alpha")).toBe(true);
        expect(resolveImage.mock.calls.every(([key]) => !key?.includes("beta"))).toBe(true);
        if (page === "image") expect(container!.querySelector('img[src="blob:image:alpha"]')).not.toBeNull();
        else {
            expect(resolveVideo).toHaveBeenCalledWith("media:alpha", "");
            expect(container!.querySelector('video[src="blob:media:alpha"]')).not.toBeNull();
        }
        expect(resolveVideo.mock.calls.every(([key]) => !key?.includes("beta"))).toBe(true);
    } finally {
        resolveImage.mockRestore(); resolveVideo.mockRestore(); preview.mockRestore();
        if (previous) Object.defineProperty(globalThis, "IntersectionObserver", previous);
        else Reflect.deleteProperty(globalThis, "IntersectionObserver");
    }
});

test.each(["image", "video"])("%s late history media cannot overwrite a newly edited prompt", async (page) => {
    const pending = Promise.withResolvers<string>();
    const resolveImage = spyOn(imageStorage, "resolveImageUrl").mockImplementation(() => pending.promise);
    const importing = Promise.withResolvers<imageStorage.UploadedImage>();
    const upload = spyOn(imageStorage, "uploadImage").mockImplementation(() => importing.promise);
    documents[`${page}-workbench`].value = { alpha: { ...log("alpha", "saved history prompt"), references: [{ id: "reference", name: "history.png", type: "image/png", storageKey: "image:slow", dataUrl: "" }] } };
    try {
        await renderPage(`/${page}?log=alpha`);
        expect(resolveImage).toHaveBeenCalledWith("image:slow", "");
        const textarea = container!.querySelector("textarea")!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "my new prompt");
            textarea.dispatchEvent(new browser.Event("input", { bubbles: true }));
        });
        expect(textarea.value).toBe("my new prompt");
        await chooseReferences([new File(["image"], "new-reference.png", { type: "image/png" })]);
        await act(async () => importing.resolve(importedImage("new-reference.png")));
        expect(container!.querySelector('img[alt="new-reference.png"]')).not.toBeNull();
        await act(async () => pending.resolve("blob:history"));
        expect(textarea.value).toBe("my new prompt");
        expect(container!.querySelector('img[alt="new-reference.png"]')).not.toBeNull();
        expect(container!.querySelector('img[alt="history.png"]')).toBeNull();
        // Capture cancellation must run before the next history click starts its own preview.
        const card = [...container!.querySelectorAll<HTMLButtonElement>("aside button")].find((button) => button.textContent?.includes("alpha"))!;
        await act(async () => card.click());
        expect(textarea.value).toBe("saved history prompt");
        expect(container!.querySelector('img[alt="history.png"]')?.getAttribute("src")).toBe("blob:history");
        expect(requests.some((request) => request.method === "POST")).toBe(false);
    } finally { resolveImage.mockRestore(); upload.mockRestore(); }
});

test("image history thumbnails load only when their card becomes visible", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
    const observers: { target?: Element; callback: IntersectionObserverCallback }[] = [];
    Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: class {
        entry: typeof observers[number];
        constructor(callback: IntersectionObserverCallback) { this.entry = { callback }; observers.push(this.entry); }
        observe(target: Element) { this.entry.target = target; }
        disconnect() {}
    } });
    const preview = spyOn(imageStorage, "ensureImagePreview").mockImplementation(async (key) => `blob:thumb-${key}`);
    documents["image-workbench"].value = Object.fromEntries(["alpha", "beta"].map((id) => [id, { ...log(id, id), images: [{ id, storageKey: `image:${id}`, dataUrl: "", width: 20, height: 10, bytes: 10 }] }]));
    try {
        await renderPage("/image");
        expect(preview).not.toHaveBeenCalled();
        const visible = observers.find((entry) => entry.target?.textContent?.includes("alpha"))!;
        expect(visible).toBeDefined();
        await act(async () => visible.callback([{ isIntersecting: true, target: visible.target } as IntersectionObserverEntry], {} as IntersectionObserver));
        expect(preview).toHaveBeenCalledTimes(1);
        expect(preview).toHaveBeenCalledWith("image:alpha");
        expect(visible.target!.querySelector('img[src="blob:thumb-image:alpha"]')).not.toBeNull();
    } finally {
        preview.mockRestore();
        if (previous) Object.defineProperty(globalThis, "IntersectionObserver", previous);
        else Reflect.deleteProperty(globalThis, "IntersectionObserver");
    }
});

test("image deep links use a fresh history snapshot and never submit generation", async () => {
    await readDocument("image-workbench");
    documents["image-workbench"] = { value: { fresh: log("fresh", "new record from another page") }, revision: 2 };
    await renderPage("/image?log=fresh");
    expect(container!.querySelector("textarea")!.value).toBe("new record from another page");
    expect(container!.querySelector('[role="alert"]')).toBeNull();
    expect(requests.filter((request) => request.path.startsWith("/api/ai/"))).toEqual([]);
});

test("video deep links preview paused tasks without querying or resubmitting them", async () => {
    documents["video-workbench"].value = { beta: { ...log("beta", "paused camera", "paused"), task: { id: "existing-video", provider: "openai", model: config.videoModel }, error: "temporary failure" } };
    await renderPage("/video?log=beta");
    expect(container!.querySelector("textarea")!.value).toBe("paused camera");
    expect(container!.textContent).toContain("temporary failure");
    expect(requests.filter((request) => request.path.startsWith("/api/ai/"))).toEqual([]);
});

test("image filters share desktop and drawer state, survive navigation, and clear on session end", async () => {
    const router = await renderPage("/image");
    await act(async () => useWorkbenchHistoryFilterStore.getState().update("image", { query: "night", status: "failed" }));
    expect(container!.querySelector("aside")!.textContent).toContain("beta");
    expect(container!.querySelector("aside")!.textContent).not.toContain("alpha");
    await click("workbench.logs");
    const searches = document.querySelectorAll<HTMLInputElement>(`input[aria-label="${i18n.t("workbench.historySearch")}"]`);
    expect(searches.length).toBe(2);
    expect([...searches].map((input) => input.value)).toEqual(["night", "night"]);
    await act(async () => router.navigate("/video"));
    await act(async () => router.navigate("/image"));
    expect(container!.querySelector<HTMLInputElement>(`input[aria-label="${i18n.t("workbench.historySearch")}"]`)!.value).toBe("night");
    await click("workbench.historyClearFilters", container!.querySelector("aside")!);
    expect(container!.querySelector("aside")!.textContent).toContain("alpha");
    await act(async () => useWorkbenchHistoryFilterStore.getState().update("image", { query: "secret search" }));
    await act(async () => endCanvasSession());
    expect(useWorkbenchHistoryFilterStore.getState().image.query).toBe("");
});

test("filtering clears hidden selection and deleting visible history preserves shared files", async () => {
    const beta = { ...log("beta", "night river", "failed"), images: [{ id: "shared", storageKey: "image:shared", dataUrl: "", width: 1, height: 1, bytes: 4, durationMs: 0 }] };
    documents["image-workbench"].value = { alpha: log("alpha", "sunrise mountain"), beta };
    await renderPage("/image");
    const aside = container!.querySelector("aside")!;
    await click("workbench.selectAll", aside);
    await act(async () => useWorkbenchHistoryFilterStore.getState().update("image", { query: "night" }));
    expect(aside.textContent).toContain(i18n.t("workbench.historySelectedCount", { count: 1 }));
    await click("common.delete", aside);
    await click("common.delete", document.querySelector('[role="dialog"]')!);
    expect(Object.keys(documents["image-workbench"].value as object)).toEqual(["alpha"]);
    expect(requests.filter((request) => request.method === "PUT" && request.path === "/api/data/image-workbench")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([]);
});

test("model search, no-match feedback and unavailable links preserve the current preview", async () => {
    const router = await renderPage("/video?log=alpha");
    await act(async () => useWorkbenchHistoryFilterStore.getState().update("video", { query: "other-model" }));
    expect(container!.querySelector("aside")!.textContent).toContain("beta");
    expect(container!.querySelector("aside")!.textContent).not.toContain("alpha");
    await act(async () => useWorkbenchHistoryFilterStore.getState().update("video", { query: "not present" }));
    expect(container!.textContent).toContain(i18n.t("workbench.historyNoMatches"));
    await act(async () => router.navigate("/video?log=deleted"));
    expect(container!.querySelector("textarea")!.value).toBe("slow camera");
    expect(container!.textContent).toContain(i18n.t("workbench.historySourceMissing"));
});

test("image task links highlight the original task without starting a new generation", async () => {
    documents["image-tasks"].value = { "original-record": { id: "original-record", task_id: "original-task", status: "succeeded", value: { model: "image-model", result: { data: [{ url: "/api/result-media/original" }] } } } };
    await renderPage("/image?task=original-record");
    expect(container!.querySelector('[aria-current="true"]')!.textContent).toContain("image-model");
    expect(container!.querySelector('[aria-current="true"]')!.textContent).toContain(i18n.t("managed.viewResults"));
    expect(requests.filter((request) => request.path.startsWith("/api/ai/") || request.path.startsWith("/api/generations"))).toEqual([]);
});


test("stored task images reuse the private file and reject a decode completed after session change", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "Image");
    let finishDecode: (() => void) | undefined;
    let waitForDecode = false;
    let notifyDecode!: () => void;
    const decoding = new Promise<void>((resolve) => { notifyDecode = resolve; });
    Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
        src = ""; naturalWidth = 1600; naturalHeight = 900;
        decode() { return waitForDecode ? new Promise<void>((resolve) => { finishDecode = resolve; notifyDecode(); }) : Promise.resolve(); }
    } });
    try {
        const image = await readStoredImage("image:original");
        expect(image).toMatchObject({ storageKey: "image:original", url: "/api/files/image%3Aoriginal", width: 1600, height: 900, mimeType: "image/png" });
        expect(requests.filter((request) => request.path.startsWith("/api/files"))).toEqual([{ path: "/api/files/image%3Aoriginal", method: "GET" }]);
        documents["image-tasks"].value = { "original-record": { id: "original-record", task_id: "original-task", status: "succeeded", value: { model: "image-model", result: { data: [{ url: "/api/result-media/original" }] }, localImages: { 0: "image:original" } } } };
        await renderPage("/image?task=original-record");
        await click("managed.viewResults");
        expect(container!.querySelector('img[src="/api/files/image%3Aoriginal"]')).not.toBeNull();
        expect(requests.some((request) => request.path === "/api/files" && request.method === "POST")).toBe(false);
        waitForDecode = true;
        const reading = readStoredImage("image:original");
        void reading.catch(() => {});
        await decoding;
        expect(finishDecode).toBeDefined();
        await act(async () => endCanvasSession());
        finishDecode!();
        await expect(reading).rejects.toThrow(i18n.t("saveRecovery.sessionChanged"));
        expect(requests.some((request) => request.method === "POST")).toBe(false);
    } finally {
        if (previous) Object.defineProperty(globalThis, "Image", previous);
        else Reflect.deleteProperty(globalThis, "Image");
    }
});


test("a history link waits for an active video query and opens only after it finishes", async () => {
    const queued = { ...log("queued", "in-flight video", "pending"), model: config.videoModel, task: { id: "existing-video", provider: "openai", model: config.videoModel } };
    documents["video-workbench"].value = { queued, alpha: log("alpha", "saved camera") };
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const queries: string[] = [];
    axios.defaults.adapter = async (request) => {
        queries.push(`${request.method} ${request.url}`);
        await gate;
        return { data: { id: "existing-video", status: "failed", error: { message: "upstream rejected" } }, status: 200, statusText: "OK", headers: {}, config: request };
    };
    const router = await renderPage("/video");
    expect(queries).toHaveLength(1);
    await act(async () => router.navigate("/video?log=alpha"));
    expect(container!.querySelector("textarea")!.value).toBe("");
    expect(container!.textContent).toContain(i18n.t("workbench.historyWaitForGeneration"));
    await act(async () => finish());
    expect(container!.querySelector("textarea")!.value).toBe("saved camera");
    expect(queries.every((query) => query.startsWith("get "))).toBe(true);
});

test("an older history read cannot replace a newer deep-link preview", async () => {
    const fetchNormally = globalThis.fetch;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let reads = 0;
    globalThis.fetch = (async (input, init) => {
        if (String(input) === "/api/data/image-workbench" && !init?.method && reads++ === 0) {
            await gate;
            return Response.json({ value: { alpha: log("alpha", "stale prompt") }, revision: 1 });
        }
        return fetchNormally(input, init);
    }) as typeof fetch;
    const router = await renderPage("/image?log=alpha");
    await act(async () => router.navigate("/image?log=beta"));
    expect(container!.querySelector("textarea")!.value).toBe("night river");
    await act(async () => finish());
    expect(container!.querySelector("textarea")!.value).toBe("night river");
    expect(container!.querySelector('[role="alert"]')).toBeNull();
});


test.each(["deep-link", "leave-page"])("an image completing after %s persists its result without stale navigation", async (navigation) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "Image");
    Object.defineProperty(globalThis, "Image", { configurable: true, value: class { src = ""; naturalWidth = 1600; naturalHeight = 900; decode() { return Promise.resolve(); } } });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const submissions: string[] = [];
    axios.defaults.adapter = async (request) => {
        submissions.push(`${request.method} ${request.url}`);
        await gate;
        return { data: { data: [{ url: "/api/result-media/original" }] }, status: 200, statusText: "OK", headers: {}, config: request };
    };
    try {
        const router = await renderPage("/image?log=alpha");
        await click("workbench.generate");
        expect(submissions).toHaveLength(1);
        await act(async () => router.navigate(navigation === "deep-link" ? "/image?log=beta" : "/video?log=alpha"));
        if (navigation === "deep-link") expect(container!.querySelector("textarea")!.value).toBe("sunrise mountain");
        await act(async () => finish());
        const saved = Object.values(documents["image-workbench"].value as Record<string, ReturnType<typeof log>>).find((item) => item.id !== "alpha" && item.id !== "beta");
        expect(saved?.status).toBe("success");
        expect(saved?.images).toMatchObject([{ storageKey: "image:saved", width: 1600, height: 900 }]);
        expect(container!.querySelector("textarea")!.value).toBe(navigation === "deep-link" ? "night river" : "slow camera");
        expect(submissions).toHaveLength(1);
    } finally {
        if (previous) Object.defineProperty(globalThis, "Image", previous);
        else Reflect.deleteProperty(globalThis, "Image");
    }
});


test.each([false, true])("video creation persists its original task before polling even when saving the received ID fails: %s", async (failFirstSave) => {
    const fetchNormally = globalThis.fetch;
    let failSave = failFirstSave;
    globalThis.fetch = (async (input, init) => {
        const hasTask = init?.body && Object.values(JSON.parse(String(init.body)).value || {}).some((item: any) => item.task?.id === "created-video");
        if (String(input) === "/api/data/video-workbench" && init?.method === "PUT" && failSave && hasTask) {
            failSave = false;
            return Response.json({ error: { message: "save unavailable" } }, { status: 503 });
        }
        return fetchNormally(input, init);
    }) as typeof fetch;
    const modelRequests: string[] = [];
    const storedAtQuery: unknown[] = [];
    axios.defaults.adapter = async (request) => {
        modelRequests.push(`${request.method} ${request.url}`);
        if (request.method === "get") storedAtQuery.push(Object.values(documents["video-workbench"].value as Record<string, { task?: { id: string } }>).find((item) => item.task?.id === "created-video"));
        return { data: request.method === "post" ? { id: "created-video", status: "queued" } : { id: "created-video", status: "failed", error: { message: "provider failure" } }, status: 200, statusText: "OK", headers: {}, config: request };
    };
    await renderPage("/video?log=alpha");
    const generate = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === i18n.t("workbench.generate"))!;
    await act(async () => { generate.click(); generate.click(); });
    if (failFirstSave) {
        const draft = getDocumentDraft("video-workbench") as Record<string, { status: string; task?: { id: string } }>;
        const pending = Object.values(draft).find((item) => item.task?.id === "created-video");
        expect(pending?.status).toBe("paused");
        expect(modelRequests).toEqual(["post /api/ai/v1/videos"]);
        await act(async () => { await retryDocument("video-workbench"); });
        await click("videoWorkbench.resume");
    }
    expect(modelRequests).toEqual(["post /api/ai/v1/videos", "get /api/ai/v1/videos/created-video"]);
    expect(storedAtQuery).toHaveLength(1);
    expect(storedAtQuery[0]).toMatchObject({ task: { id: "created-video" } });
});

test("video submission does not reach the paid endpoint if saving its intent fails", async () => {
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => String(input) === "/api/data/video-workbench" && init?.method === "PUT"
        ? Response.json({ error: { message: "QuotaExceededError" } }, { status: 503 })
        : transport(input, init)) as typeof fetch;
    const submissions: string[] = [];
    axios.defaults.adapter = async (request) => { submissions.push(String(request.url)); throw new Error("must not submit"); };
    await renderPage("/video?log=alpha");
    await click("workbench.generate");
    expect(submissions).toEqual([]);
    expect(Object.keys(documents["video-workbench"].value as object)).toEqual(["alpha", "beta"]);
    const draft = Object.values(getDocumentDraft("video-workbench") as Record<string, { id: string; status: string }>).find((item) => !["alpha", "beta"].includes(item.id));
    expect(draft?.status).toBe("failed");
    expect(container!.textContent).toContain("QuotaExceededError");
});

test.each(["network", "server", "timeout", "missing-id"])("an uncertain video %s response keeps one durable intent without a regenerate action", async (failure) => {
    const submissions: string[] = [];
    let intentId = "";
    axios.defaults.adapter = async (request) => {
        submissions.push(`${request.method} ${request.url}`);
        const intent = Object.values(documents["video-workbench"].value as Record<string, { id: string; status: string; task?: unknown }>).find((item) => !["alpha", "beta"].includes(item.id));
        expect(intent?.status).toBe("unknown");
        expect(intent?.task).toBeUndefined();
        intentId = intent!.id;
        if (failure === "missing-id") return { data: { status: "queued" }, status: 200, statusText: "OK", headers: {}, config: request };
        const response = failure === "network" ? undefined : { status: failure === "timeout" ? 408 : 503, data: { error: { message: "response lost" } }, statusText: "Error", headers: {}, config: request };
        throw new axios.AxiosError("response lost", "ERR_NETWORK", request, undefined, response);
    };
    const router = await renderPage("/video?log=alpha");
    await click("workbench.generate");
    const saved = documents["video-workbench"].value as Record<string, { status: string; task?: unknown }>;
    expect(saved[intentId].status).toBe("unknown");
    expect(saved[intentId].task).toBeUndefined();
    expect(Object.keys(saved)).toHaveLength(3);
    expect(container!.textContent).toContain(i18n.t("managed.imageTaskUnknown"));
    expect(container!.textContent).not.toContain(i18n.t("videoWorkbench.regenerate"));
    expect(container!.textContent).not.toContain(i18n.t("videoWorkbench.resume"));
    await act(async () => router.navigate("/image?log=alpha"));
    await act(async () => router.navigate(`/video?log=${intentId}`));
    expect(container!.textContent).toContain(i18n.t("managed.imageTaskUnknown"));
    expect(container!.textContent).not.toContain(i18n.t("videoWorkbench.regenerate"));
    expect(submissions).toEqual(["post /api/ai/v1/videos"]);
});

test("an explicit video request rejection stays failed and permits a deliberate new submission", async () => {
    const submissions: string[] = [];
    axios.defaults.adapter = async (request) => {
        submissions.push(String(request.url));
        throw new axios.AxiosError("bad prompt", "ERR_BAD_REQUEST", request, undefined, { status: 400, data: { error: { message: "bad prompt" } }, statusText: "Bad Request", headers: {}, config: request });
    };
    await renderPage("/video?log=alpha");
    await click("workbench.generate");
    const saved = Object.values(documents["video-workbench"].value as Record<string, { id: string; status: string }>).find((item) => !["alpha", "beta"].includes(item.id));
    expect(saved?.status).toBe("failed");
    await click("videoWorkbench.regenerate");
    expect(submissions).toEqual(["/api/ai/v1/videos", "/api/ai/v1/videos"]);
});

test("adding a video result waits for local saving and a failed save cannot add duplicates", async () => {
    const video = { id: "saved-video", url: "", storageKey: "media:video", width: 1280, height: 720, bytes: 5, durationMs: 1000, mimeType: "video/mp4" };
    documents["video-workbench"].value = { alpha: { ...log("alpha", "camera"), video } };
    documents.assets = { value: { state: { assets: [] }, version: 0 }, revision: 1 };
    await useAssetStore.persist.rehydrate();
    const transport = globalThis.fetch;
    const gate = Promise.withResolvers<void>();
    let writes = 0, failing = true;
    globalThis.fetch = (async (input, init) => {
        if (String(input) === "/api/data/assets" && init?.method === "PUT") {
            writes += 1;
            await gate.promise;
            if (failing) return Response.json({ error: { message: "QuotaExceededError" } }, { status: 503 });
        }
        return transport(input, init);
    }) as typeof fetch;
    await renderPage("/video?log=alpha");
    await click("common.addToAssets");
    await click("common.addToAssets");
    expect(writes).toBe(1);
    expect(document.body.textContent).not.toContain(i18n.t("common.addedToAssets"));
    await act(async () => gate.resolve());
    expect(useAssetStore.getState().assets).toHaveLength(1);
    expect((documents.assets.value as { state: { assets: unknown[] } }).state.assets).toEqual([]);
    expect(document.body.textContent).toContain("QuotaExceededError");
    expect(document.body.textContent).not.toContain(i18n.t("common.addedToAssets"));
    await click("common.addToAssets");
    expect(writes).toBe(1);
    expect(useAssetStore.getState().assets).toHaveLength(1);
    failing = false;
    await act(async () => { await retryDocument("assets"); });
    expect((documents.assets.value as { state: { assets: unknown[] } }).state.assets).toHaveLength(1);
    expect(requests.filter((request) => request.path === "/api/files" && request.method === "POST")).toEqual([]);
});

test.each([false, true])("a deleted video submission intent stays deleted when its response is uncertain: %s", async (uncertain) => {
    const gate = Promise.withResolvers<void>();
    const submissions: string[] = [];
    let intentId = "";
    axios.defaults.adapter = async (request) => {
        submissions.push(`${request.method} ${request.url}`);
        intentId = Object.keys(documents["video-workbench"].value as object).find((id) => !["alpha", "beta"].includes(id))!;
        await gate.promise;
        if (uncertain) throw new axios.AxiosError("lost response", "ERR_NETWORK", request);
        return { data: { id: "created-video", status: "queued" }, status: 200, statusText: "OK", headers: {}, config: request };
    };
    await renderPage("/video?log=alpha");
    await click("workbench.generate");
    expect(intentId).not.toBe("");
    await act(async () => { await deleteVideoGenerationLogs([intentId]); });
    await act(async () => gate.resolve());
    expect(Object.keys(documents["video-workbench"].value as object)).toEqual(["alpha", "beta"]);
    expect(submissions).toEqual(["post /api/ai/v1/videos"]);
});

test("image result selection adds only the visible chosen results in one save without uploading or generating", async () => {
    const images = ["first", "second", "third"].map((id) => ({ id, storageKey: `image:${id}`, dataUrl: "", width: 1600, height: 900, bytes: 4, durationMs: 0 }));
    documents["image-workbench"].value = { alpha: { ...log("alpha", "gallery"), images, imageCount: 3, successCount: 3 } };
    documents.canvas = { value: { state: { projects: [{ id: "destination", title: "Destination", createdAt: "2026-01-01", updatedAt: "2026-01-01", nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } }], deletedProjects: [] }, version: 0 }, revision: 1 };
    await useCanvasStore.persist.rehydrate();
    await renderPage("/image?log=alpha");
    await selectAllResults();
    expect(container!.textContent).toContain(i18n.t("resultToCanvas.selectedCount", { count: 3 }));
    const second = container!.querySelector<HTMLInputElement>(`input[aria-label="${i18n.t("resultToCanvas.selectResult", { count: 2 })}"]`);
    expect(second).not.toBeNull();
    await act(async () => second!.click());
    expect(container!.textContent).toContain(i18n.t("resultToCanvas.selectedCount", { count: 2 }));
    const add = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.replace(/\s/g, "") === i18n.t("resultToCanvas.insertBatch", { count: 2 }).replace(/\s/g, ""));
    expect(add).toBeDefined();
    await act(async () => { add!.click(); add!.click(); });
    const saved = documents.canvas.value as { state: { projects: Array<{ nodes: Array<{ metadata?: { storageKey?: string } }> }> } };
    expect(saved.state.projects[0].nodes.map((node) => node.metadata?.storageKey)).toEqual(["image:first", "image:third"]);
    expect(requests.filter((request) => request.method === "PUT" && request.path === "/api/data/canvas")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "POST" || request.method === "DELETE")).toEqual([]);
});

test("clearing result selection or switching history never keeps hidden images selected", async () => {
    const image = { id: "first", storageKey: "image:first", dataUrl: "", width: 100, height: 100, bytes: 4, durationMs: 0 };
    documents["image-workbench"].value = {
        alpha: { ...log("alpha", "first gallery"), images: [image] },
        beta: { ...log("beta", "second gallery"), images: [{ ...image, id: "second", storageKey: "image:second" }] },
    };
    const router = await renderPage("/image?log=alpha");
    await selectAllResults();
    expect(container!.textContent).toContain(i18n.t("resultToCanvas.selectedCount", { count: 1 }));
    await click("resultToCanvas.clearSelection");
    expect(container!.querySelector<HTMLInputElement>(`input[aria-label="${i18n.t("resultToCanvas.selectResult", { count: 1 })}"]`)!.checked).toBe(false);
    await selectAllResults();
    await act(async () => router.navigate("/image?log=beta"));
    expect(container!.querySelector<HTMLInputElement>(`input[aria-label="${i18n.t("resultToCanvas.selectResult", { count: 1 })}"]`)!.checked).toBe(false);
    expect(requests.filter((request) => request.path === "/api/data/canvas" && request.method !== "GET")).toEqual([]);
    expect(requests.filter((request) => request.method === "POST" || request.method === "DELETE")).toEqual([]);
});

type SavedImageLog = { id: string; status: string; imageCount: number; requestCount: number; successCount: number; failCount: number; recoverableCount: number; imageTaskRecordIds: string[]; recoverableRecordIds: string[]; images: { id: string; storageKey: string }[] };
function newImageLog() {
    return Object.values(documents["image-workbench"].value as Record<string, SavedImageLog>).find((item) => !["alpha", "beta"].includes(item.id))!;
}

test.each(["history", "new-session", "cancel"])("result references reuse local media and discard late completion after %s", async (change) => {
    const pending = Promise.withResolvers<string>();
    const resolveUrl = spyOn(imageStorage, "resolveImageUrl");
    const upload = spyOn(imageStorage, "uploadImage");
    documents["image-workbench"].value = { alpha: { ...log("alpha", "old prompt"), images: [{ id: "original", storageKey: "image:original", dataUrl: "", width: 100, height: 100, bytes: 4, durationMs: 0 }] }, beta: log("beta", "new prompt", "failed") };
    try {
        const router = await renderPage("/image?log=alpha");
        resolveUrl.mockImplementationOnce(() => pending.promise);
        await click("imageWorkbench.addReference");
        const generate = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === i18n.t("workbench.generate"))!;
        expect(generate.disabled).toBe(true);
        expect(upload).not.toHaveBeenCalled();
        if (change === "history") await act(async () => router.navigate("/image?log=beta"));
        else await click(change === "new-session" ? "workbench.new" : "common.cancel");
        await act(async () => pending.resolve("blob:old-result"));
        expect(Boolean(container!.querySelector('img[alt="result-1.png"]'))).toBe(false);
        expect(upload).not.toHaveBeenCalled();
    } finally { resolveUrl.mockRestore(); upload.mockRestore(); }
});

test.each(["image", "video"])("%s asset reference import shares busy state, reuses the file and cancels on new history", async (page) => {
    const pending = Promise.withResolvers<string>();
    const resolveUrl = spyOn(imageStorage, "resolveImageUrl");
    const upload = spyOn(imageStorage, "uploadImage");
    useAssetStore.setState({ hydrated: true, assets: [{ id: "picked", kind: "image", title: "saved-reference", coverUrl: "", tags: [], data: { storageKey: "image:picked", dataUrl: "blob:existing", width: 20, height: 10, bytes: 4, mimeType: "image/png" }, createdAt: "2026-01-01", updatedAt: "2026-01-01" }] });
    try {
        const router = await renderPage(`/${page}?log=alpha`);
        await click("workbench.viewAssets");
        resolveUrl.mockImplementationOnce(() => pending.promise);
        const card = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.includes("saved-reference"))!;
        await act(async () => card.click());
        expect(container!.textContent).toContain(i18n.t("workbench.importingReferences"));
        expect(upload).not.toHaveBeenCalled();
        await act(async () => router.navigate(`/${page}?log=beta`));
        await act(async () => pending.resolve("blob:picked"));
        expect(Boolean(container!.querySelector('img[alt="saved-reference"]'))).toBe(false);
        expect(upload).not.toHaveBeenCalled();
    } finally { resolveUrl.mockRestore(); upload.mockRestore(); }
});

test("one image request keeps every returned image, links its intent before payment and saves an asset once", async () => {
    let uploadCount = 0, modelCalls = 0;
    const upload = spyOn(imageStorage, "uploadImage").mockImplementation(async () => importedImage(`returned-${++uploadCount}`));
    axios.defaults.adapter = async (request) => {
        modelCalls += 1;
        expect(newImageLog().imageTaskRecordIds).toEqual(Object.keys(documents["image-tasks"].value as object));
        expect(newImageLog().imageTaskRecordIds).toHaveLength(1);
        return { config: request, status: 200, statusText: "OK", headers: {}, data: { data: [{ b64_json: "Zmlyc3Q=" }, { b64_json: "c2Vjb25k" }] } };
    };
    documents.assets = { value: { state: { assets: [] }, version: 0 }, revision: 1 };
    try {
        await useAssetStore.persist.rehydrate();
        await renderPage("/image?log=alpha");
        await click("workbench.generate");
        expect(modelCalls).toBe(1);
        expect(uploadCount).toBe(2);
        expect(newImageLog()).toMatchObject({ status: "success", imageCount: 2, successCount: 2, requestCount: 1, failCount: 0, recoverableCount: 0, recoverableRecordIds: [] });
        expect(newImageLog().images.map((image) => image.storageKey)).toEqual(["image:returned-1", "image:returned-2"]);
        await selectAllResults();
        expect(container!.textContent).toContain(i18n.t("resultToCanvas.selectedCount", { count: 2 }));
        const adding = Promise.withResolvers<Response>();
        const transport = globalThis.fetch;
        globalThis.fetch = (async (input, init) => String(input) === "/api/data/assets" && init?.method === "PUT" ? transport(input, init).then((response) => adding.promise.then(() => response)) : transport(input, init)) as typeof fetch;
        const add = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === i18n.t("common.addToAssets"))!;
        await act(async () => { add.click(); add.click(); });
        expect(add.classList.contains("ant-btn-loading")).toBe(true);
        await act(async () => adding.resolve(new Response()));
        expect(add.disabled).toBe(true);
        expect(add.textContent).toBe(i18n.t("common.addedToAssets"));
        await act(async () => add.click());
        expect(useAssetStore.getState().assets).toHaveLength(1);
        expect(uploadCount).toBe(2);
        expect(modelCalls).toBe(1);
    } finally { upload.mockRestore(); }
});

test.each(["network", "local-media", "rejection"])("image history distinguishes %s from a definite failed request", async (failure) => {
    const upload = spyOn(imageStorage, "uploadImage").mockRejectedValue(new Error("local quota reached"));
    let calls = 0;
    axios.defaults.adapter = async (request) => {
        calls += 1;
        expect(newImageLog().imageTaskRecordIds).toHaveLength(1);
        if (failure === "network") throw new axios.AxiosError("response lost", "ERR_NETWORK", request);
        if (failure === "rejection") throw new axios.AxiosError("rejected", "ERR_BAD_REQUEST", request, undefined, { config: request, status: 400, statusText: "Bad Request", headers: {}, data: { error: { message: "rejected" } } });
        return { config: request, status: 200, statusText: "OK", headers: {}, data: { data: [{ b64_json: "aW1hZ2U=" }] } };
    };
    try {
        const router = await renderPage("/image?log=alpha");
        await click("workbench.generate");
        const saved = newImageLog();
        expect(saved).toMatchObject({ status: failure === "rejection" ? "failed" : "attention", failCount: failure === "rejection" ? 1 : 0, recoverableCount: failure === "rejection" ? 0 : 1, requestCount: 1, imageCount: 0 });
        expect(saved.recoverableRecordIds).toEqual(failure === "rejection" ? [] : saved.imageTaskRecordIds);
        await act(async () => router.navigate(`/image?log=${saved.id}`));
        expect(calls).toBe(1);
        if (failure !== "rejection") expect(container!.textContent).toContain(i18n.t("managed.imageTaskUnknown"));
    } finally { upload.mockRestore(); }
});

test("a delayed image intent cannot save the previous account's prompt into the next account", async () => {
    const intent = Promise.withResolvers<void>();
    let paidCalls = 0, intentError: unknown;
    const generation = spyOn(imageApi, "requestGeneration").mockImplementation(async (_config, _prompt, options) => {
        await intent.promise;
        try { await options?.onIntentSaved?.("alice-intent"); }
        catch (error) { intentError = error; throw error; }
        paidCalls += 1;
        return [];
    });
    try {
        await renderPage("/image?log=alpha");
        await click("workbench.generate");
        expect(generation).toHaveBeenCalledTimes(1);
        const transport = globalThis.fetch;
        globalThis.fetch = (async (input, init) => String(input) === "/api/session" ? Response.json({ ...session, user: { id: 2, subject: `ics_${"b".repeat(32)}`, username: "bob" }, session_tag: "bob-session" }) : transport(input, init)) as typeof fetch;
        const bobHistory = { bob: log("bob", "bob's private history") };
        await act(async () => {
            endCanvasSession();
            documents["image-workbench"] = { value: bobHistory, revision: 1 };
            await readCanvasSession();
        });
        const afterSwitch = requests.length;
        await act(async () => intent.resolve());
        expect(intentError).toBeInstanceOf(Error);
        expect((intentError as Error).message).toBe(i18n.t("saveRecovery.sessionChanged"));
        expect(paidCalls).toBe(0);
        expect(documents["image-workbench"].value).toEqual(bobHistory);
        expect(requests.slice(afterSwitch).filter((request) => request.path === "/api/data/image-workbench" && request.method === "PUT")).toEqual([]);
        expect(getDocumentDraft("image-workbench")).toBeUndefined();
    } finally { intent.resolve(); generation.mockRestore(); }
});

test("a partial image result preserves its exact recovery record and reports attention to the agent", async () => {
    const upload = spyOn(imageStorage, "uploadImage").mockImplementation(async () => importedImage("partial"));
    const generation = spyOn(imageApi, "requestGeneration").mockImplementation(async (_config, _prompt, options) => {
        documents["image-tasks"].value = { partial: { id: "partial", task_id: null, status: "partial", value: { batch: { total: 2, completed: 2, failed: 0, unknown: 1 }, result: { data: [{ b64_json: "aW1hZ2U=" }] } } } };
        await options?.onIntentSaved?.("partial");
        options?.onPartial?.({ total: 2, completed: 2, failed: 0, unknown: 1 });
        return [{ id: "image", dataUrl: "data:image/png;base64,aW1hZ2U=" }];
    });
    useWorkbenchAgentStore.setState({ imageCommand: null, tasks: [] });
    try {
        await renderPage("/image?log=alpha");
        let taskId: string | undefined;
        await act(async () => { taskId = useWorkbenchAgentStore.getState().dispatchImage({ prompt: "partial image", run: true }); });
        expect(newImageLog()).toMatchObject({ status: "attention", imageCount: 1, failCount: 0, recoverableCount: 1, imageTaskRecordIds: ["partial"], recoverableRecordIds: ["partial"] });
        expect(useWorkbenchAgentStore.getState().tasks.find((task) => task.id === taskId)?.status).toBe("attention");
        const status = await runSiteTool("generation_get_status", { taskId }, () => {});
        expect(status).toMatchObject({ summary: { running: 0, attention: 1, failed: 0 } });
        expect(generation).toHaveBeenCalledTimes(1);
    } finally { generation.mockRestore(); upload.mockRestore(); }
});

test("advanced image settings are collapsed without hiding the common ratio, resolution and count controls", async () => {
    await renderPage("/image?log=alpha");
    const details = container!.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(i18n.t("settingsPanels.image.quality"));
    expect(details.textContent).toContain(i18n.t("settingsPanels.image.transparent"));
    expect(details.textContent).not.toContain(i18n.t("settingsPanels.image.resolution"));
    expect(details.textContent).not.toContain(i18n.t("settingsPanels.image.aspectRatio"));
    expect(details.textContent).not.toContain(i18n.t("settingsPanels.image.count"));
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
});

test.each(["succeeded", "partial", "deleted"])("explicit result recovery updates only its linked images and preserves %s history semantics", async (state) => {
    const upload = spyOn(imageStorage, "uploadImage").mockImplementation(async () => importedImage("recovered"));
    const media = (id: string, task: string) => ({ id, imageTaskRecordId: task, storageKey: `image:${id}`, dataUrl: "", width: 20, height: 10, bytes: 4, durationMs: 0 });
    documents["image-workbench"].value = { alpha: { ...log("alpha", "recover my result", "attention"), requestCount: 2, recoverableCount: 1, failCount: state === "partial" ? 1 : 0, imageTaskRecordIds: ["sibling", "primary"], recoverableRecordIds: ["primary"], images: [media("sibling-result", "sibling"), media("old-primary", "primary")] } };
    documents["image-tasks"].value = { primary: { id: "primary", task_id: null, status: state === "partial" ? "partial" : "succeeded", value: { ...(state === "partial" ? { batch: { total: 3, completed: 3, failed: 1, unknown: 1 } } : {}), result: { data: [{ b64_json: "aW1hZ2U=" }] } } } };
    try {
        await renderPage("/image?task=primary");
        if (state === "deleted") await act(async () => { await writeDocument("image-workbench", {}); });
        await click("managed.viewResults");
        const records = documents["image-workbench"].value as Record<string, SavedImageLog>;
        if (state === "deleted") expect(Object.keys(records)).toEqual([]);
        else {
            expect(records.alpha.images.map((image) => image.storageKey)).toEqual(["image:sibling-result", "image:recovered"]);
            expect(records.alpha).toMatchObject({ imageCount: 2, status: state === "partial" ? "attention" : "success", recoverableCount: state === "partial" ? 1 : 0, recoverableRecordIds: state === "partial" ? ["primary"] : [], failCount: state === "partial" ? 1 : 0 });
        }
        expect(upload).toHaveBeenCalledTimes(1);
        expect(requests.some((request) => request.path.startsWith("/api/ai/") && request.method === "POST")).toBe(false);
    } finally { upload.mockRestore(); }
});
