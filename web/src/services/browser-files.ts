import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { onSessionEnd } from "@/services/api/canvas-client";
import { assertBrowserOwner, browserStorageKey, browserStore, captureBrowserOwner } from "@/services/browser-storage";

export type BrowserFile = { id: string; storageKey: string; url: string; mimeType: string; bytes: number };
const urls = new Map<string, string>();

onSessionEnd(() => {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
});

export function localFileUrl(storageKey: string) {
    return `local-file:${encodeURIComponent(storageKey)}`;
}

export async function readBrowserFile(storageKey: string): Promise<Blob> {
    const owner = captureBrowserOwner();
    const blob = await browserStore(owner, "files").getItem<Blob>(browserStorageKey(owner, storageKey));
    assertBrowserOwner(owner);
    if (!(blob instanceof Blob)) throw new Error(i18n.t("browserStorage.fileMissing"));
    return blob;
}

export async function resolveBrowserFileUrl(storageKey: string) {
    const owner = captureBrowserOwner();
    const key = browserStorageKey(owner, storageKey);
    if (urls.has(key)) return urls.get(key)!;
    const blob = await browserStore(owner, "files").getItem<Blob>(key);
    assertBrowserOwner(owner);
    // Keep an asset with a missing file visible so its metadata can still be recovered.
    if (!(blob instanceof Blob)) return "";
    if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
    return urls.get(key)!;
}

export async function writeBrowserFile(blob: Blob, kind: "image" | "media"): Promise<BrowserFile> {
    const owner = captureBrowserOwner();
    const id = nanoid();
    const storageKey = `${kind}:${id}`;
    const key = browserStorageKey(owner, storageKey);
    await browserStore(owner, "files").setItem(key, blob);
    assertBrowserOwner(owner);
    const url = URL.createObjectURL(blob);
    urls.set(key, url);
    return { id, storageKey, url, mimeType: blob.type, bytes: blob.size };
}

export async function deleteBrowserFile(storageKey: string) {
    const owner = captureBrowserOwner();
    const key = browserStorageKey(owner, storageKey);
    await browserStore(owner, "files").removeItem(key);
    assertBrowserOwner(owner);
    const url = urls.get(key);
    if (url) URL.revokeObjectURL(url);
    urls.delete(key);
}
