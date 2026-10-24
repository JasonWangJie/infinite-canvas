import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import ipaddr from "ipaddr.js";
import type { ServerConfig } from "./config.ts";
import type { CanvasUser } from "./storage.ts";

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Grant = { grant_id: string; api_key: string; user: CanvasUser; expires_at: number };
export type GrantState = { active: boolean; reason?: string; user?: CanvasUser; expires_at?: number };

export class GatewayError extends Error {
    constructor(readonly code: string, readonly status: number, message: string) {
        super(message);
    }
}

export class Gateway {
    readonly clientProof: string;

    constructor(readonly config: ServerConfig, private readonly transport: Fetcher = fetch) {
        this.clientProof = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
    }

    async control<T>(operation: "exchange" | "introspect" | "revoke", body: unknown, requestId?: string): Promise<T> {
        let response: Response;
        try {
            response = await this.transport(`${this.config.gatewayUrl}/api/integrations/canvas/${operation}`, {
                method: "POST",
                headers: { Authorization: this.clientProof, "Content-Type": "application/json", ...(requestId ? { "X-Request-Id": requestId } : {}) },
                body: JSON.stringify(body),
                redirect: "manual",
            });
        } catch {
            throw new GatewayError("GATEWAY_UNAVAILABLE", 503, "网关授权服务暂不可用");
        }
        if (response.status >= 500) throw new GatewayError("GATEWAY_UNAVAILABLE", 503, "网关授权服务暂不可用");
        if (response.status === 429) throw new GatewayError("AUTH_RATE_LIMITED", 429, "授权请求过于频繁，请稍后重试");
        if (!response.ok) throw new GatewayError(operation === "exchange" ? "AUTH_EXCHANGE_FAILED" : "AUTH_REVOKED", 401, operation === "exchange" ? "授权兑换失败，请重新进入画布" : "网关授权已失效");
        if (response.status === 204) return undefined as T;
        try {
            return await response.json() as T;
        } catch {
            throw new GatewayError("GATEWAY_PROTOCOL_ERROR", 502, "网关返回了无效的授权响应");
        }
    }

    relay(path: string, apiKey: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${apiKey}`);
        headers.set("X-Infinite-Canvas-Client", this.clientProof);
        return this.transport(`${this.config.gatewayUrl}${path}`, { ...init, headers, redirect: "manual" });
    }

    history(path: string, grantId: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers);
        headers.set("Authorization", this.clientProof);
        headers.set("X-Infinite-Canvas-Grant", grantId);
        return this.transport(`${this.config.gatewayUrl}/api/integrations/canvas/history${path}`, { ...init, headers, redirect: "manual" });
    }
}

// The existing New API image downloader permits three redirects. Reuse its
// bound instead of adding a different download policy in the Canvas fork.
const MEDIA_REDIRECTS = 3;

export async function publicMediaResponse(source: string, signal?: AbortSignal): Promise<Response> {
    return publicResourceResponse(source, "media", signal);
}

export async function publicResourceResponse(source: string, content: "media" | "json", signal?: AbortSignal, redirects = 0): Promise<Response> {
    const url = new URL(source);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new GatewayError("MEDIA_URL_REJECTED", 502, "生成结果地址不受支持");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== "unicast")) throw new GatewayError("MEDIA_URL_REJECTED", 502, "生成结果指向受保护的网络地址");
    const selected = addresses[0];
    // Bind the verified address to this actual connection to prevent DNS rebinding.
    const response = await new Promise<Response>((resolve, reject) => {
        const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
            method: "GET",
            signal,
            lookup: (_name, options, done) => done(null, options.all ? [selected] : selected.address, selected.family),
        }, (incoming) => {
            const headers = new Headers();
            for (const name of ["content-type", "location"]) {
                const value = incoming.headers[name];
                if (typeof value === "string") headers.set(name, value);
            }
            resolve(new Response(Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, { status: incoming.statusCode || 502, headers }));
        });
        request.on("error", reject);
        request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects >= MEDIA_REDIRECTS || !response.headers.get("location")) throw new GatewayError("MEDIA_REDIRECT_REJECTED", 502, "生成结果重定向不可用");
        return publicResourceResponse(new URL(response.headers.get("location")!, url).href, content, signal, redirects + 1);
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new GatewayError("MEDIA_DOWNLOAD_FAILED", 502, "生成结果下载失败");
    }
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const accepted = content === "json" ? type === "application/json" || type === "text/plain" : !!type && /^(image\/(png|jpeg|webp|gif|avif|bmp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|ogg|webm|flac|aac))$/.test(type);
    if (!accepted) {
        await response.body?.cancel();
        throw new GatewayError("MEDIA_TYPE_REJECTED", 502, "生成结果不是支持的媒体类型");
    }
    return response;
}
