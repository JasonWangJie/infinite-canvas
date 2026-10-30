import "./browser";
import { afterEach, beforeEach, expect, test } from "bun:test";
import i18n from "../src/i18n";
import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import axios, { type InternalAxiosRequestConfig } from "axios";
import { endCanvasSession, readCanvasSession } from "../src/services/api/canvas-client";
import { getDocumentSaveState, readDocument, stageDocument, writeDocument } from "../src/services/canvas-data";
import { loadTaskCenter, readTaskCenterDocument, resumeTaskCenterItem, taskCenterDiagnostics } from "../src/services/task-center";
import { defaultConfig, useConfigStore } from "../src/stores/use-config-store";
import type { GenerationLog } from "../src/pages/video/generation-log";
import { refreshImageTask, type ImageTaskRecord } from "../src/services/api/image-tasks";

const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
const session = { user: { id: "task-user", subject: `ics_${"b".repeat(32)}`, username: "tasks" }, csrf_token: "csrf", session_tag: "tasks-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
const config = {
    ...defaultConfig,
    model: "gateway::current-model",
    videoModel: "gateway::current-model",
    channels: [{ id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai" as const, models: ["original-model", "current-model"].map((name) => ({ name, capability: "video" as const, endpointTypes: ["openai-video"] })) }],
};
const videoLog: GenerationLog = {
    id: "video-1", title: "original video", prompt: "original prompt", model: "gateway::original-model", createdAt: 2000, time: "", durationMs: 0,
    config: { model: "gateway::original-model", videoModel: "gateway::original-model", size: "16:9", vquality: "720", videoSeconds: "5", videoGenerateAudio: "true", videoWatermark: "false", videoMode: "frames" },
    references: [], size: "1280x720", resolution: "720", seconds: "5", status: "paused", task: { id: "original-task", provider: "openai", model: "gateway::original-model" }, error: "temporary failure",
};
let documents: Record<string, { value: unknown; revision: number }>;
let localDocuments: ReturnType<typeof mockBrowserDocuments>;
let localFiles: ReturnType<typeof mockBrowserFiles>;
let requests: string[];
let route: (path: string, init?: RequestInit) => Promise<Response>;

function canvas(title: string) {
    return { state: { projects: [{ id: "project/one", title, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", nodes: [
        { id: "upload", type: "image", title: "upload", metadata: { status: "success", storageKey: "image:upload", content: "/api/files/upload" } },
        { id: "generated/one", type: "image", title: "generated", metadata: { status: "success", generationType: "generation", model: "image-model", prompt: "canvas prompt", images: [{ id: "a", status: "success" }, { id: "b", status: "error", errorDetails: "one image failed" }] } },
        { id: "video", type: "video", title: "video", metadata: { status: "error", videoTaskId: "canvas-task", prompt: "video prompt", model: "video-model" } },
    ] }], deletedProjects: [] }, version: 0 };
}

beforeEach(async () => {
    endCanvasSession();
    localStorage.clear();
    localDocuments = mockBrowserDocuments();
    localFiles = mockBrowserFiles();
    requests = [];
    documents = {
        "image-tasks": { value: { "async/1": { id: "async/1", task_id: "asyncimg_1", status: "pending", created_at: 3, value: { model: "image-model" } } }, revision: 1 },
        canvas: { value: canvas("remote canvas"), revision: 1 },
        "image-workbench": { value: { "image-1": { id: "image-1", title: "finished image", prompt: "same prompt", model: "image-model", createdAt: 3000, status: "success", images: [{ storageKey: "image:one" }] } }, revision: 1 },
        "video-workbench": { value: { [videoLog.id]: structuredClone(videoLog) }, revision: 1 },
    };
    route = async (path, init) => {
        if (path === "/api/session") return Response.json(session);
        if (path.startsWith("/api/data/")) {
            const domain = decodeURIComponent(path.slice("/api/data/".length));
            const current = documents[domain] || { value: null, revision: 0 };
            if (init?.method === "PUT") {
                const body = JSON.parse(String(init.body));
                if (body.revision !== current.revision) return Response.json({ error: { message: "conflict" } }, { status: 409 });
                documents[domain] = { value: body.value, revision: current.revision + 1 };
            }
            return Response.json(documents[domain] || current);
        }
        if (path.startsWith("/api/ai/v1/images/tasks_async/")) return Response.json({ status: "succeeded", data: [{ url: "/api/result-media/original" }] });
        if (path === "/api/files" && init?.method === "POST") return Response.json({ id: "stored-video", storageKey: "media:video", url: "/api/files/media%3Avideo", mimeType: "video/mp4", bytes: 5 });
        throw new Error(`Unexpected request: ${init?.method || "GET"} ${path}`);
    };
    globalThis.fetch = (async (input, init) => {
        requests.push(`${init?.method || "GET"} ${String(input)}`);
        return route(String(input), init);
    }) as typeof fetch;
    await readCanvasSession();
    useConfigStore.setState({ config });
    await readDocument("config");
    requests = [];
});

afterEach(() => {
    endCanvasSession();
    localDocuments.restore();
    localFiles.restore();
    globalThis.fetch = originalFetch;
    axios.defaults.adapter = originalAdapter;
});

test("the task center joins independent sources and excludes plain uploads", async () => {
    const snapshot = await loadTaskCenter();
    expect(snapshot.errors).toEqual({});
    expect(snapshot.items).toHaveLength(5);
    expect(snapshot.items.map((item) => item.source)).toEqual(["canvas", "canvas", "image-workbench", "image-tasks", "video-workbench"]);
    expect(snapshot.items.find((item) => item.id === "image-task:async/1")).toMatchObject({ status: "active", createdAt: 3000, taskId: "asyncimg_1", canResume: true, href: "/image?task=async%2F1" });
    expect(snapshot.items.find((item) => item.nodeId === "generated/one")).toMatchObject({ status: "attention", canResume: false, error: "one image failed", href: "/canvas/project%2Fone?focusNode=generated%2Fone" });
    expect(snapshot.items.find((item) => item.id === "video-log:video-1")).toMatchObject({ status: "attention", prompt: "original prompt", model: "gateway::original-model", canResume: true });
    expect(snapshot.items.some((item) => item.nodeId === "upload")).toBe(false);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
});

test("unconfirmed video submissions from both workbench and canvas require attention without resubmission", async () => {
    documents["video-workbench"].value = { [videoLog.id]: { ...videoLog, status: "unknown", task: undefined, error: i18n.t("managed.imageTaskUnknown") } };
    documents.canvas.value = { state: { projects: [{ ...canvas("unknown video").state.projects[0], nodes: [
        { id: "unconfirmed", type: "video", title: "unconfirmed", metadata: { status: "error", videoSubmissionUnknown: true } },
    ] }], deletedProjects: [] }, version: 0 };
    const snapshot = await loadTaskCenter();
    const items = snapshot.items.filter((item) => item.kind === "video");
    expect(items).toHaveLength(2);
    requests = [];
    for (const item of items) {
        expect(item).toMatchObject({ status: "attention", canResume: false, error: i18n.t("managed.imageTaskUnknown") });
        expect(await resumeTaskCenterItem(item)).toBe(item);
    }
    expect(requests).toEqual([]);
});

test("canvas image recovery stays actionable and preserves each original local task association", async () => {
    documents.canvas.value = { state: { projects: [{ ...canvas("image recovery").state.projects[0], nodes: [
        { id: "single", type: "image", title: "single", metadata: { status: "error", imageTaskRecordId: "single/record" } },
        { id: "batch", type: "image", title: "batch", metadata: { status: "error", imageTaskRecordId: "first", images: [
            { id: "a", status: "error", imageTaskRecordId: "first" },
            { id: "b", status: "error", imageTaskRecordId: "second" },
        ] } },
    ] }], deletedProjects: [] }, version: 0 };
    const items = (await loadTaskCenter()).items.filter((item) => item.source === "canvas");
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.nodeId === "single")).toMatchObject({ status: "attention", canResume: false, recordId: "single", imageTaskRecordIds: ["single/record"] });
    expect(items.find((item) => item.nodeId === "batch")).toMatchObject({ status: "attention", canResume: false, imageTaskRecordIds: ["first", "second"] });
    requests = [];
    for (const item of items) expect(await resumeTaskCenterItem(item)).toBe(item);
    expect(requests).toEqual([]);
});

test("diagnostics contain only task metadata and exclude private records, errors, credentials and media", async () => {
    const items = (await loadTaskCenter()).items;
    for (const item of items) {
        const diagnostic = JSON.parse(taskCenterDiagnostics({ ...item, title: "private title", prompt: "private prompt", error: "Bearer private-token https://private.example", summary: "private summary", href: "https://private.example", imageTaskRecordIds: ["linked-image"] }));
        expect(diagnostic).toEqual({
            source: item.source, kind: item.kind, status: item.status, recordId: item.recordId,
            ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.projectId ? { projectId: item.projectId } : {}), ...(item.nodeId ? { nodeId: item.nodeId } : {}), imageTaskRecordIds: ["linked-image"],
        });
        expect(JSON.stringify(diagnostic)).not.toContain("private");
    }
    expect(items.every((item) => Boolean(item.recordId))).toBe(true);
});

test("synchronous image batches retain progress and partial outcomes without offering resubmission", async () => {
    const result = { data: [{ url: "/api/result-media/retained" }] };
    const records: ImageTaskRecord[] = [
        { id: "running", task_id: null, status: "running", value: { result, batch: { total: 3, completed: 1, failed: 0, unknown: 0 } } },
        { id: "partial", task_id: null, status: "partial", value: { result: { ...result, error_message: "one rejected; one response lost" }, batch: { total: 3, completed: 3, failed: 1, unknown: 1 } } },
        { id: "saved", task_id: null, status: "succeeded", value: { result, batch: { total: 2, completed: 2, failed: 0, unknown: 0 } } },
        { id: "failed", task_id: null, status: "failed", value: { batch: { total: 2, completed: 2, failed: 2, unknown: 0 } } },
        { id: "unknown", task_id: null, status: "execution_unknown", value: { batch: { total: 2, completed: 2, failed: 0, unknown: 2 } } },
        { id: "unsaved", task_id: null, status: "storage_failed", value: { result, batch: { total: 2, completed: 2, failed: 0, unknown: 0 } } },
    ];
    documents["image-tasks"].value = Object.fromEntries(records.map((record) => [record.id, record]));
    const items = (await loadTaskCenter()).items.filter((item) => item.source === "image-tasks");
    expect(Object.fromEntries(items.map((item) => [item.imageTask!.id, item.status]))).toEqual({ running: "attention", partial: "attention", saved: "completed", failed: "failed", unknown: "attention", unsaved: "attention" });
    expect(items.find((item) => item.imageTask!.id === "running")?.summary).toContain(i18n.t("managed.imageBatchIncompleteNotice"));
    const partial = items.find((item) => item.imageTask!.id === "partial")!;
    expect(partial.summary).toContain(i18n.t("managed.imageBatchSummary", records[1].value.batch));
    expect(partial.summary).toContain(i18n.t("managed.imageBatchPartialNotice", records[1].value.batch));
    expect(partial.error).toBe("one rejected; one response lost");
    requests = [];
    for (const item of items.filter((entry) => entry.recordId !== "unsaved")) {
        expect(item.canResume).toBe(false);
        expect(await resumeTaskCenterItem(item)).toBe(item);
    }
    expect(requests).toEqual([]);
    const unsaved = items.find((entry) => entry.recordId === "unsaved")!;
    expect(unsaved).toMatchObject({ canResume: true, resumeAction: "save" });
    expect((await resumeTaskCenterItem(unsaved)).status).toBe("completed");
    expect(requests.every((request) => request.endsWith(" /api/data/image-tasks"))).toBe(true);
});

test("refresh reads remote changes without advancing a cached editor revision", async () => {
    const baseline = await readDocument("canvas");
    documents.canvas = { value: canvas("other tab"), revision: 2 };
    const snapshot = await loadTaskCenter();
    expect(snapshot.items.find((item) => item.source === "canvas")?.title).toContain("other tab");
    expect(await readDocument("canvas")).toEqual(baseline);
    await expect(writeDocument("canvas", canvas("local edit"))).rejects.toThrow("conflict");
    expect(documents.canvas.value).toEqual(canvas("other tab"));
    expect(getDocumentSaveState("canvas").status).toBe("conflict");
    expect((await loadTaskCenter()).items.find((item) => item.source === "canvas")?.title).toContain("local edit");
});

test("a draft made while a read is in flight takes priority over the response", async () => {
    await readDocument("canvas");
    const baseRoute = route;
    let finish!: (response: Response) => void;
    route = async (path, init) => path === "/api/data/canvas" ? new Promise<Response>((resolve) => { finish = resolve; }) : baseRoute(path, init);
    const reading = readTaskCenterDocument("canvas");
    stageDocument("canvas", canvas("unsaved latest"));
    finish(Response.json({ value: canvas("stale response"), revision: 4 }));
    expect(await reading).toEqual(canvas("unsaved latest"));
    expect(await readDocument("canvas")).toEqual(canvas("unsaved latest"));
    expect(getDocumentSaveState("canvas").status).toBe("pending");
});

test("a failing or malformed source does not hide the other task sources", async () => {
    const baseRoute = route;
    route = async (path, init) => path === "/api/data/video-workbench" ? Response.json({ error: { message: "video unavailable" } }, { status: 503 }) : baseRoute(path, init);
    documents.canvas.value = { broken: true };
    const snapshot = await loadTaskCenter();
    expect(snapshot.errors["video-workbench"]).toBe("video unavailable");
    expect(snapshot.errors.canvas).toBeDefined();
    expect(snapshot.items.map((item) => item.source).sort()).toEqual(["image-tasks", "image-workbench"]);
});

test("a late snapshot and an old task handle are rejected after the session changes", async () => {
    const item = (await loadTaskCenter()).items.find((entry) => entry.canResume)!;
    let finish!: (response: Response) => void;
    const baseRoute = route;
    route = async (path, init) => path === "/api/data/image-tasks" ? new Promise<Response>((resolve) => { finish = resolve; }) : baseRoute(path, init);
    const reading = loadTaskCenter();
    endCanvasSession();
    finish(Response.json(documents["image-tasks"]));
    await expect(reading).rejects.toThrow();
    await readCanvasSession();
    const requestCount = requests.length;
    await expect(resumeTaskCenterItem(item)).rejects.toThrow();
    expect(requests).toHaveLength(requestCount);
});

test("image recovery queries the original task and retries a retained local result without generating again", async () => {
    const snapshot = await loadTaskCenter();
    requests = [];
    const task = snapshot.items.find((item) => item.source === "image-tasks")!;
    expect((await resumeTaskCenterItem(task)).status).toBe("completed");
    expect(requests.filter((request) => request.includes("/api/ai/"))).toEqual(["GET /api/ai/v1/images/tasks_async/asyncimg_1"]);
    expect((documents["image-tasks"].value as Record<string, ImageTaskRecord>)["async/1"].value.result?.data).toEqual([{ url: "/api/result-media/original" }]);
    const canvasItem = snapshot.items.find((item) => item.source === "canvas")!;
    const count = requests.length;
    expect(await resumeTaskCenterItem(canvasItem)).toBe(canvasItem);
    expect(requests).toHaveLength(count);
    const retained: ImageTaskRecord = { id: "stored-result", task_id: null, status: "storage_failed", value: { model: "image-model", result: { data: [{ url: "/api/result-media/retained" }] } } };
    const baseRoute = route;
    let failSave = true;
    route = async (path, init) => path === "/api/data/image-tasks" && init?.method === "PUT" && failSave
        ? Response.json({ error: { message: "local save unavailable" } }, { status: 503 }) : baseRoute(path, init);
    await expect(writeDocument("image-tasks", (value: unknown) => ({ ...(value as object), [retained.id]: retained }))).rejects.toThrow("local save unavailable");
    expect(getDocumentSaveState("image-tasks").status).toBe("error");
    failSave = false;
    requests = [];
    const recovered = await Promise.all([refreshImageTask(retained), refreshImageTask(retained)]);
    const saved = { ...retained, status: "succeeded" };
    expect(recovered).toEqual([saved, saved]);
    expect((documents["image-tasks"].value as Record<string, ImageTaskRecord>)[retained.id]).toEqual(saved);
    expect(getDocumentSaveState("image-tasks").status).toBe("saved");
    expect(requests.filter((request) => request.startsWith("PUT "))).toEqual(["PUT /api/data/image-tasks", "PUT /api/data/image-tasks"]);
    expect(requests.every((request) => request.endsWith(" /api/data/image-tasks"))).toBe(true);
});

test("video recovery keeps the original task and never creates a model request", async () => {
    const polled: string[] = [];
    axios.defaults.adapter = async (request: InternalAxiosRequestConfig) => {
        polled.push(`${request.method} ${request.url}`);
        return { config: request, status: 200, statusText: "OK", headers: {}, data: request.url?.endsWith("/content") ? new Blob(["video"], { type: "application/octet-stream" }) : { id: "original-task", status: "completed" } };
    };
    const item = (await loadTaskCenter()).items.find((entry) => entry.source === "video-workbench")!;
    const completed = await resumeTaskCenterItem(item);
    expect(completed.status).toBe("completed");
    expect(completed.model).toBe("gateway::original-model");
    expect(completed.videoLog?.config).toEqual(videoLog.config);
    expect(completed.videoLog?.video?.storageKey).toBe("media:video");
    expect(polled).toEqual(["get /api/ai/v1/videos/original-task", "get /api/ai/v1/videos/original-task/content"]);
    expect(requests.filter((request) => request.startsWith("POST "))).toEqual(["POST /api/files"]);
});

test("a task removed from video history cannot be recreated by a stale resume button", async () => {
    const item = (await loadTaskCenter()).items.find((entry) => entry.source === "video-workbench")!;
    documents["video-workbench"] = { value: {}, revision: 2 };
    requests = [];
    await expect(resumeTaskCenterItem(item)).rejects.toThrow();
    expect(requests).toEqual(["GET /api/data/video-workbench"]);
    expect(documents["video-workbench"].value).toEqual({});
});

test("explicit image record IDs group requests under their history without hiding attention or guessing duplicates", async () => {
    const logs = documents["image-workbench"].value as Record<string, object>;
    logs["image-1"] = { ...logs["image-1"], status: "attention", recoverableCount: 1, requestCount: 2, imageTaskRecordIds: ["async/1", "async/1", "missing"] };
    const records = documents["image-tasks"].value as Record<string, ImageTaskRecord>;
    records["async/1"] = { ...records["async/1"], status: "succeeded", value: { model: "image-model", result: { data: [{ url: "/api/result-media/original" }] } } };
    records.unrelated = { ...records["async/1"], id: "unrelated" };
    const snapshot = await loadTaskCenter();
    const parent = snapshot.items.find((entry) => entry.source === "image-workbench")!;
    expect(parent.status).toBe("attention");
    expect(parent.relatedTasks?.map((entry) => entry.recordId)).toEqual(["async/1"]);
    expect(parent.relatedTasks?.[0].status).toBe("completed");
    expect(parent.imageTaskRecordIds).toEqual(["async/1", "missing"]);
    expect(snapshot.items.filter((entry) => entry.source === "image-tasks").map((entry) => entry.recordId)).toEqual(["unrelated"]);
    expect(parent.summary).toContain("2");
    expect(JSON.parse(taskCenterDiagnostics(parent)).relatedTasks[0].recordId).toBe("async/1");
});

test("a missing history source keeps its original image requests independently recoverable", async () => {
    const baseRoute = route;
    route = async (path, init) => path === "/api/data/image-workbench" ? Response.json({ error: { message: "history unavailable" } }, { status: 503 }) : baseRoute(path, init);
    const snapshot = await loadTaskCenter();
    expect(snapshot.errors["image-workbench"]).toBe("history unavailable");
    expect(snapshot.items.find((entry) => entry.recordId === "async/1")).toMatchObject({ source: "image-tasks", canResume: true, resumeAction: "query" });
});

test("completed canvas requests keep their source and generation time without old failures changing the current result", async () => {
    const project = canvas("source canvas");
    project.state.projects[0].nodes[1].metadata.images = [{ id: "a", status: "success" }];
    documents.canvas.value = project;
    const source = { kind: "canvas" as const, canvasId: "project/one", nodeId: "generated/one" };
    documents["image-tasks"].value = {
        previous: { id: "previous", task_id: "old", status: "failed", created_at: 2, value: { source } },
        latest: { id: "latest", task_id: "new", status: "succeeded", created_at: 4, value: { source, result: { data: [{ url: "/api/result-media/new" }] } } },
    };
    const result = await loadTaskCenter();
    const parent = result.items.find((item) => item.nodeId === "generated/one")!;
    expect(parent).toMatchObject({ status: "completed", createdAt: 4000 });
    expect(parent.relatedTasks?.map((item) => item.recordId).sort()).toEqual(["latest", "previous"]);
    expect(result.items.filter((item) => item.source === "image-tasks")).toEqual([]);
    expect(parent.relatedTasks?.every((item) => item.projectId === "project/one" && item.nodeId === "generated/one")).toBe(true);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
});

test("an accepted canvas task is processing while received but uncommitted output still needs recovery", async () => {
    const project = canvas("pending canvas");
    project.state.projects[0].nodes = [{ id: "waiting", type: "image", title: "waiting", metadata: { status: "idle", imageTaskRecordId: "async/1" } }] as typeof project.state.projects[0].nodes;
    documents.canvas.value = project;
    let parent = (await loadTaskCenter()).items.find((item) => item.nodeId === "waiting")!;
    expect(parent.status).toBe("active");
    expect(parent.createdAt).toBe(3000);
    (documents["image-tasks"].value as Record<string, ImageTaskRecord>)["async/1"] = { id: "async/1", task_id: "asyncimg_1", status: "succeeded", created_at: 3, value: { result: { data: [{ url: "/api/result-media/received" }] } } };
    parent = (await loadTaskCenter()).items.find((item) => item.nodeId === "waiting")!;
    expect(parent.status).toBe("attention");
    expect(parent.relatedTasks?.[0].status).toBe("completed");
});

test("deleting a canvas source does not hide its independently recoverable image task", async () => {
    documents.canvas.value = { state: { projects: [], deletedProjects: [] }, version: 0 };
    const record = (documents["image-tasks"].value as Record<string, ImageTaskRecord>)["async/1"];
    record.value.source = { kind: "canvas", canvasId: "removed", nodeId: "removed-node" };
    const task = (await loadTaskCenter()).items.find((item) => item.recordId === "async/1")!;
    expect(task).toMatchObject({ source: "image-tasks", projectId: "removed", canResume: true, href: "/image?task=async%2F1" });
});

test("unknown records stay attention and local storage recovery never queries a paid task", async () => {
    documents["image-tasks"].value = {
        unknown: { id: "unknown", task_id: null, status: "execution_unknown", value: {} },
        known: { id: "known", task_id: "known-task", status: "execution_unknown", value: {} },
        storage: { id: "storage", task_id: "known-task", status: "storage_pending", value: {} },
    };
    const items = (await loadTaskCenter()).items.filter((entry) => entry.source === "image-tasks");
    expect(items.find((entry) => entry.recordId === "unknown")).toMatchObject({ status: "attention", canResume: false });
    expect(items.find((entry) => entry.recordId === "known")).toMatchObject({ status: "attention", canResume: true, resumeAction: "query" });
    const storage = items.find((entry) => entry.recordId === "storage")!;
    expect(storage).toMatchObject({ status: "attention", canResume: true, resumeAction: "save" });
    requests = [];
    expect(await resumeTaskCenterItem(storage)).toMatchObject({ status: "active", resumeAction: "query" });
    expect(requests.every((request) => request.endsWith(" /api/data/image-tasks"))).toBe(true);
});

test("diagnostics include only UUID request identifiers and finite timings, including related requests", async () => {
    const requestId = "62ae80c0-2c42-4ca1-8c5d-c43fe27a23a9";
    documents["image-tasks"].value = { original: {
        id: "original", task_id: null, status: "execution_unknown", value: {
            model: "private model", endpoint: "https://private.example", result: { error_message: "private error", data: [{ url: "private media" }] }, localImages: { 0: "image:private" },
            requests: [{ requestId, durationMs: 123.5, body: "private prompt" }, { requestId: "https://private.example/token", durationMs: 456 }, { requestId, durationMs: -1 }],
            lastQuery: { requestId, durationMs: 75, error: "private response" },
            mediaTimings: { 0: { readMediaMs: 25, decodeMs: 7, localSaveMs: 9, storageKey: "image:private" }, "image:private": { readMediaMs: 88 }, 1: { readMediaMs: -1, decodeMs: "private text" } },
        },
    } };
    const record = (await loadTaskCenter()).items.find((entry) => entry.recordId === "original")!;
    const diagnostic = JSON.parse(taskCenterDiagnostics(record));
    expect(diagnostic.requests).toEqual([{ requestId, durationMs: 123.5 }, { durationMs: 456 }]);
    expect(diagnostic.lastQuery).toEqual({ requestId, durationMs: 75 });
    expect(diagnostic.media).toEqual([{ index: 0, readMediaMs: 25, decodeMs: 7, localSaveMs: 9 }]);
    expect(JSON.stringify(diagnostic)).not.toContain("private");
});
