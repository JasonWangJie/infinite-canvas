import { create } from "zustand";
import type { CanvasResultPlacement } from "@/lib/canvas/result-to-canvas";
import { currentSession, onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";

const useResultPlacementHandoffStore = create<{ placement: CanvasResultPlacement | null }>(() => ({ placement: null }));
onSessionEnd(() => useResultPlacementHandoffStore.setState({ placement: null }));

// A one-time, same-session handoff; the receipt never enters persisted canvas data or browser history.
export function handoffResultPlacement(placement: CanvasResultPlacement) {
    if (!currentSession() || placement.sessionEpoch !== sessionEpoch()) return;
    useResultPlacementHandoffStore.setState({ placement: structuredClone(placement) });
}

export function takeResultPlacementHandoff(projectId: string) {
    const placement = useResultPlacementHandoffStore.getState().placement;
    if (!placement || placement.projectId !== projectId || placement.sessionEpoch !== sessionEpoch() || !currentSession()) return null;
    useResultPlacementHandoffStore.setState({ placement: null });
    return placement;
}
