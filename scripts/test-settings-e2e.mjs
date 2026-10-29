// Operator-driven, isolated settings acceptance. Real CLI calls are explicit phases.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createStore } from "../server/store.mjs";
import { createAuth } from "../server/auth.mjs";

const [mode, rootArgument] = process.argv.slice(2), password = process.env.AGENTFORGE_E2E_PASSWORD;
if (!password) throw new Error("Supply the disposable fixture password through AGENTFORGE_E2E_PASSWORD; never run against operator data.");
let directory = rootArgument && resolve(rootArgument);
if (mode === "prepare") {
  directory = await mkdtemp(resolve(".data/settings-e2e-"));
  const source = new DatabaseSync(resolve(".data/agentforge.sqlite"), { readOnly: true });
  const saved = JSON.parse(source.prepare("SELECT state_json FROM workspace_snapshots WHERE id=1").get().state_json); source.close();
  const configured = saved.settings.runtimeProfiles.find(profile => profile.id === saved.agents.find(agent => agent.kind === "manager")?.runtime.profileId && profile.provider === "claude-code") || saved.settings.runtimeProfiles.find(profile => profile.provider === "claude-code");
  assert.ok(configured, "a configured Claude Code connection is required");
  const runtime = Object.fromEntries(["provider", "model", "executable", "profile"].map(key => [key, configured[key]]));
  const workspaces = join(directory, "workspaces"); await mkdir(workspaces);
  await writeFile(join(workspaces, "external-note.txt"), "Disposable sibling outside managed Run directories must survive.");
  const auth = createAuth({ databasePath: join(directory, "auth.sqlite") }); await auth.setAdministrator("settings-qa", password); auth.close();
  const store = createStore({ databasePath: join(directory, "state.sqlite"), workspaceRoot: workspaces });
  const worker = store.createAgent({ name: "Settings QA · 内容工具作者", capabilities: ["Node.js ESM", "node:test"], systemPrompt: "实现明确规格并真实执行命令；只写任务 docs/check 下文件。先记录预期失败，再运行测试。", runtime });
  const manager = store.createAgent({ name: "Settings QA · 经理", kind: "manager", systemPrompt: "按节点人员需求选择业务成员；读取并复跑实际代码和测试，依据真实 Artifact 逐条复核。最终等待人类确认。", runtime });
  const team = store.createTeam({ name: "Settings QA · 知识内容", memberAgentIds: [worker.id], managerAgentId: manager.id });
  const workflow = store.createWorkflowTemplate({ name: "Settings QA · 代码工具", nodes: [{ id: "implement", title: "实现并测试标题工具", staffingGuidance: "熟悉 Node.js ESM 与 node:test，能提供真实测试证据的成员", deliverable: "实现标题规范化函数、至少六项真实测试和报告。", artifactPaths: ["docs/check/"], dependsOn: [] }] });
  const task = store.createTask({ teamId: team.id, workflowTemplateId: workflow.id, title: "SETTINGS-QA｜知识标题规范化工具", objective: "在 docs/check/title.mjs 导出 normalizeTitle(value)：仅接受 string，其他类型抛 TypeError；trim 后将连续空白压缩为一个空格，保留大小写。在 docs/check/title.test.mjs 写至少六个 node:test 覆盖首尾空白、连续空格、换行、空字符串、中文与非法输入。先单独真实运行 node -e 'process.exit(7)' 并保留预期失败，再运行 node --test docs/check/title.test.mjs。docs/check/report.md 记录真实命令和结果。经理须读取源码和测试，复跑后提交人类验收。只在此隔离工作区写文件，不安装依赖或访问外部业务服务。", acceptanceCriteria: ["源码实现 trim 与连续空白压缩，非法输入 TypeError", "至少六个 node:test 测试真实通过，报告保留预期退出码 7 的探针", "经理真实复跑并等待人类确认"] });
  await writeFile(join(directory, "context.json"), JSON.stringify({ workerId: worker.id, taskId: task.id, workspaces }), { mode: 0o600 }); store.close();
  console.log(JSON.stringify({ directory, taskId: task.id, workerId: worker.id }));
  process.exit(0);
}
assert.ok(directory?.startsWith(resolve(".data/settings-e2e-") ), "only the named disposable fixture can be used");
const contextPath = join(directory, "context.json"), context = JSON.parse(await readFile(contextPath, "utf8"));
const origin = "http://127.0.0.1:4310";
const cookiePath = join(directory, "session.cookie");
let cookie = await readFile(cookiePath, "utf8").catch(() => "");
if (!cookie || (await fetch(origin + "/api/auth/session", { headers: { Cookie: cookie } })).status !== 200) {
  const login = await fetch(origin + "/api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ username: context.adminUsername || "settings-qa", password }) });
  assert.equal(login.status, 200, "the isolated fixture administrator must own the running service");
  cookie = login.headers.getSetCookie()[0].split(";")[0];
  await writeFile(cookiePath, cookie, { mode: 0o600 });
}
let lastSetCookies = [];
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  lastSetCookies = response.headers.getSetCookie();
  const result = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${result.error}`); return result;
}
const bootstrap = await api("/api/bootstrap");
assert.ok(context.resetPassed ? context.installationId === bootstrap.installationId : bootstrap.agents.some(agent => agent.id === context.workerId), "refuse to touch any other instance");
if (mode === "chat") {
  const { conversation } = await api("/api/communications", { kind: "agent", targetId: context.workerId });
  await api(`/api/communications/${conversation.id}/messages`, { content: "只回复一句：隔离未读验收已收到。不要改文件或调用外部工具。", clientRequestId: `settings-unread-${Date.now()}` });
  context.conversationId = conversation.id;
} else if (mode === "run") {
  const result = await api(`/api/tasks/${context.taskId}/run`, {}); context.runId = result.run.id;
} else if (mode === "inspect") {
  console.log(JSON.stringify({ notifications: await api("/api/notifications"), run: context.runId ? (await api(`/api/runs/${context.runId}/workspace?view=summary`)).run.status : null }));
} else if (mode === "launch-failure") {
  const profile = await api("/api/settings/runtime-profiles", { name: `Disposable missing CLI ${Date.now()}`, provider: "claude-code", executable: join(directory, "not-installed-cli") });
  const result = await api(`/api/settings/runtime-profiles/${profile.id}/test`, {});
  assert.equal(result.ok, false);
  const rows = (await readFile(result.logPath, "utf8")).trim().split("\n").map(JSON.parse).filter(row => row.testId === result.testId);
  const original = rows.find(row => row.event === "provider.spawn_error");
  assert.equal(original.error.code, "ENOENT");
  const diagnosis = rows.find(row => row.event === "provider.launch_diagnostic");
  assert.equal(diagnosis.candidates[0].exists, false);
  assert.equal(diagnosis.workingDirectory.usable, true);
  assert.match(diagnosis.nextSteps.join(" "), /设置 → 本机运行时/);
  context.launchFailure = { testId: result.testId, logPath: result.logPath, diagnosisHash: createHash("sha256").update(JSON.stringify(diagnosis)).digest("hex") };
  console.log(JSON.stringify({ passed: true, originalCode: original.error.code, logPath: result.logPath, problems: diagnosis.problems, nextSteps: diagnosis.nextSteps }));
} else if (mode === "repair-probe") {
  await api(`/api/runs/${context.runId}/messages`, { recipientAgentId: context.workerId, content: "验收返工：已读取真实 Bash 输入，之前两个探针都写成 node -e 'process.exit(7)'; echo ...，shell 最后返回成功，不能作为工具失败证据。请现在发起独立的一次 Bash 工具调用：command 字段只能是 node -e 'process.exit(7)'，不能附加 echo、分号、&&、||、管道、包装脚本或 exit 0，必须让 Bash 工具真实返回非零退出码 7。随后在另一个独立 Bash 调用中重新运行 node --test docs/check/title.test.mjs，真实成功后更新 docs/check/report.md 明确原始两个工具调用末尾 echo 导致整体成功、此次修正探针真实失败与测试通过。重新交付报告，由经理重新核验并提交人类验收，不自行完成任务。" });
} else if (mode === "verify") {
  const workspace = await api(`/api/runs/${context.runId}/workspace`);
  const proofs = [];
  for (const artifact of workspace.artifacts) {
    const content = await readFile(join(directory, "records", artifact.storagePath));
    assert.equal(createHash("sha256").update(content).digest("hex"), artifact.sha256);
    proofs.push({ name: artifact.name, sha256: artifact.sha256 });
  }
  const cwd = workspace.run.workspacePath;
  const output = execFileSync(process.execPath, ["--test", "docs/check/title.test.mjs"], { cwd, encoding: "utf8" });
  assert.ok(Number(output.match(/pass (\d+)/)?.[1]) >= 6);
  context.probeEvidence = await storeAuditProbe(workspace);
  assert.ok(context.probeEvidence, "the exact standalone probe must have a paired failed tool result with Exit code 7");
  context.verifiedArtifacts = proofs; context.runWorkspace = cwd; context.testOutput = output;
  console.log(JSON.stringify({ status: workspace.run.status, artifacts: proofs.length, testOutput: output }));
} else if (mode === "reset") {
  assert.ok(context.runWorkspace && context.verifiedArtifacts?.length && context.probeEvidence?.eventId);
  assert.equal((await api(`/api/runs/${context.runId}/workspace?view=summary`)).run.status, "completed", "finish visible human acceptance before clearing this disposable fixture");
  await assert.rejects(api("/api/settings/reset", { confirmation: "清除所有数据", password: "wrong-fixture-password" }), /当前密码不正确/);
  await assert.rejects(api("/api/settings/reset", { confirmation: "wrong", password }), /确认/);
  await api("/api/runtime/git-credentials/github", { token: "disposable-settings-test-token-837412" }, "PUT");
  await api("/api/runtime/mcp-marketplace", { name: "Disposable reset MCP", description: "Only a disposable reset fixture; never selected for execution.", content: JSON.stringify({ mcpServers: { reset_fixture: { command: process.execPath, args: ["--version"] } } }) });
  await api(`/api/agents/${context.workerId}/history/list_sessions`, {});
  const result = await api("/api/settings/reset", { confirmation: "清除所有数据", password });
  const setupCookie = lastSetCookies.find(value => value.startsWith("agentforge_bootstrap=")).split(";")[0];
  assert.equal(result.next, "/setup.html");
  assert.equal((await fetch(origin + "/api/bootstrap", { headers: { Cookie: cookie } })).status, 401);
  await assert.rejects(access(context.runWorkspace), { code: "ENOENT" });
  assert.match(await readFile(join(context.workspaces, "external-note.txt"), "utf8"), /must survive/);
  assert.equal((await fetch(origin + "/setup.html", { headers: { Cookie: setupCookie } })).status, 200);
  assert.equal((await fetch(origin + "/setup.html")).status, 404);
  const initialized = await fetch(origin + "/api/auth/bootstrap", { method: "POST", headers: { Cookie: setupCookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ username: "reset-fresh", password }) });
  assert.equal(initialized.status, 201);
  const freshCookie = initialized.headers.getSetCookie().find(value => value.startsWith("agentforge_session=")).split(";")[0];
  await writeFile(cookiePath, freshCookie, { mode: 0o600 });
  const fresh = await fetch(origin + "/api/bootstrap", { headers: { Cookie: freshCookie } }).then(response => response.json());
  assert.notEqual(fresh.installationId, bootstrap.installationId);
  assert.equal(fresh.runs.length, 0);
  assert.deepEqual(fresh.tasks, [], "reset must not recreate default Tasks");
  assert.equal(fresh.agents.some(agent => agent.id === context.workerId), false);
  const credentials = await fetch(origin + "/api/runtime/git-credentials", { headers: { Cookie: freshCookie } }).then(response => response.json());
  assert.ok(credentials.providers.every(provider => provider.configured === false));
  const services = await fetch(origin + "/api/runtime/mcp-marketplace", { headers: { Cookie: freshCookie } }).then(response => response.json());
  assert.deepEqual(services.entries, []);
  context.installationId = fresh.installationId; context.adminUsername = "reset-fresh";
  context.resetPassed = true;
  console.log("PASS real-code fixture reset, stale-session rejection and external sibling preservation");
} else throw new Error("Use prepare/chat/run/inspect/launch-failure/verify/reset");
await writeFile(contextPath, JSON.stringify(context, null, 2), { mode: 0o600 });
async function storeAuditProbe(workspace) {
  async function content(event) {
    const reference = event.data.contentRef, bytes = await readFile(join(directory, "records", reference.storagePath));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), reference.sha256);
    return JSON.parse(bytes).fields;
  }
  for (const event of workspace.events.filter(event => event.data?.toolName === "Bash" && event.data?.presentation === "tool" && event.data?.contentRef)) {
    const input = await content(event);
    if (JSON.parse(input.input.text).command !== "node -e 'process.exit(7)'") continue;
    const result = workspace.events.find(item => item.data?.traceId === event.data.traceId && item.data?.toolResultId === event.data.toolUseId && item.data?.status === "failed" && item.data?.contentRef);
    if (result && /Exit code 7/.test((await content(result)).output?.text || "")) return { eventId: result.id, traceId: result.data.traceId, sha256: result.data.contentRef.sha256 };
  }
  return null;
}
