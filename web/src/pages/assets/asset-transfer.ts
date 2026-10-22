import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { createZip, readZip } from "@/lib/zip";
import { currentSession, sessionEpoch } from "@/services/api/canvas-client";
import { fileUrl } from "@/services/canvas-data";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob, uploadImage } from "@/services/image-storage";
import { importPackageFiles, remapPackageResources } from "@/services/package-import";
import { nanoid } from "nanoid";
import type { Asset } from "@/stores/use-asset-store";

type AssetExportFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    assets: Asset[];
    files: AssetExportItem[];
};

type AssetExportItem = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export type AssetImportProgress = {
    phase: "reading" | "validating" | "uploading";
    completed: number;
    total: number;
    item?: string;
};

export async function exportAssets(assets: Asset[], filename: string) {
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const exportedKeys = new Set<string>();

    await Promise.all(
        assets.map(async (asset) => {
            if (asset.kind !== "image" && asset.kind !== "video") return;
            const storageKey = asset.data.storageKey;
            if (!storageKey || exportedKeys.has(storageKey)) return;
            exportedKeys.add(storageKey);
            const blob = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
            if (!blob) throw new Error(`${asset.title}: ${i18n.t("assets.importErrors.missingFile")}`);
            const path = `files/${safeFileName(storageKey)}.${fileExtension(blob.type, asset.kind)}`;
            files.push({ storageKey, path, mimeType: blob.type || asset.data.mimeType, bytes: blob.size });
            zipFiles.push({ name: path, data: blob });
        }),
    );

    const data: AssetExportFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), assets, files };
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, filename);
}

export async function readAssetPackage(file: File, options?: { onProgress?: (progress: AssetImportProgress) => void }): Promise<Asset[]> {
    const epoch = sessionEpoch();
    const assertSession = () => {
        if (!currentSession() || epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
    };
    const report = (progress: AssetImportProgress) => {
        assertSession();
        options?.onProgress?.(progress);
        assertSession();
    };
    report({ phase: "reading", completed: 0, total: 1, item: file.name });
    let zip: Map<string, Blob>;
    try {
        zip = await readZip(file);
    } catch {
        assertSession();
        throw new Error(`${file.name}: ${i18n.t("assets.importErrors.readFailed")}`);
    }
    assertSession();
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error(`assets.json: ${i18n.t("assets.importErrors.missingFile")}`);
    let data: AssetExportFile;
    try {
        const text = await assetFile.text();
        assertSession();
        data = JSON.parse(text) as AssetExportFile;
    } catch {
        assertSession();
        throw new Error(`assets.json: ${i18n.t("assets.importErrors.invalidPackage")}`);
    }
    if (data?.app !== "infinite-canvas" || data.version !== 1 || !Array.isArray(data.assets) || !Array.isArray(data.files)) throw new Error(`assets.json: ${i18n.t("assets.importErrors.invalidPackage")}`);
    if (!data.assets.length) throw new Error(`assets.json: ${i18n.t("assets.importJobEmpty")}`);
    report({ phase: "reading", completed: 1, total: 1, item: file.name });
    const files = new Map<string, AssetExportItem>();
    const validationTotal = data.files.length + data.assets.length;
    let validated = 0;
    report({ phase: "validating", completed: 0, total: validationTotal });
    for (const [index, item] of data.files.entries()) {
        const label = item && typeof item.path === "string" && item.path ? item.path : `assets.json files[${index}]`;
        report({ phase: "validating", completed: validated, total: validationTotal, item: label });
        if (!item || typeof item.storageKey !== "string" || !/^(image|media):.+/.test(item.storageKey) || typeof item.path !== "string" || !item.path || typeof item.mimeType !== "string" || typeof item.bytes !== "number" || !Number.isFinite(item.bytes) || item.bytes < 0 || files.has(item.storageKey))
            throw new Error(`${label}: ${i18n.t("assets.importErrors.invalidManifest")}`);
        const blob = zip.get(item.path);
        if (!blob) throw new Error(`${label}: ${i18n.t("assets.importErrors.missingFile")}`);
        if (item.storageKey.startsWith("image:")) {
            try {
                await validatePackageImage(blob, assertSession);
                assertSession();
            } catch (error) {
                assertSession();
                throw new Error(`${label}: ${error instanceof Error ? error.message : i18n.t("assets.importErrors.imageUnreadable")}`);
            }
        }
        files.set(item.storageKey, item);
        report({ phase: "validating", completed: ++validated, total: validationTotal, item: label });
    }
    const references = new Map([...files].map(([key]) => [key, { storageKey: key, url: fileUrl(key) }]));
    for (const [index, asset] of data.assets.entries()) {
        const label = asset && typeof asset.title === "string" && asset.title ? asset.title : `assets.json assets[${index}]`;
        report({ phase: "validating", completed: validated, total: validationTotal, item: label });
        try {
            if (
                !asset ||
                !["text", "image", "video"].includes(asset.kind) ||
                typeof asset.title !== "string" ||
                typeof asset.coverUrl !== "string" ||
                !Array.isArray(asset.tags) ||
                !asset.tags.every((tag) => typeof tag === "string") ||
                (asset.source !== undefined && typeof asset.source !== "string") ||
                (asset.note !== undefined && typeof asset.note !== "string") ||
                !asset.data ||
                typeof asset.data !== "object" ||
                Array.isArray(asset.data)
            )
                throw new Error(i18n.t("assets.importErrors.invalidAsset"));
            if (asset.kind === "text") {
                if (typeof asset.data.content !== "string") throw new Error(i18n.t("assets.importErrors.invalidText"));
            } else {
                const mediaUrl = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
                if (typeof mediaUrl !== "string" || typeof asset.data.mimeType !== "string" || ![asset.data.width, asset.data.height, asset.data.bytes].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0))
                    throw new Error(i18n.t("assets.importErrors.invalidMedia"));
                const key = asset.data.storageKey;
                if (key !== undefined && (typeof key !== "string" || !key.startsWith(asset.kind === "image" ? "image:" : "media:") || !files.has(key))) throw new Error(i18n.t("assets.importErrors.missingReference"));
                if (asset.kind === "video" && !key) throw new Error(i18n.t("assets.importErrors.missingVideo"));
                if (asset.kind === "image" && !key) {
                    if (!asset.data.dataUrl.startsWith("data:image/")) throw new Error(i18n.t("assets.importErrors.missingImage"));
                    await validatePackageImage(asset.data.dataUrl, assertSession);
                    assertSession();
                }
            }
            // Check nested storage references before any resource is uploaded.
            remapPackageResources(asset, references);
        } catch (error) {
            assertSession();
            throw new Error(`${label}: ${error instanceof Error ? error.message : i18n.t("assets.importErrors.invalidAsset")}`);
        }
        report({ phase: "validating", completed: ++validated, total: validationTotal, item: label });
    }
    const uploadTotal = files.size + data.assets.filter((asset) => asset.kind === "image" && !asset.data.storageKey).length;
    let uploaded = 0;
    report({ phase: "uploading", completed: 0, total: uploadTotal });
    const mapping = await importPackageFiles(data.files, zip, {
        guard: assertSession,
        onProgress: ({ completed, item }) => {
            uploaded = completed;
            report({ phase: "uploading", completed: uploaded, total: uploadTotal, item });
        },
    });
    assertSession();
    // Keep inline uploads concurrent, but wait for every started upload before reporting failure.
    const results = await Promise.allSettled(
        data.assets.map(async (asset) => {
            assertSession();
            const imported = { ...remapPackageResources(asset, mapping), id: nanoid() };
            if (asset.kind === "image" && imported.kind === "image" && (asset.coverUrl === asset.data.dataUrl || (asset.data.storageKey && asset.coverUrl === fileUrl(asset.data.storageKey)))) imported.coverUrl = imported.data.dataUrl;
            if (asset.kind === "video" && imported.kind === "video" && (asset.coverUrl === asset.data.url || (asset.data.storageKey && asset.coverUrl === fileUrl(asset.data.storageKey)))) imported.coverUrl = imported.data.url;
            if (imported.kind !== "image" || imported.data.storageKey) return imported;
            try {
                report({ phase: "uploading", completed: uploaded, total: uploadTotal, item: asset.title });
                const image = await uploadImage(imported.data.dataUrl);
                assertSession();
                report({ phase: "uploading", completed: ++uploaded, total: uploadTotal, item: asset.title });
                return {
                    ...imported,
                    coverUrl: imported.coverUrl === imported.data.dataUrl ? image.url : imported.coverUrl,
                    data: { ...imported.data, dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType },
                };
            } catch (error) {
                assertSession();
                throw new Error(`${asset.title}: ${error instanceof Error ? error.message : i18n.t("assets.importFailed")}`);
            }
        }),
    );
    assertSession();
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

async function validatePackageImage(source: string | Blob, assertSession: () => void) {
    const url = typeof source === "string" ? source : URL.createObjectURL(source);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        assertSession();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error(i18n.t("assets.importErrors.imageUnreadable"));
    } catch {
        assertSession();
        throw new Error(i18n.t("assets.importErrors.imageUnreadable"));
    } finally {
        if (typeof source !== "string") URL.revokeObjectURL(url);
    }
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, kind: Asset["kind"]) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    return kind === "image" ? "png" : "bin";
}
