// Visible, isolated directory header regression; no Provider execution.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAuth } from '../server/auth.mjs';
import { createCatalogFixtureStore } from '../tests/fixture-store.mjs';

const baseline = process.env.AGENTFORGE_DIRECTORY_HEADERS_BASELINE === '1';
const packaged = process.env.AGENTFORGE_DIRECTORY_HEADERS_PACKAGED === '1';
await mkdir('.data', { recursive: true });
const root = await mkdtemp(resolve('.data/directory-headers-')), home = join(root, 'home');
await mkdir(home, { mode: 0o700 });
const data = packaged ? join(home, '.agentforge/desktop') : join(root, 'client');
const password = randomBytes(24).toString('hex');
const auth = createAuth({ databasePath: join(data, 'auth.sqlite') });
await auth.setAdministrator('directory-qa', password); auth.close();
const store = createCatalogFixtureStore({ databasePath: join(data, 'agentforge.sqlite'), workspaceRoot: join(root, 'work') });
store.updateWorkspaceSettings({ workspaceRoot: join(root, 'work') });
const seedTeam = store.listTeams()[0], seedFlow = store.listWorkflowTemplates()[0];
for (let i = 0; i < 22; i++) {
  store.createTeam({ name: '目录搜索团队 ' + i, mission: 'Search boundary ' + i, managerAgentId: seedTeam.managerAgentId, memberAgentIds: seedTeam.members.filter(m => m.type === 'agent' && m.id !== seedTeam.managerAgentId).map(m => m.id) });
  store.createWorkflowTemplate({ name: '目录搜索流程 ' + i, description: 'Search boundary ' + i, nodes: seedFlow.nodes });
}
store.createTask({ title: '目录工具栏验收', objective: '仅检查列表展示，不启动执行。', teamId: store.listTeams()[0].id, workflowTemplateId: 'software_delivery' });
store.close();
const app = await electron.launch({ ...(packaged ? { executablePath: resolve('release/mac-arm64/AgentForge.app/Contents/MacOS/AgentForge') } : {}), args: packaged ? [] : ['apps/electron/main.mjs'], env: { ...process.env, HOME: home, AGENTFORGE_DESKTOP_DATA_ROOT: data, AGENTFORGE_LOG_DIR: join(root, 'logs') }, timeout: 60000 });
const errors = [], evidence = { baseline, packaged, root, views: [] };
try {
  const page = await app.firstWindow({ timeout: 60000 }); await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 60000 }); await page.waitForLoadState('load');
  const origin = new URL(page.url()).origin;
  const login = async p => { p.on('pageerror', e => errors.push(e.message)); await p.goto(origin + '/login'); await p.locator('#username').fill('directory-qa'); await p.locator('#password').fill(password); await p.getByRole('button', { name: '登录', exact: true }).click(); await p.locator('#account-name').waitFor(); };
  await login(page);
  await page.evaluate(async () => { const r = await fetch('/api/runtime/mcp-marketplace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '目录验收 MCP', description: '只用于卡片参考，不执行服务。', content: JSON.stringify({ mcpServers: { fixture: { command: 'node', args: ['--version'] } } }) }) }); if (!r.ok) throw Error(await r.text()); });
  const views = { tasks: '#tasks-table .task-row, #tasks-table tr', communication: '.communication-sidebar-heading', teams: '#teams-grid .team-card', workflows: '#workflows-grid .workflow-list-row', agents: '#agents-grid .agent-card', 'mcp-marketplace': '.installed-extension-card' };
  const inspect = async (p, mode) => {
    for (const [view, ready] of Object.entries(views)) {
      await p.goto(origin + '/' + view); await p.locator(`#${view}-view.active`).waitFor(); await p.locator(ready).first().waitFor();
      await p.waitForFunction(() => document.querySelector('.application-icon')?.naturalWidth > 0);
      const geometry = await p.locator(`#${view}-view`).evaluate(node => {
        const toolbar = node.querySelector('.directory-toolbar, .page-heading:has(> button)'), list = node.querySelector('#teams-grid, #workflows-grid');
        const rect = el => { const r = el?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom } : null; };
        return { toolbar: rect(toolbar), button: rect(toolbar?.querySelector('button')), list: rect(list), borderTop: list ? getComputedStyle(list).borderTopWidth : null, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      if (!baseline) {
        assert.equal(geometry.overflow, false, `${mode}/${view} fits`);
        if (['teams', 'workflows'].includes(view)) {
          assert.equal(geometry.borderTop, '0px', `${mode}/${view} has no toolbar/list divider`);
          assert.equal(await p.locator(`#${view}-view > .directory-toolbar > button`).count(), 1);
          assert.ok(geometry.list.y - geometry.toolbar.bottom >= 12, 'spacing replaces the divider');
          assert.ok(Math.abs(geometry.button.x + geometry.button.width - geometry.toolbar.x - geometry.toolbar.width) < 1, 'create action stays right-aligned');
          assert.ok(geometry.button.x + geometry.button.width <= await p.evaluate(() => innerWidth));
          await p.locator(`#${view}-view > .directory-toolbar > button`).click(); await p.locator('#modal-backdrop.open').waitFor(); await p.locator('#modal-content h2').waitFor();
          await p.locator('#modal-close').click();
          const search = p.locator(`#${view}-search`);
          await search.fill('目录搜索' + (view === 'teams' ? '团队 21' : '流程 21'));
          const rows = p.locator(view === 'teams' ? '#teams-grid .team-card' : '#workflows-grid .workflow-list-row');
          assert.equal(await rows.count(), 1, 'filter includes entries outside initial 20-row page');
          await search.fill('不存在的目录名称'); assert.equal(await rows.count(), 0);
          assert.match(await p.locator(`#${view}-grid`).innerText(), /没有匹配/);
          await search.clear(); assert.equal(await rows.count(), 20);
          await p.locator(`[data-pagination="${view}"] [data-page="2"]`).click();
          await search.fill('目录搜索' + (view === 'teams' ? '团队 21' : '流程 21'));
          assert.equal(await rows.count(), 1, 'query resets pagination');
          await search.clear();
          evidence[mode + '-' + view + '-search'] = 'PASS';
        }
        if (view === 'tasks') {
          assert.deepEqual(await p.locator('#task-search-form button').allTextContents(), ['搜索', '重置', '归档历史', '＋ 新建任务']);
          assert.equal(await p.locator('#tasks-heading button').count(), 0);
          assert.equal(await p.locator('.topbar').isVisible(), true);
          assert.equal(await p.locator('#breadcrumb-current').innerText(), '任务中心');
          const heading = await p.locator('#tasks-heading').evaluate(node => ({ width: node.offsetWidth, height: node.offsetHeight, position: getComputedStyle(node).position, clip: getComputedStyle(node).clip }));
          assert.deepEqual(heading, { width: 1, height: 1, position: 'absolute', clip: 'rect(0px, 0px, 0px, 0px)' }, 'duplicate title is accessible but occupies no layout space');
          assert.equal(await p.locator('#tasks-heading h2').textContent(), '任务中心');
          const name = p.locator('#task-search-form [name=name]'); await name.fill('目录工具栏验收');
          await p.locator('#task-search-form [type=submit]').click();
          await p.locator('[data-task-center-page=archive]').click();
          assert.equal(await p.locator('#breadcrumb-current').innerText(), '归档历史');
          assert.equal(await p.locator('#tasks-heading h2').textContent(), '归档历史');
          assert.equal(await name.inputValue(), '目录工具栏验收');
          await p.locator('[data-task-center-page=current]').click();
          assert.equal(await p.locator('#breadcrumb-current').innerText(), '任务中心');
          await p.locator('#task-search-form [type=reset]').click();
        }
      }
      evidence.views.push({ mode, view, ...geometry }); await p.screenshot({ path: join(root, `${mode}-${view}.png`) });
    }
  };
  await inspect(page, 'desktop-wide');
  await app.evaluate(({ BrowserWindow }, origin) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith(origin)).setContentSize(760, 600), origin); await page.waitForFunction(() => innerWidth === 760);
  await inspect(page, 'desktop-narrow');
  assert.deepEqual(errors, []); evidence.result = 'PASS'; await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS directory headers:', root);
} catch (error) { console.error('Evidence root:', root); throw error; }
finally { await app.close(); }
