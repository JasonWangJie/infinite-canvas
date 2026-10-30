import i18n from "@/i18n";
import { ImageGenerationUncertainError } from "@/services/api/image";
import { imageTaskHasResult, imageTaskImages, imageTaskPending, refreshImageTask } from "@/services/api/image-tasks";
import { readImageTaskRecords } from "@/services/image-task-records";
import { readStoredImage } from "@/services/image-storage";
import type { ImageTaskRecord } from "@/services/image-task-records";
import type { CanvasImageTaskState } from "@/types/canvas";

export function canvasImageTaskState(record: ImageTaskRecord): CanvasImageTaskState {
    if (imageTaskHasResult(record)) return "storage_failed";
    if (["failed", "cancelled", "canceled", "expired"].includes(record.status)) return "failed";
    return record.task_id && record.status !== "succeeded" ? "pending" : "unknown";
}

export class CanvasImageTaskPendingError extends ImageGenerationUncertainError {
    constructor() { super(i18n.t("managed.imageTaskSubmitted")); }
}

function waitForHint(seconds: number, signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
        const abort = () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
        const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, seconds * 1000);
        signal.addEventListener("abort", abort, { once: true });
    });
}

// Only queries a saved intent. Polling cadence comes exclusively from the gateway.
export async function readCanvasImageTask(recordId: string, signal: AbortSignal, assertCurrent: () => void, queryNow = false, followHints = true) {
    const check = () => { signal.throwIfAborted(); assertCurrent(); };
    check();
    let record = (await readImageTaskRecords())[recordId];
    check();
    if (!record) throw new Error(i18n.t("taskCenter.recordRemoved"));
    if (queryNow || imageTaskHasResult(record)) {
        record = await refreshImageTask(record);
        check();
    }
    while (!imageTaskHasResult(record)) {
        if (!imageTaskPending(record)) {
            if (!record.task_id && !["failed", "cancelled", "canceled", "expired"].includes(record.status)) throw new ImageGenerationUncertainError(i18n.t("managed.imageTaskUnknown"));
            throw new Error(record.value.result?.error_message || i18n.t("managed.taskFailed"));
        }
        const seconds = record.value.retryAfter;
        if (!followHints || !seconds || !Number.isFinite(seconds) || seconds <= 0) throw new CanvasImageTaskPendingError();
        await waitForHint(seconds, signal);
        check();
        record = await refreshImageTask(record);
        check();
    }
    await imageTaskImages(record);
    check();
    const key = (await readImageTaskRecords())[recordId]?.value.localImages?.[0];
    check();
    if (!key) throw new Error(i18n.t("taskCenter.recordRemoved"));
    const image = await readStoredImage(key);
    check();
    return { ...image, imageTaskRecordId: recordId };
}
