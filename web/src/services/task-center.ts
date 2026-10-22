import i18n from "@/i18n";
import { currentSession, sessionEpoch } from "@/services/api/canvas-client";
import { imageTaskHasResult, imageTaskPending, readImageTasks, refreshImageTask, type ImageTaskRecord } from "@/services/api/image-tasks";
import { getDocumentDraft, getDocumentSaveState, readSavedDocument } from "@/services/canvas-data";
import { resumeVideoGeneration, type GenerationLog } from "@/pages/video/generation-log";
import { useConfigStore } from "@/stores/use-config-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type TaskCenterSource = "image-tasks" | "image-workbench" | "video-workbench" | "canvas";
export type TaskCenterStatus = "active" | "attention" | "completed" | "failed";
export type TaskCenterItem = {
    id: string;
    source: TaskCenterSource;
    kind: "image" | "video" | "text" | "audio";
    status: TaskCenterStatus;
    title: string;
    prompt: string;
    model: string;
    createdAt: number;
    taskId?: string;
    projectId?: string;
    nodeId?: string;
    href: string;
    summary?: string;
    error?: string;
    canResume: boolean;
    sessionEpoch: number;
    imageTask?: ImageTaskRecord;
    videoLog?: GenerationLog;
};
export type TaskCenterSnapshot = { items: TaskCenterItem[]; errors: Partial<Record<TaskCenterSource, string>> };
type ImageLog = { id: string; title?: string; prompt?: string; model?: string; createdAt?: number; status: string; failCount?: number; images?: unknown[] };
type TaskDocumentDomain = Exclude<TaskCenterSource, "image-tasks">;

function assertSession(epoch: number) {
    if (epoch !== sessionEpoch() || !currentSession()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
}

function localDraft(domain: TaskDocumentDomain) {
    return ["pending", "saving", "error", "conflict"].includes(getDocumentSaveState(domain).status) ? getDocumentDraft(domain) : undefined;
}

// Read-only snapshots must never advance the revision used by a still-open editor.
export async function readTaskCenterDocument(domain: TaskDocumentDomain): Promise<unknown> {
    const epoch = sessionEpoch();
    assertSession(epoch);
    const local = localDraft(domain);
    if (local !== undefined) return local;
    const value = await readSavedDocument(domain);
    assertSession(epoch);
    const latest = localDraft(domain);
    return latest !== undefined ? latest : value;
}

function imageTaskItem(record: ImageTaskRecord, epoch: number): TaskCenterItem {
    const ready = imageTaskHasResult(record);
    const batch = record.value.batch;
    const partial = Boolean(batch && (batch.failed || batch.unknown));
    const incomplete = Boolean(batch && batch.completed < batch.total);
    const storagePending = ["storage_failed", "storage_pending"].includes(record.status);
    const failed = ["failed", "cancelled", "canceled", "expired"].includes(record.status);
    const pending = imageTaskPending(record);
    return {
        id: `image-task:${record.id}`,
        source: "image-tasks",
        kind: "image",
        status: storagePending || incomplete ? "attention" : ready ? partial ? "attention" : "completed" : failed ? "failed" : pending ? "active" : "attention",
        title: record.value.model || record.id,
        prompt: "",
        model: record.value.model || "",
        createdAt: (record.created_at || 0) * 1000,
        taskId: record.task_id || undefined,
        href: `/image?task=${encodeURIComponent(record.id)}`,
        summary: batch ? [i18n.t("managed.imageBatchSummary", batch), incomplete ? i18n.t("managed.imageBatchIncompleteNotice") : "", ready && partial ? i18n.t("managed.imageBatchPartialNotice", batch) : ""].filter(Boolean).join(" ") : undefined,
        error: record.value.result?.error_message,
        canResume: !batch && !ready && (storagePending || pending),
        sessionEpoch: epoch,
        imageTask: record,
    };
}

function videoLogItem(log: GenerationLog, epoch: number): TaskCenterItem {
    return {
        id: `video-log:${log.id}`,
        source: "video-workbench",
        kind: "video",
        status: log.status === "success" ? "completed" : log.status === "failed" ? "failed" : log.status === "pending" && log.task ? "active" : "attention",
        title: log.title,
        prompt: log.prompt,
        model: log.task?.model || log.model,
        createdAt: log.createdAt,
        taskId: log.task?.id,
        href: `/video?log=${encodeURIComponent(log.id)}`,
        error: log.error,
        canResume: Boolean(log.task && (log.status === "pending" || log.status === "paused")),
        sessionEpoch: epoch,
        videoLog: log,
    };
}

function recordValues<T>(value: unknown): T[] {
    if (value == null) return [];
    if (typeof value !== "object" || Array.isArray(value)) throw new Error(i18n.t("taskCenter.invalidSource"));
    return Object.values(value) as T[];
}

function canvasItems(value: unknown, epoch: number): TaskCenterItem[] {
    if (value == null) return [];
    const projects = (value as { state?: { projects?: CanvasProject[] } }).state?.projects;
    if (!Array.isArray(projects)) throw new Error(i18n.t("taskCenter.invalidSource"));
    return projects.flatMap((project) => project.nodes.flatMap((node): TaskCenterItem[] => {
        const metadata = node.metadata;
        if (!["image", "video", "text", "audio"].includes(node.type) || !metadata || metadata.status === "idle") return [];
        // Uploaded media and text notes have no generation metadata and are not tasks.
        if (!metadata.videoTaskId && !metadata.videoSubmissionUnknown && !metadata.generationType && !(metadata.model && (metadata.images?.length || metadata.texts?.length || metadata.prompt))) return [];
        const outputs = [...(metadata.images || []), ...(metadata.texts || [])];
        const failed = outputs.some((output) => output.status === "error");
        const pending = metadata.status === "loading" || outputs.some((output) => output.status === "loading");
        const status: TaskCenterStatus = metadata.videoSubmissionUnknown ? "attention" : pending ? (metadata.videoTaskId ? "active" : "attention") : metadata.status === "error" ? (metadata.videoTaskId ? "attention" : "failed") : failed ? "attention" : "completed";
        return [{
            id: `canvas:${project.id}:${node.id}`,
            source: "canvas",
            kind: node.type as TaskCenterItem["kind"],
            status,
            title: `${project.title} · ${node.title}`,
            prompt: metadata.prompt || "",
            model: metadata.model || "",
            // Nodes have no independent task timestamp; use the containing project's update.
            createdAt: Date.parse(project.updatedAt || project.createdAt) || 0,
            taskId: metadata.videoTaskId,
            projectId: project.id,
            nodeId: node.id,
            href: `/canvas/${encodeURIComponent(project.id)}?focusNode=${encodeURIComponent(node.id)}`,
            error: metadata.errorDetails || (metadata.videoSubmissionUnknown ? i18n.t("managed.imageTaskUnknown") : outputs.find((output) => output.status === "error")?.errorDetails),
            canResume: false,
            sessionEpoch: epoch,
        }];
    }));
}

export async function loadTaskCenter(): Promise<TaskCenterSnapshot> {
    const epoch = sessionEpoch();
    assertSession(epoch);
    const sources = ["image-tasks", "image-workbench", "video-workbench", "canvas"] as const;
    const results = await Promise.allSettled([
        readImageTasks().then((records) => records.map((record) => imageTaskItem(record, epoch))),
        readTaskCenterDocument("image-workbench").then((value) => recordValues<ImageLog>(value).map((log): TaskCenterItem => ({
            id: `image-log:${log.id}`,
            source: "image-workbench",
            kind: "image",
            status: log.images?.length ? (log.failCount ? "attention" : "completed") : log.status === "failed" ? "failed" : "attention",
            title: log.title || log.id,
            prompt: log.prompt || "",
            model: log.model || "",
            createdAt: log.createdAt || 0,
            href: `/image?log=${encodeURIComponent(log.id)}`,
            canResume: false,
            sessionEpoch: epoch,
        }))),
        readTaskCenterDocument("video-workbench").then((value) => recordValues<GenerationLog>(value).map((log) => videoLogItem(log, epoch))),
        readTaskCenterDocument("canvas").then((value) => canvasItems(value, epoch)),
    ]);
    assertSession(epoch);
    const snapshot: TaskCenterSnapshot = { items: [], errors: {} };
    results.forEach((result, index) => {
        if (result.status === "fulfilled") snapshot.items.push(...result.value);
        else snapshot.errors[sources[index]] = result.reason instanceof Error ? result.reason.message : String(result.reason);
    });
    // The sources have no shared reliable ID. Keep independent records instead of guessing duplicates.
    snapshot.items.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return snapshot;
}

export async function resumeTaskCenterItem(item: TaskCenterItem): Promise<TaskCenterItem> {
    assertSession(item.sessionEpoch);
    if (!item.canResume) return item;
    if (item.imageTask) {
        const next = await refreshImageTask(item.imageTask);
        assertSession(item.sessionEpoch);
        return imageTaskItem(next, item.sessionEpoch);
    }
    if (item.videoLog) {
        const value = await readTaskCenterDocument("video-workbench");
        assertSession(item.sessionEpoch);
        const log = recordValues<GenerationLog>(value).find((entry) => entry.id === item.videoLog!.id);
        if (!log) throw new Error(i18n.t("taskCenter.recordRemoved"));
        const current = videoLogItem(log, item.sessionEpoch);
        if (!current.canResume) return current;
        const config = { ...useConfigStore.getState().config, ...log.config, model: log.task!.model || log.model };
        const next = await resumeVideoGeneration(log, config);
        assertSession(item.sessionEpoch);
        return videoLogItem(next, item.sessionEpoch);
    }
    return item;
}
