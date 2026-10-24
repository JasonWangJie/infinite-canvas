import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Alert, App, Button, Modal } from "antd";
import { useMatch, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";
import { prepareCanvasConflictCopies } from "@/lib/canvas/save-recovery";
import { assertDocumentRecoveryBackupCurrent, captureDocumentRecoveryBackup, getDocumentDraft, getDocumentSaveStates, retryDocument, subscribeDocumentSaves, type DocumentRecoveryBackup, type DocumentSaveState } from "@/services/canvas-data";
import { recoverImageTaskRecords } from "@/services/image-task-records";
import { applyCanvasDocument, flushCanvasSave, useCanvasStore } from "@/stores/canvas/use-canvas-store";

const domainLabels: Record<string, string> = {
    canvas: "navigation.canvas",
    assets: "navigation.assets",
    config: "navigation.config",
    "image-workbench": "navigation.image",
    "image-tasks": "managed.imageTasks",
    "video-workbench": "navigation.video",
    "plugin-state": "topNav.plugins",
    "plugin-data": "topNav.plugins",
};

export function DocumentSaveRecovery() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const states = useSyncExternalStore(subscribeDocumentSaves, getDocumentSaveStates, getDocumentSaveStates);
    const [backup, setBackup] = useState<DocumentRecoveryBackup | null>(null);
    const [exporting, setExporting] = useState(false);
    const [reloadError, setReloadError] = useState("");
    const reloading = useRef(false);
    const exportingRef = useRef(false);
    const unsaved = states.some((state) => state.status !== "saved" && state.status !== "idle");
    useEffect(() => onSessionEnd(() => { setBackup(null); setReloadError(""); }), []);
    useEffect(() => {
        if (!unsaved) return;
        const warn = (event: BeforeUnloadEvent) => {
            if (reloading.current) return;
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [unsaved]);
    const failures = states.filter((state) => state.status === "error" || state.status === "conflict");
    const exportAll = async () => {
        if (exportingRef.current) return;
        const epoch = sessionEpoch();
        exportingRef.current = true;
        setExporting(true);
        setReloadError("");
        try {
            flushSync(() => {
                (document.activeElement as HTMLElement | null)?.blur?.();
                window.dispatchEvent(new CustomEvent("canvas-before-logout"));
            });
            const next = await captureDocumentRecoveryBackup();
            const { saveAs } = await import("file-saver");
            assertDocumentRecoveryBackupCurrent(next);
            saveAs(new Blob([JSON.stringify({ app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), documents: next.documents }, null, 2)], { type: "application/json" }), "infinite-canvas-unsaved-drafts.json");
            if (epoch === sessionEpoch()) setBackup(next);
        } catch (error) {
            if (epoch === sessionEpoch()) message.error(error instanceof Error ? error.message : t("saveRecovery.actionFailed"));
        } finally {
            exportingRef.current = false;
            if (epoch === sessionEpoch()) setExporting(false);
        }
    };
    const reloadSaved = () => {
        if (!backup || exportingRef.current) return;
        try {
            assertDocumentRecoveryBackupCurrent(backup);
            reloading.current = true;
            window.location.reload();
        } catch (error) {
            setReloadError(error instanceof Error ? error.message : t("saveRecovery.actionFailed"));
        } finally {
            reloading.current = false;
        }
    };
    if (!failures.length && !backup) return null;
    return (
        <div id="document-save-recovery" tabIndex={-1} className="max-h-[35dvh] shrink-0 overflow-y-auto outline-none">
            {failures.map((state) => (
                <DocumentSaveIssue key={state.domain} state={state} />
            ))}
            {failures.length ? <Button className="m-2" size="small" loading={exporting} onClick={() => void exportAll()}>{t("saveRecovery.exportAllReload", { defaultValue: "导出本页全部未保存草稿并重新加载" })}</Button> : null}
            <Modal open={Boolean(backup)} title={t("saveRecovery.reloadTitle", { defaultValue: "确认备份后重新读取已保存版本" })} onCancel={() => setBackup(null)} mask={{ closable: false }} footer={[
                <Button key="cancel" disabled={exporting} onClick={() => setBackup(null)}>{t("saveRecovery.keepDrafts", { defaultValue: "保留本页草稿" })}</Button>,
                <Button key="export" loading={exporting} onClick={() => void exportAll()}>{t("saveRecovery.exportAgain", { defaultValue: "重新导出全部草稿" })}</Button>,
                <Button key="reload" danger disabled={exporting} onClick={reloadSaved}>{t("saveRecovery.confirmReload", { defaultValue: "已保存备份，放弃本页草稿并重新加载" })}</Button>,
            ]}>
                <div className="space-y-3">
                    <p>{t("saveRecovery.reloadDownloadHint", { defaultValue: "浏览器已发起下载，请确认备份文件已保存到本机后再继续。取消会保留所有草稿。" })}</p>
                    <p>{t("saveRecovery.reloadDomains", { defaultValue: "备份包含以下未保存数据：{{names}}。", names: Object.keys(backup?.documents || {}).map((domain) => t(domainLabels[domain] || "saveRecovery.otherData")).join("、") })}</p>
                    <p>{t("saveRecovery.reloadRisk", { defaultValue: "重新加载会放弃本页所有未保存状态，并读取浏览器中已保存的版本；不会覆盖已保存数据。尚未到达的生成响应和未提交的表单输入可能丢失。" })}</p>
                    <p>{t("saveRecovery.reloadMediaHint", { defaultValue: "JSON 备份包含草稿及媒体引用，不包含媒体文件。有画布草稿时，请先使用“导出画布资源包”保留完整资源。" })}</p>
                    {reloadError ? <p role="alert" className="text-destructive">{reloadError}</p> : null}
                </div>
            </Modal>
        </div>
    );
}

function DocumentSaveIssue({ state }: { state: DocumentSaveState }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const projectId = useMatch("/canvas/:id")?.params.id;
    const [working, setWorking] = useState("");
    const label = t(domainLabels[state.domain] || "saveRecovery.otherData");
    const conflict = state.status === "conflict";

    const recover = async (action: "retry" | "export" | "json" | "copy") => {
        const epoch = sessionEpoch();
        setWorking(action);
        try {
            if (action === "retry") {
                if (state.domain === "canvas") await flushCanvasSave().catch(() => {});
                if (state.domain === "image-tasks") await recoverImageTaskRecords();
                else await retryDocument(state.domain);
                if (epoch === sessionEpoch()) message.success(t("saveRecovery.retrySucceeded"));
                return;
            }
            if (action === "copy") {
                const result = await prepareCanvasConflictCopies(projectId);
                if (epoch !== sessionEpoch()) return;
                // Leave the old editor before another local edit can update its original project.
                flushSync(() => {
                    applyCanvasDocument(result.document);
                    navigate(`/canvas/${result.projectId}`, { replace: true });
                });
                message.success(t("saveRecovery.copiesSaved", { count: result.count }));
                return;
            }
            if (action === "export" && state.domain === "canvas") {
                const projects = useCanvasStore.getState().projects;
                if (!projects.length) throw new Error(t("canvas.projectPage.notFound"));
                const { exportCanvasProjects } = await import("@/lib/canvas/canvas-export");
                if (epoch !== sessionEpoch()) return;
                await exportCanvasProjects(projects, t("saveRecovery.canvasBackup"));
            } else {
                const draft = state.domain === "canvas" ? { state: { projects: useCanvasStore.getState().projects, deletedProjects: useCanvasStore.getState().deletedProjects }, version: 0 } : getDocumentDraft(state.domain);
                if (draft === undefined) throw new Error(t("saveRecovery.noDraft"));
                const blob = new Blob([JSON.stringify({ app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), content: draft }, null, 2)], { type: "application/json" });
                const { saveAs } = await import("file-saver");
                if (epoch !== sessionEpoch()) return;
                saveAs(blob, `${label.replace(/[\\/:*?"<>|]/g, "_")}-${t("saveRecovery.draftFile")}.json`);
            }
            if (epoch === sessionEpoch()) message.success(t("saveRecovery.exported"));
        } catch (error) {
            if (epoch === sessionEpoch()) message.error(error instanceof Error ? error.message : t("saveRecovery.actionFailed"));
        } finally {
            setWorking("");
        }
    };

    return (
        <Alert
            type={conflict ? "warning" : "error"}
            showIcon
            title={t(conflict ? "saveRecovery.conflictFor" : "saveRecovery.failedFor", { name: label })}
            description={
                <div className="space-y-1">
                    <p>{t(conflict ? "saveRecovery.conflictHint" : "saveRecovery.draftRetained")}</p>
                    {state.error ? <p className="break-words text-xs opacity-70">{state.error}</p> : null}
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="small" loading={working === "retry"} disabled={!!working && working !== "retry"} onClick={() => void recover("retry")}>
                            {t("saveRecovery.retrySave")}
                        </Button>
                        {state.domain === "canvas" ? (
                            <Button size="small" loading={working === "export"} disabled={!!working && working !== "export"} onClick={() => void recover("export")}>
                                {t("saveRecovery.exportCanvas")}
                            </Button>
                        ) : null}
                        <Button size="small" loading={working === "json"} disabled={!!working && working !== "json"} onClick={() => void recover("json")}>
                            {t("saveRecovery.exportDraft")}
                        </Button>
                        {state.domain === "canvas" && conflict ? (
                            <Button size="small" loading={working === "copy"} disabled={!!working && working !== "copy"} onClick={() => void recover("copy")}>
                                {t("saveRecovery.saveCopies")}
                            </Button>
                        ) : null}
                        <span className="text-xs opacity-70">{t("saveRecovery.draftExportHint")}</span>
                    </div>
                </div>
            }
        />
    );
}
