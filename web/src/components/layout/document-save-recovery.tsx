import { useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Alert, App, Button } from "antd";
import { useMatch, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { sessionEpoch } from "@/services/api/canvas-client";
import { prepareCanvasConflictCopies } from "@/lib/canvas/save-recovery";
import { getDocumentDraft, getDocumentSaveStates, retryDocument, subscribeDocumentSaves, type DocumentSaveState } from "@/services/canvas-data";
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
    const states = useSyncExternalStore(subscribeDocumentSaves, getDocumentSaveStates, getDocumentSaveStates);
    const unsaved = states.some((state) => state.status !== "saved" && state.status !== "idle");
    useEffect(() => {
        if (!unsaved) return;
        const warn = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [unsaved]);
    const failures = states.filter((state) => state.status === "error" || state.status === "conflict");
    if (!failures.length) return null;
    return (
        <div id="document-save-recovery" tabIndex={-1} className="max-h-[35dvh] shrink-0 overflow-y-auto outline-none">
            {failures.map((state) => (
                <DocumentSaveIssue key={state.domain} state={state} />
            ))}
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
