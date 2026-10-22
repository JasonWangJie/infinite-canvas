import { useSyncExternalStore } from "react";
import { theme as antTheme } from "antd";
import { Check, CircleAlert, Clock3, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { getDocumentSaveState, subscribeDocumentSaves } from "@/services/canvas-data";
import { useThemeStore } from "@/stores/use-theme-store";

const readCanvasSave = () => getDocumentSaveState("canvas");

export function CanvasSaveStatus() {
    const { t } = useTranslation();
    const state = useSyncExternalStore(subscribeDocumentSaves, readCanvasSave, readCanvasSave);
    const colorTheme = useThemeStore((value) => value.theme);
    const { token } = antTheme.useToken();
    if (state.status === "idle") return null;
    const failed = state.status === "error" || state.status === "conflict";
    const Icon = failed ? CircleAlert : state.status === "saving" ? LoaderCircle : state.status === "pending" ? Clock3 : Check;
    const label = t(`saveRecovery.status.${state.status}`);
    const content = (
        <>
            <Icon aria-hidden="true" className={`size-3.5 ${state.status === "saving" ? "animate-spin" : ""}`} />
            <span>{label}</span>
        </>
    );
    const style = { color: failed ? token.colorError : canvasThemes[colorTheme].node.muted };
    return (
        <span role="status" aria-live="polite" className="shrink-0 text-xs" style={style}>
            {failed ? (
                <button
                    type="button"
                    className="flex items-center gap-1 rounded px-1 py-1 transition hover:bg-black/5 dark:hover:bg-white/10"
                    onClick={() => {
                        const recovery = document.getElementById("document-save-recovery");
                        recovery?.scrollIntoView({ block: "nearest" });
                        recovery?.focus();
                    }}
                    title={t("saveRecovery.openRecovery")}
                >
                    {content}
                </button>
            ) : (
                <span className="flex items-center gap-1" title={state.updatedAt ? t("saveRecovery.savedAt", { time: new Date(state.updatedAt).toLocaleTimeString() }) : label}>
                    {content}
                </span>
            )}
        </span>
    );
}
