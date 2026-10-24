import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "./browser";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import i18n from "../src/i18n";
import { ImageTaskPanel } from "../src/pages/image/image-task-panel";
import { endCanvasSession, readCanvasSession, readPrivateBlob } from "../src/services/api/canvas-client";
import { getDocumentBaseline, getDocumentDraft, getDocumentSaveState, readDocument, retryDocument, writeDocument } from "../src/services/canvas-data";
import { uploadImage } from "../src/services/image-storage";
import { uploadMediaFile } from "../src/services/file-storage";
import { defaultConfig, useConfigStore, buildApiUrl } from "../src/stores/use-config-store";
import { ImageGenerationUncertainError, requestAsyncImageGeneration, requestEdit, requestGeneration } from "../src/services/api/image";
import { imageTaskHasResult, imageTaskImages, imageTaskPending, readImageTasks, refreshImageTask, type ImageTaskRecord } from "../src/services/api/image-tasks";
import { recoverImageTaskRecords, saveImageTaskRecord, updateImageTaskRecord, type ImageTaskBatch } from "../src/services/image-task-records";

const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
const config = {
    ...defaultConfig,
    model: "gateway::image-model",
    imageModel: "gateway::image-model",
    count: "2",
    size: "1024x1024",
    channels: [{ id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai" as const, models: [{ name: "image-model", capability: "image" as const, endpointTypes: ["image-generation"] }] }],
};
const session = { user: { id: 1, subject: `ics_${"a".repeat(32)}`, username: "test" }, csrf_token: "csrf", session_tag: "session", expires_at: Math.floor(Date.now() / 1000) + 60 };
const record: ImageTaskRecord = { id: "generation-1", task_id: "asyncimg_task1", status: "pending", value: { model: "image-model", retryAfter: 3 } };
let documents: Record<string, { value: unknown; revision: number }>;
let documentTransport: typeof fetch | undefined;
let browserDocuments: ReturnType<typeof mockBrowserDocuments>;
let browserFiles: ReturnType<typeof mockBrowserFiles>;
let fileWrites: string[];
let files: Map<string, Blob>;

function saveDocumentFixture(url: string | URL | Request, init?: RequestInit) {
    const domain = String(url).slice("/api/data/".length);
    const current = documents[domain] || { value: null, revision: 0 };
    if (init?.method !== "PUT") return Response.json(current);
    const body = JSON.parse(String(init.body));
    if (body.revision !== current.revision) return Response.json({ error: { message: "conflict" } }, { status: 409 });
    documents[domain] = { value: body.value, revision: current.revision + 1 };
    return Response.json(documents[domain]);
}
function seedTasks(records: ImageTaskRecord[]) {
    documents["image-tasks"] = { value: Object.fromEntries(records.map((entry) => [entry.id, entry])), revision: 1 };
}

function geminiBatchFixture(count: number) {
    const ready = Promise.withResolvers<void>();
    const pending: Array<{ request: InternalAxiosRequestConfig; resolve: (urls: string[]) => void; reject: (error: unknown) => void }> = [];
    const batchConfig = { ...config, count: String(count), channels: [{ ...config.channels[0], apiFormat: "gemini" as const, models: [{ ...config.channels[0].models[0], endpointTypes: ["gemini"] }] }] };
    useConfigStore.setState({ config: batchConfig });
    axios.defaults.adapter = async (request) => {
        const response = Promise.withResolvers<string[]>();
        pending.push({ request, resolve: response.resolve, reject: response.reject });
        if (pending.length === count) ready.resolve();
        const urls = await response.promise;
        return { config: request, data: { candidates: [{ content: { parts: urls.map((url) => ({ fileData: { fileUri: url } })) } }] }, status: 200, statusText: "OK", headers: {} };
    };
    return { config: batchConfig, pending, ready: ready.promise };
}

function rejectedGeminiRequest(request: InternalAxiosRequestConfig) {
    return new AxiosError("provider rejected", "ERR_BAD_RESPONSE", request, undefined, { config: request, status: 400, statusText: "Error", headers: {}, data: { error: { code: "INVALID_REQUEST", message: "provider rejected" } } });
}

beforeEach(async () => {
    endCanvasSession();
    localStorage.clear();
    useConfigStore.setState({ config });
    documents = {};
    documentTransport = undefined;
    files = new Map();
    fileWrites = [];
    browserDocuments = mockBrowserDocuments((async (url, init) => documentTransport ? documentTransport(url, init) : saveDocumentFixture(url, init)) as typeof fetch);
    browserFiles = mockBrowserFiles((async (url, init) => {
        if (init?.method === "POST") {
            const body = init.body as FormData;
            const blob = body.get("file") as Blob;
            const key = `${String(body.get("kind"))}:file-${fileWrites.length + 1}`;
            files.set(key, blob);
            fileWrites.push(key);
            return Response.json({ id: key, storageKey: key, url: `blob:mock-${fileWrites.length}`, bytes: blob.size, mimeType: blob.type });
        }
        const key = decodeURIComponent(String(url).slice("/api/files/".length));
        return files.has(key) ? new Response(files.get(key)) : new Response("missing", { status: 404 });
    }) as typeof fetch);
    Object.defineProperty(globalThis, "Image", { configurable: true, value: class { src = ""; naturalWidth = 1; naturalHeight = 1; async decode() {} } });
    globalThis.fetch = (async () => Response.json(session)) as typeof fetch;
    await readCanvasSession();
});
afterEach(() => {
    endCanvasSession();
    browserDocuments.restore();
    browserFiles.restore();
    globalThis.fetch = originalFetch;
    axios.defaults.adapter = originalAdapter;
    if (originalImage) Object.defineProperty(globalThis, "Image", originalImage);
    else Reflect.deleteProperty(globalThis, "Image");
});

test("media still decoding or reading after an account switch is never uploaded under the new account", async () => {
    const previousImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
    let finishDecode!: () => void;
    let decoding!: () => void;
    const started = new Promise<void>((resolve) => {
        decoding = resolve;
    });
    Object.defineProperty(globalThis, "Image", {
        configurable: true,
        value: class {
            src = "";
            naturalWidth = 1;
            naturalHeight = 1;
            decode() {
                decoding();
                return new Promise<void>((resolve) => {
                    finishDecode = resolve;
                });
            }
        },
    });
    const uploaded: string[] = [];
    try {
        globalThis.fetch = (async (url, init) => {
            if (init?.method === "POST") uploaded.push(String(url));
            return Response.json(session);
        }) as typeof fetch;
        const image = uploadImage(new Blob(["image"], { type: "image/png" }));
        await started;
        endCanvasSession();
        await readCanvasSession();
        finishDecode();
        await expect(image).rejects.toThrow("登录会话已改变");

        let body!: ReadableStreamDefaultController<Uint8Array>;
        let read!: () => void;
        const reading = new Promise<void>((resolve) => {
            read = resolve;
        });
        globalThis.fetch = (async (url, init) => {
            if (init?.method === "POST") uploaded.push(String(url));
            if (String(url) === "/api/session") return Response.json(session);
            return new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        body = controller;
                        read();
                    },
                }),
            );
        }) as typeof fetch;
        const media = uploadMediaFile("/api/result-media/old");
        await reading;
        await Promise.resolve();
        endCanvasSession();
        await readCanvasSession();
        body.enqueue(new TextEncoder().encode("old-video"));
        body.close();
        await expect(media).rejects.toThrow("登录会话已改变");
        expect(uploaded).toEqual([]);
        expect(fileWrites).toEqual([]);
    } finally {
        if (previousImage) Object.defineProperty(globalThis, "Image", previousImage);
        else Reflect.deleteProperty(globalThis, "Image");
    }
});

test("async submit carries the bounded image parameters and one intent, then reload queries the original task only", async () => {
    const calls: { path: string; method: string }[] = [];
    globalThis.fetch = (async (url, init) => {
        const path = String(url);
        calls.push({ path, method: init?.method || "GET" });
        if (path.endsWith("/generations_async")) {
            expect((documents["image-tasks"].value as Record<string, ImageTaskRecord>)["stable-intent"]).toMatchObject({ id: "stable-intent", status: "submitting", task_id: null });
            expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("stable-intent");
            expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf");
            expect(JSON.parse(String(init?.body))).toMatchObject({ model: "image-model", prompt: "draw a tree", n: 2, size: "1024x1024" });
            return Response.json({ task_id: record.task_id }, { status: 202 });
        }
        return Response.json({ status: "execution_unknown", error_message: "Still reconciling" }, { headers: { "Retry-After": "7" } });
    }) as typeof fetch;
    expect(await requestAsyncImageGeneration(config, "draw a tree", [], "stable-intent")).toBe(record.task_id!);
    const [restored] = await readImageTasks();
    expect(restored.id).toBe("stable-intent");
    expect(restored.task_id).toBe(record.task_id!);
    const first = refreshImageTask(restored);
    const second = refreshImageTask(restored);
    expect(first).toBe(second);
    const pending = await first;
    expect(imageTaskPending(pending)).toBe(true);
    expect(imageTaskHasResult(pending)).toBe(false);
    expect(pending.value.retryAfter).toBe(7);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.path.includes("tasks_async"))).toHaveLength(1);
});

test("transient polling failure and storage recovery never submit a replacement task", async () => {
    seedTasks([record]);
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
        calls.push(String(url));
        return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
    }) as typeof fetch;
    await expect(refreshImageTask(record)).rejects.toThrow("temporarily unavailable");
    expect(record.task_id).toBe("asyncimg_task1");
    const stored = { ...record, task_id: null, status: "storage_failed", value: { ...record.value, result: { data: [{ url: "/api/result-media/recovered" }] } } };
    await writeDocument("image-tasks", { [stored.id]: stored });
    globalThis.fetch = (async (url) => {
        calls.push(String(url));
        throw new Error("A saved result must not be regenerated or queried");
    }) as typeof fetch;
    const recovered = await refreshImageTask(stored);
    expect(imageTaskHasResult(recovered)).toBe(true);
    expect(recovered.status).toBe("succeeded");
    expect(calls).toEqual(["/api/ai/v1/images/tasks_async/asyncimg_task1"]);
});

test.each(["other-tab", "same-tab"])("a late image query preserves completed results and local files saved by %s", async (observer) => {
    seedTasks([record]);
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const calls: string[] = [];
    globalThis.fetch = (async (url, init) => {
        calls.push(`${init?.method || "GET"} ${url}`);
        started.resolve();
        return response.promise;
    }) as typeof fetch;
    const querying = refreshImageTask(record);
    await started.promise;
    expect(getDocumentBaseline("image-tasks")).toBeUndefined();
    const completed: ImageTaskRecord = { ...record, status: "succeeded", value: { ...record.value, result: { data: [{ url: "/api/result-media/complete" }] }, localImages: { 0: "image:existing" } } };
    if (observer === "same-tab") await writeDocument("image-tasks", { [record.id]: completed });
    else documents["image-tasks"] = { revision: 2, value: { [record.id]: completed } };
    const saved = structuredClone(documents["image-tasks"]);
    response.resolve(Response.json({ status: "running", progress: 10 }));
    expect(await querying).toEqual(completed);
    expect(documents["image-tasks"]).toEqual(saved);
    expect(getDocumentSaveState("image-tasks").status).toBe("saved");
    expect(calls).toEqual(["GET /api/ai/v1/images/tasks_async/asyncimg_task1"]);
    expect(fileWrites).toEqual([]);
});

test.each(["deleted", "replaced", "failed"])("a query finishing after its task was %s cannot restore the old task or poison later saves", async (change) => {
    seedTasks([record]);
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const calls: string[] = [];
    globalThis.fetch = (async (url, init) => {
        calls.push(`${init?.method || "GET"} ${url}`);
        started.resolve();
        return response.promise;
    }) as typeof fetch;
    const querying = refreshImageTask(record);
    await started.promise;
    const latest = change === "replaced" ? { ...record, task_id: "asyncimg_replacement" } : { ...record, status: "failed" };
    documents["image-tasks"] = { revision: 2, value: change === "deleted" ? {} : { [record.id]: latest } };
    const saved = structuredClone(documents["image-tasks"]);
    response.resolve(Response.json({ status: "succeeded", data: [{ url: "/api/result-media/old-task" }] }));
    if (change === "deleted") await expect(querying).rejects.toThrow(i18n.t("taskCenter.recordRemoved"));
    else expect(await querying).toEqual(latest);
    expect(documents["image-tasks"]).toEqual(saved);
    expect(getDocumentSaveState("image-tasks").status).toBe("saved");
    const next = { ...record, id: "another-task", task_id: "asyncimg_another" };
    await saveImageTaskRecord(next, true);
    expect((documents["image-tasks"].value as Record<string, ImageTaskRecord>)[next.id]).toEqual(next);
    expect(calls).toEqual(["GET /api/ai/v1/images/tasks_async/asyncimg_task1"]);
});

test("failed queries keep the task pending and preserve their original error even if diagnostic saving fails", async () => {
    seedTasks([record]);
    let queries = 0;
    const ids = ["77e196e8-ab33-4c90-a17a-3e11f9369a01", "77e196e8-ab33-4c90-a17a-3e11f9369a02"];
    globalThis.fetch = (async (_url, init) => {
        expect(init?.method || "GET").toBe("GET");
        return Response.json({ error: { message: "Query temporarily unavailable" } }, { status: 503, headers: { "X-Request-Id": ids[queries++] } });
    }) as typeof fetch;
    await expect(refreshImageTask(record)).rejects.toThrow("Query temporarily unavailable");
    const [saved] = await readImageTasks();
    expect(saved.status).toBe("pending");
    expect(saved.value.result).toBeUndefined();
    expect(saved.value.lastQuery).toEqual({ requestId: ids[0], durationMs: expect.any(Number) });
    const persisted = structuredClone(documents["image-tasks"]);
    documentTransport = (async (url, init) => init?.method === "PUT" ? Response.json({ error: { message: "Local storage unavailable" } }, { status: 503 }) : saveDocumentFixture(url, init)) as typeof fetch;
    await expect(refreshImageTask(record)).rejects.toThrow("Query temporarily unavailable");
    expect(documents["image-tasks"]).toEqual(persisted);
    const [draft] = await readImageTasks();
    expect(draft.status).toBe("pending");
    expect(draft.value.lastQuery).toEqual({ requestId: ids[1], durationMs: expect.any(Number) });
    expect(queries).toBe(2);
});

test("a query with an older cached write baseline retains CAS protection for another tab's completed result", async () => {
    seedTasks([record]);
    await readDocument("image-tasks");
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    globalThis.fetch = (async () => { started.resolve(); return response.promise; }) as typeof fetch;
    const querying = refreshImageTask(record);
    await started.promise;
    const completed = { ...record, status: "succeeded", value: { ...record.value, result: { data: [{ url: "/api/result-media/complete" }] }, localImages: { 0: "image:existing" } } };
    documents["image-tasks"] = { revision: 2, value: { [record.id]: completed } };
    response.resolve(Response.json({ status: "running", progress: 10 }));
    await expect(querying).rejects.toThrow("conflict");
    expect(documents["image-tasks"]).toEqual({ revision: 2, value: { [record.id]: completed } });
    expect(getDocumentBaseline("image-tasks")).toEqual({ [record.id]: record });
    expect(getDocumentSaveState("image-tasks").status).toBe("conflict");
});

test("uncertain async submission responses never retry the paid request", async () => {
    const cases = [
        {
            name: "network rejection",
            respond: () => {
                throw new TypeError("Connection interrupted");
            },
        },
        { name: "non-JSON response", respond: () => new Response("<html>upstream interrupted</html>", { status: 200 }) },
        { name: "202 without task identity", respond: () => Response.json({ status: "accepted" }, { status: 202 }) },
    ];
    for (const scenario of cases) {
        const calls: { path: string; method: string; intent: string | null }[] = [];
        globalThis.fetch = (async (url, init) => {
            calls.push({ path: String(url), method: init?.method || "GET", intent: new Headers(init?.headers).get("Idempotency-Key") });
            return scenario.respond();
        }) as typeof fetch;
        const intent = `intent-${scenario.name}`;
        await expect(requestAsyncImageGeneration(config, scenario.name, [], intent)).rejects.toBeInstanceOf(ImageGenerationUncertainError);
        await expect(requestAsyncImageGeneration(config, scenario.name, [], intent)).rejects.toBeInstanceOf(ImageGenerationUncertainError);
        expect(calls).toEqual([{ path: "/api/ai/v1/images/generations_async", method: "POST", intent }]);
        expect((await readImageTasks()).find((item) => item.id === intent)?.status).toBe("execution_unknown");
    }
});

test.each(["sync", "async"])("%s generation refuses the paid request when its intent cannot be saved", async (mode) => {
    let paid = 0;
    globalThis.fetch = (async () => { paid += 1; return Response.json({ task_id: record.task_id }, { status: 202 }); }) as typeof fetch;
    axios.defaults.adapter = async (request) => {
        paid += 1;
        return { config: request, data: { data: [{ b64_json: "aW1hZ2U=" }] }, status: 200, statusText: "OK", headers: {} };
    };
    documentTransport = (async (url, init) => init?.method === "PUT" ? Response.json({ error: { message: "local database unavailable" } }, { status: 503 }) : saveDocumentFixture(url, init)) as typeof fetch;
    const generation = mode === "sync" ? requestGeneration(config, "draw") : requestAsyncImageGeneration(config, "draw", [], "unsaved-intent");
    await expect(generation).rejects.toThrow("local database unavailable");
    expect(paid).toBe(0);
    expect(getDocumentSaveState("image-tasks").status).toBe("error");
    expect(Object.values(getDocumentDraft("image-tasks") as Record<string, ImageTaskRecord>)).toHaveLength(1);
});

test.each([
    ["generation", "network"], ["generation", "unknown"], ["generation", "rejected"],
    ["edit", "network"], ["edit", "unknown"], ["edit", "rejected"],
])("Gemini %s preserves the %s outcome without repeating its paid request", async (operation, outcome) => {
    const geminiConfig = { ...config, count: "1", channels: [{ ...config.channels[0], apiFormat: "gemini" as const, models: [{ ...config.channels[0].models[0], endpointTypes: ["gemini"] }] }] };
    useConfigStore.setState({ config: geminiConfig });
    const paid: string[] = [];
    axios.defaults.adapter = async (request) => {
        paid.push(`${request.method} ${request.url}`);
        const parts = JSON.parse(String(request.data)).contents[0].parts;
        expect(parts.some((part: { inlineData?: unknown }) => Boolean(part.inlineData))).toBe(operation === "edit");
        const response = outcome === "network" ? undefined : {
            config: request, status: outcome === "unknown" ? 502 : 400, statusText: "Error", headers: {},
            data: { error: { code: outcome === "unknown" ? "EXECUTION_UNKNOWN" : "INVALID_REQUEST", message: "generation response" } },
        };
        throw new AxiosError("request failed", outcome === "network" ? "ERR_NETWORK" : "ERR_BAD_RESPONSE", request, undefined, response);
    };
    const pending = operation === "edit"
        ? requestEdit(geminiConfig, "edit a tree", [{ id: "reference", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" }])
        : requestGeneration(geminiConfig, "draw a tree");
    const error = await pending.then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    if (outcome === "rejected") expect(error).not.toBeInstanceOf(ImageGenerationUncertainError);
    else expect(error).toBeInstanceOf(ImageGenerationUncertainError);
    expect(await readImageTasks()).toMatchObject([{ task_id: null, status: outcome === "rejected" ? "failed" : "execution_unknown" }]);
    expect(paid).toEqual(["post /api/ai/v1beta/models/image-model:generateContent"]);
    expect(fileWrites).toEqual([]);
});

test.each(["generation", "edit"])("Gemini batch %s saves completed responses before all siblings finish and returns partial results without resubmitting", async (operation) => {
    const fixture = geminiBatchFixture(3);
    const firstSaved = Promise.withResolvers<void>(), failedSaved = Promise.withResolvers<void>();
    documentTransport = (async (url, init) => {
        const response = saveDocumentFixture(url, init);
        if (String(url) === "/api/data/image-tasks" && init?.method === "PUT") {
            const [task] = Object.values(documents["image-tasks"].value as Record<string, ImageTaskRecord>);
            if (task.value.batch?.completed === 1) firstSaved.resolve();
            if (task.value.batch?.completed === 2) failedSaved.resolve();
        }
        return response;
    }) as typeof fetch;
    const warnings: ImageTaskBatch[] = [];
    const options = { onPartial: (batch: ImageTaskBatch) => { warnings.push(batch); } };
    let settled = false;
    const generating = (operation === "edit"
        ? requestEdit(fixture.config, "edit", [{ id: "reference", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" }], options)
        : requestGeneration(fixture.config, "draw", options)).then((images) => { settled = true; return images; });
    await fixture.ready;
    fixture.pending[1].resolve(["/api/result-media/second-a", "/api/result-media/second-b"]);
    await firstSaved.promise;
    expect(await readImageTasks()).toMatchObject([{ status: "running", value: { batch: { total: 3, completed: 1, failed: 0, unknown: 0 }, result: { data: [{ url: "/api/result-media/second-a" }, { url: "/api/result-media/second-b" }] } } }]);
    fixture.pending[0].reject(rejectedGeminiRequest(fixture.pending[0].request));
    await failedSaved.promise;
    expect(settled).toBe(false);
    expect(warnings).toEqual([]);
    fixture.pending[2].resolve(["/api/result-media/third"]);
    const images = await generating;
    expect(images.map((image) => image.dataUrl)).toEqual(["/api/result-media/second-a", "/api/result-media/second-b", "/api/result-media/third"]);
    expect(warnings).toEqual([{ total: 3, completed: 3, failed: 1, unknown: 0 }]);
    const [task] = await readImageTasks();
    expect(task.status).toBe("partial");
    expect(task.value.batch).toEqual(warnings[0]);
    expect(task.value.result?.data).toEqual(images.map((image) => ({ url: image.dataUrl })));
    expect(task.value.result?.error_message).toContain("#1:");
    expect(fixture.pending).toHaveLength(3);
});

test.each(["rejected", "unknown"])("a Gemini batch with only failed responses preserves its %s outcome", async (outcome) => {
    const fixture = geminiBatchFixture(2);
    const generating = requestGeneration(fixture.config, "draw").then(() => null, (error: unknown) => error);
    await fixture.ready;
    fixture.pending[0].reject(rejectedGeminiRequest(fixture.pending[0].request));
    fixture.pending[1].reject(outcome === "unknown" ? new AxiosError("connection lost", "ERR_NETWORK", fixture.pending[1].request) : rejectedGeminiRequest(fixture.pending[1].request));
    const error = await generating;
    expect(error).toBeInstanceOf(Error);
    if (outcome === "unknown") expect(error).toBeInstanceOf(ImageGenerationUncertainError);
    else expect(error).not.toBeInstanceOf(ImageGenerationUncertainError);
    expect(await readImageTasks()).toMatchObject([{ status: outcome === "unknown" ? "execution_unknown" : "failed", value: { batch: { total: 2, completed: 2, failed: outcome === "unknown" ? 1 : 2, unknown: outcome === "unknown" ? 1 : 0 }, result: { data: [] } } }]);
    expect(fixture.pending).toHaveLength(2);
});

test("a failed incremental save retains every later Gemini response and explicit recovery never generates again", async () => {
    const fixture = geminiBatchFixture(3);
    const saveFailed = Promise.withResolvers<void>();
    documentTransport = (async (url, init) => {
        if (String(url) === "/api/data/image-tasks" && init?.method === "PUT") {
            const [task] = Object.values(JSON.parse(String(init.body)).value) as ImageTaskRecord[];
            if (task.value.batch) {
                saveFailed.resolve();
                return Response.json({ error: { message: "local quota exhausted" } }, { status: 503 });
            }
        }
        return saveDocumentFixture(url, init);
    }) as typeof fetch;
    const warnings: ImageTaskBatch[] = [];
    const generating = requestGeneration(fixture.config, "draw", { onPartial: (batch) => { warnings.push(batch); } }).then(() => null, (error: unknown) => error);
    await fixture.ready;
    fixture.pending[0].resolve(["/api/result-media/one"]);
    await saveFailed.promise;
    fixture.pending[2].resolve(["/api/result-media/three"]);
    fixture.pending[1].resolve(["/api/result-media/two"]);
    expect(await generating).toBeInstanceOf(ImageGenerationUncertainError);
    const [draft] = Object.values(getDocumentDraft("image-tasks") as Record<string, ImageTaskRecord>);
    expect(draft.status).toBe("storage_failed");
    expect(draft.value.batch).toEqual({ total: 3, completed: 3, failed: 0, unknown: 0 });
    expect(draft.value.result?.data).toEqual([{ url: "/api/result-media/one" }, { url: "/api/result-media/three" }, { url: "/api/result-media/two" }]);
    expect(warnings).toEqual([]);
    documentTransport = undefined;
    expect(await refreshImageTask(draft)).toEqual({ ...draft, status: "succeeded" });
    expect(getDocumentSaveState("image-tasks").status).toBe("saved");
    expect(await readImageTasks()).toEqual([{ ...draft, status: "succeeded" }]);
    expect(fixture.pending).toHaveLength(3);
});

test("a late Gemini sibling after session replacement cannot update the previous user's saved progress", async () => {
    const fixture = geminiBatchFixture(2);
    const firstSaved = Promise.withResolvers<void>();
    documentTransport = (async (url, init) => {
        const response = saveDocumentFixture(url, init);
        if (String(url) === "/api/data/image-tasks" && init?.method === "PUT") {
            const [task] = Object.values(documents["image-tasks"].value as Record<string, ImageTaskRecord>);
            if (task.value.batch?.completed === 1) firstSaved.resolve();
        }
        return response;
    }) as typeof fetch;
    const warnings: ImageTaskBatch[] = [];
    const generating = requestGeneration(fixture.config, "draw", { onPartial: (batch) => { warnings.push(batch); } }).then(() => null, (error: unknown) => error);
    await fixture.ready;
    fixture.pending[0].resolve(["/api/result-media/already-saved"]);
    await firstSaved.promise;
    // Wait for the completed append's save acknowledgement before ending its session.
    await readDocument("image-tasks");
    const saved = structuredClone(documents["image-tasks"]);
    endCanvasSession();
    await readCanvasSession();
    fixture.pending[1].resolve(["/api/result-media/late-private-result"]);
    expect(await generating).toBeInstanceOf(Error);
    expect(documents["image-tasks"]).toEqual(saved);
    expect(warnings).toEqual([]);
    expect(fixture.pending).toHaveLength(2);
});

test("viewing an early Gemini image cannot replace later results or change existing local image indices", async () => {
    const fixture = geminiBatchFixture(2);
    const firstSaved = Promise.withResolvers<void>();
    documentTransport = (async (url, init) => {
        const response = saveDocumentFixture(url, init);
        if (String(url) === "/api/data/image-tasks" && init?.method === "PUT") {
            const [task] = Object.values(documents["image-tasks"].value as Record<string, ImageTaskRecord>);
            if (task.value.batch?.completed === 1) firstSaved.resolve();
        }
        return response;
    }) as typeof fetch;
    const reading = Promise.withResolvers<void>(), finishMedia = Promise.withResolvers<Response>();
    const downloads: string[] = [];
    globalThis.fetch = (async (url) => {
        downloads.push(String(url));
        if (String(url) === "/api/result-media/first") { reading.resolve(); return finishMedia.promise; }
        return new Response("second image", { headers: { "Content-Type": "image/png" } });
    }) as typeof fetch;
    const generating = requestGeneration(fixture.config, "draw");
    await fixture.ready;
    fixture.pending[0].resolve(["/api/result-media/first"]);
    await firstSaved.promise;
    const [early] = await readImageTasks();
    const opening = imageTaskImages(early);
    await reading.promise;
    fixture.pending[1].resolve(["/api/result-media/second"]);
    await generating;
    finishMedia.resolve(new Response("first image", { headers: { "Content-Type": "image/png" } }));
    expect((await opening).map((image) => image.dataUrl)).toEqual(["local-file:image%3Afile-1"]);
    const [latest] = await readImageTasks();
    expect(latest.value.result?.data).toEqual([{ url: "/api/result-media/first" }, { url: "/api/result-media/second" }]);
    expect(latest.value.batch).toEqual({ total: 2, completed: 2, failed: 0, unknown: 0 });
    expect(latest.value.localImages).toEqual({ 0: "image:file-1" });
    expect((await imageTaskImages(latest)).map((image) => image.dataUrl)).toEqual(["local-file:image%3Afile-1", "local-file:image%3Afile-2"]);
    expect(downloads).toEqual(["/api/result-media/first", "/api/result-media/second"]);
    expect(fileWrites).toEqual(["image:file-1", "image:file-2"]);
});

test("updating a removed image task neither restores it nor blocks subsequent task saves", async () => {
    seedTasks([record]);
    await writeDocument("image-tasks", {});
    await expect(updateImageTaskRecord(record.id, (current) => ({ ...current, status: "succeeded" }))).rejects.toThrow(i18n.t("taskCenter.recordRemoved"));
    expect(getDocumentSaveState("image-tasks").status).toBe("saved");
    const next = { ...record, id: "next-task" };
    await saveImageTaskRecord(next, true);
    expect(await readImageTasks()).toEqual([next]);
});

test("concurrent result reads share local files and preserve image metadata and media timings", async () => {
    const ready = { ...record, status: "succeeded", value: { result: { data: [{ url: "/api/result-media/first" }, { url: "/api/result-media/second" }] } } };
    seedTasks([ready]);
    const downloads: string[] = [];
    globalThis.fetch = (async (url) => {
        downloads.push(String(url));
        return new Response("image", { headers: { "Content-Type": "image/png" } });
    }) as typeof fetch;
    const [first, second] = await Promise.all([imageTaskImages(ready), imageTaskImages(ready)]);
    expect(first).toEqual(second);
    expect(first.map((image) => image.storageKey)).toEqual(["image:file-1", "image:file-2"]);
    expect(first.every((image) => image.width > 0 && image.height > 0 && image.bytes > 0 && image.mimeType === "image/png")).toBe(true);
    await imageTaskImages(ready);
    expect(fileWrites).toEqual(["image:file-1", "image:file-2"]);
    expect(downloads).toHaveLength(2);
    const [saved] = await readImageTasks();
    expect(Object.keys(saved.value.mediaTimings || {})).toEqual(["0", "1"]);
    for (const timing of Object.values(saved.value.mediaTimings || {})) expect(Object.values(timing).every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
});

test("confirmed image task recovery restores generation outcomes without declaring empty results successful", async () => {
    const rows: Array<{ id: string; batch?: ImageTaskBatch; taskId?: string; images?: boolean; expected: string }> = [
        { id: "running", batch: { total: 3, completed: 1, failed: 0, unknown: 0 }, images: true, expected: "running" },
        { id: "partial", batch: { total: 3, completed: 3, failed: 1, unknown: 1 }, images: true, expected: "partial" },
        { id: "failed", batch: { total: 2, completed: 2, failed: 2, unknown: 0 }, expected: "failed" },
        { id: "unknown", batch: { total: 2, completed: 2, failed: 1, unknown: 1 }, expected: "execution_unknown" },
        { id: "missing-results", batch: { total: 2, completed: 2, failed: 0, unknown: 0 }, expected: "execution_unknown" },
        { id: "async", taskId: "asyncimg_existing", expected: "pending" },
        { id: "no-response", expected: "execution_unknown" },
        { id: "sync", images: true, expected: "succeeded" },
    ];
    seedTasks(rows.map((row) => ({ ...record, id: row.id, task_id: row.taskId || null, status: "storage_pending", value: { batch: row.batch, result: { data: row.images ? [{ url: "/api/result-media/saved" }] : [] } } })));
    await recoverImageTaskRecords();
    expect(Object.fromEntries((await readImageTasks()).map((task) => [task.id, task.status]))).toEqual(Object.fromEntries(rows.map((row) => [row.id, row.expected])));
    expect(getDocumentSaveState("image-tasks").status).toBe("saved");
});

test.each(["sync", "async"])("%s generation keeps returned recovery information when its final save fails", async (mode) => {
    let paid = 0;
    const checkIntent = () => {
        paid += 1;
        const intentions = Object.values(documents["image-tasks"].value as Record<string, ImageTaskRecord>);
        expect(intentions).toHaveLength(1);
        expect(intentions[0].task_id).toBeNull();
        expect(intentions[0].value.result).toBeUndefined();
    };
    globalThis.fetch = (async () => { checkIntent(); return Response.json({ task_id: record.task_id }, { status: 202 }); }) as typeof fetch;
    axios.defaults.adapter = async (request) => {
        checkIntent();
        return { config: request, data: { data: [{ b64_json: "aW1hZ2U=" }] }, status: 200, statusText: "OK", headers: {} };
    };
    documentTransport = (async (url, init) => {
        if (init?.method === "PUT") {
            const records = Object.values(JSON.parse(String(init.body)).value) as ImageTaskRecord[];
            if (records.some((item) => item.task_id || item.value.result)) return Response.json({ error: { message: "disk full after response" } }, { status: 503 });
        }
        return saveDocumentFixture(url, init);
    }) as typeof fetch;
    const generation = mode === "sync" ? requestGeneration(config, "draw") : requestAsyncImageGeneration(config, "draw", [], "received-intent");
    await expect(generation).rejects.toBeInstanceOf(ImageGenerationUncertainError);
    const [draft] = Object.values(getDocumentDraft("image-tasks") as Record<string, ImageTaskRecord>);
    if (mode === "sync") {
        expect(draft.status).toBe("storage_failed");
        expect(imageTaskHasResult(draft)).toBe(true);
    } else expect(draft.task_id).toBe(record.task_id);
    expect(getDocumentSaveState("image-tasks").status).toBe("error");
    documentTransport = undefined;
    await retryDocument("image-tasks");
    expect(await readImageTasks()).toEqual([draft]);
    if (mode === "async") expect(await requestAsyncImageGeneration(config, "draw", [], "received-intent")).toBe(record.task_id!);
    else expect(imageTaskHasResult(await refreshImageTask(draft))).toBe(true);
    expect(paid).toBe(1);
});

test("opening already stored image results reuses their local files without downloading or writing new files", async () => {
    const stored: ImageTaskRecord = { ...record, status: "succeeded", value: { ...record.value, result: { data: [{ url: "/api/result-media/stored" }] }, localImages: { 0: "image:existing" } } };
    seedTasks([stored]);
    files.set("image:existing", new Blob(["saved image"], { type: "image/png" }));
    globalThis.fetch = (async () => { throw new Error("Existing local results must not download again"); }) as typeof fetch;
    for (let opened = 0; opened < 2; opened += 1) {
        const images = await imageTaskImages(stored);
        expect(images).toHaveLength(1);
        expect(images[0].dataUrl).toBe("local-file:image%3Aexisting");
    }
    expect(fileWrites).toEqual([]);
});

test.each(["deleted", "replaced"])("cached results are rejected when the task is %s during decoding without writing the record", async (change) => {
    const stored: ImageTaskRecord = { ...record, status: "succeeded", value: { result: { data: [{ url: "/api/result-media/stored" }] }, localImages: { 0: "image:existing" } } };
    seedTasks([stored]);
    files.set("image:existing", new Blob(["saved image"], { type: "image/png" }));
    const started = Promise.withResolvers<void>();
    const decoded = Promise.withResolvers<void>();
    Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
        src = ""; naturalWidth = 1; naturalHeight = 1;
        async decode() { started.resolve(); await decoded.promise; }
    } });
    const opening = imageTaskImages(stored);
    await started.promise;
    const replacement = { ...stored, value: { ...stored.value, localImages: { 0: "image:replacement" } } };
    documents["image-tasks"] = { revision: 2, value: change === "deleted" ? {} : { [stored.id]: replacement } };
    const latest = structuredClone(documents["image-tasks"]);
    decoded.resolve();
    await expect(opening).rejects.toThrow(change === "deleted" ? i18n.t("taskCenter.recordRemoved") : i18n.t("taskCenter.recordChanged", { defaultValue: "任务记录已变化，请刷新后重新查看结果" }));
    expect(documents["image-tasks"]).toEqual(latest);
    expect(getDocumentBaseline("image-tasks")).toBeUndefined();
    expect(fileWrites).toEqual([]);
});

test("async result bridge reads send session headers while foreign URLs and unsupported paths stay blocked", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url, init) => {
        calls.push(String(url));
        expect(new Headers(init?.headers).get("X-Canvas-Session-Tag")).toBe("session");
        return new Response("image", { headers: { "Content-Type": "image/png" } });
    }) as typeof fetch;
    const path = buildApiUrl("", "/images/tasks_async/asyncimg_task1/content/0");
    expect(await (await readPrivateBlob(path)).text()).toBe("image");
    await expect(readPrivateBlob(`https://foreign.example${path}`)).rejects.toThrow();
    await expect(readPrivateBlob(`${path}?signature=secret`)).rejects.toThrow();
    await expect(readPrivateBlob("/api/ai/v1/images/tasks_async/asyncimg_task1")).rejects.toThrow();
    expect(() => buildApiUrl("", "/images/tasks_async/../../models")).toThrow();
    expect(calls).toEqual([path]);
});

test("concurrent document hydration shares one read and the following write uses its revision", async () => {
    let release!: (response: Response) => void;
    let gets = 0;
    let puts = 0;
    documentTransport = (async (_url, init) => {
        if (init?.method === "PUT") {
            puts++;
            expect(JSON.parse(String(init.body))).toEqual({ value: { keep: "data", added: true }, revision: 7 });
            return Response.json({ value: { keep: "data", added: true }, revision: 8 });
        }
        gets++;
        return new Promise<Response>((resolve) => {
            release = resolve;
        });
    }) as typeof fetch;
    const first = readDocument("test-domain");
    const second = readDocument("test-domain");
    await Promise.resolve();
    expect(gets).toBe(1);
    release(Response.json({ value: { keep: "data" }, revision: 7 }));
    expect(await first).toEqual(await second);
    await writeDocument("test-domain", (value: unknown) => ({ ...(value as object), added: true }));
    expect(gets).toBe(1);
    expect(puts).toBe(1);
});

async function renderTaskPanel(onOpen: (images: { id: string; dataUrl: string }[]) => Promise<void> = async () => {}) {
    const globals = { HTMLElement: browser.HTMLElement, SVGElement: browser.SVGElement, Element: browser.Element, ShadowRoot: browser.ShadowRoot, getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true };
    const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const previousSetTimeout = window.setTimeout;
    const previousClearTimeout = window.clearTimeout;
    const scheduled = new Map<number, { due: number; run: () => void }>();
    let clock = 0;
    let nextTimer = 0;
    window.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
        if (typeof handler !== "function") throw new Error("The component must schedule callable timers");
        const id = ++nextTimer;
        scheduled.set(id, { due: clock + delay, run: () => handler(...args) });
        return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = (id) => {
        scheduled.delete(id);
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const close = async () => {
        try {
            await act(async () => root.unmount());
        } finally {
            container.remove();
            window.setTimeout = previousSetTimeout;
            window.clearTimeout = previousClearTimeout;
            for (const [key, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        }
    };
    try {
        await act(async () => root.render(createElement(ImageTaskPanel, { revision: 0, onOpen })));
    } catch (error) {
        await close();
        throw error;
    }
    return {
        container,
        close,
        now: () => clock,
        async advanceTo(target: number) {
            for (;;) {
                const next = [...scheduled].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
                if (!next) break;
                clock = next[1].due;
                scheduled.delete(next[0]);
                await act(async () => next[1].run());
            }
            clock = target;
        },
        async click(label: string) {
            const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
            expect(button).toBeDefined();
            await act(async () => button!.click());
        },
    };
}

test("the image task panel preserves each task's polling deadline when other tasks refresh", async () => {
    const first = { ...record, id: "first", task_id: "asyncimg_first", value: { ...record.value, retryAfter: 2 } };
    const second = { ...record, id: "second", task_id: "asyncimg_second", value: { ...record.value, retryAfter: 5 } };
    const polled: { task: string; at: number }[] = [];
    seedTasks([first, second]);
    let now = () => 0;
    globalThis.fetch = (async (url) => {
        const path = String(url);
        polled.push({ task: path.split("/").at(-1)!, at: now() });
        return Response.json({ status: "pending" });
    }) as typeof fetch;
    const panel = await renderTaskPanel();
    now = panel.now;
    try {
        await panel.advanceTo(5000);
        expect(polled).toEqual([
            { task: "asyncimg_first", at: 2000 },
            { task: "asyncimg_first", at: 4000 },
            { task: "asyncimg_second", at: 5000 },
        ]);
    } finally {
        await panel.close();
    }
});

test("a late list snapshot cannot replace a completed image task shown by the panel", async () => {
    seedTasks([record]);
    let listReads = 0;
    let releaseList!: (value: Response) => void;
    const opened: { id: string; dataUrl: string }[][] = [];
    documentTransport = (async (url, init) => {
        if (init?.method !== "PUT" && ++listReads === 2) {
            return new Promise<Response>((resolve) => {
                releaseList = resolve;
            });
        }
        return saveDocumentFixture(url, init);
    }) as typeof fetch;
    globalThis.fetch = (async (url) => {
        if (String(url) === "/api/result-media/complete") return new Response("image", { headers: { "Content-Type": "image/png" } });
        return Response.json({ status: "succeeded", data: [{ url: "/api/result-media/complete" }] });
    }) as typeof fetch;
    const panel = await renderTaskPanel(async (images) => {
        opened.push(images);
    });
    try {
        await panel.click(i18n.t("managed.refreshTasks"));
        await panel.click(i18n.t("managed.resumeImage"));
        await panel.click(i18n.t("managed.showCompletedTasks", { count: 1 }));
        expect(panel.container.textContent).toContain(i18n.t("managed.viewResults"));
        await act(async () => releaseList(Response.json({ value: { [record.id]: record }, revision: 1 })));
        expect(panel.container.textContent).toContain(i18n.t("managed.viewResults"));
        const actions = [...panel.container.querySelectorAll("button")].map((button) => button.textContent);
        expect(actions).toContain(i18n.t("managed.viewResults"));
        expect(actions).not.toContain(i18n.t("managed.resumeImage"));
        await panel.click(i18n.t("managed.viewResults"));
        expect(opened).toHaveLength(1);
        expect(opened[0]).toHaveLength(1);
        expect(opened[0][0].dataUrl).toBe("local-file:image%3Afile-1");
    } finally {
        await panel.close();
    }
});

test("completed tasks stay folded while unknown requests remain visible without resubmit actions", async () => {
    seedTasks([
        { ...record, id: "complete", status: "succeeded", value: { result: { data: [{ url: "/api/result-media/done" }] } } },
        { ...record, id: "unknown", task_id: null, status: "unknown" },
    ]);
    const panel = await renderTaskPanel();
    try {
        expect(panel.container.textContent).toContain(i18n.t("managed.taskAttention"));
        expect(panel.container.textContent).toContain(i18n.t("managed.imageTaskUnknown"));
        expect(panel.container.textContent).not.toContain(i18n.t("managed.viewResults"));
        expect([...panel.container.querySelectorAll("button")].map((button) => button.textContent)).not.toContain(i18n.t("managed.resumeImage"));
        await panel.click(i18n.t("managed.showCompletedTasks", { count: 1 }));
        expect(panel.container.textContent).toContain(i18n.t("managed.viewResults"));
    } finally {
        await panel.close();
    }
});
