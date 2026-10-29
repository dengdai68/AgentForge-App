import { lstat, open, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

// Only called by the authenticated instance lifecycle, never by an Agent.
// A committed intent rolls forward: reset cannot be rolled back after deletion.
export function createDataReset({ databasePath, authDatabasePath, runFilesRoot, runtimeConfigRoot, logDirectory, protectedPaths = [] }) {
  const journal = `${resolve(databasePath)}.reset.json`;
  const pending = `${journal}.pending`;
  const roots = { metadata: resolve(databasePath), authentication: resolve(authDatabasePath), runs: resolve(runFilesRoot), runtime: resolve(runtimeConfigRoot), history: `${resolve(databasePath)}.history.sqlite` };
  const protectedRoots = [resolve(homedir()), ...protectedPaths.map(path => resolve(path))];
  function safeTarget(path) {
    if (!isAbsolute(path) || path.includes("\0") || path.split(sep).filter(Boolean).length < 2 || protectedRoots.some(root => root === path || root.startsWith(path + sep))) throw new Error("清除目标包含受保护目录，未执行清除");
    return path;
  }
  async function regularTarget(path, kind) {
    safeTarget(path);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory())) throw new Error("清除目标类型或链接不安全，未执行清除");
      if (kind === "file" && info.nlink !== 1) throw new Error("清除目标存在硬链接，未执行清除");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  async function targets(plan) {
    if (plan?.version !== 1 || !Array.isArray(plan.workspaces) || !Array.isArray(plan.logs)) throw new Error("数据清除记录无效");
    const items = [];
    for (const [key, path] of Object.entries(roots)) {
      if (["runs", "runtime"].includes(key)) {
        await regularTarget(path, "directory");
        let names = [];
        try { names = await readdir(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
        const owned = key === "runs" ? /^(runs|communications|\.deleting)$/ : /^(mcp|plugins|catalogs|marketplace|installed-plugins|git-credentials\.json|\.git-credentials-[a-f0-9-]{36}\.tmp)$/;
        if (names.some(name => !owned.test(name))) throw new Error("数据目录包含非 AgentForge 文件，请先检查本机数据位置；未执行清除");
      }
      items.push({ path, kind: ["runs", "runtime"].includes(key) ? "directory" : "file" });
      if (!["runs", "runtime"].includes(key)) for (const suffix of ["-wal", "-shm", "-journal"]) items.push({ path: path + suffix, kind: "file" });
    }
    for (const item of plan.workspaces) {
      if (!item || !/^task_[A-Za-z0-9_-]+$/.test(item.taskId) || !/^run_[A-Za-z0-9_]+$/.test(item.runId) || typeof item.path !== "string" || resolve(item.path) !== item.path || basename(item.path) !== item.runId || basename(dirname(item.path)) !== item.taskId) throw new Error("受管目录归属无效，未执行清除");
      const marker = join(item.path, ".agentforge", "workspace-ready.json");
      await regularTarget(item.path, "directory");
      try {
        await regularTarget(join(item.path, ".agentforge"), "directory");
        await regularTarget(marker, "file");
        const saved = JSON.parse(await readFile(marker, "utf8"));
        if (saved.taskId !== item.taskId) throw new Error("受管目录标记归属不符，未执行清除");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      items.push({ path: item.path, kind: "directory" });
    }
    for (const name of plan.logs) {
      if (typeof name !== "string" || !/^\d{4}-\d{2}-\d{2}T[\dTZ-]+-\d+-[a-f0-9]{8}-\d+\.jsonl$/.test(name)) throw new Error("日志清除记录无效");
      items.push({ path: join(resolve(logDirectory), name), kind: "file" });
    }
    // Validate the whole plan before the first destructive operation.
    for (const item of items) await regularTarget(item.path, item.kind);
    return items;
  }
  return {
    async begin(workspaces) {
      let logs = [];
      await regularTarget(resolve(logDirectory), "directory");
      try { logs = (await readdir(logDirectory)).filter(name => /^\d{4}-\d{2}-\d{2}T[\dTZ-]+-\d+-[a-f0-9]{8}-\d+\.jsonl$/.test(name)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const plan = { version: 1, workspaces, logs };
      await targets(plan);
      try { await lstat(journal); throw new Error("已有数据清除尚未完成，请重启后继续"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const file = await open(pending, "wx", 0o600);
      try {
        try { await file.writeFile(JSON.stringify(plan)); await file.sync(); }
        finally { await file.close(); }
        await rename(pending, journal);
      } catch (error) { await rm(pending, { force: true }); throw error; }
    },
    async recover() {
      let plan;
      try { await regularTarget(journal, "file"); plan = JSON.parse(await readFile(journal, "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        // An intent that never reached the atomic commit point must not erase data.
        await regularTarget(pending, "file"); await rm(pending, { force: true });
        return false;
      }
      const items = await targets(plan);
      for (const item of items) await rm(item.path, { recursive: item.kind === "directory", force: true });
      // Remove only empty task containers. Foreign files keep their parent intact.
      for (const path of new Set(plan.workspaces.map(item => dirname(item.path)))) {
        try { await rmdir(path); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
      }
      await rm(journal);
      return true;
    }
  };
}
