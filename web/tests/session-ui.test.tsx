import "./browser";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, lazy, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { browser } from "./browser";
import { mockBrowserDocuments } from "./local-document-fixture";
import { ClientRootInit, logoutCanvas } from "../src/components/layout/client-root-init";
import { AppConfigPanel } from "../src/components/layout/app-config-modal";
import { endCanvasSession, readCanvasSession } from "../src/services/api/canvas-client";
import { stageDocument, flushDocument, getDocumentDraft, getDocumentSaveState, readDocument } from "../src/services/canvas-data";
import { routes } from "../src/router";
import i18n from "../src/i18n";

const originalFetch = globalThis.fetch;
const session = { user: { id: 1, subject: `ics_${"f".repeat(32)}`, username: "local-ui" }, csrf_token: "csrf", session_tag: "ui-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
let root: Root;
let container: HTMLDivElement;
let documents: ReturnType<typeof mockBrowserDocuments>;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let oldMatchMedia: typeof browser.matchMedia;
let models: () => Promise<Response>;
let saveFails: boolean;
let modelCalls: number;
let savedAtLogout: unknown;
let consoleError: ReturnType<typeof spyOn> | undefined;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(() => {
    endCanvasSession();
    localStorage.clear();
    documents = mockBrowserDocuments();
    models = async () => Response.json({ data: [] });
    modelCalls = 0;
    saveFails = false;
    savedAtLogout = undefined;
    const globals = {
        HTMLElement: browser.HTMLElement,
        HTMLAnchorElement: browser.HTMLAnchorElement,
        SVGElement: browser.SVGElement,
        Element: browser.Element,
        ShadowRoot: browser.ShadowRoot,
        DocumentFragment: browser.DocumentFragment,
        Node: browser.Node,
        MutationObserver: browser.MutationObserver,
        navigator: browser.navigator,
        getComputedStyle: browser.getComputedStyle.bind(browser),
        IS_REACT_ACT_ENVIRONMENT: true,
        requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
        cancelAnimationFrame: clearTimeout,
        ResizeObserver: class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    };
    descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    oldMatchMedia = browser.matchMedia;
    browser.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, media: "", onchange: null });
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/session") return Response.json(session);
        if (path === "/api/models") {
            modelCalls += 1;
            return models();
        }
        if (path === "/api/logout") {
            savedAtLogout = { draft: getDocumentDraft("assets"), status: getDocumentSaveState("assets").status };
            return new Response(null, { status: 204 });
        }
        if (path.startsWith("/api/data/")) {
            if (init?.method === "PUT" && saveFails) return Response.json({ error: { message: "local write failed" } }, { status: 503 });
            const body = init?.method === "PUT" ? JSON.parse(String(init.body)) : null;
            return Response.json(body ? { value: body.value, revision: body.revision + 1 } : { value: null, revision: 0 });
        }
        throw new Error(`Unexpected HTTP request ${path}`);
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    endCanvasSession();
    documents.restore();
    consoleError?.mockRestore();
    consoleError = undefined;
    globalThis.fetch = originalFetch;
    browser.matchMedia = oldMatchMedia;
    for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

async function render(children: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    await act(async () =>
        root.render(
            <ConfigProvider theme={{ token: { motion: false } }}>
                <App>
                    <QueryClientProvider client={client}>{children}</QueryClientProvider>
                </App>
            </ConfigProvider>,
        ),
    );
}

test("authenticated local content stays visible during a model outage and retry recovers without navigation", async () => {
    const response = deferred<Response>();
    models = () => response.promise;
    await render(
        <ClientRootInit>
            <div>local content</div>
        </ClientRootInit>,
    );
    expect(container.textContent).toContain("local content");
    await act(async () => response.resolve(Response.json({ error: { message: "models unavailable" } }, { status: 503 })));
    expect(container.textContent).toContain("local content");
    expect(container.textContent).toContain("models unavailable");
    models = async () => Response.json({ data: [] });
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === i18n.t("managed.refreshModels"));
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(container.textContent).not.toContain("models unavailable");
    expect(modelCalls).toBe(2);
});

test("configuration exposes local storage separately without inventing account quota data", async () => {
    await readCanvasSession();
    await render(<AppConfigPanel />);
    const tab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((element) => element.textContent === i18n.t("config.localStorage.title"));
    expect(tab).toBeDefined();
    await act(async () => tab!.click());
    expect(container.textContent).toContain(i18n.t("config.localStorage.description"));
});

test("logout commits blur-driven React state and its saving effect before submitting logout", async () => {
    await readCanvasSession();
    await readDocument("assets");
    function Editor() {
        const [value, setValue] = useState("original");
        useEffect(() => { stageDocument("assets", [value]); }, [value]);
        return <input defaultValue="edited title" onBlur={(event) => setValue(event.target.value)} />;
    }
    await render(<Editor />);
    await flushDocument("assets");
    await act(async () => container.querySelector("input")!.focus());
    await act(async () => { await logoutCanvas(); });
    expect(savedAtLogout).toEqual({ draft: ["edited title"], status: "saved" });
});

test("lazy route loading and failure keep recovery visible and home navigation clears the error", async () => {
    await readCanvasSession();
    await readDocument("assets");
    stageDocument("assets", ["draft"]);
    saveFails = true;
    await expect(flushDocument("assets")).rejects.toThrow("local write failed");
    const pending = deferred<{ default: () => React.ReactNode }>();
    const Slow = lazy(() => pending.promise);
    const Broken = lazy(async () => {
        throw new Error("test chunk unavailable");
    });
    const layout = routes[0];
    const boundary = layout.children![0];
    const router = createMemoryRouter(
        [
            {
                ...layout,
                children: [
                    {
                        ...boundary,
                        children: [
                            { path: "/slow", element: <Slow /> },
                            { path: "/broken", element: <Broken /> },
                            { path: "/", element: <div>home works</div> },
                        ],
                    },
                ],
            },
        ],
        { initialEntries: ["/slow"] },
    );
    await render(<RouterProvider router={router} />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(i18n.t("navigation.loadingPage", { defaultValue: "正在加载页面…" }));
    expect(container.querySelector("#document-save-recovery")).not.toBeNull();
    await act(async () => pending.resolve({ default: () => <div>page ready</div> }));
    expect(container.textContent).toContain("page ready");
    consoleError = spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
        await router.navigate("/broken");
    });
    expect(container.textContent).toContain(i18n.t("navigation.pageLoadFailed", { defaultValue: "页面加载失败" }));
    expect(container.querySelector("#document-save-recovery")).not.toBeNull();
    await act(async () => {
        await router.navigate("/");
    });
    expect(container.textContent).toContain("home works");
    expect(container.textContent).not.toContain(i18n.t("navigation.pageLoadFailed", { defaultValue: "页面加载失败" }));
    expect(router.state.location.pathname).toBe("/");
});
