export type ServerConfig = {
    origin: string;
    gatewayUrl: string;
    gatewayPublicUrl: string;
    clientId: string;
    clientSecret: string;
    encryptionKey: string;
    dataDir: string;
};

export const LOGIN_TRANSACTION_SECONDS = 5 * 60;
export const SESSION_SECONDS = 8 * 60 * 60;
export const SESSION_IDLE_SECONDS = 30 * 60;

export function readConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
    const required = (name: string) => {
        const value = env[name]?.trim();
        if (!value) throw new Error(`Missing ${name}`);
        return value;
    };
    const origin = new URL(required("CANVAS_ORIGIN"));
    if (origin.href !== `${origin.origin}/` || origin.username || origin.password || origin.search || origin.hash) throw new Error("CANVAS_ORIGIN must be an exact origin");
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("CANVAS_ORIGIN requires HTTPS, except loopback development");
    const gatewayUrl = new URL(required("NEW_API_URL"));
    const publicUrl = new URL(required("NEW_API_PUBLIC_URL"));
    for (const url of [gatewayUrl, publicUrl]) {
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("New API addresses must be HTTP(S) base URLs without credentials or query parameters");
    }
    if (publicUrl.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname)) throw new Error("NEW_API_PUBLIC_URL requires HTTPS, except loopback development");
    const encryptionKey = required("CANVAS_SESSION_ENCRYPTION_KEY");
    if (Buffer.from(encryptionKey, "base64").length !== 32) throw new Error("CANVAS_SESSION_ENCRYPTION_KEY must encode exactly 32 random bytes in base64");
    const clientSecret = required("NEW_API_CLIENT_SECRET");
    if (clientSecret.length < 32) throw new Error("NEW_API_CLIENT_SECRET must meet the New API minimum of 32 characters");
    return {
        origin: origin.origin,
        gatewayUrl: gatewayUrl.href.replace(/\/+$/, ""),
        gatewayPublicUrl: publicUrl.href.replace(/\/+$/, ""),
        clientId: env.NEW_API_CLIENT_ID?.trim() || "infinite-canvas",
        clientSecret,
        encryptionKey,
        dataDir: required("DATA_DIR"),
    };
}
