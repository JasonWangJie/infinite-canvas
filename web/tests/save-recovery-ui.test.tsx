import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { browser } from "./browser";
import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import i18n from "../src/i18n";
import { DocumentSaveRecovery } from "../src/components/layout/document-save-recovery";
import { CanvasSaveStatus } from "../src/components/canvas/canvas-save-status";
import { endCanvasSession, readCanvasSession } from "../src/services/api/canvas-client";
import { getDocumentBaseline, getDocumentDraft, getDocumentSaveState, readDocument, writeDocument } from "../src/services/canvas-data";
import { flushCanvasSave, useCanvasStore, type CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { readZip } from "../src/lib/zip";

const originalFetch = globalThis.fetch;
const globals = {
    HTMLAnchorElement: browser.HTMLAnchorElement,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Element: browser.Element,
    ShadowRoot: browser.ShadowRoot,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
};
const session = { user: { id: "user-a", subject: `ics_${"a".repeat(32)}`, username: "alice" }, csrf_token: "csrf", session_tag: "recovery-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
type SavedDocument = { value: unknown; revision: number };
let documents: Map<string, SavedDocument>;
let puts: string[];
let offline: boolean;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let saveFile: ReturnType<typeof spyOn> | undefined;
let browserDocuments: ReturnType<typeof mockBrowserDocuments>;
let browserFiles: ReturnType<typeof mockBrowserFiles>;

function project(id: string): CanvasProject {
    return {
        id,
        title: id,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        nodes: [{ id: `${id}-text`, title: "text", type: "text", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: `content-${id}` } }],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
    };
}

beforeEach(async () => {
    browserDocuments = mockBrowserDocuments();
    browserFiles = mockBrowserFiles();
    endCanvasSession();
    localStorage.clear();
    useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
    descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    documents = new Map([["canvas", { value: { state: { projects: [project("first"), project("second"), project("untouched")], deletedProjects: [] }, version: 0 }, revision: 1 }]]);
    puts = [];
    offline = false;
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/session") return Response.json(session);
        if (offline) throw new Error("offline");
        const domain = decodeURIComponent(path.slice("/api/data/".length));
        const saved = documents.get(domain) || { value: null, revision: 0 };
        if (init?.method === "PUT") {
            puts.push(domain);
            const body = JSON.parse(String(init.body));
            if (body.revision !== saved.revision) return Response.json({ error: { message: "revision conflict" } }, { status: 409 });
            documents.set(domain, { value: body.value, revision: saved.revision + 1 });
        }
        return Response.json(documents.get(domain) || saved);
    }) as typeof fetch;
    await readCanvasSession();
    await useCanvasStore.persist.rehydrate();
});

afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    saveFile?.mockRestore();
    saveFile = undefined;
    endCanvasSession();
    browserDocuments.restore();
    browserFiles.restore();
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

async function renderRecovery(path = "/canvas/first") {
    const router = createMemoryRouter(
        [
            {
                path: "*",
                element: (
                    <ConfigProvider theme={{ token: { motion: false } }}>
                        <App message={{ duration: 0 }}>
                            <DocumentSaveRecovery />
                            <CanvasSaveStatus />
                        </App>
                    </ConfigProvider>
                ),
            },
        ],
        { initialEntries: [path] },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    return router;
}

async function click(key: string) {
    const button = [...container!.querySelectorAll("button")].find((element) => element.textContent === i18n.t(key));
    expect(button).toBeDefined();
    await act(async () => button!.click());
}

test("failed saving retains edits and explicit retry clears the warning without reloading", async () => {
    offline = true;
    useCanvasStore.getState().renameProject("first", "local draft");
    await expect(flushCanvasSave()).rejects.toThrow("offline");
    await renderRecovery();
    expect(container!.textContent).toContain(i18n.t("saveRecovery.status.error"));
    const leaving = new browser.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    offline = false;
    await click("saveRecovery.retrySave");
    expect(container!.querySelector("#document-save-recovery")).toBeNull();
    expect(container!.textContent).toContain(i18n.t("saveRecovery.status.saved"));
    expect(useCanvasStore.getState().projects[0].title).toBe("local draft");
    expect((documents.get("canvas")!.value as { state: { projects: CanvasProject[] } }).state.projects[0].title).toBe("local draft");
    expect(puts).toEqual(["canvas"]);
    const savedLeave = new browser.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(savedLeave);
    expect(savedLeave.defaultPrevented).toBe(false);
});

test("conflict recovery copies all locally edited projects and keeps every remote project", async () => {
    useCanvasStore.getState().renameProject("first", "first local");
    useCanvasStore.getState().renameProject("second", "second local");
    const remoteProjects = [{ ...project("first"), title: "first remote" }, project("second"), project("untouched"), project("remote-only")];
    const deletedProjects = [{ id: "remote-deleted", deletedAt: "2026-01-02" }];
    documents.set("canvas", { value: { state: { projects: remoteProjects, deletedProjects }, version: 0 }, revision: 2 });
    await expect(flushCanvasSave()).rejects.toThrow("revision conflict");
    const router = await renderRecovery();
    await click("saveRecovery.saveCopies");
    const restored = useCanvasStore.getState();
    expect(restored.projects).toHaveLength(6);
    expect(restored.projects.filter((item) => remoteProjects.some((remote) => remote.id === item.id))).toEqual(remoteProjects);
    expect(restored.deletedProjects).toEqual(deletedProjects);
    const copies = restored.projects.filter((item) => !remoteProjects.some((remote) => remote.id === item.id));
    expect(copies.map((item) => item.title)).toEqual([i18n.t("saveRecovery.copyTitle", { title: "first local" }), i18n.t("saveRecovery.copyTitle", { title: "second local" })]);
    expect(copies.map((item) => item.nodes[0].metadata?.content)).toEqual(["content-first", "content-second"]);
    expect(router.state.location.pathname).toBe(`/canvas/${copies[0].id}`);
    expect(container!.querySelector("#document-save-recovery")).toBeNull();
    expect(puts).toEqual(["canvas", "canvas"]);
});

test("offline drafts export as JSON and missing media never produce a successful canvas ZIP", async () => {
    await import("../src/lib/canvas/canvas-export");
    const saver = await import("file-saver");
    const downloads: Blob[] = [];
    saveFile = spyOn(saver, "saveAs").mockImplementation((blob: Blob | string) => {
        if (blob instanceof Blob) downloads.push(blob);
    });
    offline = true;
    useCanvasStore.getState().updateProject("first", { nodes: [{ ...project("first").nodes[0], type: "image", metadata: { content: "local-file:image%3Amissing", storageKey: "image:missing" } }] });
    await expect(flushCanvasSave()).rejects.toThrow("offline");
    await renderRecovery();
    await click("saveRecovery.exportDraft");
    expect(downloads).toHaveLength(1);
    const backup = JSON.parse(await downloads[0].text());
    expect(backup.content.state.projects[0].nodes[0].metadata.storageKey).toBe("image:missing");
    expect(backup.content.state.projects).toHaveLength(3);
    await click("saveRecovery.exportCanvas");
    expect(downloads).toHaveLength(1);
    expect(document.body.textContent).toContain(i18n.t("saveRecovery.missingExportMedia"));
    expect(container!.querySelector("#document-save-recovery")).not.toBeNull();
    expect(puts).toEqual([]);
});

test("a lost copy-save response is confirmed without creating a second recovery copy", async () => {
    useCanvasStore.getState().renameProject("first", "local recovery");
    documents.get("canvas")!.revision = 2;
    await expect(flushCanvasSave()).rejects.toThrow("revision conflict");
    const transport = globalThis.fetch;
    let loseResponse = true;
    globalThis.fetch = (async (input, init) => {
        const response = await transport(input, init);
        if (init?.method === "PUT" && response.ok && loseResponse) {
            loseResponse = false;
            throw new Error("response lost");
        }
        return response;
    }) as typeof fetch;
    const router = await renderRecovery();
    await click("saveRecovery.saveCopies");
    const saved = documents.get("canvas")!.value as { state: { projects: CanvasProject[] } };
    expect(saved.state.projects).toHaveLength(4);
    const copyId = saved.state.projects[0].id;
    expect(router.state.location.pathname).toBe("/canvas/first");
    await click("saveRecovery.saveCopies");
    expect(useCanvasStore.getState().projects).toHaveLength(4);
    expect(router.state.location.pathname).toBe(`/canvas/${copyId}`);
    expect(puts).toEqual(["canvas", "canvas"]);
});

test("the recovery ZIP includes every local project and its referenced media", async () => {
    await import("../src/lib/canvas/canvas-export");
    const saver = await import("file-saver");
    let backup: Blob | undefined;
    saveFile = spyOn(saver, "saveAs").mockImplementation((blob: Blob | string) => {
        if (blob instanceof Blob) backup = blob;
    });
    offline = true;
    useCanvasStore.getState().updateProject("first", { nodes: [{ ...project("first").nodes[0], type: "image", metadata: { storageKey: "image:first" } }] });
    useCanvasStore.getState().updateProject("second", { nodes: [{ ...project("second").nodes[0], type: "video", metadata: { storageKey: "media:second" } }] });
    await expect(flushCanvasSave()).rejects.toThrow("offline");
    const transport = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        if (path === "/api/files/image%3Afirst") return new Response("first image bytes", { headers: { "Content-Type": "image/png" } });
        if (path === "/api/files/media%3Asecond") return new Response("second video bytes", { headers: { "Content-Type": "video/mp4" } });
        return transport(input, init);
    }) as typeof fetch;
    await renderRecovery();
    await click("saveRecovery.exportCanvas");
    expect(backup).toBeInstanceOf(Blob);
    const archive = await readZip(backup!);
    const data = JSON.parse(await archive.get("projects.json")!.text());
    expect(data.projects.map((item: { project: CanvasProject }) => item.project.id)).toEqual(["first", "second", "untouched"]);
    expect(await archive.get(data.projects[0].files[0].path)!.text()).toBe("first image bytes");
    expect(await archive.get(data.projects[1].files[0].path)!.text()).toBe("second video bytes");
    expect(container!.querySelector("#document-save-recovery")).not.toBeNull();
});

test("non-canvas failures export the latest original draft and remain individually retryable", async () => {
    await readDocument("image-workbench");
    offline = true;
    const draft = { generation: { prompt: "keep my prompt", status: "pending", taskId: "existing-task" } };
    await expect(writeDocument("image-workbench", draft)).rejects.toThrow("offline");
    const saver = await import("file-saver");
    let backup: Blob | undefined;
    saveFile = spyOn(saver, "saveAs").mockImplementation((blob: Blob | string) => {
        if (blob instanceof Blob) backup = blob;
    });
    await renderRecovery("/image");
    expect(container!.textContent).toContain(i18n.t("navigation.image"));
    expect(container!.textContent).not.toContain("image-workbench");
    await click("saveRecovery.exportDraft");
    expect(JSON.parse(await backup!.text()).content).toEqual(draft);
    offline = false;
    await click("saveRecovery.retrySave");
    expect(documents.get("image-workbench")!.value).toEqual(draft);
    expect(container!.querySelector("#document-save-recovery")).toBeNull();
});

async function clickRecoveryText(text: string) {
    const button = [...document.body.querySelectorAll("button")].find((element) => element.textContent === text);
    expect(button).toBeDefined();
    await act(async () => button!.click());
}

const allDraftsText = () => i18n.t("saveRecovery.exportAllReload", { defaultValue: "导出本页全部未保存草稿并重新加载" });
const confirmReloadText = () => i18n.t("saveRecovery.confirmReload", { defaultValue: "已保存备份，放弃本页草稿并重新加载" });

test("full recovery export keeps all failed drafts until the user confirms the downloaded backup", async () => {
    await readDocument("assets");
    await readDocument("config");
    offline = true;
    await expect(writeDocument("assets", { item: "local asset" })).rejects.toThrow();
    await expect(writeDocument("config", { setting: "local config" })).rejects.toThrow();
    const baseline = getDocumentBaseline("assets");
    const saver = await import("file-saver");
    const downloads: Blob[] = [];
    saveFile = spyOn(saver, "saveAs").mockImplementation((blob: Blob | string) => { if (blob instanceof Blob) downloads.push(blob); });
    await renderRecovery("/assets");
    await clickRecoveryText(allDraftsText());
    expect(downloads).toHaveLength(1);
    expect(JSON.parse(await downloads[0].text()).documents).toEqual({ assets: { item: "local asset" }, config: { setting: "local config" } });
    expect(document.body.textContent).toContain(i18n.t("navigation.assets"));
    expect(document.body.textContent).toContain(i18n.t("navigation.config"));
    expect(getDocumentBaseline("assets")).toBe(baseline);
    expect(getDocumentSaveState("assets").status).toBe("error");
    await clickRecoveryText(i18n.t("saveRecovery.keepDrafts", { defaultValue: "保留本页草稿" }));
    expect(getDocumentDraft("assets")).toEqual({ item: "local asset" });
    expect(getDocumentDraft("config")).toEqual({ setting: "local config" });
    const leaving = new browser.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
});

test("full recovery refuses reload after another result arrives and export failures retain drafts", async () => {
    await readDocument("image-workbench");
    offline = true;
    await expect(writeDocument("image-workbench", { result: "first" })).rejects.toThrow();
    const saver = await import("file-saver");
    saveFile = spyOn(saver, "saveAs").mockImplementation(() => { throw new Error("download blocked"); });
    await renderRecovery("/image");
    await clickRecoveryText(allDraftsText());
    expect(document.body.textContent).toContain("download blocked");
    expect(document.body.textContent).not.toContain(confirmReloadText());
    expect(getDocumentDraft("image-workbench")).toEqual({ result: "first" });
    saveFile.mockImplementation(() => {});
    await clickRecoveryText(allDraftsText());
    await act(async () => { await expect(writeDocument("image-workbench", { result: "arrived later" })).rejects.toThrow(); });
    await clickRecoveryText(confirmReloadText());
    expect(document.body.textContent).toContain(i18n.t("saveRecovery.backupChanged", { defaultValue: "导出后又有修改或生成结果到达，请重新导出全部草稿后再重新加载。" }));
    expect(getDocumentDraft("image-workbench")).toEqual({ result: "arrived later" });
    expect(getDocumentSaveState("image-workbench").status).toBe("error");
});

test("confirmed full recovery reloads only after blur commits are included and leaves saved data untouched", async () => {
    await readDocument("config");
    offline = true;
    await expect(writeDocument("config", { text: "before blur" })).rejects.toThrow();
    const saver = await import("file-saver");
    let downloaded: Blob | undefined;
    saveFile = spyOn(saver, "saveAs").mockImplementation((blob: Blob | string) => { if (blob instanceof Blob) downloaded = blob; });
    await renderRecovery("/config");
    const input = document.createElement("input");
    document.body.append(input);
    input.addEventListener("blur", () => { void writeDocument("config", { text: "committed on blur" }).catch(() => {}); });
    input.focus();
    await clickRecoveryText(allDraftsText());
    input.remove();
    expect(JSON.parse(await downloaded!.text()).documents.config).toEqual({ text: "committed on blur" });
    const saved = documents.get("config");
    const originalWindow = globalThis.window;
    let reloads = 0;
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: new Proxy(originalWindow, { get: (target, key) => key === "location" ? { reload: () => { reloads += 1; } } : Reflect.get(target, key) }) });
    try {
        await clickRecoveryText(confirmReloadText());
        expect(reloads).toBe(1);
        expect(documents.get("config")).toBe(saved);
        expect(getDocumentDraft("config")).toEqual({ text: "committed on blur" });
    } finally {
        Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: originalWindow });
    }
});
