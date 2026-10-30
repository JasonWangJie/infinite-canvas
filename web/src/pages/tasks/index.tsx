import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Select, Spin, Tag, theme } from "antd";
import { ArrowUpRight, Copy, ListChecks, Play, RefreshCw, Search } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";
import { loadTaskCenter, resumeTaskCenterItem, taskCenterDiagnostics, taskCenterMeasurements, type TaskCenterItem, type TaskCenterSource, type TaskCenterStatus } from "@/services/task-center";
import { refreshCanvasTaskTarget } from "@/stores/canvas/use-canvas-store";
import { useCopyText } from "@/hooks/use-copy-text";

const sources: TaskCenterSource[] = ["image-tasks", "image-workbench", "video-workbench", "canvas"];
const statuses: TaskCenterStatus[] = ["active", "attention", "completed", "failed"];
const statusColors = { active: "processing", attention: "warning", completed: "success", failed: "error" } as const;

export default function TasksPage() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const { token } = theme.useToken();
    const navigate = useNavigate();
    const copyText = useCopyText();
    const [params, setParams] = useSearchParams();
    const [items, setItems] = useState<TaskCenterItem[]>([]);
    const [errors, setErrors] = useState<Partial<Record<TaskCenterSource, string>>>({});
    const [loadError, setLoadError] = useState("");
    const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string[]>([]);
    const mounted = useRef(false);
    const loadingRef = useRef(false);
    const active = useRef(new Set<string>());
    const opening = useRef<AbortController | null>(null);
    const generation = useRef(0);
    const snapshotVersion = useRef(0);
    const query = params.get("q") || "";
    const source = sources.find((value) => value === params.get("source")) || "all";
    const status = statuses.find((value) => value === params.get("status")) || "all";
    const projectId = params.get("project") || "";

    const refresh = useCallback(async () => {
        if (loadingRef.current || active.current.size) return;
        const version = generation.current;
        const epoch = sessionEpoch();
        const snapshot = ++snapshotVersion.current;
        loadingRef.current = true;
        setLoading(true);
        setLoadError("");
        try {
            const result = await loadTaskCenter();
            if (!mounted.current || version !== generation.current || epoch !== sessionEpoch() || snapshot !== snapshotVersion.current) return;
            setItems(result.items);
            setErrors(result.errors);
            setActionErrors({});
        } catch (error) {
            if (mounted.current && version === generation.current && epoch === sessionEpoch()) setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
            if (mounted.current && version === generation.current && epoch === sessionEpoch()) {
                loadingRef.current = false;
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        mounted.current = true;
        const unsubscribe = onSessionEnd(() => {
            generation.current += 1;
            opening.current?.abort();
            opening.current = null;
            loadingRef.current = false;
            active.current.clear();
            setItems([]);
            setErrors({});
            setActionErrors({});
            setLoadError("");
            setBusy([]);
            setLoading(false);
        });
        void refresh();
        return () => {
            mounted.current = false;
            generation.current += 1;
            opening.current?.abort();
            opening.current = null;
            loadingRef.current = false;
            active.current.clear();
            unsubscribe();
        };
    }, [refresh]);

    const visibleItems = useMemo(() => {
        const keyword = query.trim().toLocaleLowerCase();
        return items.filter((item) => {
            const records = [item, ...(item.relatedTasks || [])];
            return (!projectId || records.some((record) => record.projectId === projectId))
                && (source === "all" || records.some((record) => record.source === source || source === "canvas" && Boolean(record.projectId)))
                && (status === "all" || records.some((record) => record.status === status))
                && (!keyword || records.some((record) => [record.title, record.prompt, record.model, record.taskId, record.id].join(" ").toLocaleLowerCase().includes(keyword)));
        });
    }, [items, query, source, status, projectId]);

    const updateFilter = (key: string, value: string) => {
        setParams((current) => {
            const next = new URLSearchParams(current);
            if (value && value !== "all") next.set(key, value);
            else next.delete(key);
            return next;
        }, { replace: true });
    };

    const resume = async (item: TaskCenterItem) => {
        if (loadingRef.current || active.current.has(item.id) || !item.canResume || item.sessionEpoch !== sessionEpoch()) return;
        const version = generation.current;
        const epoch = sessionEpoch();
        active.current.add(item.id);
        setBusy([...active.current]);
        setActionErrors((current) => ({ ...current, [item.id]: "" }));
        try {
            await resumeTaskCenterItem(item);
            if (!mounted.current || version !== generation.current || epoch !== sessionEpoch()) return;
            const snapshot = ++snapshotVersion.current;
            const updated = await loadTaskCenter();
            if (!mounted.current || version !== generation.current || epoch !== sessionEpoch() || snapshot !== snapshotVersion.current) return;
            setItems(updated.items);
            setErrors(updated.errors);
            message.success(t("tasks.updated"));
        } catch (error) {
            if (mounted.current && version === generation.current && epoch === sessionEpoch()) {
                setActionErrors((current) => ({ ...current, [item.id]: error instanceof Error ? error.message : t("tasks.resumeFailed") }));
            }
        } finally {
            if (mounted.current && version === generation.current && epoch === sessionEpoch()) {
                active.current.delete(item.id);
                setBusy([...active.current]);
            }
        }
    };

    const openCanvasSource = async (item: TaskCenterItem) => {
        const key = `${item.id}:open`;
        if (opening.current || !item.projectId || !item.nodeId || item.sessionEpoch !== sessionEpoch()) return;
        const version = generation.current;
        const epoch = sessionEpoch();
        const controller = new AbortController();
        opening.current = controller;
        active.current.add(key);
        setBusy([...active.current]);
        setActionErrors((current) => ({ ...current, [item.id]: "" }));
        try {
            await refreshCanvasTaskTarget(item.projectId, item.nodeId, controller.signal);
            if (!controller.signal.aborted && mounted.current && version === generation.current && epoch === sessionEpoch()) navigate(item.href);
        } catch (error) {
            if (!controller.signal.aborted && mounted.current && version === generation.current && epoch === sessionEpoch()) setActionErrors((current) => ({ ...current, [item.id]: error instanceof Error ? error.message : t("tasks.openFailed") }));
        } finally {
            if (opening.current === controller) opening.current = null;
            if (mounted.current && version === generation.current && epoch === sessionEpoch()) {
                active.current.delete(key);
                setBusy([...active.current]);
            }
        }
    };

    const taskActions = (item: TaskCenterItem) => (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button type="text" icon={<Copy className="size-3.5" />} title={t("tasks.copyDiagnosticsHint")} onClick={() => { if (item.sessionEpoch === sessionEpoch()) copyText(taskCenterDiagnostics(item)); }}>{t("tasks.copyDiagnostics")}</Button>
            {item.canResume ? <Button icon={<Play className="size-3.5" />} title={t(item.resumeAction === "save" ? "tasks.restoreSaveHint" : "tasks.resumeHint", { defaultValue: "仅保存已收到的结果，不重新生成。" })} loading={busy.includes(item.id)} disabled={loading} onClick={() => void resume(item)}>{item.resumeAction === "save" ? t("tasks.restoreSave", { defaultValue: "恢复本地保存" }) : t("tasks.resume")}</Button> : null}
            {item.projectId && item.nodeId && item.href.startsWith("/canvas/") ? <Button type="link" icon={<ArrowUpRight className="size-3.5" />} loading={busy.includes(`${item.id}:open`)} disabled={Boolean(opening.current)} onClick={() => void openCanvasSource(item)}>{t("tasks.openSource")}</Button> : <Link to={item.href} className="inline-flex min-h-8 items-center gap-1 px-2 text-sm" style={{ color: token.colorLink }}>{item.status === "attention" && !item.canResume ? t("tasks.verifyStatus", { defaultValue: "核实原记录" }) : t("tasks.openSource")}<ArrowUpRight className="size-3.5" /></Link>}
        </div>
    );

    return (
        <main className="h-full overflow-y-auto px-4 py-6 sm:px-6" style={{ color: token.colorText, background: token.colorBgLayout }}>
            <div className="mx-auto max-w-5xl">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h1 className="flex items-center gap-2 text-2xl font-semibold"><ListChecks className="size-6" />{t("tasks.title")}</h1>
                        <p className="mt-2 text-sm" style={{ color: token.colorTextSecondary }}>{t("tasks.description")}</p>
                    </div>
                    <Button icon={<RefreshCw className="size-4" />} loading={loading} disabled={busy.length > 0} onClick={() => void refresh()}>{t("tasks.refresh")}</Button>
                </div>

                <div className="mt-6 flex flex-wrap gap-3">
                    <Input className="min-w-48 flex-1" prefix={<Search className="size-4" />} allowClear value={query} aria-label={t("tasks.search")} placeholder={t("tasks.search")} onChange={(event) => updateFilter("q", event.target.value)} />
                    <Select className="min-w-40 flex-1 sm:flex-none" aria-label={t("tasks.sourceFilter")} value={source} onChange={(value) => updateFilter("source", value)} options={[{ value: "all", label: t("tasks.allSources") }, ...sources.map((value) => ({ value, label: t(`tasks.sources.${value}`) }))]} />
                    <Select className="min-w-32 flex-1 sm:flex-none" aria-label={t("tasks.statusFilter")} value={status} onChange={(value) => updateFilter("status", value)} options={[{ value: "all", label: t("tasks.allStatuses") }, ...statuses.map((value) => ({ value, label: t(`tasks.status.${value}`) }))]} />
                </div>

                <div className="mt-4 space-y-3" aria-live="polite">
                    {projectId ? <div className="flex flex-wrap items-center gap-2 text-sm"><span>{t("tasks.currentCanvas")}</span><Button type="text" size="small" onClick={() => updateFilter("project", "")}>{t("tasks.allCanvases")}</Button></div> : null}
                    {loadError ? <Alert type="error" showIcon title={t("tasks.loadFailed")} description={loadError} /> : null}
                    {sources.filter((key) => errors[key]).map((key) => <Alert key={key} type="warning" showIcon title={t("tasks.sourceFailed", { source: t(`tasks.sources.${key}`) })} description={errors[key]} />)}
                    <p className="text-sm" style={{ color: token.colorTextSecondary }}>{t("tasks.count", { count: visibleItems.length, total: items.length })}</p>
                </div>

                {loading && !items.length ? <div className="flex justify-center py-16" role="status" aria-label={t("tasks.loading")}><Spin /></div> : (
                    <ul className="mt-3" aria-label={t("tasks.title")}>
                        {visibleItems.map((item) => {
                            const timestamp = new Date(item.createdAt);
                            const hasTimestamp = item.createdAt > 0 && Number.isFinite(timestamp.getTime());
                            return (
                            <li key={item.id} data-task-id={item.id} className="flex flex-wrap items-start gap-4 border-b py-5" style={{ borderColor: token.colorBorderSecondary }}>
                                <div className="min-w-0 flex-1 basis-64">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Tag color={statusColors[item.status]}>{t(`tasks.status.${item.status}`)}</Tag>
                                        <span className="text-xs" style={{ color: token.colorTextSecondary }}>{t(`tasks.sources.${item.source}`)}</span>
                                        {item.model ? <span className="break-all text-xs" style={{ color: token.colorTextSecondary }}>{item.model}</span> : null}
                                    </div>
                                    <h2 className="mt-2 line-clamp-2 break-words text-sm font-medium" title={item.title}>{item.title || t(`tasks.kind.${item.kind}`)}</h2>
                                    {item.summary ? <p className="mt-1 break-words text-sm" style={{ color: token.colorTextSecondary }}>{item.summary}</p> : null}
                                    {item.prompt && item.prompt !== item.title ? <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-sm" title={item.prompt} style={{ color: token.colorTextSecondary }}>{item.prompt}</p> : null}
                                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: token.colorTextTertiary }}>
                                        {item.taskId ? <span className="break-all">{t("tasks.taskId", { id: item.taskId })}</span> : null}
                                        {item.imageTaskRecordIds?.map((id) => <Link key={id} to={`/image?task=${encodeURIComponent(id)}`} className="break-all" style={{ color: token.colorLink }}>{t("tasks.imageTaskRecord", { id })}</Link>)}
                                        {hasTimestamp ? <time dateTime={timestamp.toISOString()}>{timestamp.toLocaleString(i18n.resolvedLanguage)}</time> : null}
                                    </div>
                                    {actionErrors[item.id] || item.error ? <p role="alert" className="mt-2 break-words text-sm" style={{ color: token.colorError }}>{actionErrors[item.id] || item.error}</p> : null}
                                    <TaskMeasurements item={item} />
                                </div>
                                {taskActions(item)}
                                {item.relatedTasks?.length ? <details className="w-full min-w-0" open={source === "image-tasks" || Boolean(query)}>
                                    <summary className="cursor-pointer text-sm" style={{ color: token.colorTextSecondary }}>{t("tasks.relatedRequests", { defaultValue: "查看关联请求（{{count}}）", count: item.relatedTasks.length })}</summary>
                                    <ul className="mt-2 border-l pl-3" style={{ borderColor: token.colorBorderSecondary }}>
                                        {item.relatedTasks.map((related) => <li key={related.id} data-task-id={related.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                                            <div className="min-w-0 flex-1 basis-64">
                                                <Tag color={statusColors[related.status]}>{t(`tasks.status.${related.status}`)}</Tag>
                                                <span className="break-all text-xs">{related.model} · {related.taskId || related.recordId}</span>
                                                {related.summary ? <p className="mt-1 break-words text-sm" style={{ color: token.colorTextSecondary }}>{related.summary}</p> : null}
                                                {actionErrors[related.id] || related.error ? <p role="alert" className="mt-1 break-words text-sm" style={{ color: token.colorError }}>{actionErrors[related.id] || related.error}</p> : null}
                                                <TaskMeasurements item={related} />
                                            </div>
                                            {taskActions(related)}
                                        </li>)}
                                    </ul>
                                </details> : null}
                            </li>
                            );
                        })}
                    </ul>
                )}
                {!loading && !visibleItems.length ? <div className="py-12"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(items.length ? "tasks.noMatches" : loadError || Object.keys(errors).length ? "tasks.unavailable" : "tasks.empty")} />{query || source !== "all" || status !== "all" || projectId ? <div className="mt-3 text-center"><Button type="text" onClick={() => setParams({}, { replace: true })}>{t("tasks.clearFilters")}</Button></div> : null}</div> : null}
            </div>
        </main>
    );
}

function TaskMeasurements({ item }: { item: TaskCenterItem }) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const { requests, lastQuery, media } = taskCenterMeasurements(item);
    if (!requests && !lastQuery && !media) return null;
    const milliseconds = (value?: number) => value === undefined ? "—" : `${Math.round(value)} ms`;
    return <details className="mt-2 text-xs" style={{ color: token.colorTextSecondary }}>
        <summary className="cursor-pointer">{t("tasks.timings", { defaultValue: "查看耗时与请求标识" })}</summary>
        <ul className="mt-1 space-y-1">
            {requests?.map((request, index) => <li key={index} className="break-all">{t("tasks.requestTiming", { defaultValue: "请求 {{index}}：{{time}}", index: index + 1, time: milliseconds(request.durationMs) })}{request.requestId ? ` · ${request.requestId}` : ""}</li>)}
            {lastQuery ? <li className="break-all">{t("tasks.queryTiming", { defaultValue: "最近查询：{{time}}", time: milliseconds(lastQuery.durationMs) })}{lastQuery.requestId ? ` · ${lastQuery.requestId}` : ""}</li> : null}
            {media?.map((entry) => <li key={entry.index}>{t("tasks.mediaTiming", { defaultValue: "图片 {{index}}：读取 {{read}} · 解码 {{decode}} · 本地保存 {{save}}", index: entry.index + 1, read: milliseconds(entry.readMediaMs), decode: milliseconds(entry.decodeMs), save: milliseconds(entry.localSaveMs) })}</li>)}
        </ul>
    </details>;
}
