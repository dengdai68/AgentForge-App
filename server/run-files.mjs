import { initializeWorkspaceGit, workspaceGitStatus, workspaceGitDiff, sourceControlPath } from "./workspace-git.mjs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { diagnostic, diagnosticRedactor } from "./diagnostics.mjs";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { copyFile, lstat, mkdir, open, readFile, readdir, rm, stat, writeFile, appendFile, rename, mkdtemp } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_PREVIEW_BYTES = 512 * 1024;
const DIRECTORY_PAGE_SIZE = 200;
const DEFAULT_MAX_TREE_ENTRIES = 1000;
const execFileAsync = promisify(execFile);
const ignoredDirectories = new Set([".git", "node_modules", ".data", ".agentforge"]);
const sensitiveWorkspaceEntry = (name) => [".npmrc", ".pypirc", "credentials.json"].includes(name) || /^\.env(?:\.|$)/i.test(name) || /\.(pem|key|p12|pfx)$/i.test(name) || /^id_(rsa|ed25519)(?:\.|$)/.test(name);
const hiddenWorkspaceEntry = (name) => ignoredDirectories.has(name) || [".DS_Store", "__pycache__", ".cache", ".venv", "coverage", ".agentforge-workspace.json"].includes(name) || sensitiveWorkspaceEntry(name);
const privateWorkspaceEntry = (name) => [".git", ".agentforge", ".agentforge-workspace.json", ".DS_Store"].includes(name) || sensitiveWorkspaceEntry(name);

function workspaceRelative(path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("工作目录路径必须是规范的相对路径");
  return path;
}

function workspaceRepositories(task) {
  const repositories = task.repositoryMode === "agent" ? task.repositorySources.map((source) => source.path) : [...new Set((task.workflowSnapshot?.nodes || []).map((node) => node.repositoryPath).filter(Boolean))];
  return repositories.map(path=>({path}));
}

// Resolve the root and each component with lstat: neither a declared root nor
// a descendant may redirect the read outside the Task through a symbolic link.
async function workspaceRoot(workspacePath) {
  const root = resolve(workspacePath), info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error("工作目录不允许读取符号链接");
  if (!info.isDirectory()) throw new Error("任务工作目录不存在");
  return root;
}

async function workspaceFile(workspacePath, path) {
  workspaceRelative(path);
  let current = await workspaceRoot(workspacePath);
  for (const component of path.split("/")) {
    current = assertInside(workspacePath, join(current, component));
    if ((await lstat(current)).isSymbolicLink()) throw new Error("工作目录不允许读取符号链接");
  }
  return current;
}

// Artifact metadata is a relative path, not a capability to read arbitrary
// files. Check every stored path component because a previously captured file
// may be replaced after a Trace finishes.
async function artifactFile(runRoot, storagePath) {
  const normalized = safeRelativePath(storagePath);
  if (isAbsolute(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("产物路径不合法");
  let current = runRoot, info;
  for (const component of normalized.split("/")) {
    current = assertInside(runRoot, join(current, component));
    info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Artifact 文件不允许符号链接");
  }
  return { path: current, info };
}

async function readArtifactFile(runRoot, storagePath, maxBytes = null) {
  let file = await artifactFile(runRoot, storagePath);
  if (!file.info.isFile()) throw new Error("Artifact 必须是常规文件");
  if (maxBytes !== null && file.info.size > maxBytes) throw new Error(`产物大于 ${maxBytes} 字节，请在本地文件系统中查看`);
  const content = await readFile(file.path);
  file = await artifactFile(runRoot, storagePath);
  if (!file.info.isFile()) throw new Error("Artifact 必须是常规文件");
  if (maxBytes !== null && content.length > maxBytes) throw new Error(`产物大于 ${maxBytes} 字节，请在本地文件系统中查看`);
  return { content, bytes: content.length };
}

function artifactReadOptions(options, defaultMaxBytes) {
  if (typeof options === "number") return { maxBytes: options, expected: null };
  if (options == null) return { maxBytes: defaultMaxBytes, expected: null };
  if (typeof options !== "object" || Array.isArray(options)) throw new Error("Artifact 读取选项无效");
  const maxBytes = options.maxBytes === undefined ? defaultMaxBytes : options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Artifact 读取大小上限无效");
  return { maxBytes, expected: options.expected ?? null };
}

function verifyArtifactSnapshot(file, expected) {
  if (expected == null) return;
  if (!expected || typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0) throw new Error("Artifact 快照完整性无法验证");
  const sha256 = createHash("sha256").update(file.content).digest("hex");
  if (file.bytes !== expected.bytes || sha256 !== expected.sha256.toLowerCase()) throw new Error("Artifact 快照完整性校验失败");
}

const markerNoFollow = constants.O_NOFOLLOW || 0;
const markerSymlinkError = () => new Error("工作目录就绪标记不允许符号链接");

async function regularWorkspaceMarker(path, { missing = false } = {}) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw markerSymlinkError();
    if (!info.isFile()) throw new Error("工作目录就绪标记必须是常规文件");
    return info;
  } catch (error) {
    if (missing && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readWorkspaceReadyMarker(path) {
  if (!await regularWorkspaceMarker(path, { missing: true })) return undefined;
  let file;
  try {
    file = await open(path, constants.O_RDONLY | markerNoFollow);
  } catch (error) {
    if (error.code === "ELOOP") throw markerSymlinkError();
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("工作目录就绪标记必须是常规文件");
    if (info.size > 65536) throw new Error("工作目录就绪标记必须小于 64 KiB");
    return JSON.parse(await file.readFile({ encoding: "utf8" }));
  } finally {
    await file.close();
  }
}

async function writeWorkspaceReadyMarker(path, value, { exclusive = false } = {}) {
  if (!exclusive) await regularWorkspaceMarker(path);
  const flags = constants.O_WRONLY | markerNoFollow | (exclusive ? constants.O_CREAT | constants.O_EXCL : constants.O_TRUNC);
  let file;
  try {
    file = await open(path, flags, 0o600);
  } catch (error) {
    if (error.code === "ELOOP") throw markerSymlinkError();
    throw error;
  }
  try {
    if (!(await file.stat()).isFile()) throw new Error("工作目录就绪标记必须是常规文件");
    await file.writeFile(JSON.stringify(value), { encoding: "utf8" });
  } finally {
    await file.close();
  }
}

function assertInside(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) throw new Error("文件路径越过了允许的 Run 目录");
  return resolvedCandidate;
}

function safeRelativePath(path) {
  if (!path || path.split(/[\\/]/).includes("..")) throw new Error("产物路径不合法");
  return path.replaceAll("\\", "/");
}

function captureRoots(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error("Artifact 接纳路径必须是数组");
  return [...new Set(value.map((item) => {
    if (typeof item !== "string") throw new Error("Artifact 接纳路径必须是字符串");
    const path = item.replace(/\/+$/, "");
    workspaceRelative(path);
    if(path.split('/').some(hiddenWorkspaceEntry))throw new Error('Artifact 路径不能包含内部或敏感位置');
    return path;
  }))];
}

function belongsToCaptureRoots(path, roots) {
  return roots === null || roots.some((root) => path===root || path.startsWith(`${root}/`));
}

function mediaTypeFor(name) {
  if (/\.(m?js|cjs|ts|tsx|jsx)$/i.test(name)) return "text/javascript";
  if (/\.json$/i.test(name)) return "application/json";
  if (/\.(md|mdx|txt|log|diff|patch|yml|yaml|toml)$/i.test(name)) return "text/plain";
  if (/\.html?$/i.test(name)) return "text/html";
  if (/\.css$/i.test(name)) return "text/css";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.gif$/i.test(name)) return "image/gif";
  if (/\.webp$/i.test(name)) return "image/webp";
  if (/\.svg$/i.test(name)) return "image/svg+xml";
  return "application/octet-stream";
}

async function digest(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function repositoryRevision(source, commitSha) {
  if (!source || typeof source.path !== "string" || typeof source.url !== "string" || typeof source.ref !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(commitSha || "")) throw new Error("仓库基线提交无效");
  return { path: source.path, url: source.url, ref: source.ref, commitSha: commitSha.toLowerCase() };
}

function pinnedRepositoryRevisions(value, sources) {
  if (!Array.isArray(value) || value.length !== sources.length) throw new Error("工作目录仓库基线记录无效");
  const byPath = new Map(value.map((item) => [item?.path, item]));
  if (byPath.size !== value.length) throw new Error("工作目录仓库基线记录无效");
  return sources.map((source) => {
    const item = byPath.get(source.path);
    if (!item || item.url !== source.url || item.ref !== source.ref) throw new Error("工作目录仓库基线与 Task 绑定不一致");
    return repositoryRevision(source, item.commitSha);
  });
}

async function checkedOutRevision(target, source) {
  const { stdout } = await execFileAsync("git", ["-C", target, "rev-parse", "HEAD"], { timeout: 10000, maxBuffer: 1024 * 1024 });
  return repositoryRevision(source, stdout.trim());
}

function isWithin(root, candidate) { const resolvedRoot = resolve(root); const resolvedCandidate = resolve(candidate); return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`); }

async function repositoryInventories(workspacePath) {
  const inventories = new Map(), repos = join(workspacePath, "repos");
  let children;
  try {
    if (!(await lstat(repos)).isDirectory()) return inventories;
    children = await readdir(repos, { withFileTypes: true });
  } catch (error) { if (error.code === "ENOENT") return inventories; throw error; }
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const repo = join(repos, child.name), marker = join(repo, ".git");
    try {
      const info = await lstat(marker);
      if (info.isDirectory()) await lstat(join(marker, "HEAD"));
      else if (!info.isFile()) continue;
    } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    try {
      const { stdout } = await execFileAsync("git", ["-C", repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
      inventories.set(`repos/${child.name}`, new Set(stdout.split("\0").filter(Boolean)));
    } catch (error) { diagnostic("git.inventory_failed", { error }); throw new Error(`无法读取仓库文件清单：repos/${child.name}`); }
  }
  return inventories;
}

async function recordRestrictedEntry(root, filePath, entries, limits) {
  const info = await lstat(filePath);
  const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
  const path = safeRelativePath(relative(root, filePath));
  if (!entries.has(path) && entries.size >= limits.maxFiles) throw new Error("工作目录包含过多敏感文件或符号链接，拒绝生成不完整产物快照");
  entries.set(path, `${kind}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`);
}

function belongsToIncludedRoots(path, roots) {
  return roots === null || roots.some((root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`));
}

async function walk(root, current, entries, restrictedEntries, limits, excludedRoots = [], inventories = new Map(), includeRoots = null) {
  const directory = await readdir(current, { withFileTypes: true });
  for (const entry of directory) {
    const filePath = join(current, entry.name);
    const fileRelativePath = safeRelativePath(relative(root, filePath));
    if (!belongsToIncludedRoots(fileRelativePath, includeRoots)) continue;
    if (entry.isSymbolicLink()) {
      await recordRestrictedEntry(root, filePath, restrictedEntries, limits);
      continue;
    }
    if (hiddenWorkspaceEntry(entry.name)) {
      if (sensitiveWorkspaceEntry(entry.name)) await recordRestrictedEntry(root, filePath, restrictedEntries, limits);
      continue;
    }
    if (entry.isDirectory()) {
      if (excludedRoots.some((excludedRoot) => isWithin(excludedRoot, filePath))) continue;
      await walk(root, filePath, entries, restrictedEntries, limits, excludedRoots, inventories, includeRoots);
      continue;
    }
    if (!entry.isFile()) continue;
    const parts = fileRelativePath.split("/"), repoPath = parts.slice(0, 2).join("/");
    if (inventories.has(repoPath) && !inventories.get(repoPath).has(parts.slice(2).join("/"))) continue;
    if (entries.size >= limits.maxFiles) throw new Error(`工作目录文件超过 ${limits.maxFiles} 个，拒绝生成不完整产物快照`);
    const info = await stat(filePath);
    if (info.size > limits.maxFileBytes) {
      await recordRestrictedEntry(root, filePath, restrictedEntries, limits);
      continue;
    }
    entries.set(fileRelativePath, { hash: await digest(filePath), bytes: info.size });
  }
}

async function directoryTree(root, current, entries, limit) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const hidden = hiddenWorkspaceEntry(entry.name);
    if (hidden || entry.isSymbolicLink()) continue;
    if (limit.count >= limit.maxEntries) { limit.truncated = true; continue; }
    const filePath = join(current, entry.name);
    const name = safeRelativePath(relative(root, filePath));
    if (entry.isDirectory()) {
      const children = [];
      entries.push({ name, path: name, type: "directory", children });
      limit.count += 1;
      await directoryTree(root, filePath, children, limit);
    } else if (entry.isFile()) {
      const info = await stat(filePath);
      entries.push({ name, path: name, type: "file", bytes: info.size, mediaType: mediaTypeFor(entry.name) });
      limit.count += 1;
    }
  }
}

const gitCredentialHelper = `#!/usr/bin/env node
const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  if (process.argv[2] !== "get") return;
  const fields = Object.fromEntries(chunks.join("").split(/\\r?\\n/).filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
  }));
  const expectedHost = String(process.env.AGENTFORGE_GIT_CREDENTIAL_HOST || "").toLowerCase();
  if (fields.protocol !== "https" || String(fields.host || "").toLowerCase() !== expectedHost) return;
  const username = process.env.AGENTFORGE_GIT_CREDENTIAL_USERNAME;
  const token = process.env.AGENTFORGE_GIT_CREDENTIAL_TOKEN;
  if (!username || !token) return;
  process.stdout.write(\`username=\${username}\\npassword=\${token}\\n\`);
});
`;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function gitCredential(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || !/^[a-z0-9.-]+$/i.test(value.host || "") || typeof value.username !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(value.username) || typeof value.token !== "string" || !value.token || value.token.length > 4096 || /[\0\r\n]/.test(value.token)) throw new Error("Git 授权配置不可用");
  return { host: value.host.toLowerCase(), username: value.username, token: value.token };
}

async function runGit(args, { credential = null, helperDirectory = null } = {}) {
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
  delete environment.AGENTFORGE_GIT_CREDENTIAL_HOST;
  delete environment.AGENTFORGE_GIT_CREDENTIAL_USERNAME;
  delete environment.AGENTFORGE_GIT_CREDENTIAL_TOKEN;
  let helperPath = null;
  try {
    if (credential) {
      helperPath = join(helperDirectory, `git-credential-${randomUUID()}.mjs`);
      await writeFile(helperPath, gitCredentialHelper, { encoding: "utf8", mode: 0o700, flag: "wx" });
      environment.AGENTFORGE_GIT_CREDENTIAL_HOST = credential.host;
      environment.AGENTFORGE_GIT_CREDENTIAL_USERNAME = credential.username;
      environment.AGENTFORGE_GIT_CREDENTIAL_TOKEN = credential.token;
      const helper = `!${shellQuote(process.execPath)} ${shellQuote(helperPath)}`;
      return await execFileAsync("git", ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, ...args], { timeout: 180000, maxBuffer: 1024 * 1024, env: environment });
    }
    return await execFileAsync("git", args, { timeout: 180000, maxBuffer: 1024 * 1024, env: environment });
  } catch (error) {
    diagnostic("git.command_failed", diagnosticRedactor({ secrets: credential ? [credential.token] : [] })({ error }));
    throw error;
  } finally {
    if (helperPath) await rm(helperPath, { force: true }).catch(() => {});
  }
}

export function createRunFiles({ root, maxFiles = DEFAULT_MAX_FILES, maxFileBytes = DEFAULT_MAX_FILE_BYTES, removeDirectory = rm, resolveGitCredential = null } = {}) {
  if (!root || !isAbsolute(root)) throw new Error("RUN_FILES_ROOT 必须是绝对路径");
  if (typeof removeDirectory !== "function") throw new Error("Run 文件删除器必须是函数");
  if (resolveGitCredential !== null && typeof resolveGitCredential !== "function") throw new Error("Git 授权解析器必须是函数");
  const runRoot = resolve(root);
  const limits = { maxFiles, maxFileBytes };

  const runIdSegment = (runId) => {
    if (typeof runId !== "string" || !runId || runId === "." || runId === ".." || runId.includes("/") || runId.includes("\\") || runId.includes("\0")) throw new Error("Run ID 不合法");
    return runId;
  };
  const pathForRun = (runId) => assertInside(runRoot, join(runRoot, "runs", runIdSegment(runId)));
  const pathForTrace = (runId, traceId) => assertInside(runRoot, join(pathForRun(runId), "traces", traceId));
  const communicationPath = (key) => {
    if (typeof key !== 'string' || !/^chat_[A-Za-z0-9_-]+$/.test(key)) throw new Error('沟通 ID 不合法');
    return assertInside(runRoot, join(runRoot, 'communications', key));
  };
  async function communicationDirectory(key, parts = []) {
    communicationPath(key);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(runRoot)).isSymbolicLink()) throw new Error('沟通目录不允许符号链接');
    let current = runRoot;
    for (const part of ['communications', key, ...parts]) {
      if (typeof part !== 'string' || !part || part === '.' || part === '..' || /[/\\\0]/.test(part)) throw new Error('沟通文件路径无效');
      current = assertInside(runRoot, join(current, part));
      await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('沟通目录不允许文件或符号链接');
    }
    return current;
  }
  const attachmentName = name => {
    if (typeof name !== 'string' || !name.trim() || ['.', '..'].includes(name) || /[/\\\0]/.test(name) || Buffer.byteLength(name) > 240) throw new Error('附件文件名无效：不能包含路径，最多 240 字节');
    return name;
  };
  const deletionStagingRoot = () => assertInside(runRoot, join(runRoot, ".deleting"));
  const operationId = (value) => {
    if (typeof value !== "string" || !/^task-delete-[0-9a-f-]{36}$/i.test(value)) throw new Error("任务删除暂存记录无效");
    return value;
  };
  const operationDirectory = (id) => assertInside(deletionStagingRoot(), join(deletionStagingRoot(), operationId(id)));
  const operationRunPath = (operation, runId) => assertInside(operationDirectory(operation.id), join(operationDirectory(operation.id), "runs", runIdSegment(runId)));
  const normalizedOperation = (operation) => {
    if (!operation || !Array.isArray(operation.runIds)) throw new Error("任务删除暂存记录无效");
    const runIds = [...new Set(operation.runIds.map(runIdSegment))];
    if (!runIds.length) throw new Error("任务删除暂存记录无效");
    return { id: operationId(operation.id), runIds };
  };
  async function ensureDeletionStagingRoot() {
    const directory = deletionStagingRoot();
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("任务删除暂存目录不可用");
    return directory;
  }
  async function readDeletionOperation(id) {
    const directory = operationDirectory(id), manifestPath = join(directory, "manifest.json");
    const info = await lstat(manifestPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("任务删除暂存记录无效");
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
    catch { throw new Error("任务删除暂存记录无效"); }
    if (manifest?.version !== 1 || manifest.id !== id) throw new Error("任务删除暂存记录无效");
    return normalizedOperation(manifest);
  }
  async function restoreStagedRuns(operation) {
    const staged = normalizedOperation(operation);
    await mkdir(join(runRoot, "runs"), { recursive: true });
    for (const runId of staged.runIds) {
      try { await rename(operationRunPath(staged, runId), pathForRun(runId)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await removeDirectory(operationDirectory(staged.id), { recursive: true, force: true });
  }
  async function finalizeStagedRuns(operation) {
    const staged = normalizedOperation(operation);
    await removeDirectory(operationDirectory(staged.id), { recursive: true, force: true });
  }

  return {
    root: runRoot,
    communicationPath,
    async writeCommunicationAttachment(key, name, content) {
      attachmentName(name);
      if (!Buffer.isBuffer(content) || content.length > DEFAULT_MAX_FILE_BYTES) throw new Error('附件最大 20 MiB');
      const id = `attachment_${randomUUID()}`, directory = await communicationDirectory(key, ['attachments', id]);
      await writeFile(join(directory, name), content, { mode: 0o600, flag: 'wx' });
      return { id, name, path: `attachments/${id}/${name}`, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
    },
    async discardCommunicationAttachment(key, record) {
      await this.readCommunicationAttachment(key, record);
      await rm(join(communicationPath(key), 'attachments', record.id), { recursive: true });
    },
    async readCommunicationAttachment(key, record) {
      communicationPath(key); attachmentName(record.name);
      if (!/^attachment_[a-f0-9-]{36}$/.test(record.id) || record.path !== `attachments/${record.id}/${record.name}`) throw new Error('附件路径无效');
      const result = await readArtifactFile(runRoot, `communications/${key}/${record.path}`, DEFAULT_MAX_FILE_BYTES);
      if (result.bytes !== record.bytes || createHash('sha256').update(result.content).digest('hex') !== record.sha256) throw new Error('附件完整性校验失败');
      return result.content;
    },
    async writeCommunicationContent(key, deliveryId, attempt, content) {
      if (!/^chat_delivery_[A-Za-z0-9_-]+$/.test(deliveryId) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('沟通调用归属无效');
      const text = JSON.stringify(content);
      if (Buffer.byteLength(text) > 300000) throw new Error('执行内容超过大小限制');
      const directory = await communicationDirectory(key, ['.agentforge', deliveryId, String(attempt)]);
      const destination = join(directory, `content-${randomUUID()}.json`);
      await writeFile(destination, text, { mode: 0o600, flag: 'wx' });
      return { storagePath: relative(runRoot, destination).replaceAll('\\', '/'), bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
    },
    async prepareTaskWorkspace(task) {
      if (task.workspaceManaged) { await mkdir(task.workspacePath, { recursive: true }); const info = await lstat(task.workspacePath); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("任务目录不能是符号链接或文件"); }
    },
    async prepareRunWorkspace(task) {
      if (!task.workspaceManaged) return null;
      await mkdir(task.workspacePath, { recursive: true });
      for (const path of [task.taskWorkspacePath, task.workspacePath].filter(Boolean)) { const info = await lstat(path); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("执行目录不能是符号链接或文件"); }
      const internal = join(task.workspacePath, ".agentforge");
      await mkdir(internal, { recursive: true });
      for (const path of [internal, ...(workspaceRepositories(task).length?[join(task.workspacePath, "repos")]:[])]) {
        await mkdir(path, { recursive: true });
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("工作目录不能是符号链接或文件");
      }
      const marker = join(internal, "workspace-ready.json");
      const sources = task.repositorySources || [];
      let prepared = false, saved = null, savedRevisions = null;
      saved = await readWorkspaceReadyMarker(marker);
      if (saved !== undefined) {
        if (saved.taskId !== task.id) throw new Error("工作目录归属不匹配");
        if (task.repositoryMode !== "agent") return [];
        if (saved.repositoryRevisions !== undefined) savedRevisions = pinnedRepositoryRevisions(saved.repositoryRevisions, sources);
        prepared = true;
      }
      const revisions = [];
      for (const {path} of workspaceRepositories(task)) {
        if (!/^repos\/[A-Za-z0-9._-]+$/.test(path) || ["repos/.", "repos/.."].includes(path)) throw new Error("仓库必须是 repos 的直接子目录");
        const target = join(task.workspacePath, path), source = sources.find((item) => item.path === path), pinned = savedRevisions?.find((item) => item.path === path);
        try {
          const info = await lstat(target);
          if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("仓库目录不能是符号链接或文件");
          const gitInfo = await lstat(join(target, ".git"));
          if (task.repositoryMode === "agent" && (gitInfo.isSymbolicLink() || !gitInfo.isDirectory())) throw new Error("绑定仓库必须是独立 Git 检出");
          if (source) {
            const origin = await execFileAsync("git", ["-C", target, "config", "--get", "remote.origin.url"]);
            if (origin.stdout.trim() !== source.url) throw new Error("仓库来源不匹配");
            revisions.push(pinned || await checkedOutRevision(target, source));
          }
          continue;
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        const staging = await mkdtemp(join(internal, "checkout-"));
        const checkout = join(staging, "repo");
        const git = async (args, credentialSource = null) => runGit(args, {
          credential: credentialSource && resolveGitCredential ? gitCredential(await resolveGitCredential(credentialSource.url)) : null,
          helperDirectory: staging
        });
        try {
          if (source) {
            try {
              await git(["-c", "core.hooksPath=/dev/null", "clone", "--no-checkout", "--no-recurse-submodules", "--", source.url, checkout], source);
              await git(["-C", checkout, "checkout", pinned?.commitSha || source.ref]);
            } catch { throw new Error("仓库检出失败；请检查仓库地址、基线与 GitHub/GitLab Token 权限。"); }
          }
          else { await mkdir(checkout); await git(["-C", checkout, "init"]); }
          await rename(checkout, target);
        } finally { await rm(staging, { recursive: true, force: true }); }
        if (source) revisions.push(pinned || await checkedOutRevision(target, source));
      }
      const pinned = savedRevisions || pinnedRepositoryRevisions(revisions, sources);
      if (!prepared) await writeWorkspaceReadyMarker(marker, { taskId: task.id, preparedAt: new Date().toISOString(), repositoryRevisions: pinned }, { exclusive: true });
      else if (!savedRevisions) await writeWorkspaceReadyMarker(marker, { ...saved, repositoryRevisions: pinned });
      try { await initializeWorkspaceGit(task.workspacePath, sources); }
      catch (error) { diagnostic("workspace.git_init_failed", { error }); }
      return pinned;
    },
    async listWorkingDirectory(task, {path='',offset=0}={}) {
      try { await workspaceRoot(task.workspacePath); }
      catch (error) {
        if (error.message === "工作目录不允许读取符号链接") throw error;
        throw new Error(`任务工作目录不存在或不可访问：${task.workspacePath}。历史交付快照仍保留；请恢复原工作目录后刷新。`);
      }
      if(!Number.isSafeInteger(offset) || offset<0)throw new Error('目录 offset 必须为非负整数');
      if(path){workspaceRelative(path);if(path.split('/').some(privateWorkspaceEntry))throw new Error('不能读取内部或敏感文件');}
      const folder=path?await workspaceFile(task.workspacePath,path):await workspaceRoot(task.workspacePath);
      if(!(await lstat(folder)).isDirectory())throw new Error('所选路径不是目录');
      const children=(await readdir(folder,{withFileTypes:true})).filter(child=>!privateWorkspaceEntry(child.name) && !child.isSymbolicLink() && (child.isDirectory() || child.isFile())).sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const entries=[];
      for(const child of children.slice(offset,offset+DIRECTORY_PAGE_SIZE)){
        const childPath=path?`${path}/${child.name}`:child.name;
        try{
          const info=await lstat(await workspaceFile(task.workspacePath,childPath));
          entries.push(info.isDirectory()?{name:child.name,path:childPath,type:'directory'}:{name:child.name,path:childPath,type:'file',bytes:info.size,modifiedAt:info.mtime.toISOString(),mediaType:mediaTypeFor(child.name)});
        }catch(error){if(error.code!=='ENOENT')throw error;}
      }
      return {workspacePath:task.workspacePath,path,entries,nextOffset:offset+DIRECTORY_PAGE_SIZE<children.length?offset+DIRECTORY_PAGE_SIZE:null,readAt:new Date().toISOString()};
    },
    async listWorkingChanges(task) {
      await workspaceRoot(task.workspacePath);
      const repositories=workspaceRepositories(task);
      for (const entry of repositories) {
        try { await workspaceFile(task.workspacePath, entry.path); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      const visible = (path) => !path.split("/").some(privateWorkspaceEntry);
      return workspaceGitStatus(task.workspacePath, repositories, visible);
    },
    async readWorkingDiff(task, path, { full = false } = {}) {
      workspaceRelative(path);
      if (path.split("/").some(privateWorkspaceEntry)) throw new Error("不能读取内部或敏感文件");
      await workspaceRoot(task.workspacePath);
      const repository = workspaceRepositories(task).find(entry => path.startsWith(`${entry.path}/`) || path === entry.path);
      await sourceControlPath(task.workspacePath, path);
      const submodule = Boolean(repository && path === repository.path);
      return workspaceGitDiff(task.workspacePath, repository && !submodule ? repository.path : "", path, { submodule, full });
    },
    async readWorkingFile(task, path, { raw = false, download = false } = {}) {
      if (raw && download) throw new Error("下载与图片预览不能同时请求");
      workspaceRelative(path);
      if (path.split("/").some(privateWorkspaceEntry)) throw new Error("不能读取内部或敏感文件");
      const file = await workspaceFile(task.workspacePath, path), info = await stat(file);
      if (!info.isFile()) throw new Error("所选路径不是常规文件");
      if (download) {
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          if (!(await handle.stat()).isFile()) throw new Error("所选路径不是常规文件");
          return { content: handle.createReadStream(), fileName: path.split("/").at(-1) };
        } catch (error) { await handle.close(); throw error; }
      }
      const mediaType = mediaTypeFor(path), image = /^image\/(png|jpeg|gif|webp)$/.test(mediaType);
      if (raw && !image) throw new Error("raw 预览仅支持 PNG、JPEG、GIF 和 WebP 图片");
      const maxBytes = image ? DEFAULT_MAX_FILE_BYTES : DEFAULT_PREVIEW_BYTES;
      if (info.size > maxBytes) throw new Error(`文件超过预览上限 ${maxBytes} 字节，请在本地查看`);
      const bytes = await readFile(file);
      if (bytes.length > maxBytes) throw new Error("文件读取期间超过预览大小上限");
      if (raw) return { content: bytes, mediaType };
      const binary = !image && bytes.includes(0);
      return { path, bytes: bytes.length, modifiedAt: info.mtime.toISOString(), mediaType, image, binary, content: image || binary ? null : bytes.toString("utf8") };
    },
    async prepareRun(runId) {
      const directory = pathForRun(runId);
      await mkdir(join(directory, "traces"), { recursive: true });
      return directory;
    },
    async removeRun(runId) {
      const directory = pathForRun(runId);
      await rm(directory, { recursive: true, force: true });
      return directory;
    },
    async stageRunsForDeletion(runIds) {
      if (!Array.isArray(runIds)) throw new Error("Run 删除列表必须是数组");
      const uniqueRunIds = [...new Set(runIds.map(runIdSegment))];
      if (!uniqueRunIds.length) return null;
      const id = `task-delete-${randomUUID()}`;
      await ensureDeletionStagingRoot();
      const directory = operationDirectory(id);
      await mkdir(join(directory, "runs"), { recursive: true });
      const operation = { id, runIds: uniqueRunIds };
      await writeFile(join(directory, "manifest.json"), `${JSON.stringify({ version: 1, ...operation })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        for (const runId of uniqueRunIds) {
          try { await rename(pathForRun(runId), operationRunPath(operation, runId)); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        return operation;
      } catch (error) {
        try { await restoreStagedRuns(operation); }
        catch { /* The private staging record lets startup recovery restore retained files. */ }
        throw error;
      }
    },
    restoreStagedRuns,
    finalizeStagedRuns,
    async recoverStagedTaskDeletions(runExists) {
      if (typeof runExists !== "function") throw new Error("任务删除恢复必须提供 Run 查询");
      let entries;
      try {
        const info = await lstat(deletionStagingRoot());
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("任务删除暂存目录不可用");
        entries = await readdir(deletionStagingRoot(), { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return { restored: 0, finalized: 0, failed: 0 };
        throw error;
      }
      const result = { restored: 0, finalized: 0, failed: 0 };
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^task-delete-[0-9a-f-]{36}$/i.test(entry.name)) { result.failed += 1; continue; }
        try {
          const operation = await readDeletionOperation(entry.name);
          if (operation.runIds.some((runId) => runExists(runId))) {
            await restoreStagedRuns(operation);
            result.restored += 1;
          } else {
            await finalizeStagedRuns(operation);
            result.finalized += 1;
          }
        } catch { result.failed += 1; }
      }
      return result;
    },
    async prepareTrace(runId, traceId) {
      const directory = pathForTrace(runId, traceId);
      await mkdir(join(directory, "output"), { recursive: true });
      return directory;
    },
    traceDirectory: pathForTrace,
    async writeConsoleContent(runId, traceId, content) {
      const directory = await this.prepareTrace(runId, traceId);
      await artifactFile(runRoot, relative(runRoot, directory));
      const destination = join(directory, `content-${randomUUID()}.json`);
      const text = JSON.stringify(content);
      if (Buffer.byteLength(text) > 300000) throw new Error("执行内容超过大小限制");
      await writeFile(destination, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { storagePath: relative(runRoot, destination).replaceAll("\\", "/"), bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
    },
    async readConsoleContent(reference) {
      const { content, bytes } = await readArtifactFile(runRoot, reference.storagePath, 300000);
      if (bytes !== reference.bytes || createHash("sha256").update(content).digest("hex") !== reference.sha256) throw new Error("执行内容完整性校验失败");
      return JSON.parse(content.toString("utf8"));
    },
    // One redacted dispatch-prompt snapshot per Trace, same on-disk boundary
    // as console content: 0600, fail-if-exists, SHA-256 integrity binding.
    async writePromptSnapshot(runId, traceId, content) {
      const directory = await this.prepareTrace(runId, traceId);
      await artifactFile(runRoot, relative(runRoot, directory));
      const destination = join(directory, "prompt-snapshot.json");
      const text = JSON.stringify(content);
      if (Buffer.byteLength(text) > 300000) throw new Error("提示词快照超过大小限制");
      await writeFile(destination, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { storagePath: relative(runRoot, destination).replaceAll("\\", "/"), bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
    },
    async appendTrace(runId, traceId, record) {
      const traceDirectory = await this.prepareTrace(runId, traceId);
      const tracePath = join(traceDirectory, "events.ndjson");
      await appendFile(tracePath, `${JSON.stringify(record)}\n`, "utf8");
      return relative(runRoot, tracePath).replaceAll("\\", "/");
    },
    async snapshotWorkspace(workspacePath, { excludeRunFiles = false, includeRoots = null } = {}) {
      const rootPath = await workspaceRoot(workspacePath);
      const entries = new Map();
      const restrictedEntries = new Map();
      await walk(rootPath, rootPath, entries, restrictedEntries, limits, excludeRunFiles && isWithin(rootPath, runRoot) ? [runRoot] : [], await repositoryInventories(rootPath), includeRoots);
      if (includeRoots) {
        for (const name of [...entries.keys()]) if (!includeRoots.some((rootName) => name === rootName || name.startsWith(`${rootName}/`))) entries.delete(name);
        for (const name of [...restrictedEntries.keys()]) if (!includeRoots.some((rootName) => name === rootName || name.startsWith(`${rootName}/`))) restrictedEntries.delete(name);
      }
      Object.defineProperty(entries, "restrictedEntries", { value: restrictedEntries });
      return entries;
    },
    async loadOrCreateWorkspaceBaseline(runId, workspacePath, { allowCreate = false } = {}) {
      const path = join(pathForRun(runId), "workspace-baseline.json");
      const decode = (raw) => {
        let record;
        try { record = JSON.parse(raw); } catch { throw new Error("Run 工作目录基线记录无效"); }
        if (record?.version !== 1 || record.workspacePath !== resolve(workspacePath) || !Array.isArray(record.entries) || !Array.isArray(record.restrictedEntries) || record.entries.length > limits.maxFiles || record.restrictedEntries.length > limits.maxFiles) throw new Error("Run 工作目录基线记录无效");
        const entries = new Map(), restrictedEntries = new Map();
        for (const [name, value] of record.entries) {
          workspaceRelative(name);
          if (name.split('/').some(hiddenWorkspaceEntry)) throw new Error("Run 工作目录基线记录无效");
          if (entries.has(name) || !value || !/^[a-f0-9]{64}$/.test(value.hash) || !Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new Error("Run 工作目录基线记录无效");
          entries.set(name, value);
        }
        for (const [name, value] of record.restrictedEntries) {
          workspaceRelative(name);
          if (restrictedEntries.has(name) || typeof value !== "string") throw new Error("Run 工作目录基线记录无效");
          restrictedEntries.set(name, value);
        }
        Object.defineProperty(entries, "restrictedEntries", { value: restrictedEntries });
        return entries;
      };
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024) throw new Error("Run 工作目录基线记录无效");
        const handle = await open(path, constants.O_RDONLY | markerNoFollow);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > 20 * 1024 * 1024) throw new Error("Run 工作目录基线记录无效");
          return decode(await handle.readFile({ encoding: "utf8" }));
        } finally { await handle.close(); }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!allowCreate) {
        const error = new Error("Run 工作目录基线缺失，不能验证未接纳的文件变更");
        error.code = "RUN_WORKSPACE_BASELINE_MISSING";
        throw error;
      }
      const snapshot = await this.snapshotWorkspace(workspacePath, { excludeRunFiles: true });
      const record = { version: 1, workspacePath: resolve(workspacePath), entries: [...snapshot], restrictedEntries: [...snapshot.restrictedEntries] };
      await writeFile(path, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
      return snapshot;
    },
    async writeTraceFile(runId, traceId, name, content) {
      const directory = await this.prepareTrace(runId, traceId);
      const destination = assertInside(directory, join(directory, "output", safeRelativePath(name)));
      await mkdir(resolve(destination, ".."), { recursive: true });
      await writeFile(destination, content, "utf8");
      const info = await stat(destination);
      return {
        name: `output/${safeRelativePath(name)}`,
        storagePath: relative(runRoot, destination).replaceAll("\\", "/"),
        sourcePath: null,
        mediaType: mediaTypeFor(name),
        bytes: info.size,
        sha256: await digest(destination)
      };
    },
    async writeInternalTraceFile(runId, traceId, name, content) {
      const directory = await this.prepareTrace(runId, traceId);
      const destination = assertInside(directory, join(directory, "internal", safeRelativePath(name)));
      await mkdir(resolve(destination, ".."), { recursive: true });
      await writeFile(destination, content, "utf8");
      return destination;
    },
    async collectTraceOutputFiles(runId, traceId) {
      const directory = join(pathForTrace(runId, traceId), "output");
      const snapshot = await this.snapshotWorkspace(directory);
      return [...snapshot.entries()].map(([name, entry]) => ({
        name: `output/${name}`,
        storagePath: relative(runRoot, join(directory, name)).replaceAll("\\", "/"),
        sourcePath: null,
        mediaType: mediaTypeFor(name),
        bytes: entry.bytes,
        sha256: entry.hash,
        deleted: false
      }));
    },
    async captureWorkspaceChanges({ runId, traceId, workspacePath, before, includeRoots = null, allowedRoots = null }) {
      const after = await this.snapshotWorkspace(workspacePath, { excludeRunFiles: true, includeRoots });
      const artifacts = [];
      const changes = [];
      // Restricted entries are excluded from Artifact capture. Their presence or
      // modification does not impose an execution permission on the employee.
      for (const workspaceRelativePath of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        const oldEntry = before.get(workspaceRelativePath);
        const newEntry = after.get(workspaceRelativePath);
        if (oldEntry?.hash === newEntry?.hash) continue;
        if (!newEntry) {
          // An ignore/size rule can remove a still-existing file from the
          // inventory. Only an absent path is a deletion fact.
          try { await lstat(join(resolve(workspacePath), workspaceRelativePath)); continue; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        changes.push({ workspaceRelativePath, oldEntry, newEntry });
      }
      const roots = captureRoots(allowedRoots);
      const rejected = changes.filter(({ workspaceRelativePath }) => !belongsToCaptureRoots(workspaceRelativePath, roots));
      if (rejected.length) {
        const paths = rejected.slice(0, 8).map(({ workspaceRelativePath }) => workspaceRelativePath).join("、");
        const accepted = roots?.length ? roots.join("、") : "无（本次调用不允许修改业务文件）";
        throw new Error(`本次职责只能验收声明的 Artifact 路径：${accepted}；检测到 ${rejected.length} 个越界变更：${paths}${rejected.length > 8 ? " 等" : ""}`);
      }
      const traceDirectory = await this.prepareTrace(runId, traceId);
      for (const { workspaceRelativePath, oldEntry, newEntry } of changes) {
        if (!newEntry) {
          const deleted = await this.writeTraceFile(runId, traceId, `deleted/${workspaceRelativePath}.json`, JSON.stringify({ path: workspaceRelativePath, deleted: true }, null, 2));
          artifacts.push({ ...deleted, name: workspaceRelativePath, sourcePath: join(resolve(workspacePath), workspaceRelativePath), deleted: true });
          continue;
        }
        const sourcePath = await workspaceFile(workspacePath, workspaceRelativePath);
        if (!(await lstat(sourcePath)).isFile()) throw new Error("Artifact 只能从常规文件创建");
        const destination = assertInside(traceDirectory, join(traceDirectory, "workspace", safeRelativePath(workspaceRelativePath)));
        await mkdir(resolve(destination, ".."), { recursive: true });
        await copyFile(sourcePath, destination);
        const copied = await stat(destination);
        artifacts.push({
          name: workspaceRelativePath,
          storagePath: relative(runRoot, destination).replaceAll("\\", "/"),
          sourcePath,
          mediaType: mediaTypeFor(workspaceRelativePath),
          bytes: copied.size,
          sha256: await digest(destination),
          deleted: false
        });
      }
      return { after, artifacts };
    },
    async readArtifact(storagePath, options = null) {
      const { maxBytes, expected } = artifactReadOptions(options, DEFAULT_PREVIEW_BYTES);
      const file = await readArtifactFile(runRoot, storagePath, maxBytes);
      verifyArtifactSnapshot(file, expected);
      return { content: file.content.toString("utf8"), bytes: file.bytes };
    },
    async readArtifactBytes(storagePath, options = null) {
      const { maxBytes, expected } = artifactReadOptions(options, DEFAULT_MAX_FILE_BYTES);
      const file = await readArtifactFile(runRoot, storagePath, maxBytes);
      verifyArtifactSnapshot(file, expected);
      return file.content;
    },
    async verifyArtifact(storagePath, options) {
      const { maxBytes, expected } = artifactReadOptions(options, DEFAULT_MAX_FILE_BYTES);
      if (!expected || typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0) throw new Error("Artifact 快照完整性无法验证");
      const file = await artifactFile(runRoot, storagePath);
      if (!file.info.isFile()) throw new Error("Artifact 必须是常规文件");
      if (file.info.size > maxBytes) throw new Error(`产物大于 ${maxBytes} 字节，请在本地文件系统中查看`);
      const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.dev !== file.info.dev || before.ino !== file.info.ino) throw new Error("Artifact 快照完整性校验失败");
        const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
        let bytes = 0;
        while (true) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes > maxBytes) throw new Error(`产物大于 ${maxBytes} 字节，请在本地文件系统中查看`);
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat(), current = await artifactFile(runRoot, storagePath);
        if (!current.info.isFile() || current.info.dev !== before.dev || current.info.ino !== before.ino || after.size !== bytes || bytes !== expected.bytes || hash.digest("hex") !== expected.sha256.toLowerCase()) throw new Error("Artifact 快照完整性校验失败");
        return { bytes };
      } finally { await handle.close(); }
    },
    async listRepositoryTree(workspacePath, repositoryPath, maxEntries = DEFAULT_MAX_TREE_ENTRIES) {
      let safePath;
      try { safePath = safeRelativePath(repositoryPath); } catch { throw new Error("代码仓库路径必须是 repos/<子目录>"); }
      if (!/^repos\/[^/]+\/?$/.test(safePath)) throw new Error("代码仓库路径必须是 repos/<子目录>");
      const repositoryRoot = await workspaceFile(workspacePath, safePath);
      const info = await lstat(repositoryRoot);
      if (!info.isDirectory()) throw new Error("代码仓库目录不存在");
      const entries = [];
      const limit = { count: 0, maxEntries: Math.min(maxEntries, DEFAULT_MAX_TREE_ENTRIES), truncated: false };
      await directoryTree(repositoryRoot, repositoryRoot, entries, limit);
      return { repositoryPath: safePath.replace(/\/$/, ""), entries, truncated: limit.truncated };
    }
  };
}
