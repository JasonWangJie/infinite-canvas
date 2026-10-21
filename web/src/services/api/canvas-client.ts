import axios from "axios";

export type CanvasSession = { user: { id: string | number; subject: string; username: string; display_name?: string }; csrf_token: string; session_tag: string; expires_at: number };
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
    const response = await fetch("/api/session", {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { ...(activity ? { "X-Canvas-Activity": "1" } : {}), ...(session ? { "X-Canvas-Session-Tag": session.session_tag } : {}) },
        signal: requests.signal,
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error?.message || "授权已失效，请从 New API 重新进入画布");
    }
    const next = (await response.json()) as CanvasSession;
    if (!next.user?.id || !/^ics_[a-f0-9]{32}$/.test(next.user.subject) || !next.csrf_token || !next.session_tag || next.expires_at * 1000 <= Date.now()) throw new Error("画布授权无效");
    if (requestEpoch !== sessionEpoch()) throw new Error("登录会话已改变");
    const sharedTag = readSharedTag();
    if (sharedTag !== previousSharedTag && sharedTag !== next.session_tag) {
        endCanvasSession();
        throw new Error("其他标签页已切换授权，请重新进入画布");
    }
    if (session && (session.user.subject !== next.user.subject || session.session_tag !== next.session_tag)) {
        endCanvasSession();
        throw new Error("登录用户已改变，请重新进入画布");
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
    const requestSignal = signal ? AbortSignal.any([signal, requests.signal]) : requests.signal;
    if (url.startsWith("data:") || url.startsWith("blob:")) return (await fetch(url, { signal: requestSignal })).blob();
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin || !/^\/api\/(files\/|prompt-assets\/|ai\/v1\/videos\/)/.test(parsed.pathname)) throw new Error("远程素材必须先由网关安全保存，请上传本地文件");
    const response = await canvasFetch(`${parsed.pathname}${parsed.search}`, { signal });
    if (!response.ok) throw new Error("无法读取素材，授权可能已过期");
    return response.blob();
}
