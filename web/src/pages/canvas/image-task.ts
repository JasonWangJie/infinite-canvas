import i18n from "@/i18n";
import { nanoid } from "nanoid";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { ImageGenerationUncertainError } from "@/services/api/image";
import { imageTaskHasResult, imageTaskImages, imageTaskPending, refreshImageTask } from "@/services/api/image-tasks";
import { readImageTaskRecords } from "@/services/image-task-records";
import { readStoredImage } from "@/services/image-storage";
import type { ImageTaskRecord } from "@/services/image-task-records";
import type { CanvasImageTaskState, CanvasNodeData, CanvasNodeImage } from "@/types/canvas";

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
    const stored = await imageTaskImages(record);
    check();
    const localImages = (await readImageTaskRecords())[recordId]?.value.localImages;
    check();
    const images: Awaited<ReturnType<typeof readStoredImage>>[] = [];
    for (const [index, result] of stored.entries()) {
        const key = localImages?.[index];
        if (!key || key !== result.storageKey) throw new Error(i18n.t("taskCenter.recordRemoved"));
        images.push(await readStoredImage(key));
        check();
    }
    return { ...images[0], images, imageTaskRecordId: recordId };
}

export function applyCanvasImageBatch(node: CanvasNodeData, images: Awaited<ReturnType<typeof readStoredImage>>[]): CanvasNodeData {
    if (!images.length) return node;
    const previous = node.metadata?.images || [];
    const used = new Set<string>();
    const slots: CanvasNodeImage[] = images.map((image, index) => {
        const matching = image.storageKey ? previous.find((slot) => slot.storageKey === image.storageKey && !used.has(slot.id)) : undefined;
        const placeholder = previous[index];
        const id = matching?.id || (placeholder && !placeholder.content && !used.has(placeholder.id) ? placeholder.id : nanoid());
        used.add(id);
        return { id, status: "success", content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
    });
    const primaryStorageKey = previous.find((slot) => slot.id === node.metadata?.primaryImageId)?.storageKey || node.metadata?.storageKey;
    const primaryIndex = Math.max(0, images.findIndex((image) => image.storageKey && image.storageKey === primaryStorageKey));
    const primary = images[primaryIndex];
    const edge = Math.max(node.width, node.height);
    const size = node.metadata?.freeResize ? { width: node.width, height: node.height } : fitNodeSize(primary.width, primary.height, edge, edge);
    return {
        ...node,
        ...size,
        position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
        metadata: { ...node.metadata, ...imageMetadata(primary), images: slots, primaryImageId: slots[primaryIndex].id, imageTaskRecordId: undefined, imageTaskState: undefined, errorDetails: undefined },
    };
}
