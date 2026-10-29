import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const closeModes = { quit: "退出程序", tray: "保留在菜单栏" };
export function normalizeCloseMode(value) { return typeof value === "string" && Object.hasOwn(closeModes, value) ? value : null; }
export async function readCloseMode(path) {
  try { return normalizeCloseMode(JSON.parse(await readFile(path, "utf8"))?.closeMode); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
}
export async function saveCloseMode(path, mode) {
  if (typeof mode !== "string" || !Object.hasOwn(closeModes, mode)) throw new Error("关闭行为无效");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.tmp`;
  await writeFile(pending, JSON.stringify({ closeMode: mode }), { mode: 0o600 });
  await rename(pending, path);
}
