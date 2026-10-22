import { spyOn } from "bun:test";
import * as storage from "@/services/browser-storage";
import { sessionEpoch } from "@/services/api/canvas-client";

// Existing controlled document fixtures also exercise local CAS, failures and late completions.
// Only tests translate this storage boundary to a fetch-shaped fixture; production stays in IndexedDB.
export function mockBrowserDocuments(transport?: typeof fetch) {
    const read = spyOn(storage, "readBrowserDocument").mockImplementation(async (domain, epoch = sessionEpoch(), signal) => {
        const owner = storage.captureBrowserOwner();
        if (owner.epoch !== epoch) throw new Error("登录会话已改变");
        signal?.throwIfAborted();
        const response = await (transport || globalThis.fetch)(`/api/data/${encodeURIComponent(domain)}`, { signal: signal ? AbortSignal.any([signal, owner.signal]) : owner.signal });
        storage.assertBrowserOwner(owner);
        signal?.throwIfAborted();
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            storage.assertBrowserOwner(owner);
            throw new Error(body.error?.message || `请求失败（${response.status}）`);
        }
        const document = await response.json() as storage.BrowserDocument;
        storage.assertBrowserOwner(owner);
        signal?.throwIfAborted();
        return document;
    });
    const write = spyOn(storage, "writeBrowserDocument").mockImplementation(async (domain, value, revision, epoch = sessionEpoch()) => {
        const owner = storage.captureBrowserOwner();
        if (owner.epoch !== epoch) throw new Error("登录会话已改变");
        const response = await (transport || globalThis.fetch)(`/api/data/${encodeURIComponent(domain)}`, { method: "PUT", body: JSON.stringify({ value, revision }), signal: owner.signal });
        storage.assertBrowserOwner(owner);
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            storage.assertBrowserOwner(owner);
            if (response.status === 409) throw new storage.BrowserDocumentConflict(body.error?.message);
            throw new Error(body.error?.message || `保存失败（${response.status}）`);
        }
        const document = await response.json() as storage.BrowserDocument;
        storage.assertBrowserOwner(owner);
        return document;
    });
    return { restore: () => { read.mockRestore(); write.mockRestore(); } };
}
