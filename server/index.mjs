import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { diagnostic, diagnostics, installProcessDiagnostics } from "./diagnostics.mjs";
import { readFile, realpath, stat, access, mkdir, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, join, normalize, isAbsolute, parse, sep } from "node:path";
import { fileURLToPath } from "node:url";
import hljs from "highlight.js";
import { createStore } from "./store.mjs";
import { executeRun, pauseRun, resumeRun, terminateRun, stopInquiries } from "./orchestrator.mjs";
import { createRunFiles } from "./run-files.mjs";
import { hasActiveExecution } from "./runtime/registry.mjs";
import { createAuth } from "./auth.mjs";
import { createRuntimeConfiguration } from "./runtime/configuration.mjs";
import { desktopServiceStoragePaths } from "./data-home.mjs";
import { createMarketplace } from "./runtime/marketplace.mjs";
import { probeRuntime } from "./runtime/probe.mjs";
import { runtimeModelCatalog, assertModelEffort } from "./runtime/model-catalog.mjs";
import { createCommunicationService } from "./communication.mjs";
import { queryHistory } from "./history/bridge.mjs";
import { createDataReset } from "./data-reset.mjs";
import {createPluginUpdates} from './plugin-updates.mjs';

const root = fileURLToPath(new URL("..", import.meta.url));
const webRoot = join(root, "web");
const clientRoot = join(root, "client");
const x6Bundle = join(root, "node_modules", "@antv", "x6", "dist", "x6.min.js");
const elkBundle = join(root, "node_modules", "elkjs", "lib", "elk.bundled.js");
const markedBundle = join(root, "node_modules", "marked", "lib", "marked.umd.js");
const domPurifyBundle = join(root, "node_modules", "dompurify", "dist", "purify.min.js");
const highlightStylesheet = join(root, "node_modules", "highlight.js", "styles", "github.min.css");
const candidateBootstrapToken = process.env.AGENTFORGE_BOOTSTRAP_TOKEN;
delete process.env.AGENTFORGE_BOOTSTRAP_TOKEN;
if (!candidateBootstrapToken || !process.send || process.env.AGENTFORGE_DESKTOP_PORT !== "0") throw new Error("本机服务只能由 AgentForge 客户端启动；请运行 npm start 或打开应用。");
const bootstrapToken = candidateBootstrapToken;
const port = 0;
const host = "127.0.0.1";
const instanceId = randomUUID();
const storage = desktopServiceStoragePaths();
const databasePath = storage.databasePath;
installProcessDiagnostics("server", { instancePath: databasePath });
const runFilesRoot = storage.runFilesRoot;
const workspaceRoot = storage.workspaceRoot;
const runtimeConfigRoot = storage.runtimeConfigRoot;
// The default instance data root is private; explicit AGENTFORGE_* override
// targets stay exactly as the operator configured them.
const usesDefaultRoot = [storage.databasePath, storage.authDatabasePath, storage.runFilesRoot, storage.runtimeConfigRoot, storage.workspaceRoot].some(path => path === storage.dataRoot || path.startsWith(storage.dataRoot + sep));
if (usesDefaultRoot) { await mkdir(storage.dataRoot, { recursive: true, mode: 0o700 }); await chmod(storage.dataRoot, 0o700); }
const authOptions = { databasePath: storage.authDatabasePath, origins: [], bootstrapToken };
const dataReset = createDataReset({ databasePath, authDatabasePath: authOptions.databasePath, runFilesRoot, runtimeConfigRoot, logDirectory: diagnostics().status().directory, protectedPaths: [root] });
await dataReset.recover();
let auth;
const storeOptions = { databasePath, workspaceRoot, onSaveDiagnostic: (record) => {
  if (record.outcome === "error" || record.elapsedMs >= 250) diagnostic("persistence.save", record);
} };
let store = createStore(storeOptions);
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const runFiles = createRunFiles({ root: runFilesRoot });
const taskDeletionLocks = new Set();
const eventStreams = new Set();
let runtimeTestActive = false;
let resettingData = false, resetCommitted = false, writeRequests = 0;
try {
  const recovery = await runFiles.recoverStagedTaskDeletions((runId) => store.listRuns().some((run) => run.id === runId));
  if (recovery.failed) console.error(`Task deletion recovery retained ${recovery.failed} invalid or inaccessible staging record(s).`);
} catch {
  console.error("Task deletion staging recovery could not complete; retained files were not removed.");
}
const runtimeConfiguration = createRuntimeConfiguration(runtimeConfigRoot);
const marketplace = createMarketplace(runtimeConfigRoot);
const pluginUpdates=createPluginUpdates({getStore:()=>store,marketplace,canRun:()=>!resettingData});
const runExecutionOptions = { runFilesRoot, resolveGitCredential: (url) => runtimeConfiguration.resolveGitCredential(url) };
let communications = createCommunicationService(store, { root: join(runFilesRoot, "communications"), files: runFiles });
const wakeCommunication = (id) => setImmediate(() => { if (!resettingData) communications.kick(id).catch(error => diagnostic("communication.dispatch_error", { conversationId: id, error })); });
async function employeeInput(request, agentId = null) {
  const input = await readJson(request);
  const allowed = ['name', 'kind', 'description', 'systemPrompt', 'capabilities', 'status', 'repository', 'runtime'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('员工配置字段无效，请按当前配置协议提交');
  if (input.runtime !== undefined && (!input.runtime || typeof input.runtime !== 'object' || Array.isArray(input.runtime) || Object.keys(input.runtime).some(key => !['profileId', 'extensionSelection'].includes(key)))) throw new Error('员工Runtime仅接受profileId和extensionSelection；扩展只选择已安装插件和MCP');
  const previous = agentId ? store.listAgents().find(agent => agent.id === agentId)?.runtime : undefined;
  if (agentId && !previous) throw new Error('数字员工不存在');
  if (agentId && input.runtime === undefined) return input;
  const profileId = Object.hasOwn(input.runtime || {}, 'profileId') ? input.runtime.profileId : previous?.profileId ?? store.listRuntimeProfiles().find(item => item.provider === 'claude-code')?.id;
  const profile = store.listRuntimeProfiles().find(item => item.id === profileId);
  if (!profile) throw new Error('请先在设置 → Runtime 配置连接并选择有效profileId');
  const selection = Object.hasOwn(input.runtime || {}, 'extensionSelection') ? input.runtime.extensionSelection : previous?.extensionSelection ?? {pluginIds:[], mcpIds:[]};
  const resolved = await marketplace.resolve(selection, profile.provider);
  const {provider, model, executable, profile: cliProfile, effort} = profile;
  input.runtime = {profileId, provider, model, executable, profile: cliProfile, effort, ...resolved};
  return input;
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
const languageFor = (name = "") => ({ js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript", json: "json", yml: "yaml", yaml: "yaml", toml: "ini", sql: "sql", py: "python", java: "java", go: "go", rs: "rust", sh: "bash", css: "css", html: "xml", htm: "xml", xml: "xml", md: "markdown", mdx: "markdown", diff: "diff", patch: "diff" }[extname(name).slice(1).toLowerCase()] || null);
const rasterImageType = (mediaType = "") => /^image\/(png|jpeg|gif|webp)$/.test(mediaType);
function artifactPresentation(artifact, content) { const language = languageFor(artifact.name); return { language, highlightedHtml: language ? hljs.highlight(content, { language, ignoreIllegals: true }).value : null }; }
function artifactReadError(error) {
  const message = error instanceof Error ? error.message : "";
  if (message === "产物路径不合法" || message === "Artifact 必须是常规文件" || message === "Artifact 快照完整性无法验证" || message === "Artifact 快照完整性校验失败" || /^产物大于 \d+ 字节，请在本地文件系统中查看$/.test(message)) return error;
  return new Error("Artifact 文件不可读取或已不存在");
}
async function readArtifactSafely(read) {
  try { return await read(); }
  catch (error) { throw artifactReadError(error); }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

const maxJsonBodyBytes = 1024 * 1024;
class RequestBodyTooLargeError extends Error {
  constructor(message = "请求体超过 1 MiB 上限") { super(message); }
}

async function readJson(request) {
  let body = "", bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (bytes > maxJsonBodyBytes) throw new RequestBodyTooLargeError();
    body += chunk;
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("请求体不是有效 JSON");
  }
}

async function withTaskDeletionLock(locks, taskId, work) {
  if (locks.has(taskId)) throw new Error("Task 正在删除，请稍候");
  locks.add(taskId);
  try { return await work(); }
  finally { locks.delete(taskId); }
}

async function routeApi(request, response, pathname, searchParams = new URLSearchParams()) {
  if (pathname === "/api/settings/reset" && request.method === "POST") {
    const input = await readJson(request);
    if (input.confirmation !== "清除所有数据") throw new Error("请输入「清除所有数据」确认");
    await auth.reauthenticate(request, input.password);
    if (resettingData || writeRequests !== 1 || runtimeTestActive || pluginUpdates.status().running || communications.isActive() || taskDeletionLocks.size || store.listRuns().some(run => hasActiveExecution(run.id))) { sendJson(response, 409, { error: "仍有执行或保存操作，请停止后重试" }); return true; }
    const workspaces = store.prepareDataReset();
    resettingData = true;
    try {
      await dataReset.begin(workspaces);
      resetCommitted = true;
      for (const stream of eventStreams) stream.end();
      eventStreams.clear();
      store.close(); auth.close();
      await dataReset.recover();
      store = createStore(storeOptions); auth = createAuth(authOptions);
      pluginUpdates.reset();
      communications = createCommunicationService(store, { root: join(runFilesRoot, "communications"), files: runFiles });
      auth.establishResetSetup(response, request.headers.origin);
      diagnostic("instance.reset_completed");
      resetCommitted = false;
      sendJson(response, 200, { ok: true, next: "/setup.html" });
    } catch (error) {
      if (resetCommitted) { diagnostic("instance.reset_incomplete", { error }); sendJson(response, 503, { error: "清除尚未完成，请重启 AgentForge 后继续清除；正常使用已暂停。" }); }
      else throw error;
    } finally { resettingData = resetCommitted; }
    return true;
  }
  const chatAttachment = pathname.match(/^\/api\/communications\/([^/]+)\/attachments(?:\/([^/]+))?$/);
  if (chatAttachment && request.method === 'POST' && !chatAttachment[2]) {
    if (!/^application\/octet-stream(?:;|$)/i.test(request.headers['content-type'] || '')) throw new Error('附件上传需要 application/octet-stream');
    const key = chatAttachment[1]; store.getCommunication(key, { limit: 1 });
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 20 * 1024 * 1024) throw new RequestBodyTooLargeError('附件最大 20 MiB');
        chunks.push(chunk);
      }
    } finally { if (!request.readableEnded) request.resume(); }
    const record = await runFiles.writeCommunicationAttachment(key, searchParams.get('name'), Buffer.concat(chunks));
    try { sendJson(response, 201, { attachment: store.registerCommunicationAttachment(key, record) }); }
    catch (error) { await runFiles.discardCommunicationAttachment(key, record).catch(cleanup => diagnostic('communication.attachment_cleanup_failed', { error: cleanup })); throw error; }
    return true;
  }
  if (chatAttachment && request.method === 'GET' && chatAttachment[2]) {
    const record = store.getCommunicationAttachment(chatAttachment[1], chatAttachment[2]);
    let content;
    try { content = await runFiles.readCommunicationAttachment(chatAttachment[1], record); }
    catch (error) { diagnostic('communication.attachment_read_failed', { error }); sendJson(response, 409, { error: '附件不可读取或完整性校验失败；请核对原文件。' }); return true; }
    const filename = encodeURIComponent(record.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${filename}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    response.end(content); return true;
  }
  const chatConsole = pathname.match(/^\/api\/communications\/([^/]+)\/console$/);
  if (chatConsole && request.method === 'GET') {
    sendJson(response, 200, store.getCommunicationConsole(chatConsole[1], { agentId: searchParams.get('agentId'), before: searchParams.get('before'), limit: Number(searchParams.get('limit') || 50) })); return true;
  }
  const chatContent = pathname.match(/^\/api\/communications\/([^/]+)\/(console-content\/([^/]+)|traces\/([^/]+)\/prompt)$/);
  if (chatContent && request.method === 'GET') {
    const reference = store.getCommunicationContentReference(chatContent[1], chatContent[3] || chatContent[4], { prompt: Boolean(chatContent[4]) });
    try { sendJson(response, 200, await runFiles.readConsoleContent(reference)); }
    catch (error) { diagnostic('communication.console_content_failed', { error }); sendJson(response, 409, { error: '执行内容不可读取或完整性校验失败；未恢复旧内容。' }); }
    return true;
  }
  const readChat = pathname.match(/^\/api\/communications\/([^/]+)\/read$/);
  if (readChat && request.method === "POST") { sendJson(response, 200, { conversation: store.markCommunicationRead(readChat[1], (await readJson(request)).messageId) }); return true; }
  if (pathname === "/api/notifications" && request.method === "GET") { sendJson(response, 200, store.getNavigationNotifications()); return true; }
  if (request.method === "GET" && pathname === "/api/settings/log-files") {
    sendJson(response, 200, diagnostics().status());
    return true;
  }
  if (request.method === "GET" && pathname === "/api/settings/execution-logs") {
    sendJson(response, 200, store.getExecutionLogs({ source: searchParams.get("source") || "all", level: searchParams.get("level") || "all", before: searchParams.get("before"), limit: Number(searchParams.get("limit") || 100) }));
    return true;
  }
  if (pathname === "/api/communications" && request.method === "GET") { sendJson(response, 200, { conversations: store.listCommunications() }); return true; }
  if (pathname === "/api/communications" && request.method === "POST") { sendJson(response, 200, { conversation: store.openCommunication(await readJson(request)) }); return true; }
  const chat = pathname.match(/^\/api\/communications\/([^/]+)(?:\/(messages|deliveries)(?:\/([^/]+)\/(retry|cancel|events))?)?$/);
  if (chat) {
    const [, key, action, deliveryId, operation] = chat;
    const pagination = { before: searchParams.get("before"), limit: Number(searchParams.get("limit") || 100) };
    if (!action && request.method === "GET") { sendJson(response, 200, store.getCommunication(key, pagination)); return true; }
    if (action === "messages" && request.method === "POST") {
      const message = store.sendCommunication(key, await readJson(request));
      sendJson(response, 202, { message }); wakeCommunication(key); return true;
    }
    if (operation === "retry" && request.method === "POST") { store.retryCommunication(key, deliveryId); sendJson(response, 202, { ok: true }); wakeCommunication(key); return true; }
    if (operation === "cancel" && request.method === "POST") { store.cancelCommunication(key, deliveryId); sendJson(response, 200, { ok: true }); wakeCommunication(key); return true; }
    if (operation === "events" && request.method === "GET") { sendJson(response, 200, store.getCommunicationEvents(key, deliveryId, pagination)); return true; }
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return true;
  }
  if (request.method === "GET" && pathname === "/api/bootstrap") {
    sendJson(response, 200, { ...store.getBootstrap(), settings: store.getWorkspaceSettings() });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/workflow-templates") {
    sendJson(response, 200, { workflowTemplates: store.listWorkflowTemplates() });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/workflow-templates") {
    sendJson(response, 201, { workflowTemplate: store.createWorkflowTemplate(await readJson(request)) });
    return true;
  }
  const workflowMatch = pathname.match(/^\/api\/workflow-templates\/([^/]+)$/);
  if (workflowMatch && request.method === "PUT") {
    sendJson(response, 200, { workflowTemplate: store.updateWorkflowTemplate(workflowMatch[1], await readJson(request)) });
    return true;
  }
  if (workflowMatch && request.method === "DELETE") {
    sendJson(response, 200, { workflowTemplate: store.deleteWorkflowTemplate(workflowMatch[1]) });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/agents") {
    sendJson(response, 200, { agents: store.listAgents() });
    return true;
  }
  const historyMatch = pathname.match(/^\/api\/agents\/([^/]+)\/history\/([a-z_]+)$/);
  if (request.method === "POST" && historyMatch) {
    sendJson(response, 200, await queryHistory(store,historyMatch[1],historyMatch[2],await readJson(request),runFiles));
    return true;
  }
  if (pathname === "/api/settings/workspace" && request.method === "GET") {
    sendJson(response, 200, { ...store.getWorkspaceSettings(), version }); return true;
  }
  if (pathname === "/api/settings/workspace" && request.method === "PUT") {
    const input = await readJson(request);
    const path = input.workspaceRoot;
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.length > 4096) throw new Error("请输入有效的绝对目录路径");
    if (normalize(path) === parse(path).root) throw new Error("不能使用文件系统根目录");
    let canonical;
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      canonical = await realpath(path);
      if (!(await stat(canonical)).isDirectory()) throw new Error();
      await access(canonical, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch (cause) { throw new Error("目录无法创建或服务无法读写，请检查路径和权限", { cause }); }
    if (canonical === parse(canonical).root) throw new Error("不能使用文件系统根目录");
    sendJson(response, 200, { ...store.updateWorkspaceSettings({ workspaceRoot: canonical }), version }); return true;
  }
  // CLI paths are executed via execFile without a shell, so spaces and
  // non-ASCII are legitimate; only control characters/newlines are rejected.
  const validCliPath = (value) => typeof value === "string" && value.length <= 1024 && !/[\0\r\n]/.test(value);
  if (pathname === "/api/settings/runtime-profiles/models" && request.method === "GET") {
    const provider = searchParams.get("provider") || "";
    if (!["claude-code", "codex"].includes(provider)) throw new Error("provider 必须是 claude-code 或 codex");
    const executable = searchParams.get("executable") || "";
    if (!validCliPath(executable)) throw new Error("CLI 路径格式无效");
    sendJson(response, 200, await runtimeModelCatalog({ provider, executable: executable || null }));
    return true;
  }
  if (pathname === "/api/settings/runtime-profiles" && request.method === "GET") {
    sendJson(response, 200, { profiles: store.listRuntimeProfiles() }); return true;
  }
  // Per-model effort validation uses the real catalog when the saved model is
  // listed; manual models and catalog outages keep capability unknown (no
  // invented rejection). Store still enforces the provider vocabulary.
  async function assertRuntimeEffortSupport(input) {
    const effort = typeof input?.effort === "string" ? input.effort.trim() : "";
    const model = typeof input?.model === "string" ? input.model.trim() : "";
    const provider = input?.provider || "claude-code";
    if (!effort || !model || !["claude-code", "codex"].includes(provider) || !validCliPath(typeof input?.executable === "string" ? input.executable : "")) return;
    const catalog = await runtimeModelCatalog({ provider, executable: typeof input.executable === "string" && input.executable.trim() ? input.executable.trim() : null }).catch(error => { diagnostic("settings.model_catalog_validation_skipped", { error }); return null; });
    assertModelEffort(catalog, model, effort);
  }
  if (pathname === "/api/settings/runtime-profiles" && request.method === "POST") {
    const input = await readJson(request);
    await assertRuntimeEffortSupport(input);
    sendJson(response, 201, store.saveRuntimeProfile(input)); return true;
  }
  const runtimeProfileMatch = pathname.match(/^\/api\/settings\/runtime-profiles\/([^/]+)(\/test)?$/);
  if (runtimeProfileMatch && request.method === "PUT" && !runtimeProfileMatch[2]) {
    const input = await readJson(request);
    await assertRuntimeEffortSupport(input);
    sendJson(response, 200, store.saveRuntimeProfile(input, runtimeProfileMatch[1])); return true;
  }
  if (runtimeProfileMatch && request.method === "DELETE" && !runtimeProfileMatch[2]) {
    sendJson(response, 200, store.deleteRuntimeProfile(runtimeProfileMatch[1])); return true;
  }
  if (runtimeProfileMatch?.[2] && request.method === "POST") {
    const profile = store.listRuntimeProfiles().find(item => item.id === runtimeProfileMatch[1]);
    if (!profile) throw new Error("Runtime 配置不存在");
    if (runtimeTestActive) { sendJson(response, 409, { error: "已有连接测试正在执行，请等待完成" }); return true; }
    runtimeTestActive = true;
    try { sendJson(response, 200, await probeRuntime(profile)); }
    finally { runtimeTestActive = false; }
    return true;
  }
  if (request.method === "GET" && pathname === "/api/runtime/git-credentials") {
    sendJson(response, 200, await runtimeConfiguration.listGitCredentials());
    return true;
  }
  const gitCredentialMatch = pathname.match(/^\/api\/runtime\/git-credentials\/(github|gitlab)$/);
  if (gitCredentialMatch && request.method === "PUT") {
    sendJson(response, 200, await runtimeConfiguration.saveGitCredential(gitCredentialMatch[1], (await readJson(request)).token));
    return true;
  }
  if (gitCredentialMatch && request.method === "DELETE") {
    await readJson(request);
    sendJson(response, 200, await runtimeConfiguration.removeGitCredential(gitCredentialMatch[1]));
    return true;
  }
  if(pathname==='/api/runtime/marketplace/updates' && ['GET','POST'].includes(request.method)) {
    if(request.method==='POST'){await readJson(request);void pluginUpdates.check();}
    sendJson(response,request.method==='POST'?202:200,pluginUpdates.status());return true;
  }
  if(pathname==='/api/runtime/marketplace/updates/settings' && request.method==='PUT') {
    const input=await readJson(request);
    sendJson(response,200,pluginUpdates.configure(input));return true;
  }
  if (pathname === "/api/runtime/mcp-marketplace" && ["GET", "POST"].includes(request.method)) {
    response.setHeader("Cache-Control", "no-store");
    const result = request.method === "GET" ? await marketplace.mcpCatalog() : await marketplace.add({...await readJson(request), kind:"mcp", visibility:"market"});
    if (request.method === "GET") result.entries = result.entries.filter(item => !store.isExtensionRemoved("mcp", item.id));
    sendJson(response, request.method === "GET" ? 200 : 201, result);
    return true;
  }
  if (pathname === "/api/runtime/marketplace" && ["GET", "POST"].includes(request.method)) {
    response.setHeader("Cache-Control", "no-store");
    const result = request.method === "GET" ? await marketplace.catalog() : await marketplace.import(await readJson(request));
    if (request.method === "GET") result.plugins = result.plugins.filter(item => !store.isExtensionRemoved("plugin", item.id));
    sendJson(response, request.method === "GET" ? 200 : 201, result);
    return true;
  }
  const extensionDetail = pathname.match(/^\/api\/runtime\/(marketplace|mcp-marketplace)\/([^/]+)$/);
  if(extensionDetail?.[1]==='mcp-marketplace' && request.method==='PUT') {
    const previousId=extensionDetail[2];
    if(store.isExtensionRemoved('mcp',previousId) || !(await marketplace.mcpCatalog()).entries.some(item=>item.id===previousId)){sendJson(response,404,{error:'此 MCP 未安装或已被更新，请刷新列表'});return true;}
    const input=await marketplace.mcpEditInput(previousId,await readJson(request));
    const replacement=await marketplace.add(input);
    try {
      const users=store.listAgents().filter(item=>item.runtime?.extensionSelection?.mcpIds?.includes(previousId));
      const bindings=await Promise.all(users.map(async item=>({agentId:item.id,previousRuntime:item.runtime,runtime:{profileId:item.runtime.profileId,...await marketplace.resolve({...item.runtime.extensionSelection,mcpIds:item.runtime.extensionSelection.mcpIds.map(id=>id===previousId?replacement.id:id)},item.runtime.provider)}})));
      sendJson(response,200,store.replaceMcpExtension(previousId,replacement,bindings));
    } catch(error) {
      // Failed candidates are hidden, not used to rewrite any frozen files.
      try{store.removeExtension({kind:'mcp',id:replacement.id,name:replacement.name});}catch(cleanupError){diagnostic('mcp.edit_cleanup_failed',{error:cleanupError});}
      throw error;
    }
    return true;
  }
  if(extensionDetail && ['GET', 'DELETE'].includes(request.method)) {
    response.setHeader("Cache-Control", "no-store");
    const kind = extensionDetail[1] === 'marketplace' ? 'plugin' : 'mcp', extensionId = extensionDetail[2];
    if (store.isExtensionRemoved(kind, extensionId)) { sendJson(response, 404, { error: "此插件或 MCP 已删除" }); return true; }
    if (request.method === 'DELETE') {
      await readJson(request);
      const catalog = kind === 'plugin' ? (await marketplace.catalog()).plugins : (await marketplace.mcpCatalog()).entries;
      const entry = catalog.find(item => item.id === extensionId);
      if (!entry) { sendJson(response, 404, { error: "此插件或 MCP 未安装" }); return true; }
      sendJson(response, 200, store.removeExtension({ kind, id: entry.id, name: entry.name }));
    } else sendJson(response, 200, await marketplace.detail(extensionId, kind));
    return true;
  }
  if (request.method === "POST" && pathname === "/api/agents") {
    sendJson(response, 201, { agent: store.createAgent(await employeeInput(request)) });
    return true;
  }
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch && request.method === "PUT") {
    sendJson(response, 200, { agent: store.updateAgent(agentMatch[1], await employeeInput(request, agentMatch[1])) });
    return true;
  }
  if (agentMatch && request.method === "DELETE") {
    sendJson(response, 200, { agent: store.deleteAgent(agentMatch[1]) }); return true;
  }
  if (request.method === "GET" && pathname === "/api/teams") {
    sendJson(response, 200, { teams: store.listTeams() });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/teams") {
    sendJson(response, 201, { team: store.createTeam(await readJson(request)) });
    return true;
  }
  const teamMatch = pathname.match(/^\/api\/teams\/([^/]+)$/);
  if (teamMatch && request.method === "PUT") {
    sendJson(response, 200, { team: store.updateTeam(teamMatch[1], await readJson(request)) });
    return true;
  }
  if (teamMatch && request.method === "DELETE") {
    sendJson(response, 200, { team: store.deleteTeam(teamMatch[1]) }); return true;
  }
  if (request.method === "GET" && pathname === "/api/tasks") {
    sendJson(response, 200, { tasks: store.listTasks() });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/tasks") {
    const task = store.createTask(await readJson(request));
    // Directory preparation is retriable during Run startup; task creation is metadata-only.
    sendJson(response, 201, { task });
    return true;
  }
  const taskArchiveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/archive$/);
  const taskUnarchiveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/unarchive$/);
  if (request.method === "POST" && taskArchiveMatch) {
    sendJson(response, 200, { task: store.archiveTask(taskArchiveMatch[1]) });
    return true;
  }
  if (request.method === "POST" && taskUnarchiveMatch) {
    sendJson(response, 200, { task: store.unarchiveTask(taskUnarchiveMatch[1]) });
    return true;
  }
  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (request.method === "DELETE" && taskMatch) {
    const taskId = taskMatch[1];
    return withTaskDeletionLock(taskDeletionLocks, taskId, async () => {
      store.assertTaskDeletionAllowed(taskId);
      const relatedRuns = store.listRuns().filter((run) => run.taskId === taskId);
      const staged = await runFiles.stageRunsForDeletion(relatedRuns.map((run) => run.id));
      let deleted;
      try { deleted = store.deleteTask(taskId); }
      catch (error) {
        if (staged) {
          try { await runFiles.restoreStagedRuns(staged); }
          catch { console.error("Task deletion was rejected; retained Run files await safe recovery."); }
        }
        throw error;
      }
      try { if (staged) await runFiles.finalizeStagedRuns(staged); }
      catch {
        console.error("Task metadata was deleted; isolated Run files await cleanup recovery.");
        sendJson(response, 202, { ...deleted, runFileCleanup: "pending" });
        return true;
      }
      sendJson(response, 200, deleted);
      return true;
    });
  }
  const runMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
  if (request.method === "POST" && runMatch) {
    const run = store.createRun(runMatch[1]);
    executeRun(store, run.id, runExecutionOptions).catch((error) => console.error(`Run ${run.id} dispatch failed: ${error.message}`));
    sendJson(response, 202, { run });
    return true;
  }
  const timelineMatch = pathname.match(/^\/api\/runs\/([^/]+)\/timeline$/);
  if (request.method === "GET" && timelineMatch) {
    sendJson(response, 200, { events: store.timeline(timelineMatch[1]), run: store.listRuns().find((run) => run.id === timelineMatch[1]) || null });
    return true;
  }
  const workspaceMatch = pathname.match(/^\/api\/runs\/([^/]+)\/workspace$/);
  if (request.method === "GET" && workspaceMatch) {
    sendJson(response, 200, store.getRunWorkspace(workspaceMatch[1], { summary: searchParams.get("view") === "summary" }));
    return true;
  }
  const consoleContentMatch = pathname.match(/^\/api\/runs\/([^/]+)\/console-content\/([^/]+)$/);
  if (request.method === "GET" && consoleContentMatch) {
    const reference = store.getConsoleContentReference(consoleContentMatch[1], consoleContentMatch[2]);
    try { sendJson(response, 200, await runFiles.readConsoleContent(reference)); }
    catch { sendJson(response, 409, { error: "执行内容不可读取或完整性校验失败；未恢复旧内容。" }); }
    return true;
  }
  const promptSnapshotMatch = pathname.match(/^\/api\/runs\/([^/]+)\/traces\/([^/]+)\/prompt$/);
  if (request.method === "GET" && promptSnapshotMatch) {
    const reference = store.getTracePromptReference(promptSnapshotMatch[1], promptSnapshotMatch[2]);
    try { sendJson(response, 200, await runFiles.readConsoleContent(reference)); }
    catch { sendJson(response, 409, { error: "提示词快照不可读取或完整性校验失败；未恢复旧内容。" }); }
    return true;
  }
  const consoleMatch = pathname.match(/^\/api\/runs\/([^/]+)\/console$/);
  if (request.method === "GET" && consoleMatch) {
    sendJson(response, 200, store.getConsoleEvents(consoleMatch[1], { agentId: searchParams.get("agentId"), traceId: searchParams.get("traceId"), before: searchParams.get("before"), limit: Number(searchParams.get("limit") || 200) }));
    return true;
  }
  const repositoryTreeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/repository-tree$/);
  const workingChangesMatch = pathname.match(/^\/api\/runs\/([^/]+)\/working-directory\/(changes|diff)$/);
  if (request.method === "GET" && workingChangesMatch) {
    const task = store.getRunWorkspace(workingChangesMatch[1]).run.task;
    sendJson(response, 200, workingChangesMatch[2] === "changes"
      ? await runFiles.listWorkingChanges(task)
      : await runFiles.readWorkingDiff(task, searchParams.get("path") || "", { full: searchParams.get("full") === "1" }));
    return true;
  }
  const workingDirectoryMatch = pathname.match(/^\/api\/runs\/([^/]+)\/working-directory(?:\/(content))?$/);
  if (request.method === "GET" && workingDirectoryMatch) {
    const task = store.getRunWorkspace(workingDirectoryMatch[1]).run.task;
    if (!workingDirectoryMatch[2]) sendJson(response, 200, await runFiles.listWorkingDirectory(task,{path:searchParams.get('path') || '',offset:Number(searchParams.get('offset') || 0)}));
    else {
      const raw = searchParams.get("raw") === "1";
      const download = searchParams.get("download") === "1";
      const file = await runFiles.readWorkingFile(task, searchParams.get("path") || "", { raw, download });
      if (download) {
        const filename = encodeURIComponent(file.fileName).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${filename}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
        try { await pipeline(file.content, response); }
        catch (error) { diagnostic("http.working_file_download_failed", { runId: workingDirectoryMatch[1], error }); response.destroy(); }
      }
      else if (raw) { response.writeHead(200, { "Content-Type": file.mediaType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" }); response.end(file.content); }
      else sendJson(response, 200, { ...file, ...(file.content == null ? {} : artifactPresentation({ name: file.path }, file.content)) });
    }
    return true;
  }
  if (request.method === "GET" && repositoryTreeMatch) {
    const workspace = store.getRunWorkspace(repositoryTreeMatch[1]);
    const repositoryPath = searchParams.get("path") || "";
    const assignedRepository = workspace.run.task.repositoryMode === "agent" ? workspace.run.task.repositorySources.some((source) => source.path === repositoryPath) : workspace.run.task.workflowSnapshot.nodes.some((node) => node.repositoryPath === repositoryPath);
    if (!assignedRepository) throw new Error("该仓库不属于当前 Task 工作流");
    sendJson(response, 200, await runFiles.listRepositoryTree(workspace.run.task.workspacePath, repositoryPath));
    return true;
  }
  const defectMatch = pathname.match(/^\/api\/runs\/([^/]+)\/defects(?:\/([^/]+))?$/);
  if (defectMatch && request.method === "GET" && !defectMatch[2]) {
    sendJson(response, 200, { defects: store.listDefects(defectMatch[1]) });
    return true;
  }
  if (defectMatch && request.method === "PUT" && defectMatch[2]) {
    const input = await readJson(request);
    sendJson(response, 200, { defect: store.updateDefect(defectMatch[1], defectMatch[2], input) });
    return true;
  }
  const artifactMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)\/content$/);
  if (request.method === "GET" && artifactMatch) {
    const workspace = store.getRunWorkspace(artifactMatch[1]);
    const artifact = workspace.artifacts.find((candidate) => candidate.id === artifactMatch[2]);
    if (!artifact) throw new Error("Artifact 不存在");
    if (!artifact.storagePath) throw new Error(artifact.unavailableReason || "该 Artifact 没有可读取的真实文件");
    const file = await readArtifactSafely(() => runFiles.readArtifact(artifact.storagePath, { expected: artifact }));
    sendJson(response, 200, { artifact, ...file, ...artifactPresentation(artifact, file.content) });
    return true;
  }
  const artifactRawMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)\/raw$/);
  if (request.method === "GET" && artifactRawMatch) {
    const workspace = store.getRunWorkspace(artifactRawMatch[1]);
    const artifact = workspace.artifacts.find((candidate) => candidate.id === artifactRawMatch[2]);
    if (!artifact?.storagePath) throw new Error("Artifact 不存在或不可读取");
    if (!rasterImageType(artifact.mediaType)) throw new Error("raw 预览仅支持 PNG、JPEG、GIF 和 WebP 图片");
    const content = await readArtifactSafely(() => runFiles.readArtifactBytes(artifact.storagePath, { expected: artifact }));
    response.writeHead(200, { "Content-Type": artifact.mediaType || "application/octet-stream", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; sandbox" });
    response.end(content);
    return true;
  }
  const confirmMatch = pathname.match(/^\/api\/runs\/([^/]+)\/confirm-completion$/);
  if (request.method === "POST" && confirmMatch) {
    sendJson(response, 200, { run: store.confirmRunCompletion(confirmMatch[1]) });
    return true;
  }
  const stopInquiryMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stop-inquiries$/);
  if (request.method === "POST" && stopInquiryMatch) {
    sendJson(response, 200, { run: stopInquiries(store, stopInquiryMatch[1]) });
    return true;
  }
  const messageMatch = pathname.match(/^\/api\/runs\/([^/]+)\/messages$/);
  if (request.method === "POST" && messageMatch) {
    const runId = messageMatch[1]; const input = await readJson(request);
    store.initializeDispatches(runId);
    const result = store.submitHumanMessage(runId, { content: input.content, recipientAgentId: input.recipientAgentId, replyToMessageId: input.replyToMessageId });
    executeRun(store, runId, runExecutionOptions).catch((error) => console.error(`Run ${runId} dispatch failed: ${error.message}`));
    sendJson(response, 201, { ...result, replanRequested: false });
    return true;
  }
  const terminateMatch = pathname.match(/^\/api\/runs\/([^/]+)\/terminate$/);
  const pauseMatch = pathname.match(/^\/api\/runs\/([^/]+)\/pause$/);
  const resumeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/resume$/);
  const retryNowMatch = pathname.match(/^\/api\/runs\/([^/]+)\/retry-now$/);
  const retryMatch = pathname.match(/^\/api\/runs\/([^/]+)\/retry-failed-node$/);
  const retryManagerMatch = pathname.match(/^\/api\/runs\/([^/]+)\/retry-orchestration$/);
  if (request.method === "POST" && retryNowMatch) {
    await readJson(request);
    const result = store.retryScheduledDispatches(retryNowMatch[1]);
    executeRun(store, result.run.id, runExecutionOptions).catch((error) => console.error(`Run ${result.run.id} dispatch failed: ${error.message}`));
    sendJson(response, 202, result);
    return true;
  }
  if (request.method === "POST" && retryManagerMatch) {
    const run = store.retryFailedOrchestration(retryManagerMatch[1]);
    executeRun(store, run.id, runExecutionOptions).catch((error) => console.error(`Run ${run.id} dispatch failed: ${error.message}`));
    sendJson(response, 202, { run });
    return true;
  }
  if (request.method === "POST" && retryMatch) {
    const run = store.retryFailedNode(retryMatch[1], (await readJson(request)).workflowNodeId);
    executeRun(store, run.id, runExecutionOptions).catch((error) => console.error(`Run ${run.id} dispatch failed: ${error.message}`));
    sendJson(response, 202, { run });
    return true;
  }
  if (request.method === "POST" && pauseMatch) {
    const input = await readJson(request);
    sendJson(response, 200, { run: pauseRun(store, pauseMatch[1], input.reason || "用户暂停") });
    return true;
  }
  if (request.method === "POST" && resumeMatch) {
    const run = resumeRun(store, resumeMatch[1]);
    store.addEvent({ type: "run.manager_patrol_requested", runId: run.id, message: "用户继续 Run；项目经理立即基于当前状态重新评估。", data: { trigger: "manual_resume" } });
    executeRun(store, run.id, runExecutionOptions).catch((error) => console.error(`Run ${run.id} resume failed: ${error.message}`));
    sendJson(response, 202, { run });
    return true;
  }
  if (request.method === "POST" && terminateMatch) {
    const input = await readJson(request);
    sendJson(response, 200, { run: terminateRun(store, terminateMatch[1], input.reason || "用户终止") });
    return true;
  }
  const streamMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (request.method === "GET" && streamMatch) {
    const runId = streamMatch[1];
    store.getRun(runId);
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    eventStreams.add(response);
    response.write(`event: ready\ndata: ${JSON.stringify({ runId })}\n\n`);
    const authorized = () => { if (response.writableEnded) return false; if (auth.session(request)) return true; response.write("event: auth-expired\ndata: {}\n\n"); response.end(); return false; };
    const unsubscribe = store.subscribe((event) => { if (event.runId === runId && authorized()) response.write(`event: run-event\ndata: ${JSON.stringify(event)}\n\n`); });
    const heartbeat = setInterval(() => { if (authorized()) response.write(": heartbeat\n\n"); }, 15000);
    request.on("close", () => { eventStreams.delete(response); clearInterval(heartbeat); unsubscribe(); });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "agentforge-control-plane", instanceId, time: new Date().toISOString() });
    return true;
  }
  return false;
}

async function serveStatic(response, pathname) {
  async function presented(content, extension) {
    if (extension !== ".html") return content;
    const css = await readFile(join(root, "apps/electron/compact.css"), "utf8");
    return content.toString("utf8").replace("</head>", `<style id="agentforge-desktop-style">${css}</style></head>`);
  }
  const bundles = { "/vendor/marked.js": markedBundle, "/vendor/dompurify.js": domPurifyBundle, "/vendor/highlight.css": highlightStylesheet, "/vendor/x6.js": x6Bundle, "/vendor/elk.js": elkBundle };
  if (bundles[pathname]) {
    try {
      const content = await readFile(bundles[pathname]);
      response.writeHead(200, { "Content-Type": contentTypes[extname(bundles[pathname])] || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" });
      response.end(content);
    } catch { sendJson(response, 503, { error: "local_visual_runtime_unavailable" }); }
    return;
  }
  const clientModule = pathname.startsWith("/client/");
  const staticRoot = clientModule ? clientRoot : webRoot;
  const requested = clientModule ? pathname.slice("/client".length) : pathname === "/login" ? "/login.html" : pathname === "/setup" ? "/setup.html" : pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(join(staticRoot, requested));
  if (!(safePath === staticRoot || safePath.startsWith(`${staticRoot}/`))) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }
  try {
    const content = await readFile(safePath);
    const body = await presented(content, extname(safePath));
    response.writeHead(200, { "Content-Type": contentTypes[extname(safePath)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    if (clientModule) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const fallback = await readFile(join(webRoot, "index.html"));
    const body = await presented(fallback, ".html");
    response.writeHead(200, { "Content-Type": contentTypes[".html"], "Cache-Control": "no-store" });
    response.end(body);
  }
}

const server = createServer(async (request, response) => {
  if (!auth) { sendJson(response, 503, { error: "服务正在启动" }); return; }
  const write = !["GET", "HEAD"].includes(request.method);
  if (resettingData) { sendJson(response, 503, { error: "正在清除数据，请稍后重试" }); return; }
  if (write) ++writeRequests;
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (await auth.guard(request, response, url)) return;
    const handled = await routeApi(request, response, url.pathname, url.searchParams);
    if (handled) return;
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    diagnostic("http.request_failed", { method: request.method, pathname: (request.url || "").split("?")[0], error });
    sendJson(response, error instanceof RequestBodyTooLargeError ? 413 : 400, { error: error.message || "请求处理失败" });
  } finally { if (write) --writeRequests; }
});

server.listen(port, host, () => {
  const listeningPort = server.address().port;
  authOptions.origins = [`http://127.0.0.1:${listeningPort}`];
  auth = createAuth(authOptions);
  console.log(`AgentForge is running at http://${host}:${listeningPort}`);
  process.send({ type: "agentforge-ready", port: listeningPort, instanceId });
  communications.recover();
  pluginUpdates.start();
  communications.poll().catch(error => diagnostic("communication.recovery_error", { error }));
  for (const run of store.listRuns()) {
    const plan = store.getRunRecoveryPlan(run.id);
    if (plan.interruptedTraceIds.length || plan.recoveredDispatchIds.length) store.recoverInterruptedRun(run.id);
    if (!store.getRunRecoveryPlan(run.id).shouldExecute) continue;
    console.log(`Scheduling pending work for Run ${run.id}; business status remains ${run.status}.`);
    executeRun(store, run.id, runExecutionOptions).catch((error) => console.error(`Run ${run.id} recovery failed: ${error.message}`));
  }
});

const managerPatrolIntervalMs = 5 * 60 * 1000;
server.on('close',()=>pluginUpdates.stop());
process.once('disconnect',()=>process.kill(process.pid,'SIGTERM'));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{
  // Abort owned Git work before preserving the service's exit semantics.
  const finish=()=>process.exit(signal==='SIGINT'?130:143);
  setTimeout(finish,3000).unref();
  void pluginUpdates.stop().finally(finish);
});
setInterval(() => { if (!resettingData) communications.poll().catch(error => diagnostic("communication.poll_error", { error })); }, 15000).unref();
setInterval(() => {
  if (resettingData) return;
  for (const run of store.listRuns().filter((item) => !item.task.archivedAt && (["planning", "running", "review"].includes(item.status) || store.listDispatches(item.id).some((delivery) => delivery.interactionOnly && delivery.status === "queued")))) {
    const workspace = store.getRunWorkspace(run.id);
    if (hasActiveExecution(run.id) || workspace.traces.some((trace) => trace.status === "running")) continue;
    const due = store.listDispatches(run.id).filter(item => item.status === 'queued' && (!item.nextRetryAt || Date.parse(item.nextRetryAt) <= Date.now()));
    if (!due.length || store.hasPendingHumanQuestion(run.id)) continue;
    store.addEvent({ type: "run.manager_patrol", runId: run.id, message: "平台定时调度器继续已有待执行投递；不代表经理新增派工。", data: { trigger: "scheduled", intervalMs: managerPatrolIntervalMs, dispatchIds: due.map(item => item.id) } });
    executeRun(store, run.id, runExecutionOptions).catch((error) => console.error(`Run ${run.id} patrol failed: ${error.message}`));
  }
}, managerPatrolIntervalMs);
