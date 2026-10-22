import "./browser";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { browserTestLocks } from "./browser-storage-fixture";
import { currentSession, endCanvasSession, readCanvasSession } from "../src/services/api/canvas-client";
import * as storage from "../src/services/browser-storage";
import { getDocumentDraft, getDocumentSaveState, readDocument, stageDocument, writeDocument } from "../src/services/canvas-data";
import { logoutCanvas } from "../src/components/layout/client-root-init";
import { getGatewayModelState, hydrateCanvasSession, refreshCanvasModels } from "../src/services/canvas-bootstrap";
import { useCanvasStore } from "../src/stores/canvas/use-canvas-store";
import { useAssetStore } from "../src/stores/use-asset-store";
import { defaultConfig, useConfigStore } from "../src/stores/use-config-store";

const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const session = { user: { id: 1, subject: `ics_${"f".repeat(32)}`, username: "lifecycle-test" }, csrf_token: "csrf", session_tag: "lifecycle-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
let requests: string[];
let models: () => Promise<Response>;
let logout: () => Promise<Response>;
let writeSpy: ReturnType<typeof spyOn> | undefined;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(async () => {
    endCanvasSession();
    localStorage.clear();
    requests = [];
    models = async () => Response.json({ data: [] });
    logout = async () => new Response(null, { status: 204 });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test", locks: browserTestLocks() } });
    globalThis.fetch = (async (input) => {
        const path = String(input);
        requests.push(path);
        if (path === "/api/session") return Response.json(session);
        if (path === "/api/models") return models();
        if (path === "/api/logout") return logout();
        throw new Error(`Unexpected HTTP request ${path}`);
    }) as typeof fetch;
    await readCanvasSession();
    await storage.browserStore(storage.captureBrowserOwner(), "documents").clear();
});

afterEach(() => {
    writeSpy?.mockRestore();
    writeSpy = undefined;
    endCanvasSession();
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
});

test("logout persists debounced canvas edits and other document domains before revoking the session", async () => {
    await useCanvasStore.persist.rehydrate();
    useCanvasStore.getState().createProject("saved before logout");
    useConfigStore.getState().updateConfig("systemPrompt", "keep this setting");
    expect(getDocumentSaveState("canvas").status).toBe("pending");
    await logoutCanvas();
    expect(currentSession()).toBeNull();
    expect(requests.filter((path) => path === "/api/logout")).toHaveLength(1);
    await readCanvasSession();
    const canvas = await storage.readBrowserDocument("canvas");
    const config = await storage.readBrowserDocument("config");
    expect((canvas.value as { state: { projects: { title: string }[] } }).state.projects[0].title).toBe("saved before logout");
    expect((config.value as { state: { config: { systemPrompt: string } } }).state.config.systemPrompt).toBe("keep this setting");
});

test("failed local saving keeps the session and draft, and never submits logout", async () => {
    await readDocument("assets");
    stageDocument("assets", ["unsaved"]);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test" } });
    await expect(logoutCanvas()).rejects.toThrow();
    expect(currentSession()?.session_tag).toBe(session.session_tag);
    expect(getDocumentDraft("assets")).toEqual(["unsaved"]);
    expect(getDocumentSaveState("assets").status).toBe("error");
    expect(requests).not.toContain("/api/logout");
    const event = new Event("pointerdown", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
});

test("logout leaves revision conflicts available for explicit recovery", async () => {
    await storage.writeBrowserDocument("assets", ["original"], 0);
    await readDocument("assets");
    await storage.writeBrowserDocument("assets", ["other tab"], 1);
    stageDocument("assets", ["local draft"]);
    await expect(logoutCanvas()).rejects.toThrow();
    expect(getDocumentSaveState("assets").status).toBe("conflict");
    expect(getDocumentDraft("assets")).toEqual(["local draft"]);
    expect((await storage.readBrowserDocument("assets")).value).toEqual(["other tab"]);
    expect(requests).not.toContain("/api/logout");
});

test("logout drains edits arriving during a save and deduplicates concurrent requests", async () => {
    await readDocument("assets");
    stageDocument("assets", ["first"]);
    const started = deferred<void>(),
        release = deferred<void>();
    const write = storage.writeBrowserDocument;
    writeSpy = spyOn(storage, "writeBrowserDocument").mockImplementationOnce(async (...args: Parameters<typeof write>) => {
        started.resolve();
        await release.promise;
        return write(...args);
    });
    const first = logoutCanvas();
    expect(logoutCanvas()).toBe(first);
    await started.promise;
    const blocked = new Event("keydown", { cancelable: true });
    window.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    stageDocument("assets", ["first", "late edit"]);
    release.resolve();
    await first;
    await readCanvasSession();
    expect((await storage.readBrowserDocument("assets")).value).toEqual(["first", "late edit"]);
    expect(requests.filter((path) => path === "/api/logout")).toHaveLength(1);
});

test("a failed logout request leaves saved content and permits an explicit retry", async () => {
    await writeDocument("assets", ["saved"]);
    logout = async () => Response.json({ error: { message: "temporary failure" } }, { status: 503 });
    await expect(logoutCanvas()).rejects.toThrow("temporary failure");
    expect(currentSession()).not.toBeNull();
    expect(getDocumentSaveState("assets").status).toBe("saved");
    logout = async () => new Response(null, { status: 204 });
    await logoutCanvas();
    expect(currentSession()).toBeNull();
});

test("a model outage does not block local hydration and removes stale callable models", async () => {
    const response = deferred<Response>();
    models = () => response.promise;
    await hydrateCanvasSession(session);
    expect(useCanvasStore.getState().hydrated).toBe(true);
    expect(useAssetStore.getState().hydrated).toBe(true);
    expect(getGatewayModelState().loading).toBe(true);
    useConfigStore.setState({ config: { ...defaultConfig, models: ["gateway::old-model"], channels: [{ id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai", models: [{ name: "old-model", capability: "text" }] }] } });
    const refreshing = refreshCanvasModels();
    response.resolve(Response.json({ error: { message: "models unavailable" } }, { status: 503 }));
    await expect(refreshing).rejects.toThrow("models unavailable");
    expect(currentSession()).not.toBeNull();
    expect(useCanvasStore.getState().hydrated).toBe(true);
    expect(useConfigStore.getState().config.channels).toEqual([]);
    expect(getGatewayModelState()).toEqual({ loading: false, error: "models unavailable" });
    models = async () => Response.json({ data: [{ id: "available-model", supported_endpoint_types: ["openai"] }] });
    await refreshCanvasModels();
    expect(getGatewayModelState()).toEqual({ loading: false, error: "" });
    expect(useConfigStore.getState().config.models).toEqual(["gateway::available-model"]);
});

test("model authentication failure still closes the session and clears local memory", async () => {
    const response = deferred<Response>();
    models = () => response.promise;
    await hydrateCanvasSession(session);
    const refreshing = refreshCanvasModels();
    response.resolve(Response.json({ error: { message: "session revoked" } }, { status: 401 }));
    await expect(refreshing).rejects.toThrow("session revoked");
    expect(currentSession()).toBeNull();
    expect(useCanvasStore.getState().hydrated).toBe(false);
    expect(useAssetStore.getState().assets).toEqual([]);
    expect(getGatewayModelState()).toEqual({ loading: false, error: "" });
});
