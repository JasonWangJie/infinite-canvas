import { create } from "zustand";
import { onSessionEnd } from "@/services/api/canvas-client";
import type { AssetKind } from "@/stores/use-asset-store";

type AssetLibraryView = { keyword: string; kindFilter: AssetKind | "all"; page: number; pageSize: number };
const initialView: AssetLibraryView = { keyword: "", kindFilter: "all", page: 1, pageSize: 10 };

export const useAssetLibraryViewStore = create<AssetLibraryView & { setView: (view: Partial<AssetLibraryView>) => void }>((set) => ({
    ...initialView,
    setView: (view) => set(view),
}));

onSessionEnd(() => useAssetLibraryViewStore.setState(initialView));
