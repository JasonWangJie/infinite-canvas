import { useEffect, useRef, useState } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";
import { onSessionEnd, sessionEpoch } from "@/services/api/canvas-client";
import { uploadImage } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";

export async function readClipboardImages() {
    const items = await navigator.clipboard.read();
    const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
    if (!blobs.length) throw new Error(i18n.t("imageWorkbench.clipboardEmpty"));
    return blobs.map((blob, index) => new File([blob], `clipboard-${index + 1}.png`, { type: blob.type }));
}

export function useReferenceImageImport(onImported: (images: ReferenceImage[]) => void, context: string) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [importing, setImporting] = useState(false);
    const active = useRef<AbortController | null>(null);
    const currentContext = useRef(context);
    currentContext.current = context;
    useEffect(() => {
        const cancel = () => { active.current?.abort(); active.current = null; setImporting(false); };
        const unsubscribe = onSessionEnd(cancel);
        return () => { unsubscribe(); active.current?.abort(); active.current = null; };
    }, []);
    useEffect(() => {
        active.current?.abort();
        active.current = null;
        setImporting(false);
    }, [context]);

    const importReferences = async (source: Iterable<File> | (() => Promise<File[]>)) => {
        if (active.current) return;
        const controller = new AbortController(), epoch = sessionEpoch();
        active.current = controller;
        setImporting(true);
        const current = () => !controller.signal.aborted && epoch === sessionEpoch() && context === currentContext.current;
        try {
            const files = typeof source === "function" ? await source() : Array.from(source);
            if (!current()) return;
            const images = files.filter((file) => file.type.startsWith("image/"));
            if (images.length !== files.length) message.warning(t("videoWorkbench.unsupportedFiles"));
            const results = await Promise.allSettled(images.map(async (file) => {
                const image = await uploadImage(file, { signal: controller.signal });
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }));
            if (!current()) return;
            const saved = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
            if (saved.length) onImported(saved);
            const failures = results.flatMap((result, index) => result.status === "rejected" ? [`${images[index].name}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
            if (failures.length) message.error(t("workbench.referenceImportFailed", { files: failures.join("；") }));
        } catch (error) {
            if (current()) message.error(error instanceof Error ? error.message : String(error));
        } finally {
            if (active.current === controller) {
                active.current = null;
                setImporting(false);
            }
        }
    };
    return { importing, importReferences };
}
