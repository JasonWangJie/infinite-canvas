import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Alert, Button, Result, Spin } from "antd";
import { CanvasSessionError, canvasJson, currentSession, endCanvasSession, notifyCanvasLogout, onSessionEnd, readCanvasSession, sessionEpoch } from "@/services/api/canvas-client";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

let bootstrap: Promise<void> | undefined;
onSessionEnd(() => {
    bootstrap = undefined;
});
function initialize() {
    if (!bootstrap) {
        const epoch = sessionEpoch();
        const pending = readCanvasSession()
            .then(async (session) => {
                const { hydrateCanvasSession } = await import("@/services/canvas-bootstrap");
                if (epoch !== sessionEpoch()) throw new CanvasSessionError(i18n.t("managed.sessionExpired"), false);
                await hydrateCanvasSession(session);
                if (epoch !== sessionEpoch()) throw new CanvasSessionError(i18n.t("managed.sessionExpired"), false);
            })
            .catch((error) => {
                if (bootstrap === pending) bootstrap = undefined;
                throw error;
            });
        bootstrap = pending;
    }
    return bootstrap;
}

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const [ready, setReady] = useState(false);
    const [error, setError] = useState("");
    const [connectionError, setConnectionError] = useState("");
    const [retryable, setRetryable] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [expiresAt, setExpiresAt] = useState(0);
    const recheck = useCallback(async (activity = false) => {
        if (!currentSession() || document.visibilityState === "hidden") return;
        const epoch = sessionEpoch();
        try {
            const session = await readCanvasSession(activity);
            if (epoch === sessionEpoch()) {
                setConnectionError("");
                setExpiresAt(session.expires_at);
            }
        } catch (reason) {
            // Authentication failures terminate the session in canvas-client.
            // A failed connectivity check must not discard drafts or abort AI work.
            if (epoch === sessionEpoch() && currentSession()) setConnectionError(reason instanceof Error ? reason.message : String(reason));
        }
    }, []);
    useEffect(() => {
        let alive = true;
        for (const key of ["infinite-canvas:ai_config_store", "canvas-agent-token", "canvas-agent-url"]) localStorage.removeItem(key);
        setError("");
        void initialize()
            .then(() => {
                if (alive && currentSession()) {
                    setExpiresAt(currentSession()!.expires_at);
                    setReady(true);
                }
            })
            .catch((reason) => {
                if (alive) {
                    setError(reason instanceof Error ? reason.message : t("managed.authorizationFailed"));
                    setRetryable(!(reason instanceof CanvasSessionError) || reason.retryable);
                }
            });
        return () => {
            alive = false;
        };
    }, [t, attempt]);
    useEffect(() => {
        const expired = (event: Event) => {
            setReady(false);
            setRetryable(false);
            setConnectionError("");
            setError((event as CustomEvent<string>).detail || t("managed.sessionExpired"));
        };
        const focus = () => {
            void recheck();
        };
        let checkingActivity = false;
        const activity = () => {
            if (!currentSession() || checkingActivity) return;
            checkingActivity = true;
            void recheck(true).finally(() => {
                checkingActivity = false;
            });
        };
        window.addEventListener("canvas-session-ended", expired);
        window.addEventListener("focus", focus);
        document.addEventListener("visibilitychange", focus);
        window.addEventListener("pointerdown", activity, { passive: true });
        window.addEventListener("keydown", activity);
        return () => {
            window.removeEventListener("canvas-session-ended", expired);
            window.removeEventListener("focus", focus);
            document.removeEventListener("visibilitychange", focus);
            window.removeEventListener("pointerdown", activity);
            window.removeEventListener("keydown", activity);
        };
    }, [t, recheck]);
    useEffect(() => {
        if (!ready) return;
        const timer = window.setTimeout(() => endCanvasSession(), Math.max(0, expiresAt * 1000 - Date.now()));
        return () => window.clearTimeout(timer);
    }, [ready, expiresAt]);
    if (error)
        return (
            <div className="flex min-h-dvh items-center justify-center bg-background">
                <Result
                    status={retryable ? "warning" : "403"}
                    title={t(retryable ? "managed.loadFailed" : "managed.authorizationRequired")}
                    subTitle={error}
                    extra={
                        retryable ? (
                            <Button type="primary" onClick={() => setAttempt((value) => value + 1)}>
                                {t("workbench.retry")}
                            </Button>
                        ) : (
                            <Button type="primary" href="/auth/start">
                                {t("managed.authorize")}
                            </Button>
                        )
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
            {connectionError ? <Alert type="warning" showIcon title={t("managed.connectionInterrupted")} description={connectionError} action={<Button onClick={() => void recheck()}>{t("workbench.retry")}</Button>} /> : null}
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
