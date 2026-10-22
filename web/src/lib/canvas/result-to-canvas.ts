import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { NODE_DEFAULT_SIZE, NODE_SPECS } from "@/constant/canvas";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { currentSession, sessionEpoch } from "@/services/api/canvas-client";
import { fileUrl } from "@/services/canvas-data";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

export type CanvasResult = {
    id: string;
    title: string;
} & ({ kind: "text"; content: string } | {
    kind: "image" | "video";
    url: string;
    storageKey?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
    durationMs?: number;
});
export type CanvasResultPlacement = { projectId: string; nodeId: string; nodeIds: string[]; nodeSnapshots: CanvasNodeData[]; title: string; sessionEpoch: number };

export function canvasResultFromAsset(asset: Asset): CanvasResult {
    if (asset.kind === "text") return { id: asset.id, kind: "text", title: asset.title, content: asset.data.content };
    return {
        id: asset.id,
        kind: asset.kind,
        title: asset.title,
        url: asset.kind === "image" ? asset.data.dataUrl : asset.data.url,
        storageKey: asset.data.storageKey,
        width: asset.data.width,
        height: asset.data.height,
        bytes: asset.data.bytes,
        mimeType: asset.data.mimeType,
    };
}

// Position is the node's top-left corner; callers choose layout or drop alignment.
export function createCanvasResultNode(result: CanvasResult, position: Position): CanvasNodeData {
    const type = result.kind === "text" ? CanvasNodeType.Text : result.kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Video;
    const spec = NODE_DEFAULT_SIZE[type];
    const node: CanvasNodeData = {
        id: `${result.kind}-${nanoid()}`,
        type,
        title: result.title,
        position: { ...position },
        width: spec.width,
        height: spec.height,
    };
    if (result.kind === "text") {
        node.metadata = { ...NODE_SPECS[CanvasNodeType.Text].metadata, content: result.content, status: "success" };
    } else {
        const width = Number.isFinite(result.width) && result.width > 0 ? result.width : spec.width;
        const height = Number.isFinite(result.height) && result.height > 0 ? result.height : spec.height;
        const size = result.kind === "video" ? fitNodeSize(width, height, spec.width, spec.width) : fitNodeSize(width, height);
        const media = { ...result, width, height, url: result.url || (result.storageKey ? fileUrl(result.storageKey) : ""), mimeType: result.mimeType || (result.kind === "image" ? "image/png" : "video/mp4") };
        node.width = size.width;
        node.height = size.height;
        node.metadata = result.kind === "image" ? imageMetadata(media) : videoMetadata({ ...media, storageKey: result.storageKey || "" });
    }
    return node;
}

// Mutate once, then let the caller await flushCanvasSave. A failed save retains
// this receipt so retrying saves the existing draft instead of adding another node.
export function placeResultInCanvas(result: CanvasResult, projectId: string | undefined, epoch: number): CanvasResultPlacement {
    return placeResultsInCanvas([result], projectId, epoch);
}

export function placeResultsInCanvas(results: CanvasResult[], projectId: string | undefined, epoch: number): CanvasResultPlacement {
    if (epoch !== sessionEpoch() || !currentSession()) throw new Error(i18n.t("managed.sessionExpired"));
    if (!results.length) throw new Error(i18n.t("resultToCanvas.emptySelection"));
    const store = useCanvasStore.getState();
    if (!store.hydrated) throw new Error(i18n.t("resultToCanvas.notReady"));
    if (projectId && !store.openProject(projectId)) throw new Error(i18n.t("resultToCanvas.projectMissing"));
    const id = projectId || store.createProject(i18n.t("canvas.defaultTitle", { count: store.projects.length + 1 }));
    const project = useCanvasStore.getState().openProject(id)!;
    // Reuse the canvas's existing 96-unit side offset and 16-unit split-image gap.
    const startX = project.nodes.length ? project.nodes.reduce((right, node) => Math.max(right, node.position.x + node.width), -Infinity) + 96 : 0;
    const columns = Math.ceil(Math.sqrt(results.length));
    let x = startX;
    let y = project.nodes.length ? project.nodes.reduce((top, node) => Math.min(top, node.position.y), Infinity) : 0;
    let rowHeight = 0;
    const nodes = results.map((result, index): CanvasNodeData => {
        if (index && index % columns === 0) {
            x = startX;
            y += rowHeight + 16;
            rowHeight = 0;
        }
        const node = createCanvasResultNode(result, { x, y });
        x += node.width + 16;
        rowHeight = Math.max(rowHeight, node.height);
        return node;
    });
    store.updateProject(id, { nodes: [...project.nodes, ...nodes] });
    return { projectId: id, nodeId: nodes[0].id, nodeIds: nodes.map((node) => node.id), nodeSnapshots: JSON.parse(JSON.stringify(nodes)), title: project.title, sessionEpoch: epoch };
}

// The workbench action and the canvas's initial undo frame share this check.
// Existing media files remain referenced by history/results and are never deleted.
export function resultPlacementUndoNodes(project: Pick<CanvasProject, "id" | "nodes" | "connections">, placement: CanvasResultPlacement): CanvasNodeData[] {
    if (project.id !== placement.projectId) throw new Error(i18n.t("resultToCanvas.projectMissing"));
    const ids = new Set(placement.nodeIds);
    const originals = new Map(placement.nodeSnapshots.map((node) => [node.id, JSON.stringify(node)]));
    const changed = project.nodes.some((node) => ids.has(node.id) && JSON.stringify(node) !== originals.get(node.id));
    const connected = project.connections.some((connection) => ids.has(connection.fromNodeId) || ids.has(connection.toNodeId));
    const referenced = project.nodes.some((node) => !ids.has(node.id) && (
        (node.metadata?.groupId && ids.has(node.metadata.groupId)) || placement.nodeIds.some((id) => node.metadata?.composerContent?.includes(`@[node:${id}]`))
    ));
    if (changed || connected || referenced) throw new Error(i18n.t("resultToCanvas.undoChanged"));
    return project.nodes.filter((node) => !ids.has(node.id));
}

export function undoResultsInCanvas(placement: CanvasResultPlacement, epoch: number): string[] {
    if (epoch !== sessionEpoch() || placement.sessionEpoch !== epoch || !currentSession()) throw new Error(i18n.t("managed.sessionExpired"));
    const store = useCanvasStore.getState();
    if (!store.hydrated) throw new Error(i18n.t("resultToCanvas.notReady"));
    const project = store.openProject(placement.projectId);
    if (!project) throw new Error(i18n.t("resultToCanvas.projectMissing"));
    const nodes = resultPlacementUndoNodes(project, placement);
    const ids = new Set(placement.nodeIds);
    const removed = project.nodes.filter((node) => ids.has(node.id)).map((node) => node.id);
    if (removed.length) store.updateProject(project.id, { nodes });
    return removed;
}
