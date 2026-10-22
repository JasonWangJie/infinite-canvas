import { create } from "zustand";
import i18n from "@/i18n";
import { currentSession, onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";
import { equalDocument, flushDocument, getDocumentBaseline, getDocumentSaveState, retryDocument } from "@/services/canvas-data";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

export type AssetDeleteReceipt = { asset: Asset; index: number; previousId?: string; nextId?: string };
type AssetDeleteOperation = "delete" | "undo";
type AssetDeleteState = {
    status: "idle" | "saving" | "save-error" | "saved" | "error";
    operation: AssetDeleteOperation | null;
    deleted: AssetDeleteReceipt | null;
    error: string;
};
type AssetDeleteStore = AssetDeleteState & {
    deleteAsset: (id: string) => Promise<void>;
    undoDelete: () => Promise<void>;
    retrySave: () => Promise<void>;
};
const emptyDelete: AssetDeleteState = { status: "idle", operation: null, deleted: null, error: "" };
let operationId = 0;

function isCurrentOperation(id: number, epoch: number) {
    return id === operationId && epoch === sessionEpoch();
}
function assertAssetsReady() {
    if (!currentSession()) throw new Error(i18n.t("saveRecovery.authorizationRequired"));
    if (!useAssetStore.getState().hydrated) throw new Error(i18n.t("assets.deleteJobNotReady"));
}
function sameAssetContent(left: Asset, right: Asset) {
    // A timestamp-only edit must not prevent confirming an otherwise identical restoration.
    // Normalize the same way persistence does, including omitted undefined fields.
    return equalDocument(JSON.parse(JSON.stringify({ ...left, updatedAt: undefined })), JSON.parse(JSON.stringify({ ...right, updatedAt: undefined })));
}
function matchesChange(assets: Asset[], receipt: AssetDeleteReceipt, operation: AssetDeleteOperation) {
    const matches = assets.filter((asset) => asset.id === receipt.asset.id);
    return operation === "delete" ? matches.length === 0 : matches.length === 1 && sameAssetContent(matches[0], receipt.asset);
}
function hasSavedChange(receipt: AssetDeleteReceipt, operation: AssetDeleteOperation) {
    const baseline = getDocumentBaseline("assets") as { state?: { assets?: Asset[] } } | null | undefined;
    return Array.isArray(baseline?.state?.assets) && matchesChange(baseline.state.assets, receipt, operation);
}

async function confirmAssetChange(receipt: AssetDeleteReceipt, operation: AssetDeleteOperation, id: number, epoch: number, retry = false) {
    try {
        assertAssetsReady();
        if (!matchesChange(useAssetStore.getState().assets, receipt, operation)) throw new Error(i18n.t("assets.deleteJobChanged"));
        // Global recovery may already have confirmed this operation. Do not write it again.
        if (!retry || getDocumentSaveState("assets").status !== "saved" || !hasSavedChange(receipt, operation)) {
            if (retry) {
                await retryDocument("assets");
                if (!isCurrentOperation(id, epoch)) return;
            }
            await flushDocument("assets");
            if (!isCurrentOperation(id, epoch)) return;
        }
        if (!matchesChange(useAssetStore.getState().assets, receipt, operation)) throw new Error(i18n.t("assets.deleteJobChanged"));
        if (!hasSavedChange(receipt, operation)) throw new Error(i18n.t("assets.deleteJobSaveUnconfirmed"));
        useAssetDeleteStore.setState({ status: "saved", error: "" });
    } catch (error) {
        if (!isCurrentOperation(id, epoch)) return;
        const changed = !matchesChange(useAssetStore.getState().assets, receipt, operation);
        useAssetDeleteStore.setState({
            status: changed ? "error" : "save-error",
            error: changed ? i18n.t("assets.deleteJobChanged") : error instanceof Error ? error.message : i18n.t("saveRecovery.actionFailed"),
        });
    }
}

// Keep one undo receipt across routes, never across authenticated sessions.
export const useAssetDeleteStore = create<AssetDeleteStore>((set, get) => ({
    ...emptyDelete,
    deleteAsset: async (assetId) => {
        if (["saving", "save-error"].includes(get().status)) return;
        const id = ++operationId, epoch = sessionEpoch();
        set({ status: "saving", error: "" });
        try {
            assertAssetsReady();
            if (["error", "conflict"].includes(getDocumentSaveState("assets").status)) throw new Error(i18n.t("assets.deleteJobRecoveryRequired"));
            const store = useAssetStore.getState();
            const index = store.assets.findIndex((asset) => asset.id === assetId);
            if (index < 0) throw new Error(i18n.t("assets.deleteJobMissing"));
            const deleted: AssetDeleteReceipt = { asset: structuredClone(store.assets[index]), index, previousId: store.assets[index - 1]?.id, nextId: store.assets[index + 1]?.id };
            set({ deleted, operation: "delete" });
            if (!isCurrentOperation(id, epoch)) return;
            const current = useAssetStore.getState();
            const target = current.assets.find((asset) => asset.id === assetId);
            if (!target || !sameAssetContent(target, deleted.asset)) throw new Error(i18n.t("assets.deleteJobChanged"));
            current.replaceAssets(current.assets.filter((asset) => asset.id !== assetId));
            if (!isCurrentOperation(id, epoch)) return;
            await confirmAssetChange(deleted, "delete", id, epoch);
        } catch (error) {
            if (!isCurrentOperation(id, epoch)) return;
            set({ status: "error", error: error instanceof Error ? error.message : i18n.t("saveRecovery.actionFailed") });
        }
    },
    undoDelete: async () => {
        const { deleted, operation, status } = get();
        if (!deleted || operation !== "delete" || status === "saving") return;
        const id = ++operationId, epoch = sessionEpoch();
        set({ status: "saving", error: "" });
        try {
            assertAssetsReady();
            const store = useAssetStore.getState();
            const existing = store.assets.find((asset) => asset.id === deleted.asset.id);
            if (existing && !sameAssetContent(existing, deleted.asset)) throw new Error(i18n.t("assets.deleteJobRestoreConflict"));
            if (!existing) {
                const next = store.assets.findIndex((asset) => asset.id === deleted.nextId);
                const previous = store.assets.findIndex((asset) => asset.id === deleted.previousId);
                const index = next >= 0 ? next : previous >= 0 ? previous + 1 : Math.min(deleted.index, store.assets.length);
                store.replaceAssets([...store.assets.slice(0, index), structuredClone(deleted.asset), ...store.assets.slice(index)]);
            }
            if (!isCurrentOperation(id, epoch)) return;
            set({ operation: "undo" });
            if (!isCurrentOperation(id, epoch)) return;
            await confirmAssetChange(deleted, "undo", id, epoch);
        } catch (error) {
            if (!isCurrentOperation(id, epoch)) return;
            set({ status: "error", error: error instanceof Error ? error.message : i18n.t("saveRecovery.actionFailed") });
        }
    },
    retrySave: async () => {
        const { deleted, operation, status } = get();
        if (!deleted || !operation || status !== "save-error") return;
        const id = ++operationId, epoch = sessionEpoch();
        set({ status: "saving", error: "" });
        if (!isCurrentOperation(id, epoch)) return;
        await confirmAssetChange(deleted, operation, id, epoch, true);
    },
}));

onSessionEnd(() => {
    operationId += 1;
    useAssetDeleteStore.setState({ ...emptyDelete });
});
