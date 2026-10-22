import axios from "axios";
import i18n from "@/i18n";

export type CanvasSession = { user: { id: string | number; subject: string; username: string; display_name?: string }; csrf_token: string; session_tag: string; expires_at: number };
export class CanvasSessionError extends Error {
    constructor(
        message: string,
        readonly retryable: boolean,
        readonly status?: number,
    ) {
        super(message);
    }
}
const SESSION_TAG_KEY = "infinite-canvas:session-tag";
const LOGOUT_TAG_KEY = "infinite-canvas:logout-tag";
let session: CanvasSession | null = null;
let requests = new AbortController();
let epoch = 0;
const cleanups = new Set<() => void>();
const channel = typeof window.BroadcastChannel === "function" ? new window.BroadcastChannel("infinite-canvas:session-events") : null;

function readSharedTag() {
    try {
        return localStorage.getItem(SESSION_TAG_KEY);
    } catch {
        return null;
    }
}
function receiveSessionChange(type: string, tag: string) {
    if (session && ((type === "session" && session.session_tag !== tag) || (type === "logout" && session.session_tag === tag))) endCanvasSession();
}
window.addEventListener("storage", (event) => {
    if (event.key === SESSION_TAG_KEY && event.newValue) receiveSessionChange("session", event.newValue);
    if (event.key === LOGOUT_TAG_KEY && event.newValue) receiveSessionChange("logout", event.newValue);
});
channel?.addEventListener("message", (event) => {
    if (event.data && typeof event.data.tag === "string") receiveSessionChange(event.data.type, event.data.tag);
});
export function notifyCanvasLogout(tag: string) {
    try {
        localStorage.setItem(LOGOUT_TAG_KEY, tag);
    } catch {
        /* BroadcastChannel still works when storage is unavailable. */
    }
    channel?.postMessage({ type: "logout", tag });
}

export function currentSession() {
    return session;
}
export function sessionEpoch() {
    return epoch;
}
export function onSessionEnd(cleanup: () => void) {
    cleanups.add(cleanup);
    return () => {
        cleanups.delete(cleanup);
    };
}
export function csrfHeaders(): Record<string, string> {
    return session ? { "X-CSRF-Token": session.csrf_token } : {};
}
export function endCanvasSession(message = "授权已失效，请从 New API 重新进入画布") {
    session = null;
    epoch += 1;
    requests.abort();
    requests = new AbortController();
    cleanups.forEach((cleanup) => cleanup());
    window.dispatchEvent(new CustomEvent("canvas-session-ended", { detail: message }));
}

export async function readCanvasSession(activity = false) {
    const requestEpoch = sessionEpoch();
    const previousSharedTag = readSharedTag();
    if (session && session.expires_at * 1000 <= Date.now()) {
        endCanvasSession();
        throw new CanvasSessionError(i18n.t("managed.sessionExpired"), false);
    }
    let response: Response;
    try {
        response = await fetch("/api/session", {
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            headers: { ...(activity ? { "X-Canvas-Activity": "1" } : {}), ...(session ? { "X-Canvas-Session-Tag": session.session_tag } : {}) },
            signal: requests.signal,
        });
    } catch {
        if (requestEpoch !== sessionEpoch()) throw new CanvasSessionError("登录会话已改变", false);
        throw new CanvasSessionError(i18n.t("managed.connectionInterrupted"), true);
    }
    if (requestEpoch !== sessionEpoch()) throw new CanvasSessionError("登录会话已改变", false);
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        if (requestEpoch !== sessionEpoch()) throw new CanvasSessionError("登录会话已改变", false);
        const message = body.error?.message || i18n.t(response.status === 401 ? "managed.sessionExpired" : "managed.connectionInterrupted");
        if (response.status === 401) endCanvasSession(message);
        throw new CanvasSessionError(message, response.status !== 401, response.status);
    }
    const next = (await response.json().catch(() => null)) as CanvasSession | null;
    if (requestEpoch !== sessionEpoch()) throw new CanvasSessionError("登录会话已改变", false);
    if (!next?.user?.id || !/^ics_[a-f0-9]{32}$/.test(next.user.subject) || !next.csrf_token || !next.session_tag || !Number.isFinite(next.expires_at)) throw new CanvasSessionError(i18n.t("managed.loadFailed"), true);
    if (next.expires_at * 1000 <= Date.now()) {
        endCanvasSession();
        throw new CanvasSessionError(i18n.t("managed.sessionExpired"), false);
    }
    const sharedTag = readSharedTag();
    if (sharedTag !== previousSharedTag && sharedTag !== next.session_tag) {
        endCanvasSession();
        throw new CanvasSessionError("其他标签页已切换授权，请重新进入画布", false);
    }
    if (session && (session.user.subject !== next.user.subject || session.session_tag !== next.session_tag)) {
        endCanvasSession();
        throw new CanvasSessionError("登录用户已改变，请重新进入画布", false);
    }
    session = next;
    if (sharedTag !== next.session_tag) {
        try {
            localStorage.setItem(SESSION_TAG_KEY, next.session_tag);
        } catch {
            /* The channel remains available. */
        }
        channel?.postMessage({ type: "session", tag: next.session_tag });
    }
    return next;
}

export async function canvasFetch(path: string, init: RequestInit = {}) {
    if (!path.startsWith("/api/") || path.startsWith("//")) throw new Error("只允许访问画布的同源接口");
    if (!session) throw new Error("请先通过 New API 授权");
    const requestEpoch = sessionEpoch();
    const headers = new Headers(init.headers);
    headers.set("X-Canvas-Session-Tag", session.session_tag);
    if (!/^(GET|HEAD)$/i.test(init.method || "GET")) headers.set("X-CSRF-Token", session.csrf_token);
    const response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store", redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, requests.signal]) : requests.signal });
    if (requestEpoch !== sessionEpoch()) throw new Error("登录会话已改变");
    if (response.status === 401) {
        const body = await response.json().catch(() => ({}));
        if (requestEpoch !== sessionEpoch()) throw new Error("登录会话已改变");
        const message = body.error?.message || "授权已失效，请从 New API 重新进入画布";
        endCanvasSession(message);
        throw new Error(message);
    }
    return response;
}

export async function canvasJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const epoch = sessionEpoch();
    const response = await canvasFetch(path, init);
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error?.message || (response.status === 409 ? "项目已在其他页面更新，请重新加载后再编辑" : `请求失败（${response.status}）`));
    }
    const value = response.status === 204 ? (undefined as T) : await response.json();
    if (epoch !== sessionEpoch()) throw new Error("登录会话已改变");
    return value;
}

// Existing image/video/audio adapters share axios; no caller can choose another AI host.
axios.interceptors.request.use((config) => {
    if (!config.url?.startsWith("/api/")) throw new Error("受管画布禁止直连外部模型服务");
    if (!session) throw new Error("请先通过 New API 授权");
    config.baseURL = window.location.origin;
    config.headers.delete("Authorization");
    config.headers.delete("x-api-key");
    config.headers.delete("x-goog-api-key");
    config.headers.set("X-CSRF-Token", session.csrf_token);
    config.headers.set("X-Canvas-Session-Tag", session.session_tag);
    (config as typeof config & { canvasEpoch: number }).canvasEpoch = sessionEpoch();
    config.signal = config.signal ? AbortSignal.any([config.signal as AbortSignal, requests.signal]) : requests.signal;
    return config;
});
axios.interceptors.response.use(
    (response) => {
        if ((response.config as typeof response.config & { canvasEpoch?: number }).canvasEpoch !== sessionEpoch()) throw new Error("登录会话已改变");
        return response;
    },
    (error) => {
        if (error.response?.status === 401 && error.config?.canvasEpoch === sessionEpoch()) endCanvasSession(error.response.data?.error?.message);
        return Promise.reject(error);
    },
);

export async function readPrivateBlob(url: string, signal?: AbortSignal) {
    const epoch = sessionEpoch();
    const requestSignal = signal ? AbortSignal.any([signal, requests.signal]) : requests.signal;
    if (url.startsWith("local-file:")) {
        const { readBrowserFile } = await import("@/services/browser-files");
        requestSignal.throwIfAborted();
        if (epoch !== sessionEpoch()) throw new CanvasSessionError("登录会话已改变", false);
        const blob = await readBrowserFile(decodeURIComponent(url.slice("local-file:".length)));
        requestSignal.throwIfAborted();
        return blob;
    }
    if (url.startsWith("data:") || url.startsWith("blob:")) {
        const blob = await (await fetch(url, { signal: requestSignal })).blob();
        if (epoch !== sessionEpoch()) throw new CanvasSessionError("登录会话已改变", false);
        return blob;
    }
    const parsed = new URL(url, window.location.origin);
    const privateMedia = /^\/api\/(result-media\/[A-Za-z0-9_-]+$|prompt-assets\/[A-Za-z0-9_-]+$|ai\/v1\/videos\/)/.test(parsed.pathname);
    const taskMedia = /^\/api\/ai\/v1\/(images|media)\/tasks_async\/[A-Za-z0-9_-]+\/content\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(parsed.pathname) && !parsed.search;
    if (parsed.origin !== window.location.origin || parsed.username || parsed.password || (!privateMedia && !taskMedia)) throw new Error("远程素材必须通过已授权的网关地址读取，请选择本地文件");
    const response = await canvasFetch(`${parsed.pathname}${parsed.search}`, { signal });
    if (!response.ok) throw new Error("无法读取素材，授权可能已过期");
    const blob = await response.blob();
    if (epoch !== sessionEpoch()) throw new CanvasSessionError("登录会话已改变", false);
    return blob;
}
