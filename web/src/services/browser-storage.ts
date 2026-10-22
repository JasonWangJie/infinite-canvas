import localforage from "localforage";
import i18n from "@/i18n";
import { currentSession, onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";

export type BrowserOwner = { subject: string; epoch: number; signal: AbortSignal };
export type BrowserDocument = { value: unknown; revision: number };
const stores = new Map<string, LocalForage>();
let sessionController = new AbortController();

onSessionEnd(() => {
    sessionController.abort();
    sessionController = new AbortController();
    stores.clear();
});

export function captureBrowserOwner(): BrowserOwner {
    const session = currentSession();
    if (!session) throw new Error(i18n.t("saveRecovery.authorizationRequired"));
    return { subject: session.user.subject, epoch: sessionEpoch(), signal: sessionController.signal };
}
export function assertBrowserOwner(owner: BrowserOwner) {
    if (owner.epoch !== sessionEpoch() || currentSession()?.user.subject !== owner.subject) throw new Error(i18n.t("saveRecovery.sessionChanged"));
    owner.signal.throwIfAborted();
}
export function browserStorageKey(owner: BrowserOwner, key: string) {
    return `${owner.subject}:${key}`;
}
export function browserStore(owner: BrowserOwner, storeName: "documents" | "files"): LocalForage {
    assertBrowserOwner(owner);
    if (!globalThis.indexedDB) throw new Error(i18n.t("browserStorage.unavailable"));
    let store = stores.get(storeName);
    if (!store) {
        store = localforage.createInstance({ name: "infinite-canvas", storeName, driver: localforage.INDEXEDDB });
        stores.set(storeName, store);
    }
    return store;
}

export class BrowserDocumentConflict extends Error {
    constructor(message = i18n.t("saveRecovery.conflictDetected")) {
        super(message);
        this.name = "BrowserDocumentConflict";
    }
}

function storedDocument(value: BrowserDocument | null): BrowserDocument {
    if (value === null) return { value: null, revision: 0 };
    if (!value || typeof value !== "object" || !Object.hasOwn(value, "value") || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error(i18n.t("browserStorage.invalidDocument"));
    return value;
}

export async function readBrowserDocument(domain: string, epoch = sessionEpoch(), signal?: AbortSignal): Promise<BrowserDocument> {
    const owner = captureBrowserOwner();
    if (owner.epoch !== epoch) throw new Error(i18n.t("saveRecovery.sessionChanged"));
    signal?.throwIfAborted();
    const value = await browserStore(owner, "documents").getItem<BrowserDocument>(browserStorageKey(owner, domain));
    assertBrowserOwner(owner);
    signal?.throwIfAborted();
    return storedDocument(value);
}

export async function writeBrowserDocument(domain: string, value: unknown, revision: number, epoch = sessionEpoch()): Promise<BrowserDocument> {
    const owner = captureBrowserOwner();
    if (owner.epoch !== epoch) throw new Error(i18n.t("saveRecovery.sessionChanged"));
    const store = browserStore(owner, "documents");
    const locks = globalThis.navigator?.locks;
    if (!locks) throw new Error(i18n.t("browserStorage.writeLockUnavailable"));
    const key = browserStorageKey(owner, domain);
    // localforage's read/write pair needs one cross-tab lock for an atomic revision check.
    return locks.request(`infinite-canvas:documents:${key}`, { mode: "exclusive", signal: owner.signal }, async () => {
        assertBrowserOwner(owner);
        const current = storedDocument(await store.getItem<BrowserDocument>(key));
        assertBrowserOwner(owner);
        if (current.revision !== revision) throw new BrowserDocumentConflict();
        if (!Number.isSafeInteger(revision + 1)) throw new Error(i18n.t("browserStorage.invalidDocument"));
        const document = { value, revision: revision + 1 };
        await store.setItem(key, document);
        assertBrowserOwner(owner);
        return document;
    });
}
