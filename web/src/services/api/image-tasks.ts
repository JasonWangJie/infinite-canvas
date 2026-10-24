import { canvasFetch, onSessionEnd, sessionEpoch } from "./canvas-client";
import { parseImagePayload } from "./image";
import { readImageTaskRecords, recoverImageTaskRecords, updateImageTaskRecord, type ImageTaskRecord } from "@/services/image-task-records";
import { fileUrl } from "@/services/canvas-data";
import { readStoredImage, uploadImage } from "@/services/image-storage";
import { startGenerationRequest } from "@/services/generation-diagnostics";
import i18n from "@/i18n";
export type { ImageTaskRecord, ImageTaskResult } from "@/services/image-task-records";

const queries = new Map<string, Promise<ImageTaskRecord>>();
export type StoredTaskImage = { id: string; dataUrl: string; storageKey: string; width: number; height: number; bytes: number; mimeType: string };
const imageReads = new Map<string, Promise<StoredTaskImage[]>>();
onSessionEnd(() => { queries.clear(); imageReads.clear(); });

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
            const finish = startGenerationRequest();
            let response: Response | undefined;
            let result;
            try {
                response = await canvasFetch(`/api/ai/v1/images/tasks_async/${encodeURIComponent(record.task_id)}`);
                result = await response.json();
                if (!response.ok) throw new Error(result.error?.message || `请求失败（${response.status}）`);
            } catch (error) {
                const lastQuery = finish(response?.headers.get("X-Request-Id"));
                if (epoch === sessionEpoch()) await updateImageTaskRecord(record.id, (latest) => latest.task_id === record.task_id ? { ...latest, value: { ...latest.value, lastQuery } } : latest).catch(() => {});
                throw error;
            }
            const lastQuery = finish(response.headers.get("X-Request-Id"));
            if (epoch !== sessionEpoch()) throw new Error("登录会话已改变");
            const seconds = Number(response.headers.get("Retry-After"));
            return updateImageTaskRecord(record.id, (latest) => {
                // A fresh list does not establish a write baseline. Another observer
                // may have completed or replaced this task while its query was in flight.
                if (latest.task_id !== record.task_id || !imageTaskPending(latest)) return latest;
                const retryAfter = Number.isFinite(seconds) && seconds > 0 ? seconds : latest.value.retryAfter;
                return { ...latest, status: result.status || latest.status, value: { ...latest.value, retryAfter, result, lastQuery } };
            });
        }
        return record;
    })().finally(() => {
        if (queries.get(key) === request) queries.delete(key);
    });
    queries.set(key, request);
    return request;
}

export function imageTaskImages(record: Pick<ImageTaskRecord, "id">): Promise<StoredTaskImage[]> {
    const key = `${sessionEpoch()}:${record.id}`;
    const pending = imageReads.get(key);
    if (pending) return pending;
    const request = storeTaskImages(record.id).finally(() => { if (imageReads.get(key) === request) imageReads.delete(key); });
    imageReads.set(key, request);
    return request;
}

async function storeTaskImages(recordId: string): Promise<StoredTaskImage[]> {
    const epoch = sessionEpoch();
    const detail = (await readImageTaskRecords())[recordId];
    if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
    if (!detail) throw new Error(i18n.t("taskCenter.recordRemoved"));
    const images = parseImagePayload(detail.value.result || {});
    const storedImages: StoredTaskImage[] = [];
    for (const [index, image] of images.entries()) {
        const current = (await readImageTaskRecords())[recordId];
        if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
        if (!current) throw new Error(i18n.t("taskCenter.recordRemoved"));
        const existing = current.value.localImages?.[index];
        let stored = existing ? await readStoredImage(existing) : await uploadImage(image.dataUrl);
        if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
        let storageKey = stored.storageKey!;
        if (!existing) await updateImageTaskRecord(recordId, (latest) => {
            if (latest.value.localImages?.[index]) { storageKey = latest.value.localImages[index]; return latest; }
            return { ...latest, value: { ...latest.value, localImages: { ...latest.value.localImages, [index]: storageKey }, mediaTimings: { ...latest.value.mediaTimings, [index]: stored.timings! } } };
        });
        if (storageKey !== stored.storageKey) stored = await readStoredImage(storageKey);
        if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
        storedImages.push({ id: image.id, dataUrl: fileUrl(storageKey), storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType });
    }
    // Cached reads do not write, but deletion or replacement during decoding must still win.
    const latest = (await readImageTaskRecords())[recordId];
    if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
    if (!latest) throw new Error(i18n.t("taskCenter.recordRemoved"));
    if (storedImages.some((image, index) => latest.value.localImages?.[index] !== image.storageKey)) throw new Error(i18n.t("taskCenter.recordChanged", { defaultValue: "任务记录已变化，请刷新后重新查看结果" }));
    return storedImages;
}
