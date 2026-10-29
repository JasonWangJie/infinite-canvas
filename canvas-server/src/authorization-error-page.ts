import { html } from "hono/html";

const messages: Record<string, { title: string; description: string }> = {
    AUTH_EXCHANGE_FAILED: { title: "未能完成画布授权", description: "画布未能完成与 New API 的授权连接。请重新授权；如果仍然失败，请联系管理员检查画布接入配置。" },
    AUTH_TRANSACTION_INVALID: { title: "授权链接已失效", description: "此链接可能已过期、已使用，或并非在当前浏览器中发起。请重新授权，获取新的画布访问链接。" },
    AUTH_RATE_LIMITED: { title: "授权请求过于频繁", description: "请稍后重新授权，或先返回 New API。无需反复刷新当前页面。" },
    GATEWAY_UNAVAILABLE: { title: "授权服务暂时不可用", description: "暂时无法连接 New API 授权服务。请稍后重新授权；如果持续出现，请联系管理员。" },
    GATEWAY_PROTOCOL_ERROR: { title: "授权连接未能完成", description: "授权服务未能返回有效结果。请重新授权；如果仍然失败，请联系管理员检查接入配置。" },
    SESSION_SAVE_FAILED: { title: "暂时无法创建画布会话", description: "此次授权未能完成，请重新授权；如果仍然失败，请联系管理员检查画布服务。" },
    INTERNAL_ERROR: { title: "暂时无法进入画布", description: "画布授权服务遇到了问题。请稍后重新授权；如果持续出现，请联系管理员，并提供下方错误码。" },
};

// This page is served before the React application can load. Keep it independent
// of the web bundle, using Hono's escaped HTML and the canvas theme's palette.
export function authorizationErrorPage(code: string, gatewayPublicUrl: string, nonce: string) {
    const safeCode = Object.hasOwn(messages, code) ? code : "INTERNAL_ERROR";
    const message = messages[safeCode];
    return html`<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${message.title} · AI 无限画布</title>
    <style nonce="${nonce}">
        :root{color-scheme:light dark;--bg:#f4f2ed;--panel:#fbfaf7;--ink:#292524;--muted:#57534e;--line:#d6d3ca;--dot:rgba(68,64,60,.16);--accent:#875327;--button:#1c1917;--button-text:#fafaf9}
        *{box-sizing:border-box}body{margin:0;min-height:100svh;background:var(--bg);color:var(--ink);font:15px/1.8 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;background-image:radial-gradient(var(--dot) 1px,transparent 1px);background-size:22px 22px}
        a{color:inherit;text-decoration:none}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:5px}header{max-width:1120px;margin:auto;padding:28px 32px;display:flex;align-items:center;gap:12px;font-size:14px}header strong{font-weight:650;letter-spacing:.06em}header span{color:var(--muted);font-size:12px;border-left:1px solid var(--line);padding-left:12px}
        main{min-height:calc(100svh - 90px);display:grid;place-items:center;padding:32px 24px 96px}.panel{width:100%;max-width:580px;padding:48px;background:var(--panel);border:1px solid var(--line);border-radius:24px;box-shadow:0 16px 56px rgba(28,25,23,.04)}.symbol{width:64px;height:64px;margin-bottom:28px;color:var(--accent)}.eyebrow{margin:0 0 12px;color:var(--muted);font-size:12px;letter-spacing:.14em}h1{font-size:clamp(25px,5vw,34px);line-height:1.45;letter-spacing:-.04em;margin:0 0 16px;font-weight:650}.description{color:var(--muted);margin:0;text-wrap:pretty}
        .actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;margin-top:32px}.primary{display:inline-flex;align-items:center;justify-content:center;gap:20px;min-height:46px;padding:10px 22px;border-radius:10px;background:var(--button);color:var(--button-text);font-weight:600}.secondary{padding:8px 0;color:var(--muted)}a:hover{opacity:.78}details{margin-top:34px;padding-top:22px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}summary{cursor:pointer;width:fit-content}dl{margin:14px 0 8px;display:flex;flex-wrap:wrap;gap:4px 12px}dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,"Cascadia Code",monospace;color:var(--ink)}.hint{margin:0;font-size:12px}
        @media(prefers-color-scheme: dark){:root{--bg:#181715;--panel:#1f1d1a;--ink:#f5f5f4;--muted:#d6d3d1;--line:#44403c;--dot:rgba(245,245,244,.1);--accent:#e7c49e;--button:#fafaf9;--button-text:#1c1917}}
        @media(max-width:520px){header{padding:20px 24px}main{padding:24px 16px 64px;min-height:calc(100svh - 70px)}.panel{padding:32px 24px;border-radius:18px}.actions{align-items:stretch;flex-direction:column}.secondary{text-align:center}.symbol{margin-bottom:24px}}
    </style>
</head>
<body>
    <header><strong>AI 无限画布</strong><span>New API</span></header>
    <main>
        <section class="panel" aria-labelledby="error-title">
            <svg class="symbol" viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="7" y="7" width="50" height="50" rx="13" stroke="currentColor" stroke-width="1.5"/><path d="M23 32h7m5 0h6M32 21v7m0 8v7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="32" cy="32" r="19" stroke="currentColor" stroke-opacity=".25" stroke-dasharray="2 4"/></svg>
            <p class="eyebrow">画布访问 · 授权连接</p>
            <h1 id="error-title">${message.title}</h1>
            <p class="description">${message.description}</p>
            <nav class="actions" aria-label="授权恢复操作">
                <a class="primary" href="/auth/start">重新授权 <span aria-hidden="true">↗</span></a>
                <a class="secondary" href="${gatewayPublicUrl}">返回 New API</a>
            </nav>
            <details><summary>查看排查信息</summary><dl><dt>错误码</dt><dd>${safeCode}</dd></dl><p class="hint">请将错误码提供给管理员，请勿发送完整授权链接。</p></details>
        </section>
    </main>
</body>
</html>`;
}
