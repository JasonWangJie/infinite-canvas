import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Alert, App, Button, Progress } from "antd";
import { Download, FileUp, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasImportStore } from "@/stores/canvas/use-canvas-import-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";

export default function CanvasPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const canvasImport = useCanvasImportStore();
    const importLocked = ["working", "saving", "save-error"].includes(canvasImport.status);
    const phaseLabels = { reading: "assetImport.reading", validating: "canvasImport.validating", uploading: "assetImport.uploading" };
    const importLabel = canvasImport.status === "working" ? phaseLabels[canvasImport.progress?.phase || "reading"] : canvasImport.status === "save-error" ? "canvasImport.saveError" : canvasImport.status === "error" ? "canvas.importFailed" : `canvasImport.${canvasImport.status}`;
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);

    const mode = searchParams.get("mode");
    const enterProject = (id: string) => {
        navigate(`/canvas/${id}`);
    };
    const createAndEnter = () => enterProject(createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        enterProject(mode === "new" ? createProject(t("canvas.defaultTitle", { count: projects.length + 1 })) : projects[0]?.id || createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    }, [createProject, hydrated, mode, projects, t]);

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">{t("canvas.opening")}</main>;

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">{t("canvas.library")}</p>
                        <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1>
                        <p className="mt-2 max-w-xl text-sm text-muted-foreground">{t("browserStorage.localDataHint")}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button
                                    disabled={!hydrated}
                                    icon={<Download className="size-4" />}
                                    onClick={() =>
                                        void exportCanvasProjects(
                                            projects.filter((project) => selectedIds.includes(project.id)),
                                            `${t("canvas.title")}-${selectedIds.length}`,
                                        ).catch((error) => message.error(error instanceof Error ? error.message : t("canvas.sidePanel.exportFailed")))
                                    }
                                >
                                    {t("canvas.exportSelected")}
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    {t("canvas.deleteSelected")}
                                </Button>
                            </>
                        ) : null}
                        {projects.length ? (
                            <Button disabled={!hydrated} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                                {t("canvas.deleteAll")}
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated || importLocked} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            {t("canvas.import")}
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                </header>

                {canvasImport.status !== "idle" ? (
                    <Alert showIcon type={canvasImport.status === "saved" ? "success" : canvasImport.status === "error" || canvasImport.status === "save-error" ? "error" : "info"} title={<span className="break-words">{t(importLabel)} · {canvasImport.fileName}</span>} description={
                        <div className="space-y-2" role="status">
                            {canvasImport.status === "working" && canvasImport.progress ? <>
                                {canvasImport.progress.total > 0 ? <div><div>{t("assetImport.progress", { completed: canvasImport.progress.completed, total: canvasImport.progress.total })}</div><Progress percent={Math.round(canvasImport.progress.completed / canvasImport.progress.total * 100)} showInfo={false} size="small" aria-label={t(phaseLabels[canvasImport.progress.phase])} /></div> : null}
                                {canvasImport.progress.item ? <p className="break-words">{canvasImport.progress.item}</p> : null}
                            </> : null}
                            {canvasImport.status === "saving" ? <p>{t("canvasImport.savingHint", { count: canvasImport.projectIds.length })}</p> : null}
                            {canvasImport.status === "saved" ? <p>{t("canvas.imported", { count: canvasImport.projectIds.length })}</p> : null}
                            {canvasImport.error ? <p className="whitespace-pre-wrap break-words">{canvasImport.error}</p> : null}
                            {canvasImport.status === "save-error" ? <><p>{t("canvasImport.saveErrorHint")}</p><Button onClick={() => void canvasImport.retrySave()}>{t("assetImport.retrySave")}</Button></> : null}
                        </div>
                    } />
                ) : null}

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</section>
                ) : projects.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {projects.map((project) => (
                            <CanvasProjectCard key={project.id} project={project} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
                        <p className="mt-3 text-sm text-stone-500">{t("canvas.emptyDescription")}</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" disabled={importLocked || !hydrated} onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void canvasImport.startImport(file);
            }} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
