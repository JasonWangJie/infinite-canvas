import { spyOn } from "bun:test";
import * as files from "@/services/browser-files";
import { assertBrowserOwner, captureBrowserOwner } from "@/services/browser-storage";

// Reuse controlled media fixtures at the local file boundary. No production upload is involved.
export function mockBrowserFiles(transport?: typeof fetch) {
    const write = spyOn(files, "writeBrowserFile").mockImplementation(async (blob, kind) => {
        const owner = captureBrowserOwner();
        const body = new FormData();
        body.set("file", blob, kind);
        body.set("kind", kind);
        const response = await (transport || globalThis.fetch)("/api/files", { method: "POST", body, signal: owner.signal });
        assertBrowserOwner(owner);
        const result = await response.json();
        assertBrowserOwner(owner);
        if (!response.ok) throw new Error(result.error?.message || "Local file write failed");
        return result;
    });
    const read = spyOn(files, "readBrowserFile").mockImplementation(async (key) => {
        const owner = captureBrowserOwner();
        const response = await (transport || globalThis.fetch)(`/api/files/${encodeURIComponent(key)}`, { signal: owner.signal });
        if (!response.ok) throw new Error("Local file is missing");
        const blob = await response.blob();
        assertBrowserOwner(owner);
        return blob;
    });
    const resolve = spyOn(files, "resolveBrowserFileUrl").mockImplementation(async (key) => {
        captureBrowserOwner();
        return `/api/files/${encodeURIComponent(key)}`;
    });
    const remove = spyOn(files, "deleteBrowserFile").mockImplementation(async (key) => {
        const owner = captureBrowserOwner();
        const response = await (transport || globalThis.fetch)(`/api/files/${encodeURIComponent(key)}`, { method: "DELETE", signal: owner.signal });
        assertBrowserOwner(owner);
        if (!response.ok) throw new Error("Local file deletion failed");
    });
    return { restore: () => { write.mockRestore(); read.mockRestore(); resolve.mockRestore(); remove.mockRestore(); } };
}
