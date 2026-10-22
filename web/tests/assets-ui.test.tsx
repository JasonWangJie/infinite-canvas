import { browser } from "./browser";
import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { zipSync } from "fflate";
import i18n from "@/i18n";
import { endCanvasSession, readCanvasSession, sessionEpoch } from "@/services/api/canvas-client";
import { flushDocument, retryDocument } from "@/services/canvas-data";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetLibraryViewStore } from "@/stores/use-asset-library-view-store";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import * as fileStorage from "@/services/file-storage";

const originalFetch = globalThis.fetch;
const session = { user: { id: 1, subject: `ics_${"a".repeat(32)}`, username: "alice" }, csrf_token: "csrf", session_tag: "assets-ui-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
let documents: Record<string, { value: unknown; revision: number }>;
let requests: { path: string; method: string }[];
let canvasOffline: boolean;
let assetsOffline: boolean;
let reorderAssetsResponse: boolean;
let beforeAssetsSave: (() => Promise<void>) | undefined;
let beforeFileUpload: (() => Promise<void>) | undefined;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let oldMatchMedia: typeof browser.matchMedia;
let localDocuments: ReturnType<typeof mockBrowserDocuments>;
let localFiles: ReturnType<typeof mockBrowserFiles>;

function asset(id: string, kind: Asset["kind"] = "text"): Asset {
    const base = { id, title: id, coverUrl: "", tags: ["library-tag"], source: "source-a", note: "library-note", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    if (kind === "text") return { ...base, kind, data: { content: `text-content-${id}` } };
    const data = { storageKey: `${kind === "image" ? "image" : "media"}:${id}`, width: 1600, height: 900, bytes: 123, mimeType: kind === "image" ? "image/png" : "video/mp4" };
    return kind === "image" ? { ...base, kind, data: { ...data, dataUrl: "" } } : { ...base, kind, data: { ...data, url: "" } };
}

function canvasNodes() {
    return (documents.canvas.value as { state: { projects: CanvasProject[] } }).state.projects[0].nodes;
}

function assetPackage(assets: Asset[], files: { storageKey: string; path: string; mimeType: string; bytes: number }[] = [], contents: Record<string, Uint8Array> = {}) {
    return new File([zipSync({ "assets.json": new TextEncoder().encode(JSON.stringify({ app: "infinite-canvas", version: 1, assets, files })), ...contents })], "library.zip");
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

function importInput() {
    return container!.querySelector<HTMLInputElement>('input[type="file"][accept="application/zip,.zip"]')!;
}

function choosePackage(file: File) {
    const input = importInput();
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new browser.Event("change", { bubbles: true }));
}

async function waitForImportStatus(status: "saved" | "save-error" | "error") {
    const { useAssetImportStore } = await import("@/stores/use-asset-import-store");
    if (useAssetImportStore.getState().status === status) return;
    await new Promise<void>((resolve) => {
        const unsubscribe = useAssetImportStore.subscribe((state) => {
            if (state.status !== status) return;
            unsubscribe();
            resolve();
        });
    });
}

beforeEach(async () => {
    endCanvasSession();
    localDocuments = mockBrowserDocuments();
    localFiles = mockBrowserFiles();
    localStorage.clear();
    useAssetStore.setState({ assets: [], hydrated: false });
    useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
    const assets = [asset("text-a"), asset("image-a", "image"), ...Array.from({ length: 8 }, (_, index) => asset(`text-${index}`)), asset("video-a", "video"), asset("text-last")];
    const project: CanvasProject = { id: "canvas-a", title: "canvas-a", createdAt: "2026-01-01", updatedAt: "2026-01-01", nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
    documents = {
        assets: { value: { state: { assets }, version: 0 }, revision: 1 },
        canvas: { value: { state: { projects: [project], deletedProjects: [] }, version: 0 }, revision: 1 },
    };
    requests = [];
    canvasOffline = false;
    assetsOffline = false;
    reorderAssetsResponse = false;
    beforeAssetsSave = undefined;
    beforeFileUpload = undefined;
    const globals = {
        HTMLAnchorElement: browser.HTMLAnchorElement, MouseEvent: browser.MouseEvent, XMLHttpRequest: browser.XMLHttpRequest, navigator: browser.navigator,
        HTMLElement: browser.HTMLElement, Element: browser.Element, SVGElement: browser.SVGElement, ShadowRoot: browser.ShadowRoot,
        HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement, HTMLSelectElement: browser.HTMLSelectElement,
        FileReader: browser.FileReader,
        DocumentFragment: browser.DocumentFragment, Event: browser.Event, Node: browser.Node, MutationObserver: browser.MutationObserver,
        getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
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
        if (path === "/api/files" && init?.method === "POST") {
            await beforeFileUpload?.();
            return Response.json({ id: "imported-video", storageKey: "media:imported-video", url: "/api/files/media%3Aimported-video", mimeType: "video/mp4", bytes: 4 });
        }
        if (path.startsWith("/api/files/")) return new Response("not needed for selection", { status: 404 });
        if (!path.startsWith("/api/data/")) throw new Error(`Unexpected request ${path}`);
        const domain = decodeURIComponent(path.slice("/api/data/".length));
        if (init?.method === "PUT") {
            if (domain === "canvas" && canvasOffline) return Response.json({ error: { message: "canvas offline" } }, { status: 503 });
            if (domain === "assets") {
                await beforeAssetsSave?.();
                if (assetsOffline) return Response.json({ error: { message: "asset save unavailable" } }, { status: 503 });
            }
            const body = JSON.parse(String(init.body));
            const previous = documents[domain] || { value: null, revision: 0 };
            if (body.revision !== previous.revision) return Response.json({ error: { message: "revision conflict" } }, { status: 409 });
            documents[domain] = { value: body.value, revision: previous.revision + 1 };
            if (domain === "assets" && reorderAssetsResponse) {
                body.value.state.assets = body.value.state.assets.map((item: Asset) => Object.fromEntries(Object.entries(item).reverse()));
            }
        }
        return Response.json(documents[domain] || { value: null, revision: 0 });
    }) as typeof fetch;
    await readCanvasSession();
    await useAssetStore.persist.rehydrate();
    await useCanvasStore.persist.rehydrate();
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
        useAssetStore.setState({ assets: [], hydrated: false });
        useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
        globalThis.fetch = originalFetch;
        browser.matchMedia = oldMatchMedia;
        for (const [key, descriptor] of descriptors || []) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});

async function renderAssets() {
    const { default: AssetsPage } = await import("@/pages/assets");
    const router = createMemoryRouter([{ path: "/assets", element: <ConfigProvider theme={{ token: { motion: false } }}><App message={{ duration: 0 }}><AssetsPage /></App></ConfigProvider> }, { path: "/canvas/:id", element: <div>canvas</div> }], { initialEntries: ["/assets"] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    return router;
}

async function clickText(text: string, within: ParentNode = container!) {
    const button = [...within.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.replace(/\s/g, "") === text.replace(/\s/g, ""));
    expect(button).toBeDefined();
    await act(async () => button!.click());
}

async function editField(name: string, value: string) {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[role="dialog"] [id="${name}"]`)!;
    expect(input).not.toBeNull();
    await act(async () => {
        const prototype = input.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
}

function assetCheckbox(title: string) {
    const input = [...container!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((item) => item.getAttribute("aria-label") === i18n.t("assets.selectAsset", { title }));
    expect(input).toBeDefined();
    return input!;
}

async function selectAsset(title: string) {
    await act(async () => assetCheckbox(title).click());
}

async function changePage(page: number) {
    const item = container!.querySelector<HTMLElement>(`.ant-pagination-item[title="${page}"]`);
    expect(item).not.toBeNull();
    await act(async () => item!.click());
}

async function changeKind(kind: Asset["kind"] | "all") {
    const label = i18n.t(kind === "all" ? "common.all" : `assets.kinds.${kind}`);
    const tag = [...container!.querySelectorAll<HTMLElement>(".ant-tag-checkable")].find((item) => item.textContent === label);
    expect(tag).toBeDefined();
    await act(async () => tag!.click());
}

function expectSelected(count: number) {
    expect(container!.textContent).toContain(i18n.t("assets.selectedCount", { count }));
}

test("assets selected across pages insert mixed text, image and video without uploading", async () => {
    await renderAssets();
    await selectAsset("text-a");
    await selectAsset("image-a");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await changePage(2);
    await selectAsset("video-a");
    expectSelected(3);
    await clickText(i18n.t("resultToCanvas.insertBatch", { count: 3 }));
    expect(canvasNodes().map((node) => node.type)).toEqual(["text", "image", "video"]);
    expect(canvasNodes()[0].metadata?.content).toBe("text-content-text-a");
    expect(canvasNodes()[1].metadata?.storageKey).toBe("image:image-a");
    expect(canvasNodes()[2].metadata?.storageKey).toBe("media:video-a");
    expect(requests.filter((request) => request.method === "POST" || request.method === "DELETE")).toEqual([]);
});

test("selecting and inverting the current page preserve selections on other pages", async () => {
    await renderAssets();
    await act(async () => container!.querySelector<HTMLInputElement>('input[type="checkbox"]:not([aria-label])')!.click());
    expectSelected(10);
    await changePage(2);
    await act(async () => container!.querySelector<HTMLInputElement>('input[type="checkbox"]:not([aria-label])')!.click());
    expectSelected(12);
    await clickText(i18n.t("assets.invertPage"));
    expectSelected(10);
    await changePage(1);
    expect(assetCheckbox("text-a").checked).toBe(true);
    await clickText(i18n.t("resultToCanvas.clearSelection"));
    expectSelected(0);
    expect(assetCheckbox("text-a").checked).toBe(false);
});

test("kind and search changes clear selection before adding newly filtered assets", async () => {
    await renderAssets();
    await selectAsset("text-a");
    await changeKind("image");
    expectSelected(0);
    await selectAsset("image-a");
    await changeKind("all");
    expectSelected(0);
    await selectAsset("text-a");
    const search = container!.querySelector<HTMLInputElement>(`input[placeholder="${i18n.t("assets.search")}"]`)!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(search, "library-note");
        search.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    expectSelected(0);
    expect(assetCheckbox("text-a").checked).toBe(false);
});

test("deleting a selected asset excludes it from the next insertion", async () => {
    await renderAssets();
    await selectAsset("text-a");
    await selectAsset("image-a");
    await clickText(i18n.t("common.delete"), assetCheckbox("image-a").closest(".ant-card")!);
    await clickText(i18n.t("common.delete"), document.querySelector('[role="dialog"]')!);
    expectSelected(1);
    await clickText(i18n.t("resultToCanvas.insertBatch", { count: 1 }));
    expect(canvasNodes().map((node) => node.type)).toEqual(["text"]);
});

test("filter changes retain a failed receipt and retry only its original batch", async () => {
    await renderAssets();
    await selectAsset("text-a");
    canvasOffline = true;
    await clickText(i18n.t("resultToCanvas.insertBatch", { count: 1 }));
    const originalNode = useCanvasStore.getState().openProject("canvas-a")!.nodes[0].id;
    expect(container!.textContent).toContain("canvas offline");
    await changeKind("image");
    await selectAsset("image-a");
    expectSelected(1);
    expect(container!.textContent).toContain(i18n.t("resultToCanvas.retrySave"));
    canvasOffline = false;
    await clickText(i18n.t("resultToCanvas.retrySave"));
    expect(canvasNodes().map((node) => node.id)).toEqual([originalNode]);
    expect(canvasNodes()[0].type).toBe("text");
    await clickText(i18n.t("resultToCanvas.insertBatch", { count: 1 }));
    expect(canvasNodes().map((node) => node.type)).toEqual(["text", "image"]);
});

test("package import keeps progress across navigation and confirms success only after saving", async () => {
    const file = assetPackage([asset("imported-text")]);
    const bytes = await file.arrayBuffer();
    const read = deferred();
    const save = deferred();
    const savingStarted = deferred();
    let readCount = 0;
    Object.defineProperty(file, "arrayBuffer", { value: async () => {
        readCount += 1;
        await read.promise;
        return bytes;
    } });
    beforeAssetsSave = async () => {
        savingStarted.resolve();
        await save.promise;
    };
    const router = await renderAssets();
    await act(async () => {
        choosePackage(file);
        choosePackage(file);
    });
    expect(container!.textContent).toContain(i18n.t("assetImport.reading"));
    expect(container!.textContent).toContain(file.name);
    expect(importInput().value).toBe("");
    expect(importInput().disabled).toBe(true);
    expect(readCount).toBe(1);

    await act(async () => router.navigate("/canvas/away"));
    await act(async () => {
        read.resolve();
        await savingStarted.promise;
    });
    await act(async () => router.navigate("/assets"));
    expect(container!.textContent).toContain(i18n.t("assetImport.saving"));
    expect(container!.textContent).toContain(i18n.t("assetImport.savingHint", { count: 1 }));
    expect(container!.textContent).toContain(file.name);
    expect(container!.textContent).not.toContain(i18n.t("assetImport.saved"));
    expect(container!.textContent).not.toContain(i18n.t("assets.imported", { count: 1 }));
    expect(importInput().disabled).toBe(true);
    expect((documents.assets.value as { state: { assets: Asset[] } }).state.assets).toHaveLength(12);
    expect(useAssetStore.getState().assets).toHaveLength(13);

    await act(async () => {
        save.resolve();
        await waitForImportStatus("saved");
    });
    expect(container!.textContent).toContain(i18n.t("assetImport.saved"));
    expect(container!.textContent).toContain(i18n.t("assets.imported", { count: 1 }));
    expect(importInput().disabled).toBe(false);
    expect((documents.assets.value as { state: { assets: Asset[] } }).state.assets).toHaveLength(13);
    expect(requests.filter((request) => request.path === "/api/data/assets" && request.method === "PUT")).toHaveLength(1);
    await act(async () => router.navigate("/canvas/away"));
    await act(async () => router.navigate("/assets"));
    expect(container!.textContent).toContain(i18n.t("assetImport.saved"));
    expect(container!.textContent).toContain(file.name);

    await act(async () => {
        choosePackage(file);
        await waitForImportStatus("saved");
    });
    expect(readCount).toBe(2);
    expect((documents.assets.value as { state: { assets: Asset[] } }).state.assets).toHaveLength(14);
    expect(requests.filter((request) => request.method === "POST")).toEqual([]);
});

test("failed package save retains its batch and retry saves without repeating uploads", async () => {
    const media = asset("imported-video", "video");
    if (media.kind !== "video") throw new Error("video fixture required");
    const file = assetPackage([media], [{ storageKey: media.data.storageKey!, path: "files/video.mp4", mimeType: "video/mp4", bytes: 4 }], { "files/video.mp4": new Uint8Array([1, 2, 3, 4]) });
    const upload = deferred();
    const uploadingStarted = deferred();
    beforeFileUpload = async () => {
        uploadingStarted.resolve();
        await upload.promise;
    };
    assetsOffline = true;
    const router = await renderAssets();
    await act(async () => {
        choosePackage(file);
        await uploadingStarted.promise;
    });
    expect(container!.textContent).toContain(i18n.t("assetImport.uploading"));
    expect(container!.textContent).toContain(i18n.t("assetImport.progress", { completed: 0, total: 1 }));
    expect(container!.textContent).toContain("files/video.mp4");
    expect(container!.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(importInput().disabled).toBe(true);
    await act(async () => {
        upload.resolve();
        await waitForImportStatus("save-error");
    });
    expect(container!.textContent).toContain("asset save unavailable");
    expect(container!.textContent).toContain(i18n.t("assetImport.saveErrorHint"));
    expect(container!.textContent).not.toContain(i18n.t("assetImport.saved"));
    const imported = useAssetStore.getState().assets.find((item) => item.title === media.title)!;
    expect(imported).toBeDefined();
    expect(importInput().disabled).toBe(true);
    await act(async () => router.navigate("/canvas/away"));
    await act(async () => router.navigate("/assets"));
    expect(container!.textContent).toContain("asset save unavailable");
    expect(container!.textContent).toContain(file.name);
    assetsOffline = false;
    const retry = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === i18n.t("assetImport.retrySave"))!;
    expect(retry).toBeDefined();
    await act(async () => {
        retry.click();
        retry.click();
        await waitForImportStatus("saved");
    });
    expect(container!.textContent).toContain(i18n.t("assetImport.saved"));
    expect(importInput().disabled).toBe(false);
    const persisted = (documents.assets.value as { state: { assets: Asset[] } }).state.assets;
    expect(persisted).toHaveLength(13);
    expect(persisted.filter((item) => item.title === media.title).map((item) => item.id)).toEqual([imported.id]);
    expect(requests.filter((request) => request.path === "/api/files" && request.method === "POST")).toHaveLength(1);
    expect(requests.filter((request) => request.path === "/api/data/assets" && request.method === "PUT")).toHaveLength(2);
});

test("manual create retains a failed form and retries the same asset after further edits", async () => {
    await renderAssets();
    await clickText(i18n.t("assets.add"));
    await editField("title", "manual draft");
    await editField("content", "first text");
    await editField("coverUrl", "https://example.test/cover.png");
    assetsOffline = true;
    await clickText(i18n.t("common.save"), document.querySelector('[role="dialog"]')!);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("asset save unavailable");
    const created = useAssetStore.getState().assets.find((item) => item.title === "manual draft")!;
    expect(created).toBeDefined();
    expect(useAssetStore.getState().assets).toHaveLength(13);
    expect(document.body.textContent).not.toContain(i18n.t("assets.saved"));
    await clickText(i18n.t("common.cancel"), document.querySelector('[role="dialog"]')!);
    expect(container!.textContent).toContain(i18n.t("assets.formDraftHint"));
    await clickText(i18n.t("assets.resumeEdit"));
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] [id="title"]')!.value).toBe("manual draft");
    expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] [id="content"]')!.value).toBe("first text");
    await editField("content", "updated draft text");
    assetsOffline = false;
    reorderAssetsResponse = true;
    const saving = deferred(), finish = deferred();
    beforeAssetsSave = async () => { saving.resolve(); await finish.promise; };
    const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.replace(/\s/g, "") === i18n.t("common.save").replace(/\s/g, ""))!;
    await act(async () => {
        save.click();
        save.click();
        await saving.promise;
    });
    expect(useAssetStore.getState().assets.filter((item) => item.title === created.title).map((item) => item.id)).toEqual([created.id]);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain(i18n.t("assets.saved"));
    await act(async () => { finish.resolve(); await flushDocument("assets"); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const persisted = (documents.assets.value as { state: { assets: Asset[] } }).state.assets;
    expect(persisted).toHaveLength(13);
    expect(persisted.find((item) => item.id === created.id)).toMatchObject({ kind: "text", coverUrl: "https://example.test/cover.png", data: { content: "updated draft text" } });
    expect(requests.filter((request) => request.path === "/api/data/assets" && request.method === "PUT")).toHaveLength(2);
});

test("manual edit recognizes global save recovery and refuses deleted or externally changed targets", async () => {
    await renderAssets();
    await clickText(i18n.t("common.edit"), assetCheckbox("text-a").closest(".ant-card")!);
    await editField("content", "edited draft");
    assetsOffline = true;
    await clickText(i18n.t("common.save"), document.querySelector('[role="dialog"]')!);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("asset save unavailable");
    assetsOffline = false;
    await act(async () => { await retryDocument("assets"); await flushDocument("assets"); });
    const savedRequests = requests.length;
    await clickText(i18n.t("common.save"), document.querySelector('[role="dialog"]')!);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(requests).toHaveLength(savedRequests);

    await clickText(i18n.t("common.edit"), assetCheckbox("text-a").closest(".ant-card")!);
    await editField("content", "stale local form");
    await act(async () => {
        useAssetStore.getState().updateAsset("text-a", { title: "changed elsewhere" });
        await flushDocument("assets");
    });
    const changedRequests = requests.length;
    await clickText(i18n.t("common.save"), document.querySelector('[role="dialog"]')!);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(i18n.t("assets.formTargetChanged"));
    expect(requests).toHaveLength(changedRequests);
    expect(useAssetStore.getState().assets.find((item) => item.id === "text-a")).toMatchObject({ title: "changed elsewhere", data: { content: "edited draft" } });
    await act(async () => {
        useAssetStore.getState().replaceAssets(useAssetStore.getState().assets.filter((item) => item.id !== "text-a"));
        await flushDocument("assets");
    });
    const deletedRequests = requests.length;
    await clickText(i18n.t("common.save"), document.querySelector('[role="dialog"]')!);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(i18n.t("assets.formTargetMissing"));
    expect(requests).toHaveLength(deletedRequests);
    expect(useAssetStore.getState().assets.some((item) => item.id === "text-a")).toBe(false);
    await clickText(i18n.t("assets.discardForm"), document.querySelector('[role="dialog"]')!);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("manual validation keeps blank fields local and late cover reads cannot replace a reopened form", async () => {
    await renderAssets();
    await clickText(i18n.t("assets.add"));
    await editField("title", "   ");
    await editField("content", "   ");
    await clickText(i18n.t("common.save"), document.querySelector('[role="dialog"]')!);
    // Ant Design renders ErrorList through a zero-delay timer after validation.
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(i18n.t("assets.fields.titleRequired"));
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    await clickText(i18n.t("common.cancel"), document.querySelector('[role="dialog"]')!);
    await clickText(i18n.t("assets.discardForm"));

    const reads: { result: string; onload?: () => void }[] = [];
    Object.defineProperty(globalThis, "FileReader", { configurable: true, writable: true, value: class {
        result = "";
        onload?: () => void;
        onerror?: () => void;
        readAsDataURL() { reads.push(this); }
    } });
    await clickText(i18n.t("assets.add"));
    const fileInput = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="file"][accept="image/*"]')!;
    await act(async () => {
        Object.defineProperty(fileInput, "files", { configurable: true, value: [new File(["cover"], "cover.png", { type: "image/png" })] });
        fileInput.dispatchEvent(new browser.Event("change", { bubbles: true }));
    });
    expect(reads).toHaveLength(1);
    await clickText(i18n.t("common.cancel"), document.querySelector('[role="dialog"]')!);
    await clickText(i18n.t("common.edit"), assetCheckbox("text-a").closest(".ant-card")!);
    await act(async () => { reads[0].result = "data:image/png;base64,bGF0ZQ=="; reads[0].onload?.(); });
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] [id="title"]')!.value).toBe("text-a");
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] [id="coverUrl"]')!.value).toBe("");
    await act(async () => endCanvasSession());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container!.textContent).not.toContain(i18n.t("assets.formDraftTitle"));
    expect(requests.filter((request) => request.method === "POST" || request.method === "PUT")).toHaveLength(0);
});

test("asset deletion closes confirmation while saving and its failed undo retries without duplicate restoration", async () => {
    const router = await renderAssets();
    const deleting = deferred(), finishDelete = deferred();
    beforeAssetsSave = async () => { deleting.resolve(); await finishDelete.promise; };
    try {
        await clickText(i18n.t("common.delete"), assetCheckbox("image-a").closest(".ant-card")!);
        await clickText(i18n.t("common.delete"), document.querySelector('[role="dialog"]')!);
        await act(async () => deleting.promise);
        const hasVisibleDialog = [...document.querySelectorAll('[role="dialog"]')].some((dialog) => {
            const wrapper = dialog.closest<HTMLElement>(".ant-modal-wrap");
            return wrapper !== null && getComputedStyle(wrapper).display !== "none";
        });
        expect(hasVisibleDialog).toBe(false);
        expect(container!.textContent).toContain(i18n.t("assetDelete.deleteSaving", { title: "image-a" }));
        expect(document.body.textContent).not.toContain(i18n.t("assets.deleted"));
    } finally {
        await act(async () => { finishDelete.resolve(); await flushDocument("assets"); });
    }
    expect(container!.textContent).toContain(i18n.t("assetDelete.deleteSaved", { title: "image-a" }));
    beforeAssetsSave = undefined;
    assetsOffline = true;
    await clickText(i18n.t("assetDelete.undo"));
    expect(container!.textContent).toContain("asset save unavailable");
    expect(useAssetStore.getState().assets.filter((item) => item.id === "image-a")).toHaveLength(1);
    await act(async () => router.navigate("/canvas/away"));
    await act(async () => router.navigate("/assets"));
    expect(container!.textContent).toContain(i18n.t("assetDelete.undoSaveError", { title: "image-a" }));
    assetsOffline = false;
    await clickText(i18n.t("assetDelete.retrySave"));
    expect(container!.textContent).toContain(i18n.t("assetDelete.undoSaved", { title: "image-a" }));
    const persisted = (documents.assets.value as { state: { assets: Asset[] } }).state.assets;
    expect(persisted.map((item) => item.id).slice(0, 3)).toEqual(["text-a", "image-a", "text-0"]);
    expect(persisted.filter((item) => item.id === "image-a")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "POST" || request.method === "DELETE")).toHaveLength(0);
});

test("asset filters and pagination survive route changes and clear when the account session ends", async () => {
    const router = await renderAssets();
    const search = container!.querySelector<HTMLInputElement>(`input[placeholder="${i18n.t("assets.search")}"]`)!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(search, "library-note");
        search.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await changePage(2);
    await act(async () => router.navigate("/canvas/away"));
    await act(async () => router.navigate("/assets"));
    expect(container!.querySelector<HTMLInputElement>(`input[placeholder="${i18n.t("assets.search")}"]`)!.value).toBe("library-note");
    expect(container!.querySelector(".ant-pagination-item-active")?.getAttribute("title")).toBe("2");
    expect(assetCheckbox("video-a").checked).toBe(false);
    await changeKind("text");
    await act(async () => useAssetLibraryViewStore.getState().setView({ pageSize: 20 }));
    await act(async () => router.navigate("/canvas/away"));
    await act(async () => router.navigate("/assets"));
    expect(useAssetLibraryViewStore.getState()).toMatchObject({ keyword: "library-note", kindFilter: "text", page: 1, pageSize: 20 });
    expect(container!.querySelector(".ant-tag-checkable-checked")?.textContent).toBe(i18n.t("assets.kinds.text"));
    expect(container!.querySelectorAll('input[type="checkbox"][aria-label]')).toHaveLength(10);
    await act(async () => endCanvasSession());
    expect(useAssetLibraryViewStore.getState()).toMatchObject({ keyword: "", kindFilter: "all", page: 1, pageSize: 10 });
    expect(container!.querySelector<HTMLInputElement>(`input[placeholder="${i18n.t("assets.search")}"]`)!.value).toBe("");
});

test("asset details link exact file references to canvas nodes and do not infer text matches", async () => {
    const router = await renderAssets();
    await act(async () => {
        useCanvasStore.getState().updateProject("canvas-a", { nodes: [
            { id: "node-main", title: "main image", type: "image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "image:image-a" } },
            { id: "node-grid", title: "image grid", type: "config", position: { x: 120, y: 0 }, width: 100, height: 100, metadata: { images: [{ id: "sub-image", status: "success", content: "", storageKey: "image:image-a", naturalWidth: 10, naturalHeight: 10, bytes: 1, mimeType: "image/png" }] } },
            { id: "node-text", title: "text lookalike", type: "text", position: { x: 240, y: 0 }, width: 100, height: 100, metadata: { content: "text-content-text-a image:image-a" } },
        ] });
        await flushDocument("canvas");
    });
    await clickText(i18n.t("common.view"), assetCheckbox("image-a").closest(".ant-card")!);
    const drawer = document.querySelector('[role="dialog"]')!;
    const links = [...drawer.querySelectorAll<HTMLAnchorElement>('a[href*="focusNode="]')];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/canvas/canvas-a?focusNode=node-main", "/canvas/canvas-a?focusNode=node-grid"]);
    expect(links.map((link) => link.textContent)).toEqual(["canvas-a · main image", "canvas-a · image grid"]);
    await act(async () => links[1].dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(router.state.location.pathname).toBe("/canvas/canvas-a");
    expect(router.state.location.search).toBe("?focusNode=node-grid");
    await act(async () => router.navigate("/assets"));
    await clickText(i18n.t("common.view"), assetCheckbox("text-a").closest(".ant-card")!);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(i18n.t("assets.referencesUnavailable"));
    expect(document.querySelector('[role="dialog"]')!.querySelectorAll('a[href*="focusNode="]')).toHaveLength(0);
});

test("adding assets waits for persistence and rejects a repeated action before its first save completes", async () => {
    const saving = deferred(), finish = deferred();
    beforeAssetsSave = async () => { saving.resolve(); await finish.promise; };
    const input = { kind: "text" as const, title: "Confirmed addition", coverUrl: "", tags: [], data: { content: "retained content" } };
    let confirmed = false;
    const adding = useAssetStore.getState().addAssetsAndSave([input]).then((ids) => { confirmed = true; return ids; });
    await expect(useAssetStore.getState().addAssetsAndSave([input])).rejects.toThrow(i18n.t("assets.formSaveUnconfirmed"));
    await saving.promise;
    expect(confirmed).toBe(false);
    expect(useAssetStore.getState().assets.filter((item) => item.title === input.title)).toHaveLength(1);
    finish.resolve();
    const [id] = await adding;
    expect(confirmed).toBe(true);
    expect((documents.assets.value as { state: { assets: Asset[] } }).state.assets.find((item) => item.id === id)?.title).toBe(input.title);
});

test.each(["edited", "session"])("an asset addition cannot confirm its original payload after it was %s during saving", async (change) => {
    const saving = deferred(), finish = deferred();
    beforeAssetsSave = async () => { saving.resolve(); await finish.promise; };
    const epoch = sessionEpoch();
    const adding = useAssetStore.getState().addAssetsAndSave([{ kind: "text", title: "Pending addition", coverUrl: "", tags: [], data: { content: "original" } }], epoch);
    const outcome = adding.then(() => null, (error: unknown) => error);
    await saving.promise;
    const id = useAssetStore.getState().assets[0].id;
    if (change === "edited") useAssetStore.getState().updateAsset(id, { title: "Newer edit" });
    else {
        endCanvasSession();
        await readCanvasSession();
    }
    finish.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    if (change === "edited") {
        await flushDocument("assets");
        expect(useAssetStore.getState().assets.find((item) => item.id === id)?.title).toBe("Newer edit");
        expect((documents.assets.value as { state: { assets: Asset[] } }).state.assets.find((item) => item.id === id)?.title).toBe("Newer edit");
    }
});

test("sidebar uploads never report a failed asset save as success or add the failed draft again", async () => {
    const { CanvasSidePanel } = await import("@/components/canvas/canvas-side-panel");
    const previousPanel = useCanvasSidePanelStore.getState();
    useCanvasSidePanelStore.setState({ panelOpen: true, panelMounted: true, panelClosing: false });
    const upload = spyOn(fileStorage, "uploadMediaFile").mockResolvedValue({ url: "blob:existing-video", storageKey: "media:sidebar-video", width: 640, height: 480, bytes: 4, mimeType: "video/mp4" });
    const saving = deferred(), finish = deferred();
    beforeAssetsSave = async () => { saving.resolve(); await finish.promise; };
    assetsOffline = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    try {
        await act(async () => root!.render(<ConfigProvider theme={{ token: { motion: false } }}><App message={{ duration: 0 }}><CanvasSidePanel nodes={[]} selectedNodeIds={new Set()} onFocusNode={() => {}} onPreviewNode={() => {}} onHoverNode={() => {}} onInsertAsset={() => {}} /></App></ConfigProvider>));
        await clickText(i18n.t("canvas.sidePanel.assets"));
        const input = container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*,video/*"]')!;
        const file = new File(["clip"], "sidebar.mp4", { type: "video/mp4" });
        Object.defineProperty(input, "files", { configurable: true, value: [file] });
        await act(async () => { input.dispatchEvent(new browser.Event("change", { bubbles: true })); await saving.promise; });
        expect(document.body.textContent).not.toContain(i18n.t("canvas.sidePanel.addedAssets", { count: 1 }));
        expect(useAssetStore.getState().assets.filter((item) => item.title === file.name)).toHaveLength(1);
        await act(async () => { finish.resolve(); await flushDocument("assets").catch(() => {}); });
        expect(document.body.textContent).toContain("asset save unavailable");
        expect(document.body.textContent).not.toContain(i18n.t("canvas.sidePanel.addedAssets", { count: 1 }));
        await act(async () => input.dispatchEvent(new browser.Event("change", { bubbles: true })));
        expect(upload).toHaveBeenCalledTimes(1);
        expect(useAssetStore.getState().assets.filter((item) => item.title === file.name)).toHaveLength(1);
        assetsOffline = false;
        await act(async () => { await retryDocument("assets"); await flushDocument("assets"); });
        expect((documents.assets.value as { state: { assets: Asset[] } }).state.assets.filter((item) => item.title === file.name)).toHaveLength(1);
    } finally {
        finish.resolve();
        upload.mockRestore();
        useCanvasSidePanelStore.setState(previousPanel);
    }
});
