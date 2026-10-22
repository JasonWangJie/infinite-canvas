import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import i18n from "@/i18n";
const ProtectedRouter = React.lazy(() => import("@/router").then(({ router }) => ({ default: () => <RouterProvider router={router} /> })));

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AppProviders>
            <React.Suspense fallback={<div className="flex h-full min-h-48 items-center justify-center" role="status">{i18n.t("navigation.loadingPage", { defaultValue: "正在加载页面…" })}</div>}>
                <ProtectedRouter />
            </React.Suspense>
        </AppProviders>
    </React.StrictMode>,
);
