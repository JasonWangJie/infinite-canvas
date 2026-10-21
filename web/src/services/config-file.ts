// Managed application policy and credentials are never part of user packages.
export function exportAppConfig() {
    throw new Error("受管画布不导出服务端配置，请使用画布或素材导出");
}
export async function importAppConfig(_file: File) {
    throw new Error("受管画布不允许导入渠道或执行脚本配置");
}
