import { nanoid } from "nanoid";
import { create } from "zustand";
import { currentSession, onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

export const CANVAS_ASSET_DRAG_TYPE = "application/x-infinite-canvas-asset";

type CanvasAssetDrag = { token: string; assetId: string; epoch: number };
const useCanvasAssetDragStore = create<{ drag: CanvasAssetDrag | null }>(() => ({ drag: null }));

export function cancelCanvasAssetDrag(): void {
    useCanvasAssetDragStore.setState({ drag: null });
}

onSessionEnd(cancelCanvasAssetDrag);

export function startCanvasAssetDrag(assetId: string): string | null {
    cancelCanvasAssetDrag();
    const { assets, hydrated } = useAssetStore.getState();
    if (!currentSession() || !hydrated || !assets.some((asset) => asset.id === assetId)) return null;
    const token = nanoid();
    useCanvasAssetDragStore.setState({ drag: { token, assetId, epoch: sessionEpoch() } });
    return token;
}

// DataTransfer carries only this same-session token; resolve current asset data once at drop.
export function takeCanvasAssetDrag(token: string): Asset | null {
    const drag = useCanvasAssetDragStore.getState().drag;
    if (!drag || drag.token !== token || drag.epoch !== sessionEpoch() || !currentSession()) return null;
    cancelCanvasAssetDrag();
    const { assets, hydrated } = useAssetStore.getState();
    return hydrated ? assets.find((asset) => asset.id === drag.assetId) || null : null;
}
