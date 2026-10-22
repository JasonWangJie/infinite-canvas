import { create } from "zustand";
import i18n from "@/i18n";
import { readCanvasPackage, type CanvasImportProgress } from "@/lib/canvas/canvas-import";
import { currentSession, onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";
import { getDocumentBaseline, getDocumentSaveState, retryDocument } from "@/services/canvas-data";
import { flushCanvasSave, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

type CanvasImportState = {
    status: "idle" | "working" | "saving" | "save-error" | "error" | "saved";
    fileName: string;
    progress: CanvasImportProgress | null;
    projectIds: string[];
    error: string;
};
const initialState: CanvasImportState = { status: "idle", fileName: "", progress: null, projectIds: [], error: "" };
let operation = 0;

function isCurrent(id: number, epoch: number) {
    return id === operation && epoch === sessionEpoch() && Boolean(currentSession());
}
function containsBatch(projects: CanvasProject[] | undefined, ids: string[]) {
    return ids.length > 0 && ids.every((id) => projects?.some((project) => project.id === id));
}
function hasSavedBatch(ids: string[]) {
    const value = getDocumentBaseline("canvas") as { state?: { projects?: CanvasProject[] } } | undefined;
    return Array.isArray(value?.state?.projects) && containsBatch(value.state.projects, ids);
}

async function confirmBatch(ids: string[], id: number, epoch: number, retry = false) {
    try {
        if (!isCurrent(id, epoch)) return;
        if (!containsBatch(useCanvasStore.getState().projects, ids)) throw new Error(i18n.t("canvasImport.batchChanged"));
        if (!retry || getDocumentSaveState("canvas").status !== "saved" || !hasSavedBatch(ids)) {
            if (retry) await retryDocument("canvas");
            if (!isCurrent(id, epoch)) return;
            await flushCanvasSave();
            if (!isCurrent(id, epoch)) return;
        }
        if (!containsBatch(useCanvasStore.getState().projects, ids)) throw new Error(i18n.t("canvasImport.batchChanged"));
        if (!hasSavedBatch(ids)) throw new Error(i18n.t("canvasImport.saveUnconfirmed"));
        useCanvasImportStore.setState({ status: "saved", error: "" });
    } catch (error) {
        if (!isCurrent(id, epoch)) return;
        const missing = !containsBatch(useCanvasStore.getState().projects, ids);
        useCanvasImportStore.setState({ status: missing ? "error" : "save-error", error: missing ? i18n.t("canvasImport.batchChanged") : error instanceof Error ? error.message : i18n.t("canvas.importFailed") });
    }
}

export const useCanvasImportStore = create<CanvasImportState & { startImport: (file: File) => Promise<void>; retrySave: () => Promise<void> }>((set, get) => ({
    ...initialState,
    startImport: async (file) => {
        if (["working", "saving", "save-error"].includes(get().status)) return;
        const id = ++operation, epoch = sessionEpoch();
        set({ status: "working", fileName: file.name, progress: { phase: "reading", completed: 0, total: 1 }, projectIds: [], error: "" });
        try {
            if (!currentSession()) throw new Error(i18n.t("saveRecovery.authorizationRequired"));
            if (!useCanvasStore.getState().hydrated) throw new Error(i18n.t("canvasImport.notReady"));
            if (["error", "conflict"].includes(getDocumentSaveState("canvas").status)) throw new Error(i18n.t("canvasImport.recoveryRequired"));
            const imported = await readCanvasPackage(file, (progress) => { if (isCurrent(id, epoch)) set({ progress }); });
            if (!isCurrent(id, epoch)) return;
            const store = useCanvasStore.getState();
            if (!store.hydrated) throw new Error(i18n.t("canvasImport.notReady"));
            const projectIds = imported.map((project) => project.id);
            store.replaceProjects([...imported, ...store.projects], store.deletedProjects);
            if (!isCurrent(id, epoch)) return;
            set({ status: "saving", projectIds });
            await confirmBatch(projectIds, id, epoch);
        } catch (error) {
            if (id !== operation || epoch !== sessionEpoch()) return;
            set({ status: "error", error: error instanceof Error ? error.message : i18n.t("canvas.importFailed") });
        }
    },
    retrySave: async () => {
        if (get().status !== "save-error") return;
        const id = ++operation, epoch = sessionEpoch(), ids = get().projectIds;
        set({ status: "saving", error: "" });
        await confirmBatch(ids, id, epoch, true);
    },
}));

onSessionEnd(() => {
    operation += 1;
    useCanvasImportStore.setState({ ...initialState, projectIds: [] });
});
