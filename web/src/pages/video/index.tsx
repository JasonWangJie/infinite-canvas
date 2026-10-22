import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, LoaderCircle, Plus, SlidersHorizontal, Sparkles, Trash2, Upload, VideoIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { App, Button, Checkbox, Drawer, Empty, Input, Modal, Select, Tag, Typography } from "antd";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useLocation } from "react-router-dom";
import { useWorkbenchHistoryFilter } from "@/hooks/use-workbench-history-filter";
import { readClipboardImages, useReferenceImageImport } from "@/hooks/use-reference-image-import";
import { useWorkbenchHistoryFilterStore } from "@/stores/use-workbench-history-filter-store";
import { readTaskCenterDocument } from "@/services/task-center";
import { useTranslation } from "react-i18next";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { ResultToCanvasButton } from "@/components/result-to-canvas-button";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { VideoSettingsPanel, normalizeVideoResolutionValue, normalizeVideoSizeValue, videoModeLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { clampVideoSeconds } from "@/lib/media-size";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl, getImagePreviewRevision, previewUrlFor, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { createVideoGenerationTask, VideoGenerationUncertainError, type VideoGenerationTask } from "@/services/api/video";
import { assertAssetSaveReady, useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { boolConfig, modelMatchesCapability, modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";
import { sessionEpoch } from "@/services/api/canvas-client";
import { deleteVideoGenerationLogs, logStore, resumeVideoGeneration, serializeLog, updateExistingVideoLog, type GeneratedVideo, type GenerationLog, type GenerationLogConfig } from "./generation-log";

type GenerationResult = {
    id: string;
    status: GenerationLog["status"];
    log?: GenerationLog;
    video?: GeneratedVideo;
    error?: string;
};

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

export default function VideoPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const location = useLocation();
    const locationSearch = useRef(location.search);
    locationSearch.current = location.search;
    const linkedLogId = new URLSearchParams(location.search).get("log");
    const navigationRef = useRef("");
    const mounted = useRef(false);
    const latestLoad = useRef(0);
    const loadedSearch = useRef<string | null>(null);
    const interactionVersion = useRef(0);
    const historyInteraction = useRef(0);
    const cancelHistoryPreview = () => { historyInteraction.current += 1; };
    const [logsLoaded, setLogsLoaded] = useState(false);
    const [navigationError, setNavigationError] = useState("");
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const activeLogIdsRef = useRef<Set<string>>(new Set());
    const savingAssetIds = useRef(new Set<string>());
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAssetsAndSave = useAssetStore((state) => state.addAssetsAndSave);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const runningRef = useRef(running);
    runningRef.current = running;
    const visibleLogs = useWorkbenchHistoryFilter("video", logs);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [referenceDragTarget, setReferenceDragTarget] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const videoCommand = useWorkbenchAgentStore((state) => state.videoCommand);
    const clearVideoCommand = useWorkbenchAgentStore((state) => state.clearVideoCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    const modelReady = isAiConfigReady(effectiveConfig, model) && modelMatchesCapability(effectiveConfig, model, "video");
    const { importing: importingReferences, importReferences } = useReferenceImageImport((images) => setReferences((value) => [...value, ...images].slice(0, 7)), `${location.key}:${interactionVersion.current}`);
    const canGenerate = Boolean(prompt.trim()) && modelReady && !importingReferences;

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        mounted.current = true;
        loadedSearch.current = null;
        setLogsLoaded(false);
        setNavigationError("");
        void refreshLogs(!linkedLogId).catch((error) => {
            if (mounted.current) setNavigationError(error instanceof Error ? error.message : String(error));
        });
        return () => { mounted.current = false; latestLoad.current += 1; };
    }, [location.search]);

    useEffect(() => {
        const visible = new Set(visibleLogs.map((log) => log.id));
        setSelectedLogIds((ids) => ids.every((id) => visible.has(id)) ? ids : ids.filter((id) => visible.has(id)));
    }, [visibleLogs]);

    const addReferences = async (files?: FileList | null) => {
        const selectedFiles = Array.from(files || []);
        const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/"));
        if (unsupported.length) message.warning(t("videoWorkbench.unsupportedFiles"));
        const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/")).slice(0, 7 - references.length);
        await importReferences(imageFiles);
    };

    const handleReferenceDragEnter = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer.types.includes("Files")) setReferenceDragTarget(true);
    };

    const handleReferenceDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setReferenceDragTarget(false);
    };

    const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setReferenceDragTarget(false);
        void addReferences(event.dataTransfer.files);
    };

    const addReferencesFromClipboard = () => importReferences(async () => (await readClipboardImages()).slice(0, 7 - references.length));
    const generate = async () => {
        if (runningRef.current || importingReferences) return;
        const epoch = sessionEpoch();
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const snapshot = buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("videoWorkbench.invalidParams") });
            return;
        }
        interactionVersion.current += 1;
        runningRef.current = true;
        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults([{ id: nanoid(), status: "pending" }]);
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);
        // Persist an uncertain intent before submission: a reload while the POST
        // is in flight must never turn the same intent into a new paid request.
        let createdLog: GenerationLog = { ...buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, durationMs: 0, status: "unknown", error: t("managed.imageTaskUnknown") }), agentTaskId };
        try {
            await logStore.setItem(createdLog.id, serializeLog(createdLog));
            if (epoch !== sessionEpoch()) return;
            if (mounted.current) setLogs((items) => [createdLog, ...items]);
            const task = await createVideoGenerationTask(snapshot.config, snapshot.text, snapshot.references);
            if (epoch !== sessionEpoch()) return;
            const log: GenerationLog = { ...createdLog, status: "pending", error: undefined, task };
            createdLog = log;
            if (mounted.current) setLogs((items) => items.map((item) => item.id === log.id ? log : item));
            if (!await updateExistingVideoLog(log)) throw new Error(t("taskCenter.recordRemoved"));
            if (epoch !== sessionEpoch()) return;
            void pollGenerationLog(log, snapshot.config, agentTaskId);
        } catch (error) {
            if (epoch !== sessionEpoch()) return;
            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");
            const failedLog: GenerationLog = { ...createdLog, status: createdLog.task ? "paused" : error instanceof VideoGenerationUncertainError ? "unknown" : "failed", durationMs: performance.now() - batchStartedAt, error: errorMessage };
            if (mounted.current) {
                setResults([{ id: failedLog.id, status: failedLog.status, log: failedLog, error: errorMessage }]);
                setLogs((items) => items.some((item) => item.id === failedLog.id) ? items.map((item) => item.id === failedLog.id ? failedLog : item) : [failedLog, ...items]);
            }
            if (agentTaskId) updateAgentTask(agentTaskId, { status: failedLog.status === "failed" ? "failed" : "running", successCount: 0, failCount: failedLog.status === "failed" ? 1 : 0, error: errorMessage });
            try {
                await saveLog(failedLog);
            } catch (storageError) {
                if (mounted.current && epoch === sessionEpoch()) message.warning(storageError instanceof Error ? storageError.message : String(storageError));
            } finally {
                if (mounted.current && epoch === sessionEpoch()) {
                    message.error(errorMessage);
                    runningRef.current = false;
                    setRunning(false);
                }
            }
        }
    };

    // Handle video-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!videoCommand || videoCommand.nonce === processedCommandRef.current) return;
        cancelHistoryPreview();
        processedCommandRef.current = videoCommand.nonce;
        clearVideoCommand();
        if (typeof videoCommand.prompt === "string") setPrompt(videoCommand.prompt);
        if (videoCommand.run && (running || importingReferences)) {
            if (videoCommand.taskId) updateAgentTask(videoCommand.taskId, { status: "failed", error: t("videoWorkbench.busy") });
            return;
        }
        if (videoCommand.run) {
            agentTaskIdRef.current = videoCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [videoCommand, clearVideoCommand, running, importingReferences, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error(t("videoWorkbench.promptRequired"));
            return null;
        }
        if (importingReferences) return null;
        if (!modelReady) {
            message.warning(t("workbench.modelUnavailable"));
            openConfigDialog(true);
            return null;
        }
        return { text, config: buildVideoConfig(effectiveConfig, model), references: [...references] };
    };

    const retryResult = (result: GenerationResult) => {
        if (result.status === "unknown") return;
        if (result.status === "paused" && result.log?.task) {
            void pollGenerationLog(result.log);
            return;
        }
        void generate();
    };

    const downloadVideo = (video: GeneratedVideo) => {
        saveAs(video.url, "video.mp4");
    };

    const saveResultToAssets = async (video: GeneratedVideo) => {
        const epoch = sessionEpoch(), key = `${epoch}:${video.id}`;
        if (savingAssetIds.current.has(key)) return;
        savingAssetIds.current.add(key);
        try {
            assertAssetSaveReady(epoch);
            await addAssetsAndSave([{
                kind: "video",
                title: t("videoWorkbench.resultTitle"),
                coverUrl: "",
                tags: [],
                source: t("videoWorkbench.source"),
                data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, bytes: video.bytes, mimeType: video.mimeType },
                metadata: { source: "video-page", prompt },
            }], epoch);
            if (epoch === sessionEpoch()) message.success(t("common.addedToAssets"));
        } catch (error) {
            if (epoch === sessionEpoch()) message.error(error instanceof Error ? error.message : t("assets.formSaveUnconfirmed"));
        } finally {
            savingAssetIds.current.delete(key);
        }
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }].slice(0, 7));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        if (runningRef.current) return;
        interactionVersion.current += 1;
        setPrompt("");
        setReferences([]);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = async () => {
        const epoch = sessionEpoch();
        const ids = visibleLogs.filter((log) => selectedLogIds.includes(log.id)).map((log) => log.id);
        if (!ids.length) return;
        try {
            await deleteVideoGenerationLogs(ids);
            if (!mounted.current || epoch !== sessionEpoch()) return;
            await refreshLogs(false);
            if (previewLog && ids.includes(previewLog.id)) {
                setPreviewLog(null);
                setResults([]);
            }
            setSelectedLogIds([]);
            setDeleteConfirmOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("workbench.generationFailed"));
        }
    };

    const saveLog = async (log: GenerationLog, resumePending = false) => {
        await updateExistingVideoLog(log);
        if (mounted.current) await refreshLogs(resumePending);
    };

    const refreshLogs = async (resumePending = false) => {
        const epoch = sessionEpoch();
        const load = ++latestLoad.current;
        const search = locationSearch.current;
        const nextLogs = await readStoredLogs();
        if (!mounted.current || epoch !== sessionEpoch() || load !== latestLoad.current || search !== locationSearch.current) return [];
        loadedSearch.current = search;
        setLogs(nextLogs);
        setLogsLoaded(true);
        if (resumePending && !runningRef.current) resumePendingLogs(nextLogs);
        return nextLogs;
    };

    const resumePendingLogs = (items: GenerationLog[]) => {
        for (const log of items) {
            if ((log.status === "pending" || log.status === "paused") && log.task) void pollGenerationLog(log);
        }
    };

    const pollGenerationLog = async (log: GenerationLog, configOverride?: AiConfig, agentTaskId?: string) => {
        if (!log.task || activeLogIdsRef.current.has(log.id)) return;
        const epoch = sessionEpoch();
        const linkedAgentTaskId = agentTaskId || log.agentTaskId;
        activeLogIdsRef.current.add(log.id);
        if (mounted.current) {
            runningRef.current = true;
            setRunning(true);
            setStartedAt((value) => value || performance.now());
            setResults([{ id: log.id, status: "pending", log }]);
        }
        const taskConfig = buildVideoConfig({ ...effectiveConfig, ...log.config }, log.task.model || log.model);
        try {
            const next = await normalizeLog(await resumeVideoGeneration(log, configOverride || taskConfig), true);
            if (!mounted.current || epoch !== sessionEpoch()) return;
            setResults([{ id: next.id, status: next.status, video: next.video, error: next.error, log: next }]);
            setLogs((items) => items.map((item) => (item.id === next.id ? next : item)));
            if (linkedAgentTaskId)
                updateAgentTask(linkedAgentTaskId, {
                    status: next.status === "success" ? "succeeded" : next.status === "failed" ? "failed" : "running",
                    successCount: next.status === "success" ? 1 : 0,
                    failCount: next.status === "failed" ? 1 : 0,
                    error: next.error,
                });
            if (next.status === "success") message.success(t("videoWorkbench.generated"));
            else if (next.error) message.warning(next.error);
        } catch (error) {
            if (mounted.current && epoch === sessionEpoch()) message.error(error instanceof Error ? error.message : String(error));
        } finally {
            activeLogIdsRef.current.delete(log.id);
            if (mounted.current && epoch === sessionEpoch() && !activeLogIdsRef.current.size) {
                runningRef.current = false;
                setRunning(false);
                setStartedAt(0);
            }
        }
    };

    const previewGenerationLog = async (log: GenerationLog) => {
        if (runningRef.current) return;
        const version = interactionVersion.current, epoch = sessionEpoch(), search = locationSearch.current;
        const interaction = ++historyInteraction.current;
        try {
            log = await normalizeLog(log, true);
        } catch (error) {
            if (mounted.current && epoch === sessionEpoch() && version === interactionVersion.current && search === locationSearch.current && interaction === historyInteraction.current) setNavigationError(error instanceof Error ? error.message : String(error));
            return;
        }
        if (!mounted.current || epoch !== sessionEpoch() || version !== interactionVersion.current || search !== locationSearch.current || interaction !== historyInteraction.current) return;
        interactionVersion.current += 1;
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (log.config.videoModel || log.model) updateConfig("videoModel", log.config.videoModel || log.model);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.vquality) updateConfig("vquality", log.config.vquality);
        if (log.config.videoSeconds) updateConfig("videoSeconds", log.config.videoSeconds);
        if (log.config.videoGenerateAudio) updateConfig("videoGenerateAudio", log.config.videoGenerateAudio);
        if (log.config.videoWatermark) updateConfig("videoWatermark", log.config.videoWatermark);
        if (log.config.videoMode) updateConfig("videoMode", log.config.videoMode);
        setResults([{ id: log.id, status: log.status, log, video: log.video, error: log.error }]);
    };

    useEffect(() => {
        const key = `${location.key}:${linkedLogId || ""}`;
        if (!linkedLogId || !logsLoaded || loadedSearch.current !== location.search || running || navigationRef.current === key) return;
        navigationRef.current = key;
        const log = logs.find((item) => item.id === linkedLogId);
        if (log) {
            setNavigationError("");
            void previewGenerationLog(log);
        } else {
            setNavigationError(t("workbench.historySourceMissing"));
        }
    }, [location.key, location.search, linkedLogId, logsLoaded, logs, running, t]);

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100" onClickCapture={cancelHistoryPreview} onKeyDownCapture={cancelHistoryPreview} onInputCapture={cancelHistoryPreview} onDropCapture={cancelHistoryPreview}>
            {navigationError ? <p role="alert" className="px-4 pt-3 text-sm text-destructive">{navigationError}</p> : null}
            {linkedLogId && running && navigationRef.current !== `${location.key}:${linkedLogId}` ? <p role="status" className="px-4 pt-3 text-sm text-muted-foreground">{t("workbench.historyWaitForGeneration")}</p> : null}
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel
                        logs={logs}
                        disabled={running}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={previewGenerationLog}
                    />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div className="flex items-start justify-between gap-3">
                            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("videoWorkbench.title")}</h1>
                            <div className="flex shrink-0 gap-2 lg:hidden">
                                <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                    {t("workbench.logs")}
                                </Button>
                                <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.settings")}
                                </Button>
                            </div>
                        </div>

                        <div className="mt-6 space-y-5">
                            <div>
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{t("workbench.prompt")}</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            {t("workbench.viewPrompts")}
                                        </Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            {t("workbench.viewAssets")}
                                        </Button>
                                    </div>
                                </div>
                                <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder={t("videoWorkbench.promptPlaceholder")} />
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{t("videoWorkbench.references")}</span>
                                    <div className="flex gap-2">
                                        <Button size="small" disabled={importingReferences} icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            {t("workbench.clipboard")}
                                        </Button>
                                        <Button size="small" loading={importingReferences} icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            {t("workbench.upload")}
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${referenceDragTarget ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={handleReferenceDragEnter}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={handleReferenceDragLeave}
                                    onDrop={handleReferenceDrop}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{index + 1}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label={t("videoWorkbench.removeImage")}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {importingReferences ? <span role="status" className="self-center text-sm text-muted-foreground">{t("workbench.importingReferences")}</span> : null}
                                    {!references.length && !importingReferences ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{referenceDragTarget ? t("videoWorkbench.dropReferences") : t("videoWorkbench.noImages")}</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {normalizeResolution(effectiveConfig.vquality)}p · {videoSizeLabel(effectiveConfig.size)} · {normalizeVideoSeconds(effectiveConfig.videoSeconds)}s ·{" "}
                                    {videoModeLabel(effectiveConfig.videoMode)}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.adjust")}
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
                            {!modelReady ? <p role="status" className="mb-2 text-sm text-muted-foreground">{t("workbench.modelUnavailable")} <Button type="link" size="small" onClick={() => openConfigDialog(false)}>{t("workbench.settings")}</Button></p> : null}
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate || running} onClick={() => void generate()}>
                                {t("workbench.generate")}
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <h2 className="text-xl font-semibold">{t("workbench.results")}</h2>
                            {running ? <Tag className="m-0 px-2 py-1">{t("workbench.waiting", { time: formatDuration(elapsedMs) })}</Tag> : null}
                        </div>
                        {results.length ? (
                            <div className="grid gap-4">
                                {results.map((result) =>
                                    result.status === "success" && result.video ? (
                                        <ResultVideoCard key={result.id} video={result.video} onDownload={downloadVideo} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "failed" || result.status === "paused" || result.status === "unknown" ? (
                                        <FailedVideoCard key={result.id} paused={result.status === "paused"} unknown={result.status === "unknown"} error={result.error || t(result.status === "unknown" ? "managed.imageTaskUnknown" : "workbench.generationFailed")} disabled={running} onRetry={() => retryResult(result)} />
                                    ) : (
                                        <PendingVideoCard key={result.id} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <VideoIcon className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("videoWorkbench.empty")} />
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title={t("workbench.logs")} placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel
                    logs={logs}
                    disabled={running}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={previewGenerationLog}
                />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" height="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
                <p className="mt-2 text-sm text-stone-500">{t("videoWorkbench.deleteLogsHint")}</p>
            </Modal>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t("workbench.model")}</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("videoModel", value)} capability="video" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <VideoSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" />
            </div>
        </>
    );
}

function ResultVideoCard({ video, onDownload, onSaveAsset }: { video: GeneratedVideo; onDownload: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo) => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <video src={video.url} controls className="aspect-video w-full bg-black object-contain" />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {video.width}x{video.height}
                    </span>
                    <span>{formatBytes(video.bytes)}</span>
                    <span>{formatDuration(video.durationMs)}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                    <ResultToCanvasButton result={{ ...video, kind: "video", title: t("videoWorkbench.resultTitle") }} />
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(video)}>
                        {t("common.addToAssets")}
                    </Button>
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(video)}>
                        {t("common.download")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function PendingVideoCard() {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-video overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedVideoCard({ error, onRetry, paused, unknown, disabled }: { error: string; onRetry: () => void; paused: boolean; unknown: boolean; disabled: boolean }) {
    const { t } = useTranslation();
    const attention = paused || unknown;
    return (
        <div className={`overflow-hidden rounded-lg border ${attention ? "border-stone-200 bg-background dark:border-stone-800" : "border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20"}`}>
            <div className="flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
                <div className={`text-sm font-medium ${attention ? "text-stone-600 dark:text-stone-300" : "text-red-600 dark:text-red-300"}`}>{t(unknown ? "managed.taskPending" : paused ? "videoWorkbench.paused" : "workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs">
                    {error}
                </Typography.Paragraph>
                {paused ? <p className="text-xs text-stone-500">{t("videoWorkbench.resumeHint")}</p> : null}
            </div>
            {!unknown ? <div className={`flex justify-end border-t p-3 ${paused ? "border-stone-200 dark:border-stone-800" : "border-red-200 dark:border-red-950"}`}>
                <Button size="small" danger={!paused} disabled={disabled} onClick={onRetry}>
                    {t(paused ? "videoWorkbench.resume" : "videoWorkbench.regenerate")}
                </Button>
            </div> : null}
        </div>
    );
}

function LogPanel({
    logs,
    disabled,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    disabled: boolean;
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const { t } = useTranslation();
    const visibleLogs = useWorkbenchHistoryFilter("video", logs);
    const filter = useWorkbenchHistoryFilterStore((state) => state.video);
    const updateFilter = useWorkbenchHistoryFilterStore((state) => state.update);
    const allSelected = Boolean(visibleLogs.length) && visibleLogs.every((log) => selectedLogIds.includes(log.id));
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : visibleLogs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{t("workbench.logs")}</h2>
                <Tag className="m-0">{visibleLogs.length} / {logs.length}</Tag>
            </div>
            <div className="mb-3 space-y-2">
                <Input allowClear value={filter.query} aria-label={t("workbench.historySearch")} placeholder={t("workbench.historySearch")} onChange={(event) => updateFilter("video", { query: event.target.value })} />
                <div className="flex gap-2">
                    <Select className="min-w-0 flex-1" aria-label={t("workbench.historyStatus")} value={filter.status} onChange={(status) => updateFilter("video", { status })} options={[
                        { value: "all", label: t("workbench.historyAllStatuses") },
                        { value: "success", label: t("workbench.success") },
                        { value: "failed", label: t("workbench.failed") },
                        { value: "pending", label: t("workbench.generating") },
                        { value: "paused", label: t("videoWorkbench.paused") },
                        { value: "unknown", label: t("managed.taskPending") },
                    ]} />
                    <Button disabled={!filter.query && filter.status === "all"} onClick={() => updateFilter("video", { query: "", status: "all" })}>{t("workbench.historyClearFilters")}</Button>
                </div>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} disabled={disabled} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!visibleLogs.length} onClick={toggleAll}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    {t("common.delete")}
                </Button>
            </div>
            {selectedLogIds.length ? <p role="status" className="mb-3 text-xs text-muted-foreground">{t("workbench.historySelectedCount", { count: selectedLogIds.length })}</p> : null}
            <div className="space-y-3">
                {visibleLogs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => { if (!disabled) onPreviewLog(log); }}
                    />
                ))}
                {!visibleLogs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">{t(logs.length ? "workbench.historyNoMatches" : "workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
                <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.size}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.resolution}p</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.seconds}s</Tag>
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color={log.status === "success" ? "blue" : log.status === "pending" ? "processing" : log.status === "paused" || log.status === "unknown" ? "warning" : "red"}>
                        {t(log.status === "unknown" ? "managed.taskPending" : log.status === "paused" ? "videoWorkbench.paused" : `workbench.${log.status === "success" ? "success" : log.status === "pending" ? "generating" : "failed"}`)}
                    </Tag>
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                        {formatDuration(log.durationMs)}
                    </Tag>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs() {
    const stored = await readTaskCenterDocument("video-workbench");
    const logs = stored && typeof stored === "object" && !Array.isArray(stored) ? Object.values(stored) as GenerationLog[] : [];
    return (await Promise.all(logs.map((log) => normalizeLog(log)))).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function normalizeLog(log: Partial<GenerationLog>, loadMedia = false): Promise<GenerationLog> {
    const video = log.video?.storageKey ? { ...log.video, url: loadMedia ? await resolveMediaUrl(log.video.storageKey, log.video.url) : "" } : log.video;
    const references = await Promise.all(
        (log.references || []).map(async (item) => ({ ...item, dataUrl: !loadMedia && item.storageKey ? "" : await resolveImageUrl(item.storageKey, item.dataUrl) })),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.videoModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        size: log.size || config.size || "",
        resolution: normalizeResolution(log.resolution || config.vquality || ""),
        seconds: log.seconds || config.videoSeconds || "",
        status: log.status || "success",
        task: log.task,
        agentTaskId: log.agentTaskId,
        video,
        error: log.error,
    };
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        videoModel: log.config?.videoModel || log.model || "",
        size: log.config?.size || log.size || "",
        vquality: normalizeResolution(log.config?.vquality || log.resolution || ""),
        videoSeconds: log.config?.videoSeconds || log.seconds || "",
        videoGenerateAudio: log.config?.videoGenerateAudio || "true",
        videoWatermark: log.config?.videoWatermark || "false",
        videoMode: log.config?.videoMode === "reference" ? "reference" : "frames",
    };
}

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    status,
    task,
    video,
    error,
}: {
    prompt: string;
    model: string;
    config: AiConfig;
    references: ReferenceImage[];
    durationMs: number;
    status: GenerationLog["status"];
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
}): GenerationLog {
    const logConfig = {
        model: config.model,
        videoModel: config.videoModel,
        size: config.size,
        vquality: normalizeResolution(config.vquality),
        videoSeconds: config.videoSeconds,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
        videoMode: config.videoMode === "reference" ? "reference" : "frames",
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt,
        time: new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        size: logConfig.size,
        resolution: logConfig.vquality,
        seconds: logConfig.videoSeconds,
        status,
        task,
        video,
        error,
    };
}

function buildVideoConfig(config: AiConfig, model: string): AiConfig {
    return {
        ...config,
        model,
        videoModel: model,
        size: normalizeVideoSize(config.size),
        videoSeconds: normalizeVideoSeconds(config.videoSeconds),
        vquality: normalizeResolution(config.vquality),
        videoGenerateAudio: String(boolConfig(config.videoGenerateAudio, true)),
        videoWatermark: String(boolConfig(config.videoWatermark, false)),
        videoMode: config.videoMode === "reference" ? "reference" : "frames",
    };
}

function normalizeVideoSeconds(value: string) {
    if (String(value).trim() === "-1") return "-1";
    return clampVideoSeconds(value);
}

function normalizeVideoSize(value: string) {
    return normalizeVideoSizeValue(value);
}

function normalizeResolution(value: string) {
    return normalizeVideoResolutionValue(value);
}
