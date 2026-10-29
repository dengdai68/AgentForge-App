import { statSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { isAbsolute, resolve, dirname } from "node:path";
import { createSqlitePersistence } from "./persistence.mjs";
import { communicationCommands } from "./communication-store.mjs";
import { historyCommands } from "./history/index.mjs";
import { executionLogs } from "./execution-logs.mjs";

const now = () => new Date().toISOString(); let sequence = 0;
const id = (prefix) => `${prefix}_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function consoleAuditProjection(event) {
  const legacyAudit = ["runtime.event", "trace.failed"].includes(event?.type) && event.data?.auditVersion !== 2;
  if (!legacyAudit) return clone(event);
  const traceId = typeof event.data?.traceId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(event.data.traceId) ? event.data.traceId : null;
  return {
    id: event.id,
    type: event.type,
    runId: event.runId,
    timestamp: event.timestamp,
    actor: clone(event.actor),
    message: event.type === "runtime.event" ? "历史运行记录已按当前审计边界隐藏原始内容。" : "历史 Trace 失败原因已按当前审计边界隐藏原始内容。",
    data: { auditVersion: 1, ...(traceId ? { traceId } : {}) }
  };
}
const taskTransitions = { backlog: ["planning", "cancelled"], planning: ["running", "paused", "blocked", "cancelled"], running: ["review", "awaiting_human", "paused", "blocked", "cancelled"], awaiting_human: ["running", "review", "paused", "cancelled"], review: ["awaiting_acceptance", "running", "paused", "blocked", "cancelled"], paused: ["running", "awaiting_human", "review", "cancelled"], blocked: ["running", "cancelled"], awaiting_acceptance: ["done", "running", "cancelled"], done: [], cancelled: [] };
const runTransitions = { planning: ["running", "paused", "failed", "cancelled"], running: ["review", "awaiting_human", "paused", "failed", "cancelled"], awaiting_human: ["running", "review", "paused", "cancelled"], review: ["awaiting_acceptance", "running", "paused", "failed", "cancelled"], paused: ["running", "awaiting_human", "review", "cancelled"], awaiting_acceptance: ["completed", "running", "cancelled"], completed: [], failed: ["running"], cancelled: [] };
const text = (value, name) => { if (typeof value !== "string" || !value.trim()) throw new Error(`${name}不能为空`); return value.trim(); };
const roleName = (value) => { const name = text(value, "角色名称"); if (name.length > 80) throw new Error("角色名称最多 80 字符"); return name; };
const defaultAcceptanceCriteria = [];
function taskAcceptanceCriteria(value) {
  if (value === undefined || (Array.isArray(value) && !value.length)) return [...defaultAcceptanceCriteria];
  if (!Array.isArray(value) || value.some((criterion) => typeof criterion !== "string")) throw new Error("任务验收标准必须是字符串数组");
  if (value.length > 20) throw new Error("任务验收标准最多 20 条");
  return value.map((criterion, index) => {
    const normalized = criterion.trim();
    if (!normalized) throw new Error(`第 ${index + 1} 条任务验收标准不能为空`);
    if (normalized.length > 500) throw new Error(`第 ${index + 1} 条任务验收标准不能超过 500 字符`);
    return normalized;
  });
}
function migrateAcceptanceCriteria(value) {
  const legacy = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const criteria = legacy.filter((criterion) => typeof criterion === "string" && criterion.trim()).map((criterion) => criterion.trim() === "交付反思" ? "项目经理交付复核" : criterion.trim());
  return criteria.length ? criteria : [...defaultAcceptanceCriteria];
}
function pluginSources(value = []) {
  if (!Array.isArray(value) || value.length > 20) throw new Error("插件来源最多 20 个");
  return value.map((source) => {
    if (!source || !/^[0-9a-f-]{36}$/.test(source.catalogId) || typeof source.enabled !== "boolean" || !Array.isArray(source.enabledPlugins) || source.enabledPlugins.length > 300 || source.enabledPlugins.some((name) => typeof name !== "string" || !name.trim())) throw new Error("插件来源绑定无效");
    return { catalogId: source.catalogId, enabled: source.enabled, enabledPlugins: [...new Set(source.enabledPlugins)] };
  });
}
function extensionBinding(value) {
  if (value.extensionSelection === undefined) return {};
  const selection = value.extensionSelection, manifest = value.extensionManifest;
  // Current plugin-level references. Existing immutable Skill snapshots below
  // stay readable; HTTP/CLI never accept that retired write protocol.
  if(selection && !Object.hasOwn(selection,'skillIds')) {
    if(Object.keys(selection).some(key=>!['pluginIds','mcpIds'].includes(key)) || !Array.isArray(selection.pluginIds) || !Array.isArray(selection.mcpIds) || !Array.isArray(manifest)) throw new Error('插件/MCP 绑定无效');
    const ids=[...selection.pluginIds,...selection.mcpIds];
    if(new Set(ids).size!==ids.length || manifest.length!==ids.length || ids.some(id=>typeof id!=='string' || !/^[0-9a-f-]{36}$/.test(id))) throw new Error('插件/MCP 版本无效');
    if(manifest.some(ref=>!['plugin','mcp'].includes(ref.kind) || !selection[ref.kind==='plugin'?'pluginIds':'mcpIds'].includes(ref.id) || typeof ref.name!=='string' || !isAbsolute(ref.path || '') || !/^[a-f0-9]{64}$/.test(ref.sha256 || '') || (ref.kind==='plugin' && (!/^[a-f0-9]{64}$/.test(ref.treeSha256 || '') || !Array.isArray(ref.skills) || ref.skills.some(path=>typeof path!=='string' || isAbsolute(path) || path.split('/').includes('..'))))) || new Set(manifest.map(ref=>ref.id)).size!==ids.length) throw new Error('插件/MCP 引用无效');
    const plugins=manifest.filter(ref=>ref.kind==='plugin');
    if(value.pluginSources?.length || JSON.stringify(value.skillPaths || [])!==JSON.stringify(plugins.flatMap(ref=>ref.skills.map(path=>resolve(dirname(dirname(ref.path)),path)))) || JSON.stringify(value.pluginPaths || [])!==JSON.stringify(value.provider==='codex'?[]:plugins.map(ref=>dirname(dirname(ref.path)))) || JSON.stringify(value.mcpConfigPaths || [])!==JSON.stringify(manifest.filter(ref=>ref.kind==='mcp').map(ref=>ref.path))) throw new Error('市场模式只能使用所选插件/MCP');
    return {extensionSelection:clone(selection),extensionManifest:clone(manifest)};
  }
  if (!selection || !Array.isArray(selection.skillIds) || !Array.isArray(selection.mcpIds) || !Array.isArray(manifest)) throw new Error("市场扩展绑定无效");
  const ids = [...selection.skillIds, ...selection.mcpIds];
  if (ids.length > 60 || new Set(ids).size !== ids.length || manifest.length !== ids.length || ids.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))) throw new Error("市场扩展版本无效");
  if (manifest.some(ref => !ids.includes(ref.id) || !['skill', 'mcp'].includes(ref.kind) || !selection[ref.kind === 'skill' ? 'skillIds' : 'mcpIds'].includes(ref.id) || typeof ref.name !== 'string' || !isAbsolute(ref.path || '') || !/^[a-f0-9]{64}$/.test(ref.sha256 || '')) || new Set(manifest.map(ref => ref.id)).size !== ids.length) throw new Error("市场扩展引用无效");
  if (value.pluginPaths?.length || value.pluginSources?.length || ['skill', 'mcp'].some(kind => JSON.stringify(value[kind === 'skill' ? 'skillPaths' : 'mcpConfigPaths'] || []) !== JSON.stringify(manifest.filter(ref => ref.kind === kind).map(ref => ref.path)))) throw new Error("市场模式只能使用所选扩展");
  if (manifest.some(ref => ref.treeSha256 !== undefined && (ref.kind !== 'skill' || !/^[a-f0-9]{64}$/.test(ref.treeSha256)))) throw new Error("技能目录摘要无效");
  if(selection.pluginIds !== undefined && (!Array.isArray(selection.pluginIds) || selection.pluginIds.length > 30 || new Set(selection.pluginIds).size !== selection.pluginIds.length || selection.pluginIds.some(id=>typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)))) throw new Error('插件版本选择无效');
  if(manifest.some(ref=>(ref.resourceRoot !== undefined || ref.resourceSha256 !== undefined) && (ref.kind !== 'mcp' || !isAbsolute(ref.resourceRoot || '') || !/^[a-f0-9]{64}$/.test(ref.resourceSha256 || '')))) throw new Error('插件资源摘要无效');
  return { extensionSelection: { skillIds: [...selection.skillIds], mcpIds: [...selection.mcpIds], ...(selection.pluginIds === undefined ? {} : {pluginIds:[...selection.pluginIds]}) }, extensionManifest: manifest.map(({id,kind,name,path,sha256,treeSha256,resourceRoot,resourceSha256}) => ({id,kind,name,path,sha256,...(treeSha256 ? {treeSha256} : {}),...(resourceRoot ? {resourceRoot,resourceSha256} : {})})) };
}
const runtime = (value = {}) => { const provider = value.provider || "claude-code"; if (!["claude-code", "codex"].includes(provider)) throw new Error("运行时必须选择 Claude Code 或 Codex"); return { ...(value.profileId ? { profileId: String(value.profileId) } : {}), ...extensionBinding(value), pluginSources: pluginSources(value.pluginSources), provider, executable: value.executable?.trim() || null, model: value.model?.trim() || "", effort: effortLevel(provider, value.effort), profile: value.profile?.trim() || "", skillPaths: Array.isArray(value.skillPaths) ? value.skillPaths.map((path) => resolve(path)) : [], pluginPaths: Array.isArray(value.pluginPaths) ? value.pluginPaths.map((path) => resolve(path)) : [], mcpConfigPaths: Array.isArray(value.mcpConfigPaths) ? value.mcpConfigPaths.map((path) => resolve(path)) : [] } };
function documentPaths(value = []) {
  if(!Array.isArray(value))throw new Error('节点交付位置必须是相对路径数组');
  return [...new Set(value.map(item=>{
    const path=text(item,'节点交付位置'),parts=path.replace(/\/$/,'').split('/');
    if(isAbsolute(path) || /[\\\0]/.test(path) || parts.some(part=>!part || ['.','..','.git','.agentforge','.agentforge-workspace.json'].includes(part)))throw new Error('交付位置必须是工作目录内的规范相对路径，不得包含内部目录');
    return path;
  }))];
}
function validateWorkflowInput(input) {
  if (Array.isArray(input.nodes) && input.nodes.some(node => ['ownerRole', 'repositoryPath', 'reuseOwnerFrom'].some(key => Object.hasOwn(node || {}, key)))) throw new Error('工作流节点仅使用staffingGuidance描述人员需求；不接受ownerRole、repositoryPath或reuseOwnerFrom');
}
function workflow(input = {}, { templateId, system, current = false } = {}) { if (!Array.isArray(input.nodes) || !input.nodes.length) throw new Error("工作流至少需要一个节点"); const nodes = input.nodes.map((inputNode, index) => { const nodeId = text(inputNode?.id || `node_${index + 1}`, "节点 ID"); return { id: nodeId, title: text(inputNode?.title, `第 ${index + 1} 个节点标题`), staffingGuidance: text(inputNode?.staffingGuidance || (inputNode?.ownerRole ? `适合由熟悉${inputNode.ownerRole}相关工作的成员承担；请结合成员提示词和能力判断。` : ""), `第 ${index + 1} 个节点人员需求`), dependsOn: [...new Set(inputNode?.dependsOn || [])], handoffFrom: [...new Set(inputNode?.handoffFrom || [])], deliverable: inputNode?.deliverable?.trim() || `完成「${inputNode?.title}」并交付可验收文件。`, artifactPaths: documentPaths(inputNode?.artifactPaths, nodeId), ...(!current ? {repositoryPath: inputNode?.repositoryPath || null} : {}), ...(!current && inputNode?.reuseOwnerFrom ? { reuseOwnerFrom: inputNode.reuseOwnerFrom } : {}) }; }); const ids = new Set(nodes.map((node) => node.id)); if (ids.size !== nodes.length) throw new Error("工作流节点 ID 不能重复"); for (const node of nodes) { if (!/^[a-z][a-z0-9_]*$/.test(node.id)) throw new Error("节点 ID 只能使用小写字母、数字和下划线"); for (const dependency of [...node.dependsOn, ...node.handoffFrom]) if (!ids.has(dependency) || dependency === node.id) throw new Error(`节点「${node.title}」引用了不存在或自身的依赖节点`); if (node.repositoryPath && (!/^repos\/[A-Za-z0-9._-]+$/.test(node.repositoryPath) || ["repos/.", "repos/.."].includes(node.repositoryPath))) throw new Error("代码仓库必须是 repos/ 下的一个直接子目录"); } const visiting = new Set(), visited = new Set(); const visit = (nodeId) => { if (visiting.has(nodeId)) throw new Error("工作流节点依赖不能形成循环"); if (visited.has(nodeId)) return; visiting.add(nodeId); nodes.find((node) => node.id === nodeId).dependsOn.forEach(visit); visiting.delete(nodeId); visited.add(nodeId); }; nodes.forEach((node) => visit(node.id)); return { id: templateId || id("workflow"), system: Boolean(system), name: text(input.name, "工作流名称"), description: input.description?.trim() || "", nodes }; }
const exampleWorkflow = {
  id: "content_delivery", name: "内容交付", description: "从可信材料整理简报、创作内容，再独立审校。",
  nodes: [
    { id: "content_brief", title: "内容简报与验收标准", staffingGuidance: "选择能梳理受众、事实边界与验收标准的成员。", dependsOn: [], deliverable: "交付内容简报，列出输入事实、未知事项与验收标准。", artifactPaths: ["docs/content-brief/"] },
    { id: "content_creation", title: "内容创作与编辑", staffingGuidance: "选择能依据简报撰写准确清晰内容的成员。", dependsOn: ["content_brief"], deliverable: "依据内容简报交付可直接审阅的内容稿。", artifactPaths: ["docs/content/"] },
    { id: "content_review", title: "内容审校与质量核查", staffingGuidance: "选择非作者、能独立核对事实和验收标准的成员。", dependsOn: ["content_creation"], deliverable: "交付独立审校记录，明确问题、证据和返工建议。", artifactPaths: ["docs/content-review/"] }
  ]
};
function migrateWorkflowTemplates(value) {
  return (value || []).map((item) => workflow(item, { templateId: item.id, system: item.system, current: true }));
}
function agent(id, name, description, color, provider, kind = "business") { return { id, name, initials: name.slice(0, 2).toUpperCase(), color, description, kind, systemPrompt: `${description} 评估交接并完成可核验交付，信息不足时向合适成员咨询。`, capabilities: [], runtime: runtime({ provider, extensionSelection: {pluginIds:[],mcpIds:[]}, extensionManifest: [] }), allowedTools: [], status: "active", system: false, createdAt: now() }; }
const managerId = "system_project_manager";
const humanMember = { id: "human_operator", type: "human", name: "本机用户", role: "需求方/最终业务决策人", capabilities: ["业务取舍", "外部事实", "最终决策"] };
const agents = [agent(managerId, "项目经理", "依据成员交接推进工作流，决定何时提交人类验收；业务判断由对应节点负责。", "violet", "claude-code", "manager"), agent("agent_analyst", "内容编辑", "擅长整理可信资料、区分事实与推断并撰写清晰内容。", "cyan", "claude-code"), agent("agent_tester", "独立审校", "独立核对原始材料、事实边界、验收标准和交付文件，明确报告问题。", "green", "claude-code")];
function legacyStatus(step) { return step?.status === "completed" ? "completed" : step?.status === "failed" ? "failed" : step?.status === "awaiting_answer" ? "waiting_human" : ["cancelled", "invalidated", "superseded"].includes(step?.status) ? "skipped" : ["executing", "ready", "awaiting_review", "retrying"].includes(step?.status) ? "running" : "queued"; }
function migrate(loaded) {
  if (!loaded) return null;
  const state = clone(loaded), claudeRuntime = (value = {}) => runtime(value);
  for (const key of ["agents", "teams", "tasks", "runs", "events", "artifacts", "messages", "decisions", "defects", "traces", "roles"]) state[key] ||= [];
  state.workflowTemplates = migrateWorkflowTemplates(state.workflowTemplates);
  state.agents = state.agents.filter((item) => item.id !== "system_reflection_agent");
  for (const item of state.agents) { item.runtime = claudeRuntime(item.runtime); item.system = Boolean(item.system); delete item.role; }
  for (const item of state.tasks) {
    item.workspacePath ||= process.cwd(); item.workflowSnapshot ||= clone(state.workflowTemplates.find((template) => template.id === item.workflowTemplateId));
    item.workflowSnapshot = workflow(item.workflowSnapshot, { templateId: item.workflowSnapshot.id, system: item.workflowSnapshot.system });
    item.managerRuntime = claudeRuntime(item.managerRuntime); delete item.reflectionRuntime; delete item.reflectionAgentId;
    if (item.archivedAt === undefined) item.archivedAt = item.archived ? item.updatedAt || now() : null;
    delete item.archived;
    item.acceptanceCriteria = migrateAcceptanceCriteria(item.acceptanceCriteria);
  }
  const oldIssues = state.issues || [];
  for (const current of state.runs) {
    for (const step of current.steps || []) {
      const traceId = `legacy_trace_${current.id}_${step.id}`;
      if (!state.traces.some((item) => item.id === traceId)) state.traces.push({ id: traceId, runId: current.id, workflowNodeId: step.nodeId, agentId: step.ownerAgentId, status: step.status === "completed" ? "completed" : step.status === "failed" ? "failed" : "legacy", startedAt: step.startedAt || null, endedAt: step.completedAt || null, tracePath: `runs/${current.id}/steps/${step.id}/`, inputArtifactIds: [], outputArtifactIds: [], error: step.error || null, legacy: true });
    }
    current.waitingConversationId ||= null; current.waitingNodeId ||= null; current.waitingAgentId ||= null; current.pendingMessageIds ||= [];
    current.deliveryReview ||= current.reflection || null;
    // `currentFocus` is a project-manager decision, not a derived node lifecycle.
    // Keep legacy completed runs neutral: a completed Run has no "current" work.
    current.currentFocus ||= null;
    for (const key of ["steps", "workItems", "traceId", "agentContexts", "artifactIds", "loopControls", "reflectionCycles", "nodeStates", "reflectionAgent", "reflection"]) delete current[key];
  }
  for (const item of state.traces) if (item.agentId === "system_reflection_agent") item.agentId = state.runs.find((run) => run.id === item.runId)?.manager?.id || managerId;
  for (const item of state.events) if (item.actor?.id === "system_reflection_agent" || item.actor?.name === "交付反思师") { const manager = state.runs.find((run) => run.id === item.runId)?.manager; item.actor = { type: "agent", id: manager?.id || managerId, name: manager?.name || "项目经理" }; item.message = item.message?.replace(/交付反思师/g, "项目经理").replace(/独立交付反思/g, "项目经理交付复核").replace(/交付反思/g, "项目经理交付复核"); }
  for (const item of state.artifacts) { item.traceId ||= item.stepId ? `legacy_trace_${item.runId}_${item.stepId}` : null; item.category ||= item.name?.startsWith("repos/") ? "code" : "document"; delete item.stepId; delete item.producedByWorkItemId; delete item.producedByRevision; }
  for (const item of state.messages) { item.conversationId ||= item.consultationThreadId || `conversation_${item.runId}_${item.relatedStepId || "general"}`; delete item.relatedStepId; delete item.consultationThreadId; }
  for (const issue of oldIssues.filter((item) => item.kind === "defect")) if (!state.defects.some((item) => item.id === issue.id)) state.defects.push({ id: issue.id, runId: issue.runId, traceId: issue.sourceStepId ? `legacy_trace_${issue.runId}_${issue.sourceStepId}` : null, title: issue.title, description: issue.description, severity: issue.severity, reproduction: issue.reproduction || [], evidenceArtifactIds: issue.evidenceArtifactIds || [], affectedNodeIds: issue.affectedNodeIds || [], status: issue.status === "closed" ? "closed" : issue.status === "fixed" ? "fixed" : "open", createdAt: issue.createdAt || now(), updatedAt: issue.updatedAt || now() });
  for (const item of state.decisions) { delete item.threadId; delete item.sourceStepId; item.status ||= "confirmed"; }
  delete state.issues; delete state.consultationThreads;
  return state;
}

function validateRepositorySources(sources, template) {
  if (!Array.isArray(sources)) throw new Error("仓库来源必须是数组");
  const seen = new Set(), declared = new Set(template.nodes.map((node) => node.repositoryPath).filter(Boolean));
  return sources.map((source) => {
    const path = source?.path, url = source?.url?.trim(), ref = source?.ref?.trim() || "main";
    if (!declared.has(path) || seen.has(path)) throw new Error("仓库来源必须对应唯一的工作流仓库路径");
    if (!url || !/^(https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/|git@[A-Za-z0-9.-]+:)[A-Za-z0-9._/-]+$/.test(url) || url.includes("..") || url.endsWith("/")) throw new Error("仓库来源仅支持无凭据 HTTPS 或 git SSH 地址");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes("..")) throw new Error("仓库基线分支或提交无效");
    seen.add(path); return { path, url, ref };
  });
}

function employeeRepository(kind, value) {
  if (!["business", "manager", "developer"].includes(kind)) throw new Error("数字员工类型无效");
  if (kind !== "developer") return null;
  const source = validateRepositorySources([{ ...value, path: "repos/repository" }], { nodes: [{ repositoryPath: "repos/repository" }] })[0];
  if (/\/\/|\/$|\.$|\.lock$/.test(source.ref)) throw new Error("仓库基线分支或提交无效");
  return { url: source.url, ref: source.ref };
}

function employeeRepositories(members) {
  const bindings = {}, sources = [], urls = new Map(), paths = new Map();
  for (const member of [...members].sort((a, b) => a.id.localeCompare(b.id))) {
    if (member.kind !== "developer") continue;
    const repository = employeeRepository(member.kind, member.repository);
    const previous = urls.get(repository.url);
    if (previous && previous.ref !== repository.ref) throw new Error("同一团队仓库不能使用不同基线");
    let source = previous;
    if (!source) {
      const basename = repository.url.split(/[/:]/).pop().replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-");
      let path = `repos/${basename && ![".", ".."].includes(basename) ? basename : "repository"}`;
      if (paths.has(path)) path += `-${createHash("sha256").update(repository.url).digest("hex").slice(0, 12)}`;
      source = { ...repository, path }; paths.set(path, repository.url); urls.set(repository.url, source); sources.push(source);
    }
    bindings[member.id] = { ...source };
  }
  return { repositoryBindings: bindings, repositorySources: sources };
}

// Effort vocabularies come from the real CLIs (claude --help effort levels;
// codex debug models supported_reasoning_levels, codex-cli 0.160.0). Codex does
// not locally reject unknown effort values, so the platform must reject values
// outside the known vocabulary instead of inventing per-model tables here.
const EFFORT_LEVELS = { "claude-code": ["low", "medium", "high", "xhigh", "max"], codex: ["low", "medium", "high", "xhigh", "max", "ultra"] };
function effortLevel(provider, value) {
  const item = value ?? "";
  if (typeof item !== "string" || item.length > 64 || /[\0\r\n]/.test(item)) throw new Error("Runtime 配置必须为单行文本");
  const trimmed = item.trim();
  if (trimmed && !EFFORT_LEVELS[provider].includes(trimmed)) throw new Error(`思考等级必须是 ${EFFORT_LEVELS[provider].join(" / ")} 之一或留空`);
  return trimmed;
}
function runtimeConnection(value = {}) {
  const provider = value.provider || "claude-code";
  if (!["claude-code", "codex"].includes(provider)) throw new Error("运行时必须选择 Claude Code 或 Codex");
  const result = { provider };
  for (const key of ["model", "executable", "profile"]) {
    const item = value[key] ?? "";
    if (typeof item !== "string" || item.length > 4096 || /[\0\r\n]/.test(item)) throw new Error("Runtime 配置必须为单行文本");
    result[key] = item.trim() || (key === "executable" ? null : "");
  }
  result.effort = effortLevel(provider, value.effort);
  return result;
}

export function createStore({ databasePath = process.env.AGENTFORGE_DB_PATH || ":memory:", workspaceRoot = null, onSaveDiagnostic } = {}) {
  if (workspaceRoot !== null && (!isAbsolute(workspaceRoot) || resolve(workspaceRoot) === "/")) throw new Error("系统工作根目录必须是非根绝对目录");
  const persistence = createSqlitePersistence(databasePath, { onSaveDiagnostic }), loaded = persistence.load(); const state = migrate(loaded) || { agents: clone(agents), teams: [], tasks: [], workflowTemplates: [workflow(exampleWorkflow, { templateId: exampleWorkflow.id, current: true })], runs: [], traces: [], artifacts: [], messages: [], decisions: [], defects: [], roles: [], events: [{ id: "evt_welcome", type: "workspace.ready", runId: null, timestamp: now(), actor: { type: "system", name: "AgentForge" }, message: "工作区已就绪。", data: {} }] };
  state.roles ||= [];
  // A role is a shared plain-text system prompt; employees bind at most one via
  // roleId. Snapshots freeze the resolved text under `roleSnapshot` — never the
  // retired legacy `role` property, which startup migration deletes from agents.
  const roleSnapshotOf = (roleId) => { const role = roleId ? state.roles.find((item) => item.id === roleId) : null; return role ? { id: role.id, name: role.name, prompt: role.prompt } : null; };
  const withRoleSnapshot = (snapshot) => !snapshot || snapshot.roleSnapshot !== undefined ? snapshot : { ...snapshot, roleSnapshot: roleSnapshotOf(snapshot.roleId) };
  const assertRoleBinding = (roleId) => { if (roleId === null || roleId === undefined) return null; if (typeof roleId !== "string" || !state.roles.some((item) => item.id === roleId)) throw new Error("绑定的角色不存在，请先在角色管理中创建"); return roleId; };
  state.dispatches ||= [];
  state.extensionRemovals ||= [];
  state.settings ||= {};
  state.settings.installationId ||= randomUUID();
  const initializeRuntimeCatalog = !Array.isArray(state.settings.runtimeProfiles);
  state.settings.runtimeProfiles ||= [];
  const profiles = () => state.settings.runtimeProfiles;
  const matchingProfile = (connection) => profiles().find(item => JSON.stringify(runtimeConnection(item)) === JSON.stringify(connection));
  const ensureProfile = (connection) => {
    let item = matchingProfile(connection);
    if (!item) {
      const base = `${connection.provider === "codex" ? "Codex" : "Claude Code"}${connection.model ? ` · ${connection.model.slice(0, 80)}` : " · 默认"}`;
      let name = base, suffix = 1;
      while (profiles().some(profile => profile.name === name)) name = `${base} · ${++suffix}`;
      item = { id: id("runtime"), name, ...connection }; profiles().push(item);
    }
    return item;
  };
  const resolveAgentRuntime = (value = {}) => {
    if (!value.profileId) return runtime(value);
    const profile = profiles().find(item => item.id === value.profileId);
    if (!profile) throw new Error("Runtime 配置不存在，请重新选择");
    return { ...runtime({ ...value, ...runtimeConnection(profile) }), profileId: profile.id };
  };
  const bindRuntime = (value = {}) => {
    const resolved = resolveAgentRuntime(value);
    for (const entry of state.extensionRemovals) {
      const selected = resolved.extensionSelection?.[entry.kind === "plugin" ? "pluginIds" : "mcpIds"] || [];
      if (selected.includes(entry.id)) throw new Error(`「${entry.name}」已删除，请重新选择已安装的插件或 MCP`);
    }
    return { ...resolved, profileId: resolved.profileId || ensureProfile(runtimeConnection(resolved)).id };
  };
  if (initializeRuntimeCatalog) for (const provider of ["claude-code", "codex"]) ensureProfile(runtimeConnection({ provider }));
  for (const employee of state.agents) employee.runtime = bindRuntime(employee.runtime);
  for (const employee of state.agents) { employee.kind ||= employee.system ? "manager" : "business"; employee.systemPrompt ??= employee.description || ""; employee.roleId ??= null; }
  for (const team of state.teams) team.managerAgentId ||= state.agents.find(item => item.kind === "manager" && item.status === "active")?.id;
  for (const current of state.runs) {
    const task = state.tasks.find((item) => item.id === current.taskId), team = state.teams.find((item) => item.id === task?.teamId);
    current.manager ||= clone(state.agents.find((item) => item.id === managerId));
    current.participants ||= [...(team?.memberAgentIds || [...new Set(Object.values(task?.nodeAssignments || {}))]).map((memberId) => state.agents.find((item) => item.id === memberId)).filter(Boolean).map((item) => ({ ...withRoleSnapshot(clone(item)), type: "agent" })), { ...clone(current.manager), type: "agent", kind: "manager" }, clone(humanMember)];
    current.failure ??= null;
  }
  persistence.save(state);
  let transactionDepth = 0;
  const pendingEvents = [];
  const listeners = new Set(), save = () => { if (!transactionDepth) persistence.save(state); }, find = (collection, value) => collection.find((item) => item.id === value), getAgent = (value) => find(state.agents, value), getTeam = (value) => find(state.teams, value), getTask = (value) => find(state.tasks, value), getRun = (value) => find(state.runs, value), getTrace = (value) => find(state.traces, value), getRole = (value) => find(state.roles, value);
  const runAgent = (current, agentId) => current?.participants?.find((item) => item.type === "agent" && item.id === agentId) || (current?.manager?.id === agentId ? current.manager : null);
  const addEvent = ({ type, runId = null, actor = { type: "system", name: "AgentForge" }, message, data = {} }) => { const item = { id: id("evt"), type, runId, timestamp: now(), actor: clone(actor), message: text(message, "事件说明"), data: clone(data) }; state.events.push(item); save(); if (transactionDepth) pendingEvents.push(item); else listeners.forEach((listener) => listener(clone(item))); return item; };
  const definition = (current, nodeId) => getTask(current.taskId)?.workflowSnapshot?.nodes.find((item) => item.id === nodeId); const assertNode = (current, nodeId) => { if (!definition(current, nodeId)) throw new Error("工作流节点不存在"); };
  function assignments(currentTeam, template, input = {}) { const result = {}; for (const item of template.nodes) { const agentId = input[item.id] || (item.reuseOwnerFrom && result[item.reuseOwnerFrom]); if (!agentId || !currentTeam.memberAgentIds.includes(agentId) || getAgent(agentId)?.status !== "active") throw new Error(`节点「${item.title}」必须显式分配给一位可用团队成员`); result[item.id] = agentId; } const repositories = new Map(); for (const item of template.nodes.filter((node) => node.repositoryPath)) { const owner = result[item.id]; if (repositories.has(owner) && repositories.get(owner) !== item.repositoryPath) throw new Error("一个成员只能处理一个 Git 仓库"); repositories.set(owner, item.repositoryPath); } return result; }
  function validateTeam(input) {
    const supplied = [...new Set(input.memberAgentIds || [])];
    const managers = supplied.filter((value) => getAgent(value)?.kind === "manager");
    if (managers.length > 1 || (managers.length && input.managerAgentId && input.managerAgentId !== managers[0])) throw new Error("团队只能有一名负责项目经理");
    const memberAgentIds = supplied.filter((value) => !managers.includes(value)), selectedManager = managers[0] || input.managerAgentId || state.agents.find(item => item.kind === "manager" && item.status === "active")?.id;
    if (!memberAgentIds.length || memberAgentIds.some((value) => !getAgent(value) || getAgent(value).kind === "manager") || !memberAgentIds.some((value) => getAgent(value).status === "active")) throw new Error("团队至少需要一名可用业务数字员工");
    if (getAgent(selectedManager)?.kind !== "manager" || getAgent(selectedManager)?.status !== "active") throw new Error("请选择可用的项目经理");
    return { memberAgentIds, managerAgentId: selectedManager };
  }
  function failedBusinessTraces(runId) {
    return state.traces.filter((trace) => trace.runId === runId && trace.status === "failed" && ["node", "instruction", "consultation"].includes(trace.type));
  }
  function taskDeletionBlock(taskId) {
    const relatedRuns = state.runs.filter((run) => run.taskId === taskId);
    if (relatedRuns.some((run) => ["planning", "running", "awaiting_human", "review", "awaiting_acceptance", "paused"].includes(run.status) || state.traces.some((trace) => trace.runId === run.id && trace.status === "running"))) return "active_run";
    const runIds = new Set(relatedRuns.map((run) => run.id));
    return state.dispatches.some((item) => runIds.has(item.runId) && item.interactionOnly && !["done", "cancelled"].includes(item.status)) ? "active_inquiries" : null;
  }
  function taskDeletionError(blockedBy) {
    return blockedBy === "active_inquiries"
      ? "存在未结束答疑，不能删除 Task；请先停止答疑或等待答复完成"
      : "存在活跃或暂停的 Run，不能删除 Task";
  }
  function resumeFailedRun(current, task, nodeId, dedupeKey, event, enqueue) {
    if (state.traces.some((trace) => trace.runId === current.id && trace.status === "running") || state.dispatches.some((item) => item.runId === current.id && item.status === "claimed")) throw new Error("仍有活跃执行，不能重新启动失败 Run");
    const cancelledDispatchIds = [];
    for (const item of state.dispatches.filter((item) => item.runId === current.id && !["done", "cancelled"].includes(item.status))) {
      item.status = "cancelled"; item.nextRetryAt = null; item.updatedAt = now(); cancelledDispatchIds.push(item.id);
    }
    current.completedAt = null; current.failure = null; current.status = "running";
    current.waitingConversationId = null; current.waitingNodeId = null; current.waitingAgentId = null;
    task.status = "running"; task.updatedAt = now();
    const dispatch = enqueue(current.id, { recipientAgentId: current.manager.id, workflowNodeId: nodeId, purpose: "manager", messageIds: current.pendingMessageIds || [], dedupeKey });
    addEvent({ ...event, runId: current.id, actor: humanMember, data: { ...event.data, dispatchId: dispatch.id, cancelledDispatchIds } });
    return clone(current);
  }
  return {
    ...communicationCommands(state, save),
    ...historyCommands(state, { databasePath }),
    close() { this.closeHistory(); listeners.clear(); persistence.close(); },
    prepareDataReset() {
      if (state.runs.some(run => ["planning", "running", "review"].includes(run.status)) || state.traces.some(trace => trace.status === "running") || state.dispatches.some(delivery => delivery.status === "claimed") || state.communicationDeliveries.some(delivery => ["claimed", "running"].includes(delivery.status))) throw new Error("请先停止正在执行的任务和沟通，再清除数据");
      return state.runs.filter(run => getTask(run.taskId)?.workspaceManaged).map(run => ({ taskId: run.taskId, runId: run.id, path: resolve(run.workspacePath) }));
    },
    getNavigationNotifications() {
      const attention = new Set(["awaiting_human", "awaiting_acceptance", "paused", "blocked", "failed"]);
      return { taskAttentionCount: new Set(state.runs.filter(run => !getTask(run.taskId)?.archivedAt && attention.has(run.status)).map(run => run.taskId)).size, communicationUnreadCount: this.listCommunications().reduce((sum, item) => sum + item.unreadCount, 0) };
    },
    getBootstrap() {
      const tasks = state.tasks.map((task) => ({ id: task.id, title: task.title, objective: task.objective.slice(0, 240), status: task.status, workspaceKind: task.workspaceManaged ? "managed" : "legacy", teamId: task.teamId, team: { name: getTeam(task.teamId)?.name || "" }, workflowTemplateId: task.workflowTemplateId, workflowSnapshot: { name: task.workflowSnapshot.name }, archivedAt: task.archivedAt, deletionBlockedBy: taskDeletionBlock(task.id), createdAt: task.createdAt, updatedAt: task.updatedAt }));
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      const counts = new Map(state.runs.map((run) => [run.id, { traceCount: 0, artifactCount: 0 }]));
      for (const trace of state.traces) if (counts.has(trace.runId)) counts.get(trace.runId).traceCount++;
      for (const artifact of state.artifacts) if (counts.has(artifact.runId)) counts.get(artifact.runId).artifactCount++;
      return { installationId: state.settings.installationId, communicationUnreadCount: this.listCommunications().reduce((sum, item) => sum + item.unreadCount, 0), tasks: clone(tasks), runs: state.runs.map((run) => ({ id: run.id, taskId: run.taskId, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, task: clone(taskById.get(run.taskId)), ...counts.get(run.id) })), agents: this.listAgents(), roles: this.listRoles(), teams: this.listTeams(), workflowTemplates: this.listWorkflowTemplates(), events: state.events.slice(-6).map((event) => ({ id: event.id, type: event.type, runId: event.runId, actor: clone(event.actor), timestamp: event.timestamp, message: event.message.slice(0, 240), data: {} })) };
    },
    getConsoleContentReference(runId, eventId) {
      const event = state.events.find(item => item.id === eventId && item.runId === runId && item.type === "runtime.event" && item.data?.auditVersion === 2);
      const trace = event && getTrace(event.data.traceId);
      const reference = event?.data?.contentRef;
      if (!getRun(runId) || !trace || trace.runId !== runId || trace.agentId !== event.actor?.id || !reference) throw new Error("执行内容不存在或当时未保存");
      const prefix = `runs/${runId}/traces/${trace.id}/`;
      if (!reference.storagePath?.startsWith(prefix) || !/^content-[0-9a-f-]{36}\.json$/.test(reference.storagePath.slice(prefix.length)) || !/^[0-9a-f]{64}$/.test(reference.sha256) || !Number.isInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > 300000) throw new Error("执行内容关联无效");
      return clone(reference);
    },
    getConsoleEvents(runId, { agentId, traceId = null, before = null, limit = 200 } = {}) {
      const current = getRun(runId);
      if (!current || !runAgent(current, agentId)) throw new Error("Run 成员不存在");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("日志页大小必须在 1 至 500 之间");
      if (traceId && !state.traces.some((trace) => trace.id === traceId && trace.runId === runId && trace.agentId === agentId)) throw new Error("Trace 不属于当前成员");
      const events = state.events.filter((event) => event.runId === runId && event.actor?.id === agentId && (!traceId || event.data?.traceId === traceId));
      const end = before ? events.findIndex((event) => event.id === before) : events.length;
      if (end < 0) throw new Error("日志游标无效，请刷新日志");
      const start = Math.max(0, end - limit), page = events.slice(start, end);
      return { events: page.map(consoleAuditProjection), total: events.length, hasMore: start > 0, nextBefore: page[0]?.id || null };
    },
    transaction(command) {
      if (transactionDepth) return command();
      const before = clone(state); transactionDepth = 1;
      let result;
      try { result = command(); if (result?.then) throw new Error("Store 事务必须同步"); persistence.save(state); }
      catch (error) { for (const key of Object.keys(state)) delete state[key]; Object.assign(state, before); pendingEvents.length = 0; throw error; }
      finally { transactionDepth = 0; }
      const events = pendingEvents.splice(0); events.forEach((event) => listeners.forEach((listener) => { try { listener(clone(event)); } catch { /* A subscriber cannot roll back committed state. */ } }));
      return result;
    },
    getWorkspaceSettings() { return { workspaceRoot: state.settings?.workspaceRoot || workspaceRoot, source: state.settings?.workspaceRoot ? "saved" : "startup" }; },
    listRuntimeProfiles() { return clone(profiles().map(item => ({ ...item, system: false, employeeCount: state.agents.filter(agent => agent.runtime.profileId === item.id).length }))); },
    resolveAgentRuntime(value) { return clone(resolveAgentRuntime(value)); },
    deleteRuntimeProfile(profileId) {
      const current = profiles().find(item => item.id === profileId);
      if (!current) throw new Error("Runtime 配置不存在");
      if (state.agents.some(agent => agent.runtime.profileId === profileId)) throw new Error("Runtime 仍被数字员工使用，请先为员工切换配置（含停用员工）");
      return this.transaction(() => {
        state.settings.runtimeProfiles = profiles().filter(item => item.id !== profileId);
        addEvent({ type: "settings.runtime_deleted", actor: humanMember, message: "人类删除了未使用的 Runtime 配置", data: { profileId } });
        return clone(current);
      });
    },
    saveRuntimeProfile(input, profileId = null) {
      if (!input || typeof input !== "object" || Object.keys(input).some(key => !["name", "provider", "model", "executable", "profile", "effort"].includes(key))) throw new Error("Runtime 配置字段无效；认证沿用本机 CLI");
      const name = text(input.name, "Runtime 名称");
      if (name.length > 120) throw new Error("Runtime 名称最多 120 字符");
      if (profiles().some(item => item.name === name && item.id !== profileId)) throw new Error("Runtime 名称已存在，请使用不同名称");
      const connection = runtimeConnection(input);
      const previous = profileId && profiles().find(item => item.id === profileId);
      if (profileId && !previous) throw new Error("Runtime 配置不存在");
      if (previous && previous.provider !== connection.provider) throw new Error("不能修改已有配置的 Provider，请新建配置");
      return this.transaction(() => {
        const item = { id: profileId || id("runtime"), name, ...connection };
        if (previous) Object.assign(previous, item); else profiles().push(item);
        for (const employee of state.agents.filter(agent => agent.runtime.profileId === item.id)) employee.runtime = resolveAgentRuntime(employee.runtime);
        addEvent({ type: "settings.runtime_updated", actor: humanMember, message: "人类更新了本机 Runtime 配置", data: { profileId: item.id } });
        return clone(item);
      });
    },
    updateWorkspaceSettings(input) {
      const path = input?.workspaceRoot;
      if (typeof path !== "string" || !isAbsolute(path) || resolve(path) === "/" || path.includes("\0") || path.length > 4096) throw new Error("系统工作根目录必须是非根绝对目录");
      return this.transaction(() => {
        state.settings = { ...state.settings, workspaceRoot: resolve(path) };
        addEvent({ type: "settings.workspace_updated", actor: humanMember, message: "人类更新了新任务的默认工作目录", data: {} });
        return this.getWorkspaceSettings();
      });
    },
    listDispatches(runId) { return clone(state.dispatches.filter((item) => item.runId === runId)); },
    memberResponsibility(runId, agentId) {
      const item = state.dispatches.findLast(item => item.runId === runId && item.recipientAgentId === agentId && ["node", "instruction"].includes(item.purpose));
      return item?.workflowNodeId || null;
    },
    prepareMemberSession(dispatchId, traceId, cwd) {
      const delivery = this.getDispatch(dispatchId), current = getRun(delivery.runId), trace = getTrace(traceId);
      if (delivery.status !== "claimed" || trace?.dispatchId !== dispatchId || trace.status !== "running" || !isAbsolute(cwd)) throw new Error("会话必须绑定已领取的成员执行");
      current.memberSessions ||= {};
      let session = current.memberSessions[delivery.recipientAgentId];
      const isCodex = runAgent(current, trace.agentId).runtime.provider === "codex";
      const resume = Boolean(session?.sessionId && (!isCodex || session.nativeConfirmed));
      if (session && session.cwd !== cwd) throw new Error("同一成员会话的工作目录不能改变");
      if (!session?.sessionId) {
        session = { ...session, sessionId: randomUUID(), cwd, createdAt: now(), lastTraceId: traceId };
        current.memberSessions[delivery.recipientAgentId] = session;
      }
      session.lastTraceId = traceId;
      trace.providerSessionId = isCodex && !session.nativeConfirmed ? null : session.sessionId; trace.sessionMode = resume ? "resume" : "new";
      addEvent({ type: resume ? "session.resumed" : "session.created", runId: current.id, actor: { type: "agent", id: trace.agentId, name: runAgent(current, trace.agentId).name }, message: resume ? "续接该成员的既有会话。" : "为该成员建立独立会话。", data: { traceId, dispatchId, sessionId: session.sessionId } });
      save(); return { ...clone(session), resume };
    },
    bindProviderSession(traceId, providerSessionId) {
      const trace = getTrace(traceId), current = getRun(trace?.runId), session = current?.memberSessions?.[trace?.agentId];
      if (!session || session.lastTraceId !== traceId || trace.status !== "running" || runAgent(current, trace.agentId).runtime.provider !== "codex" || !/^[a-zA-Z0-9-]{16,80}$/.test(providerSessionId)) throw new Error("Provider 会话绑定无效");
      if (session.nativeConfirmed && session.sessionId !== providerSessionId) throw new Error("Provider 会话与成员绑定不一致");
      session.sessionId = providerSessionId; session.nativeConfirmed = true; trace.providerSessionId = providerSessionId;
      save();
    },
    memberInputMessages(dispatchId) {
      const delivery = this.getDispatch(dispatchId), current = getRun(delivery.runId);
      const messages = state.messages.filter(item => item.runId === current.id);
      const through = current.memberSessions?.[delivery.recipientAgentId]?.inputThroughMessageId;
      const received = new Set(current.memberSessions?.[delivery.recipientAgentId]?.inputMessageIds || []);
      const previous = through ? messages.findIndex(item => item.id === through) : -1;
      return clone(messages.filter((item, index) => !received.has(item.id) && item.sender.id !== delivery.recipientAgentId &&
        (delivery.messageIds.includes(item.id) || index > previous &&
          (delivery.recipientAgentId === current.manager.id || item.recipient.id === delivery.recipientAgentId || item.recipient.type === "team"))));
    },
    confirmMemberInput(traceId, messageId, inputContext, messageIds) {
      const trace = getTrace(traceId), current = getRun(trace?.runId), session = current?.memberSessions?.[trace?.agentId];
      if (!session || session.lastTraceId !== traceId) throw new Error("不能确认其他成员会话的输入");
      if (messageId && !state.messages.some(item => item.runId === current.id && item.id === messageId)) throw new Error("输入游标不属于 Run");
      const delivered = messageIds || this.memberInputMessages(trace.dispatchId).map(item => item.id);
      if (delivered.some(id => !state.messages.some(item => item.runId === current.id && item.id === id))) throw new Error('输入消息不属于 Run');
      session.inputMessageIds = [...new Set([...(session.inputMessageIds || []), ...delivered])];
      session.inputThroughMessageId = messageId;
      if (inputContext) session.inputContext = clone(inputContext);
      save();
    },
    resetMemberSession(traceId, reason) {
      const trace = getTrace(traceId), current = getRun(trace?.runId), session = current?.memberSessions?.[trace?.agentId];
      if (!session || session.sessionId !== trace.providerSessionId || session.lastTraceId !== traceId) throw new Error("不能重建其他执行的会话");
      const previousSessionId = session.sessionId;
      session.sessionId = null; session.nativeConfirmed = false;
      delete session.inputContext;
      addEvent({ type: "session.reset", runId: current.id, actor: { type: "agent", id: trace.agentId, name: runAgent(current, trace.agentId).name }, message: "原生会话不可用，下次创建新会话；已确认的平台消息不重放，需要过去资料时查询历史工具。", data: { traceId, sessionId: previousSessionId, reason } });
      save();
    },
    initializeDispatches(runId) {
      return this.transaction(() => {
        const current = getRun(runId), task = getTask(current.taskId);
        if (state.dispatches.some((item) => item.runId === runId) || ["completed", "cancelled", "failed", "awaiting_acceptance"].includes(current.status)) return;
        const nodeId = current.waitingNodeId || task.workflowSnapshot.nodes[0].id;
        const question = state.messages.filter((item) => item.runId === runId && item.conversationId === current.waitingConversationId && ["agent_consultation", "clarification_question"].includes(item.kind)).at(-1);
        if (question) {
          const parent = this.enqueueDispatch(runId, { recipientAgentId: question.sender.id, workflowNodeId: nodeId, purpose: question.sender.id === current.manager.id ? "manager" : "node", messageIds: [question.id], dedupeKey: "legacy-wait:" + question.id });
          const record = find(state.dispatches, parent.id); record.status = "waiting"; record.waitingMessageId = question.id;
          if (question.recipient.type === "agent") this.enqueueDispatch(runId, { recipientAgentId: question.recipient.id, workflowNodeId: task.workflowSnapshot.nodes.find((node) => task.nodeAssignments[node.id] === question.recipient.id)?.id || nodeId, purpose: "consultation", messageIds: [question.id], parentDispatchId: parent.id, dedupeKey: "question:" + question.id });
        } else this.enqueueDispatch(runId, { recipientAgentId: current.manager.id, workflowNodeId: nodeId, purpose: "manager", messageIds: current.pendingMessageIds || [], dedupeKey: "initial-manager" });
        this.syncWaiting(runId);
      });
    },
    getDispatch(dispatchId) { const item = find(state.dispatches, dispatchId); if (!item) throw new Error("Dispatch 不存在"); return clone(item); },
    enqueueDispatch(runId, input) {
      const current = getRun(runId);
      if (input.parentDispatchId && find(state.dispatches, input.parentDispatchId)?.runId !== runId) throw new Error("父投递不属于当前 Run");
      const interactionOnly = input.purpose === "inquiry" || Boolean(input.parentDispatchId && find(state.dispatches, input.parentDispatchId)?.interactionOnly);
      if (!current || getTask(current.taskId).archivedAt || (["completed", "cancelled", "failed"].includes(current.status) && !interactionOnly)) throw new Error("Run 不接受新投递");
      if (!runAgent(current, input.recipientAgentId)) throw new Error("投递收件人必须是 Run 数字员工");
      assertNode(current, input.workflowNodeId);
      if (!["manager", "node", "consultation", "instruction", "delivery_review", "inquiry"].includes(input.purpose)) throw new Error("投递用途无效");
      const existing = input.dedupeKey && state.dispatches.find((item) => item.runId === runId && item.dedupeKey === input.dedupeKey);
      if (existing) return clone(existing);
      const messageIds = [...new Set(input.messageIds || [])];
      if (messageIds.some((value) => find(state.messages, value)?.runId !== runId)) throw new Error("投递消息不属于 Run");
      const item = { id: id("dispatch"), runId, recipientAgentId: input.recipientAgentId, workflowNodeId: input.workflowNodeId, purpose: input.purpose, interactionOnly, messageIds, parentDispatchId: input.parentDispatchId || null, waitingMessageId: null, status: "queued", attempts: 0, nextRetryAt: null, traceIds: [], dedupeKey: input.dedupeKey || null, ...(input.coordinationFollowup ? { coordinationFollowup: true } : {}), ...(input.deferredRevisit ? { deferredRevisit: true } : {}), createdAt: now(), updatedAt: now() };
      state.dispatches.push(item); save(); return clone(item);
    },
    hasPendingHumanQuestion(runId) { return this.pendingQuestions(runId).some((item) => item.recipient.type === "human"); },
    canExecuteDispatch(dispatchId) {
      const item = find(state.dispatches, dispatchId), current = getRun(item?.runId);
      return Boolean(current && !this.hasPendingHumanQuestion(current.id) && !getTask(current.taskId).archivedAt && item.status === "claimed" && (["running", "review"].includes(current.status) || item.interactionOnly));
    },
    cancelInquiries(runId) {
      if (!getRun(runId)) throw new Error("Run 不存在");
      for (const item of state.dispatches.filter((item) => item.runId === runId && item.interactionOnly && !["done", "cancelled"].includes(item.status))) { item.status = "cancelled"; item.nextRetryAt = null; item.updatedAt = now(); }
      this.syncWaiting(runId);
      addEvent({ type: "run.inquiries_cancelled", runId, actor: humanMember, message: "人类已停止本轮答疑；原任务状态不变。", data: {} }); save();
    },
    claimDispatch(runId) {
      const current = getRun(runId);
      if (!current || getTask(current.taskId).archivedAt || state.dispatches.some((item) => item.runId === runId && item.status === "claimed")) return null;
      if (this.hasPendingHumanQuestion(runId)) return null;
      const item = state.dispatches.find((item) => item.runId === runId && item.status === "queued" && (["planning", "running", "review"].includes(current.status) || item.interactionOnly) && (!item.nextRetryAt || Date.parse(item.nextRetryAt) <= Date.now()));
      if (!item) return null;
      item.status = "claimed"; item.attempts += 1; item.updatedAt = now(); save(); return clone(item);
    },
    attachDispatchTrace(dispatchId, traceId) {
      const item = find(state.dispatches, dispatchId), trace = getTrace(traceId);
      if (!item || item.status !== "claimed" || trace?.runId !== item.runId || trace.agentId !== item.recipientAgentId) throw new Error("投递与 Trace 不匹配");
      item.traceIds.push(traceId); trace.dispatchId = dispatchId; save();
    },
    retryDispatch(dispatchId, error, delayMs = 300000, failure = null) {
      const item = find(state.dispatches, dispatchId);
      if (!item || item.status !== "claimed") return;
      item.status = "queued"; item.lastError = String(error); item.nextRetryAt = new Date(Date.now() + delayMs).toISOString(); item.updatedAt = now();
      if (failure) { item.lastErrorKind = failure.kind; item.lastErrorSignature = failure.signature; item.errorStreak = failure.streak || 1; }
      addEvent({ type: "dispatch.retry_scheduled", runId: item.runId, message: "调用未完成，投递已保留并安排重试。", data: { dispatchId, nextRetryAt: item.nextRetryAt, error: item.lastError, ...(failure ? { failureKind: failure.kind, errorStreak: item.errorStreak } : {}) } }); save();
      return clone(item);
    },
    stopFailedDispatch(dispatchId, error, failure) {
      return this.transaction(() => {
        const item = find(state.dispatches, dispatchId), current = item && getRun(item.runId);
        if (!item || item.status !== 'claimed') throw new Error('投递未领取，不能停止失败重试');
        item.status = 'cancelled'; item.nextRetryAt = null; item.updatedAt = now(); item.lastError = String(error);
        item.lastErrorKind = failure?.kind; item.lastErrorSignature = failure?.signature; item.errorStreak = failure?.streak || 1;
        addEvent({ type: 'dispatch.retry_stopped', runId: item.runId, message: '自动重试已停止；请先排查原始错误，再由人类明确恢复。', data: { dispatchId, error: item.lastError, attempts: item.attempts, failureKind: failure?.kind } });
        if (!item.interactionOnly && ['planning', 'running', 'review'].includes(current.status)) this.failRun(item.runId, item.lastError, 'runtime');
        return clone(item);
      });
    },
    escalateFailedDispatch(dispatchId, { error, kind, signature, streak } = {}) {
      return this.transaction(() => {
        const item = find(state.dispatches, dispatchId), current = item && getRun(item.runId);
        if (!item || item.status !== "claimed" || !current) throw new Error("投递未领取，不能升级");
        if (!["node", "instruction"].includes(item.purpose)) throw new Error("只有业务投递可以升级经理处置");
        const kindLabel = kind === "workspace_artifact" ? "工作区/Artifact 校验" : "协议/结果校验";
        item.status = "cancelled"; item.nextRetryAt = null;
        item.lastError = String(error); item.lastErrorKind = kind; item.lastErrorSignature = signature; item.errorStreak = streak || 1;
        item.escalatedAt = now(); item.updatedAt = now();
        const note = this.addMessage({ runId: item.runId, workflowNodeId: item.workflowNodeId, sender: { type: "system", id: "agentforge", name: "AgentForge" }, recipientAgentId: current.manager.id, kind: "escalation", content: `自动升级：投递 ${dispatchId}（职责 ${item.workflowNodeId} → 成员 ${item.recipientAgentId}）连续两次遭确定性拒收，最近一次是${kindLabel}错误；自动重试已停止，原投递作为事实保留为已终止。失败摘要：${item.lastError}。请先安排团队成员做具体修复（例如由责任成员清理其引入的受限文件/符号链接、修正交付路径或结果格式），并核对修复后的真实 Artifact；只有确需产品取舍、额外权限或团队无法取得的外部事实时才询问人类。无法修复时在协作记录中明确阻塞原因；失败 Trace 与投递历史均未改写。` });
        this.enqueueDispatch(item.runId, { recipientAgentId: current.manager.id, workflowNodeId: item.workflowNodeId, purpose: "manager", messageIds: [note.id], dedupeKey: "escalate:" + dispatchId });
        addEvent({ type: "dispatch.escalated", runId: item.runId, message: `连续两次确定性拒收，最近一次为${kindLabel}错误；已停止重试并升级项目经理处置。`, data: { dispatchId, failureKind: kind, attempts: item.attempts, errorStreak: item.errorStreak, error: item.lastError } });
        return clone(item);
      });
    },
    retryScheduledDispatches(runId) {
      return this.transaction(() => {
        const current = getRun(runId), task = getTask(current?.taskId);
        if (!current || !task || task.archivedAt) throw new Error("Run 不存在或任务已归档");
        const retries = state.dispatches.filter((item) => item.runId === runId && item.status === "queued" && item.nextRetryAt && (["planning", "running", "review"].includes(current.status) || item.interactionOnly));
        if (!retries.length) throw new Error("当前没有等待退避的可重试调用");
        const dispatchIds = retries.map((item) => item.id);
        for (const item of retries) { item.nextRetryAt = null; item.updatedAt = now(); }
        addEvent({ type: "dispatch.retry_requested", runId, actor: humanMember, message: `人类请求立即重试 ${retries.length} 个等待退避的调用；失败 Trace 与原投递已保留。`, data: { dispatchIds } });
        return { run: clone(current), dispatchIds };
      });
    },
    completeDispatch(dispatchId) {
      const item = find(state.dispatches, dispatchId);
      if (!item || item.status !== "claimed") throw new Error("投递未领取，不能确认");
      item.status = "done"; item.updatedAt = now(); item.nextRetryAt = null; save();
    },
    pendingQuestions(runId) {
      const ids = state.dispatches.filter((item) => item.runId === runId && item.status === "waiting").map((item) => item.waitingMessageId);
      return clone(state.messages.filter((item) => ids.includes(item.id)));
    },
    syncWaiting(runId) {
      const current = getRun(runId), task = getTask(current.taskId);
      const question = this.pendingQuestions(runId).find((item) => item.recipient.type === "human") || this.pendingQuestions(runId).at(-1);
      current.waitingNodeId = question?.workflowNodeId || null;
      current.waitingConversationId = question?.conversationId || null;
      current.waitingAgentId = question?.recipient.type === "agent" ? question.recipient.id : null;
      if (!["paused", "cancelled", "completed", "failed", "awaiting_acceptance"].includes(current.status)) {
        if (question?.recipient.type === "human") { current.status = "awaiting_human"; task.status = "awaiting_human"; }
        else if (current.status === "awaiting_human") { current.status = "running"; task.status = "running"; }
      }
      save();
    },
    askQuestion(dispatchId, consultation, traceId) {
      return this.transaction(() => {
        const delivery = find(state.dispatches, dispatchId), current = getRun(delivery?.runId);
        if (!delivery || delivery.status !== "claimed") throw new Error("咨询投递未领取");
        const questionType = consultation.questionType || "协作", routingReason = consultation.routingReason || "员工请求转交";
        const considered = Array.isArray(consultation.consideredMemberIds) ? consultation.consideredMemberIds : [];
        const human = consultation.audience === "human", recipientId = consultation.recipientAgentId;
        if (!human && consultation.audience !== "agent") throw new Error("咨询受众无效");
        if (!human && (!runAgent(current, recipientId) || recipientId === delivery.recipientAgentId)) throw new Error("消息需要一个可送达的其他成员");
        // An ancestor is suspended waiting for this very answer; asking it again deadlocks.
        for (let ancestor = delivery; ancestor; ancestor = find(state.dispatches, ancestor.parentDispatchId)) {
          if (!human && ancestor.recipientAgentId === recipientId) throw new Error("咨询形成等待环：请使用已有上下文、咨询其他成员或说明原因后询问人类");
        }
        const sender = runAgent(current, delivery.recipientAgentId);
        const message = this.addMessage({ runId: current.id, workflowNodeId: delivery.workflowNodeId, traceId, conversationId: id("conversation"), sender: { type: "agent", id: sender.id, name: sender.name }, recipientHuman: human, recipientAgentId: human ? null : recipientId, kind: human ? "clarification_question" : "agent_consultation", content: consultation.question, questionType, routingReason, consideredMemberIds: considered });
        delivery.status = "waiting"; delivery.waitingMessageId = message.id; delivery.updatedAt = now(); delivery.messageIds.push(message.id);
        if (!human) {
          this.enqueueDispatch(current.id, { recipientAgentId: recipientId, workflowNodeId: this.memberResponsibility(current.id, recipientId) || delivery.workflowNodeId, purpose: "consultation", messageIds: [message.id], parentDispatchId: delivery.id, dedupeKey: "question:" + message.id });
        }
        this.syncWaiting(current.id); return message;
      });
    },
    answerQuestion(runId, questionId, content, sender, traceId = null) {
      return this.transaction(() => {
        const current = getRun(runId), question = find(state.messages, questionId);
        const waiting = state.dispatches.find((item) => item.runId === runId && item.status === "waiting" && item.waitingMessageId === questionId);
        if (!current || getTask(current.taskId).archivedAt || !waiting || question?.recipient.id !== sender.id || question?.recipient.type !== sender.type) throw new Error("不存在匹配的待回答问题");
        const message = this.addMessage({ runId, workflowNodeId: question.workflowNodeId, conversationId: question.conversationId, replyToMessageId: questionId, traceId, sender, recipientAgentId: question.sender.id, kind: sender.type === "human" ? "clarification_answer" : "consultation_answer", content });
        waiting.status = "queued"; waiting.waitingMessageId = null; waiting.nextRetryAt = null; waiting.messageIds.push(message.id); waiting.updatedAt = now();
        this.syncWaiting(runId); return message;
      });
    },
    submitHumanMessage(runId, input) {
      return this.transaction(() => {
        const current = getRun(runId), task = getTask(current?.taskId);
        if (!current || task.archivedAt) throw new Error("任务已归档，不接受新消息");
        const interactionOnly = ["completed", "cancelled", "failed", "paused"].includes(current.status);
        if (current.status === "awaiting_acceptance" && !input.replyToMessageId) {
          current.status = "running"; current.deliveryReview = null; current.acceptanceRequest = null; task.status = "running"; task.updatedAt = now();
          addEvent({ type: "run.acceptance_reopened", runId, actor: humanMember, message: "人类追加消息，重新进入团队协作并等待新的验收结论。", data: {} });
        }
        if (input.replyToMessageId) return { message: this.answerQuestion(runId, input.replyToMessageId, input.content, { type: "human", id: humanMember.id, name: humanMember.name }), resumed: current.status !== "paused", queued: true };
        const recipientId = input.recipientAgentId;
        if (!recipientId) throw new Error("新消息必须明确指定一位当前 Run 成员；请使用 @ 选择接收人");
        const recipient = runAgent(current, recipientId);
        if (!recipient) throw new Error("消息接收者不属于当前 Run");
        const message = this.addMessage({ runId, recipientAgentId: recipientId, content: input.content, kind: interactionOnly ? "inquiry" : "instruction" });
        const ownNode = this.memberResponsibility(runId, recipientId);
        // Never fabricate a nodes[0] binding. An instruction to a member without
        // an assigned node goes to the manager, who formally dispatches node +
        // member via managerDecision; the original message keeps the @ intent
        // visible in the collaboration record. Read-only inquiries may still be
        // answered directly by the addressed member (no Artifact boundary is
        // opened for inquiry traces regardless of the labelled node).
        if (interactionOnly) {
          this.enqueueDispatch(runId, { recipientAgentId: recipientId, workflowNodeId: ownNode || task.workflowSnapshot.nodes[0].id, purpose: "inquiry", messageIds: [message.id], dedupeKey: "message:" + message.id });
        } else if (recipientId === current.manager.id || !ownNode) {
          this.enqueueDispatch(runId, { recipientAgentId: current.manager.id, workflowNodeId: task.workflowSnapshot.nodes[0].id, purpose: "manager", messageIds: [message.id], dedupeKey: "message:" + message.id });
        } else {
          this.enqueueDispatch(runId, { recipientAgentId: recipientId, workflowNodeId: ownNode, purpose: "instruction", messageIds: [message.id], dedupeKey: "message:" + message.id });
        }
        this.syncWaiting(runId); return { message, queued: true, resumed: false, interactionOnly };
      });
    },
    confirmRunCompletion(runId) {
      return this.transaction(() => {
        const current = getRun(runId), task = getTask(current?.taskId);
        if (!current || task.archivedAt || current.status !== "awaiting_acceptance") throw new Error("请在人类验收阶段确认完成");
        this.settleCoordinationFollowups(runId);
        current.status = "completed"; current.completedAt = now(); current.confirmedAt = current.completedAt; current.confirmedBy = humanMember.id;
        current.summary = "人类已验收并确认任务完成。";
        current.currentFocus = null;
        task.status = "done"; task.updatedAt = now();
        addEvent({ type: "run.completed", runId, actor: humanMember, message: "人类已验收并确认任务完成。", data: { confirmedAt: current.confirmedAt } }); save(); return clone(current);
      });
    },
    recordDeliveryReview(runId, traceId, input) {
      const current = getRun(runId);
      current.deliveryReview = { ...clone(input), traceId };
      save(); return clone(current.deliveryReview);
    },
    // Platform-created coordination follow-ups (deferred-decision revisits,
    // format corrections, delivery notices) exist only to continue coordination.
    // A concluded Run makes them unclaimable forever, so the terminal decision
    // legitimately cancels them with an audit record — never silently.
    settleCoordinationFollowups(runId) {
      const pending = state.dispatches.filter((item) => item.runId === runId && item.coordinationFollowup && !["done", "cancelled"].includes(item.status));
      if (!pending.length) return [];
      for (const item of pending) { item.status = "cancelled"; item.nextRetryAt = null; item.updatedAt = now(); }
      addEvent({ type: "dispatch.coordination_followups_settled", runId, message: "终止安排或人类确认已取代未执行的平台协调复核投递；这些投递已取消并保留记录。", data: { dispatchIds: pending.map((item) => item.id) } });
      save(); return pending.map((item) => item.id);
    },
    requestHumanAcceptance(runId, { traceId = null, summary = "项目经理已提交人类验收。" } = {}) {
      const current = getRun(runId), task = getTask(current.taskId);
      this.settleCoordinationFollowups(runId);
      current.acceptanceRequest = { traceId, summary, requestedAt: now(), managerAgentId: current.manager.id };
      current.status = "awaiting_acceptance"; current.summary = summary;
      task.status = "awaiting_acceptance"; task.updatedAt = now();
      addEvent({ type: "run.awaiting_acceptance", runId, actor: { type: "agent", id: current.manager.id, name: current.manager.name }, message: summary, data: { acceptanceRequest: clone(current.acceptanceRequest) } });
      save(); return clone(current);
    },
    canCompleteRun(runId) { return !state.traces.some((item) => item.runId === runId && item.status === "running") && !state.dispatches.some((item) => item.runId === runId && !["done", "cancelled"].includes(item.status)); },
    assertTaskDeletionAllowed(taskId) { const task = getTask(taskId); if (!task) throw new Error("Task 不存在"); const blockedBy = taskDeletionBlock(taskId); if (blockedBy) throw new Error(taskDeletionError(blockedBy)); return clone(task); },
    deleteTask(taskId) { const task = this.assertTaskDeletionAllowed(taskId); const relatedRuns = state.runs.filter((run) => run.taskId === taskId); const runIds = new Set(relatedRuns.map((run) => run.id)); state.tasks = state.tasks.filter((item) => item.id !== taskId); state.runs = state.runs.filter((item) => !runIds.has(item.id)); state.traces = state.traces.filter((item) => !runIds.has(item.runId)); state.artifacts = state.artifacts.filter((item) => !runIds.has(item.runId)); state.messages = state.messages.filter((item) => !runIds.has(item.runId)); state.dispatches = state.dispatches.filter((item) => !runIds.has(item.runId)); state.decisions = state.decisions.filter((item) => !runIds.has(item.runId)); state.defects = state.defects.filter((item) => !runIds.has(item.runId)); state.events = state.events.filter((item) => !runIds.has(item.runId)); save(); return { task: clone(task), runIds: [...runIds] }; },
    getExecutionLogs: (query) => executionLogs(state, query),
    snapshot: () => clone(state), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, addEvent,
    listAgents: () => clone(state.agents), listTeams: () => clone(state.teams.map((item) => {
      const businessMembers = item.memberAgentIds.map(getAgent).filter(Boolean);
      const activeMembers = businessMembers.filter((agent) => agent.status === "active");
      return { ...item, deliveryRepositories: employeeRepositories(activeMembers).repositorySources, members: [...businessMembers.map((agent) => ({ ...agent, type: "agent" })), { ...getAgent(item.managerAgentId), type: "agent" }, humanMember] };
    })), listTasks: () => clone(state.tasks.map((item) => ({ ...item, team: getTeam(item.teamId) }))), listWorkflowTemplates: () => clone(state.workflowTemplates), timeline: (runId = null) => clone(state.events.filter((item) => !runId || item.runId === runId)),
    listRuns: () => clone(state.runs.map((item) => ({ ...item, task: getTask(item.taskId), traceCount: state.traces.filter((trace) => trace.runId === item.id).length, artifactCount: state.artifacts.filter((artifact) => artifact.runId === item.id).length, openDefectCount: state.defects.filter((defect) => defect.runId === item.id && defect.status !== "closed").length }))),
    getRun(runId) { const item = getRun(runId); if (!item) throw new Error("Run 不存在"); return clone(item); }, getTask(taskId) { const item = getTask(taskId); if (!item) throw new Error("任务不存在"); return clone(item); }, getRunAgent(runId, agentId) { return clone(runAgent(getRun(runId), agentId)); },
    getRunTask(runId) { const current = getRun(runId); if (!current) throw new Error("Run 不存在"); const task = getTask(current.taskId); return clone({ ...task, taskWorkspacePath: task.workspacePath, workspacePath: current.workspacePath || task.workspacePath, deletionBlockedBy: taskDeletionBlock(task.id) }); },
    getRunWorkspace(runId, { summary = false } = {}) { const current = getRun(runId); if (!current) throw new Error("Run 不存在"); const traces = state.traces.filter((item) => item.runId === runId).map((item) => ({ ...item, agent: summary ? { id: item.agentId, name: runAgent(current, item.agentId)?.name } : runAgent(current, item.agentId) })); const artifacts = state.artifacts.filter((item) => item.runId === runId).map((item) => (summary ? { ...item } : { ...item, trace: getTrace(item.traceId), agent: runAgent(current, item.ownerAgentId) })); return clone({ failureEvents: state.events.filter((event) => event.runId === runId && event.type === "trace.failed").slice(-20).map(consoleAuditProjection), pendingQuestions: this.pendingQuestions(runId), dispatches: this.listDispatches(runId), run: { ...current, task: this.getRunTask(runId), artifactCount: artifacts.length }, traces, artifacts, messages: state.messages.filter((item) => item.runId === runId), decisions: state.decisions.filter((item) => item.runId === runId), defects: state.defects.filter((item) => item.runId === runId), events: state.events.filter((item) => item.runId === runId && (!summary || ["dispatch.retry_scheduled", "dispatch.retry_requested", "dispatch.escalated", "session.reset", "run.completed", "run.awaiting_acceptance", "run.acceptance_reopened", "run.recovered", "run.cancelled"].includes(item.type))) }); },
    createWorkflowTemplate(input = {}) { validateWorkflowInput(input); const item = workflow(input, {current: true}); if (state.workflowTemplates.some((candidate) => candidate.name === item.name)) throw new Error("工作流名称必须唯一"); state.workflowTemplates.push(item); save(); return clone(item); },
    updateWorkflowTemplate(templateId, input = {}) { const current = find(state.workflowTemplates, templateId); if (!current) throw new Error("工作流不存在"); validateWorkflowInput(input); Object.assign(current, workflow(input, { templateId, system: current.system, current: true })); save(); return clone(current); },
    deleteWorkflowTemplate(templateId) {
      const current = find(state.workflowTemplates, templateId);
      if (!current) throw new Error("工作流不存在");
      const references = state.tasks.filter(task => task.workflowTemplateId === templateId);
      if (references.length) throw new Error(`工作流仍被 ${references.length} 个 Task 的冻结快照引用，不能删除`);
      return this.transaction(() => {
        state.workflowTemplates = state.workflowTemplates.filter(item => item.id !== templateId);
        addEvent({ type: "configuration.workflow_deleted", actor: humanMember, message: "人类删除了未使用的工作流", data: { workflowTemplateId: templateId } });
        return clone(current);
      });
    },
    createAgent(input = {}) {
      const name = text(input.name, "数字员工名称"), kind = input.kind || "business";
      if (!["business", "manager", "developer"].includes(kind)) throw new Error("数字员工类型无效");
      if (input.status !== undefined && !['active','inactive'].includes(input.status)) throw new Error('数字员工状态无效');
      const item = { ...agent(id("agent"), name, input.description?.trim() || "一个等待被赋予使命的数字员工。", ["violet", "cyan", "amber", "blue", "green"][state.agents.length % 5], input.runtime?.provider || "claude-code", kind), repository: employeeRepository(kind, input.repository), systemPrompt: input.systemPrompt?.trim() || input.description?.trim() || "评估输入并完成可核验交付，信息不足时向合适成员咨询。", capabilities: Array.isArray(input.capabilities) ? input.capabilities : [], roleId: assertRoleBinding(input.roleId), runtime: bindRuntime(input.runtime) };
      item.status=input.status ?? 'active';state.agents.push(item); save(); return clone(item);
    },
    updateAgent(agentId, input = {}) {
      const stored = getAgent(agentId), current = clone(stored);
      if (!current) throw new Error("数字员工不存在");
      if (input.kind && (!["business", "manager", "developer"].includes(input.kind) || state.teams.some(team => (team.managerAgentId === agentId && input.kind !== "manager") || (team.memberAgentIds.includes(agentId) && input.kind === "manager")))) throw new Error("不能改变已被团队使用的经理类型");
      if (input.status !== undefined && !["active", "inactive"].includes(input.status)) throw new Error("数字员工状态无效");
      current.repository = employeeRepository(input.kind || current.kind, input.repository === undefined ? current.repository : input.repository);
      if (input.kind) current.kind = input.kind;
      if (input.systemPrompt !== undefined) current.systemPrompt = String(input.systemPrompt).trim();
      if (input.name) current.name = text(input.name, "数字员工名称");
      if (input.description !== undefined) current.description = input.description;
      if (input.capabilities) current.capabilities = input.capabilities;
      if (input.roleId !== undefined) current.roleId = assertRoleBinding(input.roleId);
      if (input.runtime) current.runtime = bindRuntime(input.runtime);
      if (input.status) current.status = input.status;
      Object.assign(stored, current); save(); return clone(current);
    },
    isExtensionRemoved(kind, extensionId) {
      return state.extensionRemovals.some(item => item.kind === kind && item.id === extensionId);
    },
    getPluginUpdateSettings() {return {enabled:state.settings?.pluginAutoUpdate !== false,intervalMinutes:state.settings?.pluginUpdateIntervalMinutes ?? 2};},
    setPluginUpdateSettings(input) {
      if(!input || typeof input!=='object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key=>!['enabled','intervalMinutes'].includes(key)))throw new Error('仅接受 enabled 与 intervalMinutes，至少提供一项');
      if('enabled' in input && typeof input.enabled!=='boolean')throw new Error('enabled 必须为布尔值');
      if('intervalMinutes' in input && (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes<1 || input.intervalMinutes>1440))throw new Error('检查周期必须为 1–1440 的整数分钟');
      return this.transaction(()=>{
        state.settings ||= {};
        if('enabled' in input)state.settings.pluginAutoUpdate=input.enabled;
        if('intervalMinutes' in input)state.settings.pluginUpdateIntervalMinutes=input.intervalMinutes;
        addEvent({type:'configuration.plugin_auto_update',actor:humanMember,message:'已保存插件更新设置',data:this.getPluginUpdateSettings()});
        return this.getPluginUpdateSettings();
      });
    },
    replacePluginExtensions(replacements,bindings) {
      return this.transaction(()=>{
        const ids=replacements.map(item=>item.previousId);
        if(!ids.length || new Set(ids).size!==ids.length || replacements.some(item=>this.isExtensionRemoved('plugin',item.previousId) || !item.id || item.id===item.previousId))throw new Error('插件配置已变化，请重新检查');
        const users=state.agents.filter(item=>item.runtime?.extensionSelection?.pluginIds?.some(id=>ids.includes(id)));
        if(bindings.length!==users.length || users.some(item=>!bindings.some(binding=>binding.agentId===item.id && JSON.stringify(binding.previousRuntime)===JSON.stringify(item.runtime))))throw new Error('员工配置已变化，本次插件更新未应用');
        for(const binding of bindings)this.updateAgent(binding.agentId,{runtime:binding.runtime});
        const actor={type:'system',id:'plugin-updater',name:'插件更新'};
        for(const item of replacements)this.removeExtension({kind:'plugin',id:item.previousId,name:item.name},actor);
        const employees=users.map(({id,name})=>({id,name}));
        addEvent({type:'configuration.plugins_updated',actor,message:'插件已更新；当前员工使用新版本，冻结历史保持不变',data:{plugins:replacements.map(({id,previousId,name})=>({id,previousId,name})),employees}});
        return {plugins:replacements.map(({id,previousId,name})=>({id,previousId,name})),employees};
      });
    },
    replaceMcpExtension(previousId,replacement,bindings) {
      return this.transaction(()=>{
        if(this.isExtensionRemoved('mcp',previousId) || !replacement?.id || replacement.id===previousId)throw new Error('MCP 已变化，请刷新后重新编辑');
        const users=state.agents.filter(item=>item.runtime?.extensionSelection?.mcpIds?.includes(previousId));
        if(bindings.length!==users.length || users.some(item=>!bindings.some(binding=>binding.agentId===item.id && JSON.stringify(binding.previousRuntime)===JSON.stringify(item.runtime))))throw new Error('员工配置已变化，请刷新后重新编辑 MCP');
        for(const binding of bindings)this.updateAgent(binding.agentId,{runtime:binding.runtime});
        this.removeExtension({kind:'mcp',id:previousId,name:replacement.name});
        const employees=users.map(({id,name})=>({id,name}));
        addEvent({type:'configuration.mcp_updated',actor:humanMember,message:'人类编辑了 MCP；当前员工使用新版本，冻结历史保持不变',data:{previousId,id:replacement.id,name:replacement.name,employees}});
        return {...replacement,previousId,employees,historyRetained:true};
      });
    },
    removeExtension({ kind, id: extensionId, name }, actor=humanMember) {
      if (!["plugin", "mcp"].includes(kind) || typeof extensionId !== "string" || !extensionId) throw new Error("扩展标识无效");
      if (this.isExtensionRemoved(kind, extensionId)) throw new Error("此插件或 MCP 已删除");
      const key = kind === "plugin" ? "pluginIds" : "mcpIds";
      const users = state.agents.filter(item => item.runtime?.extensionSelection?.[key]?.includes(extensionId));
      if (users.length) throw new Error(`仍被数字员工「${users.map(item => item.name).join("、")}」使用，请先在员工中移除选择后再删除`);
      const entry = { kind, id: extensionId, name: text(name, "扩展名称"), removedAt: now() };
      return this.transaction(() => {
        state.extensionRemovals.push(entry);
        addEvent({ type: "configuration.extension_deleted", actor, message: actor.type==='system'?'插件更新退役了原版本':`人类删除了已安装的${kind === "plugin" ? "插件" : "MCP"}`, data: entry });
        return { deleted: true, id: extensionId, kind, name: entry.name, historyRetained: true };
      });
    },
    deleteAgent(agentId) {
      const current = getAgent(agentId);
      if (!current) throw new Error("数字员工不存在");
      if (state.teams.some(team => team.managerAgentId === agentId || team.memberAgentIds.includes(agentId))) throw new Error("数字员工仍被团队使用，请先调整或删除团队");
      if (state.tasks.some(task => task.managerAgentId === agentId || task.memberSnapshots?.some(item => item.id === agentId) || Object.values(task.nodeAssignments || {}).includes(agentId)) || state.runs.some(run => run.manager?.sourceAgentId === agentId || run.participants?.some(item => item.id === agentId))) throw new Error("数字员工仍被任务历史引用，请保留员工以便核验历史");
      if (state.communicationConversations?.some(thread => thread.kind === "agent" && thread.targetId === agentId) || state.communicationDeliveries?.some(item => item.agentId === agentId) || state.communicationMessages?.some(item => item.sender?.id === agentId || item.visibleToAgentIds?.includes(agentId))) throw new Error("数字员工仍被沟通历史引用，请保留员工以便核验历史");
      return this.transaction(() => {
        state.agents = state.agents.filter(item => item.id !== agentId);
        addEvent({ type: "configuration.agent_deleted", actor: humanMember, message: "人类删除了未使用的数字员工", data: { agentId } });
        return clone(current);
      });
    },
    listRoles: () => clone(state.roles),
    getRole(roleId) { const current = getRole(roleId); if (!current) throw new Error("角色不存在"); return clone(current); },
    createRole(input = {}) {
      const item = { id: id("role"), name: roleName(input.name), prompt: text(input.prompt, "角色提示词"), createdAt: now() };
      return this.transaction(() => {
        state.roles.push(item);
        addEvent({ type: "configuration.role_created", actor: humanMember, message: `人类创建了角色「${item.name}」`, data: { roleId: item.id } });
        return clone(item);
      });
    },
    updateRole(roleId, input = {}) {
      const current = getRole(roleId);
      if (!current) throw new Error("角色不存在");
      if (input.name === undefined && input.prompt === undefined) throw new Error("角色更新至少提供名称或提示词");
      return this.transaction(() => {
        if (input.name !== undefined) current.name = roleName(input.name);
        if (input.prompt !== undefined) current.prompt = text(input.prompt, "角色提示词");
        addEvent({ type: "configuration.role_updated", actor: humanMember, message: `人类更新了角色「${current.name}」；新任务与后续沟通投递使用新提示词，冻结历史不变`, data: { roleId } });
        return clone(current);
      });
    },
    deleteRole(roleId) {
      const current = getRole(roleId);
      if (!current) throw new Error("角色不存在");
      const users = state.agents.filter(item => item.roleId === roleId);
      if (users.length) throw new Error(`角色仍被数字员工「${users.map(item => item.name).join("、")}」绑定，请先在员工中解除绑定后再删除`);
      return this.transaction(() => {
        state.roles = state.roles.filter(item => item.id !== roleId);
        addEvent({ type: "configuration.role_deleted", actor: humanMember, message: `人类删除了未被绑定的角色「${current.name}」`, data: { roleId, name: current.name } });
        return clone(current);
      });
    },
    deleteTeam(teamId) {
      const current = getTeam(teamId);
      if (!current) throw new Error("团队不存在");
      if (state.tasks.some(task => task.teamId === teamId)) throw new Error("团队仍被任务引用，请保留团队以便核验历史");
      if (state.communicationConversations?.some(thread => thread.kind === "team" && thread.targetId === teamId)) throw new Error("团队仍被沟通历史引用，请保留团队以便核验历史");
      return this.transaction(() => {
        state.teams = state.teams.filter(item => item.id !== teamId);
        addEvent({ type: "configuration.team_deleted", actor: humanMember, message: "人类删除了未使用的团队", data: { teamId } });
        return clone(current);
      });
    },
    createTeam(input = {}) { const members = validateTeam(input); const item = { id: id("team"), name: text(input.name, "团队名称"), mission: input.mission?.trim() || "协作完成高质量交付。", ...members, policyProfile: "local-bypass-authorized", status: "active", createdAt: now() }; state.teams.push(item); save(); return clone(item); },
    updateTeam(teamId, input = {}) { const current = getTeam(teamId); if (!current) throw new Error("团队不存在"); const next = { ...current, ...input }, members = validateTeam(next); Object.assign(current, members, { name: text(next.name, "团队名称"), mission: next.mission, status: next.status }); save(); return clone(current); },
    createTask(input = {}) { const workspaceRoot = this.getWorkspaceSettings().workspaceRoot; const currentTeam = getTeam(input.teamId), template = find(state.workflowTemplates, input.workflowTemplateId || state.workflowTemplates[0]?.id); if (!currentTeam || currentTeam.status !== "active" || !template) throw new Error("任务需要可用团队和工作流"); const taskId = "task_" + randomUUID(); if (workspaceRoot && input.workspacePath !== undefined) throw new Error("工作目录由系统自动分配，不能为任务指定"); const workspacePath = workspaceRoot ? resolve(workspaceRoot, taskId) : text(input.workspacePath, "任务工作目录"); if (!workspaceRoot && (!isAbsolute(workspacePath) || !statSync(resolve(workspacePath)).isDirectory())) throw new Error("任务工作目录必须是存在的绝对路径"); if (input.repositorySources !== undefined) throw new Error("请在研发数字员工中配置仓库，任务不能指定仓库来源"); const memberSnapshots = currentTeam.memberAgentIds.map(getAgent).filter((member) => member?.status === "active").map((member) => withRoleSnapshot(clone(member))); if (!memberSnapshots.length) throw new Error("任务团队至少需要一位可用业务成员"); const managerSnapshot = withRoleSnapshot(clone(getAgent(currentTeam.managerAgentId))); if (managerSnapshot?.kind !== "manager" || managerSnapshot.status !== "active") throw new Error("团队项目经理已停用或不可用，请先选择可用经理"); const repositories = employeeRepositories(memberSnapshots); const effectiveTemplate = clone(template); effectiveTemplate.nodes.forEach((node) => { node.staffingGuidance ||= node.ownerRole ? `适合由熟悉${node.ownerRole}相关工作的成员承担；请结合成员提示词和能力判断。` : `选择能够完成「${node.title}」交付的成员。`; node.repositoryPath = null; }); const nodeAssignments = input.nodeAssignments ? assignments(currentTeam, effectiveTemplate, input.nodeAssignments) : {}; effectiveTemplate.nodes.forEach((node) => { node.repositoryPath = repositories.repositoryBindings[nodeAssignments[node.id]]?.path || null; }); const item = { id: taskId, workspaceManaged: Boolean(workspaceRoot), repositoryMode: "agent", ...repositories, memberSnapshots, managerSnapshot, title: text(input.title, "任务标题"), objective: text(input.objective, "任务目标"), workspacePath: resolve(workspacePath), teamId: currentTeam.id, priority: input.priority || "medium", workflowTemplateId: template.id, workflowSnapshot: effectiveTemplate, nodeAssignments, deliveryAuthorization: null, managerAgentId: currentTeam.managerAgentId, managerRuntime: runtime(input.managerRuntime || getAgent(currentTeam.managerAgentId).runtime), status: "backlog", archivedAt: null, acceptanceCriteria: taskAcceptanceCriteria(input.acceptanceCriteria), createdAt: now(), updatedAt: now() }; state.tasks.unshift(item); save(); return clone(item); },
    archiveTask(taskId) { const current = getTask(taskId); if (!current) throw new Error("任务不存在"); if (current.status !== "done") throw new Error("只有已完成任务可以归档"); if (current.archivedAt) throw new Error("任务已经归档"); if (state.runs.some((run) => run.taskId === taskId && !this.canCompleteRun(run.id))) throw new Error("仍有未结束协作，不能归档"); current.archivedAt = now(); current.updatedAt = current.archivedAt; const latestRun = state.runs.find((run) => run.taskId === taskId); addEvent({ type: "task.archived", runId: latestRun?.id || null, message: `任务「${current.title}」已归档，交付记录仍可查看。`, data: { taskId, archivedAt: current.archivedAt } }); save(); return clone(current); },
    unarchiveTask(taskId) { const current = getTask(taskId); if (!current) throw new Error("任务不存在"); if (!current.archivedAt) throw new Error("任务尚未归档"); current.archivedAt = null; current.updatedAt = now(); const latestRun = state.runs.find((run) => run.taskId === taskId); addEvent({ type: "task.unarchived", runId: latestRun?.id || null, message: `任务「${current.title}」已恢复至任务中心。`, data: { taskId } }); save(); return clone(current); },
    createRun(taskId) { const currentTask = getTask(taskId); if (!currentTask || currentTask.status !== "backlog") throw new Error("Task 不能启动新的 Run"); const currentTeam = getTeam(currentTask.teamId); if (!currentTask.memberSnapshots) assignments(currentTeam, currentTask.workflowSnapshot, currentTask.nodeAssignments); const sourceManager = currentTask.managerSnapshot || getAgent(currentTask.managerAgentId || getTeam(currentTask.teamId)?.managerAgentId || managerId); if (sourceManager?.kind !== "manager" || sourceManager.status !== "active") throw new Error("项目经理不可用"); const manager = { ...withRoleSnapshot(clone(sourceManager)), id: id("manager"), sourceAgentId: sourceManager.id, runtime: clone(currentTask.managerRuntime) }; const participants = [...(currentTask.memberSnapshots || getTeam(currentTask.teamId).memberAgentIds.map(getAgent)).map((item) => ({ ...withRoleSnapshot(clone(item)), type: "agent" })), { ...manager, type: "agent" }, clone(humanMember)]; const runId = id("run"); const item = { id: runId, workspacePath: currentTask.workspaceManaged ? resolve(currentTask.workspacePath, runId) : currentTask.workspacePath, taskId, manager, participants, status: "planning", currentFocus: null, waitingConversationId: null, waitingNodeId: null, waitingAgentId: null, pendingMessageIds: [], startedAt: now(), completedAt: null, failure: null, summary: null, deliveryReview: null }; state.runs.unshift(item); currentTask.status = "planning"; save(); return clone(item); },
    updateRun(runId, patch = {}) { if (patch.status === "completed") throw new Error("完成必须由人类确认"); const current = getRun(runId); if (!current) throw new Error("Run 不存在"); if (patch.status && patch.status !== current.status && !runTransitions[current.status]?.includes(patch.status)) throw new Error(`Run 不能从 ${current.status} 变更为 ${patch.status}`); Object.assign(current, clone(patch)); save(); return clone(current); }, setTaskStatus(taskId, status) { if (status === "done") throw new Error("完成必须由人类确认"); const current = getTask(taskId); if (!current || (status !== current.status && !taskTransitions[current.status]?.includes(status))) throw new Error("Task 状态变更不合法"); current.status = status; current.updatedAt = now(); save(); return clone(current); },
    getRunRecoveryPlan(runId) {
      const current = getRun(runId);
      const empty = { shouldExecute: false, interruptedTraceIds: [], recoveredDispatchIds: [] };
      if (!current || getTask(current.taskId).archivedAt) return empty;
      const deliveries = state.dispatches.filter((item) => item.runId === runId);
      const pending = deliveries.filter((item) => ["queued", "claimed"].includes(item.status));
      const inquiryPending = pending.some((item) => item.interactionOnly);
      const inquiryReady = pending.some((item) => item.interactionOnly && (item.status === "claimed" || !item.nextRetryAt || Date.parse(item.nextRetryAt) <= Date.now()));
      const businessActive = ["planning", "running", "review"].includes(current.status);
      // A waiting human question is not work. Legacy agent consultations still
      // need initializeDispatches to materialize their recorded recipient.
      const waitingWork = current.status === "awaiting_human" && !this.hasPendingHumanQuestion(runId) && (pending.length > 0 || (!deliveries.length && current.waitingAgentId));
      const recoverBusiness = businessActive || ["awaiting_human", "paused"].includes(current.status);
      const recoverableDispatches = deliveries.filter((item) => item.status === "claimed" && (recoverBusiness || item.interactionOnly));
      return {
        shouldExecute: !this.hasPendingHumanQuestion(runId) && Boolean(businessActive || waitingWork || inquiryReady),
        interruptedTraceIds: state.traces.filter((trace) => trace.runId === runId && trace.status === "running" && (recoverBusiness || (inquiryPending && deliveries.some((item) => item.interactionOnly && item.traceIds.includes(trace.id))))).map((trace) => trace.id),
        recoveredDispatchIds: recoverableDispatches.map((item) => item.id),
      };
    },
    recoverInterruptedRun(runId, reason = "AgentForge 服务重启，未完成的本机执行已中断") {
      const plan = this.getRunRecoveryPlan(runId), current = getRun(runId);
      if (!plan.interruptedTraceIds.length && !plan.recoveredDispatchIds.length) return { run: clone(current), ...plan };
      return this.transaction(() => {
        for (const dispatchId of plan.recoveredDispatchIds) {
          const delivery = find(state.dispatches, dispatchId);
          delivery.status = "queued"; delivery.nextRetryAt = null; delivery.updatedAt = now();
        }
        for (const traceId of plan.interruptedTraceIds) this.completeTrace(traceId, { status: "failed", error: reason });
        addEvent({ type: "run.recovered", runId, message: current.status === "paused" ? "服务重启后已回收中断执行；任务保持暂停，仅独立答疑可以继续。" : "服务重启后已回收中断执行，保留历史 Trace 并重新排队未完成投递。", data: { interruptedTraceIds: plan.interruptedTraceIds, recoveredDispatchIds: plan.recoveredDispatchIds, status: current.status } });
        return { run: clone(current), ...plan };
      });
    },
    failRun(runId, reason, phase = "workspace_preparation") {
      return this.transaction(() => {
        const current = getRun(runId), task = getTask(current?.taskId);
        if (!current || !task || !["planning", "running", "review"].includes(current.status)) throw new Error("只有活跃 Run 可以标记为失败");
        if (state.traces.some((trace) => trace.runId === runId && trace.status === "running") || state.dispatches.some((item) => item.runId === runId && item.status === "claimed")) throw new Error("存在活跃执行，不能标记 Run 失败");
        current.status = "failed"; current.completedAt = now(); current.failure = { phase, message: text(reason, "失败原因") };
        task.status = "blocked"; task.updatedAt = now();
        addEvent({ type: "run.failed", runId, message: current.failure.message, data: { phase } });
        return clone(current);
      });
    },
    retryFailedNode(runId, nodeId) {
      return this.transaction(() => {
        const current = getRun(runId), task = getTask(current?.taskId);
        if (!current || !task || task.archivedAt || current.status !== "failed") throw new Error("只能恢复未归档的失败 Run");
        if (current.failure?.phase === "workspace_baseline_missing") throw new Error("工作目录基线缺失，旧 Run 不能安全重试；请核对文件并在干净工作区新建 Task/Run");
        assertNode(current, nodeId);
        const failures = failedBusinessTraces(runId), failedNodeIds = new Set(failures.map((trace) => trace.workflowNodeId));
        if (!failedNodeIds.has(nodeId)) throw new Error("所选职责没有可恢复的失败 Trace");
        const traceIds = failures.map((trace) => trace.id);
        return resumeFailedRun(current, task, nodeId, `manual-node-retry:${randomUUID()}`, {
          type: "run.retry_requested",
          message: `人类请求项目经理重新评估「${nodeId}」的失败交付；历史 Trace 已保留。`,
          data: { workflowNodeId: nodeId, failedTraceIds: traceIds }
        }, this.enqueueDispatch.bind(this));
      });
    },
    retryFailedOrchestration(runId) {
      return this.transaction(() => {
        const current = getRun(runId), task = getTask(current?.taskId);
        if (!current || !task || task.archivedAt || current.status !== "failed") throw new Error("只能恢复未归档的失败 Run");
        if (current.failure?.phase === "workspace_baseline_missing") throw new Error("工作目录基线缺失，旧 Run 不能安全重试；请核对文件并在干净工作区新建 Task/Run");
        const businessFailures = failedBusinessTraces(runId);
        if (businessFailures.length) throw new Error("存在失败的业务职责，请从该职责的恢复操作重新开始");
        const failedTraceIds = state.traces.filter((trace) => trace.runId === runId && trace.status === "failed").map((trace) => trace.id);
        const nodeId = current.currentFocus?.nodeId || task.workflowSnapshot.nodes[0].id;
        assertNode(current, nodeId);
        return resumeFailedRun(current, task, nodeId, `manual-orchestration-retry:${randomUUID()}`, {
          type: "run.orchestration_retry_requested",
          message: "人类请求重新准备运行环境，并由项目经理基于保留事实重新评估。",
          data: { failedTraceIds }
        }, this.enqueueDispatch.bind(this));
      });
    },
    pauseRun(runId, reason = "用户暂停") { const current = getRun(runId), task = getTask(current?.taskId); if (!current || !["planning", "running", "awaiting_human", "review"].includes(current.status)) throw new Error("只有活跃 Run 可以暂停"); current.pausedFromStatus = current.status; current.status = "paused"; task.status = "paused"; task.updatedAt = now(); addEvent({ type: "run.paused", runId, message: "Run 已暂停；当前本机角色执行已停止，历史 Trace 与产物保留。", data: { reason } }); save(); return clone(current); },
    resumeRun(runId) { const current = getRun(runId), task = getTask(current?.taskId); if (!current || current.status !== "paused") throw new Error("只有已暂停 Run 可以继续"); const restoredStatus = this.hasPendingHumanQuestion(runId) ? "awaiting_human" : ["awaiting_human", "review"].includes(current.pausedFromStatus) ? current.pausedFromStatus : "running"; current.status = restoredStatus; task.status = restoredStatus; task.updatedAt = now(); delete current.pausedFromStatus; addEvent({ type: "run.resumed", runId, message: "Run 已继续；项目经理将依据当前状态决定后续角色协作。", data: {} }); save(); return clone(current); },
    collaborationCandidates(runId) { const current = getRun(runId); return clone(getTask(current.taskId).workflowSnapshot.nodes); }, setCurrentFocus(runId, nodeId, reason = "项目经理已选择下一次协作") { const current = getRun(runId); assertNode(current, nodeId); current.currentFocus = { nodeId, reason: text(reason, "当前工作重心说明"), updatedAt: now() }; save(); return clone(current.currentFocus); },
    createTrace(runId, input = {}) { const current = getRun(runId); assertNode(current, input.workflowNodeId); if (!runAgent(current, input.agentId)) throw new Error("Trace Agent 不属于 Run"); const item = { id: id("trace"), runId, workflowNodeId: input.workflowNodeId, agentId: input.agentId, type: input.type || "node", status: "running", startedAt: now(), endedAt: null, tracePath: `runs/${runId}/traces/`, inputArtifactIds: [], outputArtifactIds: [], promptRef: null, error: null }; state.traces.push(item); save(); return clone(item); }, completeTrace(traceId, patch = {}) { const current = getTrace(traceId); if (!current) throw new Error("Trace 不存在"); current.status = patch.status || "completed"; current.endedAt = now(); current.tracePath = patch.tracePath || `runs/${current.runId}/traces/${current.id}/events.ndjson`; current.error = patch.error || null; save(); return clone(current); },
    attachTracePrompt(traceId, reference = {}) { const current = getTrace(traceId); if (!current) throw new Error("Trace 不存在"); if (current.promptRef || reference.storagePath !== `runs/${current.runId}/traces/${current.id}/prompt-snapshot.json` || !/^[0-9a-f]{64}$/.test(reference.sha256 || "") || !Number.isInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > 300000) throw new Error("提示词快照关联无效"); current.promptRef = { storagePath: reference.storagePath, bytes: reference.bytes, sha256: reference.sha256 }; save(); return clone(current); },
    getTracePromptReference(runId, traceId) { const trace = getTrace(traceId); const reference = trace?.promptRef; if (!getRun(runId) || !trace || trace.runId !== runId || !reference) throw new Error("提示词快照不存在或当时未保存"); if (reference.storagePath !== `runs/${runId}/traces/${trace.id}/prompt-snapshot.json` || !/^[0-9a-f]{64}$/.test(reference.sha256 || "") || !Number.isInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > 300000) throw new Error("提示词快照关联无效"); return clone(reference); },
    acceptNodeResult(runId, nodeId, traceId, output, inputs = []) {
      const current = getRun(runId), currentTrace = getTrace(traceId);
      assertNode(current, nodeId);
      if (!currentTrace || currentTrace.runId !== runId || currentTrace.workflowNodeId !== nodeId || currentTrace.status !== "running") throw new Error("Trace 不属于当前节点或不可验收");
      const resolves = Array.isArray(output.resolvesDefectIds) ? output.resolvesDefectIds : [];
      const verified = Array.isArray(output.verifiedDefectIds) ? output.verifiedDefectIds : [];
      const acceptedArtifacts = [];
      for (const input of inputs) {
        const item = { id: id("artifact"), runId, taskId: current.taskId, traceId, ownerAgentId: currentTrace.agentId, name: input.name, category: input.name.startsWith("repos/") ? "code" : "document", mediaType: input.mediaType || "application/octet-stream", storagePath: input.storagePath, sourcePath: input.sourcePath || null, sha256: input.sha256, bytes: input.bytes, deleted: Boolean(input.deleted), version: state.artifacts.filter((artifact) => artifact.runId === runId && artifact.name === input.name).length + 1, createdAt: now() };
        state.artifacts.push(item); currentTrace.outputArtifactIds.push(item.id); acceptedArtifacts.push(item);
      }
      const evidenceArtifactIds = acceptedArtifacts.filter((artifact) => !artifact.deleted && /\.(?:md|mdx)$/i.test(artifact.name)).map((artifact) => artifact.id);
      for (const input of (Array.isArray(output.decisions) ? output.decisions : [])) if (input?.summary) state.decisions.push({ id: id("decision"), runId, traceId, summary: input.summary, impact: input.impact || "clarification", affectedNodeIds: input.affectedNodeIds || [], rationale: input.rationale || "", status: "confirmed", createdAt: now(), confirmedAt: now() });
      for (const input of (Array.isArray(output.defects) ? output.defects : [])) if (input && typeof input === "object") state.defects.push({ id: id("defect"), runId, traceId, title: String(input.title || input.description || "节点报告的问题"), description: input.description || "", severity: input.severity || "medium", reproduction: input.reproduction || [], evidenceArtifactIds: [...evidenceArtifactIds], affectedNodeIds: input.affectedNodeIds || [nodeId], status: "open", createdAt: now(), updatedAt: now() });
      for (const defectId of resolves) { const defect = find(state.defects, defectId); if (defect?.runId === runId) { defect.status = "fixed"; defect.updatedAt = now(); } }
      for (const defectId of verified) { const defect = find(state.defects, defectId); if (defect?.runId === runId) { defect.status = "closed"; defect.updatedAt = now(); } }
      save();
      return clone(currentTrace);
    }, failNode(runId, nodeId, traceId, error) { const current = getRun(runId); assertNode(current, nodeId); this.completeTrace(traceId, { status: "failed", error }); save(); },
    addMessage(input = {}) { const current = getRun(input.runId); if (!current) throw new Error("Run 不存在"); const recipient = input.recipientHuman ? { type: "human", id: "human_operator", name: "你" } : input.recipientAgentId ? runAgent(current, input.recipientAgentId) : { type: "team", id: "team", name: "全体团队" }; if (!recipient) throw new Error("消息接收者不属于当前 Run"); const item = { id: id("message"), runId: current.id, conversationId: input.conversationId || `conversation_${current.id}_${input.workflowNodeId || "general"}`, workflowNodeId: input.workflowNodeId || null, sender: input.sender || { type: "human", id: "human_operator", name: "你" }, recipient: { type: recipient.type || "agent", id: recipient.id, name: recipient.name }, traceId: input.traceId || null, replyToMessageId: input.replyToMessageId || null, questionType: input.questionType || null, routingReason: input.routingReason || null, consideredMemberIds: input.consideredMemberIds || [], kind: input.kind || "instruction", content: text(input.content, "消息内容"), createdAt: now() }; state.messages.push(item); addEvent({ type: "message.sent", runId: current.id, actor: item.sender, message: item.content, data: { messageId: item.id, conversationId: item.conversationId, workflowNodeId: item.workflowNodeId } }); return clone(item); }, waitForHuman(runId, nodeId, conversationId) { const current = getRun(runId); current.waitingNodeId = nodeId; current.waitingAgentId = null; current.waitingConversationId = conversationId; current.currentFocus = { nodeId, reason: "等待人类澄清", updatedAt: now() }; current.status = "awaiting_human"; getTask(current.taskId).status = "awaiting_human"; save(); }, resumeHuman(runId, messageId) { const current = getRun(runId), message = find(state.messages, messageId); if (!current?.waitingNodeId || !message || message.conversationId !== current.waitingConversationId) throw new Error("当前 Run 没有匹配的人类澄清"); current.waitingNodeId = null; current.waitingAgentId = null; current.waitingConversationId = null; current.status = "running"; getTask(current.taskId).status = "running"; save(); return clone(current); }, waitForAgent(runId, nodeId, agentId, conversationId) { const current = getRun(runId); if (!runAgent(current, agentId)) throw new Error("被咨询数字员工不属于当前 Run"); current.waitingNodeId = nodeId; current.waitingAgentId = agentId; current.waitingConversationId = conversationId; current.currentFocus = { nodeId, reason: "等待角色协作答复", updatedAt: now() }; save(); }, resumeAgent(runId, conversationId) { const current = getRun(runId); if (!current?.waitingNodeId || !current.waitingAgentId || current.waitingConversationId !== conversationId) throw new Error("当前 Run 没有匹配的角色协作"); current.waitingNodeId = null; current.waitingAgentId = null; current.waitingConversationId = null; save(); return clone(current); },
    requestReplan(runId, messageId) { const current = getRun(runId); current.pendingMessageIds.push(messageId); save(); }, pendingMessages(runId) { const current = getRun(runId); return clone(state.messages.filter((item) => current?.pendingMessageIds.includes(item.id))); }, consumePendingMessages(runId) { getRun(runId).pendingMessageIds = []; save(); }, noteReassessment(runId, nodeIds, reason = "项目经理确认变更影响") { const current = getRun(runId); for (const nodeId of nodeIds) assertNode(current, nodeId); addEvent({ type: "run.reassessment_requested", runId, message: reason, data: { nodeIds } }); save(); return clone(current); },
    listDefects(runId = null) { return clone(state.defects.filter((item) => !runId || item.runId === runId)); }, updateDefect(runId, defectId) { const current = find(state.defects, defectId); if (!current || current.runId !== runId) throw new Error("Defect 不存在"); throw new Error("Defect 是 Trace-bound 审计事实，不能直接修改；请通过修复和回归 Trace 更新状态"); },
    cancelRun(runId, reason) {
      const current = getRun(runId), task = getTask(current?.taskId);
      if (!current || !task || !["planning", "running", "awaiting_human", "review", "awaiting_acceptance", "paused"].includes(current.status)) return clone(current);
      const cancelledAt = now(), cancellationReason = text(reason, "终止原因"), cancelledDispatchIds = [];
      for (const item of state.dispatches.filter((item) => item.runId === runId && !["done", "cancelled"].includes(item.status))) {
        item.status = "cancelled"; item.nextRetryAt = null; item.updatedAt = cancelledAt; cancelledDispatchIds.push(item.id);
      }
      current.status = "cancelled"; current.completedAt = cancelledAt; current.cancellationReason = cancellationReason;
      task.status = "cancelled"; task.updatedAt = cancelledAt;
      addEvent({ type: "run.cancelled", runId, actor: humanMember, message: "人类已终止 Run；未完成协作投递已取消，既有 Trace 与交付记录保留。", data: { reason: cancellationReason, cancelledDispatchIds } });
      save(); return clone(current);
    }
  };
}
