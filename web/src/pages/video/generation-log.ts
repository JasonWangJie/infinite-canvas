import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";
import { isVideoTaskFailed, storeGeneratedVideo, waitForVideoGenerationTask, type VideoGenerationTask } from "@/services/api/video";
import { createRecordStore, writeDocument } from "@/services/canvas-data";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type GeneratedVideo = {
    id: string;
    url: string;
    storageKey: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

export type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode">;
export type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    size: string;
    resolution: string;
    seconds: string;
    status: "pending" | "success" | "failed" | "paused" | "unknown";
    task?: VideoGenerationTask;
    agentTaskId?: string;
    video?: GeneratedVideo;
    error?: string;
};

export const logStore = createRecordStore("video-workbench");
const active = new Map<string, Promise<GenerationLog>>();
const controllers = new Set<AbortController>();
onSessionEnd(() => {
    for (const controller of controllers) controller.abort();
    controllers.clear();
    active.clear();
});

export function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        video: log.video?.storageKey ? { ...log.video, url: "" } : log.video,
    };
}

export function deleteVideoGenerationLogs(ids: string[]) {
    // Media can also belong to assets and canvas nodes. Removing history only drops its references.
    return writeDocument("video-workbench", (stored: unknown) => {
        const next = { ...((stored as Record<string, GenerationLog>) || {}) };
        for (const id of ids) delete next[id];
        return next;
    });
}

export function resumeVideoGeneration(log: GenerationLog, config: AiConfig): Promise<GenerationLog> {
    if (!log.task) return Promise.resolve(log);
    const epoch = sessionEpoch();
    const key = `${epoch}:${log.task.id}`;
    const existing = active.get(key);
    if (existing) return existing;
    const controller = new AbortController();
    controllers.add(controller);
    const work = recoverVideoGeneration(log, config, epoch, controller.signal).finally(() => {
        if (active.get(key) === work) active.delete(key);
        controllers.delete(controller);
    });
    active.set(key, work);
    return work;
}

async function recoverVideoGeneration(log: GenerationLog, config: AiConfig, epoch: number, signal: AbortSignal): Promise<GenerationLog> {
    let next = { ...log, status: "pending" as GenerationLog["status"], error: undefined as string | undefined };
    try {
        if (!await updateExistingVideoLog(next)) throw new Error(i18n.t("taskCenter.recordRemoved"));
        if (epoch !== sessionEpoch()) return log;
        let video = log.video;
        if (!video) {
            const result = await waitForVideoGenerationTask(config, log.task!, { signal });
            if (epoch !== sessionEpoch()) return log;
            const stored = await storeGeneratedVideo(result);
            if (epoch !== sessionEpoch()) return log;
            video = { ...stored, id: nanoid(), durationMs: Date.now() - log.createdAt, width: stored.width || 1280, height: stored.height || 720 };
        }
        next = { ...next, status: "success", video, durationMs: video.durationMs };
        await updateExistingVideoLog(next);
        return next;
    } catch (error) {
        if (epoch !== sessionEpoch()) return log;
        next = { ...next, status: isVideoTaskFailed(error) ? "failed" : "paused", durationMs: Date.now() - log.createdAt, error: error instanceof Error ? error.message : String(error) };
        try {
            await updateExistingVideoLog(next);
        } catch {
            // Keep the task and any already stored video in memory so an explicit resume can save them.
        }
        return next;
    }
}

export async function updateExistingVideoLog(log: GenerationLog) {
    let exists = false;
    await writeDocument("video-workbench", (stored: unknown) => {
        const records = (stored as Record<string, GenerationLog>) || {};
        // Neither starting nor finishing recovery may recreate deleted history.
        exists = Boolean(records[log.id]);
        return exists ? { ...records, [log.id]: serializeLog(log) } : records;
    });
    return exists;
}
