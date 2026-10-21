import { Alert, App, List, Modal, Switch } from "antd";
import { useTranslation } from "react-i18next";
import { setPluginEnabled } from "@/lib/canvas/plugin-loader";
import { usePluginStore } from "@/stores/canvas/use-plugin-store";

export function CanvasPluginManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const plugins = usePluginStore((state) => state.plugins);
    return (
        <Modal open={open} onCancel={onClose} title={t("canvas.plugins.title")} footer={null}>
            <Alert type="info" showIcon title={t("managed.trustedPlugins")} />
            <List
                dataSource={plugins}
                renderItem={(plugin) => (
                    <List.Item actions={[<Switch key="enabled" checked={plugin.enabled} onChange={(enabled) => void setPluginEnabled(plugin, enabled).catch((error) => message.error(String(error)))} />]}>
                        <List.Item.Meta title={plugin.name} description={`${plugin.version} · ${plugin.description || ""}`} />
                    </List.Item>
                )}
            />
        </Modal>
    );
}
