import "./browser";
import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import i18n from "@/i18n";
import * as transfer from "@/pages/assets/asset-transfer";
import { endCanvasSession, readCanvasSession } from "@/services/api/canvas-client";
import { flushDocument, getDocumentSaveState, retryDocument } from "@/services/canvas-data";
import { useAssetImportStore } from "@/stores/use-asset-import-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

const originalFetch = globalThis.fetch;
const session = { user: { id: "import-owner", subject: `ics_${"d".repeat(32)}`, username: "import-owner" }, csrf_token: "csrf", session_tag: "import-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
let remote: { value: { state: { assets: Asset[] }; version: number }; revision: number };
let requests: string[];
let transport: ((init?: RequestInit) => Promise<Response> | Response) | undefined;
let readPackage: ReturnType<typeof spyOn<typeof transfer, "readAssetPackage">>;
let localDocuments: ReturnType<typeof mockBrowserDocuments>;
let localFiles: ReturnType<typeof mockBrowserFiles>;

function asset(title: string): Asset {
    return { id: title, kind: "text", title, coverUrl: "", tags: [], data: { content: title }, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
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
const packageFile = () => new File(["package"], "library.zip");

beforeEach(async () => {
    endCanvasSession();
    localDocuments = mockBrowserDocuments();
    localFiles = mockBrowserFiles();
    localStorage.clear();
    useAssetStore.setState({ assets: [], hydrated: false });
    remote = { value: { state: { assets: [asset("existing")] }, version: 0 }, revision: 1 };
    requests = [];
    transport = undefined;
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/session") return Response.json(session);
        if (String(url) !== "/api/data/assets") throw new Error(`Unexpected request: ${url}`);
        requests.push(init?.method || "GET");
        if (transport) return transport(init);
        return init?.method === "PUT" ? commit(init) : Response.json(remote);
    }) as typeof fetch;
    await readCanvasSession();
    await useAssetStore.persist.rehydrate();
    readPackage = spyOn(transfer, "readAssetPackage").mockResolvedValue([asset("first"), asset("second")]);
});
afterEach(() => {
    readPackage.mockRestore();
    endCanvasSession();
    localDocuments.restore();
    localFiles.restore();
    useAssetStore.setState({ assets: [], hydrated: false });
    globalThis.fetch = originalFetch;
});

test("imports a complete batch atomically and reports success only after saving, rejecting overlapping starts", async () => {
    const parsed = deferred<Asset[]>(), saving = deferred<void>(), finish = deferred<Response>();
    readPackage.mockImplementation((_file, options) => {
        options?.onProgress?.({ phase: "uploading", completed: 1, total: 2, item: "image.png" });
        return parsed.promise;
    });
    transport = (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        const response = commit(init);
        saving.resolve();
        return finish.promise.then(() => response);
    };
    const observed: string[][] = [];
    const unsubscribe = useAssetStore.subscribe((state) => { observed.push(state.assets.map((item) => item.title)); });
    const importing = useAssetImportStore.getState().startImport(packageFile());
    expect(useAssetImportStore.getState().progress).toEqual({ phase: "uploading", completed: 1, total: 2, item: "image.png" });
    await useAssetImportStore.getState().startImport(packageFile());
    expect(useAssetStore.getState().assets.map((item) => item.title)).toEqual(["existing"]);
    parsed.resolve([asset("first"), asset("second")]);
    await saving.promise;
    expect(useAssetImportStore.getState().status).toBe("saving");
    expect(observed).toEqual([["first", "second", "existing"]]);
    await useAssetImportStore.getState().startImport(packageFile());
    finish.resolve(new Response());
    await importing;
    unsubscribe();
    const ids = useAssetImportStore.getState().assetIds;
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain("first");
    expect(remote.value.state.assets.map((item) => item.id)).toEqual([...ids, "existing"]);
    expect(useAssetImportStore.getState().status).toBe("saved");
    expect(readPackage).toHaveBeenCalledTimes(1);
    expect(requests.filter((method) => method === "PUT")).toHaveLength(1);
});

test("save failure retains the batch and retries storage once without parsing, uploading, or adding again", async () => {
    transport = (init) => init?.method === "PUT" ? new Response("offline", { status: 503 }) : Response.json(remote);
    await useAssetImportStore.getState().startImport(packageFile());
    const ids = [...useAssetImportStore.getState().assetIds];
    expect(useAssetImportStore.getState().status).toBe("save-error");
    await useAssetImportStore.getState().startImport(new File(["other"], "other.zip"));
    expect(useAssetImportStore.getState().fileName).toBe("library.zip");
    const saving = deferred<void>(), finish = deferred<void>();
    transport = async (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        saving.resolve();
        await finish.promise;
        return commit(init);
    };
    const retrying = useAssetImportStore.getState().retrySave();
    await saving.promise;
    await useAssetImportStore.getState().retrySave();
    finish.resolve();
    await retrying;
    expect(useAssetImportStore.getState().status).toBe("saved");
    expect(useAssetImportStore.getState().assetIds).toEqual(ids);
    expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual([...ids, "existing"]);
    expect(remote.value.state.assets.map((item) => item.id)).toEqual([...ids, "existing"]);
    expect(readPackage).toHaveBeenCalledTimes(1);
    expect(requests.filter((method) => method === "PUT")).toHaveLength(2);
});

test("recognizes a batch already saved by global recovery without sending it again", async () => {
    transport = (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        commit(init);
        throw new Error("response lost");
    };
    await useAssetImportStore.getState().startImport(packageFile());
    expect(useAssetImportStore.getState().status).toBe("save-error");
    transport = undefined;
    await retryDocument("assets");
    await flushDocument("assets");
    expect(getDocumentSaveState("assets").status).toBe("saved");
    const count = requests.length;
    await useAssetImportStore.getState().retrySave();
    expect(useAssetImportStore.getState().status).toBe("saved");
    expect(requests).toHaveLength(count);
    expect(readPackage).toHaveBeenCalledTimes(1);
    expect(remote.value.state.assets).toHaveLength(3);
});

test("deleted imported assets are not restored, and unresolved save errors block uploading another package", async () => {
    transport = (init) => init?.method === "PUT" ? new Response("offline", { status: 503 }) : Response.json(remote);
    await useAssetImportStore.getState().startImport(packageFile());
    const deletedId = useAssetImportStore.getState().assetIds[0];
    useAssetStore.getState().replaceAssets(useAssetStore.getState().assets.filter((item) => item.id !== deletedId));
    await useAssetImportStore.getState().retrySave();
    expect(useAssetImportStore.getState().status).toBe("error");
    expect(useAssetImportStore.getState().error).toBe(i18n.t("assets.importJobBatchChanged"));
    await useAssetImportStore.getState().startImport(packageFile());
    expect(useAssetImportStore.getState().error).toBe(i18n.t("assets.importJobRecoveryRequired"));
    expect(readPackage).toHaveBeenCalledTimes(1);
    transport = undefined;
    await retryDocument("assets");
    expect(remote.value.state.assets.some((item) => item.id === deletedId)).toBe(false);
});

test("deleting part of a batch during its retry does not report complete success or undo the deletion", async () => {
    transport = (init) => init?.method === "PUT" ? new Response("offline", { status: 503 }) : Response.json(remote);
    await useAssetImportStore.getState().startImport(packageFile());
    const deletedId = useAssetImportStore.getState().assetIds[0];
    const saving = deferred<void>(), finish = deferred<void>();
    transport = async (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        saving.resolve();
        await finish.promise;
        return commit(init);
    };
    const retrying = useAssetImportStore.getState().retrySave();
    await saving.promise;
    useAssetStore.getState().replaceAssets(useAssetStore.getState().assets.filter((item) => item.id !== deletedId));
    finish.resolve();
    await retrying;
    expect(useAssetImportStore.getState().status).toBe("error");
    expect(useAssetImportStore.getState().error).toBe(i18n.t("assets.importJobBatchChanged"));
    expect(remote.value.state.assets.some((item) => item.id === deletedId)).toBe(false);
    expect(readPackage).toHaveBeenCalledTimes(1);
});

test("an empty package changes no assets and permits a different package", async () => {
    readPackage.mockResolvedValueOnce([]);
    await useAssetImportStore.getState().startImport(packageFile());
    expect(useAssetImportStore.getState().status).toBe("error");
    expect(useAssetImportStore.getState().error).toBe(i18n.t("assets.importJobEmpty"));
    expect(useAssetStore.getState().assets.map((item) => item.id)).toEqual(["existing"]);
    expect(requests.filter((method) => method === "PUT")).toHaveLength(0);
    await useAssetImportStore.getState().startImport(packageFile());
    expect(useAssetImportStore.getState().status).toBe("saved");
    expect(readPackage).toHaveBeenCalledTimes(2);
});

test("session changes discard late parsing and progress without overwriting a new session import", async () => {
    const parsed = deferred<Asset[]>();
    let lateProgress: ((progress: transfer.AssetImportProgress) => void) | undefined;
    readPackage.mockImplementationOnce((_file, options) => {
        lateProgress = options?.onProgress;
        return parsed.promise;
    });
    const oldImport = useAssetImportStore.getState().startImport(packageFile());
    endCanvasSession();
    useAssetStore.setState({ assets: [], hydrated: false });
    expect(useAssetImportStore.getState().status).toBe("idle");
    await readCanvasSession();
    await useAssetStore.persist.rehydrate();
    await useAssetImportStore.getState().startImport(new File(["new"], "new.zip"));
    const ids = [...useAssetImportStore.getState().assetIds];
    lateProgress?.({ phase: "uploading", completed: 10, total: 10 });
    parsed.resolve([asset("stale")]);
    await oldImport;
    expect(useAssetImportStore.getState().fileName).toBe("new.zip");
    expect(useAssetImportStore.getState().status).toBe("saved");
    expect(useAssetImportStore.getState().assetIds).toEqual(ids);
    expect(useAssetStore.getState().assets.map((item) => item.title)).toEqual(["first", "second", "existing"]);
    expect(requests.filter((method) => method === "PUT")).toHaveLength(1);
});

test("session ending during a save clears the receipt and ignores the late response", async () => {
    const saving = deferred<void>(), finish = deferred<Response>();
    transport = (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        const response = commit(init);
        saving.resolve();
        return finish.promise.then(() => response);
    };
    const importing = useAssetImportStore.getState().startImport(packageFile());
    await saving.promise;
    endCanvasSession();
    useAssetStore.setState({ assets: [], hydrated: false });
    finish.resolve(new Response());
    await importing;
    expect(useAssetImportStore.getState().status).toBe("idle");
    expect(useAssetImportStore.getState().assetIds).toEqual([]);
    expect(useAssetImportStore.getState().fileName).toBe("");
    expect(useAssetStore.getState().assets).toEqual([]);
});
