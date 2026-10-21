import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore, defaultConfig, refreshGatewayModels } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { usePluginStore } from "@/stores/canvas/use-plugin-store";
import { onSessionEnd, type CanvasSession } from "@/services/api/canvas-client";
import { readDocument } from "@/services/canvas-data";

onSessionEnd(() => {
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
    await refreshGatewayModels();
}
