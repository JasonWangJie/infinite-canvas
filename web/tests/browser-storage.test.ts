import "./browser";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import localforage from "localforage";
import { browserTestLocks } from "./browser-storage-fixture";
import { endCanvasSession, readCanvasSession } from "../src/services/api/canvas-client";
import { BrowserDocumentConflict, browserStorageKey, browserStore, captureBrowserOwner, readBrowserDocument, writeBrowserDocument } from "../src/services/browser-storage";
import { readBrowserFile, resolveBrowserFileUrl, writeBrowserFile } from "../src/services/browser-files";
import { getDocumentBaseline, getDocumentDraft, getDocumentSaveState, readDocument, readSavedDocument, retryDocument, writeDocument } from "../src/services/canvas-data";
import { hydrateCanvasImages } from "../src/lib/canvas/canvas-generation-helpers";
import type { CanvasNodeData } from "../src/types/canvas";
import { readImageTaskRecords, recoverImageTaskRecords, saveImageTaskRecord, type ImageTaskRecord } from "../src/services/image-task-records";
import { refreshImageTask } from "../src/services/api/image-tasks";

const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let subject = `ics_${"a".repeat(32)}`;
let requests: string[];
let locks: LockManager;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
async function login(owner: string) {
    endCanvasSession();
    subject = owner;
    await readCanvasSession();
}

beforeEach(async () => {
    endCanvasSession();
    localStorage.clear();
    requests = [];
    locks = browserTestLocks();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test", locks } });
    globalThis.fetch = (async (url) => {
        requests.push(String(url));
        if (String(url) !== "/api/session") throw new Error(`Browser persistence must not use HTTP: ${String(url)}`);
        return Response.json({ user: { id: subject, subject, username: "local-owner" }, csrf_token: "csrf", session_tag: subject, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }) as typeof fetch;
    await login(`ics_${"a".repeat(32)}`);
    await browserStore(captureBrowserOwner(), "documents").clear();
    await browserStore(captureBrowserOwner(), "files").clear();
});
afterEach(() => {
    endCanvasSession();
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    expect(requests.every((url) => url === "/api/session")).toBe(true);
});

test("documents persist in IndexedDB across logout and remain isolated by account", async () => {
    const first = subject;
    await writeBrowserDocument("assets", [{ id: "first-owner-asset" }], 0);
    const otherTab = localforage.createInstance({ name: "infinite-canvas", storeName: "documents", driver: localforage.INDEXEDDB });
    expect(await otherTab.getItem(`${first}:assets`)).toEqual({ value: [{ id: "first-owner-asset" }], revision: 1 });
    await login(`ics_${"b".repeat(32)}`);
    expect(await readBrowserDocument("assets")).toEqual({ value: null, revision: 0 });
    await writeBrowserDocument("assets", [{ id: "second-owner-asset" }], 0);
    await login(first);
    expect(await readBrowserDocument("assets")).toEqual({ value: [{ id: "first-owner-asset" }], revision: 1 });
});

test("concurrent writers with the same revision cannot overwrite each other", async () => {
    const results = await Promise.allSettled([
        writeBrowserDocument("canvas", { title: "tab A" }, 0),
        writeBrowserDocument("canvas", { title: "tab B" }, 0),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BrowserDocumentConflict);
    const fulfilled = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<unknown>;
    expect(await readBrowserDocument("canvas")).toEqual(fulfilled.value);
});

test("a fresh local read does not advance an editor baseline or overwrite another tab", async () => {
    await writeBrowserDocument("canvas", { title: "original" }, 0);
    await readDocument("canvas");
    await writeBrowserDocument("canvas", { title: "other tab" }, 1);
    expect(await readSavedDocument("canvas")).toEqual({ title: "other tab" });
    expect(getDocumentBaseline("canvas")).toEqual({ title: "original" });
    await expect(writeDocument("canvas", { title: "local draft" })).rejects.toBeInstanceOf(BrowserDocumentConflict);
    expect(getDocumentDraft("canvas")).toEqual({ title: "local draft" });
    expect(getDocumentSaveState("canvas").status).toBe("conflict");
    expect(await readBrowserDocument("canvas")).toEqual({ value: { title: "other tab" }, revision: 2 });
});

test("unsupported Web Locks retains drafts and permits explicit recovery after support returns", async () => {
    await writeBrowserDocument("assets", [], 0);
    await readDocument("assets");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test" } });
    await expect(writeDocument("assets", [{ id: "unsaved" }])).rejects.toThrow();
    expect(getDocumentSaveState("assets").status).toBe("error");
    expect(getDocumentDraft("assets")).toEqual([{ id: "unsaved" }]);
    expect(await readBrowserDocument("assets")).toEqual({ value: [], revision: 1 });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test", locks } });
    await retryDocument("assets");
    expect(await readBrowserDocument("assets")).toEqual({ value: [{ id: "unsaved" }], revision: 2 });
});

test("an IndexedDB write failure preserves saved data and retry applies a functional edit once", async () => {
    await writeBrowserDocument("assets", [], 0);
    await readDocument("assets");
    let updates = 0;
    const put = spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => { throw new DOMException("quota reached", "QuotaExceededError"); });
    try {
        await expect(writeDocument("assets", (previous: unknown) => { updates += 1; return [...previous as string[], "one"]; })).rejects.toThrow("quota reached");
    } finally { put.mockRestore(); }
    expect(getDocumentDraft("assets")).toEqual(["one"]);
    expect(getDocumentSaveState("assets").status).toBe("error");
    expect(await readBrowserDocument("assets")).toEqual({ value: [], revision: 1 });
    await retryDocument("assets");
    expect(updates).toBe(1);
    expect(await readBrowserDocument("assets")).toEqual({ value: ["one"], revision: 2 });
});

test("logout invalidates a queued write without saving into either account", async () => {
    const first = subject;
    const owner = captureBrowserOwner();
    const held = deferred<void>();
    const started = deferred<void>();
    const blocker = locks.request(`infinite-canvas:documents:${browserStorageKey(owner, "assets")}`, { mode: "exclusive" }, async () => { started.resolve(); await held.promise; });
    await started.promise;
    const writing = writeBrowserDocument("assets", ["private draft"], 0);
    const result = writing.then(() => null, (error: unknown) => error);
    await login(`ics_${"b".repeat(32)}`);
    held.resolve();
    await blocker;
    expect(await result).toBeInstanceOf(Error);
    expect(await readBrowserDocument("assets")).toEqual({ value: null, revision: 0 });
    await login(first);
    expect(await readBrowserDocument("assets")).toEqual({ value: null, revision: 0 });
});

test("a late IndexedDB read cannot reveal the previous account after switching sessions", async () => {
    await writeBrowserDocument("assets", ["private asset"], 0);
    const store = browserStore(captureBrowserOwner(), "documents");
    const finish = deferred<unknown>();
    const get = spyOn(store, "getItem").mockImplementationOnce(async <T>() => await finish.promise as T | null);
    const reading = readBrowserDocument("assets");
    const result = reading.then(() => null, (error: unknown) => error);
    await login(`ics_${"b".repeat(32)}`);
    finish.resolve({ value: ["private asset"], revision: 1 });
    try { expect(await result).toBeInstanceOf(Error); } finally { get.mockRestore(); }
    expect(await readBrowserDocument("assets")).toEqual({ value: null, revision: 0 });
});

test("media blobs stay in IndexedDB after logout and cannot be read by a different account", async () => {
    const first = subject;
    const blob = new Blob(["saved browser bytes"], { type: "video/mp4" });
    const file = await writeBrowserFile(blob, "media");
    expect(file.storageKey).toStartWith("media:");
    expect(file.bytes).toBe(blob.size);
    expect(file.mimeType).toBe("video/mp4");
    expect(await (await readBrowserFile(file.storageKey)).text()).toBe("saved browser bytes");
    await login(`ics_${"b".repeat(32)}`);
    await expect(readBrowserFile(file.storageKey)).rejects.toThrow();
    expect(await resolveBrowserFileUrl(file.storageKey)).toBe("");
    await login(first);
    const restored = await readBrowserFile(file.storageKey);
    expect(restored.type).toBe("video/mp4");
    expect(await restored.text()).toBe("saved browser bytes");
});

test("logout revokes cached media URLs and the same saved blob receives a new URL on return", async () => {
    const first = subject;
    let created = 0;
    const create = spyOn(URL, "createObjectURL").mockImplementation(() => `blob:https://canvas.example/${++created}`);
    const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
        const file = await writeBrowserFile(new Blob(["image bytes"], { type: "image/png" }), "image");
        expect(await resolveBrowserFileUrl(file.storageKey)).toBe(file.url);
        expect(create).toHaveBeenCalledTimes(1);
        await login(first);
        expect(revoke).toHaveBeenCalledWith(file.url);
        const restoredUrl = await resolveBrowserFileUrl(file.storageKey);
        expect(restoredUrl).not.toBe(file.url);
        expect(create).toHaveBeenCalledTimes(2);
        expect(await resolveBrowserFileUrl(file.storageKey)).toBe(restoredUrl);
    } finally {
        endCanvasSession();
        create.mockRestore();
        revoke.mockRestore();
    }
});

test("saved plugin video and image nodes restore their files after session URLs expire", async () => {
    const owner = subject;
    const video = await writeBrowserFile(new Blob(["plugin video bytes"], { type: "video/mp4" }), "media");
    const image = await writeBrowserFile(new Blob(["image bytes"], { type: "image/png" }), "image");
    const nodes: CanvasNodeData[] = [
        { id: "plugin-video", type: "demo:video", title: "Plugin video", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: video.storageKey, content: video.url } },
        { id: "image-grid", type: "image", title: "Image grid", position: { x: 100, y: 0 }, width: 100, height: 100, metadata: { storageKey: image.storageKey, content: "", images: [{ id: "image", storageKey: image.storageKey, content: "", status: "success", naturalWidth: 10, naturalHeight: 10, bytes: image.bytes, mimeType: image.mimeType }] } },
    ];
    await writeBrowserDocument("canvas", nodes, 0);
    await login(owner);
    const saved = (await readBrowserDocument("canvas")).value as CanvasNodeData[];
    const restored = await hydrateCanvasImages(saved);
    expect(restored[0].metadata?.storageKey).toBe(video.storageKey);
    expect(restored[0].metadata?.content).toBe(await resolveBrowserFileUrl(video.storageKey));
    expect(restored[0].metadata?.content).not.toBe(video.url);
    expect(restored[1].metadata?.content).toBe(await resolveBrowserFileUrl(image.storageKey));
    expect(restored[1].metadata?.images?.[0].content).toBe(restored[1].metadata?.content);
    expect(await browserStore(captureBrowserOwner(), "files").keys()).toHaveLength(2);
    expect(await (await readBrowserFile(video.storageKey)).text()).toBe("plugin video bytes");
});

test("image task recovery merges independent tab changes while retaining a paid result and remote deletions", async () => {
    const intent: ImageTaskRecord = { id: "intent-a", task_id: null, status: "submitting", value: { model: "image-a" } };
    const removed: ImageTaskRecord = { id: "removed", task_id: "old-task", status: "pending", value: {} };
    await saveImageTaskRecord(intent, true);
    await saveImageTaskRecord(removed, true);
    const other: ImageTaskRecord = { id: "intent-b", task_id: "paid-b", status: "pending", value: { model: "image-b" } };
    const before = await readBrowserDocument("image-tasks");
    // A second writer uses the same physical document without changing this tab's baseline.
    await writeBrowserDocument("image-tasks", { [intent.id]: intent, [other.id]: other }, before.revision);
    const received: ImageTaskRecord = { ...intent, task_id: "paid-a", status: "storage_failed", value: { ...intent.value, result: { data: [{ url: "/api/result-media/paid-a" }] } } };
    await expect(saveImageTaskRecord(received)).rejects.toBeInstanceOf(BrowserDocumentConflict);
    expect(getDocumentSaveState("image-tasks").status).toBe("conflict");
    const recovered = { ...received, status: "succeeded" };
    expect(await refreshImageTask(received)).toEqual(recovered);
    expect(await readImageTaskRecords()).toEqual({ [intent.id]: recovered, [other.id]: other });
    expect((await readBrowserDocument("image-tasks")).value).toEqual({ [intent.id]: recovered, [other.id]: other });
    expect(getDocumentSaveState("image-tasks").status).toBe("saved");
});

for (const change of ["changed", "deleted"] as const) {
    test(`image task recovery retains conflicts when the same task was ${change} in another tab`, async () => {
        const intent: ImageTaskRecord = { id: "intent", task_id: null, status: "submitting", value: { model: "image" } };
        await saveImageTaskRecord(intent, true);
        const remote = change === "deleted" ? {} : { [intent.id]: { ...intent, task_id: "other-result", status: "succeeded", value: { result: { data: [{ url: "/api/result-media/other" }] } } } };
        await writeBrowserDocument("image-tasks", remote, (await readBrowserDocument("image-tasks")).revision);
        const received = { ...intent, task_id: "paid-result", status: "pending" };
        await expect(saveImageTaskRecord(received)).rejects.toBeInstanceOf(BrowserDocumentConflict);
        await expect(recoverImageTaskRecords()).rejects.toThrow();
        expect((await readBrowserDocument("image-tasks")).value).toEqual(remote);
        expect(getDocumentSaveState("image-tasks").status).toBe("conflict");
        expect(getDocumentDraft("image-tasks")).toEqual({ [intent.id]: received });
    });
}

test("malformed image task documents fail explicitly without overwriting stored data", async () => {
    const valid: ImageTaskRecord = { id: "task", task_id: null, status: "submitting", value: {} };
    const malformed = [[], { task: { ...valid, id: "different" } }, { task: { ...valid, value: null } }, { task: { ...valid, status: 1 } }, { task: { ...valid, task_id: {} } }];
    for (const value of malformed) {
        await login(subject);
        const before = await readBrowserDocument("image-tasks");
        const saved = await writeBrowserDocument("image-tasks", value, before.revision);
        await expect(readImageTaskRecords()).rejects.toThrow();
        await expect(saveImageTaskRecord(valid, true)).rejects.toThrow();
        expect(await readBrowserDocument("image-tasks")).toEqual(saved);
    }
});
