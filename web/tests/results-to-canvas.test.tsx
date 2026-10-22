import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { browser } from "./browser";
import i18n from "../src/i18n";
import { ResultToCanvasButton } from "../src/components/result-to-canvas-button";
import { canvasResultFromAsset, placeResultInCanvas, placeResultsInCanvas, resultPlacementUndoNodes, undoResultsInCanvas, type CanvasResult } from "../src/lib/canvas/result-to-canvas";
import { endCanvasSession, readCanvasSession, sessionEpoch } from "../src/services/api/canvas-client";
import { flushCanvasSave, useCanvasStore, type CanvasProject } from "../src/stores/canvas/use-canvas-store";
import type { Asset } from "../src/stores/use-asset-store";

let documents: ReturnType<typeof mockBrowserDocuments>;
let files: ReturnType<typeof mockBrowserFiles>;
const originalFetch = globalThis.fetch;
const session = { user: { id: 1, subject: `ics_${"a".repeat(32)}`, username: "alice" }, csrf_token: "csrf", session_tag: "results-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
const result: CanvasResult = { id: "image-result", kind: "image", title: "测试图片", url: "blob:preview-only", storageKey: "image:original", width: 1600, height: 900, bytes: 1234, mimeType: "image/png" };
let doc: { value: { state: { projects: CanvasProject[]; deletedProjects: [] }; version: number }; revision: number };
let writes: string[];
let respondToSave: ((init: RequestInit) => Promise<Response>) | undefined;

function project(id: string, updatedAt: string): CanvasProject {
    return { id, title: id, createdAt: updatedAt, updatedAt, nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
}
function acceptSave(init: RequestInit) {
    const body = JSON.parse(String(init.body));
    expect(body.revision).toBe(doc.revision);
    doc = { value: body.value, revision: doc.revision + 1 };
    return Response.json(doc);
}

beforeEach(async () => {
    documents = mockBrowserDocuments();
    files = mockBrowserFiles();
    endCanvasSession();
    localStorage.clear();
    writes = [];
    respondToSave = undefined;
    doc = { value: { state: { projects: [project("older", "2026-01-01"), project("recent", "2026-02-01")], deletedProjects: [] }, version: 0 }, revision: 1 };
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/session") return Response.json(session);
        if (path !== "/api/data/canvas") throw new Error(`Unexpected request: ${path}`);
        if (init?.method === "PUT") {
            writes.push(path);
            return respondToSave ? respondToSave(init) : acceptSave(init);
        }
        return Response.json(doc);
    }) as typeof fetch;
    await readCanvasSession();
    await useCanvasStore.persist.rehydrate();
});
afterEach(() => {
    endCanvasSession();
    useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
    documents.restore();
    files.restore();
    globalThis.fetch = originalFetch;
});

async function renderButton(media: CanvasResult | CanvasResult[] = result) {
    const globals = {
        HTMLElement: browser.HTMLElement,
        SVGElement: browser.SVGElement,
        Element: browser.Element,
        ShadowRoot: browser.ShadowRoot,
        getComputedStyle: browser.getComputedStyle.bind(browser),
        IS_REACT_ACT_ENVIRONMENT: true,
        ResizeObserver: class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    };
    const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let changeSelection!: (next: CanvasResult | CanvasResult[]) => void;
    function Selection() {
        const [selected, setSelected] = useState(media);
        changeSelection = setSelected;
        return Array.isArray(selected) ? createElement(ResultToCanvasButton, { results: selected }) : createElement(ResultToCanvasButton, { result: selected });
    }
    const router = createMemoryRouter(
        [
            { path: "/results", element: createElement(Selection) },
            { path: "/canvas/:id", element: createElement("div", null, "canvas") },
        ],
        { initialEntries: ["/results"] },
    );
    await act(async () => root.render(createElement(RouterProvider, { router })));
    return {
        container,
        router,
        select: async (next: CanvasResult | CanvasResult[]) => { await act(async () => changeSelection(next)); },
        button: () => container.querySelector("button")!,
        click: async () => {
            await act(async () => container.querySelector("button")!.click());
        },
        close: async () => {
            await act(async () => root.unmount());
            container.remove();
            for (const [key, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        },
    };
}

test("image and video insertion preserve stored media and proportions without overlapping existing nodes", async () => {
    const first = placeResultInCanvas(result, "older", sessionEpoch());
    const second = placeResultInCanvas({ ...result, id: "video-result", kind: "video", storageKey: "media:original", width: 1920, height: 1080, durationMs: 3000 }, "older", sessionEpoch());
    await flushCanvasSave();
    const saved = doc.value.state.projects.find((item) => item.id === "older")!;
    expect(saved.nodes.map((node) => node.id)).toEqual([first.nodeId, second.nodeId]);
    expect(saved.nodes[0].width / saved.nodes[0].height).toBeCloseTo(16 / 9);
    expect(saved.nodes[1].width / saved.nodes[1].height).toBeCloseTo(16 / 9);
    expect(saved.nodes[1].position.x).toBeGreaterThan(saved.nodes[0].position.x + saved.nodes[0].width);
    expect(saved.nodes[0].metadata).toMatchObject({ storageKey: "image:original", content: "blob:preview-only", naturalWidth: 1600, naturalHeight: 900 });
    expect(saved.nodes[1].metadata).toMatchObject({ storageKey: "media:original", content: "blob:preview-only", durationMs: 3000 });
    expect(writes).toEqual(["/api/data/canvas"]);
});

test("a batch inserts all results in one edit and arranges different proportions without overlap", async () => {
    const prior = placeResultInCanvas(result, "older", sessionEpoch());
    const results = [result, { ...result, id: "portrait", width: 900, height: 1600 }, { ...result, id: "square", width: 800, height: 800 }, { ...result, id: "video", kind: "video" as const, storageKey: "media:batch", width: 1920, height: 1080 }, { ...result, id: "small", width: 200, height: 100 }];
    let edits = 0;
    const unsubscribe = useCanvasStore.subscribe((next, previous) => { if (next.projects !== previous.projects) edits += 1; });
    const placement = placeResultsInCanvas(results, "older", sessionEpoch());
    unsubscribe();
    expect(edits).toBe(1);
    expect(placement.nodeId).toBe(placement.nodeIds[0]);
    expect(placement.nodeIds).toHaveLength(results.length);
    await flushCanvasSave();
    const nodes = doc.value.state.projects.find((item) => item.id === "older")!.nodes;
    expect(nodes.map((node) => node.id)).toEqual([prior.nodeId, ...placement.nodeIds]);
    const inserted = nodes.slice(1);
    expect(new Set(inserted.map((node) => node.position.y)).size).toBe(2);
    for (let index = 0; index < inserted.length; index += 1) {
        const node = inserted[index];
        expect(node.width / node.height).toBeCloseTo(results[index].width / results[index].height);
        expect(node.metadata?.storageKey).toBe(results[index].storageKey);
        expect(node.position.x).toBeGreaterThan(nodes[0].position.x + nodes[0].width);
    }
    for (let left = 0; left < inserted.length; left += 1) {
        for (let right = left + 1; right < inserted.length; right += 1) {
            const a = inserted[left], b = inserted[right];
            expect(a.position.x + a.width <= b.position.x || b.position.x + b.width <= a.position.x || a.position.y + a.height <= b.position.y || b.position.y + b.height <= a.position.y).toBe(true);
        }
    }
    expect(writes).toEqual(["/api/data/canvas"]);
});

test("mixed assets keep original media and text content through insertion and batch undo without uploads", async () => {
    const base = { coverUrl: "", tags: ["saved"], source: "test", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const assets: Asset[] = [
        { ...base, id: "asset-text", kind: "text", title: "saved note", data: { content: "  第一行\n第二行 **原始文本**  " } },
        { ...base, id: "asset-image", kind: "image", title: "saved image", data: { dataUrl: "blob:image-preview", storageKey: "image:saved", width: 1600, height: 900, bytes: 1234, mimeType: "image/webp" } },
        { ...base, id: "asset-video", kind: "video", title: "saved video", data: { url: "blob:video-preview", storageKey: "media:saved", width: 1080, height: 1920, bytes: 5678, mimeType: "video/webm" } },
    ];
    const originals = structuredClone(assets);
    const mapped = assets.map(canvasResultFromAsset);
    expect(mapped).toEqual([
        { id: "asset-text", kind: "text", title: "saved note", content: "  第一行\n第二行 **原始文本**  " },
        { id: "asset-image", kind: "image", title: "saved image", url: "blob:image-preview", storageKey: "image:saved", width: 1600, height: 900, bytes: 1234, mimeType: "image/webp" },
        { id: "asset-video", kind: "video", title: "saved video", url: "blob:video-preview", storageKey: "media:saved", width: 1080, height: 1920, bytes: 5678, mimeType: "video/webm" },
    ]);
    const retained = placeResultInCanvas(result, "older", sessionEpoch());
    const placement = placeResultsInCanvas(mapped, "older", sessionEpoch());
    await flushCanvasSave();
    const nodes = doc.value.state.projects.find((item) => item.id === "older")!.nodes.slice(1);
    expect(nodes.map((node) => node.type)).toEqual(["text", "image", "video"]);
    expect(nodes[0]).toMatchObject({ title: "saved note", width: 340, height: 240, metadata: { content: "  第一行\n第二行 **原始文本**  ", fontSize: 14, status: "success" } });
    expect(nodes[0].metadata?.storageKey).toBeUndefined();
    expect(nodes[1].metadata).toMatchObject({ content: "blob:image-preview", storageKey: "image:saved", naturalWidth: 1600, naturalHeight: 900, bytes: 1234, mimeType: "image/webp" });
    expect(nodes[2].metadata).toMatchObject({ content: "blob:video-preview", storageKey: "media:saved", naturalWidth: 1080, naturalHeight: 1920, bytes: 5678, mimeType: "video/webm" });
    expect(nodes[1].width / nodes[1].height).toBeCloseTo(16 / 9);
    expect(nodes[2].width / nodes[2].height).toBeCloseTo(9 / 16);
    expect(nodes[1].position.x).toBeGreaterThan(nodes[0].position.x + nodes[0].width);
    expect(nodes[2].position.y).toBeGreaterThan(Math.max(nodes[0].position.y + nodes[0].height, nodes[1].position.y + nodes[1].height));
    expect(undoResultsInCanvas(placement, sessionEpoch())).toEqual(placement.nodeIds);
    await flushCanvasSave();
    expect(doc.value.state.projects.find((item) => item.id === "older")!.nodes.map((node) => node.id)).toEqual([retained.nodeId]);
    expect(assets).toEqual(originals);
    // The fixture rejects every file/model endpoint, so both saves use only the canvas document.
    expect(writes).toEqual(["/api/data/canvas", "/api/data/canvas"]);
});

test("editing inserted text prevents batch undo from deleting the note or its companion image", () => {
    const placement = placeResultsInCanvas([{ id: "text-result", kind: "text", title: "note", content: "original" }, result], "older", sessionEpoch());
    const store = useCanvasStore.getState();
    const project = store.openProject("older")!;
    store.updateProject("older", { nodes: project.nodes.map((node) => node.id === placement.nodeId ? { ...node, metadata: { ...node.metadata, content: "edited after insertion" } } : node) });
    expect(() => undoResultsInCanvas(placement, sessionEpoch())).toThrow();
    expect(store.openProject("older")?.nodes.map((node) => node.id)).toEqual(placement.nodeIds);
    expect(store.openProject("older")?.nodes[0].metadata?.content).toBe("edited after insertion");
});

test("changing a text asset's content with the same ID inserts its new content and preserves the earlier note", async () => {
    const first: CanvasResult = { id: "saved-text", kind: "text", title: "note", content: "first content" };
    const view = await renderButton(first);
    try {
        await view.click();
        await view.select({ ...first, content: "updated content" });
        expect(view.button().textContent).toBe(i18n.t("resultToCanvas.insert"));
        await view.click();
        expect(doc.value.state.projects.find((item) => item.id === "recent")!.nodes.map((node) => node.metadata?.content)).toEqual(["first content", "updated content"]);
        expect(view.router.state.location.pathname).toBe("/results");
    } finally {
        await view.close();
    }
});

test.each(["title", "dimensions"])("changing a saved media asset's %s creates its revised node instead of opening the old result", async (field) => {
    const view = await renderButton(result);
    try {
        await view.click();
        const updated = field === "title" ? { ...result, title: "renamed asset" } : { ...result, width: 900, height: 1600 };
        await view.select(updated);
        expect(view.button().textContent).toBe(i18n.t("resultToCanvas.insert"));
        await view.click();
        const nodes = doc.value.state.projects.find((item) => item.id === "recent")!.nodes;
        expect(nodes).toHaveLength(2);
        expect(nodes[0]).toMatchObject({ title: result.title, metadata: { naturalWidth: result.width, naturalHeight: result.height } });
        expect(nodes[1]).toMatchObject({ title: updated.title, metadata: { naturalWidth: updated.width, naturalHeight: updated.height } });
        expect(view.router.state.location.pathname).toBe("/results");
    } finally {
        await view.close();
    }
});

test("undoing a batch keeps unrelated edits and repeating undo does not change the canvas", async () => {
    const placement = placeResultsInCanvas([result, { ...result, id: "second" }], "older", sessionEpoch());
    const other = placeResultInCanvas({ ...result, id: "later-result" }, "older", sessionEpoch());
    const store = useCanvasStore.getState();
    store.renameProject("older", "renamed after insertion");
    store.updateProject("older", { viewport: { x: 100, y: 200, k: 2 } });
    const before = store.openProject("older")!;
    expect(resultPlacementUndoNodes(before, placement).map((node) => node.id)).toEqual([other.nodeId]);
    expect(store.openProject("older")).toBe(before);
    expect(undoResultsInCanvas(placement, sessionEpoch())).toEqual(placement.nodeIds);
    const after = store.openProject("older")!;
    expect(after.nodes.map((node) => node.id)).toEqual([other.nodeId]);
    expect(after.title).toBe("renamed after insertion");
    expect(after.viewport).toEqual({ x: 100, y: 200, k: 2 });
    expect(undoResultsInCanvas(placement, sessionEpoch())).toEqual([]);
    expect(store.openProject("older")).toBe(after);
    await flushCanvasSave();
    expect(doc.value.state.projects.find((item) => item.id === "older")?.nodes.map((node) => node.id)).toEqual([other.nodeId]);
    expect(writes).toEqual(["/api/data/canvas"]);
});

test.each(["node edit", "connection", "prompt reference", "group reference"])("batch undo preserves subsequent %s instead of silently deleting it", (change) => {
    const placement = placeResultsInCanvas([result, { ...result, id: "second" }], "older", sessionEpoch());
    const other = placeResultInCanvas({ ...result, id: "later-result" }, "older", sessionEpoch());
    const store = useCanvasStore.getState();
    const current = store.openProject("older")!;
    if (change === "connection") {
        store.updateProject("older", { connections: [{ id: "later-connection", fromNodeId: placement.nodeId, toNodeId: other.nodeId }] });
    } else {
        store.updateProject("older", { nodes: current.nodes.map((node) => {
            if (change === "node edit" && node.id === placement.nodeId) return { ...node, position: { ...node.position, x: node.position.x + 10 } };
            if (node.id !== other.nodeId) return node;
            return { ...node, metadata: { ...node.metadata, ...(change === "prompt reference" ? { composerContent: `Use @[node:${placement.nodeId}]` } : change === "group reference" ? { groupId: placement.nodeId } : {}) } };
        }) });
    }
    const edited = store.openProject("older");
    expect(() => undoResultsInCanvas(placement, sessionEpoch())).toThrow();
    expect(store.openProject("older")).toBe(edited);
    expect(edited?.nodes).toHaveLength(3);
});

test("empty selections and receipts from an old session cannot mutate canvases", async () => {
    const projects = useCanvasStore.getState().projects;
    expect(() => placeResultsInCanvas([], undefined, sessionEpoch())).toThrow();
    expect(useCanvasStore.getState().projects).toBe(projects);
    const epoch = sessionEpoch();
    const placement = placeResultsInCanvas([result, { ...result, id: "second" }], undefined, epoch);
    const created = useCanvasStore.getState().openProject(placement.projectId);
    expect(created?.nodes).toHaveLength(2);
    expect(undoResultsInCanvas(placement, epoch)).toEqual(placement.nodeIds);
    expect(useCanvasStore.getState().openProject(placement.projectId)?.nodes).toEqual([]);
    endCanvasSession();
    await readCanvasSession();
    await useCanvasStore.persist.rehydrate();
    const current = useCanvasStore.getState().projects;
    expect(() => placeResultsInCanvas([result], "older", epoch)).toThrow();
    expect(() => undoResultsInCanvas(placement, sessionEpoch())).toThrow();
    expect(useCanvasStore.getState().projects).toBe(current);
    expect(writes).toHaveLength(0);
});

test("the result action selects the latest canvas, deduplicates clicks, and opens its node only after save confirmation", async () => {
    let finish!: (response: Response) => void;
    let request!: RequestInit;
    respondToSave = async (init) => {
        request = init;
        return new Promise<Response>((resolve) => {
            finish = resolve;
        });
    };
    const view = await renderButton();
    try {
        await view.click();
        await view.click();
        expect(writes).toHaveLength(1);
        expect(view.container.textContent).not.toContain(i18n.t("resultToCanvas.open"));
        expect(doc.value.state.projects.every((item) => item.nodes.length === 0)).toBe(true);
        expect(useCanvasStore.getState().openProject("recent")?.nodes).toHaveLength(1);
        expect(useCanvasStore.getState().openProject("older")?.nodes).toHaveLength(0);
        await act(async () => finish(acceptSave(request)));
        expect(view.container.textContent).toContain(i18n.t("resultToCanvas.open"));
        const node = doc.value.state.projects.find((item) => item.id === "recent")!.nodes[0];
        await view.click();
        expect(view.router.state.location.pathname).toBe("/canvas/recent");
        expect(new URLSearchParams(view.router.state.location.search).get("focusNode")).toBe(node.id);
    } finally {
        await view.close();
    }
});

test("failed insertion save keeps the draft and retries the same node without uploading or regenerating", async () => {
    respondToSave = async () => Response.json({ error: { message: "Temporary storage outage" } }, { status: 503 });
    const view = await renderButton();
    try {
        await view.click();
        const nodeId = useCanvasStore.getState().openProject("recent")!.nodes[0].id;
        expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Temporary storage outage");
        expect(view.container.textContent).toContain(i18n.t("resultToCanvas.retrySave"));
        expect(doc.value.state.projects.every((item) => item.nodes.length === 0)).toBe(true);
        respondToSave = undefined;
        await view.click();
        const saved = doc.value.state.projects.find((item) => item.id === "recent")!;
        expect(saved.nodes.map((node) => node.id)).toEqual([nodeId]);
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
        expect(writes).toHaveLength(2);
    } finally {
        await view.close();
    }
});

test("the target menu inserts into a chosen existing canvas or a new canvas", async () => {
    const view = await renderButton();
    try {
        for (const label of ["older", i18n.t("resultToCanvas.newCanvas")]) {
            await act(async () => view.container.querySelector<HTMLButtonElement>("button[aria-label]")!.click());
            const option = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === label);
            expect(option).toBeDefined();
            await act(async () => option!.click());
        }
        expect(doc.value.state.projects).toHaveLength(3);
        expect(doc.value.state.projects.find((item) => item.id === "older")?.nodes).toHaveLength(1);
        expect(doc.value.state.projects.find((item) => item.id === "recent")?.nodes).toHaveLength(0);
        expect(doc.value.state.projects.find((item) => !["older", "recent"].includes(item.id))?.nodes).toHaveLength(1);
    } finally {
        await view.close();
    }
});

test("an empty library creates one canvas and session changes cannot insert an old result", async () => {
    doc.value.state.projects = [];
    endCanvasSession();
    await readCanvasSession();
    await useCanvasStore.persist.rehydrate();
    const epoch = sessionEpoch();
    const view = await renderButton({ ...result, kind: "video", storageKey: "media:result" });
    try {
        await view.click();
        expect(doc.value.state.projects).toHaveLength(1);
        expect(doc.value.state.projects[0].nodes).toHaveLength(1);
        await act(async () => endCanvasSession());
        expect(view.button().disabled).toBe(true);
        await readCanvasSession();
        expect(() => placeResultInCanvas(result, undefined, epoch)).toThrow();
        expect(writes).toHaveLength(1);
    } finally {
        await view.close();
    }
});

async function clickAction(view: Awaited<ReturnType<typeof renderButton>>, key: string) {
    const button = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === i18n.t(key));
    expect(button).toBeDefined();
    await act(async () => button!.click());
}

test("batch insertion saves once and opens every selected node", async () => {
    const view = await renderButton([result, { ...result, id: "second", storageKey: "image:second", width: 900, height: 1600 }]);
    try {
        await view.click();
        const nodes = doc.value.state.projects.find((item) => item.id === "recent")!.nodes;
        expect(nodes).toHaveLength(2);
        expect(writes).toHaveLength(1);
        await view.click();
        expect(new URLSearchParams(view.router.state.location.search).getAll("focusNode")).toEqual(nodes.map((node) => node.id));
        expect(writes).toHaveLength(1);
    } finally { await view.close(); }
});

test("changing selection after a failed batch retries the original nodes before accepting another batch", async () => {
    respondToSave = async () => Response.json({ error: { message: "offline" } }, { status: 503 });
    const view = await renderButton([result, { ...result, id: "second", storageKey: "image:second" }]);
    try {
        await view.click();
        const ids = useCanvasStore.getState().openProject("recent")!.nodes.map((node) => node.id);
        await view.select([{ ...result, id: "third", storageKey: "image:third" }]);
        expect(view.button().textContent).toBe(i18n.t("resultToCanvas.retrySave"));
        expect(view.container.textContent).toContain(i18n.t("resultToCanvas.pendingBatch", { count: 2 }));
        respondToSave = undefined;
        await view.click();
        expect(doc.value.state.projects.find((item) => item.id === "recent")!.nodes.map((node) => node.id)).toEqual(ids);
        expect(view.button().textContent).toBe(i18n.t("resultToCanvas.insertBatch", { count: 1 }));
        await view.click();
        expect(doc.value.state.projects.find((item) => item.id === "recent")!.nodes.map((node) => node.metadata?.storageKey)).toEqual(["image:original", "image:second", "image:third"]);
        expect(writes).toHaveLength(3);
    } finally { await view.close(); }
});

test("an undo save failure retains a recoverable receipt and confirms success only after retry", async () => {
    const view = await renderButton([result, { ...result, id: "second", storageKey: "image:second" }]);
    try {
        await view.click();
        respondToSave = async () => Response.json({ error: { message: "undo offline" } }, { status: 503 });
        await clickAction(view, "resultToCanvas.undo");
        expect(useCanvasStore.getState().openProject("recent")!.nodes).toHaveLength(0);
        expect(doc.value.state.projects.find((item) => item.id === "recent")!.nodes).toHaveLength(2);
        expect(view.container.textContent).not.toContain(i18n.t("resultToCanvas.undone"));
        expect(view.container.textContent).toContain(i18n.t("resultToCanvas.openDraft"));
        expect(view.container.textContent).toContain(i18n.t("resultToCanvas.undoDraftKept"));
        respondToSave = undefined;
        await view.click();
        expect(doc.value.state.projects.find((item) => item.id === "recent")!.nodes).toHaveLength(0);
        expect(view.container.textContent).toContain(i18n.t("resultToCanvas.undone"));
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
        expect(writes).toHaveLength(3);
    } finally { await view.close(); }
});

test("undo refuses changed nodes and keeps an open-canvas action available", async () => {
    const view = await renderButton(result);
    try {
        await view.click();
        const canvas = useCanvasStore.getState().openProject("recent")!;
        await act(async () => useCanvasStore.getState().updateProject(canvas.id, { nodes: canvas.nodes.map((node) => ({ ...node, title: "edited afterward" })) }));
        await clickAction(view, "resultToCanvas.undo");
        expect(view.container.textContent).toContain(i18n.t("resultToCanvas.undoChanged"));
        expect(view.button().textContent).toBe(i18n.t("resultToCanvas.open"));
        expect(useCanvasStore.getState().openProject("recent")!.nodes[0].title).toBe("edited afterward");
        expect(writes).toHaveLength(1);
    } finally { await view.close(); }
});

test("an undo retry cannot report success if recovery restored the original nodes", async () => {
    const view = await renderButton(result);
    try {
        await view.click();
        const restoredNodes = doc.value.state.projects.find((item) => item.id === "recent")!.nodes;
        respondToSave = async () => Response.json({ error: { message: "offline" } }, { status: 503 });
        await clickAction(view, "resultToCanvas.undo");
        await act(async () => useCanvasStore.getState().updateProject("recent", { nodes: restoredNodes }));
        respondToSave = undefined;
        await view.click();
        expect(view.container.textContent).toContain(i18n.t("resultToCanvas.undoChanged"));
        expect(view.container.textContent).not.toContain(i18n.t("resultToCanvas.undone"));
        expect(useCanvasStore.getState().openProject("recent")!.nodes).toEqual(restoredNodes);
        expect(writes).toHaveLength(2);
    } finally { await view.close(); }
});
