import { useEffect, useRef, useState } from "react";
import { Button, Dropdown, Space, Tooltip } from "antd";
import { ChevronDown, ExternalLink, PanelsTopLeft, Plus, Undo2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { placeResultsInCanvas, undoResultsInCanvas, type CanvasResult, type CanvasResultPlacement } from "@/lib/canvas/result-to-canvas";
import { onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";
import { retryDocument } from "@/services/canvas-data";
import { handoffResultPlacement } from "@/stores/canvas/use-result-placement-handoff-store";
import { flushCanvasSave, useCanvasStore } from "@/stores/canvas/use-canvas-store";

type ResultToCanvasProps = { result: CanvasResult; results?: never } | { result?: never; results: CanvasResult[] };

export function ResultToCanvasButton({ result, results }: ResultToCanvasProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const projects = useCanvasStore((state) => state.projects);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const [busy, setBusy] = useState(false);
    const [expired, setExpired] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState<CanvasResultPlacement | null>(null);
    const [undone, setUndone] = useState(false);
    const placement = useRef<CanvasResultPlacement | null>(null);
    const selectionAtInsert = useRef("");
    const undoPending = useRef(false);
    const active = useRef(false);
    const mounted = useRef(true);
    const epoch = useRef(sessionEpoch());
    const recent = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const inputs = results || (result ? [result] : []);
    const selectionKey = JSON.stringify(inputs.map((item) => item.kind === "text"
        ? [item.id, item.kind, item.title, item.content]
        : [item.id, item.kind, item.title, item.storageKey || item.url, item.width, item.height, item.bytes, item.mimeType, item.durationMs]));
    const pendingInsert = Boolean(placement.current && !saved && !undoPending.current);
    const openSaved = Boolean(saved && (selectionKey === selectionAtInsert.current || !inputs.length));

    useEffect(() => {
        mounted.current = true;
        const unsubscribe = onSessionEnd(() => setExpired(true));
        return () => {
            mounted.current = false;
            unsubscribe();
        };
    }, []);

    const insert = async (projectId?: string, retry = false) => {
        if (active.current || expired || epoch.current !== sessionEpoch() || (!retry && !inputs.length)) return;
        active.current = true;
        setBusy(true);
        setError("");
        setUndone(false);
        try {
            if (!retry) {
                const target = placeResultsInCanvas(inputs, projectId, epoch.current);
                placement.current = target;
                selectionAtInsert.current = selectionKey;
                undoPending.current = false;
                setSaved(null);
            }
            const target = placement.current!;
            const project = useCanvasStore.getState().openProject(target.projectId);
            if (!project || !target.nodeIds.every((id) => project.nodes.some((node) => node.id === id))) throw new Error(t("resultToCanvas.projectMissing"));
            if (retry) await retryDocument("canvas");
            await flushCanvasSave();
            const latest = useCanvasStore.getState().openProject(target.projectId);
            if (!latest || !target.nodeIds.every((id) => latest.nodes.some((node) => node.id === id))) throw new Error(t("resultToCanvas.projectMissing"));
            if (epoch.current === sessionEpoch() && mounted.current) setSaved(target);
        } catch (error) {
            if (epoch.current === sessionEpoch() && mounted.current) setError(error instanceof Error ? error.message : String(error));
        } finally {
            active.current = false;
            if (mounted.current) setBusy(false);
        }
    };

    const undo = async () => {
        const target = placement.current;
        if (!target || active.current || expired || epoch.current !== sessionEpoch()) return;
        const retry = Boolean(error);
        active.current = true;
        setBusy(true);
        setError("");
        try {
            if (!undoPending.current) {
                undoResultsInCanvas(target, epoch.current);
                undoPending.current = true;
            }
            const project = useCanvasStore.getState().openProject(target.projectId);
            if (!project) throw new Error(t("resultToCanvas.projectMissing"));
            if (project.nodes.some((node) => target.nodeIds.includes(node.id))) throw new Error(t("resultToCanvas.undoChanged"));
            if (retry) await retryDocument("canvas");
            await flushCanvasSave();
            const latest = useCanvasStore.getState().openProject(target.projectId);
            if (!latest) throw new Error(t("resultToCanvas.projectMissing"));
            if (latest.nodes.some((node) => target.nodeIds.includes(node.id))) throw new Error(t("resultToCanvas.undoChanged"));
            if (epoch.current === sessionEpoch() && mounted.current) {
                placement.current = null;
                undoPending.current = false;
                setSaved(null);
                setUndone(true);
            }
        } catch (error) {
            if (epoch.current === sessionEpoch() && mounted.current) setError(error instanceof Error ? error.message : String(error));
        } finally {
            active.current = false;
            if (mounted.current) setBusy(false);
        }
    };

    const open = (target: CanvasResultPlacement | null = saved) => {
        if (!target || epoch.current !== sessionEpoch()) return;
        handoffResultPlacement(target);
        const search = new URLSearchParams();
        for (const id of target.nodeIds) search.append("focusNode", id);
        navigate(`/canvas/${encodeURIComponent(target.projectId)}?${search}`);
    };
    const label = undoPending.current ? "resultToCanvas.undoRetry" : pendingInsert ? "resultToCanvas.retrySave" : openSaved ? "resultToCanvas.open" : results ? "resultToCanvas.insertBatch" : "resultToCanvas.insert";
    const blockTarget = !hydrated || expired || busy || !inputs.length || pendingInsert || undoPending.current;

    return (
        <div className="min-w-0">
            <Space.Compact className="w-full">
                <Tooltip title={openSaved ? t("resultToCanvas.saved", { title: saved!.title }) : t("resultToCanvas.target", { title: pendingInsert ? placement.current!.title : recent[0]?.title || t("resultToCanvas.newCanvas") })}>
                    <Button
                        className="min-w-0 flex-1 px-1.5 [&>span:last-child]:truncate"
                        size="small"
                        icon={undoPending.current ? <Undo2 className="size-3.5" /> : openSaved ? <ExternalLink className="size-3.5" /> : <PanelsTopLeft className="size-3.5" />}
                        loading={busy}
                        disabled={!hydrated || expired || (!inputs.length && !placement.current)}
                        onClick={() => undoPending.current ? void undo() : pendingInsert ? void insert(placement.current!.projectId, true) : openSaved ? open() : void insert(recent[0]?.id)}
                    >
                        {t(label, { count: inputs.length })}
                    </Button>
                </Tooltip>
                <Dropdown
                    trigger={["click"]}
                    disabled={blockTarget}
                    menu={{
                        items: [...recent.map((project) => ({ key: project.id, label: project.title })), ...(recent.length ? [{ type: "divider" as const }] : []), { key: "new", label: t("resultToCanvas.newCanvas"), icon: <Plus className="size-3.5" /> }],
                        onClick: ({ key }) => saved && selectionKey === selectionAtInsert.current && saved.projectId === key ? open() : void insert(key === "new" ? undefined : key),
                        style: { maxHeight: 280, overflowY: "auto" },
                    }}
                >
                    <Button size="small" disabled={blockTarget} aria-label={t("resultToCanvas.choose")} icon={<ChevronDown className="size-3.5" />} />
                </Dropdown>
            </Space.Compact>
            {placement.current ? (
                <div className="flex flex-wrap gap-x-3">
                    {saved && !openSaved && !undoPending.current ? <Button type="link" size="small" className="!px-0" disabled={busy || expired} onClick={() => open()}>{t("resultToCanvas.open")}</Button> : null}
                    <Button type="link" size="small" className="!px-0" icon={<Undo2 className="size-3.5" />} disabled={busy || expired} onClick={() => void undo()}>{t(undoPending.current ? "resultToCanvas.undoRetry" : "resultToCanvas.undo")}</Button>
                </div>
            ) : null}
            {error ? (
                <p role="alert" className="mt-1 text-xs text-destructive">
                    {error}
                    {undoPending.current ? ` ${t("resultToCanvas.undoDraftKept")}` : pendingInsert ? ` ${t("resultToCanvas.draftKept")}` : ""}
                </p>
            ) : null}
            {error && (pendingInsert || undoPending.current) ? (
                <>
                    {results && pendingInsert ? <p role="status" className="mt-1 text-xs text-muted-foreground">{t("resultToCanvas.pendingBatch", { count: placement.current!.nodeIds.length })}</p> : null}
                    <Button type="link" size="small" className="!px-0" disabled={busy || expired} onClick={() => open(placement.current)}>{t("resultToCanvas.openDraft")}</Button>
                </>
            ) : null}
            {undone ? <p role="status" className="mt-1 text-xs text-muted-foreground">{t("resultToCanvas.undone")}</p> : null}
            {expired ? <p role="status" className="mt-1 text-xs text-muted-foreground">{t("managed.sessionExpired")}</p> : null}
        </div>
    );
}
