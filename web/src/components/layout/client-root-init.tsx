import { type ReactNode, useEffect, useState } from "react";
import { Alert, Button, Result, Spin } from "antd";
import { canvasJson, currentSession, endCanvasSession, notifyCanvasLogout, readCanvasSession, sessionEpoch } from "@/services/api/canvas-client";
import { useTranslation } from "react-i18next";

let bootstrap: Promise<void> | undefined;
function initialize() {
    bootstrap ||= readCanvasSession().then(async (session) => {
        const { hydrateCanvasSession } = await import("@/services/canvas-bootstrap");
        await hydrateCanvasSession(session);
    });
    return bootstrap;
}

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const [ready, setReady] = useState(false);
    const [error, setError] = useState("");
    const [storageError, setStorageError] = useState("");
    useEffect(() => {
        let alive = true;
        for (const key of ["infinite-canvas:ai_config_store", "canvas-agent-token", "canvas-agent-url"]) localStorage.removeItem(key);
        void initialize()
            .then(() => {
                if (alive && currentSession()) setReady(true);
            })
            .catch((reason) => {
                if (alive) setError(reason instanceof Error ? reason.message : t("managed.authorizationFailed"));
            });
        const expired = (event: Event) => {
            setReady(false);
            setError((event as CustomEvent<string>).detail || t("managed.sessionExpired"));
        };
        const saveError = (event: Event) => setStorageError((event as CustomEvent<string>).detail);
        const recheck = () => {
            if (!currentSession() || document.visibilityState === "hidden") return;
            const epoch = sessionEpoch();
            void readCanvasSession().catch((reason) => {
                if (epoch === sessionEpoch()) endCanvasSession(reason instanceof Error ? reason.message : undefined);
            });
        };
        let checkingActivity = false;
        const activity = () => {
            if (!currentSession() || checkingActivity) return;
            checkingActivity = true;
            const epoch = sessionEpoch();
            void readCanvasSession(true)
                .catch((reason) => {
                    if (epoch === sessionEpoch()) endCanvasSession(reason instanceof Error ? reason.message : undefined);
                })
                .finally(() => {
                    checkingActivity = false;
                });
        };
        window.addEventListener("canvas-session-ended", expired);
        window.addEventListener("canvas-storage-error", saveError);
        window.addEventListener("focus", recheck);
        document.addEventListener("visibilitychange", recheck);
        window.addEventListener("pointerdown", activity, { passive: true });
        window.addEventListener("keydown", activity);
        return () => {
            alive = false;
            window.removeEventListener("canvas-session-ended", expired);
            window.removeEventListener("canvas-storage-error", saveError);
            window.removeEventListener("focus", recheck);
            document.removeEventListener("visibilitychange", recheck);
            window.removeEventListener("pointerdown", activity);
            window.removeEventListener("keydown", activity);
        };
    }, [t]);
    useEffect(() => {
        if (!ready) return;
        const timer = window.setTimeout(() => endCanvasSession(), Math.max(0, (currentSession()?.expires_at || 0) * 1000 - Date.now()));
        return () => window.clearTimeout(timer);
    }, [ready]);
    if (error)
        return (
            <div className="flex min-h-dvh items-center justify-center bg-background">
                <Result
                    status="403"
                    title={t("managed.authorizationRequired")}
                    subTitle={error}
                    extra={
                        <Button type="primary" href="/auth/start">
                            {t("managed.authorize")}
                        </Button>
                    }
                />
            </div>
        );
    if (!ready)
        return (
            <div className="flex min-h-dvh items-center justify-center bg-background">
                <Spin description={t("managed.checking")} />
            </div>
        );
    return (
        <>
            {storageError ? <Alert type="error" showIcon title={t("managed.saveFailed")} description={storageError} action={<Button onClick={() => window.location.reload()}>{t("managed.reload")}</Button>} /> : null}
            {children}
        </>
    );
}

export async function logoutCanvas() {
    const tag = currentSession()?.session_tag;
    await canvasJson<void>("/api/logout", { method: "POST" });
    if (tag) notifyCanvasLogout(tag);
    endCanvasSession();
}
