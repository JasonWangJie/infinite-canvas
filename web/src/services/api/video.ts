import { canvasFetch, csrfHeaders, readPrivateBlob, sessionEpoch } from "@/services/api/canvas-client";
import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { dataUrlToFile } from "@/lib/image-utils";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio } from "@/lib/media-size";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildApiUrl, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; status?: string; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };
type VideoMediaOptions = RequestOptions & { videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "gemini" | "plugin"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };
export class VideoGenerationUncertainError extends Error {}

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        ...csrfHeaders(),
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationResult> {
    return waitForVideoGenerationTask(config, await createVideoGenerationTask(config, prompt, references, options), options);
}

export async function waitForVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw videoTaskFailed(state.error);
        if (attempt === 119) throw new Error(apiText("videoTimeout", { provider: "" }));
        await delay(2500, options?.signal);
    }
    throw new Error(apiText("videoTimeout", { provider: "" }));
}

export function isVideoTaskFailed(error: unknown) {
    return error instanceof Error && error.name === "VideoTaskFailed";
}

function videoTaskFailed(message: string) {
    const error = new Error(message);
    error.name = "VideoTaskFailed";
    return error;
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel, "video");
    assertVideoConfig(requestConfig, requestConfig.model);
    if (requestConfig.apiFormat === "gemini") throw new Error("受管画布视频生成需要 New API 的 OpenAI 视频兼容接口");
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider !== "openai") throw new Error("此视频任务使用受管画布未开放的协议，请通过 New API 视频兼容模型重新生成");
    // Existing tasks are authorized by the gateway; model removal only blocks new submissions.
    return pollOpenAIVideoTask(config, task, options);
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) {
        return uploadMediaFile(result.url, "video");
    }
    throw new Error(apiText("noPlayableVideo"));
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const epoch = sessionEpoch();
    const name = modelOptionName(model);
    const drama = /^(?:seedance2\.(?:0|5)-(?:fast-|mini-)?[AEFG](?:-|$)|minimax-h3(?:-|$))/i.test(name);
    const body = drama ? await buildDramaVideoBody(config, name, prompt, references, epoch, options) : await buildNativeVideoBody(config, model, prompt, references, options);
    assertVideoSession(epoch, options?.signal);
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config, drama ? "application/json" : undefined), signal: options?.signal })).data);
        if (typeof created.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(created.id)) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        const message = readAxiosError(error, apiText("videoTaskCreateFailed"));
        // A lost response, timeout, server error or malformed success may hide an
        // accepted paid task. Do not offer the failed-task resubmission action.
        if (status && status >= 400 && status < 500 && status !== 408) throw new Error(message);
        throw new VideoGenerationUncertainError(`${message} ${i18n.t("managed.imageTaskUnknown")}`);
    }
}

async function buildNativeVideoBody(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions) {
    const images = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    const videos = await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)));
    const audios = await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)));
    const mode = resolveVideoMode(config.videoMode, images.length);
    const ratio = inferVideoRatio(config.size || "16:9");
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    body.append("size", normalizeVideoSize(config.size, config.vquality) || "1280x720");
    if (ratio && ratio !== "auto") {
        body.append("ratio", ratio);
    }
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("generate_audio", String(boolConfig(config.videoGenerateAudio, true)));
    body.append("watermark", String(boolConfig(config.videoWatermark, false)));
    body.append("mode", mode);
    if (mode === "frames") {
        if (images[0]) {
            body.append("first_frame", images[0], "first.png");
            body.append("images", images[0], "first.png");
        }
        if (images[1]) {
            body.append("last_frame", images[1], "last.png");
            body.append("images", images[1], "last.png");
        }
    } else {
        images.forEach((file, idx) => {
            body.append("image[]", file, `ref_${idx + 1}.png`);
            body.append("images", file, `ref_${idx + 1}.png`);
        });
    }
    videos.forEach((file) => body.append("video[]", file));
    audios.forEach((file) => body.append("audio[]", file));
    return body;
}

async function buildDramaVideoBody(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], epoch: number, options?: VideoMediaOptions) {
    assertVideoSession(epoch, options?.signal);
    // Local video/audio cannot be published through the image-only upload route.
    const videos = (options?.videos || []).map((video) => publicVideoReferenceUrl(video.url, "publicReferenceVideoRequired"));
    const audios = (options?.audios || []).map((audio) => publicVideoReferenceUrl(audio.url, "publicReferenceAudioRequired"));
    const images: string[] = [];
    for (const image of references) {
        const file = dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image, options) });
        assertVideoSession(epoch, options?.signal);
        const upload = new FormData();
        upload.append("file", file);
        const response = await canvasFetch("/api/video-reference-images", { method: "POST", body: upload, headers: { "Idempotency-Key": nanoid() }, signal: options?.signal });
        assertVideoSession(epoch, options?.signal);
        const result = await response.json().catch(() => ({}));
        assertVideoSession(epoch, options?.signal);
        if (!response.ok) throw new Error(readApiErrorMessage(result) || apiText("referenceImageReadFailed"));
        images.push(publicVideoReferenceUrl(result.url, "videoReferenceUploadInvalid"));
    }
    const name = model.toLowerCase();
    const legacy = name.startsWith("seedance") && /-(?:720p|1080p)$/.test(name);
    const series = legacy ? "legacy" : name.startsWith("minimax-h3") ? "H3" : name.match(/-([aefg])$/)?.[1].toUpperCase();
    const frames = config.videoMode !== "reference" && !videos.length && !audios.length && (name === "seedance2.0-a" && images.length === 2 || series === "G" && images.length > 0 && images.length <= 2);
    const ratio = inferVideoRatio(config.size || "16:9");
    let resolution = config.vquality.toLowerCase() === "4k" ? "4k" : normalizeVideoResolution(config.vquality);
    if (legacy) resolution = name.match(/-(720p|1080p)$/)![1];
    if (name === "seedance2.0-f") resolution = "720px";
    const body: Record<string, unknown> = {
        model,
        prompt: series === "A" && !frames ? dramaReferencePrompt(prompt, images.length, videos.length, audios.length) : prompt,
        seconds: Number(normalizeVideoSeconds(config.videoSeconds)),
        resolution,
        aspect_ratio: frames && name === "seedance2.0-a" ? "Auto" : frames && name === "seedance2.5-g" ? "adaptive" : ratio === "auto" ? series === "G" ? "adaptive" : name === "seedance2.0-a" ? "Auto" : "16:9" : ratio,
        ...(frames ? { image: images[0], ...(images[1] ? { last_frame: images[1] } : {}) } : images.length ? { reference_images: images } : {}),
        ...(videos.length ? { reference_videos: videos } : {}),
        ...(audios.length ? { reference_audios: audios } : {}),
    };
    if (["F", "H3", "G"].includes(series || "")) body.generate_audio = boolConfig(config.videoGenerateAudio, true);
    if (series === "G") body.watermark = boolConfig(config.videoWatermark, false);
    return body;
}

function publicVideoReferenceUrl(value: unknown, errorKey: string) {
    try {
        if (typeof value !== "string" || value !== value.trim()) throw new Error();
        const url = new URL(value);
        if (url.protocol === "https:" && !url.username && !url.password) return url.href;
    } catch { /* The caller reports which reference cannot be submitted. */ }
    throw new Error(i18n.t(`videoReferences.${errorKey}`));
}

function dramaReferencePrompt(prompt: string, images: number, videos: number, audios: number) {
    const mentioned = new Set([...prompt.matchAll(/@(图片|图|视频|音频)([+-]?[0-9]+(?:\.[0-9]+)?)/g)].map((match) => `${match[1] === "图片" ? "图" : match[1]}${match[2]}`));
    const missing = ([["图", images], ["视频", videos], ["音频", audios]] as const).flatMap(([kind, count]) => Array.from({ length: count }, (_, index) => `${kind}${index + 1}`).filter((label) => !mentioned.has(label)).map((label) => `@${label}`));
    return missing.length ? i18n.t("videoReferences.promptPrefix", { labels: missing.join("、"), prompt }) : prompt;
}

function assertVideoSession(epoch: number, signal?: AbortSignal) {
    if (epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
    signal?.throwIfAborted();
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readApiErrorMessage(video.error?.message) || apiText("videoGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    const blob = await readPrivateBlob(url, options?.signal);
    await assertVideoBlob(blob);
    return { blob };
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
}

async function referenceMediaToFile(item: { name: string; type?: string; url?: string; storageKey?: string }, fallbackName: string, errorKey: "invalidReferenceVideo" | "invalidReferenceAudio", options?: RequestOptions) {
    let blob = item.storageKey ? await getMediaBlob(item.storageKey) : null;
    if (!blob) {
        const url = item.storageKey ? await resolveMediaUrl(item.storageKey, item.url || "") : item.url || "";
        if (!url) throw new Error(apiText(errorKey));
        try {
            blob = await readPrivateBlob(url, options?.signal);
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            throw new Error(apiText(errorKey));
        }
    }
    if (!blob.size) throw new Error(apiText(errorKey));
    return new File([blob], item.name || fallbackName, { type: item.type || blob.type || "application/octet-stream" });
}

function normalizeVideoSeconds(value: string) {
    return clampVideoSeconds(value);
}

function resolveVideoMode(mode: string | undefined, imageCount: number) {
    if (mode === "reference" || imageCount > 2) return "reference";
    return "frames";
}

function normalizeVideoSize(value: string, resolution?: string) {
    if (value === "auto") return null;
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value || "16:9");
    if (ratio === "auto") return null;
    return computeVideoSize(resolution || "720", ratio);
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (isManagedMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg = typeof payload.error === "string" ? payload.error : (payload.error as { message?: unknown })?.message;
    return readApiErrorMessage(payload.msg) || readApiErrorMessage(payload.message) || readApiErrorMessage(errorMsg) || readApiErrorMessage(payload.detail) || "";
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return apiText("requestFailed");
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || apiText("videoDownloadFailed"));
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
}

function isManagedMediaUrl(value: string) {
    return /^\/api\/(?:result-media\/[A-Za-z0-9_-]+|ai\/v1\/videos\/[A-Za-z0-9_-]+\/content)$/.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}
