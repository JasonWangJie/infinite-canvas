import { Alert, App, Button, Form, Input, Modal, Select, Switch } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelPicker } from "@/components/model-picker";
import { refreshGatewayModels, useConfigStore } from "@/stores/use-config-store";
import { logoutCanvas } from "@/components/layout/client-root-init";
import { useUserStore } from "@/stores/use-user-store";

export function AppConfigPanel(_props: { showDoneButton?: boolean; initialTab?: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const update = useConfigStore((state) => state.updateConfig);
    const user = useUserStore((state) => state.user);
    const [refreshing, setRefreshing] = useState(false);
    const refresh = async () => {
        setRefreshing(true);
        try {
            await refreshGatewayModels();
            message.success(t("managed.modelsUpdated"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("managed.loadFailed"));
        } finally {
            setRefreshing(false);
        }
    };
    return (
        <Form layout="vertical" className="space-y-4">
            <Alert type="info" showIcon title={t("managed.connected")} description={t("managed.account", { name: user?.displayName || user?.username })} />
            <Button onClick={() => void refresh()} loading={refreshing}>
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
            <Button danger onClick={() => void logoutCanvas().catch((error) => message.error(error instanceof Error ? error.message : t("managed.logoutFailed")))}>
                {t("managed.logout")}
            </Button>
        </Form>
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
