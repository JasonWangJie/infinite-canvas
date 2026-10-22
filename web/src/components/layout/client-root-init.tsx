import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Alert, Button, Modal, Result, Spin } from "antd";
import { CanvasSessionError, canvasJson, currentSession, endCanvasSession, notifyCanvasLogout, onSessionEnd, readCanvasSession, sessionEpoch } from "@/services/api/canvas-client";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { flushAllDocuments } from "@/services/canvas-data";
import { getGatewayModelState, hydrateCanvasSession, refreshCanvasModels, subscribeGatewayModels } from "@/services/canvas-bootstrap";

let bootstrap: Promise<void> | undefined;
let logoutRequest: Promise<void> | undefined;
const logoutListeners = new Set<() => void>();
const subscribeLogout = (listener: () => void) => {
    logoutListeners.add(listener);
    return () => {
        logoutListeners.delete(listener);
    };
};
const getLogoutPending = () => Boolean(logoutRequest);
export function useCanvasLogoutPending() {
    return useSyncExternalStore(subscribeLogout, getLogoutPending);
}
onSessionEnd(() => {
    bootstrap = undefined;
});
function initialize() {
    if (!bootstrap) {
        const epoch = sessionEpoch();
        const pending = readCanvasSession()
            .then(async (session) => {
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
    const loggingOut = useCanvasLogoutPending();
    const models = useSyncExternalStore(subscribeGatewayModels, getGatewayModelState);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState("");
    const [connectionError, setConnectionError] = useState("");
    const [retryable, setRetryable] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [expiresAt, setExpiresAt] = useState(0);
    const recheck = useCallback(async (activity = false) => {
        if (!currentSession() || logoutRequest || document.visibilityState === "hidden") return;
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
        <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
            {connectionError ? <Alert type="warning" showIcon title={t("managed.connectionInterrupted")} description={connectionError} action={<Button onClick={() => void recheck()}>{t("workbench.retry")}</Button>} /> : null}
            {models.loading && !models.error ? <Alert type="info" showIcon title={t("managed.modelsLoading", { defaultValue: "正在读取可用模型…" })} /> : null}
            {models.error ? (
                <Alert
                    type="warning"
                    showIcon
                    title={t("managed.modelsUnavailable", { defaultValue: "模型列表暂时不可用，已保存的本地内容仍可查看" })}
                    description={models.error}
                    action={
                        <Button loading={models.loading} onClick={() => void refreshCanvasModels().catch(() => {})}>
                            {t("managed.refreshModels")}
                        </Button>
                    }
                />
            ) : null}
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            <Modal open={loggingOut} centered closable={false} keyboard={false} mask={{ closable: false }} footer={null} title={t("managed.logoutSaving", { defaultValue: "正在保存并退出" })}>
                <div className="flex items-center gap-3 py-4" role="status">
                    <Spin />
                    <span>{t("managed.logoutSavingHint", { defaultValue: "正在保存本地修改，请稍候。" })}</span>
                </div>
            </Modal>
        </div>
    );
}

export function logoutCanvas() {
    if (logoutRequest) return logoutRequest;
    const epoch = sessionEpoch();
    const tag = currentSession()?.session_tag;
    const blockInteraction = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    const events = ["pointerdown", "keydown", "beforeinput", "click", "drop", "submit"];
    events.forEach((name) => window.addEventListener(name, blockInteraction, true));
    const beforeUnload = (event: BeforeUnloadEvent) => {
        event.preventDefault();
        event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    const pending = (async () => {
        // Canvas inputs commit local React state on blur before their save effect runs.
        flushSync(() => {
            (document.activeElement as HTMLElement | null)?.blur?.();
            window.dispatchEvent(new CustomEvent("canvas-before-logout"));
        });
        await flushAllDocuments();
        if (epoch !== sessionEpoch()) throw new CanvasSessionError(i18n.t("managed.sessionExpired"), false);
        await canvasJson<void>("/api/logout", { method: "POST" });
        if (tag) notifyCanvasLogout(tag);
        endCanvasSession();
    })().finally(() => {
        events.forEach((name) => window.removeEventListener(name, blockInteraction, true));
        window.removeEventListener("beforeunload", beforeUnload);
        if (logoutRequest === pending) logoutRequest = undefined;
        logoutListeners.forEach((listener) => listener());
    });
    logoutRequest = pending;
    logoutListeners.forEach((listener) => listener());
    return pending;
}
