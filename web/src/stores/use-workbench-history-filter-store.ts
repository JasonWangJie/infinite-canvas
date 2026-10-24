import { create } from "zustand";
import { onSessionEnd } from "@/services/api/canvas-client";

export type WorkbenchKind = "image" | "video";
export type HistoryFilter = { query: string; status: "all" | "success" | "failed" | "pending" | "paused" | "unknown" | "attention" };
const emptyFilter: HistoryFilter = { query: "", status: "all" };

// Filters belong to the current signed-in session; prompts are never persisted here.
export const useWorkbenchHistoryFilterStore = create<{
    image: HistoryFilter;
    video: HistoryFilter;
    update: (kind: WorkbenchKind, patch: Partial<HistoryFilter>) => void;
}>((set) => ({
    image: emptyFilter,
    video: emptyFilter,
    update: (kind, patch) => set((state) => ({ [kind]: { ...state[kind], ...patch } })),
}));

onSessionEnd(() => useWorkbenchHistoryFilterStore.setState({ image: emptyFilter, video: emptyFilter }));
