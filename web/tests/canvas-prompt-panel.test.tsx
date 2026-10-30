import { browser } from "./browser";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "../src/i18n";
import { CanvasNodePromptPanel } from "../src/components/canvas/canvas-node-prompt-panel";
import { defaultConfig, useConfigStore } from "../src/stores/use-config-store";
import type { CanvasImageTaskState, CanvasNodeData } from "../src/types/canvas";

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let previousMatchMedia: typeof browser.matchMedia;
const previousConfig = useConfigStore.getState().config;

beforeEach(() => {
    const globals = {
        IS_REACT_ACT_ENVIRONMENT: true,
        HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
        HTMLTextAreaElement: browser.HTMLTextAreaElement, HTMLSelectElement: browser.HTMLSelectElement,
        SVGElement: browser.SVGElement, ShadowRoot: browser.ShadowRoot,
        DocumentFragment: browser.DocumentFragment, navigator: browser.navigator,
        ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
        requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    };
    descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    previousMatchMedia = browser.matchMedia;
    browser.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, media: "", onchange: null });
    useConfigStore.setState({ config: { ...defaultConfig, model: "gateway::image-model", imageModel: "gateway::image-model", models: ["gateway::image-model"], channels: [{ id: "gateway", name: "New API", baseUrl: "/api/ai", apiKey: "", apiFormat: "openai", models: [{ name: "image-model", capability: "image", endpointTypes: ["image-generation"], imageExecution: { sync: true, async: true } }] }] } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient();
});

afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    useConfigStore.setState({ config: previousConfig });
    browser.matchMedia = previousMatchMedia;
    for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function node(metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id: "image", type: "image", title: "image", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { model: "gateway::image-model", prompt: "a tree", ...metadata } };
}

async function renderPanel(value: CanvasNodeData, onGenerate = () => {}, onConfigChange = () => {}, isRunning = false) {
    const panel: ReactNode = <CanvasNodePromptPanel node={value} nodes={[value]} isRunning={isRunning} onPromptChange={() => {}} onConfigChange={onConfigChange} onGenerate={onGenerate} onStop={() => {}} />;
    await act(async () => root.render(<QueryClientProvider client={queryClient}><ConfigProvider theme={{ token: { motion: false } }}><App>{panel}</App></ConfigProvider></QueryClientProvider>));
}

test("the expanded image editor shows its model and submits the current prompt by button or modifier shortcut without submitting plain Enter or IME", async () => {
    const calls: unknown[][] = [];
    await renderPanel(node(), (...args: unknown[]) => { calls.push(args); });
    const inputLabel = i18n.t("canvas.promptPanel.promptLabel", { mode: i18n.t("canvas.nodeTypes.image") });
    expect(container.querySelector("[role='textbox']")?.getAttribute("aria-label")).toBe(inputLabel);
    const mainGenerate = container.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("canvas.promptPanel.generateMode", { mode: i18n.t("canvas.nodeTypes.image") })}']`)!;
    expect(mainGenerate.textContent).toBe(mainGenerate.getAttribute("aria-label"));
    await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("canvas.promptPanel.expandEditor")}']`)!.click());
    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    expect(dialog.textContent).toContain(i18n.t("canvas.promptPanel.expandedTitle", { mode: i18n.t("canvas.nodeTypes.image") }));
    expect(dialog.textContent).toContain("image-model");
    const editor = dialog.querySelector<HTMLElement>("[role='textbox']")!;
    expect(editor.getAttribute("aria-label")).toBe(inputLabel);
    await act(async () => {
        editor.textContent = "a revised tree";
        editor.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    for (const init of [{ key: "Enter" }, { key: "Enter", shiftKey: true }, { key: "Enter", ctrlKey: true, isComposing: true }]) {
        await act(async () => { editor.dispatchEvent(new browser.KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true })); });
    }
    expect(calls).toEqual([]);
    await act(async () => { editor.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })); });
    const generate = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === i18n.t("canvas.promptPanel.generateMode", { mode: i18n.t("canvas.nodeTypes.image") }))!;
    await act(async () => generate.click());
    expect(calls).toEqual([["image", "image", "a revised tree"], ["image", "image", "a revised tree"]]);
});

test("an in-flight foreground image request announces generation before its saved pending task state", async () => {
    await renderPanel(node({ imageTaskRecordId: "intent", imageTaskState: "pending" }), () => {}, () => {}, true);
    expect(container.querySelector("[role='status']")?.textContent).toBe(i18n.t("canvas.node.generating"));
    const stop = container.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("canvas.promptPanel.stop")}']`)!;
    expect(stop.textContent).toBe(stop.getAttribute("aria-label"));
    expect(stop.disabled).toBe(false);
});

test("a model with only async image execution blocks synchronous generation and keeps the selectable async switch", async () => {
    const config = useConfigStore.getState().config;
    useConfigStore.setState({ config: { ...config, channels: [{ ...config.channels[0], models: [{ ...config.channels[0].models[0], imageExecution: { sync: false, async: true } }] }] } });
    const changes: unknown[][] = [];
    await renderPanel(node(), () => {}, (...args: unknown[]) => { changes.push(args); });
    expect(container.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("canvas.promptPanel.generateMode", { mode: i18n.t("canvas.nodeTypes.image") })}']`)!.disabled).toBe(true);
    expect(container.querySelector("[role='status']")?.textContent).toBe(i18n.t("managed.imageExecutionUnsupported"));
    const checkbox = container.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(false);
    await act(async () => checkbox.click());
    expect(changes).toEqual([["image", { imageAsync: true }]]);
    await renderPanel(node({ imageAsync: true }));
    expect(container.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("canvas.promptPanel.generateMode", { mode: i18n.t("canvas.nodeTypes.image") })}']`)!.disabled).toBe(false);
});

test.each([
    ["pending", "managed.resumeImage"], ["storage_failed", "managed.recoverImage"],
    ["unknown", "managed.verifyImageTask"], ["failed", "managed.regenerateImageTask"],
] as const)("the %s task action remains distinct and only a new generation requires an available model", async (state: CanvasImageTaskState, action) => {
    useConfigStore.setState({ config: { ...defaultConfig, channels: [], models: [] } });
    const calls: unknown[][] = [];
    await renderPanel(node({ prompt: "", imageTaskRecordId: "original", imageTaskState: state }), (...args: unknown[]) => { calls.push(args); });
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t(action)}']`)!;
    expect(button.disabled).toBe(state === "failed");
    expect(container.querySelector("[role='status']")?.textContent).not.toBe("");
    await act(async () => button.click());
    expect(calls).toHaveLength(state === "failed" ? 0 : 1);
});

test.each([["pending", "managed.queryAllImages"], ["storage_failed", "managed.recoverAllImages"]] as const)("the batch %s action is available inside the prompt panel without a current model", async (state, action) => {
    useConfigStore.setState({ config: { ...defaultConfig, channels: [], models: [] } });
    const calls: unknown[][] = [];
    await renderPanel(node({ prompt: "", images: [1, 2].map((id) => ({ id: String(id), status: "error", imageTaskRecordId: `intent-${id}`, imageTaskState: state })) }), (...args: unknown[]) => { calls.push(args); });
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t(action)}']`)!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(calls).toEqual([["image", "image", ""]]);
});
