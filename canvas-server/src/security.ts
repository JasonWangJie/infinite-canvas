import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "__Host-infinite_canvas_session";
export const TRANSACTION_COOKIE = "__Host-infinite_canvas_login";

export function randomSecret(): string {
    return randomBytes(32).toString("base64url");
}

export function digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

export function equalSecret(a: string, b: string): boolean {
    const aa = Buffer.from(a);
    const bb = Buffer.from(b);
    return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export class CredentialVault {
    private readonly key: Promise<CryptoKey>;

    constructor(encodedKey: string) {
        this.key = crypto.subtle.importKey("raw", Buffer.from(encodedKey, "base64"), "AES-GCM", false, ["encrypt", "decrypt"]);
    }

    async seal(value: string, binding: string): Promise<string> {
        const iv = randomBytes(12);
        const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: Buffer.from(binding) }, await this.key, Buffer.from(value));
        return Buffer.concat([iv, Buffer.from(bytes)]).toString("base64");
    }

    async open(value: string, binding: string): Promise<string> {
        const bytes = Buffer.from(value, "base64");
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: Buffer.from(binding) }, await this.key, bytes.subarray(12));
        return Buffer.from(plain).toString();
    }
}
