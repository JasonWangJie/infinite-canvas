import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { browser } from "./browser";
import i18n from "../src/i18n";
import { endCanvasSession, readCanvasSession, sessionEpoch } from "../src/services/api/canvas-client";
import { placeResultsInCanvas, type CanvasResultPlacement } from "../src/lib/canvas/result-to-canvas";
import { handoffResultPlacement } from "../src/stores/canvas/use-result-placement-handoff-store";
import { flushCanvasSave, useCanvasStore, type CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { useAssetStore, type Asset } from "../src/stores/use-asset-store";
import { CANVAS_ASSET_DRAG_TYPE, startCanvasAssetDrag } from "../src/stores/canvas/use-canvas-asset-drag-store";
import * as pluginLoader from "../src/lib/canvas/plugin-loader";
import * as imageStorage from "../src/services/image-storage";
import * as fileStorage from "../src/services/file-storage";

let documents: ReturnType<typeof mockBrowserDocuments>;
let files: ReturnType<typeof mockBrowserFiles>;
const originalFetch = globalThis.fetch;
const originalMatchMedia = browser.matchMedia;
let previous: Map<string, PropertyDescriptor | undefined>;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let pluginSpy: ReturnType<typeof spyOn<typeof pluginLoader, "ensurePluginsLoaded">>;
let imageSpy: ReturnType<typeof spyOn<typeof imageStorage, "resolveImageUrl">> | undefined;
let boundsSpy: ReturnType<typeof spyOn<typeof browser.HTMLElement.prototype, "getBoundingClientRect">>;
let doc: { value: unknown; revision: number };
let requests: string[];

function project(): CanvasProject {
    return { id: "canvas", title: "Existing canvas", createdAt: "2026-01-01", updatedAt: "2026-01-01", nodes: [{ id: "existing", type: "text", title: "Keep me", position: { x: -400, y: 0 }, width: 300, height: 200, metadata: { content: "original text" } }], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
}

beforeEach(async () => {
    documents = mockBrowserDocuments();
    files = mockBrowserFiles();
    endCanvasSession();
    jest.useFakeTimers();
    const globals = {
        __APP_VERSION__: "test", __APP_RELEASES__: [], IS_REACT_ACT_ENVIRONMENT: true,
        ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => {},
    };
    const browserGlobals = ["Element", "HTMLElement", "HTMLAnchorElement", "HTMLImageElement", "HTMLVideoElement", "MouseEvent", "XMLHttpRequest", "SVGElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "ShadowRoot", "MutationObserver", "Node", "navigator", "getComputedStyle"];
    previous = new Map();
    for (const [key, value] of [...Object.entries(globals), ...browserGlobals.map((key) => [key, Reflect.get(browser, key)] as const)]) {
        previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    browser.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, media: "", onchange: null });
    pluginSpy = spyOn(pluginLoader, "ensurePluginsLoaded").mockResolvedValue();
    boundsSpy = spyOn(browser.HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 720, width: 1200, height: 720, toJSON() {} });
    doc = { value: { state: { projects: [project()], deletedProjects: [] }, version: 0 }, revision: 1 };
    requests = [];
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        requests.push(`${init?.method || "GET"} ${path}`);
        if (path === "/api/session") return Response.json({ user: { id: "batch-user", subject: `ics_${"a".repeat(32)}`, username: "batch" }, csrf_token: "csrf", session_tag: "batch-session", expires_at: Math.floor(Date.now() / 1000) + 3600 });
        if (path.startsWith("/api/files/")) return new Response("missing preview", { status: 404 });
        if (path !== "/api/data/canvas") throw new Error(`Unexpected request: ${path}`);
        if (init?.method === "PUT") {
            const body = JSON.parse(String(init.body));
            doc = { value: body.value, revision: body.revision + 1 };
        }
        return Response.json(doc);
    }) as typeof fetch;
    await readCanvasSession();
    await useCanvasStore.persist.rehydrate();
});

afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    pluginSpy.mockRestore();
    boundsSpy.mockRestore();
    imageSpy?.mockRestore();
    imageSpy = undefined;
    endCanvasSession();
    useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
    jest.clearAllTimers();
    jest.useRealTimers();
    documents.restore();
    files.restore();
    globalThis.fetch = originalFetch;
    browser.matchMedia = originalMatchMedia;
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function insertBatch() {
    const receipt = placeResultsInCanvas([
        { id: "first", kind: "image", title: "First image", url: "/api/files/image%3Afirst", storageKey: "image:first", width: 600, height: 400, bytes: 100 },
        { id: "second", kind: "video", title: "Second video", url: "/api/files/media%3Asecond", storageKey: "media:second", width: 400, height: 600, bytes: 200 },
        { id: "third", kind: "text", title: "Saved prompt", content: "A saved prompt\nwith two lines" },
    ], "canvas", sessionEpoch());
    handoffResultPlacement(receipt);
    return receipt;
}

async function renderCanvas(receipt?: CanvasResultPlacement, strict = false) {
    const { App, ConfigProvider } = await import("antd");
    const { default: CanvasPage } = await import("../src/pages/canvas/project");
    const params = new URLSearchParams();
    receipt?.nodeIds.forEach((id) => params.append("focusNode", id));
    if (receipt) params.append("focusNode", "missing");
    const router = createMemoryRouter([{ path: "/canvas/:id", element: <ConfigProvider theme={{ token: { motion: false } }}><App><CanvasPage /></App></ConfigProvider> }], { initialEntries: [`/canvas/canvas?${params}`] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(strict ? <StrictMode><RouterProvider router={router} /></StrictMode> : <RouterProvider router={router} />));
    return router;
}

async function shortcut(key: string, shiftKey = false) {
    await act(async () => { window.dispatchEvent(new browser.KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey, bubbles: true })); });
    await act(async () => jest.advanceTimersByTime(0));
}

function draggedAsset(kind: Asset["kind"]): Asset {
    const base = { id: "drag-source", title: "Reusable asset", coverUrl: "", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    if (kind === "text") return { ...base, kind, data: { content: "Original prompt" } };
    const data = { width: 1600, height: 900, bytes: 123, storageKey: `${kind === "image" ? "image" : "media"}:original`, mimeType: kind === "image" ? "image/png" : "video/mp4" };
    return kind === "image" ? { ...base, kind, data: { ...data, dataUrl: "" } } : { ...base, kind, data: { ...data, url: "" } };
}

async function dropAsset(token: string, target?: Element, clientX = 620, clientY = 400) {
    const canvas = container!.querySelector(".origin-top-left")!.parentElement!;
    const event = new browser.MouseEvent("drop", { bubbles: true, cancelable: true, clientX: Number.isFinite(clientX) ? clientX : 0, clientY });
    if (!Number.isFinite(clientX)) Object.defineProperty(event, "clientX", { value: clientX });
    Object.defineProperty(event, "dataTransfer", { value: { types: [CANVAS_ASSET_DRAG_TYPE], getData: () => token, files: [] } });
    await act(async () => { (target || canvas).dispatchEvent(event); });
}

test.each(["text", "image", "video"] as const)("a dragged %s asset lands at the pointer after pan and zoom and supports undo without copying media", async (kind) => {
    const asset = draggedAsset(kind);
    useAssetStore.setState({ assets: [asset], hydrated: true });
    useCanvasStore.getState().updateProject("canvas", { viewport: { x: 35, y: -20, k: 2 } });
    boundsSpy.mockReturnValue({ x: 120, y: 80, left: 120, top: 80, right: 1320, bottom: 800, width: 1200, height: 720, toJSON() {} });
    await renderCanvas(undefined, true);
    const token = startCanvasAssetDrag(asset.id)!;
    expect(token).toBeString();
    await dropAsset(token);
    const nodes = useCanvasStore.getState().openProject("canvas")!.nodes;
    expect(nodes).toHaveLength(2);
    const placed = nodes[1];
    expect(placed.type).toBe(kind);
    expect(placed.position.x + placed.width / 2).toBe(232.5);
    expect(placed.position.y + placed.height / 2).toBe(170);
    expect(container!.querySelector(`[data-node-id="${placed.id}"]`)?.classList.contains("z-50")).toBe(true);
    if (kind === "text") expect(placed.metadata?.content).toBe("Original prompt");
    else {
        const storageKey = `${kind === "image" ? "image" : "media"}:original`;
        expect(placed.width / placed.height).toBeCloseTo(1600 / 900);
        expect(placed.metadata).toMatchObject({ storageKey, naturalWidth: 1600, naturalHeight: 900, bytes: 123 });
        expect(placed.metadata?.content).toBe(`/api/files/${encodeURIComponent(storageKey)}`);
    }
    await dropAsset(token);
    expect(useCanvasStore.getState().openProject("canvas")!.nodes).toHaveLength(2);
    await shortcut("z");
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.map((node) => node.id)).toEqual(["existing"]);
    await shortcut("z", true);
    expect(useCanvasStore.getState().openProject("canvas")!.nodes).toEqual(nodes);
    await act(async () => { await flushCanvasSave(); });
    expect((doc.value as { state: { projects: CanvasProject[] } }).state.projects[0].nodes).toEqual(nodes);
    expect(useAssetStore.getState().assets).toEqual([asset]);
    expect(requests.some((request) => request === "POST /api/files" || request.includes("/api/ai/"))).toBe(false);
});

test("asset drops reject removed or stale sources and editable targets, and resolve the latest asset content", async () => {
    const asset = draggedAsset("text");
    useAssetStore.setState({ assets: [asset], hydrated: true });
    await renderCanvas();
    await dropAsset("external-payload");
    const removed = startCanvasAssetDrag(asset.id)!;
    await act(async () => useAssetStore.setState({ assets: [] }));
    await dropAsset(removed);
    await act(async () => useAssetStore.setState({ assets: [asset] }));
    const invalid = startCanvasAssetDrag(asset.id)!;
    await dropAsset(invalid, undefined, NaN);
    const editing = document.createElement("textarea");
    container!.querySelector(".origin-top-left")!.append(editing);
    await dropAsset(startCanvasAssetDrag(asset.id)!, editing);
    editing.remove();
    expect(useCanvasStore.getState().openProject("canvas")!.nodes).toHaveLength(1);
    const latest = startCanvasAssetDrag(asset.id)!;
    const updated = { ...asset, kind: "text" as const, data: { content: "Edited during drag" } };
    await act(async () => useAssetStore.setState({ assets: [updated] }));
    await dropAsset(latest);
    const added = useCanvasStore.getState().openProject("canvas")!.nodes[1];
    expect(added.metadata?.content).toBe("Edited during drag");
    added.metadata!.content = "Independent node edit";
    expect(useAssetStore.getState().assets[0].data).toEqual({ content: "Edited during drag" });
    const oldSession = startCanvasAssetDrag(asset.id)!;
    await act(async () => { endCanvasSession(); await readCanvasSession(); await useCanvasStore.persist.rehydrate(); useAssetStore.setState({ assets: [updated], hydrated: true }); });
    const beforeDrop = useCanvasStore.getState().openProject("canvas")?.nodes;
    await dropAsset(oldSession);
    expect(useCanvasStore.getState().openProject("canvas")?.nodes).toEqual(beforeDrop);
    expect(requests.some((request) => request === "POST /api/files" || request.includes("/api/ai/"))).toBe(false);
});

test.each(["navigation", "session", "missing"])("a pending media drop cannot add a stale or missing file after %s", async (condition) => {
    const asset = draggedAsset("image");
    useAssetStore.setState({ assets: [asset], hydrated: true });
    const router = await renderCanvas();
    const pending = Promise.withResolvers<string>();
    const resolve = spyOn(fileStorage, "resolveMediaUrl").mockReturnValue(pending.promise);
    try {
        await dropAsset(startCanvasAssetDrag(asset.id)!);
        expect(resolve).toHaveBeenCalledTimes(1);
        if (condition === "navigation") await act(async () => {
            const id = useCanvasStore.getState().createProject("Destination");
            await router.navigate(`/canvas/${id}`);
        });
        if (condition === "session") await act(async () => { endCanvasSession(); await readCanvasSession(); await useCanvasStore.persist.rehydrate(); });
        await act(async () => { pending.resolve(condition === "missing" ? "" : "blob:old-user-image"); });
        expect(useCanvasStore.getState().projects.flatMap((entry) => entry.nodes).some((node) => node.metadata?.storageKey === "image:original")).toBe(false);
        if (condition === "missing") expect(document.body.textContent).toContain(i18n.t("browserStorage.fileMissing"));
        expect(requests.some((request) => request === "POST /api/files" || request.includes("/api/ai/"))).toBe(false);
    } finally {
        resolve.mockRestore();
    }
});

test("opening a batch selects every result and existing undo/redo preserves newer edits", async () => {
    const receipt = insertBatch();
    const router = await renderCanvas(receipt, true);
    expect(router.state.location.search).toBe("");
    for (const id of receipt.nodeIds) expect(container!.querySelector(`[data-node-id="${id}"]`)?.classList.contains("z-50")).toBe(true);
    expect(container!.querySelector('[data-node-id="existing"]')?.classList.contains("z-50")).toBe(false);
    const addText = container!.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("canvas.toolbar.text")}"]`);
    expect(addText).not.toBeNull();
    await act(async () => addText!.click());
    expect(useCanvasStore.getState().openProject("canvas")!.nodes).toHaveLength(5);
    // No debounce time has elapsed: undo must first remove this new text, leaving the inserted batch intact.
    await act(async () => {
        window.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
        window.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    });
    await act(async () => jest.advanceTimersByTime(0));
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.map((node) => node.id)).toEqual(["existing", ...receipt.nodeIds]);
    await shortcut("z");
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.map((node) => node.id)).toEqual(["existing"]);
    await shortcut("z", true);
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.map((node) => node.id)).toEqual(["existing", ...receipt.nodeIds]);
    expect(useCanvasStore.getState().openProject("canvas")!.nodes[0].metadata?.content).toBe("original text");
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.find((node) => node.id === receipt.nodeIds[2])?.metadata?.content).toBe("A saved prompt\nwith two lines");
    await act(async () => addText!.click());
    const newBranchIds = useCanvasStore.getState().openProject("canvas")!.nodes.map((node) => node.id);
    await shortcut("z", true);
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.map((node) => node.id)).toEqual(newBranchIds);
    await shortcut("z");
    await shortcut("z", true);
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.map((node) => node.id)).toEqual(newBranchIds);
    await shortcut("z", true);
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.map((node) => node.id)).toEqual(newBranchIds);
});

test("a changed batch is opened without a destructive insertion undo", async () => {
    const receipt = insertBatch();
    const current = useCanvasStore.getState().openProject("canvas")!;
    useCanvasStore.getState().updateProject("canvas", { nodes: current.nodes.map((node) => node.id === receipt.nodeIds[0] ? { ...node, title: "Edited after insertion" } : node) });
    await renderCanvas(receipt);
    await shortcut("z");
    const nodes = useCanvasStore.getState().openProject("canvas")!.nodes;
    expect(nodes).toHaveLength(4);
    expect(nodes.find((node) => node.id === receipt.nodeIds[0])?.title).toBe("Edited after insertion");
});

test("edits arriving during hydration remain in the canvas and in the batch undo frame", async () => {
    const receipt = insertBatch();
    const resolveImage = imageStorage.resolveImageUrl;
    let finish!: (url: string) => void;
    imageSpy = spyOn(imageStorage, "resolveImageUrl").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockImplementation(resolveImage);
    await renderCanvas(receipt);
    const current = useCanvasStore.getState().openProject("canvas")!;
    const later = { ...project().nodes[0], id: "arrived-later", title: "Newer note" };
    await act(async () => {
        useCanvasStore.getState().updateProject("canvas", { nodes: [...current.nodes, later] });
        finish("/api/files/image%3Afirst");
    });
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.map((node) => node.id)).toEqual(["existing", ...receipt.nodeIds, "arrived-later"]);
    await shortcut("z");
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.map((node) => node.id)).toEqual(["existing", "arrived-later"]);
});

test("session end discards the handoff and stops a late hydration from restoring the prior canvas", async () => {
    const receipt = insertBatch();
    const resolveImage = imageStorage.resolveImageUrl;
    let finish!: (url: string) => void;
    imageSpy = spyOn(imageStorage, "resolveImageUrl").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockImplementation(resolveImage);
    await renderCanvas(receipt);
    await act(async () => {
        endCanvasSession();
        useCanvasStore.setState({ projects: [project()], hydrated: false });
        finish("/api/files/image%3Afirst");
    });
    expect(useCanvasStore.getState().openProject("canvas")!.nodes.map((node) => node.id)).toEqual(["existing"]);
    expect(container!.querySelector(`[data-node-id="${receipt.nodeId}"]`)).toBeNull();
});
