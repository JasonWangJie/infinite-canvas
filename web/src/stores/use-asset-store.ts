import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
import { currentSession, sessionEpoch } from "@/services/api/canvas-client";
import { equalDocument, flushDocument, getDocumentBaseline, getDocumentSaveState } from "@/services/canvas-data";
import { cleanupUnusedImages, ensureImagePreview, previewUrlFor, resolveImageUrl } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    addAssets: (assets: Omit<Asset, "id" | "createdAt" | "updatedAt">[]) => string[];
    addAssetsAndSave: (assets: Omit<Asset, "id" | "createdAt" | "updatedAt">[], epoch?: number) => Promise<string[]>;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

// 卡片用缩略图渲染，自定义封面（远程地址或单独上传的封面）保持原样。
export function assetCoverUrl(asset: Asset) {
    const own = asset.kind === "image" ? asset.data.dataUrl : "";
    const cover = asset.coverUrl || own;
    return asset.kind === "image" && cover === own ? previewUrlFor(asset.data.storageKey) || cover : cover;
}

const ASSET_STORE_KEY = "infinite-canvas:asset_store";

export function assertAssetSaveReady(epoch = sessionEpoch()) {
    if (!currentSession() || epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
    if (!useAssetStore.getState().hydrated) throw new Error(i18n.t("assets.importJobNotReady"));
    const status = getDocumentSaveState("assets").status;
    if (status === "error" || status === "conflict") throw new Error(i18n.t("assets.importJobRecoveryRequired"));
    if (status === "pending" || status === "saving") throw new Error(i18n.t("assets.formSaveUnconfirmed"));
}

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        if (!Array.isArray(parsed?.state?.assets)) throw new Error("素材数据无法读取，原数据未被修改");
        parsed.state.assets = await Promise.all(
            parsed.state.assets.map(async (asset) => {
                if (asset.kind === "video" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                if (asset.kind !== "image") return asset;
                if (asset.data.storageKey) {
                    void ensureImagePreview(asset.data.storageKey);
                    return {
                        ...asset,
                        coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
                        data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
                    };
                }
                // Reading existing assets must not upload or replace their contents.
                return asset;
            }),
        );
        return parsed;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            addAsset: (asset) => get().addAssets([asset])[0],
            addAssets: (assets) => {
                if (!assets.length) return [];
                const now = new Date().toISOString();
                const added = assets.map((asset) => ({ ...asset, id: nanoid(), createdAt: now, updatedAt: now } as Asset));
                set((state) => ({ assets: [...added, ...state.assets] }));
                return added.map((asset) => asset.id);
            },
            addAssetsAndSave: async (assets, epoch = sessionEpoch()) => {
                assertAssetSaveReady(epoch);
                const ids = get().addAssets(assets);
                const added = JSON.parse(JSON.stringify(get().assets.filter((asset) => ids.includes(asset.id)))) as Asset[];
                await flushDocument("assets");
                if (!currentSession() || epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
                const saved = getDocumentBaseline("assets") as { state?: { assets?: Asset[] } } | undefined;
                const current = JSON.parse(JSON.stringify(get().assets)) as Asset[];
                if (!added.every((asset) => equalDocument(current.find((item) => item.id === asset.id), asset) && equalDocument(saved?.state?.assets?.find((item) => item.id === asset.id), asset))) throw new Error(i18n.t("assets.formSaveUnconfirmed"));
                return ids;
            },
            updateAsset: (id, patch) =>
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                })),
            removeAsset: (id) =>
                set((state) => {
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    get().cleanupImages({ assets });
                    return { assets };
                }),
            replaceAssets: (assets) => set({ assets }),
            cleanupImages: (extra) => {
                window.setTimeout(async () => {
                    const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
                    await cleanupUnusedImages({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                    await cleanupUnusedMedia({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                }, 0);
            },
        }),
        {
            skipHydration: true,
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
            merge: (stored, current) => ({ ...current, ...(stored as Partial<AssetStore>), hydrated: true }),
            onRehydrateStorage: () => (_state, error) => {
                // Let bootstrap show the read failure; persisting defaults here would erase the document.
                if (error) throw error;
            },
        },
    ),
);
