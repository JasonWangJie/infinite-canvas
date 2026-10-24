import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Tag } from "antd";
import { useTranslation } from "react-i18next";
import { sessionEpoch } from "@/services/api/canvas-client";
import { getDocumentDraft, subscribeDocumentSaves } from "@/services/canvas-data";
import { imageTaskHasResult, imageTaskImages, imageTaskPending, readImageTasks, refreshImageTask, type ImageTaskRecord } from "@/services/api/image-tasks";

export function ImageTaskPanel({ revision, onOpen, generating = false, activeRecordIds = [], selectedTaskId }: { revision: number; onOpen: (images: Awaited<ReturnType<typeof imageTaskImages>>, recordId: string) => Promise<void>; generating?: boolean; activeRecordIds?: string[]; selectedTaskId?: string | null }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const selectedCard = useRef<HTMLDivElement>(null);
    const [records, setRecords] = useState<ImageTaskRecord[]>([]);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [showCompleted, setShowCompleted] = useState(false);
    const mounted = useRef(false);
    const latestLoad = useRef(0);
    const active = useRef(new Set<string>());
    const timers = useRef(new Map<string, number>());
    const versions = useRef(new Map<string, number>());

    const refresh = useCallback(async () => {
        const epoch = sessionEpoch();
        const load = ++latestLoad.current;
        const snapshot = new Map(versions.current);
        setLoading(true);
        try {
            const next = await readImageTasks();
            if (mounted.current && epoch === sessionEpoch() && latestLoad.current === load) {
                setRecords((current) => next.map((record) => (versions.current.get(record.id) !== snapshot.get(record.id) ? current.find((item) => item.id === record.id) || record : record)));
                setErrors((value) => {
                    const next = { ...value };
                    delete next.list;
                    return next;
                });
            }
        } catch (error) {
            if (mounted.current && epoch === sessionEpoch() && latestLoad.current === load) setErrors((value) => ({ ...value, list: error instanceof Error ? error.message : String(error) }));
        } finally {
            if (mounted.current && epoch === sessionEpoch() && latestLoad.current === load) setLoading(false);
        }
    }, []);

    const query = useCallback(async (record: ImageTaskRecord) => {
        const epoch = sessionEpoch();
        if (active.current.has(record.id)) return;
        active.current.add(record.id);
        setBusy([...active.current]);
        try {
            const next = await refreshImageTask(record);
            if (!mounted.current || epoch !== sessionEpoch()) return;
            versions.current.set(record.id, (versions.current.get(record.id) || 0) + 1);
            setRecords((value) => value.map((item) => (item.id === next.id ? next : item)));
            setErrors((value) => {
                const next = { ...value };
                delete next[record.id];
                return next;
            });
        } catch (error) {
            if (mounted.current && epoch === sessionEpoch()) setErrors((value) => ({ ...value, [record.id]: error instanceof Error ? error.message : String(error) }));
        } finally {
            active.current.delete(record.id);
            if (mounted.current && epoch === sessionEpoch()) setBusy([...active.current]);
        }
    }, []);

    useEffect(() => {
        mounted.current = true;
        void refresh();
        return () => {
            mounted.current = false;
            latestLoad.current += 1;
        };
    }, [revision, selectedTaskId, refresh]);

    useEffect(() => {
        const epoch = sessionEpoch();
        let previous = getDocumentDraft("image-tasks");
        return subscribeDocumentSaves(() => {
            if (epoch !== sessionEpoch()) {
                latestLoad.current += 1;
                setRecords([]);
                setErrors({});
                setLoading(false);
                return;
            }
            const next = getDocumentDraft("image-tasks");
            if (next === previous) return;
            previous = next;
            // Local batch writes reveal completed images without another model query.
            void refresh();
        });
    }, [refresh]);

    useEffect(() => {
        if (selectedTaskId && records.some((record) => record.id === selectedTaskId)) selectedCard.current?.scrollIntoView?.({ block: "nearest" });
    }, [selectedTaskId, records]);

    useEffect(() => {
        const pending = new Set<string>();
        for (const record of records) {
            if (!imageTaskPending(record) || errors[record.id] || busy.includes(record.id)) continue;
            // The gateway owns polling cadence. Without its hint, expose manual refresh only.
            const seconds = record.value.retryAfter;
            if (!seconds || !Number.isFinite(seconds) || seconds <= 0) continue;
            pending.add(record.id);
            if (!timers.current.has(record.id))
                timers.current.set(
                    record.id,
                    window.setTimeout(() => {
                        timers.current.delete(record.id);
                        void query(record);
                    }, seconds * 1000),
                );
        }
        for (const [id, timer] of timers.current)
            if (!pending.has(id)) {
                window.clearTimeout(timer);
                timers.current.delete(id);
            }
    }, [records, errors, busy, query]);
    useEffect(
        () => () => {
            for (const timer of timers.current.values()) window.clearTimeout(timer);
            timers.current.clear();
        },
        [],
    );

    const open = async (record: ImageTaskRecord) => {
        if (generating || active.current.has(record.id)) return;
        const epoch = sessionEpoch();
        active.current.add(record.id);
        setBusy([...active.current]);
        try {
            const images = await imageTaskImages(record);
            if (mounted.current && epoch === sessionEpoch()) await onOpen(images, record.id);
        } catch (error) {
            if (mounted.current && epoch === sessionEpoch()) message.error(error instanceof Error ? error.message : String(error));
        } finally {
            active.current.delete(record.id);
            if (mounted.current && epoch === sessionEpoch()) setBusy([...active.current]);
        }
    };

    const completed = (record: ImageTaskRecord) => imageTaskHasResult(record) && !["storage_failed", "storage_pending"].includes(record.status) && (!record.value.batch || (record.value.batch.completed >= record.value.batch.total && !record.value.batch.failed && !record.value.batch.unknown));
    const completedCount = records.filter(completed).length;
    const visible = records.filter((record) => showCompleted || !completed(record) || record.id === selectedTaskId || Boolean(errors[record.id]));
    if (!records.length && !loading && !errors.list && !selectedTaskId) return null;
    return (
        <div className="mb-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{t("managed.imageTasks")}</h3>
                <Button type="text" size="small" loading={loading} onClick={() => void refresh()}>
                    {t("managed.refreshTasks")}
                </Button>
            </div>
            {visible.length ? <p className="text-xs text-muted-foreground">{t("managed.imageTasksHint")}</p> : null}
            {completedCount ? <Button type="text" size="small" aria-expanded={showCompleted} onClick={() => setShowCompleted((value) => !value)}>{t(showCompleted ? "managed.hideCompletedTasks" : "managed.showCompletedTasks", { count: completedCount, defaultValue: showCompleted ? "收起已完成任务" : "查看已完成任务（{{count}}）" })}</Button> : null}
            {selectedTaskId && !loading && !errors.list && !records.some((record) => record.id === selectedTaskId) ? <p role="status" className="text-sm text-muted-foreground">{t("workbench.historySourceMissing")}</p> : null}
            {errors.list ? (
                <p role="alert" className="text-sm text-destructive">
                    {errors.list}
                </p>
            ) : null}
            <div className="max-h-64 space-y-2 overflow-y-auto">
                {visible.map((record) => {
                    const ready = imageTaskHasResult(record);
                    const batch = record.value.batch;
                    const partial = Boolean(batch && (batch.failed || batch.unknown));
                    const running = generating && activeRecordIds.includes(record.id);
                    const storagePending = ["storage_failed", "storage_pending"].includes(record.status);
                    const recoverable = !batch && (storagePending || imageTaskPending(record));
                    const incomplete = Boolean(batch && batch.completed < batch.total);
                    const unknown = !ready && !record.task_id && !storagePending && !running && !["failed", "cancelled", "canceled", "expired"].includes(record.status);
                    const status = storagePending ? "taskStorageFailed" : running ? "taskRunning" : incomplete || unknown ? "taskAttention" : ready ? partial ? "taskPartial" : "taskReady" : ["failed", "cancelled", "canceled", "expired"].includes(record.status) ? "taskFailed" : "taskPending";
                    return (
                        <div key={record.id} ref={record.id === selectedTaskId ? selectedCard : undefined} aria-current={record.id === selectedTaskId ? "true" : undefined} className={`flex items-start justify-between gap-3 border-b border-border py-2 ${record.id === selectedTaskId ? "border-l-2 border-l-primary pl-2" : ""}`}>
                            <div className="min-w-0">
                                <div className="truncate text-sm" title={record.task_id || record.id}>
                                    {record.value.model || t("workbench.model")}
                                    {record.created_at ? ` · ${new Date(record.created_at * 1000).toLocaleString()}` : ""}
                                </div>
                                <Tag color={storagePending || incomplete || unknown || (ready && partial && !running) ? "warning" : running ? "processing" : undefined}>{t(`managed.${status}`, { defaultValue: "需处理" })}</Tag>
                                {batch ? <p role="status" className="text-xs text-muted-foreground">{t("managed.imageBatchSummary", batch)}</p> : null}
                                {batch && batch.completed < batch.total ? <p className="text-xs text-muted-foreground">{t("managed.imageBatchIncompleteNotice")}</p> : null}
                                {ready && partial ? <p className="text-xs text-muted-foreground">{t("managed.imageBatchPartialNotice", batch)}</p> : null}
                                {errors[record.id] || record.value.result?.error_message ? (
                                    <p role="status" className="text-xs text-muted-foreground">
                                        {errors[record.id] || record.value.result?.error_message}
                                    </p>
                                ) : null}
                                {unknown ? <p className="text-xs text-muted-foreground">{t("managed.imageTaskUnknown")}</p> : null}
                            </div>
                            {ready ? (
                                <Button size="small" disabled={generating} loading={busy.includes(record.id)} onClick={() => void open(record)}>
                                    {t("managed.viewResults")}
                                </Button>
                            ) : recoverable ? (
                                <Button size="small" loading={busy.includes(record.id)} onClick={() => void query(record)}>
                                    {t(storagePending && !record.task_id ? "managed.recoverImage" : "managed.resumeImage")}
                                </Button>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
