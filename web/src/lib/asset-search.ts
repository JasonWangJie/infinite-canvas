import type { Asset, AssetKind } from "@/stores/use-asset-store";

export function filterAssets(assets: readonly Asset[], { keyword, kind = "all", tag }: { keyword: string; kind?: AssetKind | "all"; tag?: string }) {
    const query = keyword.trim().toLowerCase();
    return assets.filter((asset) => {
        if (asset.kind !== "text" && asset.kind !== "image" && asset.kind !== "video") return false;
        if (kind !== "all" && asset.kind !== kind) return false;
        if (tag !== undefined && !asset.tags?.includes(tag)) return false;
        return !query || [asset.title, asset.source || "", asset.note || "", (asset.tags || []).join(" "), asset.kind === "text" ? asset.data.content : asset.data.mimeType].join(" ").toLowerCase().includes(query);
    });
}
