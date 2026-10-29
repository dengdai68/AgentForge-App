// Opt-in real Claude code delivery; isolated metadata, public read-only source, no push.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, readFile, symlink, stat } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { resolve, join, dirname, basename } from "node:path";
import { chromium, _electron as electron } from "playwright-core";
import { createStore } from "../server/store.mjs";
import { createAuth } from "../server/auth.mjs";
import { setupMarketplace } from "./marketplace-e2e.mjs";
import { preparePluginFixture, setupPluginMarketplace } from "./plugin-e2e.mjs";
import { loadLoginShellEnvironment } from "../apps/electron/login-shell-env.mjs";
import { setupCliConfiguration } from "./cli-e2e.mjs";

let origin = "http://127.0.0.1:4310";
await mkdir(resolve(".data"), { recursive: true });
await mkdir(resolve("screenshots"), { recursive: true });
const resume = process.env.AGENTFORGE_DEVELOPMENT_E2E_RESUME;
const cliMode = process.env.AGENTFORGE_CLI_E2E === '1';
const taskCliMode = process.env.AGENTFORGE_TASK_CLI_E2E === '1';
const clientMode = cliMode || taskCliMode;
if (!clientMode && await fetch(`${origin}/api/health`).then(() => true, () => false)) throw new Error("4310 occupied; never terminate an unverified owner");
const root = resume ? resolve(resume) : await mkdtemp(resolve(".data/development-e2e-"));
process.env.AGENTFORGE_LOG_DIR=join(root,'logs');
assert.equal(dirname(root), resolve(".data"));
assert.match(basename(root), /^development-e2e-[a-zA-Z0-9]+$/);
const pluginFixture = process.env.AGENTFORGE_PLUGIN_E2E === '1' || process.env.AGENTFORGE_MARKETPLACE_E2E === '1' || (cliMode && process.env.AGENTFORGE_CLI_PUBLIC_IMPORT !== '1') ? await preparePluginFixture(root) : null;
const pluginEnv = pluginFixture?.env || {};
const password = randomBytes(24).toString("hex");
const auth = createAuth({ databasePath: join(root, "auth.sqlite") });
await auth.setAdministrator("development-e2e", password); auth.close();
const store = createStore({ databasePath: join(root, clientMode ? "agentforge.sqlite" : "state.sqlite"), workspaceRoot: join(root, "workspaces") });
if (clientMode && !resume) store.updateWorkspaceSettings({ workspaceRoot: join(root, "workspaces") });
const agents = store.snapshot().agents;
const repository = { url: "https://github.com/octocat/Hello-World.git", ref: "master" };
let developer, tester;
if (!cliMode) {
  const member = (name, capability) => store.createAgent({ name, kind: "developer", repository, capabilities: ["Node.js ESM", "node:test", capability], systemPrompt: `${capability}：实际执行代码与测试，记录真实命令和失败，只在任务工作目录交付。仅本地 Git commit，不 push、不部署。`, runtime: { provider: "claude-code" } });
  developer = resume && (agents.find(employee => employee.name === "开发验收 · 代码实现") || agents.find(employee => employee.id === "agent_developer") || agents.find(employee => employee.id === "agent_engineer"));
  tester = resume && (agents.find(employee => employee.name === "开发验收 · 独立验证") || agents.find(employee => employee.id === "agent_tester"));
  developer ||= member("开发验收 · 代码实现", "实现内容工具并提供真实开发证据");
  tester ||= member("开发验收 · 独立验证", "独立审阅他人代码并验证边界条件");
  store.updateAgent(developer.id, { kind: "developer", repository });
  store.updateAgent(tester.id, { kind: "developer", repository });
}
const manager = agents.find(employee => employee.kind === "manager");
assert.ok(manager, "the isolated fixture must have an explicitly selected manager");
let team = cliMode ? null : (resume && store.snapshot().teams.find(item => item.name === "代码开发实测团队")) || store.createTeam({ name: "代码开发实测团队", managerAgentId: manager.id, memberAgentIds: [developer.id, tester.id] });
let flow = cliMode ? null : (resume && store.snapshot().workflowTemplates.find(item => item.name === "本地代码开发与独立测试")) || store.createWorkflowTemplate({ name: "本地代码开发与独立测试", nodes: [
  { id: "develop", title: "实现任务搜索工具", staffingGuidance: "熟悉 Node.js ESM、内容工具开发，能实际执行测试并记录证据的成员", dependsOn: [], artifactPaths: ["docs/development/"], deliverable: "在绑定代码仓库实现 task-search.mjs 和 task-search.test.mjs，执行 node --test，提交本地 Git commit（不 push），在 docs/development/report.md 记录真实测试与 SHA。" },
  { id: "verify", title: "独立边界验证", staffingGuidance: "不是本次代码作者，能独立读取源码、执行 Node.js 测试并验证边界条件的成员", dependsOn: ["develop"], artifactPaths: ["docs/verification/"], deliverable: "独立读取代码并运行测试，验证空数组、非法输入、中文名称、状态和团队交集，在 docs/verification/report.md 记录实际命令、结果与必要缺陷。" }
] });
const shellEnvTest = process.env.AGENTFORGE_SHELL_ENV_E2E === '1';
const guiPath = process.env.AGENTFORGE_GUI_PATH_E2E === '1' || shellEnvTest;
let launchEnvironment = { ...process.env, ...pluginEnv, ...(guiPath ? { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } : {}) };
if (shellEnvTest) {
  const shellRoot = join(root, 'shell-profile'), bin = join(shellRoot, 'version-manager/bin');
  await mkdir(bin, { recursive: true });
  const { stdout } = await promisify(execFile)('/usr/bin/which', ['claude']);
  const actualCli = stdout.trim(); assert.ok(actualCli.startsWith('/'));
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  await symlink(process.execPath, join(bin, 'node'));
  await writeFile(join(bin, 'claude'), `#!/bin/sh\n[ "$AF_REAL_SHELL_MARKER" = yes ] || exit 91\nprintf 'invoked\\n' >> ${quote(join(root, 'shell-cli-invocations.txt'))}\nexec ${quote(actualCli)} "$@"\n`, { mode: 0o700 });
  await writeFile(join(shellRoot, '.zshrc'), `print -r -- 'E2E shell welcome'\nexport AF_REAL_SHELL_MARKER=yes\nexport PATH=${quote(bin)}:/usr/bin:/bin:/usr/sbin:/sbin\n`);
  const rows = [];
  launchEnvironment = await loadLoginShellEnvironment({ environment: { ...launchEnvironment, SHELL: '/bin/zsh', ZDOTDIR: shellRoot }, onDiagnostic: row => rows.push(row) });
  assert.ok(rows.some(row => row.status === 'applied' && row.attempt === 'interactive'));
  assert.equal(launchEnvironment.PATH.split(':')[0], bin);
  await writeFile(join(root, 'shell-startup-evidence.json'), JSON.stringify(rows, null, 2));
}
const backend = clientMode ? null : spawn(process.execPath, ["server/index.mjs"], { detached: true, env: { ...launchEnvironment, AGENTFORGE_DB_PATH: join(root, "state.sqlite"), AGENTFORGE_AUTH_DB_PATH: join(root, "auth.sqlite"), AGENTFORGE_RUN_FILES_ROOT: join(root, "runs"), AGENTFORGE_WORKSPACE_ROOT: join(root, "workspaces"), AGENTFORGE_RUNTIME_CONFIG_ROOT: join(root, "runtime") }, stdio: ["ignore", "pipe", "pipe"] });
backend?.stdout.on("data", chunk => process.stdout.write(chunk));
backend?.stderr.on("data", chunk => process.stderr.write(chunk));
backend?.once("exit", (code, signal) => console.log(`Isolated backend exited: code=${code}, signal=${signal}`));
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function wait(label, check, timeout = 180000) {
  const started = Date.now(); let lastLog = 0;
  while (Date.now() - started < timeout) {
    const value = await check(); if (value) return value;
    if (Date.now() - lastLog > 30000) { console.log(`WAIT ${label}`); lastLog = Date.now(); }
    await sleep(1500);
  }
  throw new Error(`Timed out: ${label}`);
}
let browser, page, desktop;
const errors = [];
const taskCliEvidence = resume ? await readFile(join(root, 'task-cli-evidence.json'), 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return []; throw error; }) : [];
let taskCliTaskId, clarificationAnswered = taskCliEvidence.some(row => row.command?.[0] === 'tasks' && row.command?.[1] === 'reply' && row.ok && row.data?.message?.replyToMessageId);
async function taskCli(args, input, expected = 0) {
  const result = await new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ['cli/main.mjs', ...args, '--endpoint-file', join(root, 'desktop-endpoint.json'), '--session-file', join(root, 'task-cli-private/session.json'), '--json'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    processChild.stdout.on('data', chunk => { stdout += chunk; }); processChild.stderr.on('data', chunk => { stderr += chunk; });
    processChild.once('error', reject); processChild.once('close', code => resolve({ code, stdout, stderr }));
    processChild.stdin.on('error', () => {});
    processChild.stdin.end(input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input));
  });
  assert.equal(result.code, expected, result.stdout || result.stderr);
  assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password));
  const envelope = JSON.parse(result.stdout);
  taskCliEvidence.push({ command: args.slice(0, 3), code: result.code, ...envelope });
  await writeFile(join(root, 'task-cli-evidence.json'), JSON.stringify(taskCliEvidence, null, 2));
  return envelope.data;
}
try {
  if (clientMode) {
    desktop = await electron.launch({ args: ["apps/electron/main.mjs", `--user-data-dir=${join(root, 'browser')}`], env: { ...launchEnvironment, AGENTFORGE_DESKTOP_DATA_ROOT: root }, timeout: 60000 });
    page = await desktop.firstWindow();
    await wait('client endpoint', async () => {
      const endpoint = await readFile(join(root, 'desktop-endpoint.json'), 'utf8').then(JSON.parse, () => null);
      if (!endpoint) return false;
      origin = endpoint.origin; return true;
    });
  }
  await wait("isolated server", () => fetch(`${origin}/api/health`).then(r => r.ok, () => false));
  const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ username: "development-e2e", password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  async function api(path, body, method = body ? "POST" : "GET") {
    if (taskCliMode && method === 'POST' && path === '/api/tasks') {
      const { nodeAssignments, ...taskInput } = body;
      taskInput.objective += '\n开工前有一项必须向人类澄清：最终开发报告的标题是什么？请先发出正式的人类澄清，禁止猜测答案或在收到明确答复之前开始代码开发。回复后在报告使用该标题。';
      const created = await taskCli(['tasks', 'create', '--file', '-'], taskInput);
      taskCliTaskId = created.task.id;
      assert.equal((await taskCli(['tasks', 'progress', taskCliTaskId])).runId, null);
      await taskCli(['tasks', 'message', taskCliTaskId, '--file', '-'], { content: '启动前拒绝探针', recipientAgentId: manager.id }, 4);
      assert.equal((await taskCli(['tasks', 'get', taskCliTaskId])).objective, taskInput.objective);
      assert.ok((await taskCli(['tasks', 'list', '--search', 'DEV-E2E', '--team', team.id, '--status', 'backlog'])).items.some(task => task.id === taskCliTaskId));
      return created;
    }
    if (taskCliMode && method === 'POST' && path === `/api/tasks/${taskCliTaskId}/run`) return taskCli(['tasks', 'start', taskCliTaskId]);
    const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", Connection: "close" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
  }
  if (!clientMode) {
    browser = await chromium.launch({ channel: "chrome", headless: false });
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  }
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/login`);
  await page.locator("#username").fill("development-e2e"); await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator("#account-name").waitFor();
  const createdWorkspaceRoot=process.env.AGENTFORGE_WORKSPACE_E2E==='1' ? join(root,'auto-created-workspaces','任务目录') : null;
  if(createdWorkspaceRoot){
    await page.goto(origin+'/settings/workspace');await page.locator('#default-workspace-root').fill(createdWorkspaceRoot);
    await page.getByRole('button',{name:'保存目录',exact:true}).click();await page.getByText('已保存，仅新任务使用此目录。',{exact:true}).waitFor();
    assert.equal((await stat(createdWorkspaceRoot)).isDirectory(),true);
    assert.equal((await api('/api/settings/workspace')).workspaceRoot,createdWorkspaceRoot);
    console.log('PASS real-task workspace saved and missing nested directories created before Task creation');
  }
  if (taskCliMode) await taskCli(['auth', 'login', '--username', 'development-e2e', '--password-stdin'], password + '\n');
  if (cliMode) ({ developer, tester, team, flow } = await setupCliConfiguration({ root, api, page, username: 'development-e2e', password, repository }));
  if (process.env.AGENTFORGE_RUNTIME_E2E === '1' || guiPath) {
    await page.goto(`${origin}/settings/runtime`);
    const fresh = page.locator('[data-runtime-profile="new"]');
    await fresh.locator('summary').click();
    await fresh.locator('[name="name"]').fill('实测 Claude 连接');
    await fresh.getByRole('button', { name: '添加配置', exact: true }).click();
    await page.getByRole('heading', { name: '实测 Claude 连接', exact: true }).waitFor();
    let profiles = (await api('/api/settings/runtime-profiles')).profiles;
    const claude = profiles.find(item => item.name === '实测 Claude 连接');
    const card = page.locator(`[data-runtime-profile="${claude.id}"]`);
    await card.locator('summary').click();
    await card.locator('[name="executable"]').fill('/agentforge-real-e2e-missing-cli');
    await card.getByRole('button', { name: '保存配置', exact: true }).click();
    await card.getByText('已保存。可测试此配置。', { exact: true }).waitFor();
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await wait('real missing CLI failure', async () => (await card.locator('[data-runtime-result]').textContent()).includes('连接测试失败'));
    const failure = await card.locator('[data-runtime-result]').textContent();
    await card.locator('[name="executable"]').fill('');
    await card.getByRole('button', { name: '保存配置', exact: true }).click();
    await card.getByText('已保存。可测试此配置。', { exact: true }).waitFor();
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await wait('real Claude connection', async () => (await card.locator('[data-runtime-result]').textContent()).includes('连接测试通过'), 120000);
    const success = await card.locator('[data-runtime-result]').textContent();
    let codexResult = null;
    if (process.env.AGENTFORGE_RUNTIME_E2E === '1') {
      const codex = profiles.find(item => item.provider === 'codex');
      const codexCard = page.locator(`[data-runtime-profile="${codex.id}"]`);
      await codexCard.getByRole('button', { name: '测试连接', exact: true }).click();
      await wait('real Codex connection', async () => (await codexCard.locator('[data-runtime-result]').textContent()).includes('连接测试通过'), 120000);
      codexResult = await codexCard.locator('[data-runtime-result]').textContent();
    }
    for (const employeeId of [developer.id, tester.id, team.managerAgentId]) {
      const employee = (await api('/api/bootstrap')).agents.find(item => item.id === employeeId);
      await api(`/api/agents/${employeeId}`, { runtime: { ...employee.runtime, profileId: claude.id } }, 'PUT');
    }
    await page.screenshot({ path: 'screenshots/runtime-settings-web.png', fullPage: true });
    await writeFile(join(root, 'runtime-settings-evidence.json'), JSON.stringify({ failure, success, codex: codexResult, guiPath, profileId: claude.id }, null, 2));
  }
  if (process.env.AGENTFORGE_LOGS_E2E === "1") {
    assert.equal((await fetch(`${origin}/api/settings/execution-logs`)).status, 401);
    for (const [kind, targetId, source] of [["agent", developer.id, "private"], ["team", team.id, "group"]]) {
      await api(`/api/agents/${developer.id}`, { runtime: { ...developer.runtime, executable: join(root, "missing-cli") } }, "PUT");
      const { conversation } = await api("/api/communications", { kind, targetId });
      await api(`/api/communications/${conversation.id}/messages`, { content: "日志验收：请只回答 17 加 25 等于多少，不使用工具，不转交。", mentionAgentIds: [developer.id], clientRequestId: `logs-${source}-${Date.now()}` });
      const delivery = await wait(`${source} actual CLI spawn failure`, async () => (await api(`/api/communications/${conversation.id}`)).deliveries.find(row => row.status === "failed"));
      const failed = await api(`/api/settings/execution-logs?source=${source}&level=error`);
      assert.ok(failed.items.some(row => row.deliveryId === delivery.id && /CLI 不可启动/.test(row.message)));
      await api(`/api/agents/${developer.id}`, { runtime: developer.runtime }, "PUT");
      await api(`/api/communications/${conversation.id}/deliveries/${delivery.id}/retry`, {});
      await wait(`${source} real Claude recovery`, async () => (await api(`/api/communications/${conversation.id}`)).deliveries.find(row => row.id === delivery.id && row.status === "done"), 600000);
      const logs = await api(`/api/settings/execution-logs?source=${source}`);
      assert.ok(logs.items.some(row => row.deliveryId === delivery.id && row.type === "completed"));
      assert.ok(logs.items.some(row => row.deliveryId === delivery.id && row.level === "error" && row.currentStatus === "done"));
      assert.doesNotMatch(JSON.stringify(logs), /missing-cli|17 加 25/);
      await writeFile(join(root, `${source}-logs-evidence.json`), JSON.stringify(logs, null, 2));
    }
    await page.goto(`${origin}/settings/logs`);
    assert.equal((await fetch(`${origin}/api/settings/log-files`)).status, 401);
    const logStatus = await api('/api/settings/log-files');
    assert.equal(logStatus.available, true);
    const diagnosticText = await readFile(logStatus.filePath, 'utf8');
    assert.match(diagnosticText, /provider.spawn_error/);
    assert.match(diagnosticText, /ENOENT/);
    assert.match(diagnosticText, /missing-cli/);
    assert.match(diagnosticText, /communication.completed/);
    await wait('diagnostic path visible', async () => (await page.locator('[data-log-file]').innerText()) === logStatus.filePath);
    assert.equal(await page.locator('[data-log-list]').count(), 0);
    await page.screenshot({path: 'screenshots/execution-logs-web.png'});
  }
  const verifyMarketplace = process.env.AGENTFORGE_PLUGIN_E2E === '1' ? await setupPluginMarketplace({page,api,root,developer,tester,manager}) : process.env.AGENTFORGE_MARKETPLACE_E2E === '1' ? await setupMarketplace({page,api,root,developer,tester,manager}) : null;
  const created = (resume && store.listTasks().find(task => task.title.startsWith("DEV-E2E｜"))) || await api("/api/tasks", { title: "DEV-E2E｜真实执行日志与任务检索开发", teamId: team.id, workflowTemplateId: flow.id, nodeAssignments: { develop: developer.id, verify: tester.id }, objective: "完成真实 Node.js ESM 代码开发：在已绑定的公共 Hello-World 克隆目录中新增 task-search.mjs，导出 filterTasks(tasks, {name='',status='',teamId=''}={})。按名称不区分大小写子串、状态和团队精确交集过滤，保留顺序、不修改输入。空数组返回 []；tasks 非数组或元素缺少字符串 name/status/teamId 时抛 TypeError。新增 task-search.test.mjs，使用 node:test 覆盖中文/大小写、组合条件、无匹配、空数组、非法输入和不修改输入。开发者先用普通 assistant 正文简短说明即将实施的工作（不要求隐藏思维），再实际执行一次预期失败探针：node -e \"console.error('EXPECTED_FAILURE_PROBE');process.exit(1)\"，记录这是有意测试工具失败展示而不是交付缺陷，随后正常开发和修复到测试通过。开发者执行真实测试并仅本地 commit，测试者独立执行和验证；所有文档仅写自己的 artifactPaths。不能 push/发布/部署、不能改凭据。验收后等待人类确认。", acceptanceCriteria: ["真实 ESM 函数通过名称、状态、团队组合过滤且不修改输入", "真实 node --test 覆盖成功路径及 TypeError/无匹配边界，并记录预期失败探针后正常交付", "独立测试报告引用实际结果且代码有本地 Git commit，无远程写入"] });
  const task = created.task || created;
  if(createdWorkspaceRoot)assert.equal(task.workspacePath,join(createdWorkspaceRoot,task.id));
  const existingRun = resume && store.listRuns().find(run => run.taskId === task.id);
  const started = existingRun ? { run: existingRun } : await api(`/api/tasks/${task.id}/run`, {}); const runId = started.run.id;
  console.log(`EVIDENCE ${root} TASK ${task.id} RUN ${runId}`);
  if (resume && existingRun?.status === "failed" && existingRun.failure?.phase === "workspace_preparation") {
    await api(`/api/runs/${runId}/retry-orchestration`, {});
  }
  if(resume && process.env.AGENTFORGE_DEVELOPMENT_E2E_REPAIR_PROBE === '1') {
    await api(`/api/runs/${runId}/messages`, {recipientAgentId:developer.id,content:'测试操作者拒绝当前失败探针证据：你在非零退出命令后追加 echo，导致 Bash 工具整体返回 0。请通过一次独立 Bash 调用严格执行 node -e "console.error(\'EXPECTED_FAILURE_PROBE\');process.exit(1)"。不要追加 echo、分号后的命令、|| true 或任何吞掉退出码的包装，工具自身必须返回失败。此预期失败不是代码缺陷；随后再用另一次独立调用运行代码测试。保留现有源码和技能/MCP 核验值，更新自己的开发报告记录这次真实失败与修正。请项目经理重新复核，仍等待人类确认。'});
  }
  await page.goto(`${origin}/runs/${runId}`);
  const workspace = await wait("real code delivery and independent review", async () => {
    const w = await api(`/api/runs/${runId}/workspace?view=summary`);
    if (taskCliMode) {
      const progress = await taskCli(['tasks', 'progress', task.id, '--run', runId]);
      assert.equal(progress.runId, runId);
      if (progress.pendingQuestions.length) {
        assert.equal(clarificationAnswered, false, 'only the intended report-title question is expected');
        const questions = await taskCli(['tasks', 'questions', task.id]);
        const question = questions.items[0];
        assert.ok(question && /标题/.test(question.content), 'real model asked the required question');
        await taskCli(['tasks', 'reply', task.id, '--file', '-'], { content: '拒绝错误问题探针', replyToMessageId: 'missing_question' }, 4);
        await taskCli(['tasks', 'message', task.id, '--file', '-'], { content: '这是一条普通排队消息，不是澄清回答。继续等待人类明确回答报告标题。', recipientAgentId: question.sender.id });
        const before = (await api(`/api/runs/${runId}/workspace?view=summary`)).traces.length;
        await sleep(2500);
        const blocked = await taskCli(['tasks', 'progress', task.id]);
        assert.ok(blocked.pendingQuestions.some(item => item.id === question.id));
        assert.equal((await api(`/api/runs/${runId}/workspace?view=summary`)).traces.length, before, 'no invocation starts while human question is unanswered');
        await page.screenshot({ path: 'screenshots/task-cli-human-blocked.png' });
        await taskCli(['tasks', 'reply', task.id, '--file', '-'], { content: '最终开发报告标题采用「内部知识工具开发验收」；现在继续既定代码开发、独立测试及复核，仍由人类最终确认。', replyToMessageId: question.id });
        clarificationAnswered = true;
        await taskCli(['tasks', 'reply', task.id, '--file', '-'], { content: '过期问题重复回复探针', replyToMessageId: question.id }, 4);
        console.log('PASS real task CLI clarification: invalid question refused, ordinary message stayed blocked, exact reply resumed and duplicate refused');
        return null;
      }
      if (w.run.status === 'awaiting_human') return null;
    }
    if (["failed", "awaiting_human"].includes(w.run.status)) throw new Error(`Unexpected Run status: ${w.run.status}`);
    return w.run.status === "awaiting_acceptance" ? w : null;
  }, 2700000);
  assert.equal(workspace.run.confirmedBy ?? null, null);
  if (taskCliMode) {
    assert.equal(clarificationAnswered, true, 'real human clarification and CLI reply must happen');
    assert.ok((await taskCli(['tasks', 'collaboration', task.id, '--all'])).items.some(item => item.canReply === false && item.content.includes('内部知识工具开发验收')));
    assert.ok((await taskCli(['tasks', 'artifacts', task.id, '--all'])).items.some(item => item.name.endsWith('/task-search.mjs')));
    await taskCli(['tasks', 'confirm', task.id], undefined, 2);
  }
  const executionEvidence = [];
  for (const member of workspace.run.participants.filter(item => item.id !== 'human_operator')) {
    const events = (await api(`/api/runs/${runId}/console?agentId=${member.id}&limit=500`)).events;
    for (const event of events.filter(e => e.data?.contentRef)) {
      const content = await api(`/api/runs/${runId}/console-content/${event.id}`);
      executionEvidence.push({ eventId: event.id, memberId: member.id, status: event.data.status, presentation: event.data.presentation, fields: content.fields });
    }
  }
  assert.ok(executionEvidence.some(e => e.fields.text?.text), 'actual assistant text, not a placeholder');
  assert.ok(executionEvidence.some(e => e.fields.input?.text.includes('node')), 'actual command input');
  assert.ok(executionEvidence.some(e => e.fields.output?.text), 'actual tool output');
  const failedProbe = executionEvidence.find(e => e.status === 'failed' && e.fields.output?.text.includes('EXPECTED_FAILURE_PROBE'));
  assert.ok(failedProbe, 'real non-zero tool result retained as failed');
  assert.equal((await fetch(`${origin}/api/runs/${runId}/console-content/${failedProbe.eventId}`)).status, 401, 'content requires authentication');
  await writeFile(join(root, 'execution-evidence.json'), JSON.stringify(executionEvidence, null, 2));
  const source = workspace.artifacts.find(a => a.name.endsWith("/task-search.mjs"));
  assert.ok(source, "real source Artifact captured");
  const content = await api(`/api/runs/${runId}/artifacts/${source.id}/content`);
  assert.equal(createHash("sha256").update(content.content).digest("hex"), source.sha256);
  const sourcePath = join(workspace.run.task.workspacePath, source.name);
  const { stdout } = await promisify(execFile)(process.execPath, ["--test", "--test-reporter=tap", join(sourcePath, "..", "task-search.test.mjs")]);
  assert.match(stdout, /# fail 0/);
  await writeFile(join(root, "independent-tests.txt"), stdout);
  await page.goto(`${origin}/runs/${runId}`); await page.locator("[data-open-completion-confirm]").waitFor();
  assert.equal(await page.locator(".workspace-details").isVisible(), false);
  assert.equal(await page.locator('.workspace-mode-tabs [data-toggle-task-details]').count(), 1);
  await page.locator('[data-toggle-task-details]').click();
  assert.equal(await page.locator('.workspace-details').isVisible(), true);
  await page.locator('[data-toggle-task-details]').click();
  await page.locator("#directory-mode").click();
  await page.locator(`[data-select-working-file="${source.name}"]`).click();
  await page.locator("#working-directory-panel .code-preview").waitFor();
  await page.screenshot({ path: "screenshots/development-directory-e2e.png" });
  await page.locator('#console-mode').click();
  await page.locator(`[data-select-agent="${developer.id}"]`).click();
  // A single loaded page has an intentionally empty (hidden) controls block.
  // Wait for actual member events, not for pagination controls to be visible.
  await page.locator(".console-history-controls").waitFor({ state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('.console-history-controls')?.textContent.includes('正在加载') && document.querySelector('#trace-stream .log-row:not(.log-row-trace-prompt)'));
  // Rework may put the failed probe in a later Trace than the source Artifact.
  // Use the visible all-invocations command rather than assuming one Trace.
  if(await page.locator('[data-console-reset]').count()) await page.locator('[data-console-reset]').click();
  await page.waitForFunction(() => !document.querySelector('.console-history-controls')?.textContent.includes('正在加载'));
  while(await page.locator('[data-console-older]').count()) {
    await page.locator('[data-console-older]').click();
    await page.waitForFunction(() => !document.querySelector('.console-history-controls')?.textContent.includes('正在加载'));
  }
  for (const group of await page.locator('.console-tool-group > summary').all()) await group.click();
  await page.locator(".console-tool-call:visible > summary").first().waitFor();
  await page.locator(".console-tool-call:visible > summary").first().click();
  assert.equal(await page.locator(".console-tool-call[open]").count() > 0, true);
  await page.locator('.execution-content [data-execution-kind="input"]').first().waitFor({ state: 'attached' });
  await page.locator('.execution-content [data-execution-kind="output"]').first().waitFor({ state: 'attached' });
  assert.ok(await page.locator('.console-tool-call.failed').count() > 0);
  const failedTool = page.locator('.console-tool-call.failed').first();
  if (await failedTool.getAttribute('open') === null) await failedTool.locator(':scope > summary').click();
  await failedTool.locator('[data-execution-kind="output"]').waitFor();
  assert.match(await failedTool.textContent(), /EXPECTED_FAILURE_PROBE/);
  await page.screenshot({ path: "screenshots/development-console-e2e.png" });
  if (verifyMarketplace) await verifyMarketplace(workspace,executionEvidence);
  await page.locator("[data-open-completion-confirm]").click();
  assert.equal(await page.locator("#confirm-completion").isDisabled(), true);
  await page.locator("#ack-completion").check(); await page.locator("#confirm-completion").click();
  await wait("explicit human acceptance", async () => (await api(`/api/runs/${runId}/workspace?view=summary`)).run.status === "completed");
  const completed = await api(`/api/runs/${runId}/workspace?view=summary`);
  assert.equal(completed.run.confirmedBy, "human_operator");
  if (taskCliMode) assert.equal((await taskCli(['tasks', 'progress', task.id])).runStatus, 'completed');
  const unified = [];
  let before = null;
  do {
    const logs = await api(`/api/settings/execution-logs?source=task&limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    unified.push(...logs.items);
    before = logs.hasMore ? logs.nextBefore : null;
  } while (before && unified.length < 10000);
  assert.ok(unified.some(row => row.id === failedProbe.eventId && row.level === "error"));
  assert.ok(unified.some(row => row.runId === runId && row.type === "run.completed" && row.currentStatus === "completed"));
  await writeFile(join(root, "task-logs-evidence.json"), JSON.stringify(unified, null, 2));
  assert.deepEqual(errors, []);
  if (shellEnvTest) assert.ok((await readFile(join(root, 'shell-cli-invocations.txt'), 'utf8')).trim().split('\n').length >= 6, 'real Claude invocations must use the shell-only CLI wrapper');
  await writeFile(join(root, "evidence.json"), JSON.stringify({ result: "PASS", taskId: task.id, runId, artifactId: source.id, sha256: source.sha256, realProvider: "claude", independentTests: "node --test: zero failures", contentRecords: executionEvidence.length, thinkingRecords: executionEvidence.filter(e => e.fields.thinking).length, failedToolEventId: failedProbe.eventId, humanConfirmation: completed.run.confirmedBy, browserErrors: errors }, null, 2));
  console.log(`PASS real development E2E: ${root}`);
} catch (error) {
  console.error("Browser errors:", errors);
  console.error("Isolated backend state:", backend && { exitCode: backend.exitCode, signalCode: backend.signalCode, killed: backend.killed });
  await page?.screenshot({ path: join(root, "failed-page.png") }).catch(() => {});
  throw error;
} finally {
  pluginFixture?.close();
  await browser?.close();
  await desktop?.close();
  store.close();
  if (backend) { try { process.kill(-backend.pid, "SIGTERM"); } catch { backend.kill("SIGTERM"); } }
}
