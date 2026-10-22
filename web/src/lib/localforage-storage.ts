import type { StateStorage } from "zustand/middleware";
import { readDocument, writeDocument } from "@/services/canvas-data";
import { currentSession } from "@/services/api/canvas-client";

const domains: Record<string, string> = {
    "infinite-canvas:canvas_store": "canvas",
    "infinite-canvas:asset_store": "assets",
    "infinite-canvas:plugin_store": "plugin-state",
    "infinite-canvas:ai_config_store": "config",
};

// Browser documents are partitioned by the current account and revision-checked across tabs.
export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        const value = await readDocument(domains[name]);
        return value == null ? null : JSON.stringify(value);
    },
    setItem: async (name, value) => {
        // Zustand does not await storage writes. The save service retains the draft
        // and exposes failures to the recovery UI; session cleanup must never persist.
        if (!currentSession()) return;
        await writeDocument(domains[name], JSON.parse(value)).catch(() => {});
    },
    removeItem: async (name) => {
        if (!currentSession()) return;
        await writeDocument(domains[name], null).catch(() => {});
    },
};
