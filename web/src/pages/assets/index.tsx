import { currentSession, onSessionEnd, readPrivateBlob, sessionEpoch } from "@/services/api/canvas-client";
import { Copy, Download, PencilLine, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, App, Button, Card, Checkbox, Drawer, Empty, Form, Image, Input, Modal, Pagination, Progress, Select, Space, Tag, Typography } from "antd";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { useCopyText } from "@/hooks/use-copy-text";
import { ResultToCanvasButton } from "@/components/result-to-canvas-button";
import { AssetDeleteStatus } from "@/components/asset-delete-status";
import { canvasResultFromAsset } from "@/lib/canvas/result-to-canvas";
import { filterAssets } from "@/lib/asset-search";
import { findAssetReferences } from "@/lib/asset-references";
import { formatBytes, readFileAsDataUrl } from "@/lib/image-utils";
import { getMediaBlob } from "@/services/file-storage";
import { equalDocument, flushDocument, getDocumentBaseline, getDocumentSaveState, retryDocument } from "@/services/canvas-data";
import { getImageBlob, getImagePreviewRevision, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { cn } from "@/lib/utils";
import { assetCoverUrl, useAssetStore, type Asset, type AssetKind, type ImageAsset } from "@/stores/use-asset-store";
import { useAssetImportStore } from "@/stores/use-asset-import-store";
import { useAssetDeleteStore } from "@/stores/use-asset-delete-store";
import { useAssetLibraryViewStore } from "@/stores/use-asset-library-view-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { exportAssets } from "./asset-transfer";

type AssetFormValues = {
    kind: AssetKind;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    content?: string;
};

type ImageDraft = ImageAsset["data"] | null;

const kindOptions = ["all", "text", "image", "video"] as const;

export default function AssetsPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const [form] = Form.useForm<AssetFormValues>();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const assets = useAssetStore((state) => state.assets);
    const assetsHydrated = useAssetStore((state) => state.hydrated);
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const assetDelete = useAssetDeleteStore();
    const assetImport = useAssetImportStore();
    const importLocked = assetImport.status === "working" || assetImport.status === "saving" || assetImport.status === "save-error";
    const importStage = assetImport.status === "working" ? assetImport.progress?.phase || "reading" : assetImport.status === "save-error" ? "saveError" : assetImport.status === "error" ? "failed" : assetImport.status;
    const { keyword, kindFilter, page, pageSize, setView } = useAssetLibraryViewStore();
    const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
    const [formKind, setFormKind] = useState<AssetKind>("text");
    const [imageDraft, setImageDraft] = useState<ImageDraft>(null);
    const [savingAsset, setSavingAsset] = useState(false);
    const [assetSaveError, setAssetSaveError] = useState("");
    const [editorDirty, setEditorDirty] = useState(false);
    const [coverReading, setCoverReading] = useState(false);
    const [imageReading, setImageReading] = useState(false);
    const editorRevision = useRef(0);
    const mounted = useRef(true);
    const editorOpen = useRef(false);
    const editorSaving = useRef(false);
    const editorRecord = useRef<Asset | null>(null);
    const editorReceipt = useRef<{ id: string; payload: string } | null>(null);
    const coverRead = useRef(0);
    const imageRead = useRef(0);
    const hasEditorDraft = editorDirty || Boolean(assetSaveError);
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const title = Form.useWatch("title", form) || "";
    const tags = Form.useWatch("tags", form) || [];
    const content = Form.useWatch("content", form) || "";
    const validAssets = useMemo(() => assets.filter((asset) => asset.kind === "text" || asset.kind === "image" || asset.kind === "video"), [assets]);

    const filteredAssets = useMemo(() => filterAssets(validAssets, { keyword, kind: kindFilter }), [validAssets, keyword, kindFilter]);

    const visibleAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return filteredAssets.slice(start, start + pageSize);
    }, [filteredAssets, page, pageSize]);
    const selectedIds = useMemo(() => new Set(selectedAssetIds), [selectedAssetIds]);
    const selectedAssets = useMemo(() => filteredAssets.filter((asset) => selectedIds.has(asset.id)), [filteredAssets, selectedIds]);
    const allPageSelected = Boolean(visibleAssets.length) && visibleAssets.every((asset) => selectedIds.has(asset.id));
    const somePageSelected = visibleAssets.some((asset) => selectedIds.has(asset.id));

    useEffect(() => {
        if (!assetsHydrated) return;
        const maxPage = Math.max(1, Math.ceil(filteredAssets.length / pageSize));
        if (page > maxPage) setView({ page: maxPage });
    }, [assetsHydrated, filteredAssets.length, page, pageSize, setView]);

    useEffect(() => {
        const available = new Set(filteredAssets.map((asset) => asset.id));
        setSelectedAssetIds((ids) => ids.every((id) => available.has(id)) ? ids : ids.filter((id) => available.has(id)));
    }, [filteredAssets]);

    useEffect(() => {
        mounted.current = true;
        const unsubscribe = onSessionEnd(() => {
            editorRevision.current += 1;
            editorOpen.current = false;
            editorSaving.current = false;
            editorRecord.current = null;
            editorReceipt.current = null;
            setIsAssetOpen(false);
            setSavingAsset(false);
            setCoverReading(false);
            setImageReading(false);
            setEditorDirty(false);
            setAssetSaveError("");
            setDeletingAsset(null);
            setPreviewAsset(null);
            setImageDraft(null);
            form.resetFields();
        });
        return () => {
            unsubscribe();
            mounted.current = false;
            editorRevision.current += 1;
            editorOpen.current = false;
        };
    }, [form]);

    const resumeEditor = () => {
        editorOpen.current = true;
        setIsAssetOpen(true);
    };

    const closeEditor = () => {
        if (editorSaving.current) return;
        editorRevision.current += 1;
        editorOpen.current = false;
        setCoverReading(false);
        setImageReading(false);
        setIsAssetOpen(false);
    };

    const discardEditor = () => {
        if (editorSaving.current) return;
        closeEditor();
        editorReceipt.current = null;
        editorRecord.current = null;
        setEditorDirty(false);
        setAssetSaveError("");
        setEditingAsset(null);
        setImageDraft(null);
        form.resetFields();
    };

    const openCreate = () => {
        if (hasEditorDraft) {
            resumeEditor();
            message.info(t("assets.formOtherDraft"));
            return;
        }
        editorRevision.current += 1;
        editorRecord.current = null;
        editorReceipt.current = null;
        setAssetSaveError("");
        setEditingAsset(null);
        setImageDraft(null);
        setFormKind("text");
        form.setFieldsValue({ kind: "text", title: "", coverUrl: "", tags: [], source: t("assets.manual"), note: "", content: "" });
        resumeEditor();
    };

    const openEdit = (asset: Asset) => {
        if (hasEditorDraft) {
            resumeEditor();
            message.info(t("assets.formOtherDraft"));
            return;
        }
        editorRevision.current += 1;
        editorRecord.current = asset;
        editorReceipt.current = null;
        setAssetSaveError("");
        setEditingAsset(asset);
        setFormKind(asset.kind);
        setImageDraft(asset.kind === "image" ? asset.data : null);
        form.setFieldsValue({
            kind: asset.kind,
            title: asset.title,
            coverUrl: asset.coverUrl,
            tags: asset.tags || [],
            source: asset.source,
            note: asset.note,
            content: asset.kind === "text" ? asset.data.content : "",
        });
        resumeEditor();
    };

    const saveAsset = async () => {
        if (editorSaving.current || !editorOpen.current || coverReading || imageReading) return;
        editorSaving.current = true;
        setSavingAsset(true);
        const revision = editorRevision.current;
        const epoch = sessionEpoch();
        try {
            const values = await form.validateFields();
            if (revision !== editorRevision.current || epoch !== sessionEpoch() || !editorOpen.current) return;
            if (!currentSession()) throw new Error(t("saveRecovery.authorizationRequired"));
            const targetId = editorReceipt.current?.id || editingAsset?.id;
            const live = targetId ? useAssetStore.getState().assets.find((asset) => asset.id === targetId) : null;
            if (targetId && !live) throw new Error(t("assets.formTargetMissing"));
            if (live && !equalDocument(JSON.parse(JSON.stringify(live)), JSON.parse(JSON.stringify(editorRecord.current)))) throw new Error(t("assets.formTargetChanged"));
            if (values.kind !== "text" && !imageDraft) throw new Error(t("assets.selectImage"));
            const base = {
                title: values.title.trim(),
                coverUrl: values.coverUrl?.trim() || (values.kind === "image" && imageDraft ? imageDraft.dataUrl : ""),
                tags: values.tags || [],
                source: values.source?.trim(),
                note: values.note?.trim(),
                metadata: editorRecord.current?.metadata || { source: "manual" },
            };
            const payload = values.kind === "text" ? { ...base, kind: "text" as const, data: { content: (values.content || "").trim() } } : { ...base, kind: "image" as const, data: imageDraft! };
            const payloadKey = JSON.stringify(payload);
            let id = targetId;
            if (!id) id = addAsset(payload);
            else if (editorReceipt.current?.payload !== payloadKey) updateAsset(id, payload);
            editorReceipt.current = { id, payload: payloadKey };
            editorRecord.current = useAssetStore.getState().assets.find((asset) => asset.id === id)!;
            const submitted = JSON.parse(JSON.stringify(editorRecord.current)) as Asset;
            setEditorDirty(true);
            setAssetSaveError("");
            if (["error", "conflict"].includes(getDocumentSaveState("assets").status)) await retryDocument("assets");
            if (epoch !== sessionEpoch()) return;
            await flushDocument("assets");
            if (revision !== editorRevision.current || epoch !== sessionEpoch() || !editorOpen.current) return;
            const current = useAssetStore.getState().assets.find((asset) => asset.id === id);
            if (!current) throw new Error(t("assets.formTargetMissing"));
            if (!equalDocument(JSON.parse(JSON.stringify(current)), submitted)) throw new Error(t("assets.formTargetChanged"));
            const baseline = getDocumentBaseline("assets") as { state?: { assets?: Asset[] } } | undefined;
            const confirmed = baseline?.state?.assets?.find((asset) => asset.id === id);
            if (!equalDocument(confirmed, submitted)) throw new Error(t("assets.formSaveUnconfirmed"));
            message.success(editingAsset ? t("assets.updated") : t("assets.saved"));
            editorReceipt.current = null;
            editorRecord.current = null;
            editorOpen.current = false;
            setEditorDirty(false);
            setIsAssetOpen(false);
        } catch (error) {
            if (revision !== editorRevision.current || epoch !== sessionEpoch() || !editorOpen.current) return;
            if (error && typeof error === "object" && "errorFields" in error) return;
            setAssetSaveError(error instanceof Error ? error.message : t("assets.formSaveUnconfirmed"));
        } finally {
            if (revision === editorRevision.current && epoch === sessionEpoch()) {
                editorSaving.current = false;
                setSavingAsset(false);
            }
        }
    };

    const readCoverFile = async (file?: File) => {
        if (!file || !editorOpen.current || editorSaving.current) return;
        const revision = editorRevision.current, epoch = sessionEpoch(), request = ++coverRead.current;
        const previous = form.getFieldValue("coverUrl");
        setCoverReading(true);
        try {
            const dataUrl = await readFileAsDataUrl(file);
            if (revision !== editorRevision.current || epoch !== sessionEpoch() || request !== coverRead.current || !editorOpen.current) return;
            if (form.getFieldValue("coverUrl") === previous) {
                form.setFieldValue("coverUrl", dataUrl);
                setEditorDirty(true);
            }
        } catch (error) {
            if (revision === editorRevision.current && epoch === sessionEpoch() && request === coverRead.current && editorOpen.current) message.error(error instanceof Error ? error.message : t("common.imageReadFailed"));
        } finally {
            if (revision === editorRevision.current && epoch === sessionEpoch() && request === coverRead.current) setCoverReading(false);
        }
    };

    const readImageFile = async (file?: File) => {
        if (!file || !file.type.startsWith("image/") || !editorOpen.current || editorSaving.current) return;
        const revision = editorRevision.current, epoch = sessionEpoch(), request = ++imageRead.current;
        setImageReading(true);
        try {
            const image = await uploadImage(file);
            if (revision !== editorRevision.current || epoch !== sessionEpoch() || request !== imageRead.current || !editorOpen.current || form.getFieldValue("kind") !== "image") return;
            const draft = { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
            setImageDraft(draft);
            setEditorDirty(true);
            if (!form.getFieldValue("coverUrl")) form.setFieldValue("coverUrl", draft.dataUrl);
            if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
        } catch (error) {
            if (revision === editorRevision.current && epoch === sessionEpoch() && request === imageRead.current && editorOpen.current) message.error(error instanceof Error ? error.message : t("common.imageReadFailed"));
        } finally {
            if (revision === editorRevision.current && epoch === sessionEpoch() && request === imageRead.current) setImageReading(false);
        }
    };

    const copyAssetText = async (asset: Asset) => {
        if (asset.kind !== "text") return;
        copyText(asset.data.content, t("assets.textCopied"));
    };

    const downloadImage = async (asset: Asset) => {
        if (asset.kind !== "image" && asset.kind !== "video") return;
        try {
            const blob = await readAssetMediaBlob(asset);
            if (!blob) {
                message.error(t("assets.downloadFailed"));
                return;
            }
            const ext = asset.data.mimeType?.split("/")[1]?.split("+")[0] || (asset.kind === "video" ? "mp4" : "png");
            saveAs(blob, `${asset.title || "asset"}.${ext}`);
        } catch {
            message.error(t("assets.downloadFailed"));
        }
    };

    const exportAllAssets = async () => {
        if (!validAssets.length) {
            message.warning(t("assets.noneToExport"));
            return;
        }
        await exportAssets(validAssets, t("assets.packageName"));
    };

    const confirmDelete = async () => {
        if (!deletingAsset || ["saving", "save-error"].includes(useAssetDeleteStore.getState().status)) return;
        const id = deletingAsset.id, epoch = sessionEpoch();
        const deleting = assetDelete.deleteAsset(id);
        if (!useAssetStore.getState().assets.some((asset) => asset.id === id)) setDeletingAsset((current) => current?.id === id ? null : current);
        await deleting;
        if (epoch !== sessionEpoch() || !mounted.current) return;
        const result = useAssetDeleteStore.getState();
        if (result.deleted?.asset.id !== id) return;
        if (result.status === "saved" && result.operation === "delete") message.success(t("assets.deleted"));
        if (!useAssetStore.getState().assets.some((asset) => asset.id === id)) setDeletingAsset((current) => current?.id === id ? null : current);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="pb-8">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="text-4xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("assets.title")}</h1>
                        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{t("assets.description")}</p>
                        <p className="mt-2 text-sm text-muted-foreground">{t("browserStorage.localDataHint")}</p>
                    </div>

                    <div className="mx-auto mt-8 w-full max-w-2xl">
                        <Input.Search
                            className="w-full"
                            size="large"
                            allowClear
                            prefix={<Search className="size-4 text-stone-400" />}
                            value={keyword}
                            placeholder={t("assets.search")}
                            onChange={(event) => {
                                if (keyword !== event.target.value) setSelectedAssetIds([]);
                                setView({ keyword: event.target.value, page: 1 });
                            }}
                            onSearch={(value) => {
                                if (keyword !== value) setSelectedAssetIds([]);
                                setView({ keyword: value, page: 1 });
                            }}
                        />
                    </div>

                    <div className="mx-auto mt-6 grid max-w-6xl gap-3 text-left">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                                <div className="text-xs font-medium text-stone-500 dark:text-stone-400">{t("assets.type")}</div>
                                <div className="flex flex-wrap gap-2">
                                    {kindOptions.map((option) => (
                                        <Tag.CheckableTag
                                            key={option}
                                            checked={kindFilter === option}
                                            className={cn("prompt-filter-tag", kindFilter === option && "is-active")}
                                            onChange={() => {
                                                if (kindFilter !== option) setSelectedAssetIds([]);
                                                setView({ kindFilter: option, page: 1 });
                                            }}
                                        >
                                            {option === "all" ? t("common.all") : t(`assets.kinds.${option}`)}
                                        </Tag.CheckableTag>
                                    ))}
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-4">
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => void exportAllAssets()}
                                >
                                    {t("assets.export")}
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-stone-300"
                                    disabled={importLocked}
                                    onClick={() => assetInputRef.current?.click()}
                                >
                                    {t("assets.import")}
                                </button>
                                <button type="button" className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300" onClick={openCreate}>
                                    {t("assets.add")}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="mx-auto flex max-w-7xl flex-col gap-5">
                    {!isAssetOpen && hasEditorDraft ? (
                        <Alert type="warning" showIcon title={t("assets.formDraftTitle")} description={<div className="space-y-2"><p>{t("assets.formDraftHint")}</p><Space wrap><Button onClick={resumeEditor}>{t("assets.resumeEdit")}</Button><Button onClick={discardEditor}>{t("assets.discardForm")}</Button></Space></div>} />
                    ) : null}
                    {assetImport.status !== "idle" ? (
                        <Alert
                            showIcon
                            type={assetImport.status === "saved" ? "success" : assetImport.status === "error" || assetImport.status === "save-error" ? "error" : "info"}
                            title={<span className="break-words">{t(`assetImport.${importStage}`)} · {assetImport.fileName}</span>}
                            description={(
                                <div className="space-y-2" role="status">
                                    {assetImport.status === "working" && assetImport.progress ? (
                                        <>
                                            {assetImport.progress.total > 0 ? (
                                                <div>
                                                    <div>{t("assetImport.progress", { completed: assetImport.progress.completed, total: assetImport.progress.total })}</div>
                                                    <Progress percent={Math.round(assetImport.progress.completed / assetImport.progress.total * 100)} showInfo={false} size="small" aria-label={t(`assetImport.${assetImport.progress.phase}`)} />
                                                </div>
                                            ) : null}
                                            {assetImport.progress.item ? <div className="break-words">{assetImport.progress.item}</div> : null}
                                        </>
                                    ) : null}
                                    {assetImport.status === "saving" ? <p>{t("assetImport.savingHint", { count: assetImport.assetIds.length })}</p> : null}
                                    {assetImport.status === "saved" ? <p>{t("assets.imported", { count: assetImport.assetIds.length })}</p> : null}
                                    {assetImport.error ? <p className="whitespace-pre-wrap break-words">{assetImport.error}</p> : null}
                                    {assetImport.status === "save-error" ? (
                                        <>
                                            <p>{t("assetImport.saveErrorHint")}</p>
                                            <Button onClick={() => void assetImport.retrySave()}>{t("assetImport.retrySave")}</Button>
                                        </>
                                    ) : null}
                                </div>
                            )}
                        />
                    ) : null}
                    <AssetDeleteStatus />
                    <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                        <Checkbox checked={allPageSelected} indeterminate={somePageSelected && !allPageSelected} disabled={!visibleAssets.length} onChange={(event) => {
                            const pageIds = new Set(visibleAssets.map((asset) => asset.id));
                            const checked = event.target.checked;
                            setSelectedAssetIds((ids) => checked ? [...new Set([...ids, ...pageIds])] : ids.filter((id) => !pageIds.has(id)));
                        }}>{t("assets.selectPage")}</Checkbox>
                        <Button type="text" size="small" disabled={!visibleAssets.length} onClick={() => {
                            const pageIds = new Set(visibleAssets.map((asset) => asset.id));
                            setSelectedAssetIds((ids) => [...ids.filter((id) => !pageIds.has(id)), ...visibleAssets.filter((asset) => !ids.includes(asset.id)).map((asset) => asset.id)]);
                        }}>{t("assets.invertPage")}</Button>
                        <Button type="text" size="small" disabled={!selectedAssets.length} onClick={() => setSelectedAssetIds([])}>{t("resultToCanvas.clearSelection")}</Button>
                        <div className="min-w-0 flex-1 text-xs leading-6 text-muted-foreground">
                            <span role="status">{t("assets.selectedCount", { count: selectedAssets.length })}</span>
                            <p>{t("assets.selectionHint")}</p>
                        </div>
                        <div className="w-full sm:w-auto sm:min-w-56">
                            <ResultToCanvasButton results={selectedAssets.map(canvasResultFromAsset)} />
                        </div>
                    </div>
                    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {visibleAssets.map((asset) => (
                            <AssetCard key={asset.id} asset={asset} selected={selectedIds.has(asset.id)} deleteDisabled={assetDelete.status === "saving" || assetDelete.status === "save-error"} onSelectedChange={(checked) => setSelectedAssetIds((ids) => checked ? [...new Set([...ids, asset.id])] : ids.filter((id) => id !== asset.id))} onOpen={() => setPreviewAsset(asset)} onEdit={() => openEdit(asset)} onCopy={copyAssetText} onDownload={downloadImage} onDelete={() => setDeletingAsset(asset)} />
                        ))}
                    </div>

                    {!visibleAssets.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("assets.empty")} className="py-20" /> : null}

                    <div className="flex justify-center">
                        <Pagination
                            current={page}
                            pageSize={pageSize}
                            total={filteredAssets.length}
                            showSizeChanger
                            pageSizeOptions={[10, 20, 50, 100]}
                            onChange={(nextPage, nextPageSize) => {
                                setView({ page: nextPage, pageSize: nextPageSize });
                            }}
                        />
                    </div>
                </div>
            </main>

            <Modal title={editingAsset ? t("assets.edit") : t("assets.add")} open={isAssetOpen} width={980} onCancel={closeEditor} onOk={() => void saveAsset()} confirmLoading={savingAsset} okButtonProps={{ disabled: coverReading || imageReading }} cancelButtonProps={{ disabled: savingAsset }} closable={!savingAsset} mask={{ closable: !savingAsset }} keyboard={!savingAsset} okText={t("common.save")} cancelText={t("common.cancel")} destroyOnHidden>
                {assetSaveError ? <Alert className="mb-4" type="error" showIcon title={t("assets.formSaveFailed")} description={<div className="space-y-2"><p className="whitespace-pre-wrap break-words">{assetSaveError}</p><p>{t("assets.formSaveHint")}</p><p>{t("assets.formDraftHint")}</p><Button disabled={savingAsset} onClick={discardEditor}>{t("assets.discardForm")}</Button></div>} /> : null}
                <div className="grid gap-6 pt-1 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <Form form={form} layout="vertical" requiredMark={false} disabled={savingAsset} onValuesChange={() => setEditorDirty(true)} initialValues={{ kind: "text", tags: [] }}>
                        <Form.Item name="kind" label={t("assets.type")}>
                            <Select
                                options={[
                                    { label: t("assets.kinds.text"), value: "text" },
                                    { label: t("assets.kinds.image"), value: "image" },
                                ]}
                                onChange={(value) => {
                                    imageRead.current += 1;
                                    setImageReading(false);
                                    setFormKind(value);
                                }}
                            />
                        </Form.Item>
                        <Form.Item name="title" label={t("assets.fields.title")} rules={[{ required: true, whitespace: true, message: t("assets.fields.titleRequired") }]}>
                            <Input size="large" placeholder={t("assets.fields.titlePlaceholder")} />
                        </Form.Item>
                        <Form.Item label={t("assets.fields.coverUrl")}>
                            <Space.Compact className="w-full">
                                <Form.Item name="coverUrl" noStyle><Input placeholder={t("assets.fields.coverPlaceholder")} /></Form.Item>
                                <Button loading={coverReading} icon={<Upload className="size-3.5" />} onClick={() => coverInputRef.current?.click()}>
                                    {t("common.upload")}
                                </Button>
                            </Space.Compact>
                        </Form.Item>
                        <Form.Item name="tags" label={t("assets.fields.tags")}>
                            <Select mode="tags" tokenSeparators={[",", "，"]} placeholder={t("assets.fields.tagsPlaceholder")} />
                        </Form.Item>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="source" label={t("assets.fields.source")}>
                                <Input placeholder={t("assets.fields.sourcePlaceholder")} />
                            </Form.Item>
                            <Form.Item name="note" label={t("assets.fields.note")}>
                                <Input placeholder={t("assets.fields.optional")} />
                            </Form.Item>
                        </div>
                        {formKind === "text" ? (
                            <Form.Item name="content" label={t("assets.fields.textContent")} rules={[{ required: true, whitespace: true, message: t("assets.fields.textRequired") }]}>
                                <Input.TextArea rows={8} placeholder={t("assets.fields.textPlaceholder")} />
                            </Form.Item>
                        ) : (
                            <Form.Item label={t("assets.fields.imageContent")} required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button loading={imageReading} icon={<Upload className="size-4" />} onClick={() => imageInputRef.current?.click()}>
                                        {t("assets.selectImageFile")}
                                    </Button>
                                    {imageDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {imageDraft.width}x{imageDraft.height} · {formatBytes(imageDraft.bytes)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {t("assets.noImageSelected")}
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        )}
                    </Form>
                    <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-950">
                        <Typography.Text strong>{t("assets.preview")}</Typography.Text>
                        <div className="mt-3 overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                            {coverUrl || imageDraft?.dataUrl ? (
                                <img src={coverUrl || imageDraft?.dataUrl} alt="" className="aspect-[4/3] w-full object-cover" />
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm text-stone-500 dark:bg-stone-900">{content || t("assets.noCover")}</div>
                            )}
                            <div className="p-4">
                                <Typography.Text strong ellipsis className="block">
                                    {title || t("assets.untitled")}
                                </Typography.Text>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {tags.length ? (
                                        tags.map((tag) => (
                                            <Tag key={tag} className="m-0">
                                                {tag}
                                            </Tag>
                                        ))
                                    ) : (
                                        <Tag className="m-0">{t("assets.untagged")}</Tag>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={savingAsset}
                    onChange={(event) => {
                        void readCoverFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={savingAsset}
                    onChange={(event) => {
                        void readImageFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
            </Modal>

            <AssetDrawer asset={previewAsset} onClose={() => setPreviewAsset(null)} onCopy={copyAssetText} onDownload={downloadImage} />

            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" disabled={importLocked} onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void assetImport.startImport(file);
            }} />

            <Modal title={t("assets.deleteTitle")} open={Boolean(deletingAsset)} onCancel={() => setDeletingAsset(null)} onOk={() => void confirmDelete()} confirmLoading={assetDelete.status === "saving"} okText={t("common.delete")} okButtonProps={{ danger: true, disabled: assetDelete.status === "save-error" }} cancelText={t("common.cancel")}>
                {t("assets.deleteConfirm", { name: deletingAsset?.title })}
                {assetDelete.status === "error" && assetDelete.error ? <Alert className="mt-3" type="error" title={assetDelete.error} /> : null}
            </Modal>
        </div>
    );
}

function AssetCard({ asset, selected, deleteDisabled, onSelectedChange, onOpen, onEdit, onCopy, onDownload, onDelete }: { asset: Asset; selected: boolean; deleteDisabled: boolean; onSelectedChange: (checked: boolean) => void; onOpen: () => void; onEdit: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void; onDelete: () => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const cover = assetCoverUrl(asset);
    const summary = assetSummary(asset);
    return (
        <Card
            hoverable
            className={cn("overflow-hidden", selected && "ring-1 ring-primary")}
            styles={{ body: { padding: 0 } }}
            cover={
                <div className="relative">
                    <button type="button" className="block w-full text-left" onClick={onOpen}>
                    {cover ? (
                        <img src={cover} alt={asset.title} className="aspect-[4/3] w-full object-cover" />
                    ) : (
                        <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm leading-6 text-stone-600 dark:bg-stone-900 dark:text-stone-300">
                            {asset.kind === "text" ? asset.data.content : t("assets.noCover")}
                        </div>
                    )}
                    </button>
                    <Checkbox checked={selected} aria-label={t("assets.selectAsset", { title: asset.title })} className="!absolute right-2 top-2 rounded bg-background/90 p-1.5" onChange={(event) => onSelectedChange(event.target.checked)} />
                </div>
            }
        >
            <button type="button" className="block w-full text-left" onClick={onOpen}>
                <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{asset.title}</h2>
                            <Typography.Text type="secondary" className="mt-1 block text-xs">
                                {asset.source || t("assets.unknownSource")}
                            </Typography.Text>
                        </div>
                        <Tag className="m-0 shrink-0 text-[11px]">{t(`assets.kinds.${asset.kind}`)}</Tag>
                    </div>
                    <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} className="!mb-0 !mt-2 !text-xs !leading-5">
                        {summary}
                    </Typography.Paragraph>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {(asset.tags || []).slice(0, 3).map((tag) => (
                            <Tag key={tag} className="m-0 text-[11px]">
                                {tag}
                            </Tag>
                        ))}
                        {!asset.tags?.length ? <Tag className="m-0 text-[11px]">{t("assets.noTags")}</Tag> : null}
                    </div>
                </div>
            </button>
            <div className="flex items-center gap-2 px-4 pb-4">
                <Button size="small" onClick={onOpen}>
                    {t("common.view")}
                </Button>
                {asset.kind !== "video" ? (
                    <Button size="small" icon={<PencilLine className="size-3.5" />} onClick={onEdit}>
                        {t("common.edit")}
                    </Button>
                ) : null}
                {asset.kind === "text" ? (
                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void onCopy(asset)}>
                        {t("common.copy")}
                    </Button>
                ) : null}
                {asset.kind === "image" || asset.kind === "video" ? (
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(asset)}>
                        {t("common.download")}
                    </Button>
                ) : null}
                <Button size="small" danger disabled={deleteDisabled} icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                    {t("common.delete")}
                </Button>
            </div>
        </Card>
    );
}

function AssetDrawer({ asset, onClose, onCopy, onDownload }: { asset: Asset | null; onClose: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void }) {
    const { t } = useTranslation();
    const projects = useCanvasStore((state) => state.projects);
    const projectsHydrated = useCanvasStore((state) => state.hydrated);
    const storageKey = asset && asset.kind !== "text" ? asset.data.storageKey : undefined;
    const references = useMemo(() => storageKey ? findAssetReferences(projects, storageKey) : [], [projects, storageKey]);
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const cover = asset ? asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "") : "";
    return (
        <Drawer title={t("assets.details")} open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-5">
                    {cover ? (
                        <Image src={assetCoverUrl(asset)} preview={{ src: cover }} alt={asset.title} className="rounded-lg" />
                    ) : (
                        <div className="rounded-lg border border-stone-200 bg-stone-50 p-5 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
                            {asset.kind === "text" ? asset.data.content : t("assets.noCover")}
                        </div>
                    )}
                    <div>
                        <Typography.Title level={4} className="!mb-2">
                            {asset.title}
                        </Typography.Title>
                        <Space size={[4, 4]} wrap>
                            <Tag>{t(`assets.kinds.${asset.kind}`)}</Tag>
                            {(asset.tags || []).map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                            ))}
                        </Space>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                        <Typography.Text type="secondary" className="block text-xs">
                            {t("assets.fields.textContent")}
                        </Typography.Text>
                        {asset.kind === "text" ? (
                            <Typography.Paragraph className="mt-2 whitespace-pre-wrap">{asset.data.content}</Typography.Paragraph>
                        ) : asset.kind === "video" ? (
                            <video src={asset.data.url} controls className="mt-2 aspect-video w-full rounded-lg bg-black" />
                        ) : (
                            <Typography.Text className="mt-2 block">
                                {asset.data.width}x{asset.data.height} · {formatBytes(asset.data.bytes)} · {asset.data.mimeType}
                            </Typography.Text>
                        )}
                    </div>
                    {asset.note ? (
                        <div>
                            <Typography.Text type="secondary">{t("assets.fields.note")}</Typography.Text>
                            <Typography.Paragraph className="mt-1">{asset.note}</Typography.Paragraph>
                        </div>
                    ) : null}
                    <div className="space-y-2">
                        <Typography.Text strong>{t("assets.referencesTitle")}</Typography.Text>
                        {!storageKey ? <p className="text-sm text-muted-foreground">{t("assets.referencesUnavailable")}</p> : !projectsHydrated ? <p className="text-sm text-muted-foreground">{t("canvas.loading")}</p> : references.length ? (
                            <ul className="space-y-2">
                                {references.map((reference) => <li key={`${reference.projectId}:${reference.nodeId}`}><Link to={`/canvas/${encodeURIComponent(reference.projectId)}?focusNode=${encodeURIComponent(reference.nodeId)}`} onClick={onClose} className="text-sm text-primary hover:underline">{reference.projectTitle} · {reference.nodeTitle}</Link></li>)}
                            </ul>
                        ) : <p className="text-sm text-muted-foreground">{t("assets.referencesEmpty")}</p>}
                    </div>
                    <Space>
                        {asset.kind === "text" ? (
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(asset)}>
                                {t("assets.copyText")}
                            </Button>
                        ) : null}
                        {asset.kind === "image" || asset.kind === "video" ? (
                            <Button type="primary" icon={<Download className="size-4" />} onClick={() => onDownload(asset)}>
                                {asset.kind === "video" ? t("assets.downloadVideo") : t("assets.downloadImage")}
                            </Button>
                        ) : null}
                    </Space>
                </div>
            ) : null}
        </Drawer>
    );
}

async function readAssetMediaBlob(asset: Extract<Asset, { kind: "image" | "video" }>) {
    const storageKey = asset.data.storageKey;
    if (storageKey) {
        const stored = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        if (stored) return stored;
    }
    const url = asset.kind === "video" ? asset.data.url : asset.data.dataUrl || asset.coverUrl;
    if (!url) return null;
    return readPrivateBlob(url);
}

function assetSummary(asset: Asset) {
    if (asset.kind === "text") return asset.data.content;
    return `${asset.data.width}x${asset.data.height} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
}
