import type { StateStorage } from "zustand/middleware";
import { readDocument, writeDocument } from "@/services/canvas-data";

const domains: Record<string, string> = {
    "infinite-canvas:canvas_store": "canvas",
    "infinite-canvas:asset_store": "assets",
    "infinite-canvas:plugin_store": "plugin-state",
    "infinite-canvas:ai_config_store": "config",
};

// Historical import name; business state is owner-checked by the BFF.
export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        const value = await readDocument(domains[name]);
        return value == null ? null : JSON.stringify(value);
    },
    setItem: async (name, value) => {
        await writeDocument(domains[name], JSON.parse(value));
    },
    removeItem: async (name) => {
        await writeDocument(domains[name], null);
    },
};
