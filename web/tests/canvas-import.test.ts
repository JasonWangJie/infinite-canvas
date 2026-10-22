import "./browser";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { zipSync } from "fflate";
import { mockBrowserDocuments } from "./local-document-fixture";
import { mockBrowserFiles } from "./local-file-fixture";
import i18n from "@/i18n";
import { readCanvasPackage, type CanvasImportProgress } from "@/lib/canvas/canvas-import";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { findAssetReferences } from "@/lib/asset-references";
import { readZip } from "@/lib/zip";
import { endCanvasSession, readCanvasSession } from "@/services/api/canvas-client";
import { retryDocument } from "@/services/canvas-data";
import { flushCanvasSave, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasImportStore } from "@/stores/canvas/use-canvas-import-store";
import type { CanvasProjectExportItem } from "@/types/canvas-export";

const originalFetch = globalThis.fetch;
const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
const session = { user: { id: 1, subject: `ics_${"a".repeat(32)}`, username: "alice" }, csrf_token: "csrf", session_tag: "canvas-import-session", expires_at: Math.floor(Date.now() / 1000) + 3600 };
let document: { value: { state: { projects: CanvasProject[]; deletedProjects: unknown[] }; version: number }; revision: number };
let requests: { method: string; path: string }[];
let saveFails: boolean;
let imageFails: boolean;
let beforeFileWrite: (() => Promise<void>) | undefined;
let beforeDocumentWrite: (() => Promise<void>) | undefined;
let localDocuments: ReturnType<typeof mockBrowserDocuments>;
let localFiles: ReturnType<typeof mockBrowserFiles>;

function project(id: string): CanvasProject {
    return { id, title: id, createdAt: "2026-01-01", updatedAt: "2026-01-01", nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
}

function mediaProject(id: string): CanvasProjectExportItem {
    return {
        project: { ...project(id), nodes: [{ id: `${id}-video`, title: "video", type: "video", position: { x: 0, y: 0 }, width: 100, height: 60, metadata: { storageKey: `media:${id}`, content: "" } }] },
        files: [{ storageKey: `media:${id}`, path: `files/${id}.mp4`, mimeType: "video/mp4", bytes: 4 }],
    };
}

function packageFile(projects: CanvasProjectExportItem[], contents: Record<string, Uint8Array> = {}) {
    const files = Object.fromEntries(projects.flatMap((item) => item.files.map((file) => [file.path, new Uint8Array([1, 2, 3, 4])])));
    return new File([zipSync({ "projects.json": new TextEncoder().encode(JSON.stringify({ app: "infinite-canvas", version: 3, projects })), ...files, ...contents })], "canvas.zip");
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

beforeEach(async () => {
    endCanvasSession();
    localDocuments = mockBrowserDocuments();
    localFiles = mockBrowserFiles();
    useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
    document = { value: { state: { projects: [project("existing")], deletedProjects: [] }, version: 0 }, revision: 1 };
    requests = [];
    saveFails = false;
    imageFails = false;
    beforeFileWrite = undefined;
    beforeDocumentWrite = undefined;
    Object.defineProperty(globalThis, "Image", { configurable: true, writable: true, value: class {
        src = "";
        naturalWidth = 16;
        naturalHeight = 8;
        async decode() { if (imageFails) throw new Error("invalid image"); }
    } });
    globalThis.fetch = (async (input, init) => {
        const path = String(input), method = init?.method || "GET";
        requests.push({ path, method });
        if (path === "/api/session") return Response.json(session);
        if (path === "/api/files" && method === "POST") {
            const index = requests.filter((item) => item.path === "/api/files" && item.method === "POST").length;
            await beforeFileWrite?.();
            return Response.json({ id: `stored-${index}`, storageKey: `media:stored-${index}`, url: `blob:stored-${index}`, mimeType: "video/mp4", bytes: 4 });
        }
        if (path === "/api/data/canvas") {
            if (method === "PUT") {
                await beforeDocumentWrite?.();
                if (saveFails) return Response.json({ error: { message: "local canvas write failed" } }, { status: 503 });
                const body = JSON.parse(String(init?.body));
                if (body.revision !== document.revision) return Response.json({ error: { message: "revision conflict" } }, { status: 409 });
                document = { value: body.value, revision: document.revision + 1 };
            }
            return Response.json(document);
        }
        throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;
    await readCanvasSession();
    await useCanvasStore.persist.rehydrate();
});

afterEach(() => {
    endCanvasSession();
    useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
    localDocuments.restore();
    localFiles.restore();
    globalThis.fetch = originalFetch;
    if (originalImage) Object.defineProperty(globalThis, "Image", originalImage);
    else Reflect.deleteProperty(globalThis, "Image");
});

test("every canvas and file is validated before storing any package resource", async () => {
    const invalid = mediaProject("invalid");
    invalid.project.connections.push({ id: "broken", fromNodeId: "missing", toNodeId: "invalid-video" });
    await expect(readCanvasPackage(packageFile([mediaProject("valid"), invalid]), () => {})).rejects.toThrow(i18n.t("canvasImport.invalidProject"));
    const missingReference = mediaProject("missing-reference");
    missingReference.project.nodes[0].metadata = { references: ["image:missing"] };
    missingReference.files = [];
    await expect(readCanvasPackage(packageFile([missingReference]), () => {})).rejects.toThrow(i18n.t("assets.importErrors.missingReference"));
    const image = mediaProject("image");
    image.files[0].storageKey = "image:corrupt";
    image.project.nodes[0].metadata = { storageKey: "image:corrupt" };
    imageFails = true;
    await expect(readCanvasPackage(packageFile([image]), () => {})).rejects.toThrow(i18n.t("assets.importErrors.imageUnreadable"));
    await expect(readCanvasPackage(packageFile([]), () => {})).rejects.toThrow(i18n.t("canvasImport.empty"));
    expect(requests.filter((item) => item.method === "POST" || item.method === "PUT")).toHaveLength(0);
    expect(useCanvasStore.getState().projects.map((item) => item.id)).toEqual(["existing"]);
});

test("shared files are stored once and conflicting duplicate identities fail preflight", async () => {
    const first = mediaProject("one"), second = mediaProject("two");
    second.files[0].storageKey = first.files[0].storageKey;
    second.project.nodes[0].metadata!.storageKey = first.files[0].storageKey;
    await expect(readCanvasPackage(packageFile([first, second], { "files/two.mp4": new Uint8Array([4, 3, 2, 1]) }), () => {})).rejects.toThrow(i18n.t("assets.importErrors.invalidManifest"));
    expect(requests.filter((item) => item.method === "POST")).toHaveLength(0);
    const progress: CanvasImportProgress[] = [];
    const imported = await readCanvasPackage(packageFile([first, second]), (item) => progress.push(item));
    expect(requests.filter((item) => item.method === "POST")).toHaveLength(1);
    expect(imported.map((item) => item.nodes[0].metadata?.storageKey)).toEqual(["media:stored-1", "media:stored-1"]);
    expect(imported.map((item) => item.nodes[0].metadata?.content)).toEqual(["blob:stored-1", "blob:stored-1"]);
    expect(progress.filter((item) => item.phase === "uploading").map((item) => item.completed)).toEqual([0, 0, 1]);
    expect(progress.at(-1)).toMatchObject({ completed: 1, total: 1, item: "files/one.mp4" });
    expect(useCanvasStore.getState().projects.map((item) => item.id)).toEqual(["existing"]);
});

test("a complete batch is applied once and a failed save retries the same IDs without restoring files again", async () => {
    const storing = deferred(), finish = deferred();
    beforeFileWrite = async () => { storing.resolve(); await finish.promise; };
    saveFails = true;
    const lengths: number[] = [];
    const unsubscribe = useCanvasStore.subscribe((state, previous) => { if (state.projects !== previous.projects) lengths.push(state.projects.length); });
    const importing = useCanvasImportStore.getState().startImport(packageFile([mediaProject("one"), mediaProject("two")]));
    try {
        await storing.promise;
        expect(useCanvasImportStore.getState()).toMatchObject({ status: "working", progress: { phase: "uploading", completed: 0, total: 2, item: "files/one.mp4" } });
        expect(lengths).toEqual([]);
        await useCanvasImportStore.getState().startImport(new File(["duplicate"], "duplicate.zip"));
        expect(useCanvasImportStore.getState().fileName).toBe("canvas.zip");
    } finally { finish.resolve(); await importing; unsubscribe(); }
    expect(lengths).toEqual([3]);
    expect(useCanvasImportStore.getState().status).toBe("save-error");
    const ids = [...useCanvasImportStore.getState().projectIds];
    expect(ids).toHaveLength(2);
    expect(document.value.state.projects.map((item) => item.id)).toEqual(["existing"]);
    saveFails = false;
    await Promise.all([useCanvasImportStore.getState().retrySave(), useCanvasImportStore.getState().retrySave()]);
    expect(useCanvasImportStore.getState().status).toBe("saved");
    expect(document.value.state.projects.map((item) => item.id)).toEqual([...ids, "existing"]);
    expect(requests.filter((item) => item.method === "POST")).toHaveLength(2);
    expect(requests.filter((item) => item.method === "PUT")).toHaveLength(2);
});

test("global recovery confirms the same batch while deletion prevents a later retry from recreating it", async () => {
    saveFails = true;
    await useCanvasImportStore.getState().startImport(packageFile([mediaProject("one")]));
    saveFails = false;
    await retryDocument("canvas");
    await flushCanvasSave();
    const count = requests.length;
    await useCanvasImportStore.getState().retrySave();
    expect(useCanvasImportStore.getState().status).toBe("saved");
    expect(requests).toHaveLength(count);
    saveFails = true;
    await useCanvasImportStore.getState().startImport(packageFile([mediaProject("two")]));
    const deleted = useCanvasImportStore.getState().projectIds[0];
    useCanvasStore.getState().deleteProjects([deleted]);
    await useCanvasImportStore.getState().retrySave();
    expect(useCanvasImportStore.getState().status).toBe("error");
    expect(useCanvasImportStore.getState().error).toBe(i18n.t("canvasImport.batchChanged"));
    expect(useCanvasStore.getState().projects.some((item) => item.id === deleted)).toBe(false);
    const writes = requests.filter((item) => item.method === "POST").length;
    await useCanvasImportStore.getState().startImport(packageFile([mediaProject("three")]));
    expect(useCanvasImportStore.getState().error).toBe(i18n.t("canvasImport.recoveryRequired"));
    expect(requests.filter((item) => item.method === "POST")).toHaveLength(writes);
});

test("ending a session during a file write ignores its late result and starts no remaining work", async () => {
    const storing = deferred(), finish = deferred();
    beforeFileWrite = async () => { storing.resolve(); await finish.promise; };
    const importing = useCanvasImportStore.getState().startImport(packageFile([mediaProject("one"), mediaProject("two")]));
    try {
        await storing.promise;
        endCanvasSession();
        useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
    } finally { finish.resolve(); await importing; }
    expect(useCanvasImportStore.getState()).toMatchObject({ status: "idle", projectIds: [], fileName: "", progress: null });
    expect(useCanvasStore.getState().projects).toEqual([]);
    expect(requests.filter((item) => item.method === "POST")).toHaveLength(1);
    expect(requests.filter((item) => item.method === "PUT")).toHaveLength(0);
});

test("a late save cannot publish import success in a different session", async () => {
    const saving = deferred(), finish = deferred();
    beforeDocumentWrite = async () => { saving.resolve(); await finish.promise; };
    const importing = useCanvasImportStore.getState().startImport(packageFile([{ project: project("text-only"), files: [] }]));
    try {
        await saving.promise;
        expect(useCanvasImportStore.getState().status).toBe("saving");
        endCanvasSession();
        useCanvasStore.setState({ projects: [], deletedProjects: [], hydrated: false });
    } finally { finish.resolve(); await importing; }
    expect(useCanvasImportStore.getState()).toMatchObject({ status: "idle", projectIds: [], fileName: "" });
    expect(useCanvasStore.getState().projects).toEqual([]);
});

test("canvas packages and asset locations recognize explicit references without treating ordinary text as files", async () => {
    const canvas = project("media: ordinary canvas title");
    const base = { position: { x: 0, y: 0 }, width: 200, height: 100 };
    const pluginData = { label: "media:reference", untouched: ["image: ordinary plugin text"], attachment: { storageKey: "media:attachment", url: "blob:attachment" } };
    const pluginMetadata = { content: "", extension: pluginData };
    canvas.nodes = [
        { ...base, id: "referencing", type: "text", title: "image: ordinary node title", metadata: { content: "image: a red car", prompt: "media: camera notes", references: ["media:reference"] } },
        { ...base, id: "plugin", type: "custom-node", title: "Plugin", metadata: pluginMetadata },
        { ...base, id: "literal", type: "text", title: "Literal", metadata: { content: "media:reference", prompt: "media:attachment" } },
    ];
    expect(findAssetReferences([canvas], "media:reference").map((item) => item.nodeId)).toEqual(["referencing"]);
    expect(findAssetReferences([canvas], "media:attachment").map((item) => item.nodeId)).toEqual(["plugin"]);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        if (["/api/files/media%3Areference", "/api/files/media%3Aattachment"].includes(String(input))) return new Response(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/mp4" }));
        return previousFetch(input, init);
    }) as typeof fetch;
    const saver = await import("file-saver");
    const downloads: Blob[] = [];
    const saveFile = spyOn(saver, "saveAs").mockImplementation((blob: Blob | string) => { if (blob instanceof Blob) downloads.push(blob); });
    try {
        await exportCanvasProjects([canvas], "references");
        expect(downloads).toHaveLength(1);
        const zip = await readZip(downloads[0]);
        const manifest = JSON.parse(await zip.get("projects.json")!.text());
        expect(manifest.projects[0].files.map((file: { storageKey: string }) => file.storageKey).sort()).toEqual(["media:attachment", "media:reference"]);
        const [imported] = await readCanvasPackage(new File([downloads[0]], "references.zip"), () => {});
        const reference = imported.nodes[0].metadata!.references![0];
        expect(reference).not.toBe("media:reference");
        expect(imported.nodes[0].metadata).toEqual({ content: "image: a red car", prompt: "media: camera notes", references: [reference] });
        expect(imported.title).toBe(canvas.title);
        expect(imported.nodes[0].title).toBe(canvas.nodes[0].title);
        const extension = (imported.nodes[1].metadata as typeof pluginMetadata).extension;
        expect(extension.label).toBe(pluginData.label);
        expect(extension.untouched).toEqual(pluginData.untouched);
        expect(extension.attachment.storageKey).not.toBe("media:attachment");
        expect(imported.nodes[2].metadata).toEqual(canvas.nodes[2].metadata);
        expect(findAssetReferences([imported], reference).map((item) => item.nodeId)).toEqual(["referencing"]);
        expect(findAssetReferences([imported], extension.attachment.storageKey).map((item) => item.nodeId)).toEqual(["plugin"]);
        expect(findAssetReferences([imported], "media:reference")).toEqual([]);
    } finally { saveFile.mockRestore(); }
});
