// Isolated real Electron UI acceptance for role management: directory CRUD,
// search/pagination, employee single-role binding and reference-rejected
// deletion. No Provider calls; never touches the operator's data or session.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAuth } from '../server/auth.mjs';
import { createStore } from '../server/store.mjs';

await mkdir('.data', { recursive: true });
const root = await mkdtemp(resolve('.data/roles-ui-'));
assert.equal(dirname(root), resolve('.data')); assert.match(basename(root), /^roles-ui-[a-zA-Z0-9]+$/);
const home = join(root, 'home'), data = join(root, 'client');
await mkdir(home, { recursive: true, mode: 0o700 });
const password = randomBytes(24).toString('hex');
const auth = createAuth({ databasePath: join(data, 'auth.sqlite') });
await auth.setAdministrator('roles-ui', password);
auth.close();
const seeded = createStore({ databasePath: join(data, 'agentforge.sqlite'), workspaceRoot: join(root, 'work') });
const employee = seeded.listAgents().find(item => item.kind === 'business');
assert.ok(employee, 'default catalog provides a business employee');
seeded.close();

const app = await electron.launch({ args: ['apps/electron/main.mjs'], env: { ...process.env, HOME: home, AGENTFORGE_DESKTOP_DATA_ROOT: data, AGENTFORGE_LOG_DIR: join(root, 'logs') }, timeout: 180000 });
try {
  const page = await app.firstWindow({ timeout: 180000 });
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 60000 });
  await page.waitForLoadState('load');
  const origin = new URL(page.url()).origin;
  const api = (path, body, method = 'POST') => page.evaluate(async ({ path, body, method }) => { const r = await fetch(path, body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : body === null ? { method } : {}); const result = await r.json().catch(() => ({})); return { status: r.status, ...result }; }, { path, body, method });

  // The roles API is authenticated like every other configuration resource.
  const anonymous = await page.evaluate(async () => (await fetch('/api/roles')).status);
  assert.equal(anonymous, 401, 'roles API requires authentication');

  await page.goto(origin + '/login');
  await page.locator('#username').fill('roles-ui');
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('#account-name').waitFor();

  // Roles participates in the same persisted visibility choices as every
  // optional sidebar entry, including empty BUILD groups and default restore.
  await page.goto(origin + '/settings/appearance');
  const roleVisibility = page.getByRole('checkbox', { name: '显示角色', exact: true });
  await roleVisibility.waitFor();
  assert.ok(await roleVisibility.isChecked());
  await roleVisibility.uncheck();
  assert.ok(await page.locator('.nav-item[data-view="roles"]').isHidden());
  await page.reload();
  await roleVisibility.waitFor();
  assert.equal(await roleVisibility.isChecked(), false, 'role visibility survives reload');
  assert.ok(await page.locator('.nav-item[data-view="roles"]').isHidden());
  for (const id of ['agents', 'mcp-marketplace', 'marketplace']) await page.locator(`[data-nav-visible="${id}"]`).uncheck();
  assert.ok(await page.locator('[data-navigation-group="build"]').isHidden(), 'empty BUILD group is hidden');
  await page.locator('[data-reset-navigation]').click();
  assert.ok(await roleVisibility.isChecked());
  assert.ok(await page.locator('.nav-item[data-view="roles"]').isVisible());

  // Standalone BUILD-group navigation entry next to 数字员工.
  await page.locator('.nav-item[data-view="roles"]').click();
  await page.waitForURL(/\/roles$/);
  assert.equal(await page.locator('#breadcrumb-current').textContent(), '角色');
  await page.locator('#roles-view .empty-state').waitFor();
  const roleIcon = page.locator('.nav-item[data-view="roles"] .nav-icon');
  assert.ok(await roleIcon.isVisible());
  const roleMask = await roleIcon.evaluate(node => getComputedStyle(node, '::before').maskImage);
  assert.match(roleMask, /data:image\/svg\+xml/, 'desktop role icon has an SVG mask rather than an unmasked solid square');

  // Create through the modal; only name + plain-text prompt are requested.
  await page.locator('#roles-view .directory-toolbar [data-action="new-role"]').click();
  await page.locator('#role-form [name=name]').fill('界面验收角色');
  await page.locator('#role-form [name=prompt]').fill('UI_ROLE_MARK 第一行只写证据编号。');
  await page.locator('#role-form [type=submit]').click();
  await page.locator('#role-form').waitFor({ state: 'detached' });
  await page.locator('#roles-grid .agent-card h3', { hasText: '界面验收角色' }).waitFor();
  let roles = (await api('/api/roles', null, 'GET')).roles;
  assert.equal(roles.length, 1);
  const role = roles[0];
  assert.deepEqual(Object.keys(role).sort(), ['createdAt', 'id', 'name', 'prompt'].sort(), 'role holds only name and prompt plus system metadata');
  for (const theme of ['minimal', 'warm']) {
    await page.goto(origin + '/settings/appearance');
    await page.locator(`[name="theme"][value="${theme}"]`).check();
    await page.goto(origin + '/roles');
    await page.locator(`[data-edit-role="${role.id}"]`).waitFor();
    assert.ok(await roleIcon.isVisible(), `role icon is visible in ${theme} theme`);
    await page.screenshot({ path: join(root, `roles-${theme}-wide.png`) });
  }

  // Edit the prompt in place.
  await page.locator(`[data-edit-role="${role.id}"]`).click();
  await page.locator('#role-form [name=prompt]').fill('UI_ROLE_MARK_V2 更新后的角色提示词。');
  await page.locator('#role-form [type=submit]').click();
  await page.locator('#role-form').waitFor({ state: 'detached' });
  await page.locator('#roles-grid .agent-card', { hasText: 'UI_ROLE_MARK_V2' }).waitFor();

  // Cards carry a full-width title plus the role ID; duplicate names stay
  // distinguishable in the employee selector by that ID.
  const card = page.locator('#roles-grid .agent-card', { hasText: 'UI_ROLE_MARK_V2' });
  assert.ok((await card.textContent()).includes(role.id), 'role card shows its ID');
  const geometry = await card.evaluate(node => {
    const identity = node.querySelector('.agent-card-identity').getBoundingClientRect();
    const title = node.querySelector('h3').getBoundingClientRect();
    return { cardWidth: node.getBoundingClientRect().width, identityWidth: identity.width, titleHeight: title.height };
  });
  assert.ok(geometry.identityWidth > 100 && geometry.titleHeight < 40, 'title uses the card width instead of a narrow column: ' + JSON.stringify(geometry));
  const duplicate = (await api('/api/roles', { name: '界面验收角色', prompt: 'DUPLICATE_PROMPT_TEXT' })).role;
  await page.locator('.nav-item[data-view="agents"]').click();
  await page.locator(`[data-edit-agent="${employee.id}"]`).click();
  await page.locator('#employee-role').waitFor();
  const optionTexts = await page.locator('#employee-role option').allTextContents();
  for (const candidate of [role, duplicate]) assert.ok(optionTexts.some(text => text.includes(candidate.name) && text.includes(candidate.id)), 'same-name roles are distinguishable by ID: ' + candidate.id);
  await page.locator('#agent-form [data-close-modal]').click();
  await api(`/api/roles/${duplicate.id}`, {}, 'DELETE');
  await page.locator('.nav-item[data-view="roles"]').click();
  await page.locator('#roles-grid .agent-card').first().waitFor();

  // Search filters by name/prompt and restores on clear.
  await page.locator('#roles-search').fill('不存在的关键词');
  await page.getByText('没有匹配的角色', { exact: true }).waitFor();
  await page.locator('#roles-search').fill('UI_ROLE_MARK_V2');
  assert.equal(await page.locator('#roles-grid .agent-card').count(), 1);
  await page.locator('#roles-search').fill('');
  assert.equal(await page.locator('#roles-grid .agent-card').count(), 1);

  // Twenty-per-page pagination follows the shared directory rule.
  for (let index = 0; index < 21; index++) await api('/api/roles', { name: `分页角色-${String(index).padStart(2, '0')}`, prompt: `分页提示词 ${index}` });
  await page.goto(origin + '/roles');
  await page.locator('#roles-grid .agent-card').first().waitFor();
  assert.equal(await page.locator('#roles-grid .agent-card').count(), 20);
  await page.getByText('共 22 条 · 每页 20 条 · 第 1/2 页').waitFor();
  await page.locator('[data-pagination="roles"] [data-page="2"]').click();
  assert.equal(await page.locator('#roles-grid .agent-card').count(), 2);

  // Employee form binds at most one role; the card shows the binding.
  await page.locator('.nav-item[data-view="agents"]').click();
  await page.locator(`[data-edit-agent="${employee.id}"]`).click();
  await page.locator('#employee-role').waitFor();
  const options = await page.locator('#employee-role option').allTextContents();
  assert.ok(options.includes('不绑定角色') && options.some(text => text.startsWith('界面验收角色') && text.includes(role.id)));
  await page.locator('#employee-role').selectOption(role.id);
  await page.locator('#agent-form [type=submit]').click();
  await page.locator('#agent-form').waitFor({ state: 'detached' });
  await page.locator('#agents-grid .agent-card', { hasText: '界面验收角色' }).waitFor();
  assert.equal((await api('/api/agents', null, 'GET')).agents.find(item => item.id === employee.id).roleId, role.id);
  // Persisted selection is shown when the form reopens.
  await page.locator(`[data-edit-agent="${employee.id}"]`).click();
  assert.equal(await page.locator('#employee-role').inputValue(), role.id);
  await page.locator('#agent-form [data-close-modal]').click();

  // A bound role cannot be deleted; the referencing employee is listed in place.
  await page.locator('.nav-item[data-view="roles"]').click();
  await page.locator('#roles-search').fill('界面验收角色');
  await page.locator(`[data-delete-role="${role.id}"]`).click();
  await page.locator('[data-confirm-configuration-delete]').click();
  await page.locator('[data-delete-error]', { hasText: employee.name }).waitFor();
  await page.locator('#modal-close').click();

  // Narrow window keeps the toolbar usable.
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(item => item.isVisible()); window.setSize(760, 800); });
  await page.waitForFunction(() => innerWidth <= 760);
  assert.ok(await roleIcon.isVisible(), 'role SVG remains visible in narrow icon-only navigation');
  const toolbar = await page.locator('#roles-view .directory-toolbar').evaluate(node => {
    const search = node.querySelector('input').getBoundingClientRect(), button = node.querySelector('button').getBoundingClientRect();
    return { separate: search.right <= button.left, fits: button.right <= innerWidth };
  });
  assert.deepEqual(toolbar, { separate: true, fits: true }, 'narrow layout keeps search and create on one usable row');
  await page.screenshot({ path: join(root, 'roles-narrow.png') });

  // Unbind, then deletion succeeds.
  await page.locator('.nav-item[data-view="agents"]').click();
  await page.locator(`[data-edit-agent="${employee.id}"]`).click();
  await page.locator('#employee-role').selectOption('');
  await page.locator('#agent-form [type=submit]').click();
  await page.locator('#agent-form').waitFor({ state: 'detached' });
  assert.equal((await api('/api/agents', null, 'GET')).agents.find(item => item.id === employee.id).roleId, null);
  await page.locator('.nav-item[data-view="roles"]').click();
  await page.locator('#roles-search').fill('界面验收角色');
  await page.locator(`[data-delete-role="${role.id}"]`).click();
  await page.locator('[data-confirm-configuration-delete]').click();
  await page.locator('#modal-backdrop[aria-hidden="true"]').waitFor({ state: 'attached' });
  assert.equal((await api('/api/roles', null, 'GET')).roles.some(item => item.id === role.id), false);
  await page.getByText('没有匹配的角色', { exact: true }).waitFor();

  await page.screenshot({ path: join(root, 'roles-ui.png') });
  console.log('PASS roles UI acceptance; evidence: ' + root);
} finally {
  await app.close();
}
