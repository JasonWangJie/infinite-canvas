import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore, defaultConfig, refreshGatewayModels } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { usePluginStore } from "@/stores/canvas/use-plugin-store";
import { currentSession, onSessionEnd, sessionEpoch, type CanvasSession } from "@/services/api/canvas-client";
import { readDocument } from "@/services/canvas-data";
import i18n from "@/i18n";

let modelState = { loading: false, error: "" };
let modelRequest: Promise<void> | undefined;
const modelListeners = new Set<() => void>();
export const getGatewayModelState = () => modelState;
export function subscribeGatewayModels(listener: () => void) {
    modelListeners.add(listener);
    return () => {
        modelListeners.delete(listener);
    };
}
function publishModels(loading: boolean, error = "") {
    modelState = { loading, error };
    modelListeners.forEach((listener) => listener());
}

export function refreshCanvasModels() {
    if (modelRequest) return modelRequest;
    if (!currentSession()) return Promise.reject(new Error(i18n.t("managed.sessionExpired")));
    const epoch = sessionEpoch();
    publishModels(true, modelState.error);
    const pending = refreshGatewayModels()
        .then(() => {
            if (epoch === sessionEpoch()) publishModels(false);
        })
        .catch((error) => {
            if (epoch === sessionEpoch() && currentSession()) {
                useConfigStore.setState((state) => ({ config: { ...state.config, channels: [], models: [] } }));
                publishModels(false, error instanceof Error ? error.message : String(error));
            }
            throw error;
        })
        .finally(() => {
            if (modelRequest === pending) modelRequest = undefined;
        });
    modelRequest = pending;
    return pending;
}

onSessionEnd(() => {
    modelRequest = undefined;
    publishModels(false);
    useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
    useAssetStore.setState({ assets: [], hydrated: false });
    useConfigStore.setState({ config: defaultConfig, isConfigOpen: false });
    usePluginStore.setState({ plugins: [] });
    useUserStore.getState().clearSession();
});

export async function hydrateCanvasSession(session: CanvasSession) {
    useUserStore.setState({ user: { id: session.user.subject, username: session.user.username, displayName: session.user.display_name || session.user.username, avatarUrl: "" } });
    await Promise.all(["canvas", "assets", "config", "plugin-state", "image-workbench", "video-workbench"].map(readDocument));
    await Promise.all([useCanvasStore.persist.rehydrate(), useAssetStore.persist.rehydrate(), useConfigStore.persist.rehydrate(), usePluginStore.persist.rehydrate()]);
    // Local documents remain usable when the model gateway is temporarily unavailable.
    void refreshCanvasModels().catch(() => {});
}
