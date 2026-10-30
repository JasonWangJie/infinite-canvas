import i18n from "@/i18n";
import { currentSession, sessionEpoch } from "@/services/api/canvas-client";
import { imageTaskHasResult, imageTaskPending, readImageTasks, refreshImageTask, type ImageTaskRecord } from "@/services/api/image-tasks";
import { recoverImageTaskRecords } from "@/services/image-task-records";
import { getDocumentDraft, getDocumentSaveState, readSavedDocument } from "@/services/canvas-data";
import { resumeVideoGeneration, type GenerationLog } from "@/pages/video/generation-log";
import { useConfigStore } from "@/stores/use-config-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type TaskCenterSource = "image-tasks" | "image-workbench" | "video-workbench" | "canvas";
export type TaskCenterStatus = "active" | "attention" | "completed" | "failed";
export type TaskCenterItem = {
    id: string;
    recordId: string;
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
    imageTaskRecordIds?: string[];
    href: string;
    summary?: string;
    error?: string;
    canResume: boolean;
    resumeAction?: "query" | "save";
    relatedTasks?: TaskCenterItem[];
    hasCompletedOutput?: boolean;
    sessionEpoch: number;
    imageTask?: ImageTaskRecord;
    videoLog?: GenerationLog;
};
export type TaskCenterSnapshot = { items: TaskCenterItem[]; errors: Partial<Record<TaskCenterSource, string>> };
type ImageLog = { id: string; title?: string; prompt?: string; model?: string; createdAt?: number; status: string; failCount?: number; images?: unknown[]; imageTaskRecordIds?: string[]; recoverableCount?: number; requestCount?: number };
type TaskDocumentDomain = Exclude<TaskCenterSource, "image-tasks">;

function duration(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function requestMeasurement(value: { requestId?: string; durationMs: number }) {
    const durationMs = duration(value?.durationMs);
    if (durationMs === undefined) return undefined;
    return { durationMs, ...(typeof value.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId) ? { requestId: value.requestId } : {}) };
}

export function taskCenterMeasurements(item: TaskCenterItem) {
    const value = item.imageTask?.value;
    const requests = Array.isArray(value?.requests) ? value.requests.flatMap((request) => { const safe = requestMeasurement(request); return safe ? [safe] : []; }) : [];
    const lastQuery = value?.lastQuery ? requestMeasurement(value.lastQuery) : undefined;
    const media = Object.entries(value?.mediaTimings || {}).flatMap(([index, timings]) => {
        if (!/^\d+$/.test(index) || !Number.isSafeInteger(Number(index)) || !timings || typeof timings !== "object") return [];
        const readMediaMs = duration(timings.readMediaMs), decodeMs = duration(timings.decodeMs), localSaveMs = duration(timings.localSaveMs);
        return readMediaMs === undefined && decodeMs === undefined && localSaveMs === undefined ? [] : [{ index: Number(index), readMediaMs, decodeMs, localSaveMs }];
    });
    return { requests: requests.length ? requests : undefined, lastQuery, media: media.length ? media : undefined };
}

function diagnosticFields(item: TaskCenterItem): object {
    // Keep this allowlist independent of the full records, which contain private input and media.
    return {
        source: item.source,
        kind: item.kind,
        status: item.status,
        recordId: item.recordId,
        taskId: item.taskId,
        projectId: item.projectId,
        nodeId: item.nodeId,
        imageTaskRecordIds: item.imageTaskRecordIds,
        ...taskCenterMeasurements(item),
        relatedTasks: item.relatedTasks?.map(diagnosticFields),
    };
}

export function taskCenterDiagnostics(item: TaskCenterItem): string {
    return JSON.stringify(diagnosticFields(item), null, 2);
}

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
    const unknown = ["execution_unknown", "unknown"].includes(record.status);
    return {
        id: `image-task:${record.id}`,
        recordId: record.id,
        source: "image-tasks",
        kind: "image",
        status: storagePending || incomplete || unknown ? "attention" : ready ? partial ? "attention" : "completed" : failed ? "failed" : pending ? "active" : "attention",
        title: record.value.model || record.id,
        prompt: "",
        model: record.value.model || "",
        createdAt: (record.created_at || 0) * 1000,
        taskId: record.task_id || undefined,
        projectId: record.value.source?.canvasId,
        nodeId: record.value.source?.nodeId,
        href: `/image?task=${encodeURIComponent(record.id)}`,
        summary: batch ? [i18n.t("managed.imageBatchSummary", batch), incomplete ? i18n.t("managed.imageBatchIncompleteNotice") : "", ready && partial ? i18n.t("managed.imageBatchPartialNotice", batch) : ""].filter(Boolean).join(" ") : undefined,
        error: record.value.result?.error_message,
        canResume: storagePending || (!batch && !ready && pending),
        resumeAction: storagePending ? "save" : !batch && !ready && pending ? "query" : undefined,
        sessionEpoch: epoch,
        imageTask: record,
    };
}

function videoLogItem(log: GenerationLog, epoch: number): TaskCenterItem {
    return {
        id: `video-log:${log.id}`,
        recordId: log.id,
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
        resumeAction: log.video ? "save" : "query",
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
        if (!["image", "video", "text", "audio"].includes(node.type) || !metadata) return [];
        const imageTaskRecordIds = [...new Set([metadata.imageTaskRecordId, ...(metadata.images || []).map((image) => image.imageTaskRecordId)].filter((id): id is string => typeof id === "string" && Boolean(id)))];
        if (metadata.status === "idle" && !imageTaskRecordIds.length && !metadata.videoSubmissionUnknown) return [];
        // Uploaded media and text notes have no generation metadata and are not tasks.
        if (!imageTaskRecordIds.length && !metadata.videoTaskId && !metadata.videoSubmissionUnknown && !metadata.generationType && !(metadata.model && (metadata.images?.length || metadata.texts?.length || metadata.prompt))) return [];
        const outputs = [...(metadata.images || []), ...(metadata.texts || [])];
        const failed = outputs.some((output) => output.status === "error");
        const pending = metadata.status === "loading" || outputs.some((output) => output.status === "loading");
        const status: TaskCenterStatus = metadata.videoSubmissionUnknown || imageTaskRecordIds.length ? "attention" : pending ? (metadata.videoTaskId ? "active" : "attention") : metadata.status === "error" ? (metadata.videoTaskId ? "attention" : "failed") : failed ? "attention" : "completed";
        return [{
            id: `canvas:${project.id}:${node.id}`,
            recordId: node.id,
            source: "canvas",
            kind: node.type as TaskCenterItem["kind"],
            status,
            hasCompletedOutput: outputs.some((output) => output.status === "success"),
            title: `${project.title} · ${node.title}`,
            prompt: metadata.prompt || "",
            model: metadata.model || "",
            // Nodes have no independent task timestamp; use the containing project's update.
            createdAt: Date.parse(project.updatedAt || project.createdAt) || 0,
            taskId: metadata.videoTaskId,
            projectId: project.id,
            nodeId: node.id,
            imageTaskRecordIds: imageTaskRecordIds.length ? imageTaskRecordIds : undefined,
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
            recordId: log.id,
            source: "image-workbench",
            kind: "image",
            status: log.status === "attention" || log.recoverableCount ? "attention" : log.images?.length ? (log.failCount ? "attention" : "completed") : log.status === "failed" ? "failed" : "attention",
            title: log.title || log.id,
            prompt: log.prompt || "",
            model: log.model || "",
            createdAt: log.createdAt || 0,
            imageTaskRecordIds: Array.isArray(log.imageTaskRecordIds) ? [...new Set(log.imageTaskRecordIds.filter((id) => typeof id === "string" && Boolean(id)))] : undefined,
            summary: log.requestCount !== undefined ? i18n.t("tasks.imageRequestSummary", { defaultValue: "{{requests}} 次请求，{{images}} 张结果，{{recoverable}} 项待恢复", requests: log.requestCount, images: log.images?.length || 0, recoverable: log.recoverableCount || 0 }) : undefined,
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
    // Only explicit IDs and saved source links establish a relationship.
    const imageTasks = new Map(snapshot.items.filter((item) => item.source === "image-tasks").map((item) => [item.recordId, item]));
    const canvasRequests = new Map<string, TaskCenterItem[]>();
    for (const task of imageTasks.values()) {
        if (!task.projectId || !task.nodeId) continue;
        const key = `canvas:${task.projectId}:${task.nodeId}`;
        canvasRequests.set(key, [...(canvasRequests.get(key) || []), task]);
    }
    const attached = new Set<string>();
    for (const item of snapshot.items) {
        if (item.source === "image-tasks") continue;
        const currentIds = item.imageTaskRecordIds || [];
        const current = currentIds.flatMap((id) => { const task = imageTasks.get(id); return task ? [task] : []; });
        const related = [...new Map([...current, ...(canvasRequests.get(item.id) || [])].map((task) => [task.recordId, task])).values()];
        if (!related.length) continue;
        item.relatedTasks = related;
        related.forEach((task) => attached.add(task.recordId));
        if (item.source === "canvas") {
            item.createdAt = Math.max(...related.map((task) => task.createdAt));
            for (const task of related) {
                task.projectId = item.projectId;
                task.nodeId = item.nodeId;
                task.href = item.href;
            }
            if (currentIds.length) {
                item.status = current.length !== currentIds.length || current.some((task) => task.status === "attention") ? "attention"
                    : current.some((task) => task.status === "active") ? "active"
                    : current.every((task) => task.status === "failed") && !item.hasCompletedOutput ? "failed" : "attention";
                if (item.status === "active") { item.error = undefined; item.summary = i18n.t("managed.imageTaskPending"); }
                else if (item.status === "attention" && current.every((task) => task.status === "completed")) item.summary = i18n.t("managed.imageTaskStorageFailed");
            }
            continue;
        }
        if (related.some((task) => task.status === "attention") || (item.status === "completed" && related.some((task) => task.status !== "completed")) || (item.status === "failed" && related.some((task) => task.status !== "failed"))) item.status = "attention";
    }
    snapshot.items = snapshot.items.filter((item) => item.source !== "image-tasks" || !attached.has(item.recordId));
    snapshot.items.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return snapshot;
}

export async function readCanvasTaskDiagnostics(projectId: string, nodeId: string) {
    const item = (await loadTaskCenter()).items.find((task) => task.source === "canvas" && task.projectId === projectId && task.nodeId === nodeId);
    if (!item) throw new Error(i18n.t("taskCenter.recordRemoved"));
    return taskCenterDiagnostics(item);
}

export async function resumeTaskCenterItem(item: TaskCenterItem): Promise<TaskCenterItem> {
    assertSession(item.sessionEpoch);
    if (!item.canResume) return item;
    if (item.imageTask) {
        if (item.resumeAction === "save") {
            await recoverImageTaskRecords();
            assertSession(item.sessionEpoch);
            const current = (await readImageTasks()).find((record) => record.id === item.recordId);
            assertSession(item.sessionEpoch);
            if (!current) throw new Error(i18n.t("taskCenter.recordRemoved"));
            return imageTaskItem(current, item.sessionEpoch);
        }
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
