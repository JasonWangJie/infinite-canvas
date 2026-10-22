import { Alert, App, Button, Form, Input, Modal, Select, Switch, Tabs, Tag } from "antd";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ModelPicker } from "@/components/model-picker";
import { selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { logoutCanvas, useCanvasLogoutPending } from "@/components/layout/client-root-init";
import { useUserStore } from "@/stores/use-user-store";
import { ConfigLocalStorage } from "./config-local-storage";
import { getGatewayModelState, refreshCanvasModels, subscribeGatewayModels } from "@/services/canvas-bootstrap";
import { getDocumentSaveStates } from "@/services/canvas-data";

export function AppConfigPanel(_props: { showDoneButton?: boolean; initialTab?: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const update = useConfigStore((state) => state.updateConfig);
    const user = useUserStore((state) => state.user);
    const [tab, setTab] = useState("models");
    const models = useSyncExternalStore(subscribeGatewayModels, getGatewayModelState);
    const loggingOut = useCanvasLogoutPending();
    const refresh = async () => {
        try {
            await refreshCanvasModels();
            message.success(t("managed.modelsUpdated"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("managed.loadFailed"));
        }
    };
    const logout = async () => {
        try {
            await logoutCanvas();
        } catch (error) {
            const unsaved = getDocumentSaveStates().some((state) => state.status === "error" || state.status === "conflict");
            message.error(unsaved ? t("managed.logoutSaveFailed", { defaultValue: "本地修改尚未保存，已停止退出。请先恢复或导出草稿。" }) : error instanceof Error ? error.message : t("managed.logoutFailed"));
            if (unsaved) {
                useConfigStore.getState().setConfigDialogOpen(false);
                requestAnimationFrame(() => {
                    const recovery = document.getElementById("document-save-recovery");
                    recovery?.scrollIntoView({ block: "nearest" });
                    recovery?.focus();
                });
            }
        }
    };
    return (
        <Tabs
            activeKey={tab}
            onChange={setTab}
            items={[
                {
                    key: "models",
                    label: t("managed.settings"),
                    children: (
                        <Form layout="vertical" className="space-y-4">
                            <Alert
                                type="info"
                                showIcon
                                title={t("managed.connected")}
                                description={
                                    <div className="space-y-2">
                                        <p>{t("managed.account", { name: user?.displayName || user?.username })}</p>
                                        {models.loading ? (
                                            <p>{t("managed.modelsLoading", { defaultValue: "正在读取可用模型…" })}</p>
                                        ) : !models.error ? (
                                            <>
                                                <p>{t("managed.gatewayModels", { defaultValue: "New API · 当前可用模型 {{count}} 个", count: config.models.length })}</p>
                                                <div className="flex flex-wrap gap-1">
                                                    {(["image", "text", "video", "audio"] as const).map((capability) => (
                                                        <Tag key={capability}>
                                                            {t(`settingsPanels.model.capabilities.${capability}`)} · {selectableModelsByCapability(config, capability).length}
                                                        </Tag>
                                                    ))}
                                                </div>
                                            </>
                                        ) : null}
                                    </div>
                                }
                            />
                            {models.error ? <Alert type="warning" showIcon title={t("managed.modelsUnavailable", { defaultValue: "模型列表暂时不可用，已保存的本地内容仍可查看" })} description={models.error} /> : null}
                            <Button onClick={() => void refresh()} loading={models.loading}>
                                {t("managed.refreshModels")}
                            </Button>
                            {(["image", "text", "video", "audio"] as const).map((capability) => {
                                const key = `${capability}Model` as "imageModel" | "textModel" | "videoModel" | "audioModel";
                                return (
                                    <Form.Item key={key} label={t(`settingsPanels.model.capabilities.${capability}`)}>
                                        <ModelPicker config={config} capability={capability} value={config[key]} onChange={(value) => update(key, value)} fullWidth />
                                    </Form.Item>
                                );
                            })}
                            <Form.Item label={t("managed.systemPrompt")}>
                                <Input.TextArea value={config.systemPrompt} onChange={(event) => update("systemPrompt", event.target.value)} autoSize />
                            </Form.Item>
                            <Form.Item label={t("managed.reasoning")}>
                                <Select value={config.reasoningEffort} onChange={(value) => update("reasoningEffort", value)} options={["auto", "low", "medium", "high", "xhigh"].map((value) => ({ value, label: value }))} />
                            </Form.Item>
                            <Form.Item label={t("managed.autoFocus")}>
                                <Switch checked={config.autoFocusOnSelect} onChange={(value) => update("autoFocusOnSelect", value)} />
                            </Form.Item>
                            <Button danger loading={loggingOut} onClick={() => void logout()}>
                                {t("managed.logout")}
                            </Button>
                        </Form>
                    ),
                },
                { key: "storage", label: t("config.localStorage.title"), children: <ConfigLocalStorage active={tab === "storage"} /> },
            ]}
        />
    );
}

export function AppConfigModal() {
    const { t } = useTranslation();
    const open = useConfigStore((state) => state.isConfigOpen);
    const close = useConfigStore((state) => state.setConfigDialogOpen);
    return (
        <Modal open={open} onCancel={() => close(false)} title={t("managed.settings")} footer={<Button onClick={() => close(false)}>{t("common.done")}</Button>} destroyOnHidden>
            <AppConfigPanel />
        </Modal>
    );
}
