import "./browser";
import { afterEach, beforeEach, expect, test } from "bun:test";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { mockBrowserDocuments } from "./local-document-fixture";
import { endCanvasSession, readCanvasSession } from "@/services/api/canvas-client";
import { ImageGenerationUncertainError, requestAsyncImageGeneration, requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { createVideoGenerationTask, pollVideoGenerationTask } from "@/services/api/video";
import { readImageTaskRecords } from "@/services/image-task-records";
import { defaultConfig, resolveModelForCapability, supportsAsyncImageGeneration, useConfigStore, type AiConfig } from "@/stores/use-config-store";

const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
const session = { user: { id: 1, subject: `ics_${"a".repeat(32)}`, username: "routing" }, csrf_token: "csrf", session_tag: "routing", expires_at: Math.floor(Date.now() / 1000) + 3600 };
let documents: Record<string, { value: unknown; revision: number }>;
let fixture: ReturnType<typeof mockBrowserDocuments>;
const requests: string[] = [];

function configure(endpoints: string[], name = "gemini-image"): AiConfig {
    const model = `gateway::${name}`;
    const config: AiConfig = { ...defaultConfig, model, imageModel: model, textModel: model, videoModel: model, channels: [{ id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai", models: [{ name, capability: "image", capabilities: ["image", "text"], endpointTypes: endpoints }] }] };
    useConfigStore.setState({ config });
    return config;
}

function response(request: InternalAxiosRequestConfig, data: unknown) {
    requests.push(`${request.method?.toUpperCase()} ${request.url}`);
    return { config: request, data, status: 200, statusText: "OK", headers: {} };
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
        throw new AxiosError("upstream response", "ERR_BAD_RESPONSE", request, undefined, { config: request, status, statusText: "Error", headers: {}, data: { error: { message: "upstream response" } } });
    };
    const error = await requestGeneration(config, "draw").catch((error) => error);
    const unknown = status === 408 || status >= 500;
    expect(error instanceof ImageGenerationUncertainError).toBe(unknown);
    expect(Object.values(await readImageTaskRecords()).map((record) => record.status)).toEqual([unknown ? "execution_unknown" : "failed"]);
    expect(requests).toEqual(["POST /api/ai/v1/images/generations"]);
});

test.each(["generation", "edit", "gemini"])("an unreadable successful %s response remains execution unknown", async (kind) => {
    const config = configure(kind === "gemini" ? ["gemini"] : ["image-generation"]);
    axios.defaults.adapter = async (request) => response(request, { request_id: "accepted-with-unreadable-result" });
    await expect(kind === "edit" ? requestEdit(config, "edit", []) : requestGeneration(config, "draw")).rejects.toBeInstanceOf(ImageGenerationUncertainError);
    expect(Object.values(await readImageTaskRecords()).map((record) => record.status)).toEqual(["execution_unknown"]);
    expect(requests).toHaveLength(1);
});

test.each([408, 504])("asynchronous HTTP %i keeps the original intent and never resubmits it", async (status) => {
    const config = configure(["image-generation"]);
    globalThis.fetch = (async (url, init) => {
        requests.push(`${init?.method} ${url}`);
        return Response.json({ error: { message: "upstream timeout" } }, { status });
    }) as typeof fetch;
    await expect(requestAsyncImageGeneration(config, "draw", [], "same-intent")).rejects.toBeInstanceOf(ImageGenerationUncertainError);
    await expect(requestAsyncImageGeneration(config, "draw", [], "same-intent")).rejects.toBeInstanceOf(ImageGenerationUncertainError);
    expect((await readImageTaskRecords())["same-intent"].status).toBe("execution_unknown");
    expect(requests).toEqual(["POST /api/ai/v1/images/generations_async"]);
});

test.each([
    { endpoints: ["gemini", "openai"], path: "/api/ai/v1beta/models/gemini-image:generateContent" },
    { endpoints: ["gemini", "image-generation"], path: "/api/ai/v1/images/generations" },
])("image dispatch follows image endpoints in $endpoints", async ({ endpoints, path }) => {
    const config = configure(endpoints);
    axios.defaults.adapter = async (request) => response(request, request.url?.includes("v1beta") ? { candidates: [{ content: { parts: [{ inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } }] } }] } : { data: [{ b64_json: "aW1hZ2U=" }] });
    expect(await requestGeneration(config, "draw")).toHaveLength(1);
    expect(requests).toEqual([`POST ${path}`]);
    expect(supportsAsyncImageGeneration(config, config.model)).toBe(endpoints.includes("image-generation"));
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
