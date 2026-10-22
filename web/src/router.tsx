import { lazy, Suspense } from "react";
import { Button, Result, Spin } from "antd";
import { createBrowserRouter, Link, Outlet, useLocation, type RouteObject } from "react-router-dom";
import { useTranslation } from "react-i18next";

import UserLayout from "@/layouts/user-layout";
const AssetsPage = lazy(() => import("@/pages/assets"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const ConfigPage = lazy(() => import("@/pages/config"));
const HomePage = lazy(() => import("@/pages/home"));
const ImagePage = lazy(() => import("@/pages/image"));
const NotFound = lazy(() => import("@/pages/not-found"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const TasksPage = lazy(() => import("@/pages/tasks"));
const VideoPage = lazy(() => import("@/pages/video"));

export function RouteLoading() {
    const { t } = useTranslation();
    return (
        <div className="flex h-full min-h-48 items-center justify-center gap-3" role="status">
            <Spin />
            <span>{t("navigation.loadingPage", { defaultValue: "正在加载页面…" })}</span>
        </div>
    );
}

export function RouteError() {
    const { t } = useTranslation();
    return (
        <Result
            status="error"
            title={t("navigation.pageLoadFailed", { defaultValue: "页面加载失败" })}
            subTitle={t("navigation.pageLoadFailedHint", { defaultValue: "可以返回首页，或刷新页面重试。未保存的修改请先恢复或导出。" })}
            extra={
                <>
                    <Link to="/">{t("navigation.backHome", { defaultValue: "返回首页" })}</Link>
                    <Button className="ml-4" onClick={() => window.location.reload()}>
                        {t("workbench.retry")}
                    </Button>
                </>
            }
        />
    );
}

function RouteLayout() {
    const { pathname } = useLocation();
    return (
        <UserLayout>
            <Suspense key={pathname} fallback={<RouteLoading />}>
                <Outlet />
            </Suspense>
        </UserLayout>
    );
}

export const routes: RouteObject[] = [
    {
        element: <RouteLayout />,
        children: [
            {
                errorElement: <RouteError />,
                children: [
                    { path: "/", element: <HomePage /> },
                    { path: "/image", element: <ImagePage /> },
                    { path: "/video", element: <VideoPage /> },
                    { path: "/tasks", element: <TasksPage /> },
                    { path: "/assets", element: <AssetsPage /> },
                    { path: "/prompts", element: <PromptsPage /> },
                    { path: "/canvas", element: <CanvasPage /> },
                    { path: "/canvas/:id", element: <CanvasProjectPage /> },
                    { path: "/config", element: <ConfigPage /> },
                    { path: "*", element: <NotFound /> },
                ],
            },
        ],
    },
];

export const router = createBrowserRouter(routes);
