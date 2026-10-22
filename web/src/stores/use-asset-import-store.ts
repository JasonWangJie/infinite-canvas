import { create } from "zustand";
import i18n from "@/i18n";
import { readAssetPackage, type AssetImportProgress } from "@/pages/assets/asset-transfer";
import { currentSession, onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";
import { flushDocument, getDocumentBaseline, getDocumentSaveState, retryDocument } from "@/services/canvas-data";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

type AssetImportState = {
    status: "idle" | "working" | "saving" | "save-error" | "error" | "saved";
    fileName: string;
    progress: AssetImportProgress | null;
    assetIds: string[];
    error: string;
};
type AssetImportStore = AssetImportState & {
    startImport: (file: File) => Promise<void>;
    retrySave: () => Promise<void>;
};
const emptyImport: AssetImportState = { status: "idle", fileName: "", progress: null, assetIds: [], error: "" };
let operation = 0;

function isCurrentImport(id: number, epoch: number) {
    return id === operation && epoch === sessionEpoch() && Boolean(currentSession());
}
function containsBatch(assets: Pick<Asset, "id">[] | undefined, ids: string[]) {
    const existing = new Set(assets?.map((asset) => asset.id));
    return ids.length > 0 && ids.every((id) => existing.has(id));
}
function hasSavedBatch(ids: string[]) {
    const value = getDocumentBaseline("assets") as { state?: { assets?: Asset[] } } | null | undefined;
    return Array.isArray(value?.state?.assets) && containsBatch(value.state.assets, ids);
}

// This receipt survives route changes, but never crosses an authenticated session.
export const useAssetImportStore = create<AssetImportStore>((set, get) => ({
    ...emptyImport,
    startImport: async (file) => {
        if (["working", "saving", "save-error"].includes(get().status)) return;
        const id = ++operation, epoch = sessionEpoch();
        set({ status: "working", fileName: file.name, progress: { phase: "reading", completed: 0, total: 1 }, assetIds: [], error: "" });
        let assetIds: string[] = [];
        try {
            if (!currentSession()) throw new Error(i18n.t("saveRecovery.authorizationRequired"));
            if (!useAssetStore.getState().hydrated) throw new Error(i18n.t("assets.importJobNotReady"));
            if (["error", "conflict"].includes(getDocumentSaveState("assets").status)) throw new Error(i18n.t("assets.importJobRecoveryRequired"));
            const assets = await readAssetPackage(file, {
                onProgress: (progress) => { if (isCurrentImport(id, epoch)) set({ progress }); },
            });
            if (!isCurrentImport(id, epoch)) return;
            if (!useAssetStore.getState().hydrated) throw new Error(i18n.t("assets.importJobNotReady"));
            if (!assets.length) throw new Error(i18n.t("assets.importJobEmpty"));
            assetIds = useAssetStore.getState().addAssets(assets);
            if (!isCurrentImport(id, epoch)) return;
            set({ status: "saving", assetIds });
            await flushDocument("assets");
            if (!isCurrentImport(id, epoch)) return;
            if (!containsBatch(useAssetStore.getState().assets, assetIds)) throw new Error(i18n.t("assets.importJobBatchChanged"));
            if (!hasSavedBatch(assetIds)) throw new Error(i18n.t("assets.importJobSaveUnconfirmed"));
            set({ status: "saved", error: "" });
        } catch (error) {
            if (id !== operation || epoch !== sessionEpoch()) return;
            const missing = assetIds.length > 0 && !containsBatch(useAssetStore.getState().assets, assetIds);
            set({
                status: assetIds.length && !missing ? "save-error" : "error",
                error: missing ? i18n.t("assets.importJobBatchChanged") : error instanceof Error ? error.message : i18n.t("assets.importFailed"),
            });
        }
    },
    retrySave: async () => {
        if (get().status !== "save-error") return;
        const id = ++operation, epoch = sessionEpoch();
        const assetIds = get().assetIds;
        set({ status: "saving", error: "" });
        try {
            if (!currentSession()) throw new Error(i18n.t("saveRecovery.authorizationRequired"));
            if (!containsBatch(useAssetStore.getState().assets, assetIds)) throw new Error(i18n.t("assets.importJobBatchChanged"));
            // The global recovery control may already have saved this exact batch.
            if (getDocumentSaveState("assets").status !== "saved" || !hasSavedBatch(assetIds)) {
                await retryDocument("assets");
                if (!isCurrentImport(id, epoch)) return;
                await flushDocument("assets");
                if (!isCurrentImport(id, epoch)) return;
            }
            if (!containsBatch(useAssetStore.getState().assets, assetIds)) throw new Error(i18n.t("assets.importJobBatchChanged"));
            if (!hasSavedBatch(assetIds)) throw new Error(i18n.t("assets.importJobSaveUnconfirmed"));
            set({ status: "saved", error: "" });
        } catch (error) {
            if (id !== operation || epoch !== sessionEpoch()) return;
            const missing = !containsBatch(useAssetStore.getState().assets, assetIds);
            set({
                status: missing ? "error" : "save-error",
                error: missing ? i18n.t("assets.importJobBatchChanged") : error instanceof Error ? error.message : i18n.t("assets.importJobSaveUnconfirmed"),
            });
        }
    },
}));

onSessionEnd(() => {
    operation += 1;
    useAssetImportStore.setState({ ...emptyImport, assetIds: [] });
});
