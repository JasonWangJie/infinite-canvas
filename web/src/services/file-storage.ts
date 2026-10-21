import { readPrivateBlob } from "@/services/api/canvas-client";
import { deletePrivateFile, fileUrl, uploadPrivateFile } from "@/services/canvas-data";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };
export async function uploadMediaFile(input: string | Blob, _prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await readPrivateBlob(input) : input;
    const file = await uploadPrivateFile(blob, "media");
    const meta = blob.type.startsWith("video/") ? await readMediaMeta(blob, "video") : blob.type.startsWith("audio/") ? await readMediaMeta(blob, "audio") : {};
    return { url: file.url, storageKey: file.storageKey, bytes: file.bytes, mimeType: file.mimeType, ...meta };
}
export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    return storageKey ? fileUrl(storageKey) : /^(blob:|data:|\/api\/files\/)/.test(fallback) ? fallback : "";
}
export async function getMediaBlob(storageKey: string) {
    return readPrivateBlob(fileUrl(storageKey));
}
export async function setMediaBlob(_storageKey: string, blob: Blob) {
    return (await uploadMediaFile(blob)).url;
}
export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all([...new Set(keys)].map(deletePrivateFile));
}
export async function cleanupUnusedMedia(_usedData: unknown) {}
export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => {
        if (Array.isArray(item)) item.forEach((child) => collectMediaStorageKeys(child, keys));
        else collectMediaStorageKeys(item, keys);
    });
    return keys;
}
function readMediaMeta(blob: Blob, kind: "video" | "audio") {
    return new Promise<{ width?: number; height?: number; durationMs?: number }>((resolve) => {
        const media = document.createElement(kind);
        const url = URL.createObjectURL(blob);
        const done = () => {
            const video = media as HTMLVideoElement;
            const meta = { ...(kind === "video" ? { width: video.videoWidth || 1280, height: video.videoHeight || 720 } : {}), durationMs: Number.isFinite(media.duration) ? Math.round(media.duration * 1000) : undefined };
            URL.revokeObjectURL(url);
            resolve(meta);
        };
        media.onloadedmetadata = done;
        media.onerror = done;
        media.src = url;
    });
}
