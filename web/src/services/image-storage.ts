import i18n from "@/i18n";
import { createImageThumbnail } from "@/lib/image-thumbnail";
import { onSessionEnd, readPrivateBlob, sessionEpoch } from "@/services/api/canvas-client";
import { deletePrivateFile, fileUrl, uploadPrivateFile } from "@/services/canvas-data";

export type UploadedImage = { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string };
type ImageReadOptions = { signal?: AbortSignal };
const previewUrls = new Map<string, string>();
const previewListeners = new Set<() => void>();
let previewRevision = 0;
onSessionEnd(() => {
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.clear();
    previewRevision += 1;
});

export async function uploadImage(input: string | Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await readPrivateBlob(input, options?.signal) : input;
    const url = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error(i18n.t("common.imageReadFailed"));
        options?.signal?.throwIfAborted();
        const file = await uploadPrivateFile(blob, "image");
        return { url: file.url, storageKey: file.storageKey, width: image.naturalWidth, height: image.naturalHeight, bytes: file.bytes, mimeType: file.mimeType };
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    return storageKey ? fileUrl(storageKey) : safeImageFallback(fallback);
}
function safeImageFallback(value: string) {
    return value.startsWith("data:image/") || value.startsWith("blob:") || value.startsWith("/api/files/") ? value : "";
}
export async function getImageBlob(storageKey: string) {
    return readPrivateBlob(fileUrl(storageKey));
}
export function previewUrlFor(storageKey?: string) {
    return storageKey ? previewUrls.get(storageKey) : undefined;
}
export function subscribeImagePreviews(listener: () => void) {
    previewListeners.add(listener);
    return () => {
        previewListeners.delete(listener);
    };
}
export function getImagePreviewRevision() {
    return previewRevision;
}
export async function ensureImagePreview(storageKey?: string) {
    if (!storageKey || previewUrls.has(storageKey)) return storageKey ? previewUrls.get(storageKey) : undefined;
    const epoch = sessionEpoch();
    const blob = await getImageBlob(storageKey).catch(() => null);
    const preview = blob ? await createImageThumbnail(blob).catch(() => null) : null;
    if (!preview || epoch !== sessionEpoch()) return undefined;
    const existing = previewUrls.get(storageKey);
    if (existing) return existing;
    const url = URL.createObjectURL(preview);
    previewUrls.set(storageKey, url);
    previewRevision += 1;
    previewListeners.forEach((listener) => listener());
    return url;
}

// Importers upload and rewrite all package references to newly allocated IDs.
export async function setImageBlob(_storageKey: string, blob: Blob) {
    return (await uploadImage(blob)).url;
}
export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }, options?: ImageReadOptions) {
    const url = image.storageKey ? fileUrl(image.storageKey) : image.dataUrl || image.url || "";
    if (url.startsWith("data:image/")) return url;
    const blob = await readPrivateBlob(url, options?.signal);
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        [...new Set(keys)].map(async (key) => {
            await deletePrivateFile(key);
            const url = previewUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            previewUrls.delete(key);
        }),
    );
}
// Shared files may still be referenced by another project or log; remove only on explicit owner deletion.
export async function cleanupUnusedImages(_usedData: unknown) {}
export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => {
        if (Array.isArray(item)) item.forEach((child) => collectImageStorageKeys(child, keys));
        else collectImageStorageKeys(item, keys);
    });
    return keys;
}
