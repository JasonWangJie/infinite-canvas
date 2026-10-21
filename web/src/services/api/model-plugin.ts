import i18n from "@/i18n";
import type { AiConfig, ModelCapability } from "@/stores/use-config-store";
export type RunPluginArgs = {
    capability: ModelCapability;
    script: string;
    config: AiConfig;
    prompt?: string;
    images?: string[];
    videos?: File[];
    audios?: File[];
    messages?: unknown[];
    params?: Record<string, unknown>;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
};
export async function runModelPlugin<T = unknown>(_args: RunPluginArgs): Promise<T> {
    throw new Error("受管画布不执行自定义模型脚本");
}
export type PluginVariable = { name: string; type: string; desc: string; capabilities?: ModelCapability[] };
export type PluginTemplate = { label: string; script: string };
export function getPluginVariables(): PluginVariable[] {
    return [];
}
export function getPluginReturn(_capability: ModelCapability) {
    return "";
}
export function getPluginAuthoringPrompt(_capability: ModelCapability, _modelName: string, _draft = "") {
    return "受管画布不执行自定义模型脚本";
}
export function getPluginTemplates(): Record<ModelCapability, PluginTemplate[]> {
    return { image: [], video: [], text: [], audio: [] };
}

/** Normalize whatever an image script returns into the app's generated-image shape. */
export function normalizePluginImages(result: unknown): string[] {
    const items = Array.isArray(result) ? result : [result];
    const urls = items
        .map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object") {
                const record = item as Record<string, unknown>;
                if (typeof record.dataUrl === "string") return record.dataUrl;
                if (typeof record.url === "string") return record.url;
                if (typeof record.b64_json === "string") return `data:image/png;base64,${record.b64_json}`;
            }
            return "";
        })
        .filter(Boolean);
    if (!urls.length) throw new Error(i18n.t("modelPlugin.noImages"));
    return urls;
}
