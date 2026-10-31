import { browser } from "./browser";
import { afterEach, beforeEach, expect, test } from "bun:test";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import i18n from "@/i18n";
import { endCanvasSession, readCanvasSession } from "@/services/api/canvas-client";
import { createVideoGenerationTask, pollVideoGenerationTask, VideoGenerationUncertainError } from "@/services/api/video";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

const originalFetch = globalThis.fetch;
const originalAdapter = axios.defaults.adapter;
const fileReaderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
const session = { user: { id: 1, subject: `ics_${"a".repeat(32)}`, username: "video" }, csrf_token: "csrf-video", session_tag: "video-format", expires_at: Math.floor(Date.now() / 1000) + 3600 };
let activeSession = session;
let documents: Record<string, { value: unknown; revision: number }>;
let browserDocuments: ReturnType<typeof mockBrowserDocuments>;
let browserFiles: ReturnType<typeof mockBrowserFiles>;
let uploads: RequestInit[];
let fileReads: string[];
let videoRequests: InternalAxiosRequestConfig[];
let upload: (init: RequestInit) => Promise<Response>;

function configure(name = "seedance2.5-A", values: Partial<AiConfig> = {}) {
    const model = `gateway::${name}`;
    const config: AiConfig = {
        ...defaultConfig, model, videoModel: model, size: "16:9", vquality: "720", videoSeconds: "5", videoMode: "reference",
        channels: [{ id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai", models: [{ name, capability: "video", endpointTypes: ["openai-video"] }] }],
        ...values,
    };
    useConfigStore.setState({ config });
    return config;
}

function localImage(id = "first"): ReferenceImage {
    return { id, name: `${id}.png`, type: "image/png", dataUrl: `blob:preview-${id}`, storageKey: `image:${id}` };
}

function jsonSubmission() {
    expect(videoRequests).toHaveLength(1);
    const request = videoRequests[0];
    expect(request.method).toBe("post");
    expect(request.url).toBe("/api/ai/v1/videos");
    expect(request.headers.get("Content-Type")).toContain("application/json");
    expect(typeof request.data).toBe("string");
    return JSON.parse(request.data);
}

beforeEach(async () => {
    endCanvasSession();
    localStorage.clear();
    activeSession = session;
    documents = {};
    uploads = [];
    fileReads = [];
    videoRequests = [];
    Object.defineProperty(globalThis, "FileReader", { configurable: true, writable: true, value: browser.FileReader });
    upload = async () => Response.json({ url: `https://media.example/reference-${uploads.length}.png` });
    globalThis.fetch = (async (input, init = {}) => {
        const path = String(input);
        if (path === "/api/session") return Response.json(activeSession);
        if (path.startsWith("/api/data/")) {
            const domain = decodeURIComponent(path.slice("/api/data/".length));
            const saved = documents[domain] || { value: null, revision: 0 };
            if (init.method === "PUT") {
                const body = JSON.parse(String(init.body));
                if (body.revision !== saved.revision) return Response.json({ error: { message: "conflict" } }, { status: 409 });
                documents[domain] = { value: body.value, revision: saved.revision + 1 };
            }
            return Response.json(documents[domain] || saved);
        }
        if (path.startsWith("/api/files/") && (!init.method || init.method === "GET")) {
            const key = decodeURIComponent(path.slice("/api/files/".length));
            fileReads.push(key);
            const response = new Response(`local-${key}`, { headers: { "Content-Type": "image/png" } });
            // JSDOM's real FileReader consumes a Blob from the same browser realm.
            response.blob = async () => new browser.Blob([`local-${key}`], { type: "image/png" }) as unknown as Blob;
            return response;
        }
        if (path === "/api/video-reference-images" && init.method === "POST") {
            uploads.push(init);
            return upload(init);
        }
        throw new Error(`Unexpected fetch ${init.method || "GET"} ${path}`);
    }) as typeof fetch;
    browserDocuments = mockBrowserDocuments();
    browserFiles = mockBrowserFiles();
    axios.defaults.adapter = async (request) => {
        videoRequests.push(request);
        return { config: request, data: { id: "created-video", status: "queued" }, status: 200, statusText: "OK", headers: {} };
    };
    await readCanvasSession();
});

afterEach(() => {
    endCanvasSession();
    browserDocuments.restore();
    browserFiles.restore();
    globalThis.fetch = originalFetch;
    axios.defaults.adapter = originalAdapter;
    if (fileReaderDescriptor) Object.defineProperty(globalThis, "FileReader", fileReaderDescriptor);
    else Reflect.deleteProperty(globalThis, "FileReader");
});

test.each([
    { name: "seedance2.5-A", quality: "720", resolution: "720p", audio: false, watermark: false },
    { name: "seedance2.0-E", quality: "1080", resolution: "1080p", audio: false, watermark: false },
    { name: "seedance2.0-F", quality: "720", resolution: "720px", audio: true, watermark: false },
    { name: "seedance2.5-G", quality: "1080", resolution: "1080p", audio: true, watermark: true },
    { name: "minimax-h3", quality: "1080", resolution: "1080p", audio: true, watermark: false },
    { name: "seedance2.0-E-720p", quality: "1080", resolution: "720p", audio: false, watermark: false },
])("$name publishes the local image once and submits a single JSON video request", async ({ name, quality, resolution, audio, watermark }) => {
    const config = configure(name, { vquality: quality, videoGenerateAudio: "false", videoWatermark: "true" });
    expect(await createVideoGenerationTask(config, "animate the scene", [localImage()])).toEqual({ id: "created-video", provider: "openai", model: config.model });
    expect(fileReads).toEqual(["image:first"]);
    expect(uploads).toHaveLength(1);
    const form = uploads[0].body as FormData;
    expect([...form.keys()]).toEqual(["file"]);
    expect(await (form.get("file") as File).text()).toBe("local-image:first");
    const headers = new Headers(uploads[0].headers);
    expect(headers.get("Content-Type")).toBeNull();
    expect(headers.get("X-CSRF-Token")).toBe(session.csrf_token);
    expect(headers.get("X-Canvas-Session-Tag")).toBe(session.session_tag);
    expect(headers.get("Idempotency-Key")).toBeTruthy();
    const body = jsonSubmission();
    expect(body).toMatchObject({ model: name, seconds: 5, resolution, aspect_ratio: "16:9", reference_images: ["https://media.example/reference-1.png"] });
    for (const key of ["mode", "size", "resolution_name", "ratio", "first_frame", "image", "last_frame"]) expect(body).not.toHaveProperty(key);
    if (audio) expect(body.generate_audio).toBe(false);
    else expect(body).not.toHaveProperty("generate_audio");
    if (watermark) expect(body.watermark).toBe(true);
    else expect(body).not.toHaveProperty("watermark");
});

test.each(["seedance2.0-A", "seedance2.5-A"])("%s numbers every reference kind and preserves existing image mentions", async (name) => {
    const config = configure(name);
    await createVideoGenerationTask(config, "让@图片1动起来", [localImage(), localImage("second")], {
        videos: [{ id: "video", name: "reference.mp4", type: "video/mp4", url: "https://media.example/reference.mp4" }],
        audios: [{ id: "audio", name: "reference.mp3", type: "audio/mpeg", url: "https://media.example/reference.mp3" }],
    });
    const body = jsonSubmission();
    expect(body.prompt).toBe(i18n.t("videoReferences.promptPrefix", { labels: "@图2、@视频1、@音频1", prompt: "让@图片1动起来" }));
    expect(body.reference_images).toEqual(["https://media.example/reference-1.png", "https://media.example/reference-2.png"]);
    expect(body.reference_videos).toEqual(["https://media.example/reference.mp4"]);
    expect(body.reference_audios).toEqual(["https://media.example/reference.mp3"]);
    expect(fileReads).toEqual(["image:first", "image:second"]);
    expect(uploads).toHaveLength(2);
});

test("the minimax-h3-720p gateway alias uses JSON and does not send multipart-only fields", async () => {
    await createVideoGenerationTask(configure("minimax-h3-720p"), "animate");
    const body = jsonSubmission();
    expect(body).toMatchObject({ model: "minimax-h3-720p", resolution: "720p" });
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("size");
    expect(body).not.toHaveProperty("resolution_name");
});

test("the A-series single image receives its required mention", async () => {
    const config = configure();
    await createVideoGenerationTask(config, "animate", [localImage()]);
    expect(jsonSubmission().prompt).toBe(i18n.t("videoReferences.promptPrefix", { labels: "@图1", prompt: "animate" }));
});

test.each([
    { name: "seedance2.0-A", ratio: "Auto" },
    { name: "seedance2.5-G", ratio: "adaptive" },
])("$name sends uploaded first and last frames using the model's frame fields", async ({ name, ratio }) => {
    const config = configure(name, { videoMode: "frames" });
    await createVideoGenerationTask(config, "transition between frames", [localImage(), localImage("last")]);
    const body = jsonSubmission();
    expect(body).toMatchObject({ image: "https://media.example/reference-1.png", last_frame: "https://media.example/reference-2.png", aspect_ratio: ratio, prompt: "transition between frames" });
    expect(body).not.toHaveProperty("reference_images");
    expect(body).not.toHaveProperty("first_frame");
    expect(uploads).toHaveLength(2);
});

test("native video models retain multipart file submission without the Drama upload route", async () => {
    const config = configure("video-model", { videoMode: "frames", vquality: "720" });
    await createVideoGenerationTask(config, "animate", [localImage()]);
    expect(uploads).toEqual([]);
    expect(videoRequests).toHaveLength(1);
    const request = videoRequests[0];
    expect(request.url).toBe("/api/ai/v1/videos");
    expect(request.method).toBe("post");
    expect(request.data).toBeInstanceOf(FormData);
    const body = request.data as FormData;
    expect(body.get("model")).toBe("video-model");
    expect(body.get("seconds")).toBe("5");
    expect(body.get("size")).toBe("1280x720");
    expect(body.get("first_frame")).toBeInstanceOf(File);
    expect(await (body.get("first_frame") as File).text()).toBe("local-image:first");
});

test.each(["http", "network", "invalid-url"])("reference upload %s failure stops before any paid video request", async (failure) => {
    const config = configure();
    upload = async () => {
        if (failure === "http") return Response.json({ error: { message: "reference rejected" } }, { status: 400 });
        if (failure === "network") throw new TypeError("upload connection lost");
        return Response.json({ url: "blob:server-preview" });
    };
    const error = await createVideoGenerationTask(config, "animate", [localImage(), localImage("second")]).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(VideoGenerationUncertainError);
    expect(error.message).toBe(failure === "http" ? "reference rejected" : failure === "network" ? "upload connection lost" : i18n.t("videoReferences.videoReferenceUploadInvalid"));
    expect(uploads).toHaveLength(1);
    expect(videoRequests).toEqual([]);
});

test.each(["abort", "session"])("%s during reference upload prevents further uploads and video submission", async (change) => {
    const config = configure();
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    const controller = new AbortController();
    upload = async () => { started.resolve(); return pending.promise; };
    const operation = createVideoGenerationTask(config, "animate", [localImage(), localImage("second")], { signal: controller.signal }).catch((error) => error);
    await started.promise;
    if (change === "abort") controller.abort();
    else {
        endCanvasSession();
        activeSession = { ...session, user: { id: 2, subject: `ics_${"b".repeat(32)}`, username: "other" }, session_tag: "other-session" };
        await readCanvasSession();
    }
    pending.resolve(Response.json({ url: "https://media.example/late.png" }));
    const error = await operation;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(VideoGenerationUncertainError);
    expect(uploads[0].signal?.aborted).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(fileReads).toEqual(["image:first"]);
    expect(videoRequests).toEqual([]);
});

test("an already aborted intent does not read files or upload references", async () => {
    const config = configure();
    const controller = new AbortController();
    controller.abort();
    await expect(createVideoGenerationTask(config, "animate", [localImage()], { signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
    expect(fileReads).toEqual([]);
    expect(uploads).toEqual([]);
    expect(videoRequests).toEqual([]);
});

test.each([
    { kind: "video", url: "blob:local-video" },
    { kind: "video", url: "local-file:media%3Avideo" },
    { kind: "video", url: "data:video/mp4;base64,dmlkZW8=" },
    { kind: "audio", url: "blob:local-audio" },
    { kind: "audio", url: "local-file:media%3Aaudio" },
    { kind: "audio", url: "data:audio/mpeg;base64,YXVkaW8=" },
])("local $kind reference $url is rejected clearly before uploads or paid requests", async ({ kind, url }) => {
    const config = configure();
    const media = { id: "local-media", name: kind, type: kind === "video" ? "video/mp4" : "audio/mpeg", url, storageKey: `media:${kind}` };
    const error = await createVideoGenerationTask(config, "animate", [localImage()], kind === "video" ? { videos: [media] } : { audios: [media] }).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(VideoGenerationUncertainError);
    expect(error.message).toBe(i18n.t(`videoReferences.${kind === "video" ? "publicReferenceVideoRequired" : "publicReferenceAudioRequired"}`));
    expect(fileReads).toEqual([]);
    expect(uploads).toEqual([]);
    expect(videoRequests).toEqual([]);
});

test("a lost paid video response remains execution unknown and does not submit again", async () => {
    const config = configure();
    axios.defaults.adapter = async (request) => {
        videoRequests.push(request);
        throw new AxiosError("response lost", "ERR_NETWORK", request);
    };
    await expect(createVideoGenerationTask(config, "animate", [localImage()])).rejects.toBeInstanceOf(VideoGenerationUncertainError);
    expect(uploads).toHaveLength(1);
    expect(jsonSubmission().reference_images).toEqual(["https://media.example/reference-1.png"]);
});

test("an existing Drama task only queries its original ID even after model access is removed", async () => {
    const config = configure();
    useConfigStore.setState({ config: { ...config, channels: [], models: [] } });
    axios.defaults.adapter = async (request) => {
        videoRequests.push(request);
        return { config: request, data: { id: "original-task", status: "queued" }, status: 200, statusText: "OK", headers: {} };
    };
    expect(await pollVideoGenerationTask(config, { id: "original-task", provider: "openai", model: config.model })).toEqual({ status: "pending" });
    await expect(createVideoGenerationTask(config, "new task", [localImage()])).rejects.toThrow("当前用户无权调用所选模型");
    expect(videoRequests.map((request) => `${request.method} ${request.url}`)).toEqual(["get /api/ai/v1/videos/original-task"]);
    expect(fileReads).toEqual([]);
    expect(uploads).toEqual([]);
});
