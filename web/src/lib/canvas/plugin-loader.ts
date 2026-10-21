import { registerNodeDefinitions, unregisterPluginNodes } from "@/lib/canvas/node-registry";
import { getPluginRuntime } from "@/lib/canvas/plugin-runtime";
import { usePluginStore, type InstalledPlugin } from "@/stores/canvas/use-plugin-store";
import type { CanvasPlugin } from "@/types/canvas-plugin";
import { currentSession, onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";

// Source imports are bundled into the application; persisted source and arbitrary URLs are never evaluated.
const trustedLoaders = {
    svg: () => import("../../../../plugins/canvas/svg/src/index"),
    markdown: () => import("../../../../plugins/canvas/markdown/src/index"),
    "sticky-note": () => import("../../../../plugins/canvas/sticky-note/src/index"),
    html: () => import("../../../../plugins/canvas/html/src/index"),
};
const cleanups = new Map<string, () => void>();
let loaded = false;
export function activatePlugin(plugin: CanvasPlugin) {
    registerNodeDefinitions(plugin.nodes, plugin.id);
    const runtime = getPluginRuntime();
    const css = plugin.css ? runtime.injectCSS(plugin.css, plugin.id) : undefined;
    const cleanup = plugin.setup?.(runtime);
    cleanups.set(plugin.id, () => {
        css?.();
        if (typeof cleanup === "function") cleanup();
    });
}
export function deactivatePlugin(id: string) {
    cleanups.get(id)?.();
    cleanups.delete(id);
    unregisterPluginNodes(id);
}
export async function installPluginFromUrl(_url: string, _opts?: { official?: boolean; bustCache?: boolean }): Promise<CanvasPlugin> {
    throw new Error("受管画布只启用随应用构建的可信插件");
}
export async function updatePlugin(_record: InstalledPlugin): Promise<CanvasPlugin> {
    throw new Error("可信插件随画布版本统一升级");
}
export async function setPluginEnabled(record: InstalledPlugin, enabled: boolean) {
    if (!(record.id in trustedLoaders)) throw new Error("插件不在可信清单中");
    const epoch = sessionEpoch();
    usePluginStore.getState().setEnabled(record.id, enabled);
    deactivatePlugin(record.id);
    if (enabled) {
        const plugin = (await trustedLoaders[record.id as keyof typeof trustedLoaders]()).default as CanvasPlugin;
        if (currentSession() && epoch === sessionEpoch()) activatePlugin(plugin);
    }
}
export function uninstallPlugin(id: string) {
    deactivatePlugin(id);
    usePluginStore.getState().setEnabled(id, false);
}
export async function ensurePluginsLoaded() {
    if (loaded || !currentSession()) return;
    const epoch = sessionEpoch();
    loaded = true;
    getPluginRuntime();
    for (const [id, load] of Object.entries(trustedLoaders)) {
        const plugin = (await load()).default as CanvasPlugin;
        if (!currentSession() || epoch !== sessionEpoch()) return;
        const enabled = usePluginStore.getState().plugins.find((item) => item.id === id)?.enabled ?? true;
        usePluginStore.getState().upsert({ id, name: plugin.name || id, version: plugin.version || "", description: plugin.description, enabled, url: "", source: "", local: true, official: true });
        if (enabled) activatePlugin(plugin);
    }
}
onSessionEnd(() => {
    for (const id of cleanups.keys()) deactivatePlugin(id);
    loaded = false;
});
