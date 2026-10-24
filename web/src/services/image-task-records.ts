import i18n from "@/i18n";
import { sessionEpoch } from "@/services/api/canvas-client";
import type { GenerationRequestMeasurement } from "@/services/generation-diagnostics";
import type { ImageStorageTimings } from "@/services/image-storage";
import { equalDocument, flushDocument, getDocumentBaseline, getDocumentDraft, getDocumentSaveState, readSavedDocument, resolveDocumentConflict, retryDocument, writeDocument } from "@/services/canvas-data";

export type ImageTaskResult = {
    status?: string;
    data?: Record<string, unknown>[];
    images?: Record<string, unknown>[];
    results?: Record<string, unknown>[];
    progress?: number;
    error_message?: string;
};
export type ImageTaskBatch = { total: number; completed: number; failed: number; unknown: number };
export type ImageTaskRecord = {
    id: string;
    task_id: string | null;
    status: string;
    created_at?: number;
    has_result?: boolean;
    value: { model?: string; endpoint?: string; retryAfter?: number; result?: ImageTaskResult; localImages?: Record<string, string>; batch?: ImageTaskBatch; requests?: GenerationRequestMeasurement[]; lastQuery?: GenerationRequestMeasurement; mediaTimings?: Record<string, ImageStorageTimings> };
};

function taskRecords(value: unknown): Record<string, ImageTaskRecord> {
    if (value == null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw new Error(i18n.t("taskCenter.invalidSource"));
    for (const [id, record] of Object.entries(value)) {
        if (!record || typeof record !== "object" || Array.isArray(record) || record.id !== id || typeof record.status !== "string"
            || (record.task_id !== null && typeof record.task_id !== "string") || !record.value || typeof record.value !== "object" || Array.isArray(record.value)) throw new Error(i18n.t("taskCenter.invalidSource"));
    }
    return value as Record<string, ImageTaskRecord>;
}

export async function readImageTaskRecords(): Promise<Record<string, ImageTaskRecord>> {
    const pending = () => ["pending", "saving", "error", "conflict"].includes(getDocumentSaveState("image-tasks").status) ? getDocumentDraft("image-tasks") : undefined;
    const value = pending() ?? await readSavedDocument("image-tasks");
    return taskRecords(pending() ?? value);
}

export async function saveImageTaskRecord(record: ImageTaskRecord, create = false) {
    taskRecords({ [record?.id]: record });
    await writeDocument("image-tasks", (value: unknown) => {
        const records = taskRecords(value);
        // A late query must not restore a task that the user removed.
        return create || records[record.id] ? { ...records, [record.id]: record } : records;
    });
}

export async function updateImageTaskRecord(id: string, update: (current: ImageTaskRecord) => ImageTaskRecord) {
    let adopted: ImageTaskRecord | undefined;
    await writeDocument("image-tasks", (value: unknown) => {
        const records = taskRecords(value);
        const current = records[id];
        if (!current) return records;
        const record = update(current);
        taskRecords({ [id]: record });
        adopted = record;
        return record === current ? records : { ...records, [id]: record };
    });
    // Throw outside the queued updater: a removed task must not strand a failing
    // update in the document's pending edits and block unrelated task recovery.
    if (!adopted) throw new Error(i18n.t("taskCenter.recordRemoved"));
    return adopted;
}

// Explicit recovery may combine independent tasks, never conflicting edits to the same task.
export async function recoverImageTaskRecords() {
    const epoch = sessionEpoch();
    if (getDocumentSaveState("image-tasks").status !== "conflict") {
        try {
            await retryDocument("image-tasks");
            if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
            await flushDocument("image-tasks");
        } catch (error) {
            if (epoch !== sessionEpoch()) throw error;
            if (getDocumentSaveState("image-tasks").status !== "conflict") throw error;
        }
    }
    if (getDocumentSaveState("image-tasks").status === "conflict") await resolveDocumentConflict("image-tasks", (remote, local) => {
        const [baseline, saved, draft] = [getDocumentBaseline("image-tasks"), remote, local].map((value) => taskRecords(JSON.parse(JSON.stringify(taskRecords(value)))));
        const ids = new Set([...Object.keys(baseline), ...Object.keys(saved), ...Object.keys(draft)]);
        return Object.fromEntries([...ids].flatMap((id) => {
            const [original, fromSaved, fromDraft] = [baseline, saved, draft].map((records) => Object.hasOwn(records, id) ? records[id] : undefined);
            let record: ImageTaskRecord | undefined;
            if (equalDocument(fromDraft, original) || equalDocument(fromDraft, fromSaved)) record = fromSaved;
            else if (equalDocument(fromSaved, original)) record = fromDraft;
            else throw new Error(i18n.t("saveRecovery.conflictDetected"));
            return record ? [[id, record]] : [];
        }));
    });
    if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
    await flushDocument("image-tasks");
    if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
    await writeDocument("image-tasks", (value: unknown) => Object.fromEntries(Object.entries(taskRecords(value)).map(([id, record]) => {
        if (!["storage_failed", "storage_pending"].includes(record.status)) return [id, record];
        const { batch, result } = record.value;
        const hasImages = Boolean(result?.data?.length || result?.images?.length || result?.results?.length);
        let status: string;
        if (batch) {
            if (batch.completed < batch.total) status = "running";
            else if (hasImages) status = batch.failed || batch.unknown ? "partial" : "succeeded";
            else if (batch.unknown) status = "execution_unknown";
            else status = batch.failed ? "failed" : "execution_unknown";
        } else if (hasImages) status = "succeeded";
        else status = record.task_id ? "pending" : "execution_unknown";
        return [id, { ...record, status }];
    })));
}
