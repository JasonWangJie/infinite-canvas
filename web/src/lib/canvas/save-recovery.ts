import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { getDocumentBaseline, getDocumentDraft, resolveDocumentConflict } from "@/services/canvas-data";
import { onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";
import { flushCanvasSave, type CanvasProject, type CanvasDeletedProject } from "@/stores/canvas/use-canvas-store";

type CanvasDocument = { state: { projects: CanvasProject[]; deletedProjects: CanvasDeletedProject[] }; version: number };
let recoveryReceipt: { epoch: number; source: string; copies: Map<string, CanvasProject> } | undefined;
onSessionEnd(() => {
    recoveryReceipt = undefined;
});

// A canvas document contains every project. Keep all remotely saved records, and
// copy every locally edited project so recovering one canvas cannot discard another.
export async function prepareCanvasConflictCopies(activeProjectId?: string) {
    await flushCanvasSave().catch(() => {});
    const source = JSON.stringify(getDocumentDraft("canvas")) ?? "";
    if (!recoveryReceipt || recoveryReceipt.epoch !== sessionEpoch() || recoveryReceipt.source !== source) recoveryReceipt = { epoch: sessionEpoch(), source, copies: new Map() };
    const receipt = recoveryReceipt;
    const baseline = getDocumentBaseline("canvas") as CanvasDocument | null | undefined;
    const previous = new Map((baseline?.state?.projects || []).map((project) => [project.id, project]));
    const document = await resolveDocumentConflict("canvas", (remoteValue, localValue) => {
        const remote = remoteValue as CanvasDocument | null;
        const local = localValue as CanvasDocument;
        if (!Array.isArray(local?.state?.projects) || (remote !== null && (!Array.isArray(remote?.state?.projects) || !Array.isArray(remote.state.deletedProjects)))) throw new Error(i18n.t("saveRecovery.invalidCanvas"));
        const now = new Date().toISOString();
        const changed = local.state.projects.filter((project) => project.id === activeProjectId || JSON.stringify(project) !== JSON.stringify(previous.get(project.id)));
        if (!changed.length) throw new Error(i18n.t("saveRecovery.noDraft"));
        const copies: CanvasProject[] = [];
        for (const project of changed) {
            let copy = receipt.copies.get(project.id);
            const existing = copy && remote?.state.projects.find((item) => item.id === copy.id);
            if (copy && existing && JSON.stringify(copy) === JSON.stringify(existing)) continue;
            if (!copy || existing || remote?.state.deletedProjects.some((item) => item.id === copy!.id)) copy = { ...project, id: nanoid(), title: i18n.t("saveRecovery.copyTitle", { title: project.title }), createdAt: now, updatedAt: now };
            receipt.copies.set(project.id, copy);
            copies.push(copy);
        }
        return { ...remote, version: remote?.version ?? local.version, state: { ...remote?.state, projects: [...copies, ...(remote?.state.projects || [])], deletedProjects: remote?.state.deletedProjects || [] } };
    });
    const target = (activeProjectId && receipt.copies.get(activeProjectId)) || receipt.copies.values().next().value;
    if (!target) throw new Error(i18n.t("saveRecovery.noDraft"));
    return { document, projectId: target.id, count: receipt.copies.size };
}
