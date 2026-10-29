export function isPreferencesSender(event, contents, origin) {
  return isSettingsSender(event, contents, origin, "/settings/general");
}
export function isCliSender(event, contents, origin) {
  return isSettingsSender(event, contents, origin, "/settings/cli");
}
function isSettingsSender(event, contents, origin, path) {
  return Boolean(contents && event.sender === contents && event.senderFrame && event.senderFrame === contents.mainFrame
    && isConsoleURL(event.senderFrame.url, origin) && new URL(event.senderFrame.url).pathname === path);
}
export function isConsoleURL(value, origin) {
  try { const url = new URL(value); return Boolean(origin) && url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}
export function isExternalURL(value, origin) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !isConsoleURL(value, origin); }
  catch { return false; }
}
export async function health(origin, instanceId, fetcher = fetch) {
  if (!origin || !instanceId) return false;
  try {
    const response = await fetcher(`${origin}/api/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    const body = await response.json();
    return response.ok && body.service === "agentforge-control-plane" && body.instanceId === instanceId;
  } catch { return false; }
}

export async function initialRoute(origin, fetcher = fetch) {
  const response = await fetcher(`${origin}/api/auth/bootstrap-status`, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error("无法读取工作区管理员状态，请重试连接。");
  const status = await response.json();
  if (status.configured === true) return "/";
  if (status.configured === false && status.available === true) return "/setup";
  throw new Error("客户端首次设置不可用，请查看本机服务日志。");
}
