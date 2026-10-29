// Isolated real UI/API acceptance. REAL=1 uses the operator's existing Claude
// login read-only; it never modifies credentials, real instances or projects.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createStore } from '../server/store.mjs';
import { createAuth } from '../server/auth.mjs';

const real = process.env.AGENTFORGE_COMMUNICATION_E2E_REAL === '1';
const packaged = process.env.AGENTFORGE_COMMUNICATION_E2E_PACKAGED === '1';
if (real && packaged) throw new Error('真实 Provider 在源码隔离客户端验证；安装包验收仅使用隔离 HOME，不连接操作者安装实例');
await mkdir('.data', { recursive: true });
const root = await mkdtemp(resolve('.data/communication-workbench-'));
const home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
const data = packaged ? join(home, '.agentforge/desktop') : join(root, 'client');
const password = randomBytes(24).toString('hex');
const auth = createAuth({ databasePath: join(data, 'auth.sqlite') });
await auth.setAdministrator('communication-qa', password); auth.close();
const store = createStore({ databasePath: join(data, 'agentforge.sqlite'), workspaceRoot: join(root, 'work') });
store.updateWorkspaceSettings({ workspaceRoot: join(root, 'work') });
const missing = store.saveRuntimeProfile({ name: 'Controlled unavailable CLI', provider: 'claude-code', executable: join(root, 'missing-cli') });
const failedAgent = store.createAgent({ name: '失败诊断验收', runtime: { profileId: missing.id } });
let profileId = missing.id;
if (real) {
  const actual = execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim(), wrapper = join(root, 'real-claude');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(wrapper, '#!/bin/sh\nHOME=' + quote(homedir()) + ' exec ' + quote(actual) + ' "$@"\n', { mode: 0o700 });
  profileId = store.saveRuntimeProfile({ name: 'Real read-only Claude acceptance', provider: 'claude-code', executable: wrapper }).id;
}
const employee = store.createAgent({ name: '知识材料核对', description: '只根据真实文件核对企业内部材料', systemPrompt: '需要文件证据时实际读取附件。明确区分失败与已核对事实，不猜测附件内容、不联网、不修改业务文件。', runtime: { profileId } });
const chat = store.openCommunication({ kind: 'agent', targetId: employee.id });
const other = store.openCommunication({ kind: 'agent', targetId: failedAgent.id });
const manager = store.listAgents().find(row => row.kind === 'manager');
const team = store.createTeam({ name: '沟通工作台验收', managerAgentId: manager.id, memberAgentIds: [employee.id, failedAgent.id] });
const group = store.openCommunication({ kind: 'team', targetId: team.id });
if (!real) {
  // Clearly labelled UI pagination fixture, never passed off as a real Provider.
  store.sendCommunication(group.id, { content: '隔离分页夹具', mentionAgentIds: [failedAgent.id], clientRequestId: 'controlled-history-fixture' });
  const delivery = store.claimCommunication(group.id);
  for (let i = 0; i < 65; i++) store.appendCommunicationEvent(group.id, delivery.id, { providerEventType: 'fixture', message: '隔离分页夹具记录 ' + i });
  store.completeCommunication(group.id, delivery.id, '隔离分页夹具完成，不是真实 Provider。');
}
store.close();
const app = await electron.launch({ ...(packaged ? { executablePath: resolve('release/mac-arm64/AgentForge.app/Contents/MacOS/AgentForge') } : {}), args: packaged ? [] : ['apps/electron/main.mjs'], env: { ...process.env, HOME: home, AGENTFORGE_LOG_DIR: join(root, 'logs'), AGENTFORGE_DESKTOP_DATA_ROOT: data }, timeout: 60000 });
const errors = [], evidence = { root, real, packaged };
const wait = async (label, check, timeout = 180000) => { const start = Date.now(); let reported = 0; while (Date.now() - start < timeout) { const value = await check(); if (value) return value; if (Date.now() - reported > 30000) { console.log('WAIT ' + label); reported = Date.now(); } await new Promise(done => setTimeout(done, 500)); } throw new Error('Timed out: ' + label); };
try {
  const page = await app.firstWindow({ timeout: 60000 }); await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 60000 });
  const origin = new URL(page.url()).origin;
  const api = (path, body, method = body ? 'POST' : 'GET') => page.evaluate(async ({ path, body, method }) => { const response = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) }); const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result; }, { path, body, method });
  const login = async p => { await p.goto(origin + '/login'); await p.locator('#username').fill('communication-qa'); await p.locator('#password').fill(password); await p.getByRole('button', { name: '登录', exact: true }).click(); await p.locator('#account-name').waitFor(); };
  page.on('pageerror', error => errors.push(error.message)); await login(page);
  // Install actual local market entries; colors are presentation only.
  const market = join(root, 'market'); await mkdir(join(market, '.claude-plugin'), { recursive: true });
  const plugins = [];
  for (let index = 0; index < 5; index++) {
    const name = 'knowledge-kit-' + index, path = join(market, name); plugins.push({ name, source: './' + name });
    await mkdir(join(path, '.claude-plugin'), { recursive: true });
    await writeFile(join(path, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'Local visual acceptance fixture' }));
    await mkdir(join(path, 'skills/proof'), { recursive: true }); await writeFile(join(path, 'skills/proof/SKILL.md'), '---\nname: proof\ndescription: Visual fixture\n---\nRead only.');
    await api('/api/runtime/mcp-marketplace', { name: '知识 MCP ' + index, description: 'Local visual acceptance fixture', content: JSON.stringify({ mcpServers: { ['proof' + index]: { command: 'node', args: ['-e', 'process.exit(0)'] } } }) });
  }
  await writeFile(join(market, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'workbench-fixture', owner: { name: 'QA' }, plugins }));
  await api('/api/runtime/marketplace', { path: market });
  for (const view of ['marketplace', 'mcp-marketplace']) {
    await page.goto(origin + '/' + view); await page.locator('.extension-card-heading .agent-card-avatar').first().waitFor();
    const avatars = await page.locator('.extension-card-heading .agent-card-avatar').evaluateAll(nodes => nodes.map(node => ({ color: getComputedStyle(node).backgroundColor, className: node.className, label: node.textContent })));
    assert.equal(avatars.length, 5); assert.ok(avatars.every(row => /color-(violet|cyan|amber|blue|green)/.test(row.className)));
    evidence[view] = avatars; await page.screenshot({ path: join(root, view + '.png') });
  }
  await page.goto(origin + '/communication/' + chat.id); await page.locator('.communication-heading').filter({ hasText: employee.name }).waitFor();
  assert.equal(await page.locator('label[for=communication-input]').count(), 0);
  assert.equal(await page.locator('.communication-contact i').count(), 0);
  const draft = page.locator('#communication-input'); await draft.fill('切换控制台时保留的草稿');
  const toggle = page.locator('[data-toggle-communication-console]'); await toggle.click();
  await page.locator('[data-communication-console]:not([hidden])').waitFor();
  const widths = await page.locator('.communication-chat, .communication-console').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  assert.ok(Math.abs(widths[0] - widths[1]) < 2);
  const assertSplitHeaders = async p => {
    const geometry = await p.evaluate(() => {
      const rect = selector => { const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width, height }; };
      return { left: rect('.communication-header'), toolbar: rect('.communication-console-toolbar'), chat: rect('.communication-chat'), console: rect('.communication-console'), toggle: rect('[data-toggle-communication-console]') };
    });
    assert.equal(await p.locator('.communication-chat > .communication-header [data-toggle-communication-console]').count(), 1);
    assert.equal(await p.locator('.communication-console-header, [data-close-communication-console]').count(), 0);
    assert.deepEqual(await p.locator('.communication-console-toolbar button').allTextContents(), ['↓ 最新', '刷新']);
    assert.equal(await p.locator('.communication-console-toolbar [data-communication-members], .communication-console-toolbar [data-communication-console-older]').count(), 0);
    assert.ok(Math.abs(geometry.left.y - geometry.console.y) < 1);
    assert.ok(Math.abs(geometry.toolbar.y - geometry.console.y) < 1);
    assert.ok(Math.abs(geometry.left.width - geometry.chat.width) < 2);
    assert.ok(geometry.toggle.x + geometry.toggle.width <= geometry.left.x + geometry.left.width);
    return geometry;
  };
  evidence.headers = await assertSplitHeaders(page);
  await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await draft.inputValue(), '切换控制台时保留的草稿');
  await toggle.click(); await toggle.click(); assert.equal(await draft.inputValue(), '切换控制台时保留的草稿');
  const a = randomBytes(12).toString('hex'), b = randomBytes(12).toString('hex');
  const buffers = [Buffer.from('项目：知识库升级\n核对码：' + a + '\n'), Buffer.from('项目：内容审核\n核对码：' + b + '\n')];
  await page.locator('[data-chat-file]').setInputFiles([{ name: '待移除.md', mimeType: 'text/plain', buffer: Buffer.from('never uploaded') }]);
  await page.locator('[data-remove-chat-attachment]').click(); assert.equal(await page.locator('[data-remove-chat-attachment]').count(), 0);
  await page.locator('[data-chat-file]').setInputFiles(buffers.map(buffer => ({ name: '知识清单.md', mimeType: 'text/markdown', buffer })));
  await draft.fill(real ? '我是企业知识内容负责人。请核对本条两个同名附件：先使用 Read 试读会话主目录 attachments/不存在的材料.md，确认缺失后，再分别实际读取两个真实附件，报告每个项目和唯一核对码。再调用一次只读 Bash 的 wc -c 核对两个文件总字节数。用中文简报列出事实与证据位置；不猜测、不联网、不修改文件，不创建任务。' : '只用于隔离客户端文件与失败控制台验收。');
  await page.locator('.communication-composer [type=submit]').click();
  await wait('attachments sent', async () => (await api('/api/communications/' + chat.id)).messages.find(row => row.sender.type === 'human' && row.attachments?.length === 2));
  const initial = await api('/api/communications/' + chat.id), attachments = initial.messages[0].attachments;
  assert.notEqual(attachments[0].path, attachments[1].path);
  for (let index = 0; index < attachments.length; index++) {
    const actual = await readFile(join(data, 'agentforge-runs/communications', chat.id, attachments[index].path)); assert.deepEqual(actual, buffers[index]);
    assert.equal(createHash('sha256').update(actual).digest('hex'), attachments[index].sha256);
  }
  assert.equal(initial.conversation.unreadCount, 0); assert.equal(await page.locator('.communication-contact i').count(), 0);
  // Leave the receiving chat before its reply; only incoming unread content lights it up.
  await page.goto(origin + '/communication/' + other.id); await page.locator('.communication-heading').filter({ hasText: failedAgent.name }).waitFor();
  if (real) {
    const received = await wait('real Claude attachment review', async () => { const value = await api('/api/communications/' + chat.id); const reply = value.messages.find(row => row.sender.type === 'agent'); if (reply) return { value, reply }; const failed = value.deliveries.find(row => row.status === 'failed'); if (failed) throw new Error('Real Runtime failed: ' + failed.error); }, 600000);
    assert.ok(received.reply.content.includes(a) && received.reply.content.includes(b), 'employee actually read both unpredictable attachment markers');
    assert.equal(received.value.conversation.unreadCount, 1);
    await page.locator(`[data-chat-id="${chat.id}"] .communication-unread`).waitFor();
    evidence.reply = received.reply; console.log('PASS real employee read both duplicate-name attachments; outgoing did not mark unread, incoming did');
  }
  await page.goto(origin + '/communication/' + chat.id); await page.locator('.communication-heading').filter({ hasText: employee.name }).waitFor();
  if (real) await wait('visible read acknowledgement', async () => (await api('/api/communications/' + chat.id)).conversation.unreadCount === 0);
  await page.locator('[data-toggle-communication-console]').click();
  await page.locator('[data-communication-stream] .log-row').first().waitFor();
  assert.equal(await page.locator('[data-communication-members]').isVisible(), false);
  assert.equal(await page.locator('[data-communication-agent]').count(), 0);
  const consoleData = await api('/api/communications/' + chat.id + '/console?agentId=' + employee.id + '&limit=200');
  if (real) {
    assert.ok(consoleData.events.some(row => row.data?.contentRef));
    while (await page.locator('[data-communication-console-older]').isVisible()) {
      await page.locator('[data-communication-console-older]').click();
      await page.waitForFunction(() => !document.querySelector('[data-communication-console-older]')?.disabled);
    }
    await page.locator('.console-tool-call').first().waitFor();
    // Open real tool bodies through the same renderer used in Task workspaces.
    for (const row of await page.locator('.communication-console details.console-tool-call').all()) if (!(await row.getAttribute('open'))) await row.locator(':scope > summary').click();
    await page.locator('.communication-console [data-execution-kind=output]').first().waitFor();
    assert.ok(await page.locator('.communication-console .console-tool-call.failed').count());
    await page.locator('.communication-console .console-tool-summary').filter({ hasText: 'wc' }).first().waitFor();
    const prompt = page.locator('.communication-console .prompt-snapshot').first(); await prompt.locator('summary').click();
    await prompt.locator('.prompt-snapshot-text').waitFor(); assert.match(await prompt.innerText(), /会话主目录/);
    await prompt.locator('summary').click();
  }
  await page.locator('[data-communication-console-latest]').click();
  await page.screenshot({ path: join(root, 'client-split-wide.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 560));
  await page.waitForFunction(() => innerWidth === 760);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await assertSplitHeaders(page);
  assert.ok(await page.locator('.communication-composer [type=submit]').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight));
  await page.screenshot({ path: join(root, 'client-split-narrow.png') });
  await page.locator('[data-toggle-communication-console]').click();
  await page.locator('#communication-input').fill('独立保留的后续草稿');
  await page.locator('[data-toggle-communication-console]').click(); await page.locator('[data-toggle-communication-console]').click();
  assert.equal(await page.locator('#communication-input').inputValue(), '独立保留的后续草稿');
  // An actual unavailable CLI must be visible in the conversation Console.
  await api('/api/communications/' + other.id + '/messages', { content: '可控缺失 CLI 失败探针', clientRequestId: randomBytes(12).toString('hex') });
  await wait('controlled missing CLI failure', async () => (await api('/api/communications/' + other.id)).deliveries.some(row => row.status === 'failed'));
  await page.goto(origin + '/communication/' + other.id); await page.locator('[data-toggle-communication-console]').click();
  await page.locator('[data-communication-stream]').getByText(/CLI|启动|missing/i).first().waitFor();
  assert.equal(await page.locator('.communication-contact i').count(), 0);
  await page.screenshot({ path: join(root, 'client-failure-console.png') });
  // Group member selection and ordinary Web presentation share commands, not host styles.
  await page.goto(origin + '/communication/' + group.id); await page.locator('[data-toggle-communication-console]').click();
  await page.locator('[data-communication-agent]').first().waitFor(); assert.equal(await page.locator('[data-communication-agent]').count(), 3);
  assert.equal(await page.locator('.communication-console-toolbar [data-communication-agent]').count(), 0);
  await page.locator(`[data-communication-agent="${failedAgent.id}"]`).click();
  await page.waitForFunction(id => document.querySelector(`[data-communication-agent="${id}"]`)?.getAttribute('aria-pressed') === 'true', failedAgent.id);
  await assertSplitHeaders(page);
  if (!real) {
    const older = page.locator('[data-communication-console-older]');
    await older.waitFor(); assert.equal(await page.locator('.communication-console-toolbar [data-communication-console-older]').count(), 0);
    await older.click(); await page.waitForFunction(() => document.querySelector('[data-communication-console-older]').hidden);
    assert.equal(await page.locator('[data-communication-stream] .log-row').filter({ hasText: '隔离分页夹具记录' }).count(), 65, 'all fixture history retained after paging');
  }
  const loginResponse = await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'communication-qa',password})});
  const cookie = loginResponse.headers.get('set-cookie').match(/agentforge_session=[a-f0-9]+/)[0];
  const upload = (name, bytes, originHeader = origin, authenticated = true) => fetch(origin + '/api/communications/' + chat.id + '/attachments?name=' + encodeURIComponent(name), { method: 'POST', headers: { Origin: originHeader, 'Content-Type': 'application/octet-stream', ...(authenticated ? { Cookie: cookie } : {}) }, body: bytes });
  assert.equal((await upload('a.txt', 'x', origin, false)).status, 401);
  assert.equal((await upload('a.txt', 'x', 'http://untrusted.invalid')).status, 403);
  assert.equal((await upload('../escape.txt', 'x')).status, 400);
  assert.equal((await upload('oversize.txt', Buffer.alloc(20 * 1024 * 1024 + 1))).status, 413);
  const cross = await fetch(origin + '/api/communications/' + other.id + '/attachments/' + attachments[0].id, { headers: { Cookie: cookie } }); assert.equal(cross.status, 400);
  assert.deepEqual(errors, []); evidence.browserErrors = errors; evidence.result = 'PASS';
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS communication workbench ${real ? 'REAL Claude' : 'controlled-failure UI'}: ${root}`);
} catch (error) { console.error('Evidence root:', root); throw error; }
finally { await app.close(); }
