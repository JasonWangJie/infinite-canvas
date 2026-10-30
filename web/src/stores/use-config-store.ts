import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
import { canvasJson, currentSession } from "@/services/api/canvas-client";

export type ApiCallFormat = "openai" | "gemini";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";
export type ImageExecution = { sync: boolean; async: boolean; syncEndpoint?: "image-generation" | "gemini" };

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    script?: string;
    capabilities?: ModelCapability[];
    endpointTypes?: string[];
    imageExecution?: ImageExecution;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    imageAsync?: boolean;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoMode: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    size: string;
    background: string;
    count: string;
    canvasImageCount: string;
    proxyEnabled: boolean;
    proxyUrl: string;
    nodeRegenerateBehavior: "new-node" | "overwrite";
    autoFocusOnSelect: boolean;
    textApi?: "responses" | "chat";
};

export type WebdavSyncConfig = {
    url: string;
    username: string;
    password: string;
    directory: string;
    lastSyncedAt: string;
};
export type ConfigTabKey = "channels" | "local-proxy" | "preferences" | "prompt-sources" | "webdav" | "local-storage";

export type ChannelCredentialsImportResult = {
    status: "created" | "updated" | "missing-base-url" | "invalid-base-url";
    channelName?: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "/api/ai";
const GEMINI_BASE_URL = "/api/ai";
export const LOCAL_PROXY_PACKAGE = "@basketikun/canvas-proxy";
export const DEFAULT_LOCAL_PROXY_URL = "http://127.0.0.1:23210";

export const defaultConfig: AiConfig = {
    channelMode: "remote",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    channels: [],
    model: "default::gpt-image-2",
    imageModel: "default::gpt-image-2",
    videoModel: "default::grok-imagine-video",
    textModel: "default::gpt-5.5",
    audioModel: "default::gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoMode: "frames",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: [],
    quality: "auto",
    size: "1:1",
    background: "",
    count: "1",
    canvasImageCount: "3",
    proxyEnabled: false,
    proxyUrl: DEFAULT_LOCAL_PROXY_URL,
    nodeRegenerateBehavior: "new-node",
    autoFocusOnSelect: false,
};

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    url: "",
    username: "",
    password: "",
    directory: "infinite-canvas",
    lastSyncedAt: "",
};

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    importChannelCredentials: (input: { baseUrl?: string | null; apiKey?: string | null }) => ChannelCredentialsImportResult;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

const VIDEO_KEYWORDS = ["video", "sora", "veo", "kling", "wan", "hailuo", "seedance", "minimax-h3"];

export function boolConfig(value: string, fallback: boolean) {
    return value ? value === "true" : fallback;
}
const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney", "nano-banana"];

/** Best-effort default capability for a freshly fetched model name; user can override in the channel editor. */
export function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
    if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
    if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    const model = findChannelModel(config, value)?.model;
    return Boolean(model && modelSupportsCapability(model, capability));
}

function isDedicatedMediaModel(name: string) {
    return guessCapability(name) === "video" || /^(?:.*\/)?(?:gpt-image|image|dall-e|dalle|seedream|imagen|flux|sdxl|stable-diffusion|midjourney|qwen-image|nano-banana|gemini-(?:nano-banana|[\d.]+-(?:pro|flash)-image))(?:[-.]|$)/i.test(name);
}

function modelSupportsCapability(model: ChannelModel, capability: ModelCapability) {
    return (capability !== "text" || (!model.endpointTypes?.includes("openai-video") && !isDedicatedMediaModel(model.name))) && (model.capabilities || [model.capability]).includes(capability);
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    for (const model of [currentModel, defaultModel]) {
        if (!model) continue;
        const configuredCapability = modelCapabilityOf(config, model);
        // Keep unavailable selections visible so the readiness check blocks the
        // request. Only a known capability switch may choose another model.
        if (!configuredCapability || modelMatchesCapability(config, model, capability)) return model;
    }
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => modelSupportsCapability(model, capability)).map((model) => encodeChannelModel(channel.id, model.name)));
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    void config;
    void value;
    return "";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const match = findChannelModel(config, model);
    return Boolean(currentSession() && match);
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            isConfigOpen: false,
            configTab: "channels",
            shouldPromptContinue: false,
            updateConfig: (key, value) => {
                if (["baseUrl", "apiKey", "channels", "models", "apiFormat", "channelMode", "proxyEnabled", "proxyUrl"].includes(key)) return;
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                }));
            },
            importChannelCredentials: (input) => {
                void input;
                return { status: "invalid-base-url" };
            },
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: value,
                    },
                })),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false) => set({ isConfigOpen: true, shouldPromptContinue, configTab: "preferences" }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            storage: createJSONStorage(() => localForageStorage),
            skipHydration: true,
            partialize: (state) => ({ config: { ...state.config, channels: [], models: [], baseUrl: "", apiKey: "", proxyEnabled: false, proxyUrl: "" } }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const managedConfig = { ...current.config };
                for (const key of Object.keys(persistedConfig) as Array<keyof AiConfig>) {
                    if (!["baseUrl", "apiKey", "channels", "models", "apiFormat", "channelMode", "proxyEnabled", "proxyUrl"].includes(key)) (managedConfig as unknown as Record<string, unknown>)[key] = persistedConfig[key];
                }
                return { ...current, config: managedConfig, webdav: defaultWebdavSyncConfig };
            },
        },
    ),
);

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "remote" as const }), [config]);
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const script = typeof item === "string" ? undefined : item.script?.trim() || undefined;
        result.push({ name, capability, script, ...(typeof item === "string" ? {} : { capabilities: item.capabilities, endpointTypes: item.endpointTypes, imageExecution: item.imageExecution }) });
    }
    return result;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || i18n.t("config.channels.newName"),
        baseUrl: "/api/ai",
        apiKey: "",
        apiFormat,
        models: normalizeChannelModels(channel?.models),
    };
}

export function upsertChannelCredentials(config: AiConfig, _input: { baseUrl?: string | null; apiKey?: string | null }): ChannelCredentialsImportResult & { config: AiConfig } {
    return { status: "invalid-base-url", config };
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return channel ? `${decoded.model}（${channel.name}）` : decoded.model;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.some((item) => item.name === decoded.model) ? model : "";
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return (
        matched ||
        config.channels[0] ||
        createModelChannel({
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            apiFormat: config.apiFormat,
            models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })),
        })
    );
}

export function supportsAsyncImageGeneration(config: AiConfig, value: string) {
    return supportsImageGeneration(config, value, "async");
}

export function supportsImageGeneration(config: AiConfig, value: string, operation: "sync" | "async" = "sync") {
    const model = findChannelModel(config, value)?.model;
    if (!model || !modelSupportsCapability(model, "image") || model.imageExecution?.[operation] === false) return false;
    const endpoints = model.endpointTypes || [];
    return operation === "async" ? endpoints.includes("image-generation") : model.imageExecution?.syncEndpoint ? endpoints.includes(model.imageExecution.syncEndpoint) : endpoints.some((type) => type === "image-generation" || type === "gemini");
}

export function resolveModelRequestConfig(config: AiConfig, value: string, capability: ModelCapability, operation?: "async") {
    const match = findChannelModel(useConfigStore.getState().config, value);
    if (!currentSession() || !match) throw new Error("当前用户无权调用所选模型，请刷新模型列表");
    if (!modelSupportsCapability(match.model, capability)) throw new Error(i18n.t("managed.modelOperationMismatch"));
    if (capability === "image" && !supportsImageGeneration(useConfigStore.getState().config, value, operation || "sync")) throw new Error(i18n.t("managed.imageExecutionUnsupported"));
    const endpoints = match.model.endpointTypes || [];
    const supported = capability === "image" ? operation === "async" ? ["image-generation"] : match.model.imageExecution?.syncEndpoint ? [match.model.imageExecution.syncEndpoint] : ["image-generation", "gemini"] : capability === "text" ? ["openai-response", "openai", "gemini"] : capability === "video" ? ["openai-video"] : ["openai"];
    const endpoint = supported.find((type) => endpoints.includes(type));
    if (!endpoint) throw new Error(operation === "async" ? i18n.t("managed.asyncImageModelRequired") : "当前模型不支持所选调用接口，请刷新模型列表");
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: "/api/ai",
        apiKey: "",
        apiFormat: (endpoint === "gemini" ? "gemini" : "openai") as ApiCallFormat,
        textApi: (endpoint === "openai" ? "chat" : "responses") as "chat" | "responses",
    };
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    return OPENAI_BASE_URL;
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" ? apiFormat : "openai";
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function buildApiUrl(_baseUrl: string, path: string) {
    if (!/^\/(responses|chat\/completions|images\/(?:generations|edits)(?:_async)?|(?:images|media)\/tasks_async\/[A-Za-z0-9_-]+(?:\/content\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127})?|audio\/speech|videos(?:\/[^/?#]+(?:\/content)?)?)$/.test(path))
        throw new Error("不支持的网关接口");
    return `/api/ai/v1${path}`;
}

export function normalizeLocalProxyUrl(value: string) {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Prefix an outgoing request with the local forwarding proxy so the browser is not blocked by CORS. */
export function withLocalProxy(url: string) {
    if (/^(?:data:|blob:|\/api\/)/.test(url)) return url;
    throw new Error("受管画布禁止外部代理或模型直连");
}

export async function refreshGatewayModels() {
    const payload = await canvasJson<{ data?: Array<{ id?: string; supported_endpoint_types?: string[]; image_execution?: { sync: boolean; async: boolean; sync_endpoint?: "image-generation" | "gemini" } }> }>("/api/models");
    const models: ChannelModel[] = (payload.data || [])
        .filter((item): item is typeof item & { id: string } => Boolean(item.id))
        .map((item) => {
            const endpoints = item.supported_endpoint_types || [];
            const execution = item.image_execution;
            if (execution !== undefined && (!execution || typeof execution.sync !== "boolean" || typeof execution.async !== "boolean" || execution.sync_endpoint !== undefined && !["image-generation", "gemini"].includes(execution.sync_endpoint))) throw new Error(i18n.t("managed.loadFailed"));
            const capabilities: ModelCapability[] = [];
            const capability = guessCapability(item.id);
            if (execution || endpoints.includes("image-generation") || (endpoints.includes("gemini") && capability === "image")) capabilities.push("image");
            if (endpoints.includes("openai-video")) capabilities.push("video");
            if (endpoints.includes("openai") && capability === "audio") capabilities.push("audio");
            if (!endpoints.includes("openai-video") && !isDedicatedMediaModel(item.id) && (endpoints.includes("openai-response") || endpoints.includes("gemini") || (endpoints.includes("openai") && capability !== "audio"))) capabilities.push("text");
            if (!endpoints.length) capabilities.push(capability);
            return { name: item.id, capability, capabilities, endpointTypes: endpoints, imageExecution: execution ? { sync: execution.sync, async: execution.async, syncEndpoint: execution.sync_endpoint } : undefined };
        });
    useConfigStore.setState((state) => {
        const channel: ModelChannel = { id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai", models };
        const channels = [channel];
        const next = { ...state.config, channelMode: "remote" as const, baseUrl: "/api/ai", apiKey: "", apiFormat: "openai" as const, proxyEnabled: false, proxyUrl: "", channels, models: modelOptionsFromChannels(channels) };
        for (const [key, capability] of [
            ["imageModel", "image"],
            ["textModel", "text"],
            ["videoModel", "video"],
            ["audioModel", "audio"],
        ] as const) {
            const selected = normalizeModelOptionValue(next[key], channels);
            next[key] = selected && modelMatchesCapability(next, selected, capability) ? selected : next.models.find((value) => modelMatchesCapability(next, value, capability)) || "";
        }
        next.model = next.imageModel;
        return { config: next };
    });
    return models;
}
