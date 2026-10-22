import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

// Resource identities live in storageKey fields and generation reference lists.
// Other strings, including prompts and unknown plugin fields, are ordinary text.
export function collectAssetStorageKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    if ("references" in value && Array.isArray(value.references)) {
        for (const reference of value.references) if (typeof reference === "string" && /^(?:image|media):/.test(reference)) keys.add(reference);
    }
    for (const child of Object.values(value)) collectAssetStorageKeys(child, keys);
    return keys;
}

export function findAssetReferences(projects: readonly CanvasProject[], storageKey: string) {
    return projects.flatMap((project) => project.nodes
        .filter((node) => collectAssetStorageKeys(node.metadata).has(storageKey))
        .map((node) => ({ projectId: project.id, projectTitle: project.title, nodeId: node.id, nodeTitle: node.title || node.id })));
}
