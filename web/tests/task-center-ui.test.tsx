import { browser } from "./browser";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { mockBrowserDocuments } from "./local-document-fixture";
import i18n from "../src/i18n";
import TasksPage from "../src/pages/tasks";
import { ImageTaskPanel } from "../src/pages/image/image-task-panel";
import * as imageTasks from "../src/services/api/image-tasks";
import { getDocumentDraft, getDocumentSaveState, readDocument, writeDocument } from "../src/services/canvas-data";
import * as taskCenter from "../src/services/task-center";
import * as canvasStore from "../src/stores/canvas/use-canvas-store";
import * as clipboard from "../src/hooks/use-copy-text";
import { endCanvasSession, readCanvasSession, sessionEpoch } from "../src/services/api/canvas-client";

const globals = {
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Element: browser.Element,
    ShadowRoot: browser.ShadowRoot,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
};
let descriptors: Map<string, PropertyDescriptor | undefined>;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let load: ReturnType<typeof spyOn<typeof taskCenter, "loadTaskCenter">>;
let resume: ReturnType<typeof spyOn<typeof taskCenter, "resumeTaskCenterItem">>;
let openCanvas: ReturnType<typeof spyOn<typeof canvasStore, "refreshCanvasTaskTarget">>;
let localDocuments: ReturnType<typeof mockBrowserDocuments>;

function item(overrides: Partial<taskCenter.TaskCenterItem> = {}): taskCenter.TaskCenterItem {
    return { id: "image-task:original", recordId: "original", source: "image-tasks", kind: "image", status: "active", title: "A green forest", prompt: "A green forest", model: "image-model", createdAt: 0, taskId: "original-task", href: "/image?task=original", canResume: true, sessionEpoch: sessionEpoch(), ...overrides };
}

beforeEach(() => {
    endCanvasSession();
    localDocuments = mockBrowserDocuments();
    descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    load = spyOn(taskCenter, "loadTaskCenter").mockResolvedValue({ items: [], errors: {} });
    resume = spyOn(taskCenter, "resumeTaskCenterItem").mockImplementation(async (record) => ({ ...record, status: "completed", canResume: false }));
    openCanvas = spyOn(canvasStore, "refreshCanvasTaskTarget").mockResolvedValue();
});

afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    load.mockRestore();
    resume.mockRestore();
    openCanvas.mockRestore();
    endCanvasSession();
    localDocuments.restore();
    for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

async function renderPage(path = "/tasks") {
    const router = createMemoryRouter([
        { path: "/tasks", element: <ConfigProvider theme={{ token: { motion: false } }}><App message={{ duration: 0 }}><TasksPage /></App></ConfigProvider> },
        { path: "*", element: <div>source page</div> },
    ], { initialEntries: [path] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    return router;
}

function button(key: string) {
    const found = [...container!.querySelectorAll("button")].find((element) => element.textContent === i18n.t(key));
    expect(found).toBeDefined();
    return found!;
}

test("partial image batches show their summary separately from errors and only link to existing results", async () => {
    const batch = { total: 3, completed: 3, failed: 1, unknown: 1 };
    const summary = i18n.t("managed.imageBatchSummary", batch);
    load.mockResolvedValue({ items: [item({ status: "attention", canResume: false, summary, error: "provider rejected one request" })], errors: {} });
    const router = await renderPage();
    const card = container!.querySelector('[data-task-id="image-task:original"]')!;
    expect(card.textContent).toContain(summary);
    expect(card.querySelector('[role="alert"]')!.textContent).toBe("provider rejected one request");
    expect([...card.querySelectorAll("button")].some((entry) => entry.textContent === i18n.t("tasks.resume"))).toBe(false);
    await act(async () => card.querySelector<HTMLAnchorElement>("a")!.click());
    expect(router.state.location.pathname).toBe("/image");
    expect(router.state.location.search).toBe("?task=original");
    expect(resume).not.toHaveBeenCalled();
});

test("canvas recovery links open the original image record and diagnostic copy uses only safe metadata", async () => {
    const copied: string[] = [];
    const copy = spyOn(clipboard, "useCopyText").mockReturnValue((value: string) => { copied.push(value); });
    const record = item({ id: "canvas:p:n", recordId: "n", source: "canvas", status: "attention", projectId: "p", nodeId: "n", imageTaskRecordIds: ["image/original"], title: "private title", prompt: "private prompt", error: "private failure https://private.example", canResume: false });
    load.mockResolvedValue({ items: [record], errors: {} });
    try {
        const router = await renderPage();
        await act(async () => button("tasks.copyDiagnostics").click());
        expect(copied).toEqual([taskCenter.taskCenterDiagnostics(record)]);
        expect(copied[0]).not.toContain("private");
        const link = container!.querySelector<HTMLAnchorElement>('a[href="/image?task=image%2Foriginal"]');
        expect(link).not.toBeNull();
        await act(async () => link!.click());
        expect(router.state.location.pathname + router.state.location.search).toBe("/image?task=image%2Foriginal");
        expect(resume).not.toHaveBeenCalled();
    } finally { copy.mockRestore(); }
});

test.each([false, true])("local batch writes update the image panel without model queries or manual refresh (repeated save errors: %s)", async (saveFailures) => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const started: imageTasks.ImageTaskRecord = { id: "batch", task_id: null, status: "running", value: { model: "gemini-model", batch: { total: 3, completed: 1, failed: 0, unknown: 0 }, result: { data: [{ url: "/api/result-media/retained" }] } } };
    let saved = { value: { batch: started }, revision: 1 };
    const openImages = spyOn(imageTasks, "imageTaskImages").mockResolvedValue([{ id: "image", dataUrl: "local-file:image%3Aretained" }]);
    const query = spyOn(imageTasks, "refreshImageTask");
    const opened: string[] = [];
    try {
        globalThis.fetch = (async (input, init) => {
            const path = String(input);
            calls.push(path);
            if (path === "/api/session") return Response.json({ user: { id: "panel", subject: `ics_${"c".repeat(32)}`, username: "panel" }, csrf_token: "csrf", session_tag: "batch-panel", expires_at: Math.floor(Date.now() / 1000) + 3600 });
            if (path !== "/api/data/image-tasks") throw new Error(`Unexpected request ${path}`);
            if (init?.method === "PUT") {
                if (saveFailures) return Response.json({ error: { message: "local storage unavailable" } }, { status: 503 });
                const body = JSON.parse(String(init.body));
                saved = { value: body.value, revision: saved.revision + 1 };
            }
            return Response.json(saved);
        }) as typeof fetch;
        await readCanvasSession();
        await readDocument("image-tasks");
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () => root!.render(<ConfigProvider theme={{ token: { motion: false } }}><App><ImageTaskPanel revision={0} onOpen={async (images) => { opened.push(...images.map((image) => image.dataUrl)); }} /></App></ConfigProvider>));
        expect(container.textContent).toContain(i18n.t("managed.taskAttention", { defaultValue: "需处理" }));
        expect(container.textContent).not.toContain(i18n.t("managed.taskRunning"));
        expect(container.textContent).toContain(i18n.t("managed.imageBatchIncompleteNotice"));
        expect(container.textContent).toContain(i18n.t("managed.imageBatchSummary", started.value.batch));
        expect(container.textContent).not.toContain(i18n.t("managed.taskReady"));
        expect(button("managed.viewResults").disabled).toBe(false);
        const retained = [{ id: "image", dataUrl: "local-file:image%3Aretained" }];
        const resultData = [...started.value.result!.data!];
        if (saveFailures) {
            const progress: imageTasks.ImageTaskRecord = { ...started, status: "storage_failed", value: { ...started.value, batch: { total: 3, completed: 2, failed: 1, unknown: 0 }, result: { data: [...resultData], error_message: "one rejected" } } };
            await act(async () => { await expect(writeDocument("image-tasks", { batch: progress })).rejects.toThrow("local storage unavailable"); });
            expect(getDocumentSaveState("image-tasks").status).toBe("error");
            expect(container.textContent).toContain(i18n.t("managed.imageBatchSummary", progress.value.batch));
            expect(button("managed.viewResults").disabled).toBe(false);
            resultData.push({ url: "/api/result-media/second" });
            retained.push({ id: "second", dataUrl: "local-file:image%3Asecond" });
        }
        const errorMessage = saveFailures ? "one rejected" : "one rejected; one response lost";
        const complete: imageTasks.ImageTaskRecord = { ...started, status: saveFailures ? "storage_failed" : "partial", value: { ...started.value, batch: { total: 3, completed: 3, failed: 1, unknown: saveFailures ? 0 : 1 }, result: { data: resultData, error_message: errorMessage } } };
        await act(async () => {
            const saving = writeDocument("image-tasks", { batch: complete });
            if (saveFailures) await expect(saving).rejects.toThrow("local storage unavailable");
            else await saving;
        });
        if (saveFailures) {
            expect(getDocumentSaveState("image-tasks")).toMatchObject({ status: "error", error: "local storage unavailable" });
            expect(getDocumentDraft("image-tasks")).toEqual({ batch: complete });
            expect(saved.value.batch).toEqual(started);
        }
        expect(container.textContent).toContain(i18n.t(saveFailures ? "managed.taskStorageFailed" : "managed.taskPartial"));
        expect(container.textContent).toContain(i18n.t("managed.imageBatchPartialNotice", complete.value.batch));
        expect(container.textContent).toContain(i18n.t("managed.imageBatchSummary", complete.value.batch));
        expect(container.textContent).not.toContain(i18n.t("managed.imageBatchIncompleteNotice"));
        expect(container.textContent).toContain(errorMessage);
        expect([...container.querySelectorAll("button")].some((button) => button.textContent === i18n.t("managed.resumeImage"))).toBe(false);
        openImages.mockResolvedValue(retained);
        await act(async () => button("managed.viewResults").click());
        expect(opened).toEqual(retained.map((image) => image.dataUrl));
        expect(openImages).toHaveBeenCalledTimes(1);
        expect(query).not.toHaveBeenCalled();
        expect(calls.every((path) => path === "/api/session" || path === "/api/data/image-tasks")).toBe(true);
        await act(async () => endCanvasSession());
        expect(container.textContent).not.toContain("gemini-model");
    } finally {
        openImages.mockRestore();
        query.mockRestore();
        globalThis.fetch = originalFetch;
    }
});

test("task filters compose and remain in the URL after returning from a source", async () => {
    load.mockResolvedValue({ items: [
        item(),
        item({ id: "video-log:paused", source: "video-workbench", kind: "video", status: "attention", title: "An astronaut", prompt: "The MOON landing", model: "video-model", taskId: "video-task", href: "/video?log=paused" }),
        item({ id: "video-log:done", source: "video-workbench", kind: "video", status: "completed", prompt: "The moon", href: "/video?log=done" }),
    ], errors: {} });
    const router = await renderPage("/tasks?q=moon&source=video-workbench&status=attention");
    expect([...container!.querySelectorAll("[data-task-id]")].map((element) => element.getAttribute("data-task-id"))).toEqual(["video-log:paused"]);
    expect((container!.querySelector("input") as HTMLInputElement).value).toBe("moon");
    const link = container!.querySelector<HTMLAnchorElement>('a[href="/video?log=paused"]');
    expect(link).not.toBeNull();
    await act(async () => link!.click());
    expect(router.state.location.pathname).toBe("/video");
    await act(async () => router.navigate(-1));
    expect(router.state.location.search).toBe("?q=moon&source=video-workbench&status=attention");
    expect(container!.querySelectorAll("[data-task-id]")).toHaveLength(1);
    const search = container!.querySelector("input")!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(search, "astronaut");
        search.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    expect(router.state.location.search).toBe("?q=astronaut&source=video-workbench&status=attention");
    await act(async () => router.navigate("/tasks?q=original-task"));
    expect(container!.querySelector("[data-task-id]")?.getAttribute("data-task-id")).toBe("image-task:original");
    await act(async () => router.navigate("/tasks?q=not-found"));
    expect(container!.textContent).toContain(i18n.t("tasks.noMatches"));
    await act(async () => button("tasks.clearFilters").click());
    expect(router.state.location.search).toBe("");
    expect(container!.querySelectorAll("[data-task-id]")).toHaveLength(3);
});

test("a failed source keeps other records visible and manual refresh recovers it", async () => {
    load.mockResolvedValueOnce({ items: [item({ createdAt: 1e20 })], errors: { "video-workbench": "video source unavailable" } });
    await renderPage();
    expect(container!.textContent).toContain("video source unavailable");
    expect(container!.querySelectorAll("[data-task-id]")).toHaveLength(1);
    expect(container!.querySelector("time")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    resume.mockRejectedValueOnce(new Error("query interrupted"));
    await act(async () => button("tasks.resume").click());
    expect(container!.textContent).toContain("query interrupted");
    expect(container!.querySelectorAll("[data-task-id]")).toHaveLength(1);
    load.mockResolvedValue({ items: [item(), item({ id: "video-log:recovered", source: "video-workbench" })], errors: {} });
    await act(async () => button("tasks.refresh").click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(container!.textContent).not.toContain("video source unavailable");
    expect(container!.textContent).not.toContain("query interrupted");
    expect(container!.querySelectorAll("[data-task-id]")).toHaveLength(2);
});

test("continuing a task is deduplicated and its returned status replaces the row", async () => {
    const record = item();
    load.mockResolvedValue({ items: [record], errors: {} });
    let complete!: (value: taskCenter.TaskCenterItem) => void;
    resume.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    await renderPage();
    const action = button("tasks.resume");
    await act(async () => { action.click(); action.click(); });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith(record);
    expect(button("tasks.refresh").disabled).toBe(true);
    load.mockResolvedValue({ items: [{ ...record, status: "completed", canResume: false }], errors: {} });
    await act(async () => complete({ ...record, status: "completed", canResume: false }));
    expect(load).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toContain(i18n.t("tasks.status.completed"));
    expect([...container!.querySelectorAll("button")].some((element) => element.textContent === i18n.t("tasks.resume"))).toBe(false);
    expect(button("tasks.refresh").disabled).toBe(false);
});

test("canvas source navigation waits for the latest target and reports failed preparation", async () => {
    load.mockResolvedValue({ items: [item({ id: "canvas:p:n", source: "canvas", projectId: "p", nodeId: "n", href: "/canvas/p?focusNode=n", canResume: false })], errors: {} });
    openCanvas.mockRejectedValueOnce(new Error("target missing"));
    const router = await renderPage();
    await act(async () => button("tasks.openSource").click());
    expect(router.state.location.pathname).toBe("/tasks");
    expect(container!.textContent).toContain("target missing");
    let ready!: () => void;
    openCanvas.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
    await act(async () => button("tasks.openSource").click());
    expect(router.state.location.pathname).toBe("/tasks");
    await act(async () => ready());
    expect(openCanvas).toHaveBeenLastCalledWith("p", "n", expect.any(AbortSignal));
    expect(router.state.location.pathname + router.state.location.search).toBe("/canvas/p?focusNode=n");
});

test.each(["navigation", "session"])("pending canvas navigation is cancelled on %s and cannot redirect afterward", async (exit) => {
    load.mockResolvedValue({ items: [
        item({ id: "canvas:p:first", source: "canvas", projectId: "p", nodeId: "first", href: "/canvas/p?focusNode=first", canResume: false }),
        item({ id: "canvas:p:second", source: "canvas", projectId: "p", nodeId: "second", href: "/canvas/p?focusNode=second", canResume: false }),
    ], errors: {} });
    let ready!: () => void;
    let signal: AbortSignal | undefined;
    openCanvas.mockImplementation((_project, _node, requestSignal) => {
        signal = requestSignal;
        return new Promise((resolve) => { ready = resolve; });
    });
    const router = await renderPage();
    const actions = [...container!.querySelectorAll("button")].filter((element) => element.textContent === i18n.t("tasks.openSource"));
    await act(async () => { actions[0].click(); actions[1].click(); });
    expect(openCanvas).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await act(async () => {
        if (exit === "navigation") await router.navigate("/image?log=other");
        else endCanvasSession();
    });
    expect(signal?.aborted).toBe(true);
    const destination = router.state.location.pathname + router.state.location.search;
    await act(async () => ready());
    expect(router.state.location.pathname + router.state.location.search).toBe(destination);
    expect(router.state.location.pathname).not.toBe("/canvas/p");
});

test("session changes clear private rows and discard late task results", async () => {
    const record = item();
    load.mockResolvedValue({ items: [record], errors: {} });
    let complete!: (value: taskCenter.TaskCenterItem) => void;
    resume.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    await renderPage();
    await act(async () => button("tasks.resume").click());
    await act(async () => endCanvasSession());
    expect(container!.querySelectorAll("[data-task-id]")).toHaveLength(0);
    await act(async () => complete({ ...record, title: "PRIVATE OLD RESULT", status: "completed" }));
    expect(container!.textContent).not.toContain("PRIVATE OLD RESULT");
    expect(container!.querySelectorAll("[data-task-id]")).toHaveLength(0);
});

test("image-task filters find grouped history and child actions refresh the complete group", async () => {
    const child = item();
    const parent = item({ id: "image-log:parent", recordId: "parent", source: "image-workbench", status: "attention", title: "recover history", taskId: undefined, imageTaskRecordIds: [child.recordId], canResume: false, relatedTasks: [child], href: "/image?log=parent" });
    load.mockResolvedValue({ items: [parent], errors: {} });
    const router = await renderPage("/tasks?source=image-tasks&q=original-task");
    expect(container!.querySelector('[data-task-id="image-log:parent"]')).not.toBeNull();
    expect(container!.querySelector('details')?.open).toBe(true);
    expect(container!.querySelector('a[href="/image?task=original"]')).not.toBeNull();
    load.mockResolvedValue({ items: [{ ...parent, relatedTasks: [{ ...child, status: "completed", canResume: false }] }], errors: {} });
    await act(async () => button("tasks.resume").click());
    expect(resume).toHaveBeenCalledWith(child);
    expect(load).toHaveBeenCalledTimes(2);
    const parentCard = container!.querySelector('[data-task-id="image-log:parent"]')!;
    expect(parentCard.querySelector(".ant-tag")?.textContent).toBe(i18n.t("tasks.status.attention"));
    expect(parentCard.querySelector('[data-task-id="image-task:original"] .ant-tag')?.textContent).toBe(i18n.t("tasks.status.completed"));
    await act(async () => container!.querySelector<HTMLAnchorElement>('a[href="/image?log=parent"]')!.click());
    expect(router.state.location.pathname + router.state.location.search).toBe("/image?log=parent");
});

test("task actions distinguish local saving from unknown verification and show safe timings", async () => {
    const local = item({ id: "image-task:local", recordId: "local", status: "attention", resumeAction: "save", imageTask: { id: "local", task_id: null, status: "storage_failed", value: { requests: [{ requestId: "62ae80c0-2c42-4ca1-8c5d-c43fe27a23a9", durationMs: 120 }], mediaTimings: { 0: { readMediaMs: 30, decodeMs: 5, localSaveMs: 7 } } } } });
    const unknown = item({ id: "image-task:unknown", recordId: "unknown", status: "attention", canResume: false, taskId: undefined, href: "/image?task=unknown" });
    load.mockResolvedValue({ items: [local, unknown], errors: {} });
    const router = await renderPage();
    const localCard = container!.querySelector('[data-task-id="image-task:local"]')!;
    const action = [...localCard.querySelectorAll("button")].find((element) => element.textContent === i18n.t("tasks.restoreSave", { defaultValue: "恢复本地保存" }));
    expect(action).toBeDefined();
    expect(localCard.textContent).toContain("120 ms");
    expect(localCard.textContent).toContain("30 ms");
    await act(async () => action!.click());
    expect(resume).toHaveBeenCalledWith(local);
    const unknownCard = container!.querySelector('[data-task-id="image-task:unknown"]')!;
    expect(unknownCard.querySelector("a")?.textContent).toBe(i18n.t("tasks.verifyStatus", { defaultValue: "核实原记录" }));
    expect([...unknownCard.querySelectorAll("button")].some((element) => element.textContent === i18n.t("tasks.resume"))).toBe(false);
    await act(async () => unknownCard.querySelector<HTMLAnchorElement>("a")!.click());
    expect(router.state.location.pathname + router.state.location.search).toBe("/image?task=unknown");
});

test("a late post-query snapshot cannot overwrite a newer completed refresh", async () => {
    const first = item(), second = item({ id: "image-task:second", recordId: "second" });
    load.mockResolvedValueOnce({ items: [first, second], errors: {} });
    let finishFirst!: (value: taskCenter.TaskCenterSnapshot) => void;
    load.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    load.mockResolvedValue({ items: [{ ...first, status: "completed", canResume: false }, { ...second, status: "completed", canResume: false }], errors: {} });
    await renderPage();
    const actions = [...container!.querySelectorAll("button")].filter((entry) => entry.textContent === i18n.t("tasks.resume"));
    await act(async () => { actions[0].click(); });
    await act(async () => { actions[1].click(); });
    expect(container!.querySelector('[data-task-id="image-task:second"] .ant-tag')?.textContent).toBe(i18n.t("tasks.status.completed"));
    await act(async () => finishFirst({ items: [first, second], errors: {} }));
    expect(container!.querySelector('[data-task-id="image-task:second"] .ant-tag')?.textContent).toBe(i18n.t("tasks.status.completed"));
});
