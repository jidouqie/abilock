// Public form contract only; this module is also safe to bundle in the UI.
export const configurationFormVersion = 2;
export const configurationRestartMessage =
  "配置页版本不一致。应用请退出后重开；abl config 请在终端按 Ctrl+C 后重新运行，再刷新页面。";

export function isConfigurationCompatible(version: unknown) {
  return version === configurationFormVersion;
}

export function requireConfigurationCompatible(version: unknown) {
  if (!isConfigurationCompatible(version))
    throw new Error(configurationRestartMessage);
}
