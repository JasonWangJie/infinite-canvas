import { canvasJson, currentSession, onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";

type Document = { value: unknown; revision: number };
const documents = new Map<string, Document>();
const queues = new Map<string, Promise<void>>();
const blocked = new Set<string>();
onSessionEnd(() => {
    documents.clear();
    queues.clear();
    blocked.clear();
});

async function loadDocument(domain: string) {
    if (!currentSession()) return null;
    const requestEpoch = sessionEpoch();
    const doc = await canvasJson<Document>(`/api/data/${encodeURIComponent(domain)}`);
    if (requestEpoch !== sessionEpoch()) throw new Error("登录会话已改变");
    documents.set(domain, doc);
    return doc.value;
}

export async function readDocument(domain: string) {
    await queues.get(domain);
    if (documents.has(domain)) return documents.get(domain)!.value;
    return loadDocument(domain);
}

export function writeDocument(domain: string, value: unknown | ((previous: unknown) => unknown)) {
    if (!currentSession()) return Promise.resolve();
    const requestEpoch = sessionEpoch();
    const write = (queues.get(domain) || Promise.resolve()).then(async () => {
        if (requestEpoch !== sessionEpoch()) return;
        if (blocked.has(domain)) throw new Error("数据已在其他页面更新，请重新加载后再编辑");
        if (!documents.has(domain)) await loadDocument(domain);
        const nextValue = typeof value === "function" ? value(documents.get(domain)?.value) : value;
        const doc = await canvasJson<Document>(`/api/data/${encodeURIComponent(domain)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: nextValue, revision: documents.get(domain)?.revision || 0 }) });
        if (requestEpoch === sessionEpoch()) documents.set(domain, doc);
    });
    queues.set(
        domain,
        write.catch((error) => {
            if (requestEpoch !== sessionEpoch()) return;
            blocked.add(domain);
            window.dispatchEvent(new CustomEvent("canvas-storage-error", { detail: error instanceof Error ? error.message : "保存失败，请重新加载" }));
        }),
    );
    return write;
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

export type PrivateFile = { id: string; storageKey: string; url: string; mimeType: string; bytes: number };
export function fileUrl(storageKey: string) {
    return `/api/files/${encodeURIComponent(storageKey)}`;
}
export async function uploadPrivateFile(blob: Blob, kind: "image" | "media") {
    const body = new FormData();
    body.set("file", blob, kind);
    body.set("kind", kind);
    return canvasJson<PrivateFile>("/api/files", { method: "POST", body });
}
export async function deletePrivateFile(key: string) {
    await canvasJson<void>(fileUrl(key), { method: "DELETE" });
}
