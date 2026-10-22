import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { browser } from "./browser";
import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import i18n from "../src/i18n";
import { filterAssets } from "../src/lib/asset-search";
import { AssetPickerModal, type InsertAssetPayload } from "../src/components/canvas/asset-picker-modal";
import { CanvasSidePanel } from "../src/components/canvas/canvas-side-panel";
import { useAssetStore, type Asset } from "../src/stores/use-asset-store";
import { useCanvasSidePanelStore } from "../src/stores/use-canvas-side-panel-store";
import { useAssetDeleteStore } from "../src/stores/use-asset-delete-store";
import { CANVAS_ASSET_DRAG_TYPE, takeCanvasAssetDrag } from "../src/stores/canvas/use-canvas-asset-drag-store";
import { endCanvasSession, readCanvasSession } from "../src/services/api/canvas-client";

const base = { coverUrl: "", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const assets: Asset[] = [
    { ...base, id: "text", kind: "text", title: "Draft Outline", source: "Team Board", note: "First chapter", tags: ["all", "Writing"], data: { content: "HELLO universe" } },
    { ...base, id: "image", kind: "image", title: "Cover", source: "Render", note: "cinematic", tags: ["Poster"], data: { dataUrl: "blob:cover-image", storageKey: "image:cover", width: 600, height: 400, bytes: 100, mimeType: "image/WebP" } },
    { ...base, id: "video", kind: "video", title: "Clip", source: "Studio", note: "timelapse", tags: ["Motion"], data: { url: "blob:clip-video", width: 400, height: 600, bytes: 200, mimeType: "video/MP4" } },
];
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let previous: Map<string, PropertyDescriptor | undefined>;
let panelState: ReturnType<typeof useCanvasSidePanelStore.getState>;
const originalMatchMedia = browser.matchMedia;
const originalFetch = globalThis.fetch;
const inserted: InsertAssetPayload[] = [];
let localDocuments: ReturnType<typeof mockBrowserDocuments>;
let localFiles: ReturnType<typeof mockBrowserFiles>;

beforeEach(() => {
    endCanvasSession();
    localDocuments = mockBrowserDocuments();
    localFiles = mockBrowserFiles();
    inserted.length = 0;
    useAssetStore.setState({ assets, hydrated: true });
    panelState = useCanvasSidePanelStore.getState();
    useCanvasSidePanelStore.setState({ panelOpen: true, panelMounted: true, panelClosing: false });
    const globals = {
        HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement, SVGElement: browser.SVGElement, Element: browser.Element,
        ShadowRoot: browser.ShadowRoot, getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
        requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
        ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    };
    previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    browser.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, media: "", onchange: null });
});

afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    endCanvasSession();
    localDocuments.restore();
    localFiles.restore();
    useAssetStore.setState({ assets: [], hydrated: false });
    useCanvasSidePanelStore.setState(panelState);
    browser.matchMedia = originalMatchMedia;
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

test("shared asset search combines all searchable fields with the existing substring semantics", () => {
    for (const [keyword, ids] of [
        ["  DRAFT  ", ["text"]], ["team board", ["text"]], ["CHAPTER", ["text"]], ["writing", ["text"]], ["hello universe", ["text"]],
        ["  IMAGE/WEBP ", ["image"]], ["mp4", ["video"]], ["draft outline team board", ["text"]], ["hello draft", []],
    ] as const) expect(filterAssets(assets, { keyword }).map((asset) => asset.id)).toEqual([...ids]);
    expect(filterAssets([...assets, { ...assets[0], kind: "audio" } as unknown as Asset], { keyword: "   " }).map((asset) => asset.id)).toEqual(["text", "image", "video"]);
    expect(filterAssets(assets, { keyword: "", kind: "image" }).map((asset) => asset.id)).toEqual(["image"]);
    expect(filterAssets(assets, { keyword: "", tag: "all" }).map((asset) => asset.id)).toEqual(["text"]);
    expect(filterAssets(assets, { keyword: "HELLO", kind: "text", tag: "all" }).map((asset) => asset.id)).toEqual(["text"]);
    expect(filterAssets(assets, { keyword: "HELLO", kind: "video", tag: "all" })).toEqual([]);
});

async function renderEntry(kind: "picker" | "sidebar") {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
        <ConfigProvider theme={{ token: { motion: false } }}>
            <App>
                {kind === "picker"
                    ? <AssetPickerModal open onClose={() => {}} onInsert={(payload) => inserted.push(payload)} />
                    : <CanvasSidePanel nodes={[]} selectedNodeIds={new Set()} onFocusNode={() => {}} onPreviewNode={() => {}} onHoverNode={() => {}} onInsertAsset={(payload) => inserted.push(payload)} />}
            </App>
        </ConfigProvider>,
    ));
    if (kind === "sidebar") {
        const tab = [...container.querySelectorAll("button")].find((button) => button.textContent === i18n.t("canvas.sidePanel.assets"));
        await act(async () => tab!.click());
    }
}

async function search(label: string, value: string) {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${i18n.t(label)}"]`);
    expect(input).not.toBeNull();
    await act(async () => {
        Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input!.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
}

test("the canvas picker finds text contents and media MIME while preserving insertion payloads", async () => {
    await renderEntry("picker");
    await search("canvas.assetPicker.search", "  hello UNIVERSE  ");
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Draft Outline");
    expect(dialog.textContent).not.toContain("Cover");
    const textCard = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Draft Outline"));
    expect(textCard).toBeDefined();
    await act(async () => textCard!.click());
    expect(inserted[0]).toEqual({ kind: "text", title: "Draft Outline", content: "HELLO universe" });
    await search("canvas.assetPicker.search", "image/webp");
    expect(dialog.textContent).not.toContain("Draft Outline");
    const imageCard = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Cover"));
    await act(async () => imageCard!.click());
    expect(inserted[1]).toEqual({ kind: "image", title: "Cover", dataUrl: "blob:cover-image", storageKey: "image:cover" });
});

test("sidebar source and note search preserves keyboard-accessible insertion", async () => {
    await renderEntry("sidebar");
    await search("canvas.sidePanel.searchAssets", "  cinematic  ");
    const action = container!.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("canvas.sidePanel.insertAssetNamed", { title: "Cover" })}"]`);
    expect(action).not.toBeNull();
    expect(container!.querySelector(`button[aria-label="${i18n.t("canvas.sidePanel.insertAssetNamed", { title: "Draft Outline" })}"]`)).toBeNull();
    await act(async () => { action!.focus(); });
    expect(document.activeElement).toBe(action);
    await act(async () => action!.click());
    expect(inserted[0]).toMatchObject({ kind: "image", title: "Cover", storageKey: "image:cover" });
    await search("canvas.sidePanel.searchAssets", "studio");
    expect(container!.querySelector(`button[aria-label="${i18n.t("canvas.sidePanel.insertAssetNamed", { title: "Clip" })}"]`)).not.toBeNull();
});

function dispatchDrag(target: Element, type: "dragstart" | "dragend", dataTransfer: object) {
    const event = new browser.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    target.dispatchEvent(event);
    return event;
}

test.each(assets.map((asset) => [asset.kind, asset] as const))("sidebar %s dragging transfers only a temporary token and preserves button insertion", async (_kind, asset) => {
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/data/assets" && init?.method !== "PUT") return Response.json({ value: { state: { assets }, version: 0 }, revision: 1 });
        if (String(url) === "/api/files/image%3Acover" && !init?.method) return new Response(null, { status: 404 });
        if (String(url) !== "/api/session") throw new Error(`Unexpected request: ${url}`);
        return Response.json({ user: { id: "drag-owner", subject: `ics_${"a".repeat(32)}`, username: "drag-owner" }, csrf_token: "csrf", session_tag: "drag-session", expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }) as typeof fetch;
    await readCanvasSession();
    await useAssetStore.persist.rehydrate();
    await renderEntry("sidebar");
    const insert = container!.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("canvas.sidePanel.insertAssetNamed", { title: asset.title })}"]`)!;
    const remove = container!.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("canvas.sidePanel.removeAssetNamed", { title: asset.title })}"]`)!;
    const card = insert.closest<HTMLElement>('[draggable="true"]')!;
    expect(card).not.toBeNull();
    expect(card.title).toBe(i18n.t("canvas.sidePanel.dragAssetHint"));
    for (const image of card.querySelectorAll("img")) expect(image.draggable).toBe(false);
    const values = new Map<string, string>();
    const transfer = {
        effectAllowed: "uninitialized",
        clearData: () => values.clear(),
        setData: (type: string, value: string) => { values.set(type, value); },
        getData: (type: string) => values.get(type) || "",
    };

    for (const button of [insert, remove]) {
        button.dispatchEvent(new browser.Event("pointerdown", { bubbles: true }));
        expect(dispatchDrag(card, "dragstart", transfer).defaultPrevented).toBe(true);
        expect(values.size).toBe(0);
    }
    await act(async () => { insert.focus(); insert.click(); });
    expect(document.activeElement).toBe(insert);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ kind: asset.kind, title: asset.title });

    card.dispatchEvent(new browser.Event("pointerdown", { bubbles: true }));
    values.set("text/uri-list", "https://example.com/old-image.png");
    expect(dispatchDrag(card, "dragstart", transfer).defaultPrevented).toBe(false);
    expect([...values.keys()]).toEqual([CANVAS_ASSET_DRAG_TYPE]);
    expect(transfer.effectAllowed).toBe("copy");
    const token = transfer.getData(CANVAS_ASSET_DRAG_TYPE);
    expect(token).not.toBe("");
    expect(token).not.toContain(asset.title);
    const media = asset.kind === "text" ? asset.data.content : asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
    expect(token).not.toContain(media);
    expect(takeCanvasAssetDrag(token)).toMatchObject({ id: asset.id, kind: asset.kind });
    expect(takeCanvasAssetDrag(token)).toBeNull();
    expect(inserted).toHaveLength(1);

    dispatchDrag(card, "dragstart", transfer);
    const canceledToken = transfer.getData(CANVAS_ASSET_DRAG_TYPE);
    dispatchDrag(card, "dragend", transfer);
    expect(takeCanvasAssetDrag(canceledToken)).toBeNull();
});

test("a real all tag stays selectable and visible when displaced, then clears when removed", async () => {
    await renderEntry("sidebar");
    const tag = [...container!.querySelectorAll<HTMLElement>(".ant-tag-checkable")].find((element) => element.textContent === "all");
    expect(tag).toBeDefined();
    await act(async () => tag!.click());
    expect(container!.querySelector(`button[aria-label="${i18n.t("canvas.sidePanel.insertAssetNamed", { title: "Cover" })}"]`)).toBeNull();
    const incoming: Asset[] = Array.from({ length: 21 }, (_, index) => ({ ...base, id: `incoming-${index}`, kind: "text", title: `Incoming ${index}`, tags: [`new-${index}`], data: { content: `New content ${index}` } }));
    await act(async () => useAssetStore.setState({ assets: [...incoming, ...assets] }));
    const stillVisible = [...container!.querySelectorAll<HTMLElement>(".ant-tag-checkable")].find((element) => element.textContent === "all");
    expect(stillVisible).toBeDefined();
    expect(stillVisible!.classList.contains("ant-tag-checkable-checked")).toBe(true);
    expect(container!.querySelector(`button[aria-label="${i18n.t("canvas.sidePanel.insertAssetNamed", { title: "Incoming 0" })}"]`)).toBeNull();
    await act(async () => useAssetStore.setState({ assets: [...incoming, assets[1]] }));
    expect(container!.querySelector(`button[aria-label="${i18n.t("canvas.sidePanel.insertAssetNamed", { title: "Incoming 0" })}"]`)).not.toBeNull();
    await act(async () => useAssetStore.setState({ assets: [...incoming, ...assets] }));
    expect(container!.querySelector(`button[aria-label="${i18n.t("canvas.sidePanel.insertAssetNamed", { title: "Cover" })}"]`)).not.toBeNull();
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

async function waitForDeletion(status: "saved" | "save-error") {
    if (useAssetDeleteStore.getState().status === status) return;
    await new Promise<void>((resolve) => {
        const unsubscribe = useAssetDeleteStore.subscribe((state) => {
            if (state.status !== status) return;
            unsubscribe();
            resolve();
        });
    });
}

test("sidebar deletion waits for saving across remounts and failed undo retries without duplicating the asset", async () => {
    const title = assets[0].title;
    const originalAssets = [assets[0], { ...assets[0], id: "other", title: "Other note" }];
    let remote = { value: { state: { assets: originalAssets }, version: 0 }, revision: 1 };
    let writes = 0;
    const savingDelete = deferred<void>(), finishDelete = deferred<void>();
    const savingUndo = deferred<void>(), finishUndo = deferred<void>();
    const session = { user: { id: "sidebar-owner", subject: `ics_${"f".repeat(32)}`, username: "sidebar-owner" }, csrf_token: "csrf", session_tag: "sidebar-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    localStorage.clear();
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/session") return Response.json(session);
        if (String(url) !== "/api/data/assets") throw new Error(`Unexpected request: ${url}`);
        if (init?.method !== "PUT") return Response.json(remote);
        writes += 1;
        if (writes === 1) { savingDelete.resolve(); await finishDelete.promise; }
        if (writes === 2) {
            savingUndo.resolve();
            await finishUndo.promise;
            return Response.json({ error: { message: "offline" } }, { status: 503 });
        }
        const body = JSON.parse(String(init.body));
        if (body.revision !== remote.revision) return Response.json({ error: { message: "conflict" } }, { status: 409 });
        remote = { value: body.value, revision: remote.revision + 1 };
        return Response.json(remote);
    }) as typeof fetch;
    await readCanvasSession();
    await useAssetStore.persist.rehydrate();
    await renderEntry("sidebar");
    const remove = container!.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("canvas.sidePanel.removeAssetNamed", { title })}"]`)!;
    await act(async () => remove.click());
    const confirm = document.querySelector<HTMLButtonElement>(".ant-popconfirm-buttons .ant-btn-primary")!;
    expect(confirm).not.toBeNull();
    await act(async () => { confirm.click(); await savingDelete.promise; });
    expect(container!.textContent).toContain(i18n.t("assetDelete.deleteSaving", { title }));
    expect(container!.textContent).not.toContain(i18n.t("assetDelete.deleteSaved", { title }));
    expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual(["other"]);
    expect(container!.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("canvas.sidePanel.removeAssetNamed", { title: "Other note" })}"]`)!.disabled).toBe(true);
    await act(async () => root!.unmount());
    root = undefined;
    container!.remove();
    container = undefined;
    await renderEntry("sidebar");
    expect(container!.textContent).toContain(i18n.t("assetDelete.deleteSaving", { title }));
    await act(async () => { finishDelete.resolve(); await waitForDeletion("saved"); });
    expect(container!.textContent).toContain(i18n.t("assetDelete.deleteSaved", { title }));
    const undo = [...container!.querySelectorAll("button")].find((button) => button.textContent === i18n.t("assetDelete.undo"))!;
    await act(async () => { undo.click(); await savingUndo.promise; });
    expect(container!.textContent).toContain(i18n.t("assetDelete.undoSaving", { title }));
    expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual(["text", "other"]);
    await act(async () => { finishUndo.resolve(); await waitForDeletion("save-error"); });
    expect(container!.textContent).toContain(i18n.t("assetDelete.undoSaveError"));
    expect(container!.textContent).not.toContain(i18n.t("assetDelete.undoSaved", { title }));
    const retry = [...container!.querySelectorAll("button")].find((button) => button.textContent === i18n.t("assetDelete.retrySave"))!;
    await act(async () => { retry.click(); retry.click(); await waitForDeletion("saved"); });
    expect(container!.textContent).toContain(i18n.t("assetDelete.undoSaved", { title }));
    expect(remote.value.state.assets.map((asset) => asset.id)).toEqual(["text", "other"]);
    expect(writes).toBe(3);
    await act(async () => endCanvasSession());
    expect(container!.textContent).not.toContain(i18n.t("assetDelete.undoSaved", { title }));
});
