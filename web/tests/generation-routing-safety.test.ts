import "./browser";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { mockBrowserDocuments } from "./local-document-fixture";
import { endCanvasSession, readCanvasSession } from "@/services/api/canvas-client";
import { ImageGenerationUncertainError, requestAsyncImageGeneration, requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { createVideoGenerationTask, pollVideoGenerationTask } from "@/services/api/video";
import { readImageTaskRecords, updateImageTaskRecord } from "@/services/image-task-records";
import { startGenerationRequest } from "@/services/generation-diagnostics";
import { defaultConfig, modelMatchesCapability, refreshGatewayModels, resolveModelForCapability, selectableModelsByCapability, supportsAsyncImageGeneration, supportsImageGeneration, useConfigStore, type AiConfig } from "@/stores/use-config-store";

const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
const session = { user: { id: 1, subject: `ics_${"a".repeat(32)}`, username: "routing" }, csrf_token: "csrf", session_tag: "routing", expires_at: Math.floor(Date.now() / 1000) + 3600 };
let documents: Record<string, { value: unknown; revision: number }>;
let fixture: ReturnType<typeof mockBrowserDocuments>;
const requests: string[] = [];
const requestId = "d1b198aa-7c88-4fbc-8be8-8a5bc434f946";

function configure(endpoints: string[], name = "gemini-image"): AiConfig {
    const model = `gateway::${name}`;
    const config: AiConfig = { ...defaultConfig, model, imageModel: model, textModel: model, videoModel: model, channels: [{ id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai", models: [{ name, capability: "image", capabilities: ["image", "text"], endpointTypes: endpoints }] }] };
    useConfigStore.setState({ config });
    return config;
}

function response(request: InternalAxiosRequestConfig, data: unknown) {
    requests.push(`${request.method?.toUpperCase()} ${request.url}`);
    return { config: request, data, status: 200, statusText: "OK", headers: { "X-Request-Id": requestId } };
}

beforeEach(async () => {
    endCanvasSession();
    localStorage.clear();
    requests.length = 0;
    documents = {};
    fixture = mockBrowserDocuments((async (url, init) => {
        const domain = String(url).slice("/api/data/".length);
        const saved = documents[domain] || { value: null, revision: 0 };
        if (init?.method === "PUT") {
            const body = JSON.parse(String(init.body));
            if (body.revision !== saved.revision) return Response.json({ error: { message: "conflict" } }, { status: 409 });
            documents[domain] = { value: body.value, revision: saved.revision + 1 };
        }
        return Response.json(documents[domain] || saved);
    }) as typeof fetch);
    globalThis.fetch = (async () => Response.json(session)) as typeof fetch;
    axios.defaults.adapter = async () => { throw new Error("Unexpected model request"); };
    await readCanvasSession();
});

afterEach(() => {
    endCanvasSession();
    fixture.restore();
    globalThis.fetch = originalFetch;
    axios.defaults.adapter = originalAdapter;
});

test.each([408, 500, 504, 400, 429])("synchronous HTTP %i distinguishes unknown execution from explicit rejection", async (status) => {
    const config = configure(["image-generation"]);
    axios.defaults.adapter = async (request) => {
        requests.push(`POST ${request.url}`);
        throw new AxiosError("upstream response", "ERR_BAD_RESPONSE", request, undefined, { config: request, status, statusText: "Error", headers: { "X-Request-Id": requestId }, data: { error: { message: "upstream response" } } });
    };
    const error = await requestGeneration(config, "draw").catch((error) => error);
    const unknown = status === 408 || status >= 500;
    expect(error instanceof ImageGenerationUncertainError).toBe(unknown);
    expect(Object.values(await readImageTaskRecords()).map((record) => record.status)).toEqual([unknown ? "execution_unknown" : "failed"]);
    expect(Object.values(await readImageTaskRecords())[0].value.requests).toEqual([{ requestId, durationMs: expect.any(Number) }]);
    expect(requests).toEqual(["POST /api/ai/v1/images/generations"]);
});

test.each(["generation", "edit", "gemini"])("an unreadable successful %s response remains execution unknown", async (kind) => {
    const config = configure(kind === "gemini" ? ["gemini"] : ["image-generation"]);
    axios.defaults.adapter = async (request) => response(request, { request_id: "accepted-with-unreadable-result" });
    await expect(kind === "edit" ? requestEdit(config, "edit", []) : requestGeneration(config, "draw")).rejects.toBeInstanceOf(ImageGenerationUncertainError);
    expect(Object.values(await readImageTaskRecords()).map((record) => record.status)).toEqual(["execution_unknown"]);
    expect(Object.values(await readImageTaskRecords())[0].value.requests).toEqual([{ requestId, durationMs: expect.any(Number) }]);
    expect(requests).toHaveLength(1);
});

test.each([408, 504])("asynchronous HTTP %i keeps the original intent and never resubmits it", async (status) => {
    const config = configure(["image-generation"]);
    globalThis.fetch = (async (url, init) => {
        requests.push(`${init?.method} ${url}`);
        return Response.json({ error: { message: "upstream timeout" } }, { status, headers: { "X-Request-Id": requestId } });
    }) as typeof fetch;
    await expect(requestAsyncImageGeneration(config, "draw", [], "same-intent")).rejects.toBeInstanceOf(ImageGenerationUncertainError);
    await expect(requestAsyncImageGeneration(config, "draw", [], "same-intent")).rejects.toBeInstanceOf(ImageGenerationUncertainError);
    expect((await readImageTaskRecords())["same-intent"].status).toBe("execution_unknown");
    expect((await readImageTaskRecords())["same-intent"].value.requests).toEqual([{ requestId, durationMs: expect.any(Number) }]);
    expect(requests).toEqual(["POST /api/ai/v1/images/generations_async"]);
});

test.each([
    { endpoints: ["gemini", "openai"], path: "/api/ai/v1beta/models/gemini-image:generateContent" },
    { endpoints: ["gemini", "image-generation"], path: "/api/ai/v1/images/generations" },
])("image dispatch follows image endpoints in $endpoints", async ({ endpoints, path }) => {
    const config = configure(endpoints);
    axios.defaults.adapter = async (request) => response(request, request.url?.includes("v1beta") ? { candidates: [{ content: { parts: [{ inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } }] } }] } : { data: [{ b64_json: "aW1hZ2U=" }] });
    expect(await requestGeneration(config, "draw")).toHaveLength(1);
    expect(Object.values(await readImageTaskRecords())[0].value.requests).toEqual([{ requestId, durationMs: expect.any(Number) }]);
    expect(requests).toEqual([`POST ${path}`]);
    expect(supportsAsyncImageGeneration(config, config.model)).toBe(endpoints.includes("image-generation"));
});

test("request measurements accept only BFF UUIDs and elapsed time", () => {
    const clock = spyOn(performance, "now");
    try {
        clock.mockReturnValue(100);
        const finish = startGenerationRequest();
        clock.mockReturnValue(125);
        expect(finish(requestId)).toEqual({ requestId, durationMs: 25 });
        for (const value of ["private-token-value", "Bearer secret", { requestId }, null, undefined]) expect(finish(value)).toEqual({ durationMs: 25 });
    } finally { clock.mockRestore(); }
});

test.each(["generation", "edit", "gemini"])("successful %s measurements share the existing result save", async (kind) => {
    const config = configure(kind === "gemini" ? ["gemini"] : ["image-generation"]);
    axios.defaults.adapter = async (request) => response(request, kind === "gemini" ? { candidates: [{ content: { parts: [{ inlineData: { data: "aW1hZ2U=" } }] } }] } : { data: [{ b64_json: "aW1hZ2U=" }] });
    await (kind === "edit" ? requestEdit(config, "private-prompt-value", []) : requestGeneration(config, "private-prompt-value"));
    const measurement = Object.values(await readImageTaskRecords())[0].value.requests;
    expect(measurement).toEqual([{ requestId, durationMs: expect.any(Number) }]);
    expect(measurement![0].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(measurement)).not.toContain("private-prompt-value");
    expect(documents["image-tasks"].revision).toBe(2);
});

test("Gemini batch measurements survive each partial result save without extra writes", async () => {
    const config = { ...configure(["gemini"]), count: "2" };
    axios.defaults.adapter = async (request) => response(request, { candidates: [{ content: { parts: [{ inlineData: { data: "aW1hZ2U=" } }] } }] });
    expect(await requestGeneration(config, "draw")).toHaveLength(2);
    expect(Object.values(await readImageTaskRecords())[0].value.requests).toEqual(Array.from({ length: 2 }, () => ({ requestId, durationMs: expect.any(Number) })));
    expect(documents["image-tasks"].revision).toBe(3);
    expect(requests).toHaveLength(2);
});

test.each([false, true])("async edit=%s measurements include JSON completion and share the task save", async (edit) => {
    const config = configure(["image-generation"]);
    const clock = spyOn(performance, "now");
    try {
        clock.mockReturnValue(100);
        globalThis.fetch = (async (url, init) => {
            requests.push(`${init?.method} ${url}`);
            clock.mockReturnValue(150);
            const accepted = Response.json({ task_id: "asyncimg_measured" }, { status: 202, headers: { "X-Request-Id": requestId } });
            const json = accepted.json.bind(accepted);
            accepted.json = async () => { clock.mockReturnValue(300); return json(); };
            return accepted;
        }) as typeof fetch;
        const references = edit ? [{ id: "reference", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" }] : [];
        expect(await requestAsyncImageGeneration(config, "private-prompt-value", references, "measured-intent")).toBe("asyncimg_measured");
        expect((await readImageTaskRecords())["measured-intent"].value.requests).toEqual([{ requestId, durationMs: 200 }]);
        expect(documents["image-tasks"].revision).toBe(2);
        expect(requests).toEqual([`POST /api/ai/v1/images/${edit ? "edits" : "generations"}_async`]);
    } finally { clock.mockRestore(); }
});

test.each([false, true])("network failure async=%s records elapsed time without inventing a request ID", async (asyncRequest) => {
    const config = configure(["image-generation"]);
    axios.defaults.adapter = async (request) => { throw new AxiosError("private-network-message", "ERR_NETWORK", request); };
    globalThis.fetch = (async () => { throw new TypeError("private-network-message"); }) as typeof fetch;
    await expect(asyncRequest ? requestAsyncImageGeneration(config, "draw", [], "network-intent") : requestGeneration(config, "draw")).rejects.toBeInstanceOf(ImageGenerationUncertainError);
    const record = Object.values(await readImageTaskRecords())[0];
    expect(record.status).toBe("execution_unknown");
    expect(record.value.requests).toEqual([{ durationMs: expect.any(Number) }]);
    expect(documents["image-tasks"].revision).toBe(2);
});

test.each([
    { endpoints: ["image-generation", "gemini"], path: "/api/ai/v1beta/models/gemini-image:streamGenerateContent?alt=sse", event: { candidates: [{ content: { parts: [{ text: "answer" }] } }] } },
    { endpoints: ["gemini", "openai"], path: "/api/ai/v1/chat/completions", event: { choices: [{ delta: { content: "answer" } }] } },
    { endpoints: ["gemini", "openai", "openai-response"], path: "/api/ai/v1/responses", event: { type: "response.output_text.delta", delta: "answer" } },
])("text dispatch follows text endpoints in $endpoints", async ({ endpoints, path, event }) => {
    const config = configure(endpoints);
    globalThis.fetch = (async (url, init) => {
        requests.push(`${init?.method} ${url}`);
        return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    expect(await requestImageQuestion(config, [{ role: "user", content: "hi" }], () => {})).toBe("answer");
    expect(requests).toEqual([`POST ${path}`]);
});

test("an unsupported asynchronous image operation fails locally before a model request", async () => {
    const config = configure(["gemini", "openai"]);
    globalThis.fetch = (async (url) => { requests.push(String(url)); throw new Error("Unexpected model request"); }) as typeof fetch;
    await expect(requestAsyncImageGeneration(config, "draw", [], "unsupported")).rejects.toThrow();
    expect((await readImageTaskRecords()).unsupported.status).toBe("failed");
    expect(requests).toEqual([]);
});

test("multi-capability selections remain selected for text and image", () => {
    const config = configure(["gemini", "image-generation"]);
    expect(resolveModelForCapability(config, config.model, "text")).toBe(config.model);
    expect(resolveModelForCapability(config, undefined, "text")).toBe(config.model);
    expect(resolveModelForCapability(config, config.model, "image")).toBe(config.model);
});

test("removing a model still permits original video queries but prevents new submissions", async () => {
    const config = configure(["openai-video"], "removed-video");
    useConfigStore.setState({ config: { ...config, channels: [], models: [] } });
    axios.defaults.adapter = async (request) => response(request, { id: "original-task", status: "pending" });
    expect(await pollVideoGenerationTask(config, { id: "original-task", provider: "openai", model: config.model })).toEqual({ status: "pending" });
    await expect(createVideoGenerationTask(config, "new video")).rejects.toThrow("当前用户无权调用所选模型");
    expect(requests).toEqual(["GET /api/ai/v1/videos/original-task"]);
});

const dedicatedImageModels = ["gpt-image-2", "dall-e-3", "seedream-5-pro", "qwen-image", "flux.1-pro", "gemini-nano-banana-2.1", "gemini-3-pro-image-preview", "gemini-2.5-flash-image-preview"];
const videoModels = ["veo-3.1-fast-generate-preview", "seedance2.0-E", "seedance2.5-A", "minimax-h3-2k", "minimax-h3-720p", "video-model", "opaque-generator"];

test.each(dedicatedImageModels)("dedicated image model %s cannot use text endpoints, including stale selections", async (name) => {
    const config = configure(["image-generation", "openai", "openai-response", "gemini"], name);
    globalThis.fetch = (async (url) => { requests.push(String(url)); throw new Error("Unexpected text request"); }) as typeof fetch;
    expect(modelMatchesCapability(config, config.model, "image")).toBe(true);
    expect(modelMatchesCapability(config, config.model, "text")).toBe(false);
    expect(selectableModelsByCapability(config, "text")).toEqual([]);
    await expect(requestImageQuestion(config, [{ role: "user", content: "draw" }], () => {})).rejects.toThrow("当前模型不支持此操作");
    expect(requests).toEqual([]);
});

test.each(videoModels)("video model %s rejects stale text capabilities before any request", async (name) => {
    const config = configure(["openai-video", "openai", "openai-response", "gemini"], name);
    globalThis.fetch = (async (url) => { requests.push(String(url)); throw new Error("Unexpected text request"); }) as typeof fetch;
    expect(modelMatchesCapability(config, config.model, "text")).toBe(false);
    expect(selectableModelsByCapability(config, "text")).toEqual([]);
    await expect(requestImageQuestion(config, [{ role: "user", content: "answer" }], () => {})).rejects.toThrow("当前模型不支持此操作");
    expect(requests).toEqual([]);
});

test.each([...dedicatedImageModels, ...videoModels])("model refresh removes the media text default %s and preserves general text models", async (name) => {
    configure(["openai", "openai-response", "gemini"], name);
    const textModels = [
        { id: "gemini-2.5-pro", supported_endpoint_types: ["gemini"] },
        { id: "gemini-2.5-flash", supported_endpoint_types: ["gemini"] },
        { id: "gpt-5.5", supported_endpoint_types: ["openai-response", "openai"] },
        { id: "MiniMax-M2", supported_endpoint_types: ["openai"] },
        { id: "gemini-image", supported_endpoint_types: ["gemini", "image-generation"] },
    ];
    globalThis.fetch = (async () => Response.json({ data: [
        ...dedicatedImageModels.map((id) => ({ id, supported_endpoint_types: ["image-generation", "openai", "openai-response", "gemini"] })),
        ...videoModels.map((id) => ({ id, supported_endpoint_types: ["openai-video", "openai", "openai-response", "gemini"] })),
        ...textModels,
    ] })) as typeof fetch;
    await refreshGatewayModels();
    const { config } = useConfigStore.getState();
    expect(config.textModel).toBe("gateway::gemini-2.5-pro");
    expect(selectableModelsByCapability(config, "text")).toEqual(textModels.map((model) => `gateway::${model.id}`));
    expect(modelMatchesCapability(config, `gateway::${name}`, videoModels.includes(name) ? "video" : "image")).toBe(true);
    expect(modelMatchesCapability(config, "gateway::gemini-image", "image")).toBe(true);
});

test("model refresh replaces an image-only text default while preserving genuine Gemini multi-capability", async () => {
    configure(["image-generation", "openai-response"], "gpt-image-2");
    globalThis.fetch = (async () => Response.json({ data: [
        { id: "gpt-image-2", supported_endpoint_types: ["image-generation", "openai", "openai-response"] },
        { id: "gemini-image", supported_endpoint_types: ["gemini", "image-generation"] },
    ] })) as typeof fetch;
    await refreshGatewayModels();
    const { config } = useConfigStore.getState();
    expect(config.imageModel).toBe("gateway::gpt-image-2");
    expect(config.textModel).toBe("gateway::gemini-image");
    expect(selectableModelsByCapability(config, "text")).toEqual(["gateway::gemini-image"]);
    expect(modelMatchesCapability(config, config.textModel, "image")).toBe(true);
});

test.each(["sync", "async"] as const)("explicitly unavailable %s execution is stopped before a paid POST", async (operation) => {
    configure(["image-generation"], "gpt-image-2");
    globalThis.fetch = (async () => Response.json({ data: [{ id: "gpt-image-2", supported_endpoint_types: ["image-generation"], image_execution: { sync: operation !== "sync", async: operation !== "async" } }] })) as typeof fetch;
    await refreshGatewayModels();
    const { config } = useConfigStore.getState();
    expect(supportsImageGeneration(config, config.imageModel, "sync")).toBe(operation !== "sync");
    expect(supportsAsyncImageGeneration(config, config.imageModel)).toBe(operation !== "async");
    globalThis.fetch = (async (url) => { requests.push(String(url)); throw new Error("Unexpected paid request"); }) as typeof fetch;
    await expect(operation === "sync" ? requestGeneration(config, "draw") : requestAsyncImageGeneration(config, "draw", [], "disabled-mode")).rejects.toThrow("当前模型不支持所选生成方式");
    expect(requests).toEqual([]);
});

test("declared Gemini sync route wins over an async-only standard image endpoint", async () => {
    configure(["image-generation", "gemini"], "opaque-model");
    globalThis.fetch = (async () => Response.json({ data: [{ id: "opaque-model", supported_endpoint_types: ["image-generation", "gemini"], image_execution: { sync: true, async: true, sync_endpoint: "gemini" } }] })) as typeof fetch;
    await refreshGatewayModels();
    const { config } = useConfigStore.getState();
    expect(modelMatchesCapability(config, config.imageModel, "image")).toBe(true);
    axios.defaults.adapter = async (request) => response(request, { candidates: [{ content: { parts: [{ inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } }] } }] });
    expect(await requestGeneration(config, "draw")).toHaveLength(1);
    expect(requests).toEqual(["POST /api/ai/v1beta/models/opaque-model:generateContent"]);
});

test("malformed execution metadata does not replace the last valid model catalog", async () => {
    const config = configure(["image-generation"]);
    globalThis.fetch = (async () => Response.json({ data: [{ id: "gpt-image-2", supported_endpoint_types: ["image-generation"], image_execution: { sync: "false", async: true } }] })) as typeof fetch;
    await expect(refreshGatewayModels()).rejects.toThrow();
    expect(useConfigStore.getState().config).toBe(config);
});

test("async canvas submission waits for the linked intent save, then reuses the known task without another POST", async () => {
    const config = configure(["image-generation"]);
    let linked = false;
    globalThis.fetch = (async (url, init) => {
        expect(linked).toBe(true);
        expect((await readImageTaskRecords())["linked-intent"].status).toBe("submitting");
        requests.push(`${init?.method} ${url}`);
        return Response.json({ task_id: "asyncimg_linked" }, { status: 202 });
    }) as typeof fetch;
    const source = { kind: "canvas" as const, canvasId: "canvas", nodeId: "image", slotId: "slot" };
    const options = { onIntentSaved: async (id: string) => { expect(id).toBe("linked-intent"); await updateImageTaskRecord(id, (record) => ({ ...record, value: { ...record.value, source } })); linked = true; } };
    expect(await requestAsyncImageGeneration(config, "draw", [], "linked-intent", options)).toBe("asyncimg_linked");
    expect(await requestAsyncImageGeneration(config, "draw", [], "linked-intent", options)).toBe("asyncimg_linked");
    expect(requests).toEqual(["POST /api/ai/v1/images/generations_async"]);
    expect((await readImageTaskRecords())["linked-intent"].value.source).toEqual(source);
});

test.each(["cancelled", "save-failed"])("async canvas intent %s before POST never reaches the gateway", async (cause) => {
    const config = configure(["image-generation"]);
    const controller = new AbortController();
    globalThis.fetch = (async (url) => { requests.push(String(url)); throw new Error("Unexpected paid request"); }) as typeof fetch;
    await expect(requestAsyncImageGeneration(config, "draw", [], cause, {
        signal: controller.signal,
        onIntentSaved: async () => { if (cause === "cancelled") controller.abort(); else throw new Error("save failed"); },
    })).rejects.toThrow();
    expect((await readImageTaskRecords())[cause].status).toBe("failed");
    expect(requests).toEqual([]);
});
