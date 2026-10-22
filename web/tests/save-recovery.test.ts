import { afterEach, beforeEach, expect, test } from "bun:test";
import "./browser";
import { mockBrowserDocuments } from "./local-document-fixture";
import { CanvasNodeType } from "../src/types/canvas";
import { currentSession, endCanvasSession, readCanvasSession } from "../src/services/api/canvas-client";
import { applyCanvasDocument, flushCanvasSave, refreshCanvasTaskTarget, useCanvasStore } from "../src/stores/canvas/use-canvas-store";
import { flushDocument, getDocumentBaseline, getDocumentDraft, getDocumentSaveState, getDocumentSaveStates, readDocument, resolveDocumentConflict, retryDocument, stageDocument, subscribeDocumentSaves, writeDocument } from "../src/services/canvas-data";

const originalFetch = globalThis.fetch;
const session = { user: { id: "save-owner", subject: `ics_${"c".repeat(32)}`, username: "save-owner" }, csrf_token: "private-csrf", session_tag: "save-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
let remote: { value: unknown; revision: number };
let writes: Array<{ value: unknown; revision: number }>;
let transport: ((init?: RequestInit) => Promise<Response> | Response) | undefined;
let documents: ReturnType<typeof mockBrowserDocuments>;

function commit(init?: RequestInit) {
    const body = JSON.parse(String(init?.body));
    writes.push(body);
    if (body.revision !== remote.revision) return Response.json({ error: { message: "conflict" } }, { status: 409 });
    remote = { value: body.value, revision: remote.revision + 1 };
    return Response.json(remote);
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
async function hydrateTaskCanvas() {
    remote.value = { state: { projects: [], deletedProjects: [] }, version: 0 };
    await useCanvasStore.persist.rehydrate();
    const id = useCanvasStore.getState().createProject("original");
    useCanvasStore.getState().updateProject(id, { nodes: [{ id: "existing-node", type: CanvasNodeType.Text, title: "result", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "original result" } }] });
    await flushCanvasSave();
    return useCanvasStore.getState().openProject(id)!;
}
beforeEach(async () => {
    endCanvasSession();
    localStorage.clear();
    useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
    remote = { value: { count: 0 }, revision: 1 };
    writes = [];
    transport = undefined;
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/session") return Response.json(session);
        if (transport) return transport(init);
        return init?.method === "PUT" ? commit(init) : Response.json(remote);
    }) as typeof fetch;
    documents = mockBrowserDocuments();
    await readCanvasSession();
});
afterEach(() => {
    documents.restore();
    endCanvasSession();
    useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
    globalThis.fetch = originalFetch;
});

test("failed saves retain subsequent functional edits in order and an explicit retry never reapplies them", async () => {
    await readDocument("records");
    let updates = 0;
    transport = (init) => {
        if (init?.method === "PUT") {
            writes.push(JSON.parse(String(init.body)));
            throw new Error("offline");
        }
        return Response.json(remote);
    };
    await expect(writeDocument("records", (value: unknown) => ({ count: (value as { count: number }).count + ++updates }))).rejects.toThrow("offline");
    await expect(writeDocument("records", (value: unknown) => ({ count: (value as { count: number }).count + ++updates }))).rejects.toThrow("offline");
    expect(getDocumentDraft("records")).toEqual({ count: 3 });
    expect(writes).toHaveLength(1);
    expect(getDocumentSaveState("records").status).toBe("error");
    transport = undefined;
    await retryDocument("records");
    expect(remote).toEqual({ value: { count: 3 }, revision: 2 });
    expect(updates).toBe(2);
    expect(getDocumentSaveState("records").status).toBe("saved");
});

test("failed initial reads retain queued functions until a single explicit recovery", async () => {
    let updates = 0;
    let reads = 0;
    transport = () => { reads += 1; throw new Error("cannot load"); };
    const first = writeDocument("records", () => ({ count: ++updates }));
    const second = writeDocument("records", (value: unknown) => ({ count: (value as { count: number }).count + ++updates }));
    expect((await Promise.allSettled([first, second])).every((result) => result.status === "rejected")).toBe(true);
    expect(reads).toBe(1);
    expect(updates).toBe(0);
    transport = undefined;
    await retryDocument("records");
    expect(remote.value).toEqual({ count: 3 });
    expect(updates).toBe(2);
    expect(writes).toHaveLength(1);
});

test("lost successful response is confirmed by its sent snapshot before newer edits use the advanced revision", async () => {
    await readDocument("records");
    transport = (init) => {
        if (init?.method === "PUT") {
            commit(init);
            return new Response("broken response body", { headers: { "Content-Type": "application/json" } });
        }
        return Response.json(remote);
    };
    await expect(writeDocument("records", { count: 1 })).rejects.toThrow();
    await expect(writeDocument("records", (value: unknown) => ({ count: (value as { count: number }).count + 1 }))).rejects.toThrow();
    transport = undefined;
    await retryDocument("records");
    expect(remote).toEqual({ value: { count: 2 }, revision: 3 });
    expect(writes.map((write) => write.revision)).toEqual([1, 2]);
});

test("retry confirms a lost response without duplicating an already applied append", async () => {
    remote.value = [];
    await readDocument("records");
    transport = (init) => {
        if (init?.method === "PUT") { commit(init); throw new Error("response lost"); }
        return Response.json(remote);
    };
    await expect(writeDocument("records", (value: unknown) => [...value as unknown[], "one"])).rejects.toThrow("response lost");
    transport = undefined;
    await retryDocument("records");
    expect(remote.value).toEqual(["one"]);
    expect(writes).toHaveLength(1);
    expect(getDocumentSaveState("records").status).toBe("saved");
});

test("debounced edits arriving during an uncertain save retain the latest value and the original sent snapshot", async () => {
    await readDocument("records");
    const started = deferred<void>(), finish = deferred<Response>();
    transport = (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        commit(init);
        started.resolve();
        return finish.promise;
    };
    stageDocument("records", { count: 1 });
    const saving = flushDocument("records");
    await started.promise;
    stageDocument("records", { count: 2 });
    finish.resolve(new Response("lost response", { status: 502 }));
    await expect(saving).rejects.toThrow();
    expect(getDocumentDraft("records")).toEqual({ count: 2 });
    transport = undefined;
    await retryDocument("records");
    expect(remote).toEqual({ value: { count: 2 }, revision: 3 });
    expect(writes.map((write) => write.value)).toEqual([{ count: 1 }, { count: 2 }]);
});

test("revision conflicts retain the newest draft and retries never overwrite another tab", async () => {
    await readDocument("records");
    remote = { value: { remote: true }, revision: 2 };
    await expect(writeDocument("records", { local: 1 })).rejects.toThrow("conflict");
    await expect(writeDocument("records", { local: 2 })).rejects.toThrow("其他页面");
    await expect(retryDocument("records")).rejects.toThrow("其他页面");
    expect(writes).toHaveLength(1);
    expect(remote).toEqual({ value: { remote: true }, revision: 2 });
    expect(getDocumentDraft("records")).toEqual({ local: 2 });
    expect(getDocumentBaseline("records")).toEqual({ count: 0 });
    expect(getDocumentSaveState("records").status).toBe("conflict");
});

test("conflict resolution reads the latest remote collection and uses its revision for a copied record", async () => {
    remote.value = { projects: [{ id: "original", title: "before" }] };
    await readDocument("records");
    remote = { value: { projects: [{ id: "original", title: "remote" }, { id: "other" }] }, revision: 2 };
    await expect(writeDocument("records", { projects: [{ id: "original", title: "local" }] })).rejects.toThrow();
    const result = await resolveDocumentConflict("records", (server, local) => ({ projects: [...(server as { projects: unknown[] }).projects, { ...(local as { projects: object[] }).projects[0], id: "copy" }] }));
    expect(result).toEqual({ projects: [{ id: "original", title: "remote" }, { id: "other" }, { id: "copy", title: "local" }] });
    expect(writes.map((write) => write.revision)).toEqual([1, 2]);
    expect(getDocumentSaveState("records").status).toBe("saved");
});

test("a conflict copy with a lost response is confirmed without rerunning the merge or creating another copy", async () => {
    await readDocument("records");
    remote = { value: { remote: true }, revision: 2 };
    await expect(writeDocument("records", { local: 1 })).rejects.toThrow();
    let merges = 0;
    const merge = (server: unknown, local: unknown) => ({ ...server as object, copies: [{ id: `copy-${++merges}`, value: local }] });
    transport = (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        commit(init);
        throw new Error("copy response lost");
    };
    await expect(resolveDocumentConflict("records", merge)).rejects.toThrow("copy response lost");
    expect(getDocumentDraft("records")).toEqual({ local: 1 });
    transport = undefined;
    const recovered = await resolveDocumentConflict("records", merge);
    expect(recovered).toEqual({ remote: true, copies: [{ id: "copy-1", value: { local: 1 } }] });
    expect(merges).toBe(1);
    expect(writes).toHaveLength(2);
    expect(getDocumentSaveState("records").status).toBe("saved");
});

test("local changes during conflict submission remain recoverable and cannot be overwritten by its response", async () => {
    await readDocument("records");
    remote = { value: { remote: true }, revision: 2 };
    await expect(writeDocument("records", { local: 1 })).rejects.toThrow();
    const started = deferred<void>(), finish = deferred<Response>();
    transport = (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        const response = commit(init);
        started.resolve();
        return finish.promise.then(() => response);
    };
    const resolving = resolveDocumentConflict("records", (server, local) => ({ ...server as object, copy: local }));
    await started.promise;
    const edit = writeDocument("records", { local: 2 });
    finish.resolve(new Response());
    await expect(resolving).rejects.toThrow("新编辑");
    await expect(edit).rejects.toThrow();
    expect(getDocumentDraft("records")).toEqual({ local: 2 });
    transport = undefined;
    await expect(retryDocument("records")).rejects.toThrow("其他页面");
    expect(remote.value).toEqual({ remote: true, copy: { local: 1 } });
    expect(getDocumentSaveState("records").status).toBe("conflict");
});

test("new remote edits between merge read and write cause CAS rejection and preserve the local draft", async () => {
    await readDocument("records");
    remote = { value: { remote: 1 }, revision: 2 };
    await expect(writeDocument("records", { local: 1 })).rejects.toThrow();
    transport = (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        remote = { value: { remote: 2 }, revision: 3 };
        return commit(init);
    };
    await expect(resolveDocumentConflict("records", (server, local) => ({ ...server as object, copy: local }))).rejects.toThrow("conflict");
    expect(remote.value).toEqual({ remote: 2 });
    expect(getDocumentDraft("records")).toEqual({ local: 1 });
    transport = undefined;
    const recovered = await resolveDocumentConflict("records", (server, local) => ({ ...server as object, copy: local }));
    expect(recovered).toEqual({ remote: 2, copy: { local: 1 } });
    expect(remote).toEqual({ value: recovered, revision: 4 });
    expect(writes.map((write) => write.revision)).toEqual([1, 2, 3]);
    expect(getDocumentSaveState("records").status).toBe("saved");
});

test("session teardown clears all drafts and late requests cannot populate a new owner's state", async () => {
    await readDocument("records");
    const started = deferred<void>(), finish = deferred<Response>();
    transport = (init) => {
        if (init?.method !== "PUT") return Response.json(remote);
        started.resolve();
        return finish.promise;
    };
    const request = writeDocument("records", { secret: "old owner" });
    await started.promise;
    endCanvasSession();
    expect(currentSession()).toBeNull();
    expect(getDocumentDraft("records")).toBeUndefined();
    expect(getDocumentSaveStates()).toEqual([]);
    await expect(flushDocument("records")).rejects.toThrow("授权");
    await expect(writeDocument("records", { prohibited: true })).rejects.toThrow("授权");
    await readCanvasSession();
    finish.resolve(Response.json({ value: { secret: "old owner" }, revision: 2 }));
    await expect(request).rejects.toThrow("会话已改变");
    expect(getDocumentDraft("records")).toBeUndefined();
    expect(getDocumentSaveState("records").status).toBe("idle");
});

test("canvas edits immediately expose pending state, explicit flush saves, and hydration failures never write defaults", async () => {
    remote.value = { state: { projects: [], deletedProjects: [], createProject: "must not replace a store action" }, version: 0 };
    await useCanvasStore.persist.rehydrate();
    expect(useCanvasStore.getState().hydrated).toBe(true);
    expect(typeof useCanvasStore.getState().createProject).toBe("function");
    expect(writes).toEqual([]);
    const id = useCanvasStore.getState().createProject("pending canvas");
    expect(getDocumentSaveState("canvas").status).toBe("pending");
    expect(writes).toEqual([]);
    await flushCanvasSave();
    expect((remote.value as { state: { projects: Array<{ id: string }> } }).state.projects[0].id).toBe(id);
    expect(writes).toHaveLength(1);
    const snapshot = getDocumentDraft("canvas");
    applyCanvasDocument(snapshot);
    await flushCanvasSave();
    expect(writes).toHaveLength(1);
    useCanvasStore.getState().renameProject(id, "newer draft");
    expect(() => applyCanvasDocument(snapshot)).toThrow("新编辑");
    expect(useCanvasStore.getState().projects[0].title).toBe("newer draft");
    endCanvasSession();
    useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
    remote.value = { state: { projects: "broken", deletedProjects: [] }, version: 0 };
    await readCanvasSession();
    await expect(useCanvasStore.persist.rehydrate()).rejects.toThrow("原数据未被修改");
    expect(useCanvasStore.getState().hydrated).toBe(false);
    expect(writes).toHaveLength(1);
});

test("save snapshots remain referentially stable until actual state changes", async () => {
    const initial = getDocumentSaveState("records");
    expect(getDocumentSaveState("records")).toBe(initial);
    const all = getDocumentSaveStates();
    expect(getDocumentSaveStates()).toBe(all);
    let notifications = 0;
    const unsubscribe = subscribeDocumentSaves(() => { notifications += 1; });
    await readDocument("records");
    const saved = getDocumentSaveState("records");
    expect(saved.updatedAt).toBeUndefined();
    const savedAll = getDocumentSaveStates();
    await readDocument("records");
    expect(getDocumentSaveState("records")).toBe(saved);
    expect(getDocumentSaveStates()).toBe(savedAll);
    expect(notifications).toBe(1);
    unsubscribe();
});

test("opening a remote canvas task adopts the latest editor and revision together without writing", async () => {
    const original = await hydrateTaskCanvas();
    const remoteProject = { ...original, title: "other tab", nodes: [{ ...original.nodes[0], id: "remote-node" }] };
    remote = { value: { state: { projects: [remoteProject, { ...original, id: "remote-only" }], deletedProjects: [] }, version: 0 }, revision: remote.revision + 1 };
    const revision = remote.revision;
    await refreshCanvasTaskTarget(original.id, "remote-node");
    expect(writes).toHaveLength(1);
    expect(useCanvasStore.getState().openProject(original.id)).toEqual(remoteProject);
    useCanvasStore.getState().renameProject(original.id, "my next edit");
    await flushCanvasSave();
    expect(writes.at(-1)?.revision).toBe(revision);
    expect(useCanvasStore.getState().openProject("remote-only")).not.toBeNull();
});

test("opening tasks preserves unsaved canvases and rejects missing targets without changing the baseline", async () => {
    const original = await hydrateTaskCanvas();
    const baseline = getDocumentBaseline("canvas");
    useCanvasStore.getState().renameProject(original.id, "unsaved draft");
    transport = () => { throw new Error("must not read over the draft"); };
    await refreshCanvasTaskTarget(original.id, "existing-node");
    await expect(refreshCanvasTaskTarget(original.id, "unknown-node")).rejects.toThrow();
    expect(useCanvasStore.getState().openProject(original.id)?.title).toBe("unsaved draft");
    expect(getDocumentBaseline("canvas")).toBe(baseline);
    expect(writes).toHaveLength(1);
});

test("edits made while a task target is loading prevent the new snapshot from replacing the draft", async () => {
    const original = await hydrateTaskCanvas();
    const baseline = getDocumentBaseline("canvas");
    const started = deferred<void>(), finish = deferred<Response>();
    transport = () => { started.resolve(); return finish.promise; };
    const loading = refreshCanvasTaskTarget(original.id, "existing-node");
    await started.promise;
    useCanvasStore.getState().renameProject(original.id, "edited while loading");
    finish.resolve(Response.json({ value: { state: { projects: [{ ...original, title: "other tab" }], deletedProjects: [] }, version: 0 }, revision: remote.revision + 1 }));
    await expect(loading).rejects.toThrow();
    expect(useCanvasStore.getState().openProject(original.id)?.title).toBe("edited while loading");
    expect(getDocumentBaseline("canvas")).toBe(baseline);
    expect(writes).toHaveLength(1);
});

test("leaving task navigation before its response preserves both the editor and its save revision", async () => {
    const original = await hydrateTaskCanvas();
    const baseline = getDocumentBaseline("canvas");
    const started = deferred<void>(), finish = deferred<Response>();
    const controller = new AbortController();
    transport = () => { started.resolve(); return finish.promise; };
    const loading = refreshCanvasTaskTarget(original.id, "existing-node", controller.signal);
    await started.promise;
    controller.abort();
    finish.resolve(Response.json({ value: { state: { projects: [{ ...original, title: "other tab" }], deletedProjects: [] }, version: 0 }, revision: remote.revision + 1 }));
    await expect(loading).rejects.toThrow();
    expect(useCanvasStore.getState().openProject(original.id)).toEqual(original);
    expect(getDocumentBaseline("canvas")).toBe(baseline);
    transport = undefined;
    useCanvasStore.getState().renameProject(original.id, "valid next edit");
    await flushCanvasSave();
    expect(writes.at(-1)?.revision).toBe(2);
    expect(useCanvasStore.getState().openProject(original.id)?.title).toBe("valid next edit");
});
