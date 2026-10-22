import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { zipSync } from "fflate";
import { browser } from "./browser";
import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import type { AssetImportProgress } from "../src/pages/assets/asset-transfer";
import type { Asset } from "../src/stores/use-asset-store";

const originalFetch = globalThis.fetch;
const originalImage = globalThis.Image;
const originalAnchor = globalThis.HTMLAnchorElement;
Object.defineProperty(globalThis, "HTMLAnchorElement", { configurable: true, writable: true, value: browser.HTMLAnchorElement });
const client = await import("../src/services/api/canvas-client");
const data = await import("../src/services/canvas-data");
const { useAssetStore } = await import("../src/stores/use-asset-store");
const { exportAssets, readAssetPackage } = await import("../src/pages/assets/asset-transfer");
const { readZip } = await import("../src/lib/zip");
const session = { user: { id: "user-a", subject: `ics_${"a".repeat(32)}`, username: "alice" }, csrf_token: "csrf", session_tag: "assets-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
const brokenImage = "data:image/png;base64,AAAA";
const inlineImage = "data:image/png;base64,aW1hZ2U=";
const textAsset = { id: "text", kind: "text", title: "保留文本", coverUrl: "", tags: [], data: { content: "保留内容" } };
const imageAsset = { id: "image", kind: "image", title: "图片", coverUrl: inlineImage, tags: [], data: { dataUrl: inlineImage, width: 1, height: 1, bytes: 5, mimeType: "image/png" } };
let document: { value: unknown; revision: number };
let mutations: string[];
let activeSession = session;
let saveFile: ReturnType<typeof spyOn> | undefined;
let localDocuments: ReturnType<typeof mockBrowserDocuments>;
let localFiles: ReturnType<typeof mockBrowserFiles>;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

async function changeAccount() {
    client.endCanvasSession();
    activeSession = { ...session, user: { id: "user-b", subject: `ics_${"b".repeat(32)}`, username: "bob" }, session_tag: "assets-session-b" };
    await client.readCanvasSession();
}

function assetPackage(assets: unknown[], files: unknown[] = [], contents: Record<string, Uint8Array> = {}) {
    return new File([zipSync({ "assets.json": new TextEncoder().encode(JSON.stringify({ app: "infinite-canvas", version: 1, assets, files })), ...contents })], "assets.zip");
}

beforeEach(async () => {
    client.endCanvasSession();
    localDocuments = mockBrowserDocuments();
    localFiles = mockBrowserFiles();
    useAssetStore.setState({ assets: [], hydrated: false });
    mutations = [];
    activeSession = session;
    document = { value: { state: { assets: [] }, version: 0 }, revision: 1 };
    Object.defineProperty(globalThis, "HTMLAnchorElement", { configurable: true, writable: true, value: browser.HTMLAnchorElement });
    Object.defineProperty(globalThis, "Image", {
        configurable: true,
        writable: true,
        value: class {
            src = "";
            naturalWidth = 16;
            naturalHeight = 8;
            async decode() {
                if (this.src === brokenImage) throw new Error("图片素材无法读取");
            }
        },
    });
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/session") return Response.json(activeSession);
        if (path.startsWith("data:")) return originalFetch(input, init);
        if (init?.method === "POST" || init?.method === "PUT" || init?.method === "DELETE") mutations.push(path);
        if (path === "/api/files") return Response.json({ id: "fresh", storageKey: "image:fresh", url: "blob:imported-image", mimeType: "image/png", bytes: 5 });
        if (path === "/api/data/assets") {
            if (init?.method === "PUT") {
                const body = JSON.parse(String(init.body));
                expect(body.revision).toBe(document.revision);
                document = { value: body.value, revision: document.revision + 1 };
            }
            return Response.json(document);
        }
        throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;
    await client.readCanvasSession();
});

afterEach(() => {
    client.endCanvasSession();
    localDocuments.restore();
    localFiles.restore();
    useAssetStore.setState({ assets: [], hydrated: false });
    saveFile?.mockRestore();
    saveFile = undefined;
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "Image", { configurable: true, writable: true, value: originalImage });
    Object.defineProperty(globalThis, "HTMLAnchorElement", { configurable: true, writable: true, value: originalAnchor });
});

test("hydration preserves all saved assets and never writes or uploads during reads", async () => {
    const assets = [textAsset, { ...imageAsset, coverUrl: brokenImage, data: { ...imageAsset.data, dataUrl: brokenImage } }];
    document.value = { state: { assets }, version: 0 };
    await useAssetStore.persist.rehydrate();
    expect(useAssetStore.getState().hydrated).toBe(true);
    expect(useAssetStore.getState().assets).toEqual(assets);
    expect(document).toEqual({ value: { state: { assets }, version: 0 }, revision: 1 });
    expect(mutations).toEqual([]);
    useAssetStore.getState().addAsset({ kind: "text", title: "新增", coverUrl: "", tags: [], data: { content: "新内容" } });
    await data.readDocument("assets");
    expect((document.value as { state: { assets: unknown[] } }).state.assets).toHaveLength(3);
    expect(mutations).toEqual(["/api/data/assets"]);
});

test("invalid persisted documents reject hydration without persisting defaults", async () => {
    document.value = { state: { assets: "damaged document" }, version: 0 };
    await expect(useAssetStore.persist.rehydrate()).rejects.toThrow("原数据未被修改");
    expect(useAssetStore.getState().hydrated).toBe(false);
    expect(document).toEqual({ value: { state: { assets: "damaged document" }, version: 0 }, revision: 1 });
    expect(mutations).toEqual([]);
});

test("a corrupt inline image rejects the whole import before any upload or asset write", async () => {
    const file = assetPackage([textAsset, imageAsset, { ...imageAsset, data: { ...imageAsset.data, dataUrl: brokenImage } }]);
    await expect(readAssetPackage(file)).rejects.toThrow("无法读取");
    expect(mutations).toEqual([]);
    expect(useAssetStore.getState().assets).toEqual([]);
});

test("invalid entries and missing nested references are rejected before uploading", async () => {
    for (const assets of [
        [{ ...textAsset, tags: "invalid" }],
        [{ ...textAsset, source: { invalid: true } }],
        [{ ...textAsset, note: ["invalid"] }],
        [{ ...textAsset, data: { content: null } }],
        [{ ...imageAsset, data: { ...imageAsset.data, width: "invalid" } }],
        [{ ...imageAsset, data: { ...imageAsset.data, storageKey: "image:missing" } }],
        [{ ...textAsset, metadata: { storageKey: "image:missing" } }],
        [{ ...textAsset, metadata: { references: ["image:missing"] } }],
    ]) {
        await expect(readAssetPackage(assetPackage(assets))).rejects.toThrow();
    }
    expect(mutations).toEqual([]);
});

test("valid imported images receive private storage identities and matching covers", async () => {
    const importedInline = await readAssetPackage(assetPackage([imageAsset]));
    expect(importedInline[0]).toMatchObject({ kind: "image", coverUrl: "blob:imported-image", data: { storageKey: "image:fresh", dataUrl: "blob:imported-image", width: 16, height: 8 } });
    expect(importedInline[0].id).not.toBe(imageAsset.id);
    const previousUrl = data.fileUrl("image:previous");
    const storedImage = { ...imageAsset, coverUrl: previousUrl, data: { ...imageAsset.data, dataUrl: "", storageKey: "image:previous" } };
    const importedStored = await readAssetPackage(assetPackage([storedImage], [{ storageKey: "image:previous", path: "files/image.png", mimeType: "image/png", bytes: 5 }], { "files/image.png": new TextEncoder().encode("image") }));
    expect(importedStored[0]).toMatchObject({ coverUrl: "blob:imported-image", data: { storageKey: "image:fresh", dataUrl: "blob:imported-image" } });
    expect(mutations).toEqual(["/api/files", "/api/files"]);
});

test("every manifest file is checked before uploads, including images referenced only by metadata", async () => {
    Object.defineProperty(globalThis, "Image", {
        configurable: true,
        writable: true,
        value: class {
            src = "";
            naturalWidth = 16;
            naturalHeight = 8;
            async decode() {
                if ((await (await originalFetch(this.src)).text()) === "broken") throw new Error("decode failed");
            }
        },
    });
    const files = [
        { storageKey: "image:good", path: "files/good.png", mimeType: "image/png", bytes: 5 },
        { storageKey: "image:broken", path: "files/broken.png", mimeType: "image/png", bytes: 6 },
    ];
    const contents = { "files/good.png": new TextEncoder().encode("image"), "files/broken.png": new TextEncoder().encode("broken") };
    const assets = [{ ...textAsset, metadata: { storageKey: "image:broken" } }];
    const progress: AssetImportProgress[] = [];
    await expect(readAssetPackage(assetPackage(assets, files, contents), { onProgress: (value) => progress.push(value) })).rejects.toThrow("files/broken.png: 图片素材无法读取");
    expect(progress.at(-1)).toEqual({ phase: "validating", completed: 1, total: 3, item: "files/broken.png" });
    expect(progress.some((value) => value.phase === "uploading")).toBe(false);
    for (const invalidFiles of [
        [files[0], { ...files[1], path: "files/missing.png" }],
        [files[0], { ...files[1], bytes: "invalid" }],
        [files[0], { ...files[1], storageKey: files[0].storageKey }],
    ]) {
        await expect(readAssetPackage(assetPackage(assets, invalidFiles, contents))).rejects.toThrow("files/");
    }
    expect(mutations).toEqual([]);
});

test("validation errors identify the offending asset and prevent all uploads", async () => {
    for (const asset of [
        { ...imageAsset, title: "无法解码的图片", data: { ...imageAsset.data, dataUrl: brokenImage } },
        { ...textAsset, title: "来源不合法的文本", source: 42 },
        { ...textAsset, title: "备注不合法的文本", note: null },
        { ...textAsset, title: "引用缺失的文本", metadata: { nested: [{ storageKey: "image:missing" }] } },
    ]) {
        await expect(readAssetPackage(assetPackage([imageAsset, asset]))).rejects.toThrow(`${asset.title}:`);
    }
    await expect(readAssetPackage(new File(["not a ZIP"], "broken.zip"))).rejects.toThrow("broken.zip: 素材压缩包无法读取");
    await expect(readAssetPackage(assetPackage([], [{ storageKey: "media:unused", path: "files/unused.mp4", mimeType: "video/mp4", bytes: 5 }], { "files/unused.mp4": new TextEncoder().encode("video") }))).rejects.toThrow("压缩包中没有可导入的素材");
    expect(mutations).toEqual([]);
});

test("mixed imports report real phase counts and the current item before each upload", async () => {
    const file = { storageKey: "media:video", path: "files/video.mp4", mimeType: "video/mp4", bytes: 5 };
    const video = { id: "video", kind: "video", title: "视频", coverUrl: "", tags: [], data: { storageKey: file.storageKey, url: "", width: 16, height: 9, bytes: 5, mimeType: file.mimeType } };
    const progress: AssetImportProgress[] = [];
    const imported = await readAssetPackage(assetPackage([textAsset, imageAsset, video], [file], { [file.path]: new TextEncoder().encode("video") }), {
        onProgress: (value) => {
            if (value.phase !== "uploading") expect(mutations).toEqual([]);
            if (value.phase === "uploading" && value.completed === 0 && value.item === file.path) expect(mutations).toEqual([]);
            progress.push(value);
        },
    });
    expect(imported).toHaveLength(3);
    expect(progress.filter((value) => value.phase === "reading").map((value) => value.completed)).toEqual([0, 1]);
    for (const [phase, total] of [["validating", 4], ["uploading", 2]] as const) {
        const entries = progress.filter((value) => value.phase === phase);
        expect(entries.every((value) => value.total === total)).toBe(true);
        expect([...new Set(entries.map((value) => value.completed))]).toEqual(Array.from({ length: total + 1 }, (_, index) => index));
        expect(entries.at(-1)?.completed).toBe(total);
    }
    expect(progress).toContainEqual({ phase: "uploading", completed: 0, total: 2, item: file.path });
    expect(progress).toContainEqual({ phase: "uploading", completed: 1, total: 2, item: imageAsset.title });
    expect(mutations).toEqual(["/api/files", "/api/files"]);
    expect(useAssetStore.getState().assets).toEqual([]);
});

test("a packaged upload failure names its file and never reports it as completed", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        if (String(input) !== "/api/files") return previousFetch(input, init);
        mutations.push("/api/files");
        return Response.json({ error: { message: "storage offline" } }, { status: 503 });
    }) as typeof fetch;
    const file = { storageKey: "image:first", path: "files/first.png", mimeType: "image/png", bytes: 5 };
    const progress: AssetImportProgress[] = [];
    await expect(readAssetPackage(assetPackage([textAsset], [file], { [file.path]: new TextEncoder().encode("image") }), { onProgress: (value) => progress.push(value) })).rejects.toThrow("files/first.png: storage offline");
    expect(progress.at(-1)).toEqual({ phase: "uploading", completed: 0, total: 1, item: file.path });
    expect(mutations).toEqual(["/api/files"]);
    expect(useAssetStore.getState().assets).toEqual([]);
});

test("inline uploads stay concurrent and finish in-flight uploads before exposing an import failure", async () => {
    const previousFetch = globalThis.fetch;
    const secondStarted = deferred<void>();
    const releaseSecond = deferred<Response>();
    let uploads = 0;
    globalThis.fetch = (async (input, init) => {
        if (String(input) !== "/api/files") return previousFetch(input, init);
        mutations.push("/api/files");
        uploads += 1;
        if (uploads === 1) return Response.json({ error: { message: "storage offline" } }, { status: 503 });
        secondStarted.resolve();
        return releaseSecond.promise;
    }) as typeof fetch;
    const progress: AssetImportProgress[] = [];
    let settled = false;
    const pending = readAssetPackage(assetPackage([{ ...imageAsset, title: "上传失败的图片" }, { ...imageAsset, title: "仍在上传的图片" }]), { onProgress: (value) => progress.push(value) }).then(
        () => { settled = true; return null; },
        (error: unknown) => { settled = true; return error; },
    );
    await secondStarted.promise;
    try {
        // Drain the first request's rejection while the second request remains explicitly blocked.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(uploads).toBe(2);
    } finally {
        releaseSecond.resolve(Response.json({ id: "second", storageKey: "image:second", url: "blob:second-image", mimeType: "image/png", bytes: 5 }));
    }
    expect(String(await pending)).toContain("上传失败的图片: storage offline");
    expect(progress.at(-1)).toEqual({ phase: "uploading", completed: 1, total: 2, item: "仍在上传的图片" });
    expect(mutations).toEqual(["/api/files", "/api/files"]);
    expect(useAssetStore.getState().assets).toEqual([]);
});

test("an account change during ZIP reading prevents validation, uploads, and stale progress", async () => {
    const file = assetPackage([imageAsset]);
    const bytes = await file.arrayBuffer();
    const started = deferred<void>();
    const release = deferred<ArrayBuffer>();
    Object.defineProperty(file, "arrayBuffer", { value: () => { started.resolve(); return release.promise; } });
    const progress: AssetImportProgress[] = [];
    const pending = readAssetPackage(file, { onProgress: (value) => progress.push(value) }).catch((error: unknown) => error);
    await started.promise;
    await changeAccount();
    const before = [...progress];
    release.resolve(bytes);
    expect(String(await pending)).toContain("登录会话已改变");
    expect(progress).toEqual(before);
    expect(mutations).toEqual([]);
});

test("an account change during image decoding prevents uploads and stale progress", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    Object.defineProperty(globalThis, "Image", {
        configurable: true,
        writable: true,
        value: class {
            src = "";
            naturalWidth = 16;
            naturalHeight = 8;
            async decode() { started.resolve(); await release.promise; }
        },
    });
    const progress: AssetImportProgress[] = [];
    const pending = readAssetPackage(assetPackage([imageAsset]), { onProgress: (value) => progress.push(value) }).catch((error: unknown) => error);
    await started.promise;
    expect(progress.at(-1)).toEqual({ phase: "validating", completed: 0, total: 1, item: imageAsset.title });
    await changeAccount();
    const before = [...progress];
    release.resolve();
    expect(String(await pending)).toContain("登录会话已改变");
    expect(progress).toEqual(before);
    expect(mutations).toEqual([]);
});

test("an account change during a serial upload prevents sending the next file to the new account", async () => {
    const previousFetch = globalThis.fetch;
    const started = deferred<void>();
    const release = deferred<Response>();
    const owners: (string | undefined)[] = [];
    globalThis.fetch = (async (input, init) => {
        if (String(input) !== "/api/files") return previousFetch(input, init);
        mutations.push("/api/files");
        owners.push(client.currentSession()?.user.subject);
        started.resolve();
        return release.promise;
    }) as typeof fetch;
    const files = [
        { storageKey: "media:first", path: "files/first.mp4", mimeType: "video/mp4", bytes: 5 },
        { storageKey: "media:second", path: "files/second.mp4", mimeType: "video/mp4", bytes: 5 },
    ];
    const progress: AssetImportProgress[] = [];
    const pending = readAssetPackage(assetPackage([textAsset], files, Object.fromEntries(files.map((file) => [file.path, new TextEncoder().encode("video")]))), { onProgress: (value) => progress.push(value) }).catch((error: unknown) => error);
    await started.promise;
    await changeAccount();
    const before = [...progress];
    release.resolve(Response.json({ id: "first", storageKey: "media:first-new", url: "blob:first-video", mimeType: "video/mp4", bytes: 5 }));
    expect(String(await pending)).toContain("登录会话已改变");
    expect(progress).toEqual(before);
    expect(owners).toEqual([session.user.subject]);
    expect(mutations).toEqual(["/api/files"]);
});

test("asset export and import preserve ordinary resource-like text while remapping shared resources", async () => {
    const saver = await import("file-saver");
    const downloads: Blob[] = [];
    saveFile = spyOn(saver, "saveAs").mockImplementation((blob: Blob | string) => {
        if (blob instanceof Blob) downloads.push(blob);
    });
    const previousFetch = globalThis.fetch;
    const reads: string[] = [];
    globalThis.fetch = (async (input, init) => {
        if (String(input) !== "/api/files/image%3Ashared") return previousFetch(input, init);
        reads.push(String(input));
        return new Response(new Blob(["image"], { type: "image/png" }));
    }) as typeof fetch;
    const first = { ...imageAsset, coverUrl: "blob:shared-image", data: { ...imageAsset.data, dataUrl: "blob:shared-image", storageKey: "image:shared" }, createdAt: "2026-01-01", updatedAt: "2026-01-01" } as Asset;
    const text: Asset = {
        ...textAsset, kind: "text", title: "image: a red car", source: "media: camera notes", note: "image:shared", tags: ["media: notes"],
        data: { content: "media: a video description" }, createdAt: "2026-01-01", updatedAt: "2026-01-01",
        metadata: { references: ["image:shared"], plugin: { label: "image:shared", untouched: ["media: notes"] } },
    };
    await exportAssets([first, { ...first, id: "second", title: "同一图片的另一条收藏" }, text], "shared.zip");
    expect(reads).toEqual(["/api/files/image%3Ashared"]);
    expect(downloads).toHaveLength(1);
    const zip = await readZip(downloads[0]);
    const manifest = JSON.parse(await zip.get("assets.json")!.text());
    expect(manifest.assets).toHaveLength(3);
    expect(manifest.files).toHaveLength(1);
    const imported = await readAssetPackage(new File([downloads[0]], "shared.zip"));
    expect(imported.map((asset) => asset.title)).toEqual([imageAsset.title, "同一图片的另一条收藏", text.title]);
    expect(imported[0].id).not.toBe(imported[1].id);
    expect(imported.slice(0, 2).every((asset) => asset.kind === "image" && asset.data.storageKey === "image:fresh")).toBe(true);
    expect(imported[2]).toMatchObject({ ...text, id: imported[2].id, metadata: { ...text.metadata, references: ["image:fresh"] } });
    expect(mutations).toEqual(["/api/files"]);
});
