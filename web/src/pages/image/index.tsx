import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, Plus, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Checkbox, Drawer, Empty, Image, Input, Modal, Select, Tag, Tooltip, Typography } from "antd";
import { createRecordStore, writeDocument } from "@/services/canvas-data";
import { saveAs } from "file-saver";
import { useLocation } from "react-router-dom";
import { useWorkbenchHistoryFilter } from "@/hooks/use-workbench-history-filter";
import { readClipboardImages, useReferenceImageImport } from "@/hooks/use-reference-image-import";
import { useWorkbenchHistoryFilterStore } from "@/stores/use-workbench-history-filter-store";
import { readTaskCenterDocument } from "@/services/task-center";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { ResultToCanvasButton } from "@/components/result-to-canvas-button";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { modelOptionLabel, modelMatchesCapability, supportsAsyncImageGeneration, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { ImageGenerationUncertainError, requestAsyncImageGeneration, requestEdit, requestGeneration } from "@/services/api/image";
import { ImageTaskPanel } from "./image-task-panel";
import { ensureImagePreview, getImagePreviewRevision, previewUrlFor, readStoredImage, resolveImageUrl, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { assertAssetSaveReady, useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";
import { sessionEpoch } from "@/services/api/canvas-client";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed" | "recoverable";
    image?: GeneratedImage;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "success" | "failed";
    images: GeneratedImage[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";
const logStore = createRecordStore("image-workbench");

export default function ImagePage() {
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
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAssetsAndSave = useAssetStore((state) => state.addAssetsAndSave);
    const savingAssetIds = useRef(new Set<string>());
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [selectedResultIds, setSelectedResultIds] = useState<string[]>([]);
    const successfulResults = results.flatMap((result, index) => result.status === "success" && result.image ? [{ image: result.image, index }] : []);
    const selectedResults = successfulResults.filter(({ image }) => selectedResultIds.includes(image.id));
    const allResultsSelected = Boolean(successfulResults.length) && selectedResults.length === successfulResults.length;
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const runningRef = useRef(running);
    runningRef.current = running;
    const visibleLogs = useWorkbenchHistoryFilter("image", logs);
    const [asyncMode, setAsyncMode] = useState(false);
    const [taskRevision, setTaskRevision] = useState(0);
    const submittingAsync = useRef(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const imageCommand = useWorkbenchAgentStore((state) => state.imageCommand);
    const clearImageCommand = useWorkbenchAgentStore((state) => state.clearImageCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const modelReady = isAiConfigReady(effectiveConfig, model) && modelMatchesCapability(effectiveConfig, model, "image");
    const asyncSupported = supportsAsyncImageGeneration(effectiveConfig, model);
    const { importing: importingReferences, importReferences } = useReferenceImageImport((images) => setReferences((value) => [...value, ...images]), `${location.key}:${interactionVersion.current}`);
    const canGenerate = Boolean(prompt.trim()) && modelReady && !importingReferences;
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));

    useEffect(() => { if (!asyncSupported) setAsyncMode(false); }, [asyncSupported]);

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
        void refreshLogs().catch((error) => {
            if (mounted.current) setNavigationError(error instanceof Error ? error.message : String(error));
        });
        return () => { mounted.current = false; latestLoad.current += 1; };
    }, [location.search]);

    useEffect(() => {
        const visible = new Set(visibleLogs.map((log) => log.id));
        setSelectedLogIds((ids) => ids.every((id) => visible.has(id)) ? ids : ids.filter((id) => visible.has(id)));
    }, [visibleLogs]);

    useEffect(() => {
        const available = new Set(results.flatMap((result) => result.status === "success" && result.image ? [result.image.id] : []));
        setSelectedResultIds((ids) => ids.every((id) => available.has(id)) ? ids : ids.filter((id) => available.has(id)));
    }, [results]);

    const addReferences = async (files?: FileList | null) => {
        await importReferences(Array.from(files || []));
    };

    const addReferencesFromClipboard = () => importReferences(readClipboardImages);

    const generate = async () => {
        if (submittingAsync.current || runningRef.current || importingReferences) return;
        const epoch = sessionEpoch();
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const text = prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.promptRequired") });
            return;
        }
        if (!modelReady) {
            message.warning(t("workbench.modelUnavailable"));
            openConfigDialog(true);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.configIncomplete") });
            return;
        }

        const snapshot = buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.invalidParams") });
            return;
        }

        interactionVersion.current += 1;
        runningRef.current = true;
        setSelectedResultIds([]);
        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults(Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending" })));
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);

        if (asyncMode && asyncSupported && !agentTaskId) {
            if (submittingAsync.current) return;
            submittingAsync.current = true;
            try {
                await requestAsyncImageGeneration({ ...snapshot.config, count: String(generationCount) }, text, snapshot.references, nanoid());
                if (mounted.current && epoch === sessionEpoch()) message.success(t("managed.imageTaskSubmitted"));
            } catch (error) {
                if (mounted.current && epoch === sessionEpoch()) message.error(error instanceof Error ? error.message : t("workbench.generationFailed"));
            } finally {
                submittingAsync.current = false;
                if (mounted.current && epoch === sessionEpoch()) {
                    runningRef.current = false;
                    setRunning(false);
                    setResults([]);
                    setTaskRevision((value) => value + 1);
                }
            }
            return;
        }

        const tasks = Array.from({ length: generationCount }, (_, index) => runGenerationSlot(index, snapshot));

        const result = await Promise.allSettled(tasks);
        if (epoch !== sessionEpoch()) return;
        const successImages = result.filter((item): item is PromiseFulfilledResult<GeneratedImage> => item.status === "fulfilled").map((item) => item.value);
        const successCount = successImages.length;
        const failCount = generationCount - successCount;
        const failed = result.find((item): item is PromiseRejectedResult => item.status === "rejected");
        const error = failed?.reason instanceof Error ? failed.reason.message : failCount ? t("workbench.generationFailed") : undefined;
        if (agentTaskId) updateAgentTask(agentTaskId, { status: successCount ? "succeeded" : "failed", successCount, failCount, error: successCount ? undefined : error });

        try {
            saveLog(
                buildLog({
                    prompt: text,
                    model,
                    config: { ...snapshot.config, count: String(generationCount) },
                    references: snapshot.references,
                    durationMs: performance.now() - batchStartedAt,
                    successCount,
                    failCount,
                    status: successCount ? "success" : "failed",
                    images: successImages,
                }),
            );
            if (mounted.current) successCount ? message.success(t("imageWorkbench.generated")) : message.error(failed?.reason instanceof Error ? failed.reason.message : t("workbench.generationFailed"));
        } finally {
            if (mounted.current) {
                runningRef.current = false;
                setRunning(false);
                setTaskRevision((value) => value + 1);
            }
        }
    };

    // Handle image-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!imageCommand || imageCommand.nonce === processedCommandRef.current) return;
        cancelHistoryPreview();
        processedCommandRef.current = imageCommand.nonce;
        clearImageCommand();
        if (typeof imageCommand.prompt === "string") setPrompt(imageCommand.prompt);
        if (imageCommand.run && (running || importingReferences)) {
            if (imageCommand.taskId) updateAgentTask(imageCommand.taskId, { status: "failed", error: t("imageWorkbench.busy") });
            return;
        }
        if (imageCommand.run) {
            agentTaskIdRef.current = imageCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [imageCommand, clearImageCommand, running, importingReferences, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        message.success(t("imageWorkbench.addedReference"));
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const epoch = sessionEpoch(), key = `${epoch}:${image.id}`;
        if (savingAssetIds.current.has(key)) return;
        savingAssetIds.current.add(key);
        try {
            assertAssetSaveReady(epoch);
            const stored = await uploadImage(image.dataUrl);
            await addAssetsAndSave([{
                kind: "image",
                title: t("imageWorkbench.resultTitle", { count: index + 1 }),
                coverUrl: stored.url,
                tags: [],
                source: t("imageWorkbench.source"),
                data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
                metadata: { source: "image-page", prompt },
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
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        } else {
            message.warning(t("imageWorkbench.unsupportedAsset"));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        if (runningRef.current) return;
        interactionVersion.current += 1;
        setPrompt("");
        setReferences([]);
        setResults([]);
        setSelectedResultIds([]);
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
            // Generated files may already belong to a canvas or an asset; remove history only.
            await writeDocument("image-workbench", (previous) => {
                const next = { ...(previous as Record<string, GenerationLog> || {}) };
                for (const id of ids) delete next[id];
                return next;
            });
            if (!mounted.current || epoch !== sessionEpoch()) return;
            await refreshLogs();
            if (!mounted.current || epoch !== sessionEpoch()) return;
            if (previewLog && ids.includes(previewLog.id)) {
                setPreviewLog(null);
                setResults([]);
            }
            setSelectedLogIds([]);
            setDeleteConfirmOpen(false);
        } catch (error) {
            if (mounted.current && epoch === sessionEpoch()) message.error(error instanceof Error ? error.message : String(error));
        }
    };

    const saveLog = (log: GenerationLog) => {
        void logStore.setItem(log.id, serializeLog(log)).then(() => mounted.current ? refreshLogs() : undefined).catch((error) => {
            if (mounted.current) message.error(error instanceof Error ? error.message : String(error));
        });
    };

    const refreshLogs = async () => {
        const epoch = sessionEpoch();
        const load = ++latestLoad.current;
        const search = locationSearch.current;
        const nextLogs = await readStoredLogs();
        if (!mounted.current || epoch !== sessionEpoch() || load !== latestLoad.current || search !== locationSearch.current) return [];
        loadedSearch.current = search;
        setLogs(nextLogs);
        setLogsLoaded(true);
        return nextLogs;
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
        setSelectedResultIds([]);
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
        setResults(log.images.map((image) => ({ id: image.id, status: "success", image })));
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

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            return null;
        }
        if (importingReferences) return null;
        if (!modelReady) {
            message.warning(t("workbench.modelUnavailable"));
            openConfigDialog(true);
            return null;
        }
        return { text, config: { ...effectiveConfig, model, count: "1" }, references: [...references] };
    };

    const runGenerationSlot = async (index: number, snapshot: { text: string; config: AiConfig; references: ReferenceImage[] }) => {
        const epoch = sessionEpoch();
        const version = interactionVersion.current;
        const itemStartedAt = performance.now();
        let received = false;
        try {
            const result = snapshot.references.length ? await requestEdit(snapshot.config, snapshot.text, snapshot.references) : await requestGeneration(snapshot.config, snapshot.text);
            if (epoch !== sessionEpoch()) throw new Error(t("saveRecovery.sessionChanged"));
            received = true;
            const image = result[0];
            if (!image) throw new Error(t("imageWorkbench.missingResult"));
            const stored = await uploadImage(image.dataUrl);
            const nextImage: GeneratedImage = {
                id: image.id,
                dataUrl: stored.url,
                ...(stored.storageKey ? { storageKey: stored.storageKey } : {}),
                durationMs: performance.now() - itemStartedAt,
                width: stored.width,
                height: stored.height,
                bytes: stored.bytes,
                mimeType: stored.mimeType,
            };
            if (mounted.current && epoch === sessionEpoch() && version === interactionVersion.current) setResults((value) => updateResultAt(value, index, { status: "success", image: nextImage }));
            return nextImage;
        } catch (error) {
            if (mounted.current && epoch === sessionEpoch() && version === interactionVersion.current) setResults((value) => updateResultAt(value, index, { status: received || error instanceof ImageGenerationUncertainError ? "recoverable" : "failed", error: error instanceof Error ? error.message : t("workbench.generationFailed") }));
            throw error;
        }
    };

    const retryResult = async (index: number) => {
        if (runningRef.current) return;
        const epoch = sessionEpoch();
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        setPreviewLog(null);
        setResults((value) => updateResultAt(value, index, { status: "pending", error: undefined, image: undefined }));
        interactionVersion.current += 1;
        runningRef.current = true;
        setRunning(true);
        const retryStartedAt = performance.now();
        try {
            const image = await runGenerationSlot(index, snapshot);
            if (epoch !== sessionEpoch()) return;
            saveLog(
                buildLog({
                    prompt: snapshot.text,
                    model,
                    config: { ...snapshot.config, count: "1" },
                    references: snapshot.references,
                    durationMs: performance.now() - retryStartedAt,
                    successCount: 1,
                    failCount: 0,
                    status: "success",
                    images: [image],
                }),
            );
            if (mounted.current) message.success(t("workbench.retrySuccess"));
        } catch {
            // runGenerationSlot has already marked the result as failed.
        } finally {
            if (mounted.current && epoch === sessionEpoch()) {
                runningRef.current = false;
                setRunning(false);
            }
        }
    };

    const resultsViewVersion = interactionVersion.current;
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
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("imageWorkbench.title")}</h1>
                                </div>
                                <div className="flex shrink-0 gap-2 lg:hidden">
                                    <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                        {t("workbench.logs")}
                                    </Button>
                                    <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                        {t("workbench.settings")}
                                    </Button>
                                </div>
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
                                <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder={t("imageWorkbench.promptPlaceholder")} />
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{t("imageWorkbench.references")}</span>
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
                                    className={`hover-scrollbar hover-scrollbar-hint relative flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${isReferenceDragActive ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current += 1;
                                        if (event.dataTransfer.types.includes("Files")) setIsReferenceDragActive(true);
                                    }}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                                        if (!dragDepthRef.current) setIsReferenceDragActive(false);
                                    }}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = 0;
                                        setIsReferenceDragActive(false);
                                        void addReferences(event.dataTransfer.files);
                                    }}
                                    onWheel={(event) => {
                                        if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                        event.preventDefault();
                                        event.currentTarget.scrollLeft += event.deltaY;
                                    }}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label={t("imageWorkbench.removeReference")}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {importingReferences ? <span role="status" className="self-center text-sm text-muted-foreground">{t("workbench.importingReferences")}</span> : null}
                                    {!references.length && !importingReferences ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{isReferenceDragActive ? t("imageWorkbench.dropReferences") : t("imageWorkbench.noReferences")}</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {effectiveConfig.size} · {effectiveConfig.quality}
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
                            <Checkbox checked={asyncMode && asyncSupported} disabled={running || !asyncSupported} onChange={(event) => setAsyncMode(event.target.checked)}>
                                {t("managed.asyncImage")}
                            </Checkbox>
                            {asyncMode ? <p className="my-2 text-xs text-muted-foreground">{t("managed.asyncImageHint")}</p> : null}
                            {!asyncSupported && modelReady ? <p className="my-2 text-xs text-muted-foreground">{t("managed.asyncImageUnsupported")}</p> : null}
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate || running} onClick={() => void generate()}>
                                {t("workbench.generate")}
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <ImageTaskPanel
                            revision={taskRevision}
                            generating={running}
                            selectedTaskId={new URLSearchParams(location.search).get("task")}
                            onOpen={async (images) => {
                                if (runningRef.current || resultsViewVersion !== interactionVersion.current || location.search !== locationSearch.current) return;
                                const epoch = sessionEpoch();
                                const version = resultsViewVersion;
                                const stored = await Promise.all(
                                    images.map(async (image) => {
                                        const privateFile = /^local-file:([^/?#]+)$/.exec(image.dataUrl);
                                        const file = privateFile ? await readStoredImage(decodeURIComponent(privateFile[1])) : await uploadImage(image.dataUrl);
                                        return {
                                            id: image.id,
                                            status: "success" as const,
                                            image: { id: image.id, dataUrl: file.url, storageKey: file.storageKey, durationMs: 0, width: file.width, height: file.height, bytes: file.bytes, mimeType: file.mimeType },
                                        };
                                    }),
                                );
                                if (!mounted.current || epoch !== sessionEpoch() || runningRef.current || version !== interactionVersion.current || location.search !== locationSearch.current) return;
                                setPreviewLog(null);
                                setSelectedResultIds([]);
                                setResults(stored);
                            }}
                        />
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div>
                                <h2 className="text-xl font-semibold">{t("workbench.results")}</h2>
                            </div>
                            {running ? <Tag className="m-0 px-2 py-1">{t("workbench.waiting", { time: formatDuration(elapsedMs) })}</Tag> : null}
                        </div>
                        <div className="mb-4 flex flex-wrap items-start gap-x-3 gap-y-2">
                            <Checkbox checked={allResultsSelected} indeterminate={Boolean(selectedResults.length) && !allResultsSelected} disabled={!successfulResults.length} onChange={(event) => setSelectedResultIds(event.target.checked ? successfulResults.map(({ image }) => image.id) : [])}>
                                {t("resultToCanvas.selectAllResults")}
                            </Checkbox>
                            <Button type="text" size="small" disabled={!selectedResults.length} onClick={() => setSelectedResultIds([])}>{t("resultToCanvas.clearSelection")}</Button>
                            <span role="status" className="text-xs leading-6 text-muted-foreground">{t("resultToCanvas.selectedCount", { count: selectedResults.length })}</span>
                            <div className="min-w-0 flex-1 basis-48">
                                <ResultToCanvasButton results={selectedResults.map(({ image, index }) => ({ ...image, kind: "image", url: image.dataUrl, title: t("imageWorkbench.resultTitle", { count: index + 1 }) }))} />
                            </div>
                        </div>
                        {results.length ? (
                            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                                {results.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard key={result.id} image={result.image} index={index} selected={selectedResultIds.includes(result.image.id)} onSelectedChange={(checked) => setSelectedResultIds((ids) => checked ? [...new Set([...ids, result.image!.id])] : ids.filter((id) => id !== result.image!.id))} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "recoverable" ? (
                                        <FailedImageCard key={result.id} error={result.error || t("managed.imageTaskUnknown")} recovery onRetry={() => setTaskRevision((value) => value + 1)} />
                                    ) : result.status === "failed" ? (
                                        <FailedImageCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={() => retryResult(index)} />
                                    ) : (
                                        <PendingImageCard key={result.id} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <ImagePlus className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("imageWorkbench.empty")} />
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
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
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
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    selected,
    onSelectedChange,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    selected: boolean;
    onSelectedChange: (checked: boolean) => void;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    return (
        <div className={`overflow-hidden rounded-lg border bg-background ${selected ? "border-primary ring-1 ring-primary" : "border-stone-200 dark:border-stone-800"}`}>
            <div className="relative">
                <Image src={previewUrlFor(image.storageKey) || image.dataUrl} preview={{ src: image.dataUrl }} alt={t("imageWorkbench.resultAlt", { count: index + 1 })} className="aspect-square object-cover" />
                <Checkbox checked={selected} aria-label={t("resultToCanvas.selectResult", { count: index + 1 })} className="!absolute right-2 top-2 rounded bg-background/90 p-1.5" onChange={(event) => onSelectedChange(event.target.checked)} />
            </div>
            <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-2 gap-2">
                    <ResultToCanvasButton result={{ ...image, kind: "image", url: image.dataUrl, title: t("imageWorkbench.resultTitle", { count: index + 1 }) }} />
                    <Tooltip title={t("common.addToAssets")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                            {t("common.addToAssets")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("imageWorkbench.addReference")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                            {t("imageWorkbench.addReference")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("common.download")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                            {t("common.download")}
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard() {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-square overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry, recovery }: { error: string; onRetry: () => void; recovery?: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{t(recovery ? "managed.taskPending" : "workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger onClick={onRetry}>
                    {t(recovery ? "managed.resumeImage" : "workbench.retry")}
                </Button>
            </div>
        </div>
    );
}

function updateResultAt(results: GenerationResult[], index: number, next: Partial<GenerationResult>) {
    return results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
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
    const visibleLogs = useWorkbenchHistoryFilter("image", logs);
    const filter = useWorkbenchHistoryFilterStore((state) => state.image);
    const updateFilter = useWorkbenchHistoryFilterStore((state) => state.update);
    const allSelected = Boolean(visibleLogs.length) && visibleLogs.every((log) => selectedLogIds.includes(log.id));
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : visibleLogs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">{t("workbench.logs")}</h2>
                </div>
                <Tag className="m-0">{visibleLogs.length} / {logs.length}</Tag>
            </div>
            <div className="mb-3 space-y-2">
                <Input allowClear value={filter.query} aria-label={t("workbench.historySearch")} placeholder={t("workbench.historySearch")} onChange={(event) => updateFilter("image", { query: event.target.value })} />
                <div className="flex gap-2">
                    <Select className="min-w-0 flex-1" aria-label={t("workbench.historyStatus")} value={filter.status} onChange={(status) => updateFilter("image", { status })} options={[
                        { value: "all", label: t("workbench.historyAllStatuses") },
                        { value: "success", label: t("workbench.success") },
                        { value: "failed", label: t("workbench.failed") },
                    ]} />
                    <Button disabled={!filter.query && filter.status === "all"} onClick={() => updateFilter("image", { query: "", status: "all" })}>{t("workbench.historyClearFilters")}</Button>
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
    const cardRef = useRef<HTMLButtonElement>(null);
    const [thumbnails, setThumbnails] = useState<string[]>([]);
    useEffect(() => {
        let alive = true;
        const epoch = sessionEpoch();
        setThumbnails([]);
        const load = async () => {
            const urls = await Promise.all(log.images.slice(0, 4).map(async (image) => (await ensureImagePreview(image.storageKey)) || resolveImageUrl(image.storageKey, image.dataUrl)));
            if (alive && epoch === sessionEpoch()) setThumbnails(urls.filter(Boolean));
        };
        const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); void load().catch(() => {}); }
        }) : null;
        if (observer && cardRef.current) observer.observe(cardRef.current);
        else void load().catch(() => {});
        return () => { alive = false; observer?.disconnect(); };
    }, [log.images]);

    return (
        <button
            ref={cardRef}
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[minmax(128px,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((url, index) => (
                                    <img key={index} src={url} alt="" loading="lazy" className="size-8 shrink-0 rounded-md object-cover" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <div className="flex gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">
                            {t("workbench.successCount", { count: log.successCount ?? log.imageCount })}
                        </Tag>
                        {log.failCount ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">
                                {t("workbench.failCount", { count: log.failCount })}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{t("workbench.itemCount", { count: log.imageCount })}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                            {formatDuration(log.durationMs)}
                        </Tag>
                    </div>
                    <div className="flex justify-end">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.time}</Tag>
                    </div>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs() {
    const stored = await readTaskCenterDocument("image-workbench");
    const logs = stored && typeof stored === "object" && !Array.isArray(stored) ? Object.values(stored) as GenerationLog[] : [];
    return (await Promise.all(logs.map((log) => normalizeLog(log)))).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function normalizeLog(log: Partial<GenerationLog>, loadMedia = false): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => {
            return { ...item, dataUrl: !loadMedia && item.storageKey ? "" : await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => {
            return { ...item, dataUrl: !loadMedia && item.storageKey ? "" : await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "success",
        images,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
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

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
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
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
    };
}
