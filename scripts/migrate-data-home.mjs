#!/usr/bin/env node
// One-time, operator-run migration of application instance data to ~/.agentforge.
//
// This is NOT an in-app auto migration: the operator runs it explicitly after
// stopping every AgentForge instance. Per instance it copies the application
// whitelist (databases, run files, runtime configuration, desktop endpoint and
// preferences), verifies every file by size + SHA-256, then renames the legacy
// entries to *.migrated-backup-<timestamp> without deleting anything.
// Chromium-managed userData files and frozen Task/Run workspaces are excluded
// by construction (whitelist enumeration, never whole-directory copy).
//
// Usage:
//   node scripts/migrate-data-home.mjs            # dry-run plan, no changes
//   node scripts/migrate-data-home.mjs --yes      # execute the migration
//   --only web|desktop|desktop-dev   limit to one instance
//   --home DIR                       override ~ (isolated rehearsal/tests)
//   --user-data DIR                  override the packaged desktop legacy root
//   --web-origin URL                 override the Web liveness probe (4310)
import { cp, lstat, mkdir, readdir, readFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Application-owned entries only. workspaces/ is deliberately absent: frozen
// historical Task/Run paths stay where they are and remain readable.
export const whitelistFiles = [
  "agentforge.sqlite", "agentforge.sqlite-wal", "agentforge.sqlite-shm",
  "agentforge.sqlite.history.sqlite", "agentforge.sqlite.history.sqlite-wal", "agentforge.sqlite.history.sqlite-shm",
  "agentforge.sqlite.reset.json", "agentforge.sqlite.reset.json.pending",
  "auth.sqlite", "auth.sqlite-wal", "auth.sqlite-shm",
  "desktop-endpoint.json", "desktop-preferences.json"
];
export const whitelistDirectories = ["agentforge-runs", "runtime-configs"];

export function packagedUserDataRoot({ home = homedir(), platform = process.platform, env = process.env } = {}) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "AgentForge");
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "AgentForge");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "AgentForge");
}

export function migrationInstances({ home = homedir(), userData = null } = {}) {
  const dataHome = join(home, ".agentforge");
  return [
    { id: "web", source: join(repoRoot, ".data"), target: join(dataHome, "web") },
    { id: "desktop", source: userData || packagedUserDataRoot({ home }), target: join(dataHome, "desktop") },
    { id: "desktop-dev", source: join(repoRoot, ".data", "desktop-dev"), target: join(dataHome, "desktop-dev") }
  ];
}

async function listSourceEntries(source) {
  const entries = [];
  for (const name of [...whitelistFiles, ...whitelistDirectories]) {
    let info;
    try { info = await lstat(join(source, name)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (info.isSymbolicLink()) throw new Error(`拒绝搬迁符号链接：${join(source, name)}`);
    entries.push({ name, kind: info.isDirectory() ? "directory" : "file" });
  }
  return entries;
}

async function assertNoSymlinks(root) {
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`拒绝搬迁符号链接：${path}`);
    if (info.isDirectory()) await assertNoSymlinks(path);
    else if (!info.isFile()) throw new Error(`拒绝搬迁非常规文件：${path}`);
  }
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function treeFiles(root, base = root) {
  const files = [];
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`拒绝符号链接：${path}`);
    if (info.isDirectory()) files.push(...await treeFiles(path, base));
    else if (!info.isFile()) throw new Error(`拒绝非常规文件：${path}`);
    else files.push(path.slice(base.length + 1));
  }
  return files.sort();
}

// Full content comparison of one whitelist entry; returns a mismatch reason or null.
export async function compareEntry(source, target, kind) {
  if (kind === "file") return (await hashFile(source)) === (await hashFile(target)) ? null : "内容不一致";
  const [sourceFiles, targetFiles] = [await treeFiles(source), await treeFiles(target)];
  if (sourceFiles.join("\n") !== targetFiles.join("\n")) return "目录文件清单不一致";
  for (const relative of sourceFiles) {
    if (await hashFile(join(source, relative)) !== await hashFile(join(target, relative))) return `文件不一致：${relative}`;
  }
  return null;
}

async function probeHealth(origin, instanceId = null) {
  try {
    const response = await fetch(`${origin}/api/health`, { redirect: "error", signal: AbortSignal.timeout(1500) });
    const health = await response.json();
    return response.ok && health.service === "agentforge-control-plane" && (!instanceId || health.instanceId === instanceId);
  } catch { return false; }
}

async function assertInstanceStopped(instance, { webOrigin }) {
  if (instance.id === "web" && await probeHealth(webOrigin))
    throw new Error(`独立 Web 服务仍在监听 ${webOrigin}；请先停止该实例再搬迁`);
  try {
    const endpoint = JSON.parse(await readFile(join(instance.source, "desktop-endpoint.json"), "utf8"));
    if (endpoint && await probeHealth(endpoint.origin, endpoint.instanceId))
      throw new Error(`桌面实例仍在运行（${endpoint.origin}）；请先退出客户端再搬迁`);
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return;
    throw error;
  }
}

export async function migrateInstance(instance, { apply = false, stamp, webOrigin } = {}) {
  const report = { instance: instance.id, source: instance.source, target: instance.target, planned: [], copied: [], reused: [], backups: [], skipped: false };
  const entries = await listSourceEntries(instance.source);
  if (!entries.length) { report.skipped = true; return report; }
  for (const entry of entries) if (entry.kind === "directory") await assertNoSymlinks(join(instance.source, entry.name));
  try { await assertInstanceStopped(instance, { webOrigin }); }
  catch (error) { if (apply) throw error; report.warning = error.message; }
  for (const entry of entries) {
    const targetPath = join(instance.target, entry.name);
    let existing = null;
    try { existing = await lstat(targetPath); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing) {
      if (existing.isSymbolicLink()) throw new Error(`目标已是符号链接，拒绝覆盖：${targetPath}`);
      if (entry.kind === "file" && !existing.isFile()) throw new Error(`目标类型不符（应为常规文件）：${targetPath}`);
      if (entry.kind === "directory" && !existing.isDirectory()) throw new Error(`目标类型不符（应为目录）：${targetPath}`);
      const mismatch = await compareEntry(join(instance.source, entry.name), targetPath, entry.kind);
      if (mismatch) throw new Error(`目标 ${targetPath} 已存在且${mismatch}；为避免覆盖不同实例数据，已中止。请人工核对后处理。`);
      report.reused.push(entry.name);
    } else report.planned.push(entry.name);
  }
  if (!apply) return report;
  await mkdir(instance.target, { recursive: true, mode: 0o700 });
  for (const name of report.planned) {
    const entry = entries.find(item => item.name === name);
    await cp(join(instance.source, name), join(instance.target, name), { recursive: true, force: false, errorOnExist: true });
    const mismatch = await compareEntry(join(instance.source, name), join(instance.target, name), entry.kind);
    if (mismatch) throw new Error(`复制校验失败（${mismatch}）：${name}。旧数据未改动，目标保留已复制内容，修正后可重跑。`);
    report.copied.push(name);
  }
  for (const entry of entries) {
    const backup = join(instance.source, `${entry.name}.migrated-backup-${stamp}`);
    try { await lstat(backup); throw new Error(`备份名称已存在，拒绝覆盖：${backup}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(join(instance.source, entry.name), backup);
    report.backups.push(backup);
  }
  return report;
}

function parseArgs(argv) {
  const options = { apply: false, home: homedir(), userData: null, only: null, webOrigin: "http://127.0.0.1:4310" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes") options.apply = true;
    else if (arg === "--home") options.home = resolve(argv[++index] || "");
    else if (arg === "--user-data") options.userData = resolve(argv[++index] || "");
    else if (arg === "--only") { options.only = argv[++index]; if (!["web", "desktop", "desktop-dev"].includes(options.only)) throw new Error("--only 仅支持 web|desktop|desktop-dev"); }
    else if (arg === "--web-origin") options.webOrigin = argv[++index];
    else if (arg === "--help" || arg === "-h") { console.log("用法：node scripts/migrate-data-home.mjs [--yes] [--only web|desktop|desktop-dev] [--home DIR] [--user-data DIR] [--web-origin URL]\n默认仅打印计划；--yes 才执行复制、校验与备份改名。旧数据绝不删除。"); process.exit(0); }
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const instances = migrationInstances(options).filter(instance => !options.only || instance.id === options.only);
  console.log(`数据目录搬迁${options.apply ? "" : "（演练，未做修改；加 --yes 执行）"}：目标根 ${join(options.home, ".agentforge")}`);
  let failed = 0, acted = 0;
  for (const instance of instances) {
    try {
      const report = await migrateInstance(instance, { apply: options.apply, stamp, webOrigin: options.webOrigin });
      if (report.skipped) { console.log(`- ${instance.id}：旧位置无应用数据，跳过（${instance.source}）`); continue; }
      acted += 1;
      console.log(`- ${instance.id}：${instance.source} → ${instance.target}`);
      if (report.warning) console.log(`    警告：${report.warning}`);
      for (const name of report.planned) console.log(`    待复制 ${name}${options.apply ? "（已复制并校验 SHA-256）" : ""}`);
      for (const name of report.reused) console.log(`    已存在且一致 ${name}`);
      for (const backup of report.backups) console.log(`    旧文件已改名为 ${backup}`);
      if (options.apply) console.log(`    回滚：删除目标中新条目并把上述备份改回原名；备份不会被自动删除。`);
    } catch (error) {
      failed += 1;
      console.error(`- ${instance.id}：失败：${error.message}`);
      console.error(`  旧数据保持原样；修复原因后可重新运行本脚本（幂等）。`);
    }
  }
  if (!options.apply && acted) console.log("确认以上计划后，加 --yes 执行；任务工作目录（workspaces/）不在搬迁范围，历史任务路径保持冻结。");
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`搬迁失败：${error.message}`); process.exit(1); });
}
