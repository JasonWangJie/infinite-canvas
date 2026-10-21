import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";

const config = readConfig();
const { app } = createApp(config);
const port = process.env.PORT ? Number(process.env.PORT) : 3001;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");

// SSE and long-running image calls inherit the gateway's timeout policy.
// The BFF adds no transport idle timeout or automatic paid-request retry.
Bun.serve({
    hostname: "0.0.0.0",
    port,
    development: false,
    idleTimeout: 0,
    fetch: app.fetch,
    error() {
        console.error(JSON.stringify({ timestamp: new Date().toISOString(), component: "infinite-canvas", action: "request", result: "failure", code: "UNHANDLED_REQUEST_ERROR" }));
        return Response.json({ error: { code: "INTERNAL_ERROR", message: "画布服务暂不可用" } }, { status: 500, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    },
});
console.log(`Infinite Canvas server listening on port ${port}`);
