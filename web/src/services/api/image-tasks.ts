import { canvasFetch, onSessionEnd, sessionEpoch } from "./canvas-client";
import { parseImagePayload } from "./image";
import { readImageTaskRecords, recoverImageTaskRecords, updateImageTaskRecord, type ImageTaskRecord } from "@/services/image-task-records";
import { fileUrl } from "@/services/canvas-data";
import { readStoredImage, uploadImage } from "@/services/image-storage";
import i18n from "@/i18n";
export type { ImageTaskRecord, ImageTaskResult } from "@/services/image-task-records";

const queries = new Map<string, Promise<ImageTaskRecord>>();
onSessionEnd(() => queries.clear());

export async function readImageTasks() {
    return Object.values(await readImageTaskRecords()).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

export function imageTaskHasResult(record: ImageTaskRecord) {
    const result = record.value.result;
    return Boolean(record.has_result || (result && (result.data?.length || result.images?.length || result.results?.length)));
}

export function imageTaskPending(record: ImageTaskRecord) {
    return Boolean(record.task_id) && !imageTaskHasResult(record) && !["failed", "cancelled", "canceled", "expired", "succeeded"].includes(record.status);
}

// Dedupe strict-mode mounts and repeated clicks. This operation never submits a model request.
export function refreshImageTask(record: ImageTaskRecord): Promise<ImageTaskRecord> {
    const key = `${sessionEpoch()}:${record.id}`;
    const pending = queries.get(key);
    if (pending) return pending;
    const request = (async () => {
        const epoch = sessionEpoch();
        const current = (await readImageTaskRecords())[record.id];
        if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
        if (!current) throw new Error(i18n.t("taskCenter.recordRemoved"));
        record = current;
        if (imageTaskHasResult(record)) {
            await recoverImageTaskRecords();
            const recovered = (await readImageTaskRecords())[record.id];
            if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
            if (!recovered) throw new Error(i18n.t("taskCenter.recordRemoved"));
            return recovered;
        }
        if (record.task_id) {
            const response = await canvasFetch(`/api/ai/v1/images/tasks_async/${encodeURIComponent(record.task_id)}`);
            const result = await response.json();
            if (epoch !== sessionEpoch()) throw new Error("登录会话已改变");
            if (!response.ok) throw new Error(result.error?.message || `请求失败（${response.status}）`);
            const seconds = Number(response.headers.get("Retry-After"));
            return updateImageTaskRecord(record.id, (latest) => {
                // A fresh list does not establish a write baseline. Another observer
                // may have completed or replaced this task while its query was in flight.
                if (latest.task_id !== record.task_id || !imageTaskPending(latest)) return latest;
                const retryAfter = Number.isFinite(seconds) && seconds > 0 ? seconds : latest.value.retryAfter;
                return { ...latest, status: result.status || latest.status, value: { ...latest.value, retryAfter, result } };
            });
        }
        return record;
    })().finally(() => {
        if (queries.get(key) === request) queries.delete(key);
    });
    queries.set(key, request);
    return request;
}

export async function imageTaskImages(record: ImageTaskRecord) {
    const epoch = sessionEpoch();
    const detail = (await readImageTaskRecords())[record.id];
    if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
    if (!detail) throw new Error(i18n.t("taskCenter.recordRemoved"));
    const images = parseImagePayload(detail.value.result || {});
    const storedImages = [];
    for (const [index, image] of images.entries()) {
        const current = (await readImageTaskRecords())[record.id];
        if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
        if (!current) throw new Error(i18n.t("taskCenter.recordRemoved"));
        const existing = current.value.localImages?.[index];
        const stored = existing ? await readStoredImage(existing) : await uploadImage(image.dataUrl);
        if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
        let storageKey = stored.storageKey!;
        await updateImageTaskRecord(record.id, (latest) => {
            storageKey = latest.value.localImages?.[index] || storageKey;
            return { ...latest, value: { ...latest.value, localImages: { ...latest.value.localImages, [index]: storageKey } } };
        });
        storedImages.push({ id: image.id, dataUrl: fileUrl(storageKey) });
    }
    return storedImages;
}
