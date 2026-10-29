// Opt-in real Provider acceptance: native memory, system instruction updates,
// clarification blocking, independently tested code and visible human sign-off.
import assert from 'node:assert/strict';
import { _electron as electron, chromium } from 'playwright-core';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { createStore } from '../server/store.mjs';
import { createAuth } from '../server/auth.mjs';
import { tomlValue } from '../server/runtime/extensions.mjs';

if (process.env.AGENTFORGE_PROMPT_E2E_REAL !== '1') throw new Error('Requires AGENTFORGE_PROMPT_E2E_REAL=1; never substitutes a fixture for real models');
const resume = process.env.AGENTFORGE_PROMPT_E2E_RESUME;
const root = resume ? resolve(resume) : await mkdtemp(resolve('.data/prompt-e2e-'));
console.log('EVIDENCE ' + root);
assert.equal(dirname(root), resolve('.data')); assert.match(basename(root), /^prompt-e2e-[a-zA-Z0-9]+$/);
const packaged = process.env.AGENTFORGE_PROMPT_E2E_PACKAGED === '1';
const nativeSkills = process.env.AGENTFORGE_NATIVE_SKILLS_REAL === '1';
const taskOnly = process.env.AGENTFORGE_PROMPT_E2E_TASK_ONLY === '1';
const home = join(root, 'home'), data = packaged ? join(home, '.agentforge/desktop') : join(root, 'client'); await mkdir(home, { recursive: true, mode: 0o700 });
const password = randomBytes(24).toString('hex');
const auth = createAuth({ databasePath: join(data, 'auth.sqlite') }); await auth.setAdministrator('prompt-qa', password); auth.close();
const store = createStore({ databasePath: join(data, 'agentforge.sqlite'), workspaceRoot: join(root, 'work') }); store.updateWorkspaceSettings({ workspaceRoot: join(root, 'work') });
const profiles = {};
for (const [provider, command] of [['claude-code', 'claude'], ['codex', 'codex']]) {
  const actual = execFileSync('/usr/bin/which', [command], { encoding: 'utf8' }).trim(), wrapper = join(root, command);
  const q = text => "'" + text.replaceAll("'", "'\\''") + "'";
  const ambient = 'mcp_servers.agentforge_unselected_probe=' + tomlValue({ command: process.execPath, args: [resolve('scripts/marketplace-probe-mcp.mjs'), join(root, 'codex-unselected.log'), 'must-not-start'] });
  await writeFile(wrapper, '#!/bin/sh\nHOME=' + q(homedir()) + ' exec ' + q(actual) + (provider === 'codex' ? ' -c ' + q(ambient) : '') + ' "$@"\n', { mode: 0o700 });
  profiles[provider] = store.listRuntimeProfiles().find(item => item.name === 'Real ' + provider)?.id || store.saveRuntimeProfile({ name: 'Real ' + provider, provider, executable: wrapper }).id;
}
const employee = input => store.listAgents().find(item => item.name === input.name) || store.createAgent(input);
const cc = employee({ name: '原生会话验证', systemPrompt: '请遵循当前入口。回答前在正文前加【系统指令生效】。只调用用户本轮明确请求的工具，记住本会话用户给出的校验码，不猜测。', runtime: { profileId: profiles['claude-code'] } });
const codex = employee({ name: 'Codex 原生会话验证', systemPrompt: cc.systemPrompt, runtime: { profileId: profiles.codex } });
const developer = employee({ name: '实现者', capabilities: ['Node.js', '代码实现'], systemPrompt: '实际实现代码并运行 node --test。在 docs/develop/ 中保存代码、测试和 report.md。报告写出实际命令、结果及错误。业务交接用普通文字即可，不编排流程。', runtime: { profileId: profiles['claude-code'] } });
const tester = employee({ name: '独立测试者', capabilities: ['独立测试', 'Node.js'], systemPrompt: '必须独立读取并实际运行实现者的代码和测试，在 docs/verify/report.md 写真实结果。不要仅信任实现者摘要。完成后以普通文字说明结果，不编排流程。', runtime: { profileId: profiles['claude-code'] } });
const manager = employee({ name: '调度者', kind: 'manager', systemPrompt: '协调本次真实验收。首次调用先向 human consultation 提问“是否按简体中文标题整理器的范围执行？”；得到精确回答后安排 develop，再根据真实交接安排 verify，最后提交人类验收。必须返回有效 managerDecision 并明确 nextAgentId；不自行开发、审校或测试，不凭口头派工声称员工已运行。', runtime: { profileId: profiles['claude-code'] } });
const team = store.listTeams().find(item => item.name === '提示词真实验收') || store.createTeam({ name: '提示词真实验收', managerAgentId: manager.id, memberAgentIds: [developer.id, tester.id] });
const absentCli = join(root, 'not-installed-claude');
const failureProfile = store.listRuntimeProfiles().find(item => item.name === 'Missing CLI verification') || store.saveRuntimeProfile({ name:'Missing CLI verification', provider:'claude-code', executable:absentCli });
const failureManager = employee({ name:'启动失败验证经理', kind:'manager', runtime:{profileId:failureProfile.id} });
const failureTeam = store.listTeams().find(item => item.name === '启动失败验证') || store.createTeam({ name:'启动失败验证', managerAgentId:failureManager.id, memberAgentIds:[developer.id] });
const flow = store.listWorkflowTemplates().find(item => item.name === '实现与独立验证') || store.createWorkflowTemplate({ name: '实现与独立验证', nodes: [
  { id: 'develop', title: '实现标题整理器', staffingGuidance: '选择具备 Node.js 代码实现能力的成员。', deliverable: '在 docs/develop/normalize.mjs 导出 normalizeTitle(value)：字符串 trim、将连续空白折叠为单空格；非字符串抛 TypeError。在 docs/develop/normalize.test.mjs 使用 node:test 覆盖中文、英文、换行、多空白、空串和非法输入，不修改输入；至少六个用例。先单独执行 node -e "process.exit(7)" 记录预期失败，再以另一条命令运行真实测试。写 report.md。', artifactPaths: ['docs/develop/'], dependsOn: [] },
  { id: 'verify', title: '独立验证', staffingGuidance: '选择具备独立测试能力且不是作者的成员。', deliverable: '读取 docs/develop/ 源码及测试，独立运行 node --test docs/develop/normalize.test.mjs；再独立验证至少两个边界。报告放 docs/verify/report.md，写实际命令、退出码、问题和未验证项。', artifactPaths: ['docs/verify/'], dependsOn: ['develop'] }
] });
const existingTask = resume && store.listTasks().find(item => item.title.startsWith('PROMPT-E2E｜'));
const existingRun = existingTask && store.listRuns().find(item => item.taskId === existingTask.id);
const chats = [cc, codex].map(agent => ({ agent, chat: store.openCommunication({ kind: 'agent', targetId: agent.id }) })); store.close();
const web = process.env.AGENTFORGE_PROMPT_E2E_WEB === '1';
if (packaged && web) throw new Error('Packaged acceptance must use the real Electron window, not Web mode');
let app, browser, backend, webOrigin;
if (web) {
  backend = fork(resolve('server/index.mjs'), [], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), HOST: '127.0.0.1', AGENTFORGE_DESKTOP_PORT: '0', AGENTFORGE_BOOTSTRAP_TOKEN: randomBytes(32).toString('hex'), AGENTFORGE_DB_PATH: join(data, 'agentforge.sqlite'), AGENTFORGE_AUTH_DB_PATH: join(data, 'auth.sqlite'), AGENTFORGE_WORKSPACE_ROOT: join(root, 'work'), AGENTFORGE_RUN_FILES_ROOT: join(data, 'agentforge-runs'), AGENTFORGE_RUNTIME_CONFIG_ROOT: join(data, 'runtime-configs'), AGENTFORGE_LOG_DIR: join(root, 'web-logs') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  webOrigin = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated Web startup timeout')), 60000);
    backend.once('exit', code => { clearTimeout(timer); reject(new Error('Isolated Web exited ' + code)); });
    backend.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); done(match[0]); } });
    backend.stderr.on('data', chunk => process.stderr.write(chunk));
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
} else app = await electron.launch({ ...(packaged ? { executablePath: resolve('release/mac-arm64/AgentForge.app/Contents/MacOS/AgentForge') } : {}), args: packaged ? [] : ['apps/electron/main.mjs'], env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), AGENTFORGE_DESKTOP_DATA_ROOT: data, AGENTFORGE_LOG_DIR: join(root, 'logs') }, timeout: 180000 });
const previous = resume ? JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8')) : null;
const evidence = { root, surface: web ? 'headless Chrome / isolated real HTTP service' : packaged ? 'packaged Electron / real models' : 'Electron', providers: previous?.providers || {}, task: null, result: 'RUNNING', priorFailures: previous ? [...(previous.priorFailures || []), previous.error].filter(Boolean) : [] }; let page;
const wait = async (label, check, timeout = 900000) => { const start = Date.now(); let logged = 0; while (Date.now() - start < timeout) { const result = await check(); if (result) return result; if (Date.now() - logged > 30000) { console.log('WAIT ' + label); logged = Date.now(); } await new Promise(done => setTimeout(done, 1000)); } throw new Error('Timed out: ' + label); };
try {
  page = web ? await browser.newPage({ viewport: { width: 1400, height: 950 } }) : await app.firstWindow({ timeout: 180000 });
  if (web) await page.goto(webOrigin + '/login');
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 60000 }); await page.waitForLoadState('load');
  const origin = new URL(page.url()).origin;
  const api = (path, body, method = 'POST') => page.evaluate(async ({ path, body, method }) => { const r = await fetch(path, body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); const result = await r.json(); if (!r.ok) throw new Error(JSON.stringify(result)); return result; }, { path, body, method });
  await page.goto(origin + '/login'); await page.locator('#username').fill('prompt-qa'); await page.locator('#password').fill(password); await page.getByRole('button', { name: '登录', exact: true }).click(); await page.locator('#account-name').waitFor();
  let nativePlugin, nativeProof;
  if(nativeSkills) {
    const source=join(root,'native-plugin'); nativeProof=randomBytes(20).toString('hex');
    for(const dir of ['.claude-plugin','skills/native-check/scripts'])await mkdir(join(source,dir),{recursive:true});
    await writeFile(join(source,'.claude-plugin/plugin.json'),JSON.stringify({name:'native-acceptance',version:'1.0.0',description:'Native Skill acceptance fixture'}));
    await writeFile(join(source,'skills/native-check/SKILL.md'),'---\nname: native-check\ndescription: 执行原生能力验证，生成用户指定的校验文件。\n---\n执行此技能目录中的 scripts/proof.mjs，唯一参数为用户指定的输出文件路径。必须实际运行脚本，不得编造校验值。\n');
    await writeFile(join(source,'skills/native-check/scripts/proof.mjs'),`import{mkdirSync,writeFileSync}from'node:fs';import{dirname}from'node:path';const file=process.argv[2];mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify({proof:${JSON.stringify(nativeProof)}}));console.log('proof file written');`);
    await page.goto(origin+'/marketplace');await page.locator('[data-install-plugin]').click();await page.locator('[name=sourceType][value=local]').check();await page.locator('#market-source').fill(source);await page.locator('#market-entry-form [type=submit]').click();await page.locator('#market-entry-form').waitFor({state:'detached'});
    nativePlugin=(await api('/api/runtime/marketplace')).plugins.find(plugin=>plugin.name==='native-acceptance');assert.ok(nativePlugin);
    evidence.nativePlugin={id:nativePlugin.id,installedThroughUI:true};
  }
  if(taskOnly) { evidence.communicationSkipped = true; consoleLog('TASK ONLY: communication validation is not performed in this run'); }
  for (const { agent, chat } of resume || taskOnly ? [] : chats) {
    const memberDirectory = join(data, 'agentforge-runs/communications', chat.id, agent.id); await mkdir(memberDirectory, { recursive: true });
    if (agent.runtime.provider === 'claude-code') await writeFile(join(memberDirectory, '.mcp.json'), JSON.stringify({ mcpServers: { unselected: { command: process.execPath, args: [resolve('scripts/marketplace-probe-mcp.mjs'), join(root, 'claude-code-unselected.log'), 'must-not-start'] } } }));
    const marker = randomBytes(12).toString('hex');
    await api('/api/communications/' + chat.id + '/messages', { content: '记住本会话校验码：' + marker + '。回复已记住及该码，不使用工具。', clientRequestId: randomBytes(12).toString('hex') });
    const settle = () => wait(agent.name, async () => { const value = await api('/api/communications/' + chat.id); const failed = value.deliveries.find(item => item.status === 'failed'); if (failed) throw new Error(failed.error); return value.deliveries.every(item => item.status === 'done') ? value : null; });
    await settle();
    const historyQuery = '历史工具真实检索-' + randomBytes(8).toString('hex');
    const historyValue = randomBytes(16).toString('hex');
    const { conversation: historyChat } = await api('/api/communications', { kind: 'agent', targetId: developer.id });
    const historyMessage = await api('/api/communications/' + historyChat.id + '/messages', { content: historyQuery + '：' + historyValue, clientRequestId: randomBytes(12).toString('hex') });
    // This is a normal, separately saved message; its random value is not
    // included in the target employee's prompt or native conversation.
    assert.ok(historyMessage);
    const proof = randomBytes(16).toString('hex'), log = join(root, agent.runtime.provider + '-mcp.log');
    const installed = await api('/api/runtime/mcp-marketplace', { name: '会话扩展验证 ' + agent.runtime.provider, description: '隔离本机验收服务', content: JSON.stringify({ mcpServers: { selected_proof: { command: process.execPath, args: [resolve('scripts/marketplace-probe-mcp.mjs'), log, proof] } } }) });
    await api('/api/agents/' + agent.id, { description: '本轮更新简介', capabilities: ['原生会话', 'MCP'], systemPrompt: '当前职责已更新。回复必须以【更新指令生效】开头。只调用用户本轮明确请求的工具；保持原生会话记忆，不读取其他会话或配置。', runtime: { profileId: profiles[agent.runtime.provider], extensionSelection: { pluginIds: nativePlugin?[nativePlugin.id]:[], mcpIds: [installed.id] } } }, 'PUT');
    await api('/api/communications/' + chat.id + '/messages', { content: '复述上轮给你的校验码，并实际调用 read_validation_code 工具，把它返回的 verificationCode 原样写在回复中。另外必须实际使用 agentforge_history 的 search_private_chat 搜索“' + historyQuery + '”，再用 read_context 读取匹配原文，回复原文的随机值和 recordId。'+(nativeSkills?'另外执行原生能力验证，输出 native-proof.json。可以按技能使用文件和脚本工具，但不要读取数据库或凭据。':'只使用这三个 MCP 工具，不读文件或数据库；找不到工具就如实报错。'), clientRequestId: randomBytes(12).toString('hex') });
    const result = await settle();
    const reply = result.messages.filter(item => item.sender.type === 'agent').at(-1); assert.ok(reply.content.includes(marker) && reply.content.includes(proof), 'native memory and an actually called MCP return are required, not a prose capability claim');
    assert.ok(reply.content.includes(historyValue), 'a real history tool result must supply the unprompted random value');
    if(nativeSkills)assert.equal(JSON.parse(await readFile(join(memberDirectory,'native-proof.json'),'utf8')).proof,nativeProof,'native Skill script ran; marker was absent from user/system prompt');
    assert.match(await readFile(log, 'utf8'), /called/); const afterSelected = await readFile(log, 'utf8');
    await api('/api/agents/' + agent.id, { runtime: { profileId: profiles[agent.runtime.provider], extensionSelection: { pluginIds: [], mcpIds: [] } } }, 'PUT');
    await api('/api/communications/' + chat.id + '/messages', { content: '只复述本会话最初校验码，不使用任何工具。', clientRequestId: randomBytes(12).toString('hex') });
    const removed = await settle(); assert.ok(removed.messages.filter(item => item.sender.type === 'agent').at(-1).content.includes(marker));
    assert.equal(await readFile(log, 'utf8'), afterSelected, 'removed MCP is not started or called on resumed turn');
    await assert.rejects(readFile(join(root, agent.runtime.provider + '-unselected.log')), error => error.code === 'ENOENT', 'ambient MCP must never start, even without an explicit extensionSelection field');
    const console = await api('/api/communications/' + chat.id + '/console?agentId=' + agent.id);
    const traces = console.traces; assert.equal(traces.length, 3); assert.equal(new Set(traces.map(trace => trace.providerSessionId)).size, 1); assert.equal(traces[1].sessionMode, 'resume'); assert.equal(traces[2].sessionMode, 'resume');
    for (const name of ['search_private_chat', 'read_context']) assert.ok(console.events.some(event => event.data?.toolResultId && event.data?.toolName?.endsWith(name)), 'native history call/result recorded: ' + name);
    const snapshot = await api('/api/communications/' + chat.id + '/traces/' + traces[1].id + '/prompt');
    assert.match(snapshot.prompt.text, /\[应用系统指令\]/); assert.match(snapshot.prompt.text, /\[本轮输入\]/); assert.ok(!snapshot.prompt.text.includes(marker), 'marker was recalled from native memory, not platform replay');
    assert.match(snapshot.prompt.text, /当前职责已更新/);
    assert.doesNotMatch(snapshot.prompt.text.split('[本轮输入]')[0],/已配置技能文件|mcp__agentforge_history__|installed-plugins|平台已向本次调用注册/);
    if(nativeSkills && agent.runtime.provider==='claude-code')assert.ok(console.events.some(event=>event.data?.toolName==='Skill'&&event.data?.toolUseId),'Claude native Skill activation recorded');
    evidence.providers[agent.runtime.provider] = { reply: reply.content, sameNativeSession: true, noHistoryReplay: true, platformHistoryCalled: true, historyValue, updatedSystemInstructionDispatched: true, updatedPrefixFollowed: reply.content.includes('更新指令生效'), selectedMcpCalled: true, removedMcpNotStarted: true, ambientMcpNotStarted: true };
    await page.goto(origin + '/communication/' + chat.id);
    await page.locator('.communication-message:not(.from-human)').last().waitFor();
    await page.locator('[data-toggle-communication-console]').click();
    await page.locator('[data-communication-stream] .log-row').first().waitFor();
    await page.screenshot({ path: join(root, agent.runtime.provider + '-chat.png') });
    consoleLog('PASS native memory and system instructions: ' + agent.runtime.provider);
  }
  if(nativeSkills)await api('/api/agents/'+developer.id,{systemPrompt:developer.systemPrompt+' 开发前执行原生能力验证，输出 docs/develop/native-proof.json。',runtime:{profileId:profiles['claude-code'],extensionSelection:{pluginIds:[nativePlugin.id],mcpIds:[]}}},'PUT');
  const created = existingTask || await api('/api/tasks', { title: 'PROMPT-E2E｜真实代码与独立测试', objective: '执行完整的标题整理器开发与独立测试，不只写方案。先由经理向人类澄清范围，得到回答再派工。禁止修改外部项目、凭据或远程发布。实现者先执行预期失败探针并记录，再完成真实代码与测试；独立测试者实际测试后交接，经理提交人类验收。', teamId: team.id, workflowTemplateId: flow.id });
  const task = created.task || created; const started = existingRun ? { run: existingRun } : await api('/api/tasks/' + task.id + '/run', {}); const runId = started.run?.id || started.id;
  evidence.task = { taskId: task.id, runId };
  const state = () => api('/api/runs/' + runId + '/workspace?view=summary');
  if (!resume || (await state()).run.status === 'awaiting_human') {
  const blocked = await wait('human clarification', async () => { const w = await state(); if (w.run.status === 'failed') throw new Error(JSON.stringify(w.run.failure)); if(w.run.status === 'awaiting_acceptance')throw new Error('Manager skipped required human clarification and requested acceptance'); return w.run.status === 'awaiting_human' ? w : null; });
  const question = blocked.pendingQuestions.find(item => item.recipient.type === 'human'); assert.ok(question);
  await new Promise(done => setTimeout(done, 2500)); assert.equal((await state()).traces.length, blocked.traces.length);
  await api('/api/runs/' + runId + '/messages', { replyToMessageId: question.id, content: '确认，按此范围执行。请完成实现和独立测试，最后等待我确认。' });
  evidence.clarificationBlocked = true;
  }
  if (resume) {
    const current = await state();
    assert.ok(current.messages.some(item => item.kind === 'clarification_answer' && item.sender.type === 'human'));
    await api('/api/runs/' + runId + '/messages', { recipientAgentId: current.run.manager.id, content: '继续本次验收。此前说明后的协调 JSON 未被旧解析器识别，平台尚未派工；请根据实际 Trace 和产物继续安排未完成工作，明确返回 managerDecision，不把文字声明当作员工已运行。人类范围已确认，不需重复澄清；最终仍等待人类确认。' });
    evidence.resumedSameRun = true;
  }
  const retries = new Set();
  const final = await wait('real code delivery and independent test', async () => { const w = await state(); if (['failed', 'awaiting_human'].includes(w.run.status)) throw new Error('Unexpected status ' + w.run.status); const retry = w.dispatches.find(item => item.status === 'queued' && item.nextRetryAt && !retries.has(item.id + ':' + item.attempts)); if (retry && retries.size < 2) { retries.add(retry.id + ':' + retry.attempts); (evidence.retries ||= []).push({ dispatchId: retry.id, attempt: retry.attempts, error: retry.lastError }); await api('/api/runs/' + runId + '/retry-now', {}); } return w.run.status === 'awaiting_acceptance' ? w : null; }, 1800000);
  assert.ok(final.traces.some(t => t.agentId === developer.id && t.type === 'node' && t.status === 'completed'));
  assert.ok(final.traces.some(t => t.agentId === tester.id && t.type === 'node' && t.status === 'completed'));
  const managerTraces = final.traces.filter(t => t.agentId === final.run.manager.id); assert.ok(managerTraces.length >= 3); assert.equal(new Set(managerTraces.map(t => t.providerSessionId)).size, 1);
  for (const trace of final.traces) {
    const snapshot = await api('/api/runs/' + runId + '/traces/' + trace.id + '/prompt');
    const [system, input] = snapshot.prompt.text.split('[本轮输入]');
    assert.match(system, /执行环境/);
    if (trace.agentId === final.run.manager.id) assert.match(system, /工作流定义/);
    else assert.doesNotMatch(snapshot.prompt.text, /工作流定义|"dependsOn"|"handoffFrom"/);
    assert.match(system, /可咨询角色：/);
    assert.doesNotMatch(system,/已配置技能文件|mcp__agentforge_history__|installed-plugins|平台已向本次调用注册/);
    assert.doesNotMatch(input, /^(角色工作法|团队共享仓库|本次运行目录|群聊\/私聊记录|相关消息：|可咨询角色：)/m);
  }
  const work = final.run.task.workspacePath;
  const output = execFileSync(process.execPath, ['--test', join(work, 'docs/develop/normalize.test.mjs')], { encoding: 'utf8' }); assert.match(output, /fail 0/);
  await readFile(join(work, 'docs/verify/report.md'), 'utf8');
  if(nativeSkills)assert.equal(JSON.parse(await readFile(join(work,'docs/develop/native-proof.json'),'utf8')).proof,nativeProof);
  assert.equal(final.run.confirmedBy ?? null, null);
  await page.goto(origin + '/runs/' + runId); await page.locator('[data-open-completion-confirm]').click(); assert.ok(await page.locator('#confirm-completion').isDisabled()); await page.locator('#ack-completion').check(); await page.locator('#confirm-completion').click();
  const completed = await wait('visible human confirmation', async () => { const w = await state(); return w.run.status === 'completed' ? w : null; }); assert.equal(completed.run.confirmedBy, 'human_operator');
  evidence.task = { ...evidence.task, independentTestOutput: output, humanConfirmation: completed.run.confirmedBy, traceCount: completed.traces.length };
  await page.screenshot({ path: join(root, 'task-completed.png') });
  await api('/api/runs/' + runId + '/messages', { recipientAgentId: developer.id, content: '只答疑，不修改文件或恢复业务流程。请实际使用平台历史工具 search_task_activity 查询本任务“PROMPT-E2E”，回复本任务 ID、当前状态和你的交付文件路径。' });
  const answered = await wait('completed task real history inquiry', async () => { const w = await state(); return w.dispatches.every(d => ['done', 'cancelled'].includes(d.status)) && w.messages.some(m => m.kind === 'inquiry_answer' && m.content.includes(task.id)) ? w : null; });
  assert.equal(answered.run.status, 'completed');
  const full = await api('/api/runs/' + runId + '/workspace');
  assert.ok(full.events.some(e => e.data?.toolResultId && e.data?.toolName?.endsWith('search_task_activity')));
  await page.reload(); await page.locator('.collaboration-row.from-human').last().waitFor();
  assert.equal(await page.locator('.collaboration-review, [data-stop-inquiries]').count(), 0);
  assert.equal(await page.locator('#instruction-text').isEnabled(), true);
  await page.screenshot({ path: join(root, 'completed-task-inquiry.png') });
  if (app) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 600));
  else await page.setViewportSize({ width: 760, height: 600 });
  await page.waitForFunction(() => innerWidth === 760 && innerHeight === 600);
  await page.screenshot({ path: join(root, 'completed-task-inquiry-narrow.png') });
  await api('/api/tasks/' + task.id + '/archive', {}); await page.reload();
  await page.locator('#instruction-text:disabled').waitFor();
  await assert.rejects(api('/api/runs/' + runId + '/messages', { recipientAgentId: developer.id, content: '此请求应因归档被拒绝' }), /归档/);
  evidence.task.completedInquiry = true; evidence.task.archivedReadOnly = true;
  const failureTaskResult=await api('/api/tasks',{title:'CLI 缺失原始错误验证',objective:'仅验证缺失可执行文件，不执行任何业务。',teamId:failureTeam.id,workflowTemplateId:flow.id});
  const failureTask=failureTaskResult.task || failureTaskResult;
  const failureStarted=await api('/api/tasks/'+failureTask.id+'/run',{});
  const failureRunId=failureStarted.run?.id || failureStarted.id;
  const failed=await wait('original startup error',async()=>{const w=await api('/api/runs/'+failureRunId+'/workspace?view=summary');return w.run.status==='failed'?w:null;},60000);
  assert.equal(failed.traces.length,1);assert.match(failed.traces[0].error,/ENOENT/);assert.ok(failed.traces[0].error.includes(absentCli));
  assert.equal(failed.dispatches[0].status,'cancelled');assert.equal(failed.dispatches[0].nextRetryAt,null);
  await assert.rejects(api('/api/runs/'+failureRunId+'/retry-now',{}),/没有等待退避/);
  await page.goto(origin+'/runs/'+failureRunId);await page.locator('#console-mode').click();
  await page.locator('#trace-stream .log-row:visible').filter({hasText:/ENOENT/}).first().waitFor();
  await page.screenshot({path:join(root,'original-runtime-error-narrow.png')});
  if(app)await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1400,950));else await page.setViewportSize({width:1400,height:950});
  await page.waitForFunction(()=>innerWidth===1400 && innerHeight===950);
  await page.screenshot({path:join(root,'original-runtime-error.png')});
  evidence.startupFailure={runId:failureRunId,traceId:failed.traces[0].id,originalError:failed.traces[0].error,automaticRetryStopped:true,visibleInConsole:true};
  evidence.result = 'PASS'; consoleLog('PASS real prompt acceptance: ' + root);
} catch (error) { evidence.result = 'FAIL'; evidence.error = error.stack; throw error; }
finally { await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); await app?.close(); await browser?.close(); backend?.kill('SIGTERM'); }
function consoleLog(value) { console.log(value); }
