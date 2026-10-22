import i18n from "@/i18n";
import { currentSession, onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";
import { BrowserDocumentConflict, readBrowserDocument, writeBrowserDocument } from "@/services/browser-storage";

type Document = { value: unknown; revision: number };
type Update = { value: unknown | ((previous: unknown) => unknown) };
export type DocumentSaveState = { domain: string; status: "idle" | "pending" | "saving" | "saved" | "error" | "conflict"; error?: string; updatedAt?: number };
type Draft = {
    document?: Document;
    value?: unknown;
    dirty: boolean;
    changes: number;
    pending: Update[];
    attempt?: { value: unknown; revision: number; resolution?: boolean; changes?: number };
    issue?: { message: string; conflict: boolean };
};
const drafts = new Map<string, Draft>();
const queues = new Map<string, Promise<void>>();
const reads = new Map<string, Promise<Document>>();
const states = new Map<string, DocumentSaveState>();
const listeners = new Set<() => void>();
let snapshots: DocumentSaveState[] = [];

export function subscribeDocumentSaves(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function getDocumentSaveState(domain: string): DocumentSaveState {
    let state = states.get(domain);
    if (!state) {
        state = { domain, status: "idle" };
        states.set(domain, state);
    }
    return state;
}
export function getDocumentSaveStates() {
    return snapshots;
}
function publish(domain: string, status: DocumentSaveState["status"], error?: string, savedAt?: number) {
    const previous = getDocumentSaveState(domain);
    const updatedAt = savedAt ?? previous.updatedAt;
    if (previous.status === status && previous.error === error && previous.updatedAt === updatedAt) {
        // Failed saves can still append new results to the retained draft. Notify
        // draft readers without changing the stable save-state snapshot.
        if (status === "error" || status === "conflict") listeners.forEach((listener) => listener());
        return;
    }
    states.set(domain, { domain, status, ...(error ? { error } : {}), ...(updatedAt ? { updatedAt } : {}) });
    snapshots = [...states.values()].filter((state) => state.status !== "idle");
    listeners.forEach((listener) => listener());
}
onSessionEnd(() => {
    drafts.clear();
    queues.clear();
    reads.clear();
    states.clear();
    snapshots = [];
    listeners.forEach((listener) => listener());
});
function assertSession(epoch = sessionEpoch()) {
    if (!currentSession()) throw new Error(i18n.t("saveRecovery.authorizationRequired"));
    if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
}
function draftFor(domain: string) {
    let draft = drafts.get(domain);
    if (!draft) {
        draft = { dirty: false, changes: 0, pending: [] };
        drafts.set(domain, draft);
    }
    return draft;
}
export function equalDocument(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && equalDocument(a[key], b[key]));
}
function applyPending(draft: Draft, through?: Update) {
    while (draft.pending.length) {
        const update = draft.pending[0];
        const value = typeof update.value === "function" ? update.value(draft.dirty ? draft.value : draft.document?.value) : update.value;
        // Store updates are immutable; retain their references until the debounced send.
        draft.value = value;
        draft.dirty = true;
        draft.pending.shift();
        if (update === through) break;
    }
}
async function loadDocument(domain: string): Promise<Document> {
    assertSession();
    const pending = reads.get(domain);
    if (pending) return pending;
    const epoch = sessionEpoch();
    const read = readBrowserDocument(domain, epoch)
        .then((doc) => {
            assertSession(epoch);
            const draft = draftFor(domain);
            draft.document = doc;
            if (!draft.dirty) draft.value = doc.value;
            if (!draft.dirty && !draft.pending.length && !draft.issue) publish(domain, "saved");
            return doc;
        })
        .finally(() => { if (reads.get(domain) === read) reads.delete(domain); });
    reads.set(domain, read);
    return read;
}
export async function readDocument(domain: string) {
    if (!currentSession()) return null;
    const epoch = sessionEpoch();
    await queues.get(domain);
    assertSession(epoch);
    const draft = draftFor(domain);
    if (draft.dirty) return draft.value;
    return (draft.document || await loadDocument(domain)).value;
}
// A fresh browser snapshot for read-only lists. It never changes an editor's write baseline.
export async function readSavedDocument(domain: string, signal?: AbortSignal) {
    const epoch = sessionEpoch();
    assertSession(epoch);
    const document = await readBrowserDocument(domain, epoch, signal);
    assertSession(epoch);
    return document.value;
}
export function getDocumentDraft(domain: string) {
    const draft = drafts.get(domain);
    return draft?.dirty ? draft.value : draft?.document?.value;
}
export function getDocumentBaseline(domain: string) {
    return drafts.get(domain)?.document?.value;
}
// Explicitly reopen a saved document for editing. Read-only task lists must not
// call this: adopting a newer revision also requires replacing the editor state.
export function reloadSavedDocument(domain: string, validate: (value: unknown) => void, apply: (value: unknown) => void, signal?: AbortSignal) {
    return enqueue(domain, async (draft, epoch) => {
        signal?.throwIfAborted();
        if (draft.dirty || draft.pending.length || draft.issue) throw new Error(i18n.t("taskCenter.unsavedTarget"));
        const changes = draft.changes;
        const remote = await readBrowserDocument(domain, epoch, signal);
        assertSession(epoch);
        signal?.throwIfAborted();
        if (draft.changes !== changes || draft.dirty || draft.pending.length || draft.issue) throw new Error(i18n.t("taskCenter.unsavedTarget"));
        validate(remote.value);
        draft.document = remote;
        draft.value = remote.value;
        apply(remote.value);
        publish(domain, "saved");
        return remote.value;
    });
}
function enqueue<T>(domain: string, operation: (draft: Draft, epoch: number) => Promise<T>): Promise<T> {
    const epoch = sessionEpoch();
    const request = (queues.get(domain) || Promise.resolve()).then(async () => {
        assertSession(epoch);
        return operation(draftFor(domain), epoch);
    });
    const settled = request.then(() => {}, () => {});
    queues.set(domain, settled);
    void settled.finally(() => { if (queues.get(domain) === settled) queues.delete(domain); });
    return request;
}
function reportFailure(domain: string, draft: Draft, error: unknown, epoch: number) {
    if (epoch !== sessionEpoch() || !currentSession()) return;
    const message = error instanceof Error ? error.message : i18n.t("saveRecovery.saveFailedRetained");
    draft.issue = { message, conflict: draft.issue?.conflict || false };
    publish(domain, draft.issue.conflict ? "conflict" : "error", message);
}
async function sendDocument(domain: string, value: unknown, revision: number, epoch: number): Promise<Document> {
    try {
        const result = await writeBrowserDocument(domain, value, revision, epoch);
        assertSession(epoch);
        return result;
    } catch (error) {
        assertSession(epoch);
        if (error instanceof BrowserDocumentConflict) draftFor(domain).issue = { message: error.message, conflict: true };
        throw error;
    }
}
async function saveDraft(domain: string, draft: Draft, epoch: number, through?: Update) {
    try {
        if (draft.document) applyPending(draft, through);
        if (draft.issue) throw new Error(draft.issue.conflict ? i18n.t("saveRecovery.conflictDetected") : draft.issue.message);
        if (!draft.document) {
            await loadDocument(domain);
            assertSession(epoch);
            applyPending(draft, through);
        }
        if (!draft.dirty || equalDocument(draft.value, draft.document!.value)) {
            draft.dirty = false;
            publish(domain, draft.pending.length ? "pending" : "saved");
            return;
        }
        const changes = draft.changes;
        // Isolate only the actual submitted snapshot, not every drag or text edit.
        const attempt = { value: JSON.parse(JSON.stringify(draft.value)), revision: draft.document!.revision };
        draft.attempt = attempt;
        publish(domain, "saving");
        const doc = await sendDocument(domain, attempt.value, attempt.revision, epoch);
        draft.document = doc;
        draft.attempt = undefined;
        if (draft.changes === changes && !draft.pending.length) {
            draft.value = doc.value;
            draft.dirty = false;
            publish(domain, "saved", undefined, Date.now());
        } else publish(domain, "pending");
    } catch (error) {
        reportFailure(domain, draft, error, epoch);
        throw error;
    }
}
export function writeDocument(domain: string, value: Update["value"]) {
    try { assertSession(); } catch (error) { return Promise.reject(error); }
    const draft = draftFor(domain);
    const update = { value };
    draft.pending.push(update);
    draft.changes += 1;
    if (!draft.issue) publish(domain, "pending");
    return enqueue(domain, (current, epoch) => saveDraft(domain, current, epoch, update));
}
// Canvas uses this to expose its existing debounced edits immediately, without sending early.
export function stageDocument(domain: string, value: unknown) {
    assertSession();
    const draft = draftFor(domain);
    draft.pending.push({ value });
    draft.changes += 1;
    if (draft.document) applyPending(draft);
    if (!draft.issue) publish(domain, "pending");
}
export function flushDocument(domain: string) {
    try { assertSession(); } catch (error) { return Promise.reject(error); }
    return enqueue(domain, (draft, epoch) => saveDraft(domain, draft, epoch));
}
// Drain edits added while a previous save was in flight; never resolve a conflict implicitly.
export async function flushAllDocuments() {
    const epoch = sessionEpoch();
    while (true) {
        assertSession(epoch);
        const pending = [...drafts].filter(([, draft]) => draft.dirty || draft.pending.length || draft.issue).map(([domain]) => domain);
        if (!pending.length && !queues.size) return;
        const results = await Promise.allSettled([...queues.values(), ...pending.map(flushDocument)]);
        assertSession(epoch);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
    }
}
export function retryDocument(domain: string) {
    return enqueue(domain, async (draft, epoch) => {
        try {
            const remote = await readBrowserDocument(domain, epoch);
            assertSession(epoch);
            if (draft.document && (remote.revision !== draft.document.revision || !equalDocument(remote.value, draft.document.value))) {
                if (!draft.attempt || draft.attempt.resolution || !equalDocument(remote.value, draft.attempt.value)) {
                    draft.issue = { message: i18n.t("saveRecovery.conflictDetected"), conflict: true };
                    throw new Error(draft.issue.message);
                }
            }
            const confirmed = draft.attempt && equalDocument(remote.value, draft.attempt.value);
            draft.document = remote;
            draft.attempt = undefined;
            draft.issue = undefined;
            applyPending(draft);
            await saveDraft(domain, draft, epoch);
            if (confirmed && !draft.dirty && !draft.pending.length) publish(domain, "saved", undefined, Date.now());
        } catch (error) {
            reportFailure(domain, draft, error, epoch);
            throw error;
        }
    });
}
// Only an explicit merge may resolve conflicts. The caller must retain remote records.
export function resolveDocumentConflict(domain: string, merge: (remote: unknown, local: unknown) => unknown) {
    return enqueue(domain, async (draft, epoch) => {
        try {
            if (!draft.issue?.conflict) throw new Error(i18n.t("saveRecovery.noConflict"));
            if (draft.document) applyPending(draft);
            const changes = draft.changes;
            const remote = await readBrowserDocument(domain, epoch);
            assertSession(epoch);
            if (changes !== draft.changes) throw new Error(i18n.t("saveRecovery.newEditsDuringRecovery"));
            const previous = draft.attempt;
            let saved: Document;
            if (previous?.resolution && previous.changes === changes && equalDocument(remote.value, previous.value)) {
                // A successful copy whose response was lost is still the same user action.
                saved = remote;
            } else {
                const value = JSON.parse(JSON.stringify(merge(remote.value, draft.value)));
                draft.attempt = { value, revision: remote.revision, resolution: true, changes };
                publish(domain, "saving");
                saved = await sendDocument(domain, value, remote.revision, epoch);
            }
            if (changes !== draft.changes) throw new Error(i18n.t("saveRecovery.copySavedWithNewEdits"));
            draft.document = saved;
            draft.value = saved.value;
            draft.dirty = false;
            draft.attempt = undefined;
            draft.issue = undefined;
            publish(domain, "saved", undefined, Date.now());
            return saved.value;
        } catch (error) {
            reportFailure(domain, draft, error, epoch);
            throw error;
        }
    });
}

export function createRecordStore(domain: string) {
    return {
        async getItem<T>(key: string): Promise<T | null> {
            const value = (await readDocument(domain)) as Record<string, T> | null;
            return value?.[key] ?? null;
        },
        async setItem<T>(key: string, value: T): Promise<T> {
            await writeDocument(domain, (stored: unknown) => ({ ...((stored as Record<string, unknown>) || {}), [key]: value }));
            return value;
        },
        async removeItem(key: string) {
            await writeDocument(domain, (stored: unknown) => {
                const next = { ...((stored as Record<string, unknown>) || {}) };
                delete next[key];
                return next;
            });
        },
        async iterate<T, R>(callback: (value: T, key: string, iteration: number) => R) {
            const stored = (await readDocument(domain)) as Record<string, T> | null;
            let index = 0;
            for (const [key, value] of Object.entries(stored || {})) callback(value, key, ++index);
        },
    };
}

// Keep the existing storage API while all user files now live in this browser.
export { type BrowserFile as PrivateFile, localFileUrl as fileUrl, writeBrowserFile as uploadPrivateFile, deleteBrowserFile as deletePrivateFile } from "@/services/browser-files";
