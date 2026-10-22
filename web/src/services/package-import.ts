import i18n from "@/i18n";
import { currentSession, sessionEpoch } from "@/services/api/canvas-client";
import { uploadPrivateFile } from "@/services/canvas-data";

type PackageFile = { storageKey: string; path: string; mimeType: string };
type ImportedFile = { storageKey: string; url: string };

export async function importPackageFiles(files: PackageFile[], zip: Map<string, Blob>, options?: { onProgress?: (progress: { completed: number; total: number; item: string }) => void; guard?: () => void }) {
    const epoch = sessionEpoch();
    const assertSession = () => {
        if (!currentSession() || epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
        options?.guard?.();
    };
    assertSession();
    const mapping = new Map<string, ImportedFile>();
    const total = new Set(files.map((file) => file.storageKey)).size;
    for (const file of files) {
        assertSession();
        if (mapping.has(file.storageKey)) continue;
        const blob = zip.get(file.path);
        if (!blob) throw new Error(`${file.path}: ${i18n.t("assets.importErrors.missingFile")}`);
        const kind = file.storageKey.startsWith("image:") ? "image" : "media";
        try {
            options?.onProgress?.({ completed: mapping.size, total, item: file.path });
            assertSession();
            const uploaded = await uploadPrivateFile(blob.type ? blob : blob.slice(0, blob.size, file.mimeType), kind);
            assertSession();
            mapping.set(file.storageKey, uploaded);
            options?.onProgress?.({ completed: mapping.size, total, item: file.path });
        } catch (error) {
            assertSession();
            throw new Error(`${file.path}: ${error instanceof Error ? error.message : i18n.t("assets.importFailed")}`);
        }
    }
    assertSession();
    return mapping;
}

// Preserve unknown node fields while replacing every file identity and owned media URL.
export function remapPackageResources<T>(value: T, mapping: Map<string, ImportedFile>): T {
    if (Array.isArray(value)) return value.map((item) => remapPackageResources(item, mapping)) as T;
    if (!value || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype" || key === "owner" || key === "owner_id") continue;
        if (key === "references" && Array.isArray(child)) {
            result[key] = child.map((reference) => {
                if (typeof reference !== "string" || !/^(?:image|media):/.test(reference)) return remapPackageResources(reference, mapping);
                const file = mapping.get(reference);
                if (!file) throw new Error(i18n.t("assets.importErrors.missingReference"));
                return file.storageKey;
            });
        } else {
            result[key] = remapPackageResources(child, mapping);
        }
    }
    const file = typeof source.storageKey === "string" ? mapping.get(source.storageKey) : undefined;
    if (source.storageKey && !file) throw new Error(i18n.t("assets.importErrors.missingReference"));
    if (file) {
        result.storageKey = file.storageKey;
        for (const key of ["content", "url", "dataUrl", "coverUrl"]) if (key in source && typeof source[key] === "string") result[key] = file.url;
    }
    for (const key of ["url", "dataUrl", "coverUrl", "previewUrl"]) {
        if (typeof result[key] === "string" && !/^(?:blob:|local-file:|data:image\/)/.test(result[key] as string)) result[key] = "";
    }
    if (["image", "video", "audio"].includes(String(source.type)) && result.metadata && typeof result.metadata === "object") {
        const metadata = result.metadata as Record<string, unknown>;
        if (typeof metadata.content === "string" && !/^(?:blob:|local-file:|data:)/.test(metadata.content)) metadata.content = "";
    }
    return result as T;
}
