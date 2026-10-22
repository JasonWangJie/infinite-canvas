import { Alert, Button } from "antd";
import { useTranslation } from "react-i18next";
import { useAssetDeleteStore } from "@/stores/use-asset-delete-store";

export function AssetDeleteStatus() {
    const { t } = useTranslation();
    const { status, operation, deleted, error, undoDelete, retrySave } = useAssetDeleteStore();
    if (status === "idle") return null;
    const saving = status === "saving";
    const undo = operation === "undo";
    const titleKey = status === "error" ? "assetDelete.failed"
        : saving ? (undo ? "assetDelete.undoSaving" : "assetDelete.deleteSaving")
        : status === "saved" ? (undo ? "assetDelete.undoSaved" : "assetDelete.deleteSaved")
        : undo ? "assetDelete.undoSaveError" : "assetDelete.deleteSaveError";
    const canUndo = operation === "delete" && Boolean(deleted) && !saving;

    return (
        <Alert
            className="mb-2"
            type={saving ? "info" : status === "saved" ? "success" : "warning"}
            showIcon
            title={<span className="break-words">{t(titleKey, { title: deleted?.asset.title || t("assets.untitled") })}</span>}
            description={
                <div className="space-y-2">
                    {saving ? <p className="text-xs">{t("assetDelete.pendingHint")}</p> : null}
                    {error ? <p className="break-words text-xs">{error}</p> : null}
                    {status === "save-error" ? <p className="text-xs">{t("assetDelete.recoveryHint")}</p> : null}
                    {canUndo || status === "save-error" ? (
                        <div className="flex flex-wrap gap-2">
                            {status === "save-error" ? <Button size="small" type="text" onClick={() => void retrySave()}>{t("assetDelete.retrySave")}</Button> : null}
                            {canUndo ? <Button size="small" type="text" onClick={() => void undoDelete()}>{t("assetDelete.undo")}</Button> : null}
                        </div>
                    ) : null}
                </div>
            }
        />
    );
}
