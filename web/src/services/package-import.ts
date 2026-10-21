import { uploadPrivateFile } from "@/services/canvas-data";

type PackageFile = { storageKey: string; path: string; mimeType: string };
type ImportedFile = { storageKey: string; url: string };

export async function importPackageFiles(files: PackageFile[], zip: Map<string, Blob>) {
    const mapping = new Map<string, ImportedFile>();
    for (const file of files) {
        if (mapping.has(file.storageKey)) continue;
        const blob = zip.get(file.path);
        if (!blob) throw new Error("导入包缺少素材文件");
        const kind = file.storageKey.startsWith("image:") ? "image" : "media";
        const uploaded = await uploadPrivateFile(blob.type ? blob : blob.slice(0, blob.size, file.mimeType), kind);
        mapping.set(file.storageKey, uploaded);
    }
    return mapping;
}

// Preserve unknown node fields while replacing every file identity and owned media URL.
export function remapPackageResources<T>(value: T, mapping: Map<string, ImportedFile>): T {
    if (typeof value === "string") return (mapping.get(value)?.storageKey || value) as T;
    if (Array.isArray(value)) return value.map((item) => remapPackageResources(item, mapping)) as T;
    if (!value || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype" || key === "owner" || key === "owner_id") continue;
        result[key] = remapPackageResources(child, mapping);
    }
    const file = typeof source.storageKey === "string" ? mapping.get(source.storageKey) : undefined;
    if (source.storageKey && !file) throw new Error("导入包引用了未包含的素材");
    if (file) {
        result.storageKey = file.storageKey;
        for (const key of ["content", "url", "dataUrl", "coverUrl"]) if (key in source && typeof source[key] === "string") result[key] = file.url;
    }
    for (const key of ["url", "dataUrl", "coverUrl", "previewUrl"]) {
        if (typeof result[key] === "string" && !/^(?:\/api\/files\/|data:image\/)/.test(result[key] as string)) result[key] = "";
    }
    if (["image", "video", "audio"].includes(String(source.type)) && result.metadata && typeof result.metadata === "object") {
        const metadata = result.metadata as Record<string, unknown>;
        if (typeof metadata.content === "string" && !/^(?:\/api\/files\/|data:)/.test(metadata.content)) metadata.content = "";
    }
    return result as T;
}
