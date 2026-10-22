import "./browser";
import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import { afterEach, beforeEach, expect, test } from "bun:test";
import i18n from "@/i18n";
import { endCanvasSession, readCanvasSession } from "@/services/api/canvas-client";
import { flushDocument, getDocumentSaveState, retryDocument } from "@/services/canvas-data";
import { useAssetDeleteStore } from "@/stores/use-asset-delete-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

const originalFetch = globalThis.fetch;
const session = { user: { id: "delete-owner", subject: `ics_${"d".repeat(32)}`, username: "delete-owner" }, csrf_token: "csrf", session_tag: "delete-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
const video: Asset = {
    id: "video", kind: "video", title: "原视频", coverUrl: "", tags: ["保留"], source: "收藏", note: "原备注",
    data: { storageKey: "media:original", url: "/api/files/media%3Aoriginal", width: 1280, height: 720, bytes: 42, mimeType: "video/mp4" },
    metadata: { first: "one", second: { width: 1280, height: 720 } }, createdAt: "2026-01-01", updatedAt: "2026-01-02",
};
let activeSession = session;
let remote: { value: { state: { assets: Asset[] }; version: number }; revision: number };
let requests: string[];
let transport: ((init?: RequestInit) => Promise<Response> | Response) | undefined;
let localDocuments: ReturnType<typeof mockBrowserDocuments>;
let localFiles: ReturnType<typeof mockBrowserFiles>;

function textAsset(id: string): Asset {
    return { id, kind: "text", title: id, coverUrl: "", tags: [], data: { content: id }, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
function commit(init?: RequestInit) {
    const body = JSON.parse(String(init?.body));
    if (body.revision !== remote.revision) return Response.json({ error: { message: "conflict" } }, { status: 409 });
    remote = { value: body.value, revision: remote.revision + 1 };
    return Response.json(remote);
}

beforeEach(async () => {
    endCanvasSession();
    localDocuments = mockBrowserDocuments();
    localFiles = mockBrowserFiles();
    localStorage.clear();
    useAssetStore.setState({ assets: [], hydrated: false });
    activeSession = session;
    remote = { value: { state: { assets: [textAsset("first"), structuredClone(video), textAsset("last")] }, version: 0 }, revision: 1 };
    requests = [];
    transport = undefined;
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/session") return Response.json(activeSession);
        // No delete or undo path may upload, download, or delete a media file.
        if (String(url) !== "/api/data/assets") throw new Error(`Unexpected request: ${url}`);
        requests.push(init?.method || "GET");
        if (transport) return transport(init);
        return init?.method === "PUT" ? commit(init) : Response.json(remote);
    }) as typeof fetch;
    await readCanvasSession();
    await useAssetStore.persist.rehydrate();
});

afterEach(() => {
    endCanvasSession();
    localDocuments.restore();
    localFiles.restore();
    useAssetStore.setState({ assets: [], hydrated: false });
    globalThis.fetch = originalFetch;
});

test("deletion keeps an exact undo receipt and reports success only after the save is confirmed", async () => {
    const started = deferred<void>(), finish = deferred<void>();
    transport = (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        const response = commit(init);
        started.resolve();
        return finish.promise.then(() => response);
    };
    const deleting = useAssetDeleteStore.getState().deleteAsset("video");
    await started.promise;
    expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual(["first", "last"]);
    expect(useAssetDeleteStore.getState().status).toBe("saving");
    expect(useAssetDeleteStore.getState().deleted).toEqual({ asset: video, index: 1, previousId: "first", nextId: "last" });
    await useAssetDeleteStore.getState().deleteAsset("first");
    await useAssetDeleteStore.getState().undoDelete();
    await useAssetDeleteStore.getState().retrySave();
    finish.resolve();
    await deleting;
    expect(useAssetDeleteStore.getState()).toMatchObject({ status: "saved", operation: "delete", error: "" });
    expect(remote.value.state.assets.map((asset) => asset.id)).toEqual(["first", "last"]);
    expect(requests.filter((method) => method === "PUT")).toHaveLength(1);
});

test("failed deletion retains its receipt, blocks replacing it, and retries only the newest document", async () => {
    transport = (init) => init?.method === "PUT" ? new Response("offline", { status: 503 }) : Response.json(remote);
    await useAssetDeleteStore.getState().deleteAsset("video");
    const receipt = useAssetDeleteStore.getState().deleted;
    expect(useAssetDeleteStore.getState().status).toBe("save-error");
    await useAssetDeleteStore.getState().deleteAsset("first");
    expect(useAssetDeleteStore.getState().deleted).toBe(receipt);
    useAssetStore.getState().updateAsset("first", { title: "later edit" });
    const assets = useAssetStore.getState().assets;
    transport = undefined;
    await useAssetDeleteStore.getState().retrySave();
    expect(useAssetDeleteStore.getState().status).toBe("saved");
    expect(useAssetStore.getState().assets).toBe(assets);
    expect(remote.value.state.assets.map((asset) => asset.title)).toEqual(["later edit", "last"]);
    expect(requests.filter((method) => method === "PUT")).toHaveLength(2);
});

test("undo preserves the original identity and media while keeping later additions and edits", async () => {
    await useAssetDeleteStore.getState().deleteAsset("video");
    const added = useAssetStore.getState().addAsset({ kind: "text", title: "new", coverUrl: "", tags: [], data: { content: "new" } });
    useAssetStore.getState().updateAsset("first", { title: "edited first" });
    await flushDocument("assets");
    await useAssetDeleteStore.getState().undoDelete();
    expect(useAssetDeleteStore.getState()).toMatchObject({ status: "saved", operation: "undo", error: "" });
    expect(remote.value.state.assets.map((asset) => asset.id)).toEqual([added, "first", "video", "last"]);
    expect(remote.value.state.assets.find((asset) => asset.id === "video")).toEqual(video);
    expect(remote.value.state.assets.find((asset) => asset.id === "first")?.title).toBe("edited first");
    const count = requests.length;
    await useAssetDeleteStore.getState().undoDelete();
    await useAssetDeleteStore.getState().retrySave();
    expect(requests).toHaveLength(count);
});

test("undo save failure restores once and retrying never inserts a second copy", async () => {
    await useAssetDeleteStore.getState().deleteAsset("video");
    transport = (init) => init?.method === "PUT" ? new Response("offline", { status: 503 }) : Response.json(remote);
    await useAssetDeleteStore.getState().undoDelete();
    expect(useAssetDeleteStore.getState()).toMatchObject({ status: "save-error", operation: "undo" });
    const assets = useAssetStore.getState().assets;
    await useAssetDeleteStore.getState().undoDelete();
    await useAssetDeleteStore.getState().deleteAsset("first");
    transport = undefined;
    await useAssetDeleteStore.getState().retrySave();
    expect(useAssetDeleteStore.getState()).toMatchObject({ status: "saved", operation: "undo" });
    expect(useAssetStore.getState().assets).toBe(assets);
    expect(remote.value.state.assets).toEqual([textAsset("first"), video, textAsset("last")]);
    expect(requests.filter((method) => method === "PUT")).toHaveLength(3);
});

test("undoing an uncertain deletion retains the original record until explicit save recovery", async () => {
    transport = (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        commit(init);
        throw new Error("response lost");
    };
    await useAssetDeleteStore.getState().deleteAsset("video");
    expect(useAssetDeleteStore.getState().status).toBe("save-error");
    await useAssetDeleteStore.getState().undoDelete();
    expect(useAssetDeleteStore.getState()).toMatchObject({ status: "save-error", operation: "undo" });
    expect(useAssetStore.getState().assets.find((asset) => asset.id === "video")).toEqual(video);
    expect(requests.filter((method) => method === "PUT")).toHaveLength(1);
    transport = undefined;
    await useAssetDeleteStore.getState().retrySave();
    expect(useAssetDeleteStore.getState().status).toBe("saved");
    expect(remote.value.state.assets).toEqual([textAsset("first"), video, textAsset("last")]);
    expect(requests.filter((method) => method === "PUT")).toHaveLength(2);
});

test("global recovery can confirm deletion and undo without writing either operation again", async () => {
    for (const operation of ["delete", "undo"] as const) {
        transport = (init) => {
            if (init?.method !== "PUT") return Response.json(remote);
            commit(init);
            throw new Error("response lost");
        };
        if (operation === "delete") await useAssetDeleteStore.getState().deleteAsset("video");
        else await useAssetDeleteStore.getState().undoDelete();
        expect(useAssetDeleteStore.getState().status).toBe("save-error");
        transport = undefined;
        await retryDocument("assets");
        await flushDocument("assets");
        const count = requests.length;
        await useAssetDeleteStore.getState().retrySave();
        expect(useAssetDeleteStore.getState()).toMatchObject({ status: "saved", operation });
        expect(requests).toHaveLength(count);
    }
    expect(remote.value.state.assets).toEqual([textAsset("first"), video, textAsset("last")]);
    expect(requests.filter((method) => method === "PUT")).toHaveLength(2);
});

test("undo refuses to overwrite new content with the same ID and allows unrelated later operations", async () => {
    await useAssetDeleteStore.getState().deleteAsset("video");
    const replacement = { ...video, title: "new content for this ID" };
    useAssetStore.getState().replaceAssets([textAsset("first"), replacement, textAsset("last")]);
    await flushDocument("assets");
    const count = requests.length;
    await useAssetDeleteStore.getState().undoDelete();
    expect(useAssetDeleteStore.getState()).toMatchObject({ status: "error", operation: "delete", error: i18n.t("assets.deleteJobRestoreConflict") });
    expect(useAssetStore.getState().assets.find((asset) => asset.id === "video")).toBe(replacement);
    expect(requests).toHaveLength(count);
    await useAssetDeleteStore.getState().deleteAsset("first");
    await useAssetDeleteStore.getState().undoDelete();
    expect(useAssetDeleteStore.getState().status).toBe("saved");
    expect(remote.value.state.assets.find((asset) => asset.id === "video")).toEqual(replacement);
});

test("a retried deletion never removes a same-ID record that was added after the failed save", async () => {
    transport = (init) => init?.method === "PUT" ? new Response("offline", { status: 503 }) : Response.json(remote);
    await useAssetDeleteStore.getState().deleteAsset("video");
    const replacement = { ...video, title: "new content after failure" };
    useAssetStore.getState().replaceAssets([...useAssetStore.getState().assets, replacement]);
    const count = requests.filter((method) => method === "PUT").length;
    await useAssetDeleteStore.getState().retrySave();
    expect(useAssetDeleteStore.getState()).toMatchObject({ status: "error", error: i18n.t("assets.deleteJobChanged") });
    expect(useAssetStore.getState().assets.find((asset) => asset.id === "video")).toBe(replacement);
    expect(requests.filter((method) => method === "PUT")).toHaveLength(count);
    transport = undefined;
    await retryDocument("assets");
    await useAssetDeleteStore.getState().deleteAsset("first");
    expect(remote.value.state.assets.find((asset) => asset.id === "video")).toEqual(replacement);
});

test("edits during undo saving are kept and are not reported as restoration of the old content", async () => {
    await useAssetDeleteStore.getState().deleteAsset("video");
    const started = deferred<void>(), finish = deferred<void>();
    transport = (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        const response = commit(init);
        started.resolve();
        return finish.promise.then(() => response);
    };
    const undoing = useAssetDeleteStore.getState().undoDelete();
    await started.promise;
    useAssetStore.getState().updateAsset("video", { title: "edited while restoring" });
    finish.resolve();
    await undoing;
    await flushDocument("assets");
    expect(useAssetDeleteStore.getState()).toMatchObject({ status: "error", operation: "undo", error: i18n.t("assets.deleteJobChanged") });
    expect(remote.value.state.assets.find((asset) => asset.id === "video")?.title).toBe("edited while restoring");
    expect(getDocumentSaveState("assets").status).toBe("saved");
    const count = requests.length;
    await useAssetDeleteStore.getState().undoDelete();
    await useAssetDeleteStore.getState().retrySave();
    expect(requests).toHaveLength(count);
});

test("key order, omitted undefined fields and timestamp-only changes do not block an already restored record", async () => {
    await useAssetDeleteStore.getState().deleteAsset("video");
    const restored = {
        ...Object.fromEntries(Object.entries(video).reverse()),
        updatedAt: "2026-02-01",
        metadata: { second: { height: 720, width: 1280 }, first: "one", omitted: undefined },
    } as Asset;
    useAssetStore.getState().replaceAssets([textAsset("first"), restored, textAsset("last")]);
    await flushDocument("assets");
    const count = requests.length;
    await useAssetDeleteStore.getState().undoDelete();
    expect(useAssetDeleteStore.getState()).toMatchObject({ status: "saved", operation: "undo" });
    expect(useAssetStore.getState().assets.find((asset) => asset.id === "video")).toBe(restored);
    expect(remote.value.state.assets.find((asset) => asset.id === "video")?.updatedAt).toBe("2026-02-01");
    expect(requests).toHaveLength(count);
});

test("unauthorized deletion reports an error without leaving the store locked for a later session", async () => {
    endCanvasSession();
    await useAssetDeleteStore.getState().deleteAsset("video");
    expect(useAssetDeleteStore.getState()).toMatchObject({ status: "error", deleted: null, error: i18n.t("saveRecovery.authorizationRequired") });
    expect(requests.filter((method) => method === "PUT")).toHaveLength(0);
    await readCanvasSession();
    await useAssetStore.persist.rehydrate();
    await useAssetDeleteStore.getState().deleteAsset("video");
    expect(useAssetDeleteStore.getState().status).toBe("saved");
});

for (const operation of ["delete", "undo"] as const) {
    test(`a session change clears the ${operation} receipt and ignores its late save response`, async () => {
        if (operation === "undo") await useAssetDeleteStore.getState().deleteAsset("video");
        const started = deferred<void>(), finish = deferred<void>();
        transport = (init) => {
            if (init?.method !== "PUT") return Response.json(remote);
            const response = commit(init);
            started.resolve();
            return finish.promise.then(() => response);
        };
        const pending = operation === "delete" ? useAssetDeleteStore.getState().deleteAsset("video") : useAssetDeleteStore.getState().undoDelete();
        await started.promise;
        endCanvasSession();
        useAssetStore.setState({ assets: [], hydrated: false });
        expect(useAssetDeleteStore.getState()).toMatchObject({ status: "idle", deleted: null, operation: null, error: "" });
        activeSession = { ...session, user: { id: "next-owner", subject: `ics_${"e".repeat(32)}`, username: "next-owner" }, session_tag: "next-delete-session" };
        remote = { value: { state: { assets: [textAsset("next-first"), textAsset("next-last")] }, version: 0 }, revision: 1 };
        transport = undefined;
        await readCanvasSession();
        await useAssetStore.persist.rehydrate();
        await useAssetDeleteStore.getState().deleteAsset("next-first");
        finish.resolve();
        await pending;
        expect(useAssetDeleteStore.getState()).toMatchObject({ status: "saved", operation: "delete", deleted: { asset: { id: "next-first" } } });
        expect(useAssetStore.getState().assets.map((asset) => asset.id)).toEqual(["next-last"]);
        expect(remote.value.state.assets.map((asset) => asset.id)).toEqual(["next-last"]);
    });
}
