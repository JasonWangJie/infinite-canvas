import { createRecordStore } from "@/services/canvas-data";
import { onSessionEnd } from "@/services/api/canvas-client";

import type { PluginStorage } from "@/types/canvas-plugin";

// Lightweight canvas event bus for communication between nodes and plugins.
type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

export function emitCanvasEvent(event: string, payload?: unknown) {
    handlers.get(event)?.forEach((handler) => {
        try {
            handler(payload);
        } catch (error) {
            console.error(`[canvas-event] handler for "${event}" failed`, error);
        }
    });
}

export function onCanvasEvent(event: string, handler: Handler) {
    let set = handlers.get(event);
    if (!set) {
        set = new Set();
        handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
}

const store = createRecordStore("plugin-data");
onSessionEnd(() => handlers.clear());

export function createPluginStorage(pluginId: string): PluginStorage {
    return {
        get: (key) => store.getItem(`${pluginId}:${key}`),
        set: async (key, value) => {
            await store.setItem(`${pluginId}:${key}`, value);
        },
        remove: async (key) => {
            await store.removeItem(`${pluginId}:${key}`);
        },
    };
}
