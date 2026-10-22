import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { readZip } from "@/lib/zip";
import { currentSession, sessionEpoch } from "@/services/api/canvas-client";
import { fileUrl } from "@/services/canvas-data";
import { importPackageFiles, remapPackageResources } from "@/services/package-import";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";

export type CanvasImportProgress = { phase: "reading" | "validating" | "uploading"; completed: number; total: number; item?: string };

function validateProject(project: CanvasProject) {
    const invalid = () => new Error(i18n.t("canvasImport.invalidProject"));
    if (!project || typeof project !== "object" || typeof project.id !== "string" || !project.id || typeof project.title !== "string" || typeof project.createdAt !== "string" || typeof project.updatedAt !== "string"
        || !Array.isArray(project.nodes) || !Array.isArray(project.connections) || !Array.isArray(project.chatSessions) || (project.activeChatId !== null && typeof project.activeChatId !== "string")
        || !["dots", "lines", "blank"].includes(project.backgroundMode) || typeof project.showImageInfo !== "boolean" || !project.viewport
        || ![project.viewport.x, project.viewport.y, project.viewport.k].every(Number.isFinite) || project.viewport.k <= 0) throw invalid();
    const nodeIds = new Set<string>();
    for (const node of project.nodes) {
        if (!node || typeof node.id !== "string" || !node.id || nodeIds.has(node.id) || typeof node.type !== "string" || !node.type || typeof node.title !== "string" || !node.position
            || ![node.position.x, node.position.y, node.width, node.height].every(Number.isFinite) || node.width < 0 || node.height < 0
            || (node.metadata !== undefined && (!node.metadata || typeof node.metadata !== "object" || Array.isArray(node.metadata)))) throw invalid();
        nodeIds.add(node.id);
        const metadata = node.metadata;
        if (!metadata) continue;
        for (const value of [metadata.content, metadata.composerContent, metadata.prompt, metadata.storageKey, metadata.groupId]) if (value !== undefined && typeof value !== "string") throw invalid();
        if (metadata.references !== undefined && (!Array.isArray(metadata.references) || !metadata.references.every((reference) => typeof reference === "string"))) throw invalid();
        if (metadata.images !== undefined && (!Array.isArray(metadata.images) || metadata.images.some((image) => !image || typeof image.id !== "string" || typeof image.content !== "string" || typeof image.mimeType !== "string"
            || !["idle", "success", "loading", "error"].includes(image.status) || ![image.naturalWidth, image.naturalHeight, image.bytes].every((value) => Number.isFinite(value) && value >= 0)
            || (image.storageKey !== undefined && typeof image.storageKey !== "string")))) throw invalid();
        if (metadata.texts !== undefined && (!Array.isArray(metadata.texts) || metadata.texts.some((text) => !text || typeof text.id !== "string" || typeof text.content !== "string" || !["idle", "success", "loading", "error"].includes(text.status)))) throw invalid();
    }
    const connectionIds = new Set<string>();
    for (const connection of project.connections) {
        if (!connection || typeof connection.id !== "string" || !connection.id || connectionIds.has(connection.id) || !nodeIds.has(connection.fromNodeId) || !nodeIds.has(connection.toNodeId)) throw invalid();
        connectionIds.add(connection.id);
    }
    const chatIds = new Set<string>();
    for (const chat of project.chatSessions) {
        if (!chat || typeof chat.id !== "string" || !chat.id || chatIds.has(chat.id) || typeof chat.title !== "string" || typeof chat.createdAt !== "string" || typeof chat.updatedAt !== "string" || !Array.isArray(chat.messages)
            || chat.messages.some((message) => !message || typeof message.id !== "string" || typeof message.text !== "string" || !["user", "assistant", "system", "tool", "error"].includes(message.role)
                || (message.references !== undefined && (!Array.isArray(message.references) || message.references.some((reference) => !reference || typeof reference.id !== "string" || typeof reference.type !== "string" || typeof reference.title !== "string"))))) throw invalid();
        chatIds.add(chat.id);
    }
    if (project.activeChatId !== null && !chatIds.has(project.activeChatId)) throw invalid();
}

async function validateCanvasImage(source: string | Blob, assertSession: () => void) {
    const url = typeof source === "string" ? source : URL.createObjectURL(source);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        assertSession();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error();
    } catch (error) {
        assertSession();
        throw new Error(i18n.t("assets.importErrors.imageUnreadable"), { cause: error });
    } finally {
        if (typeof source !== "string") URL.revokeObjectURL(url);
    }
}

// Every project and referenced file is checked before the first resource is stored.
export async function readCanvasPackage(file: File, onProgress: (progress: CanvasImportProgress) => void): Promise<CanvasProject[]> {
    const epoch = sessionEpoch();
    const assertSession = () => {
        if (!currentSession() || epoch !== sessionEpoch()) throw new Error(i18n.t("saveRecovery.sessionChanged"));
    };
    const report = (progress: CanvasImportProgress) => { assertSession(); onProgress(progress); assertSession(); };
    report({ phase: "reading", completed: 0, total: 1, item: file.name });
    let zip: Map<string, Blob>;
    let data: CanvasExportFile;
    try {
        zip = await readZip(file);
        assertSession();
        const manifest = zip.get("projects.json");
        if (!manifest) throw new Error(i18n.t("assets.importErrors.missingFile"));
        data = JSON.parse(await manifest.text()) as CanvasExportFile;
        assertSession();
    } catch (error) {
        assertSession();
        throw new Error(`${file.name}: ${i18n.t("assets.importErrors.invalidPackage")}`, { cause: error });
    }
    if (data?.app !== "infinite-canvas" || data.version !== 3 || !Array.isArray(data.projects) || data.projects.some((item) => !item || !Array.isArray(item.files) || !item.project)) throw new Error(i18n.t("assets.importErrors.invalidPackage"));
    if (!data.projects.length) throw new Error(i18n.t("canvasImport.empty"));
    report({ phase: "reading", completed: 1, total: 1, item: file.name });
    const entries = data.projects.flatMap((item) => item.files);
    const total = data.projects.length + entries.length;
    const files = new Map<string, CanvasExportAsset>();
    let completed = 0;
    for (const [index, item] of entries.entries()) {
        const label = item && typeof item.path === "string" ? item.path : `projects.json files[${index}]`;
        report({ phase: "validating", completed, total, item: label });
        if (!item || typeof item.storageKey !== "string" || !/^(image|media):.+/.test(item.storageKey) || typeof item.path !== "string" || !item.path || typeof item.mimeType !== "string" || !Number.isFinite(item.bytes) || item.bytes < 0) throw new Error(`${label}: ${i18n.t("assets.importErrors.invalidManifest")}`);
        const blob = zip.get(item.path);
        if (!blob || blob.size !== item.bytes) throw new Error(`${label}: ${i18n.t("assets.importErrors.missingFile")}`);
        const previous = files.get(item.storageKey);
        if (previous) {
            const [left, right] = await Promise.all([zip.get(previous.path)!.arrayBuffer(), blob.arrayBuffer()]);
            assertSession();
            const rightBytes = new Uint8Array(right);
            if (previous.mimeType !== item.mimeType || left.byteLength !== right.byteLength || !new Uint8Array(left).every((value, position) => value === rightBytes[position])) throw new Error(`${label}: ${i18n.t("assets.importErrors.invalidManifest")}`);
        } else if (item.storageKey.startsWith("image:")) {
            try {
                await validateCanvasImage(blob, assertSession);
                assertSession();
            } catch (error) {
                assertSession();
                throw new Error(`${label}: ${i18n.t("assets.importErrors.imageUnreadable")}`, { cause: error });
            }
        }
        if (!previous) files.set(item.storageKey, item);
        report({ phase: "validating", completed: ++completed, total, item: label });
    }
    const references = new Map([...files].map(([key]) => [key, { storageKey: key, url: fileUrl(key) }]));
    const projectIds = new Set<string>();
    for (const item of data.projects) {
        const label = typeof item.project.title === "string" ? item.project.title : "projects.json";
        report({ phase: "validating", completed, total, item: label });
        try {
            validateProject(item.project);
            if (projectIds.has(item.project.id)) throw new Error(i18n.t("canvasImport.invalidProject"));
            projectIds.add(item.project.id);
            remapPackageResources(item.project, references);
            for (const node of item.project.nodes) {
                const images = [node.type === "image" && !node.metadata?.storageKey ? node.metadata?.content : undefined, ...(node.metadata?.images || []).filter((image) => !image.storageKey).map((image) => image.content)];
                for (const image of images) if (image?.startsWith("data:image/")) await validateCanvasImage(image, assertSession);
            }
        } catch (error) {
            throw new Error(`${label}: ${error instanceof Error ? error.message : i18n.t("canvasImport.invalidProject")}`);
        }
        report({ phase: "validating", completed: ++completed, total, item: label });
    }
    report({ phase: "uploading", completed: 0, total: files.size });
    const mapping = await importPackageFiles([...files.values()], zip, { guard: assertSession, onProgress: (progress) => report({ phase: "uploading", ...progress }) });
    assertSession();
    const now = new Date().toISOString();
    return data.projects.map(({ project }) => ({ ...remapPackageResources(project, mapping), id: nanoid(), title: project.title || i18n.t("canvas.project.imported"), updatedAt: now }));
}
