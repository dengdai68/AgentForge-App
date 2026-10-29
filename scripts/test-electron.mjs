import vm from "node:vm";
import {editDiff, workingDirectoryIcon} from "../client/console-projections.mjs";
// Real visible Electron smoke test; uses isolated data, never production credentials.
import { _electron as electron } from "playwright-core";
import { mkdtemp, mkdir, readFile, writeFile, access, stat, symlink, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { desktopStoragePaths } from "../apps/electron/runtime-paths.mjs";
import { createAuth } from "../server/auth.mjs";
import { createCatalogFixtureStore as createStore } from "../tests/fixture-store.mjs";
import { initializeWorkspaceGit } from "../server/workspace-git.mjs";
import { createRunFiles } from "../server/run-files.mjs";
import { promptSnapshot } from "../server/runtime/local-cli.mjs";
import { execute as executeCli } from "../cli/main.mjs";
import { Readable } from "node:stream";

await mkdir(".data", { recursive: true });
await mkdir("screenshots", { recursive: true });
const directory = await mkdtemp(resolve(".data/electron-e2e-"));
const storage = desktopStoragePaths(directory, { home: directory });
const password = randomBytes(24).toString("hex");
const auth = createAuth({ databasePath: storage.AGENTFORGE_AUTH_DB_PATH });
await auth.setAdministrator("desktop-test", password);
auth.close();
const fixtureStore = createStore({ databasePath: storage.AGENTFORGE_DB_PATH, workspaceRoot: storage.AGENTFORGE_WORKSPACE_ROOT });
assert.deepEqual(fixtureStore.listTasks(), []);
const fixtureTask = fixtureStore.createTask({ title: "隔离任务空间验收", objective: "只用于界面回归", teamId: fixtureStore.listTeams()[0].id, workflowTemplateId: "software_delivery" });
assert.ok(fixtureTask.workspacePath.startsWith(join(directory, "agentforge") + "/"));
const fixtureRun = fixtureStore.createRun(fixtureTask.id);
assert.ok(fixtureRun.workspacePath.startsWith(join(directory, "agentforge") + "/"));
await mkdir(join(fixtureRun.workspacePath, "docs/notes"), { recursive: true });
await initializeWorkspaceGit(fixtureRun.workspacePath, []);
await writeFile(join(fixtureRun.workspacePath, "docs/notes/readme.md"), "# 隔离目录阅读测试\n只用于 UI 回归，不是模型交付。\n");
const failureTrace = fixtureStore.createTrace(fixtureRun.id, { agentId: fixtureRun.manager.id, workflowNodeId: fixtureTask.workflowSnapshot.nodes[0].id, type: "manager" });
fixtureStore.completeTrace(failureTrace.id, { status: "failed", error: "CLI 不可启动：检查数字员工的可执行文件路径、服务 PATH 和任务目录是否存在。" });
fixtureStore.addEvent({ type: "trace.failed", runId: fixtureRun.id, actor: { type: "agent", id: fixtureRun.manager.id, name: fixtureRun.manager.name }, message: "CLI 不可启动：检查数字员工的可执行文件路径、服务 PATH 和任务目录是否存在。", data: { traceId: failureTrace.id, auditVersion: 2 } });
fixtureStore.pauseRun(fixtureRun.id, "Isolated presentation fixture; do not execute Provider");
const fixtureFiles = createRunFiles({ root: storage.AGENTFORGE_RUN_FILES_ROOT });
let fixtureThinkingEventId;
for (const [presentation, fields] of Object.entries({
  thinking: { thinking: { text: '公开思考直接阅读，不折叠', redacted: false, truncated: false } },
  tool: { input: { text: '{"result":"<img src=x>","count":9007199254740993,"ok":true}', redacted: false, truncated: false } }
})) {
  const ref = await fixtureFiles.writeConsoleContent(fixtureRun.id, failureTrace.id, { version: 1, fields });
  const event = fixtureStore.addEvent({ type: 'runtime.event', runId: fixtureRun.id, actor: { type: 'agent', id: fixtureRun.manager.id }, message: '展示夹具', data: { auditVersion: 2, traceId: failureTrace.id, presentation, providerEventType: 'assistant', contentRef: ref, ...(presentation === 'tool' ? { toolName: 'StructuredOutput', toolUseId: 'structured-fixture', status: 'completed' } : {}) } });
  if (presentation === 'thinking') fixtureThinkingEventId = event.id;
}
const contentRef = await fixtureFiles.writeConsoleContent(fixtureRun.id, failureTrace.id, { version: 1, fields: { input: { text: 'node --test fixture.test.mjs', redacted: false, truncated: false }, output: { text: 'fixture passed\n<img src=x onerror="alert(1)">', redacted: false, truncated: false } } });
// 2026-10-25 console presentation fixtures: Markdown body, Shell tool content,
// a handoff message in Markdown, and extra tree files for icon mapping.
const markdownRef = await fixtureFiles.writeConsoleContent(fixtureRun.id, failureTrace.id, { version: 1, fields: { text: { text: ["## 交付说明", "", "- 第一项", "- 第二项", "", "| 列 | 值 |", "| --- | --- |", "| a | 1 |", "", "[示例链接](https://example.com)", "", "```js", "const answer = 42;", "```", "", '<img src=x onerror="alert(1)">'].join("\n"), redacted: false, truncated: false } } });
const markdownEvent = fixtureStore.addEvent({ type: "runtime.event", runId: fixtureRun.id, actor: { type: "agent", id: fixtureRun.manager.id, name: fixtureRun.manager.name }, message: "Markdown 正文夹具", data: { auditVersion: 2, traceId: failureTrace.id, presentation: "text", providerEventType: "assistant", contentRef: markdownRef } });
const shellRef = await fixtureFiles.writeConsoleContent(fixtureRun.id, failureTrace.id, { version: 1, fields: { input: { text: JSON.stringify({ command: "echo 开始\n  ls -la /tmp", description: "夹具命令" }), redacted: false, truncated: false }, output: { text: "total 8\ndrwxr-xr-x  2 user  wheel  64\n<img src=x onerror=\"alert(1)\">", redacted: false, truncated: false } } });
const shellEvent = fixtureStore.addEvent({ type: "runtime.event", runId: fixtureRun.id, actor: { type: "agent", id: fixtureRun.manager.id, name: fixtureRun.manager.name }, message: "Shell 工具夹具", data: { auditVersion: 2, traceId: failureTrace.id, presentation: "tool", toolName: "Bash", toolUseId: "fixture-shell-1", status: "completed", contentRef: shellRef } });
fixtureStore.addMessage({ runId: fixtureRun.id, workflowNodeId: "development", sender: { type: "agent", id: fixtureRun.manager.id, name: fixtureRun.manager.name }, recipientAgentId: "agent_analyst", kind: "handoff", content: "交接**重点**：\n\n- 完成列表项\n- 处理 `code` 片段\n\n<img src=x onerror=\"alert(1)\">" });
fixtureStore.addMessage({ runId: fixtureRun.id, workflowNodeId: 'development', sender: { type: 'human', id: 'human_operator', name: '你' }, recipientAgentId: fixtureRun.manager.id, kind: 'instruction', content: `@${fixtureRun.manager.name} 请核对排版与会话记录。` });
const repeatedInput = { input: { text: '{"city":"北京"}', redacted: false, truncated: false } };
for (const callId of ['weather-one-call', 'weather-another-call']) for (const [phase, fields] of [['tool', repeatedInput], ['tool', repeatedInput], ['tool_result', { ...repeatedInput, output: { text: '{"weather":"晴"}', redacted: false, truncated: false } }], ['tool_result', { ...repeatedInput, output: { text: '{"weather":"晴"}', redacted: false, truncated: false } }]]) {
  const contentRef = await fixtureFiles.writeConsoleContent(fixtureRun.id, failureTrace.id, { version: 1, fields });
  fixtureStore.addEvent({ type: 'runtime.event', runId: fixtureRun.id, actor: { type: 'agent', id: fixtureRun.manager.id }, message: 'MCP 展示夹具', data: { auditVersion: 2, traceId: failureTrace.id, presentation: phase, toolName: 'maps_weather', [phase === 'tool' ? 'toolUseId' : 'toolResultId']: callId, status: phase === 'tool' ? 'running' : 'completed', contentRef } });
}
await writeFile(join(fixtureRun.workspacePath, "docs/app.js"), "console.log(1);\n");
await writeFile(join(fixtureRun.workspacePath, "docs/data.json"), "{\"ok\":true}\n");
await writeFile(join(fixtureRun.workspacePath, "docs/strange.xyzq"), "unknown\n");
let fixtureContentEventId = null;
fixtureStore.transaction(() => {
  for (let index = 0; index < 50; index++) {
    const event = fixtureStore.addEvent({ type: "runtime.event", runId: fixtureRun.id, actor: { type: "agent", id: fixtureRun.manager.id }, message: "工具调用", data: { auditVersion: 2, traceId: failureTrace.id, presentation: "tool", toolName: index % 2 ? "Bash" : "Read", toolUseId: `fixture-tool-${index}`, status: "completed", ...(index === 49 ? { contentRef } : {}) } });
    if (index === 49) fixtureContentEventId = event.id;
    fixtureStore.addEvent({ type: "dispatch.retry_requested", runId: fixtureRun.id, actor: { type: "human", name: "测试操作者" }, message: `隔离历史记录 ${index}`, data: {} });
  }
});
// A second invocation of the same member, this time with a real prompt
// snapshot, so the console timeline must bind one prompt entry per Trace.
// Its first visible event is a Bash call adjacent to an identical Bash call of
// the previous Trace: grouping must not merge across invocations.
const promptedTrace = fixtureStore.createTrace(fixtureRun.id, { agentId: fixtureRun.manager.id, workflowNodeId: "development", type: "node" });
fixtureStore.completeTrace(promptedTrace.id, { status: "completed" });
fixtureStore.attachTracePrompt(promptedTrace.id, await fixtureFiles.writePromptSnapshot(fixtureRun.id, promptedTrace.id, promptSnapshot({ systemPrompt: "SYSTEM_PRIVATE_DO_NOT_DISPLAY", prompt: "本行为提示词快照夹具原文。" })));
fixtureStore.addEvent({ type: "runtime.event", runId: fixtureRun.id, actor: { type: "agent", id: fixtureRun.manager.id, name: fixtureRun.manager.name }, message: "第二次调用的首个 Bash", data: { auditVersion: 2, traceId: promptedTrace.id, presentation: "tool", toolName: "Bash", toolUseId: "fixture-shell-head", status: "completed" } });
fixtureStore.addEvent({ type: "runtime.event", runId: fixtureRun.id, actor: { type: "agent", id: fixtureRun.manager.id, name: fixtureRun.manager.name }, message: "第二次调用的正文", data: { auditVersion: 2, traceId: promptedTrace.id, presentation: "text", providerEventType: "assistant" } });
// A fresh invocation with a saved snapshot but no visible events yet: its
// prompt entry must still appear, bound to the Trace record itself.
const silentTrace = fixtureStore.createTrace(fixtureRun.id, { agentId: fixtureRun.manager.id, workflowNodeId: "testing", type: "node" });
fixtureStore.attachTracePrompt(silentTrace.id, await fixtureFiles.writePromptSnapshot(fixtureRun.id, silentTrace.id, promptSnapshot({ systemPrompt: "SYSTEM_PRIVATE_DO_NOT_DISPLAY", prompt: "静默调用快照原文。" })));
const desktop = await electron.launch({ args: ["apps/electron/main.mjs", `--user-data-dir=${join(directory, "profile")}`], env: {
  ...process.env,
  // Isolate the whole data home: the child control plane drops inherited
  // AGENTFORGE_* values, so only HOME keeps its diagnostics out of the
  // operator's real ~/.agentforge.
  HOME: directory,
  AGENTFORGE_DESKTOP_DATA_ROOT: directory
}, timeout: 60000 });
const actualPaths=await desktop.evaluate(({app})=>Object.fromEntries(['userData','sessionData','logs','crashDumps'].map(key=>[key,app.getPath(key)])));
for(const path of Object.values(actualPaths)) assert.ok(path.startsWith(directory+'/'),'all Electron paths use isolated instance root');
async function verifyDirectorySearch(page, prefix, view) {
  const root=page.locator(`#${view}-view`),search=root.locator('.directory-toolbar input');
  const cards=root.locator(view==='agents'?'.agent-card':'.installed-extension-card');
  await cards.first().waitFor();
  const count=await cards.count(),name=await cards.first().locator(view==='agents'?'h3':'.extension-name').textContent();
  const row=await root.locator('.directory-toolbar').evaluate(node=>{
    const search=node.querySelector('input').getBoundingClientRect(),button=node.querySelector('button').getBoundingClientRect();
    return {aligned:Math.abs(search.y+search.height/2-button.y-button.height/2)<2,separate:search.right<button.left,fits:button.right<=innerWidth};
  });
  assert.deepEqual(row,{aligned:true,separate:true,fits:true},`${prefix} ${view} search and action share a row`);
  assert.equal(await root.getByText(/搜索已安装/).count(),0);
  await search.fill(name.toLowerCase());await page.waitForFunction(({view,name})=>{
    const root=document.querySelector(`#${view}-view`),cards=[...root.querySelectorAll(view==='agents'?'.agent-card':'.installed-extension-card')];
    return cards.length>0 && cards.every(card=>card.textContent.toLowerCase().includes(name));
  },{view,name:name.toLowerCase()});
  await search.fill('NOT-FOUND-66');await root.getByText(view==='agents'?'没有匹配的数字员工':'没有匹配项',{exact:true}).waitFor();
  await search.fill('');assert.equal(await cards.count(),count);
  if(view==='agents' && prefix==='electron') {
    const ids=await page.evaluate(async()=>{
      const ids=[];for(let i=0;i<21;i++) {
        const response=await fetch('/api/agents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:`Directory-66-${String(i).padStart(2,'0')}`,description:i===0?'':i===1?'Short description':'Long description for stable card layout. '.repeat(15),capabilities:i===2?['Node.js','测试','很长的能力标签用于检查卡片裁切']:[]})});
        if(!response.ok)throw new Error('Could not create isolated search fixture');ids.push((await response.json()).agent.id);
      }return ids;
    });
    await page.reload();await search.fill('Directory-66');await cards.first().waitFor();await verifyCardGeometry(cards,'employee varying descriptions');
    await page.locator('[data-pagination=agents] [data-page="2"]').click();
    await search.fill('Directory-66-20');await page.getByRole('heading',{name:'Directory-66-20',exact:true}).waitFor();
    assert.equal(await cards.count(),1,'search covers all pages and returns to page one');
    await page.evaluate(async ids=>{for(const id of ids){const response=await fetch(`/api/agents/${id}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error('Could not remove own search fixture');}},ids);
    await search.fill('');await page.reload();await cards.first().waitFor();
    assert.equal(await cards.count(),count);
  }
  await page.screenshot({path:`screenshots/${prefix}-${view}-search.png`,animations:'disabled'});
  console.log(`PASS ${prefix} ${view}: same-row toolbar, case-insensitive search, empty result and clear`);
}
async function verifyCardGeometry(cards,label) {
  const bounds=await cards.evaluateAll(nodes=>nodes.map(n=>({height:n.getBoundingClientRect().height,actions:n.querySelector('.directory-card-actions').getBoundingClientRect().top-n.getBoundingClientRect().top})));
  assert.ok(bounds.length>1,label);
  for(const key of ['height','actions']) assert.ok(Math.max(...bounds.map(x=>x[key]))-Math.min(...bounds.map(x=>x[key]))<2,`${label}: stable ${key}`);
}
async function verifyPluginScroll(page,label) {
  const scroller=page.locator('.extension-detail-modal .modal-scroll');
  const bounds=await scroller.evaluate(n=>({height:n.clientHeight,content:n.scrollHeight,bottom:n.getBoundingClientRect().bottom,viewport:innerHeight}));
  assert.ok(bounds.height>60 && bounds.height<bounds.content,`${label}: component body has a bounded scrolling viewport`);
  assert.ok(bounds.bottom<bounds.viewport);
  await scroller.hover();await page.mouse.wheel(0,20000);
  await page.waitForFunction(()=>{const n=document.querySelector('.extension-detail-modal .modal-scroll');return n.scrollHeight-n.scrollTop-n.clientHeight<2;});
  const last=await page.locator('.plugin-detail-component').last().boundingBox();
  assert.ok(last.y+last.height<=bounds.bottom+2,`${label}: wheel reaches final Skill`);
  const footer=await page.locator('.extension-detail-modal .form-actions').boundingBox();assert.ok(footer.y+footer.height<=bounds.viewport);
  await scroller.evaluate(n=>n.scrollTo({top:0,behavior:'instant'}));
  await page.locator('#plugin-component-panel').focus();
  const initial=await scroller.evaluate(n=>n.scrollTop);await page.keyboard.press('PageDown');
  await page.waitForFunction(initial=>document.querySelector('.extension-detail-modal .modal-scroll').scrollTop>initial,initial);
  await scroller.evaluate(n=>n.scrollTo({top:0,behavior:'instant'}));
  console.log(`PASS ${label}: wheel reaches final Skill, keyboard scrolls and actions stay visible`);
}
async function verifyMarketEmptyState(page,view) {
  const root=page.locator(`#${view}-view`),empty=root.locator('[data-market-empty]');
  await empty.filter({hasText:'尚未安装'}).waitFor();
  assert.equal(await root.locator('[data-market-list]').isVisible(),false);
  const bounds=await empty.evaluate(node=>({grid:Boolean(node.closest('[data-market-list]')),width:node.getBoundingClientRect().width,parent:node.parentElement.getBoundingClientRect().width}));
  assert.equal(bounds.grid,false);assert.ok(bounds.width>bounds.parent*.85,'directory empty state spans the page rather than a card column');
}
async function verifyExtensionPickerDismissal(page,prefix) {
  for(const [kind,query] of [['plugin','ui-proof'],['mcp','desktop_']]){
    const picker=page.locator(`[data-picker=${kind}]`),input=picker.locator('input'),list=picker.locator('[role=listbox]'),chips=picker.locator('.extension-chip'),initial=await chips.count();
    await input.click();await input.fill(query);await list.getByRole('option').first().waitFor();
    await page.locator('.modal h2').hover();await list.waitFor({state:'hidden'});
    assert.equal(await input.getAttribute('aria-expanded'),'false');assert.equal(await input.inputValue(),query);assert.equal(await chips.count(),initial);
    await input.click();await list.waitFor({state:'visible'});
    const box=await input.boundingBox();await page.mouse.move(box.x+20,box.y+box.height+2);assert.equal(await list.isVisible(),true,'input-to-options gap does not dismiss');
    await list.getByRole('option').first().hover();assert.equal(await list.isVisible(),true,'moving into a candidate keeps options open');
    await input.press('Escape');assert.equal(await list.isVisible(),false);assert.equal(await page.locator('#agent-form').isVisible(),true);
    await input.press('ArrowDown');assert.equal(await list.getByRole('option').first().evaluate(n=>n===document.activeElement),true);
    await page.locator('.modal h2').hover();await list.waitFor({state:'hidden'});assert.equal(await input.evaluate(n=>n===document.activeElement),true,'dismissal does not strand focus in hidden options');
    await input.press('ArrowDown');const id=await list.getByRole('option').first().getAttribute('data-add-extension');await page.keyboard.press('Enter');
    assert.equal(await chips.count(),initial+1);assert.equal(await list.isVisible(),false);
    await input.click();await list.waitFor({state:'visible'});await input.press('Shift+Tab');await list.waitFor({state:'hidden'});
    // Shift+Tab may legitimately focus/open the other combobox. Dismiss that
    // keyboard-owned popup before testing removal behind it.
    if(await page.locator('[role=combobox][aria-expanded=true]').count())await page.keyboard.press('Escape');
    await picker.locator(`[data-remove-extension="${id}"]`).click();assert.equal(await chips.count(),initial);assert.equal(await list.isVisible(),false);
  }
  console.log(`PASS ${prefix}: plugin/MCP mouse-leave dismissal, traversable gap, focused-input reopen, Escape/Tab, keyboard selection and removal`);
}
async function verifyExtensionDeletion(page, kind, input, prefix) {
  const path=kind==='plugin'?'/api/runtime/marketplace':'/api/runtime/mcp-marketplace',key=kind==='plugin'?'pluginIds':'mcpIds';
  const request=(url,method='GET',body)=>page.evaluate(async({url,method,body})=>{
    const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  },{url,method,body});
  if(kind==='mcp') input={description:'Isolated deletion validation',...input};
  const installed=await request(path,'POST',input);assert.equal(installed.status,201,JSON.stringify(installed.body));
  const entry=kind==='plugin'?installed.body.plugins[0]:installed.body;
  const selection={pluginIds:[],mcpIds:[],[key]:[entry.id]};
  const created=await request('/api/agents','POST',{name:`${prefix} 删除引用测试`,status:'inactive',runtime:{extensionSelection:selection}});
  assert.equal(created.status,201);const employee=created.body.agent;
  await page.reload();await page.locator(`[data-extension-detail="${entry.id}"]`).first().click();
  await page.locator('[data-delete-extension]').click();await page.locator('[data-confirm-dialog-accept]').click();
  await page.locator('[data-extension-delete-error]').filter({hasText:employee.name}).waitFor();
  if(kind==='plugin') await page.getByRole('tab',{name:/Skill/}).waitFor();else await page.locator('.mcp-json-detail').waitFor();
  const errorBounds=await page.locator('[data-extension-delete-error]').evaluate(node=>({top:node.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom,height:innerHeight}));
  assert.ok(errorBounds.top>=0 && errorBounds.bottom<=errorBounds.height,'reference error stays in the visible viewport even with long component details');
  assert.equal((await request(`${path}/${entry.id}`)).status,200,'failed deletion keeps installed entry');
  await page.screenshot({path:`screenshots/${prefix}-${kind}-delete-blocked.png`,animations:'disabled'});
  assert.equal((await request(`/api/agents/${employee.id}`,'PUT',{runtime:{extensionSelection:{pluginIds:[],mcpIds:[]}}})).status,200);
  await page.locator('[data-delete-extension]').click();await page.locator('[data-confirm-dialog-cancel]').click();
  await page.locator('[data-delete-extension]').waitFor();
  assert.equal((await request(`${path}/${entry.id}`)).status,200,'cancel preserves installed entry');
  await page.locator('[data-delete-extension]').click();await page.locator('[data-confirm-dialog-accept]').click();
  await page.locator(`[data-extension-detail="${entry.id}"]`).first().waitFor({state:'detached'});
  assert.equal((await request(`${path}/${entry.id}`)).status,404);
  assert.equal((await request(`${path}/${entry.id}`,'DELETE',{})).status,404);
  const rebound=await request(`/api/agents/${employee.id}`,'PUT',{runtime:{extensionSelection:selection}});
  assert.equal(rebound.status,400);assert.match(rebound.body.error,/已删除/);
  assert.equal((await request(`/api/agents/${employee.id}`,'DELETE',{})).status,200);
  // Exercise the same public CLI against the actual isolated Electron server.
  const cliRoot=join(directory,`cli-${prefix}-${kind}`);await mkdir(cliRoot,{mode:0o700});
  const endpoint=join(cliRoot,'endpoint.json'),session=join(cliRoot,'session.json');
  const health=(await request('/api/health')).body;
  await writeFile(endpoint,JSON.stringify({origin:new URL(page.url()).origin,instanceId:health.instanceId}),{mode:0o600});
  const cli=(args,content='')=>executeCli([...args,'--endpoint-file',endpoint,'--session-file',session],{stdin:Readable.from([content])});
  await cli(['auth','login','--username','desktop-test','--password-stdin'],password+'\n');
  if(kind==='plugin'){
    const imported=await cli(['plugins','import','--file','-'],JSON.stringify(input));
    assert.ok(imported.plugins.length>0,'real authenticated CLI installs the same source');
    for(const plugin of imported.plugins)await cli(['plugins','delete',plugin.id,'--yes']);
    const link=join(input.path,'outside-source');await symlink('..',link);
    try{await assert.rejects(cli(['plugins','import','--file','-'],JSON.stringify(input)),/outside-source.*超出来源目录/);}
    finally{await unlink(link);}
  }
  const fresh=await request(path,'POST',input),freshEntry=kind==='plugin'?fresh.body.plugins[0]:fresh.body;
  const group=kind==='plugin'?'plugins':'mcps';
  assert.equal((await cli([group,'list','--search',freshEntry.name])).items.some(item=>item.id===freshEntry.id),true);
  assert.equal((await cli([group,'delete',freshEntry.id,'--yes'])).historyRetained,true);
  assert.equal((await cli([group,'list','--all'])).items.some(item=>item.id===freshEntry.id),false);
  await cli(['auth','logout']);await page.reload();
  console.log(`PASS ${prefix} ${kind}: authenticated UI/CLI delete, cancel, employee-reference rejection, retired-ID rejection and 404`);
}
async function verifyTaskSearch(page, prefix) {
  const selectConsole = async ({ all = false } = {}) => {
    await page.locator(`[data-select-agent="${fixtureRun.manager.id}"]`).click();
    await page.locator('.console-history-controls').waitFor();
    await page.waitForFunction(() => !document.querySelector('.console-history-controls')?.textContent.includes('正在加载'));
    await page.locator('.log-row').first().waitFor();
    while (all && await page.locator('[data-console-older]').count()) {
      await page.locator('[data-console-older]').click();
      await page.waitForFunction(() => !document.querySelector('.console-history-controls')?.textContent.includes('正在加载'));
    }
  };
  const form = page.locator("#task-search-form");
  await form.waitFor();
  assert.equal(await page.locator("#tasks-table th").count(), 5);
  assert.equal(await page.locator(".topbar").isVisible(), true);
  const title = await page.locator("#tasks-table .table-title").first().textContent();
  const teamId = await form.locator('select[name="teamId"] option').nth(1).getAttribute("value");
  await form.locator('[name="name"]').fill(title.slice(0, 4));
  await form.locator('[name="status"]').selectOption("paused");
  await form.locator('[name="teamId"]').selectOption(teamId);
  await form.getByRole("button", { name: "搜索", exact: true }).click();
  assert.equal(await page.locator("#tasks-table tbody tr").count(), 1);
  await form.locator('[name="status"]').selectOption("awaiting_acceptance");
  await form.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByText("没有匹配的任务", { exact: true }).waitFor();
  await form.getByRole("button", { name: "重置", exact: true }).click();
  assert.equal(await page.locator("#tasks-table tbody tr").count(), 1);
  assert.equal(await form.locator('[name="status"]').inputValue(), "all");
  assert.equal(await form.locator('[name="teamId"]').inputValue(), "");
  await form.locator('[name="name"]').fill("未提交的搜索草稿");
  await page.locator('[data-view="agents"]').click();
  await page.locator('[data-view="tasks"]').click();
  assert.equal(await form.locator('[name="name"]').inputValue(), "未提交的搜索草稿");
  await form.getByRole("button", { name: "重置", exact: true }).click();
  await page.getByRole("button", { name: "归档历史", exact: true }).click();
  await form.locator('[name="name"]').fill("无匹配归档");
  await form.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByText("没有匹配的任务", { exact: true }).waitFor();
  await page.getByRole("button", { name: "返回任务中心", exact: true }).click();
  await form.getByRole("button", { name: "重置", exact: true }).click();
  await page.screenshot({ path: `screenshots/${prefix}-task-search.png`, animations: "disabled" });
  await page.locator("#tasks-table [data-open-task]").first().click();
  await page.locator("#run-workspace .workspace-title h3").waitFor();
  assert.equal(await page.locator(".topbar").isVisible(), false);
  assert.equal(await page.locator(".workspace-back").count(), 1);
  assert.equal(await page.locator("#run-workspace .workspace-title h3").textContent(), title);
  assert.equal(await page.locator('[data-collaboration-filter="dispatch"]').count(), 0);
  await page.locator('#instruction-text').fill('没有收件人的消息');
  await page.locator('[data-send-instruction]').click();
  await page.getByText('新消息必须 @ 一位当前任务成员', { exact: true }).waitFor();
  assert.equal(await page.locator('#instruction-text').inputValue(), '没有收件人的消息');
  await page.screenshot({ path: `screenshots/${prefix}-task-detail-clean.png`, animations: "disabled" });
  await page.waitForFunction(() => { const list = document.querySelector('.human-message-list'); return list && list.scrollHeight - list.scrollTop - list.clientHeight < 10; });
  assert.equal(await page.locator('.client-download').isVisible(), prefix === 'web');
  await page.locator('.human-message-list').evaluate(list => { list.scrollTop = 0; });
  assert.equal(await page.locator(".workspace-details").isVisible(), false);
  assert.equal(await page.locator('.workspace-mode-tabs [role="tab"]').count(), 3);
  const tabsBox = await page.locator('#console-mode').boundingBox(), detailBox = await page.locator('.workspace-mode-tabs [data-toggle-task-details]').boundingBox();
  assert.ok(detailBox.x > tabsBox.x + tabsBox.width, 'task details is right of all tabs');
  await page.locator('[data-toggle-task-details]').click();
  assert.equal(await page.locator('.human-message-list').evaluate(list => list.scrollTop), 0, 'opening properties preserves deliberate history reading');
  await page.locator('[data-task-workflow-details]').click();
  await page.getByText('本任务创建时的工作流快照 · 只读').waitFor();
  assert.equal(await page.locator('#modal-content [data-edit-workflow]').count(), 0);
  await page.locator('[data-close-modal]').click();
  await page.locator('[data-toggle-task-details]').click();
  await page.locator('[data-ws-tab="console"]').click();
  await selectConsole({ all: true });
  await page.locator(".console-failure").waitFor();
  await page.locator(`[data-console-content="${fixtureThinkingEventId}"]`).scrollIntoViewIfNeeded();
  await page.locator('[data-execution-kind="thinking"]').waitFor();
  assert.equal(await page.locator('[data-execution-kind="thinking"]').evaluate(node => Boolean(node.closest('details'))), false);
  await page.locator('.structured-output').scrollIntoViewIfNeeded();
  await page.locator('.structured-output .execution-json .hljs-attr').first().waitFor();
  assert.match(await page.locator('.structured-output .execution-json').textContent(), /\n  "count": 9007199254740993/);
  assert.equal(await page.locator('.structured-output img').count(), 0);
  const jsonColors = await page.locator('.structured-output').evaluate(node => ['.hljs-attr','.hljs-string','.hljs-literal'].map(selector => getComputedStyle(node.querySelector(selector)).color));
  assert.ok(new Set(jsonColors).size > 1, 'JSON token types have syntax colours');
  await page.locator('.structured-output').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `screenshots/${prefix}-console-json.png` });
  assert.equal(await page.locator('.role-responsibility').count(), 0);
  assert.match(await page.locator('.role-nav-heading strong').textContent(), /产品交付小队/);
  assert.match(await page.locator(".console-failure").textContent(), /CLI 不可启动/);
  await page.getByRole("button", { name: "定位失败记录", exact: true }).click();
  await page.locator("[data-console-reset]").waitFor();
  await page.waitForFunction(() => !document.querySelector(".console-history-controls")?.textContent.includes("正在加载"));
  await page.waitForFunction(() => { const stream = document.querySelector('#trace-stream'); return stream && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 10; });
  await page.locator(`[data-console-key="tool:${fixtureContentEventId}"] > summary`).click();
  assert.equal(await page.locator('.console-tool-call[open]').count(), 1);
  await page.locator('.console-tool-call[open] [data-execution-kind="output"]').waitFor();
  assert.match(await page.locator('.console-tool-call[open]').textContent(), /node --test fixture.test.mjs/);
  assert.equal(await page.locator('.execution-content img').count(), 0, 'provider HTML is plain text');
  const contentPath = join(storage.AGENTFORGE_RUN_FILES_ROOT, contentRef.storagePath);
  const savedContent = await readFile(contentPath);
  try {
    await writeFile(contentPath, '{}');
    await page.reload();
    await page.locator('#console-mode').click();
    await selectConsole();
    await page.locator(`[data-console-key="tool:${fixtureContentEventId}"] > summary`).click();
    await page.locator('.execution-content [role="alert"]').waitFor();
    assert.match(await page.locator('.execution-content [role="alert"]').textContent(), /不可读取|校验失败/);
  } finally { await writeFile(contentPath, savedContent); }
  await page.reload(); await page.locator('#console-mode').click();
  await selectConsole();
  await page.locator(`[data-console-key="tool:${fixtureContentEventId}"] > summary`).click();
  await page.locator('.console-tool-call[open] [data-execution-kind="output"]').waitFor();
  await page.locator('.console-tool-call[open] > summary').click();
  await page.locator('#trace-stream').evaluate(stream => { stream.scrollTop = 0; });
  await page.locator('#collaboration-mode').click();
  await page.waitForFunction(() => { const list = document.querySelector('.human-message-list'); return list && list.scrollHeight - list.scrollTop - list.clientHeight < 10; });
  await page.locator('#console-mode').click();
  await page.waitForFunction(() => { const stream = document.querySelector('#trace-stream'); return stream && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 10; });
  await page.screenshot({ path: `screenshots/${prefix}-console-diagnostic.png`, animations: "disabled" });
  // 2026-10-25: per-Trace prompt entries in the timeline — one per invocation,
  // bound to that Trace even while browsing the whole history, and generated
  // from Trace records so a fresh call without visible events still has one.
  await selectConsole({ all: true });
  const promptKeys = await page.locator('#trace-stream .log-row-trace-prompt [data-console-key]').evaluateAll(nodes => nodes.map(node => node.dataset.consoleKey));
  assert.deepEqual(promptKeys, [`prompt:${failureTrace.id}`, `prompt:${promptedTrace.id}`, `prompt:${silentTrace.id}`], 'one prompt entry per Trace, in timeline order, including the silent running call');
  assert.match(await page.locator(`[data-console-key="prompt:${failureTrace.id}"]`).textContent(), /未保存提示词快照/);
  await page.locator(`[data-console-key="prompt:${promptedTrace.id}"] > summary`).click();
  await page.locator(`[data-console-key="prompt:${promptedTrace.id}"] .prompt-snapshot-text`).waitFor();
  assert.match(await page.locator(`[data-console-key="prompt:${promptedTrace.id}"] .prompt-snapshot-text`).textContent(), /提示词快照夹具原文/);
  assert.match(await page.locator(`[data-console-key="prompt:${promptedTrace.id}"]`).innerText(), /\[应用系统指令\][\s\S]*SYSTEM_PRIVATE_DO_NOT_DISPLAY[\s\S]*\[本轮输入\]/);
  assert.doesNotMatch(await page.locator(`[data-console-key="prompt:${promptedTrace.id}"]`).innerText(), /快照范围以/);
  assert.match(await page.locator(`[data-console-key="prompt:${promptedTrace.id}"]`).innerText(), /会话 ID/);
  assert.equal(await page.locator('#trace-stream .tool-audit').count(), 0);
  await page.locator(`[data-console-key="prompt:${silentTrace.id}"] > summary`).click();
  await page.locator(`[data-console-key="prompt:${silentTrace.id}"] .prompt-snapshot-text`).waitFor();
  assert.match(await page.locator(`[data-console-key="prompt:${silentTrace.id}"] .prompt-snapshot-text`).textContent(), /静默调用快照原文/);
  // Same-name tools adjacent across two invocations must not merge into one
  // visual group (which would hide the later invocation's own prompt entry).
  assert.equal(await page.locator('#trace-stream .console-tool-group').count(), 1, 'only the two weather calls within one Trace form a visual group');
  const weatherGroup = page.locator('.console-tool-group', { has: page.locator('[data-tool-name="maps_weather"]') });
  await weatherGroup.locator(':scope > summary').click();
  const weatherCall = page.locator('[data-tool-name="maps_weather"]');
  assert.equal(await weatherCall.count(), 2, 'different native IDs retain two calls even with identical arguments');
  for (const call of await weatherCall.all()) {
    await call.locator('summary').click();
    await call.locator('[data-execution-kind="output"]').waitFor();
    assert.equal(await call.locator('[data-execution-kind="input"]:visible').count(), 1, 'one input per native call, not one input across calls');
    assert.equal(await call.locator('[data-execution-kind="output"]:visible').count(), 1, 'one output per native call');
  }
  await page.screenshot({ path: `screenshots/${prefix}-independent-tool-calls.png` });
  await weatherGroup.locator(':scope > summary').click();
  // Console assistant body renders Markdown; injected HTML is sanitized away.
  await page.locator(`[data-console-content="${markdownEvent.id}"]`).scrollIntoViewIfNeeded();
  await page.locator('[data-execution-kind="text"] .console-markdown h2').waitFor();
  assert.equal(await page.locator('.console-markdown h2').textContent(), "交付说明");
  assert.equal(await page.locator('.console-markdown table').count(), 1);
  assert.equal(await page.locator('.console-markdown ul li').count(), 2);
  assert.equal(await page.locator('.console-markdown a[href="https://example.com"]').count(), 1);
  assert.match(await page.locator('.console-markdown pre code').textContent(), /const answer = 42/);
  assert.equal(await page.locator('.console-markdown img, .console-markdown script').count(), 0);
  // Shell tool content uses the terminal theme: command and output verbatim.
  await page.locator(`[data-console-key="tool:${shellEvent.id}"]`).scrollIntoViewIfNeeded();
  const shellCall = page.locator('[data-tool-name="Bash"]', { has: page.locator('.console-tool-summary', { hasText: 'echo 开始' }) });
  await shellCall.locator(':scope > summary').click();
  await shellCall.locator('.shell-output').waitFor();
  assert.equal(await shellCall.locator('.shell-command code').textContent(), "echo 开始\n  ls -la /tmp");
  assert.equal(await shellCall.locator('.shell-output code').textContent(), "total 8\ndrwxr-xr-x  2 user  wheel  64\n<img src=x onerror=\"alert(1)\">");
  assert.ok(await shellCall.locator('.shell-token-command').count() >= 1, 'shell command token colored');
  assert.equal(await shellCall.locator('.execution-json, .console-markdown, img').count(), 0, 'shell content is neither JSON-colored nor Markdown nor raw HTML');
  await shellCall.locator(':scope > summary').click();
  // Collaboration records render Markdown with the same sanitize boundary.
  await page.locator('#collaboration-mode').click();
  await page.locator('.collaboration-markdown').first().waitFor();
  assert.equal(await page.locator('.collaboration-markdown strong').first().textContent(), '重点');
  assert.equal(await page.locator('.collaboration-markdown li').count(), 2);
  assert.equal(await page.locator('.collaboration-markdown img').count(), 0);
  const human = page.locator('.collaboration-row.from-human');
  assert.equal(await human.locator('.collaboration-content header').count(), 0, 'metadata is outside the bubble');
  assert.equal(await human.locator('.member-mention').innerText(), '@' + fixtureRun.manager.name);
  const layout = await human.evaluate(row => {
    const bubble = row.querySelector('.collaboration-content'), header = row.querySelector('header'), mention = row.querySelector('.member-mention');
    return { bubblePadding: parseFloat(getComputedStyle(bubble).paddingLeft), metadataRight: Math.abs(header.getBoundingClientRect().right - bubble.getBoundingClientRect().right) < 2, color: getComputedStyle(mention).color, nameColor: getComputedStyle(header.querySelector('strong')).color, weight: Number(getComputedStyle(mention).fontWeight) };
  });
  assert.equal(layout.bubblePadding, 12); assert.ok(layout.metadataRight); assert.equal(layout.color, layout.nameColor); assert.ok(layout.weight >= 600);
  assert.equal(await page.locator('#collaboration-panel .collaboration-review, [data-stop-inquiries]').count(), 0);
  await page.screenshot({ path: `screenshots/${prefix}-human-collaboration.png`, animations: 'disabled' });
  await page.locator('#console-mode').click();
  await page.locator('#directory-mode').click();
  // Directory pages now load children lazily. Expand the real tree rather
  // than assuming an inherited docs-specific eager/default expansion.
  for (const path of ['docs', 'docs/notes']) {
    const entry = page.locator(`[data-directory-path="${path}"]`);
    await entry.waitFor();
    if (!await entry.evaluate(node => node.open)) await entry.locator(':scope > summary').click();
  }
  await page.locator('[data-select-working-file="docs/notes/readme.md"]').waitFor();
  const folder = page.locator('[data-directory-path="docs/notes"] > summary');
  await folder.click();
  assert.equal(await page.locator('[data-select-working-file="docs/notes/readme.md"]').isVisible(), false);
  await folder.press('Enter');
  await page.locator('[data-select-working-file="docs/notes/readme.md"]').click();
  await page.locator('#working-directory-panel .markdown-preview').waitFor();
  assert.equal(await page.locator('[data-ws-tab="artifacts"]').count(), 0, 'delivery-version view was removed; current files remain');
  await page.screenshot({ path: `screenshots/${prefix}-working-directory.png`, animations: "disabled" });
  assert.equal(await page.locator('#working-directory-panel .directory-protocol').count(), 0);
  assert.equal(await page.locator('#working-directory-panel .artifact-tree-file small').count(), 0);
  await page.locator('[data-toggle-task-details]').click();
  assert.match(await page.locator('#workspace-directory-details').textContent(), /工作目录/s);
  assert.doesNotMatch(await page.locator('[data-task-workflow-details]').textContent(), /查看工作流详情/);
  if (prefix === 'electron') {
    const expectedPath = await page.locator('#workspace-details [data-copy]').getAttribute('data-copy');
    await page.locator('#workspace-details [data-copy]').click();
    await page.getByRole('button', { name: '已复制', exact: true }).waitFor();
    assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), expectedPath);
  }

  assert.doesNotMatch(await page.locator('#workspace-directory-details').textContent(), /目录说明|文档与交付材料|\/Users\/|\/private\/|\/tmp\//);
  await page.locator('[data-toggle-task-details]').click();
  await page.locator('[data-ws-tab="diff"]').click();
  await page.locator('[data-select-diff="docs/notes/readme.md"]').waitFor();
  await page.locator('[data-select-diff="docs/notes/readme.md"]').click();
  await page.locator('.source-diff-add').first().waitFor();
  assert.match(await page.locator('.source-diff-table').textContent(), /隔离目录阅读测试/);
  await page.locator('.file-source-switch [data-ws-tab="directory"]').click();
  await page.locator('[data-select-working-file="docs/app.js"]').waitFor();
  // 2026-10-25: vscode-icons tree glyphs, scoped theme switching and fallback.
  const iconSrcs = await page.locator('#working-directory-panel img.file-icon-svg').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')));
  assert.ok(iconSrcs.some(src => src.endsWith('/icons/vscode/file_type_js.svg')), 'app.js maps to the JS icon');
  assert.ok(iconSrcs.some(src => src.endsWith('/icons/vscode/file_type_markdown.svg')), 'readme.md maps to the Markdown icon');
  assert.ok(iconSrcs.some(src => src.endsWith('/icons/vscode/file_type_json.svg')), 'data.json maps to the JSON icon');
  assert.ok(iconSrcs.some(src => src.endsWith('/icons/vscode/default_file.svg')), 'unknown extension falls back to the default file icon');
  assert.ok(iconSrcs.some(src => src.includes('/icons/vscode/default_folder')), 'folders use folder icons');
  assert.equal(await page.locator('#artifact-snapshots-panel img.file-icon-svg, .console-main img.file-icon-svg').count(), 0, 'icons stay scoped to the working-directory tree');
  assert.match(await page.evaluate(async () => (await fetch('/icons/vscode/file_type_js.svg')).headers.get('content-type')), /image\/svg\+xml/);
  assert.equal(await page.locator('#working-directory-panel').getAttribute('data-directory-theme'), 'vscode-light', 'default directory theme');
  await page.locator('[data-select-working-file="docs/app.js"]').click();
  await page.locator('#working-directory-panel .artifact-preview').waitFor();
  const lightPreview = await page.locator('#working-directory-panel .artifact-preview').evaluate(node => getComputedStyle(node).backgroundColor);
  await page.locator('[data-view="settings"]').click();
  await page.locator('[data-settings-page="appearance"]').click();
  assert.equal(await page.locator('input[name="directoryTheme"]').count(), 3);
  assert.equal(await page.locator('input[name="directoryTheme"]:checked').inputValue(), 'vscode-light');
  await page.locator('input[name="directoryTheme"][value="vscode-dark"]').check();
  assert.equal(await page.locator('input[name="directoryTheme"]:checked').inputValue(), 'vscode-dark');
  await page.locator('[data-view="tasks"]').click();
  await page.locator('#tasks-table [data-open-task]').first().click();
  await page.locator('#directory-mode').click();
  const darkDocs = page.locator('[data-directory-path="docs"]');
  await darkDocs.waitFor();
  if (!await darkDocs.evaluate(node=>node.open)) await darkDocs.locator(':scope > summary').click();
  await page.locator('[data-select-working-file="docs/app.js"]').waitFor();
  assert.equal(await page.locator('#working-directory-panel').getAttribute('data-directory-theme'), 'vscode-dark');
  await page.locator('[data-select-working-file="docs/app.js"]').click();
  await page.locator('#working-directory-panel .artifact-preview').waitFor();
  const darkPreview = await page.locator('#working-directory-panel .artifact-preview').evaluate(node => getComputedStyle(node).backgroundColor);
  assert.notEqual(darkPreview, lightPreview, 'dark directory theme recolors only the working-directory preview');
  await page.reload();
  await page.locator('#directory-mode').click();
  const reloadedDocs = page.locator('[data-directory-path="docs"]');
  await reloadedDocs.waitFor();
  if (!await reloadedDocs.evaluate(node=>node.open)) await reloadedDocs.locator(':scope > summary').click();
  await page.locator('[data-select-working-file="docs/app.js"]').waitFor();
  assert.equal(await page.locator('#working-directory-panel').getAttribute('data-directory-theme'), 'vscode-dark', 'directory theme survives reload');
  await page.locator('[data-view="settings"]').click();
  await page.locator('[data-settings-page="appearance"]').click();
  await page.locator('input[name="directoryTheme"][value="classic"]').check();
  await page.locator('[data-view="tasks"]').click();
  await page.locator('#tasks-table [data-open-task]').first().click();
  await page.locator('#directory-mode').click();
  const classicDocs = page.locator('[data-directory-path="docs"]');
  await classicDocs.waitFor();
  if (!await classicDocs.evaluate(node=>node.open)) await classicDocs.locator(':scope > summary').click();
  await page.locator('[data-select-working-file="docs/app.js"]').waitFor();
  assert.equal(await page.locator('#working-directory-panel').getAttribute('data-directory-theme'), 'classic');
  assert.equal(await page.locator('#working-directory-panel img.file-icon-svg').count(), 0, 'classic theme keeps the plain text glyphs');
  assert.ok(await page.locator('#working-directory-panel .file-icon').count() >= 1);
  await page.locator('[data-view="settings"]').click();
  await page.locator('[data-settings-page="appearance"]').click();
  await page.locator('input[name="directoryTheme"][value="vscode-light"]').check();
  const presentationSource = await readFile('web/app.js', 'utf8');
  const presentationContext = vm.createContext({editDiff, workingDirectoryIcon, esc: value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')});
  vm.runInContext(presentationSource.slice(presentationSource.indexOf('function editDiffMarkup'),presentationSource.indexOf('async function hydrateConsoleContent')) + presentationSource.slice(presentationSource.indexOf('function directoryNodeIcon'),presentationSource.indexOf('function renderWorkingDirectory')) + presentationSource.slice(presentationSource.indexOf('function workingChangesTree'),presentationSource.indexOf('function rememberDiffReading')), presentationContext);
  const probeHtml = presentationContext.editDiffMarkup({filePath:'src/a.js',oldText:'a\n\nb',newText:'a\n\nc'}) + presentationContext.workingChangesTree({path:'repos/app',changes:[{path:'repos/app/src/a.js',status:'M'}]}, {}, 'vscode-light');
  await page.evaluate(html => { const probe = document.createElement('section'); probe.id='presentation-regression-probe'; probe.innerHTML=html; document.body.append(probe); }, probeHtml);
  const rowMetrics = await page.locator('#presentation-regression-probe .diff-line').evaluateAll(rows => rows.map(row => { const box=row.getBoundingClientRect();return {top:box.top,bottom:box.bottom}; }));
  for(let index=1;index<rowMetrics.length;index++) assert.ok(Math.abs(rowMetrics[index].top-rowMetrics[index-1].bottom)<1,'Edit rows have no extra blank line between blocks');
  assert.equal(await page.locator('#presentation-regression-probe [data-select-diff]').isVisible(),true);
  await page.locator('#presentation-regression-probe [data-diff-directory="repos/app/src"] > summary').click();
  assert.equal(await page.locator('#presentation-regression-probe [data-select-diff]').isVisible(),false,'Diff folder collapses its files');
  await page.locator('#presentation-regression-probe').evaluate(node => node.remove());
  console.log(`PASS ${prefix} console Markdown/Shell theme, per-Trace prompt entries, collaboration Markdown and scoped directory themes`);
  await page.locator('[data-view="tasks"]').click();
  console.log(`PASS ${prefix} task search: combined conditions, no match, reset, draft retention and archive`);
}
try {
  const page = await desktop.firstWindow({ timeout: 120000 });
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 120000 });
  const desktopOrigin = new URL(page.url()).origin;
  assert.notEqual(desktopOrigin, "http://127.0.0.1:4310", "desktop must not attach to independent Web");
  await page.locator("#username").waitFor({ timeout: 60000 });
  assert.equal(await page.locator('head #agentforge-desktop-style').count(), 1, 'login receives desktop CSS in HTML');
  await page.addInitScript(() => {
    window.desktopPaints = [];
    const inspect = () => { if (document.body) window.desktopPaints.push(getComputedStyle(document.documentElement).getPropertyValue('--desktop-presentation').trim()); if (window.desktopPaints.length < 30) requestAnimationFrame(inspect); };
    requestAnimationFrame(inspect);
  });
  await page.locator("#username").fill("desktop-test");
  await page.locator("#password").fill("incorrect-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#password")?.value === "");
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator("#account-name").waitFor();
  await page.waitForFunction(() => document.querySelector("#account-name")?.textContent === "desktop-test");
  assert.equal(await page.locator("#account-name").textContent(), "desktop-test");
  assert.equal(await page.locator('head #agentforge-desktop-style').count(), 1);
  assert.ok(await page.evaluate(() => desktopPaints.length > 0 && desktopPaints.every(style => style === 'workbench')), 'all sampled post-login frames use desktop style');
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue("--desktop-density").trim() === "compact");
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue("--desktop-presentation").trim() === "workbench");
  const primaryButtonRadius = await page.locator(".primary-button").first().evaluate((button) => getComputedStyle(button).borderRadius);
  assert.ok(parseFloat(primaryButtonRadius) <= 6, `expected an operations-style primary button, received ${primaryButtonRadius}`);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function verifyModalActions() {
    const modalState = await page.locator(".modal").evaluate((modal) => ({ overflowY: getComputedStyle(modal).overflowY, scrollH: modal.scrollHeight, clientH: modal.clientHeight, scrollW: modal.scrollWidth, clientW: modal.clientWidth }));
    assert.ok(!["auto", "scroll"].includes(modalState.overflowY), `modal never scrolls itself (${modalState.overflowY})`);
    assert.ok(modalState.scrollH <= modalState.clientH + 1 && modalState.scrollW <= modalState.clientW + 1, `modal neither scrolls nor clips: ${JSON.stringify(modalState)}`);
    const scrollGroup = await page.locator(".modal-scroll").evaluate((element) => getComputedStyle(element).overflowY);
    const responsive = await page.locator(".modal").evaluate(modal => modal.matches(".workflow-detail-modal,.workflow-editor-modal,.team-config-modal"));
    if (responsive) assert.ok(["auto", "scroll"].includes(scrollGroup), "long configuration bodies scroll inside the viewport");
    else assert.ok(!["auto", "scroll"].includes(scrollGroup), "short dialogs keep their plain flow layout");
    await page.locator(".modal-backdrop").evaluate((backdrop) => { backdrop.scrollTop = backdrop.scrollHeight; });
    const actions = await page.locator("#modal-content .form-actions").boundingBox();
    const height = await page.evaluate(() => innerHeight);
    assert.ok(actions && actions.y + actions.height <= height + 1, "modal actions stay reachable through backdrop scrolling");
    await page.locator(".modal-backdrop").evaluate((backdrop) => { backdrop.scrollTop = 0; });
    const title = await page.locator("#modal-content h2").boundingBox();
    assert.ok(title && title.y >= 0, "the modal title is never clipped at the top");
  }
  // Optional reference navigation defaults hidden; opt in through the real preferences.
  await page.locator('[data-view="settings"]').click();
  await page.locator('[data-settings-page="appearance"]').click();
  assert.equal(await page.locator('[data-nav-visible="manual"]').isChecked(), false);
  await page.locator('[data-nav-visible="manual"]').check();
  await page.locator('[data-nav-visible="overview"]').check();
  for (const view of ["overview", "tasks", "communication", "teams", "workflows", "agents", "marketplace", "mcp-marketplace", "manual", "settings"]) {
    await page.locator(`[data-view="${view}"]`).click();
    await page.locator(`#${view}-view.active`).waitFor();
    if (view === "tasks") {
      await verifyTaskSearch(page, "electron");
      await page.getByRole("button", { name: "＋ 新建任务", exact: true }).click();
      assert.equal(await page.getByRole("region", { name: "本机执行与资料边界" }).isVisible(), true);
      assert.match(await page.locator("[data-task-execution-boundary]").innerText(), /工作目录不是沙箱/);
      assert.equal(await page.locator(".modal-scroll [data-task-execution-boundary]").count(), 1, "disclosure scrolls with the form instead of squeezing short-window inputs");
      const criteria = page.locator('textarea[name="acceptanceCriteria"]');
      await criteria.waitFor();
      assert.equal(await criteria.isVisible(), true);
      await criteria.fill(Array.from({ length: 21 }, (_, index) => `验收标准 ${index + 1}`).join("\n"));
      await page.getByRole("button", { name: "创建并开始", exact: true }).click();
      await page.getByText("验收标准最多 20 条。", { exact: true }).waitFor();
      await verifyModalActions();
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 560));
      await verifyModalActions();
      await page.screenshot({ path: "screenshots/electron-task-form-short.png", animations: "disabled" });
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 860));
      await page.locator("#modal-close").click();
      console.log("PASS visible Task acceptance-criteria entry and validation");
    }
    if (view === "communication") {
      await page.getByRole("button", { name: "新建对话", exact: true }).click();
      await page.locator("dialog[open]").waitFor();
      await page.getByRole("button", { name: "关闭选择", exact: true }).click();
      await page.getByRole("button", { name: "新建对话", exact: true }).click();
      await page.locator('dialog [data-kind="agent"]').first().click();
      await page.waitForFunction(() => window.marked && window.DOMPurify);
      const safe = await page.evaluate(async () => {
        const { formatCommunicationContent } = await import("/communication.js");
        const html = formatCommunicationContent('**清晰正文**\n\n<img src="https://example.invalid/private" onerror="alert(1)"><svg><image href="https://example.invalid/hidden"/></svg><script>alert(1)</script>[链接](javascript:alert(1))', { parse: window.marked.parse, sanitize: window.DOMPurify.sanitize });
        const element = document.createElement("div"); element.innerHTML = html;
        return { bold: element.querySelector("strong")?.textContent, unsafe: Boolean(element.querySelector("img,svg,script,iframe")), javascript: [...element.querySelectorAll("a")].some((link) => link.getAttribute("href")?.startsWith("javascript:")) };
      });
      assert.deepEqual(safe, { bold: "清晰正文", unsafe: false, javascript: false });
    }
    if (view === "workflows") {
      await page.locator("[data-workflow-details]").first().click();
      await page.locator("#workflow-node-detail").waitFor();
      await page.locator(".modal .diagram-graph .x6-node").first().waitFor();
      await verifyModalActions();
      await page.screenshot({ path: "screenshots/electron-workflow-detail.png", animations: "disabled" });
      await page.locator("#modal-close").click();
    }
    if (["teams", "agents"].includes(view)) {
      if(view === "agents") await verifyDirectorySearch(page,'electron','agents');
      await page.locator(view === "teams" ? "[data-edit-team]" : "[data-edit-agent]").first().click();
      await page.locator("#modal-content form").waitFor();
      if (view === "agents") {
        assert.equal(await page.locator('#agent-form [name="role"]').count(), 0);
        assert.equal(await page.getByText('职责标签', { exact: true }).count(), 0);
        await page.waitForFunction(()=>document.querySelector('[data-selection-state]')?.textContent.includes('历史任务不变'));
        assert.equal(await page.locator('#employee-mcp-json').count(),0);
        assert.equal(await page.locator('[data-skill]').count(),0);
        assert.equal(await page.locator('#agent-form [name="executable"]').count(), 0);
        const runtimeOptions = await page.locator('[name="runtimeProfileId"] option').evaluateAll(items => items.map(item => ({ value: item.value, label: item.textContent })));
        await page.locator('[name="runtimeProfileId"]').selectOption(runtimeOptions.find(item => item.label.includes('Codex')).value);
        await page.locator('[name="runtimeProfileId"]').selectOption(runtimeOptions.find(item => item.label.includes('Claude Code')).value);
      }
      await verifyModalActions();
      await page.screenshot({ path: `screenshots/electron-${view}-editor.png`, animations: "disabled" });
      if (view === 'agents') {
        const selected = await page.locator('[name="runtimeProfileId"]').inputValue();
        await page.getByRole('button', { name: '保存修改', exact: true }).click();
        await page.locator('#agent-form').waitFor({ state: 'hidden' });
        await page.locator('[data-edit-agent]').first().click();
        await page.locator('[name="runtimeProfileId"]').waitFor();
        assert.equal(await page.locator('[name="runtimeProfileId"]').inputValue(), selected);
      }
      await page.locator("#modal-close").click();
      if (view === 'agents') {
        const cards=await page.locator('.agent-card').evaluateAll(items=>items.slice(0,3).map(item=>({left:item.getBoundingClientRect().left,top:item.getBoundingClientRect().top})));
        assert.ok(cards.length>1 && cards[0].top===cards[1].top && cards[0].left!==cards[1].left,'wide employee directory uses multiple cards per row');
        await page.locator('[data-action="new-agent"]').first().click();
        await page.waitForFunction(()=>document.querySelector('[data-selection-state]')?.textContent.includes('历史任务不变'));
        await page.locator('#agent-form [name=name]').fill('创建即停用验收');
        await page.locator('#agent-form [name=status][value=inactive]').check();
        const pickers=await page.locator('.extension-picker').evaluateAll(items=>items.map(item=>({left:item.getBoundingClientRect().left,top:item.getBoundingClientRect().top})));
        assert.ok(pickers[0].left===pickers[1].left && pickers[1].top>pickers[0].top,'plugin and MCP selectors are separate vertical rows');
        await page.getByRole('button',{name:'创建数字员工',exact:true}).click();
        await page.locator('#agent-form').waitFor({state:'detached'});
        const created=page.locator('.agent-card').filter({hasText:'创建即停用验收'});await created.waitFor();
        assert.match(await created.textContent(),/停用/);
        await created.locator('[data-edit-agent]').click();
        assert.equal(await page.locator('#agent-form [name=status]:checked').inputValue(),'inactive');
        await page.locator('#modal-close').click();
        await created.locator('[data-delete-agent]').click();await page.locator('[data-confirm-configuration-delete]').click();await created.waitFor({state:'detached'});
        await page.locator('[data-edit-agent="system_project_manager"]').click();
        const managerForm = page.locator('#agent-form');
        await managerForm.locator('[name="kind"]').waitFor();
        await managerForm.locator('#employee-plugin-search').waitFor();
        assert.equal(await managerForm.locator('[name="kind"]').isDisabled(), false);
        assert.equal(await managerForm.locator('[name="status"][value="active"]').isDisabled(), false);
        await managerForm.locator('[name="kind"]').selectOption('business');
        await managerForm.getByRole('button', { name: '保存修改', exact: true }).click();
        await page.getByText('不能改变已被团队使用的经理类型', { exact: true }).waitFor();
        assert.equal(await managerForm.isVisible(), true, 'real team relation rejects incompatible kind changes');
        await managerForm.locator('[name="kind"]').selectOption('manager');
        await managerForm.locator('[name="status"][value="inactive"]').check();
        await managerForm.getByRole('button', { name: '保存修改', exact: true }).click();
        await managerForm.waitFor({ state: 'detached' });
        await page.locator('[data-edit-agent="system_project_manager"]').click();
        await managerForm.locator('[name="status"]:checked').waitFor();
        await managerForm.locator('#employee-plugin-search').waitFor();
        assert.equal(await managerForm.locator('[name="status"]:checked').inputValue(), 'inactive', 'the former built-in manager may be deactivated');
        await managerForm.locator('[name="status"][value="active"]').check();
        await managerForm.getByRole('button', { name: '保存修改', exact: true }).click();
        await managerForm.waitFor({ state: 'detached' });
        await page.locator('[data-delete-agent="agent_analyst"]').click();
        await page.locator('[data-confirm-configuration-delete]').click();
        await page.locator('[data-delete-error]').filter({ hasText: '仍被团队使用' }).waitFor();
        assert.equal(await page.locator('[data-confirm-configuration-delete]').isEnabled(), true, 'rejected deletion remains retryable');
        await page.locator('[data-close-modal]').click();
        assert.equal(await page.locator('[data-edit-agent="agent_analyst"]').count(), 1);
        console.log('PASS default manager editable status/type controls; real references reject incompatible changes and deletion');
      }
    }
    if (view === "marketplace") {
      await verifyMarketEmptyState(page,view);
      assert.notEqual(await page.locator('[data-view="marketplace"] .nav-icon').evaluate(node=>getComputedStyle(node,'::before').maskImage), 'none');
      assert.equal((await fetch(`${desktopOrigin}/api/runtime/marketplace`)).status, 401);
      const invalidSelection = await page.evaluate(async () => (await fetch('/api/agents/agent_engineer', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({runtime:{provider:'claude-code',extensionSelection:{skillIds:['missing'],mcpIds:[]}}})})).status);
      assert.equal(invalidSelection, 400);
      assert.equal(await page.locator('[data-add-mcp]').count(),0);
      await page.locator('[data-install-plugin]').click();
      await page.locator('#market-source').fill('http://example.com/not-https.git');
      assert.equal(await page.locator('[name=trusted]').count(),0);
      assert.equal(await page.locator('[data-read-plugin-source]').count(),0);
      await page.locator('#market-entry-form [type=submit]').click();
      await page.locator('[data-market-error]').filter({hasText:'HTTPS'}).waitFor();
      const source=join(directory,'ui-plugin-source');
      await mkdir(join(source,'.codex-plugin'),{recursive:true});await mkdir(join(source,'agents'));await mkdir(join(source,'hooks'));
      await writeFile(join(source,'.codex-plugin/plugin.json'),JSON.stringify({name:'ui-proof',description:'Codex format plugin details layout proof'}));
      for(let i=0;i<100;i++){await mkdir(join(source,`skills/proof-${i}`),{recursive:true});await writeFile(join(source,`skills/proof-${i}/SKILL.md`),`---\nname: proof-${i}\ndescription: Component ${i}\n---\nUI fixture only.`);}
      await symlink('SKILL.md',join(source,'skills/proof-0/AGENTS.md'));
      await writeFile(join(source,'agents/review.md'),'---\nname: reviewer\n---\nUI fixture.');
      await writeFile(join(source,'hooks/hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:'printf ui-fixture'}]}]}}));
      await page.locator('[name=sourceType][value=local]').check();await page.locator('#market-source').fill(source);
      await page.locator('#market-entry-form [type=submit]').click();await page.locator('#market-entry-form').waitFor({state:'detached'});
      const card=page.locator('.installed-extension-card').filter({hasText:'ui-proof'});await card.waitFor();
      assert.equal(await card.locator('.extension-avatar').textContent(),'UI');await card.getByRole('button',{name:'详情',exact:true}).click();
      await page.getByRole('tab',{name:/Skill/}).waitFor();assert.equal(await page.locator('.plugin-detail-component').count(),100);
      await verifyPluginScroll(page,'electron wide');
      await page.getByRole('tab',{name:/Skill/}).focus();await page.keyboard.press('ArrowRight');assert.match(await page.locator('#plugin-component-panel').textContent(),/reviewer/);
      await page.keyboard.press('ArrowRight');assert.match(await page.locator('#plugin-component-panel').textContent(),/SessionStart/);
      await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(760,560));await page.waitForFunction(()=>innerHeight===560);await page.getByRole('tab',{name:/Skill/}).click();
      await page.locator('#modal-close').click();await card.getByRole('button',{name:'详情',exact:true}).click();await page.locator('.plugin-detail-component').first().waitFor();
      const bounds=await page.locator('.extension-detail-modal').evaluate(modal=>{const close=modal.querySelector('.form-actions button').getBoundingClientRect(),heading=modal.querySelector('h2').getBoundingClientRect(),name=modal.querySelector('.extension-detail-overview h3').getBoundingClientRect();return {scroll:modal.scrollHeight>modal.clientHeight,bottom:close.bottom,height:innerHeight,nameVisible:name.top>=heading.bottom};});
      assert.equal(bounds.scroll,false);assert.ok(bounds.bottom<=bounds.height,'long plugin details keep close command visible');
      assert.equal(bounds.nameVisible,true,'opening the detail in a narrow window starts with the complete overview visible');
      await verifyPluginScroll(page,'electron narrow');
      await page.screenshot({path:'screenshots/electron-plugin-detail-760.png',animations:'disabled'});
      await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1320,860));
      await page.locator('#modal-close').click();
      await verifyDirectorySearch(page,'electron','marketplace');
      await verifyExtensionDeletion(page,'plugin',{path:source},'electron');
      // Static compatibility is visible in both catalog and employee picker;
      // changing Runtime must not silently drop or save an incompatible choice.
      const onlyClaude=join(directory,'ui-claude-only');
      await mkdir(join(onlyClaude,'.claude-plugin'),{recursive:true});
      await writeFile(join(onlyClaude,'.claude-plugin/plugin.json'),JSON.stringify({name:'ui-claude-only',settings:{}}));
      const incompatible=await page.evaluate(async path=>(await(await fetch('/api/runtime/marketplace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})})).json()).plugins[0],onlyClaude);
      await page.reload();const restricted=page.locator('.installed-extension-card').filter({hasText:'ui-claude-only'});
      await restricted.waitFor();assert.match(await restricted.locator('[data-supported=false]').textContent(),/Codex/);
      await restricted.getByRole('button',{name:'详情',exact:true}).click();await page.locator('.plugin-runtime-compatibility').waitFor();
      assert.match(await page.locator('.plugin-runtime-compatibility').textContent(),/Codex.*settings/);await page.locator('#modal-close').click();
      await page.locator('[data-view=agents]').click();await page.locator('[data-action=new-agent]').first().click();
      await page.waitForFunction(()=>document.querySelector('[data-selection-state]')?.textContent.includes('历史任务不变'));
      const profiles=await page.locator('[name=runtimeProfileId] option').evaluateAll(options=>Object.fromEntries(['Claude Code','Codex'].map(label=>[label,options.find(option=>option.textContent.includes(label)).value])));
      await page.locator('[name=runtimeProfileId]').selectOption(profiles.Codex);await page.locator('#employee-plugin-search').fill('ui-claude-only');
      assert.equal(await page.locator(`[data-add-extension="${incompatible.id}"]`).isDisabled(),true);
      await page.locator('[name=runtimeProfileId]').selectOption(profiles['Claude Code']);
      await page.locator(`[data-add-extension="${incompatible.id}"]`).click();await page.locator('[name=runtimeProfileId]').selectOption(profiles.Codex);
      assert.match(await page.locator('.extension-chip[data-incompatible=true]').textContent(),/Runtime 不兼容/);
      await page.locator('#agent-form [name=name]').fill('Must not save incompatible plugin');await page.getByRole('button',{name:'创建数字员工',exact:true}).click();
      await page.getByText(/ui-claude-only.*Codex.*settings/).waitFor();assert.equal(await page.locator('#agent-form').count(),1);
      const rejected=await page.evaluate(async({id,profileId})=>{const response=await fetch('/api/agents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'API incompatible selection probe',runtime:{profileId,extensionSelection:{pluginIds:[id],mcpIds:[]}}})});return {status:response.status,body:await response.json()};},{id:incompatible.id,profileId:profiles.Codex});
      assert.equal(rejected.status,400);assert.match(rejected.body.error,/ui-claude-only.*Codex.*settings/);
      await page.locator('#modal-close').click();await page.locator('[data-view=marketplace]').click();
      console.log('PASS Runtime badges, exact compatibility reasons and employee Runtime switch rejection');
      await page.screenshot({path:'screenshots/electron-marketplace.png'});
    }
    if (view === "mcp-marketplace") {
      await verifyMarketEmptyState(page,view);
      assert.notEqual(await page.locator('[data-view="mcp-marketplace"] .nav-icon').evaluate(node=>getComputedStyle(node,'::before').maskImage),'none');
      assert.equal((await fetch(`${desktopOrigin}/api/runtime/mcp-marketplace`)).status,401);
      // The real 添加 MCP modal fits the 760x560 minimum window and 1320x860 with
      // neither modal nor backdrop scrolling — including with a validation error.
      const verifyMcpModalFits = async (label) => {
        const m = await page.evaluate(() => {
          const backdrop = document.getElementById("modal-backdrop");
          const modal = backdrop.querySelector(".modal");
          const submit = modal.querySelector('#mcp-market-form [type="submit"]');
          const title = modal.querySelector("h2");
          const rect = (node) => { const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; };
          return { innerH: innerHeight, innerW: innerWidth, modalScroll: modal.scrollHeight > modal.clientHeight || modal.scrollWidth > modal.clientWidth, backdropScroll: backdrop.scrollHeight > backdrop.clientHeight, title: rect(title), submit: rect(submit) };
        });
        assert.equal(m.modalScroll, false, `${label}: MCP modal never scrolls itself`);
        assert.equal(m.backdropScroll, false, `${label}: MCP modal needs no backdrop scrolling`);
        assert.ok(m.title.top >= 0 && m.title.bottom <= m.innerH, `${label}: title fully visible`);
        assert.ok(m.submit.top >= 0 && m.submit.bottom <= m.innerH, `${label}: submit button fully visible (${JSON.stringify(m.submit)} vs ${m.innerH})`);
      };
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 560));
      await page.locator('[data-add-mcp]').click();
      await page.locator('#mcp-market-form').waitFor();
      await verifyMcpModalFits("desktop 760x560");
      // Fill every required field except valid JSON so the browser submits and
      // the in-form validation error appears (first packaged-window round missed
      // the required name, the browser blocked submit and the wait timed out).
      await page.locator('#mcp-market-form [name=name]').fill('geometry_probe');
      await page.locator('#mcp-market-form [name=content]').fill('{bad');
      await page.locator('#mcp-market-form [type=submit]').click();
      await page.locator('[data-market-error]').filter({hasText:'JSON'}).waitFor();
      await verifyMcpModalFits("desktop 760x560 with validation error");
      await page.screenshot({path:'screenshots/electron-mcp-modal-760.png', animations:'disabled'});
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 860));
      await verifyMcpModalFits("desktop 1320x860");
      await page.locator("#modal-close").click();
      console.log('PASS real 添加 MCP modal fits 760x560 (incl. validation error) and 1320x860 without any scrolling');
      for(const name of ['desktop_one','desktop_two']) {
        await page.locator('[data-add-mcp]').click();
        await page.locator('#mcp-market-form [name=name]').fill(name);
        await page.locator('#mcp-market-form [name=content]').fill('{bad');
        await page.locator('#mcp-market-form [type=submit]').click();
        await page.locator('[data-market-error]').filter({hasText:'JSON'}).waitFor();
        await page.locator('#mcp-market-form [name=content]').fill(JSON.stringify({mcpServers:{[name]:{command:'node',args:['--version']}}}));
        await page.locator('#mcp-market-form [type=submit]').click();
        await page.locator('#mcp-market-form').waitFor({state:'detached'});
      }
      await page.screenshot({path:'screenshots/electron-mcp-market.png'});
      await verifyDirectorySearch(page,'electron','mcp-marketplace');
      await verifyExtensionDeletion(page,'mcp',{name:'delete-proof',content:JSON.stringify({mcpServers:{proof:{command:'node',args:['--version']}}})},'electron');
      await page.locator('[data-view="agents"]').click();
      await page.locator('[data-edit-agent="agent_engineer"]').click();
      await page.waitForFunction(()=>document.querySelector('[data-selection-state]')?.textContent.includes('历史任务不变'));
      for(const name of ['desktop_one','desktop_two']) {
        await page.locator('#employee-mcp-search').fill(name);
        await page.locator('[data-picker=mcp] [data-add-extension]').first().click();
      }
      await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.locator('#agent-form').waitFor({state:'detached'});
      await page.locator('[data-edit-agent="agent_engineer"]').click();
      await page.waitForFunction(()=>document.querySelectorAll('[data-picker=mcp] [data-remove-extension]').length===2);
      await page.locator('[data-picker=mcp] [data-remove-extension]').first().click();
      await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.locator('#agent-form').waitFor({state:'detached'});
      await page.locator('[data-edit-agent="agent_engineer"]').click();
      await page.waitForFunction(()=>document.querySelectorAll('[data-picker=mcp] [data-remove-extension]').length===1);
      await verifyExtensionPickerDismissal(page,'electron wide');
      await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(760,560));await page.waitForFunction(()=>innerHeight===560);
      await verifyExtensionPickerDismissal(page,'electron narrow');
      await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1320,860));
      assert.equal(await page.locator('#employee-mcp-json').count(),0);
      await page.locator('#employee-market-selection').scrollIntoViewIfNeeded();
      await page.screenshot({path:'screenshots/electron-mcp-selection.png',animations:'disabled'});
      await page.locator('#modal-close').click();
      console.log('PASS separate MCP market, multiple selection, deselection with no employee JSON input');
    }
    if (view === "manual") for (const chapter of ["data-model", "system-architecture", "task-flow"]) {
      await page.locator(`[data-manual-page="${chapter}"]`).click();
      await page.locator(".diagram-graph .x6-graph-svg").waitFor();
      await page.screenshot({ path: `screenshots/electron-manual-${chapter}.png`, animations: "disabled" });
    }
    if (view === "settings") for (const category of ["general", "appearance", "workspace", "cli", "repositories", "runtime", "logs"]) {
      await page.locator(`[data-settings-page="${category}"]`).click();
      await page.locator(`[data-settings-panel="${category}"]:not([hidden])`).waitFor();
      assert.equal(await page.locator('[data-settings-page="navigation"], [data-settings-page="data"]').count(), 0);
      if (category === "appearance") assert.equal(await page.locator('[data-nav-visible="tasks"]').isVisible(), true);
      if (category === "workspace") {
        await page.locator('[data-reset-all]').click();
        assert.equal(await page.locator('#reset-data-form button[type="submit"]').isDisabled(), true);
        await page.locator('[data-cancel-reset]').click();
      }
      if (category === "cli") await page.getByText(/请先将 Mac 安装包移到持久位置/).waitFor();
      if (category === "general") {
        await page.getByText("尚未设置；首次关闭窗口时会询问，取消不会保存选择。", { exact: true }).waitFor();
        assert.equal(await page.locator('input[name="closeMode"]:checked').count(), 0);
        assert.equal(await page.locator('input[type="radio"][name="closeMode"]').count(), 2);
        assert.equal(await page.locator('[data-close-form] button[type="submit"]').isDisabled(), true);
      }
      if (category === "logs") {
        await page.waitForFunction(() => document.querySelector('[data-log-file]')?.textContent.endsWith('.jsonl'));
        assert.equal(await page.locator('[data-log-list]').count(), 0);
      }
      if (category === 'runtime') {
        assert.equal((await fetch(`${desktopOrigin}/api/settings/runtime-profiles`)).status, 401);
        assert.equal(await page.getByText('本机执行说明与版本', { exact: true }).count(), 0);
        await page.locator('[data-runtime-profile] summary h4').first().waitFor();
        const hierarchy = await page.locator('[data-runtime-profile] summary h4').evaluateAll(headings => headings.map(heading => ({ size: parseFloat(getComputedStyle(heading).fontSize), weight: Number(getComputedStyle(heading).fontWeight), parentSize: parseFloat(getComputedStyle(document.querySelector('#runtime-title')).fontSize), parentWeight: Number(getComputedStyle(document.querySelector('#runtime-title')).fontWeight) })));
        assert.ok(hierarchy.length > 0 && hierarchy.every(item => item.size <= item.parentSize && item.weight <= item.parentWeight), `connection headings stay subordinate to Runtime: ${JSON.stringify(hierarchy)}`);
        const form = page.locator('[data-runtime-profile="new"]');
        await form.locator('summary').click();
        await page.waitForFunction(() => document.querySelector('[data-runtime-profile="new"] [data-model-status]')?.textContent.includes('个可选'));
        const modelInput = form.locator('[name="model"]');
        await modelInput.fill('son');
        await modelInput.press('ArrowDown');
        await modelInput.press('Enter');
        assert.equal(await modelInput.inputValue(), 'sonnet');
        assert.equal(await form.locator('.model-options').isVisible(), false);
        await modelInput.fill('manual-model');
        await modelInput.press('Escape');
        assert.equal(await modelInput.inputValue(), 'manual-model');
        await modelInput.fill(''); await modelInput.press('Escape');
        assert.equal(await form.locator('[data-refresh-models] svg').count(), 1);
        await form.locator('[name="name"]').fill('桌面 Runtime 失败验收');
        await form.locator('[name="executable"]').fill('/agentforge-desktop-missing-cli');
        await form.locator('[name="executable"]').press('Tab');
        await page.waitForFunction(() => { const text = document.querySelector('[data-runtime-profile="new"] [data-model-status]')?.textContent || ''; return text && !/正在加载|尚未加载/.test(text); });
        const creation = page.waitForResponse(response => response.url().endsWith('/api/settings/runtime-profiles') && response.request().method() === 'POST');
        await form.getByRole('button', { name: '添加配置', exact: true }).click();
        const creationResponse = await creation;
        assert.equal(creationResponse.status(), 201, await creationResponse.text());
        const card = page.locator('[data-runtime-profile]').filter({ has: page.getByRole('heading', { name: '桌面 Runtime 失败验收', exact: true }) });
        await card.locator('summary').click();
        await card.getByRole('button', { name: '测试连接', exact: true }).click();
        await card.locator('[data-runtime-result]').filter({ hasText: '连接测试失败' }).waitFor();
        assert.match(await card.locator('[data-runtime-result]').textContent(), /\.jsonl/);
      }
      if (category === "workspace") {
        const input = page.locator("#default-workspace-root");
        await input.waitFor();
        const blocker=join(directory,'workspace-file');await writeFile(blocker,'not a directory');
        await input.fill(join(blocker, "child"));
        await page.getByRole("button", { name: "保存目录", exact: true }).click();
        await page.getByText("目录无法创建或服务无法读写，请检查路径和权限", { exact: true }).waitFor();
        const nextRoot = join(directory, "new-workspaces", "新目录");
        await input.fill(nextRoot);
        await page.getByRole("button", { name: "保存目录", exact: true }).click();
        await page.getByText("已保存，仅新任务使用此目录。", { exact: true }).waitFor();
        const result = await page.evaluate(async () => (await fetch("/api/settings/workspace")).json());
        assert.equal(result.workspaceRoot, nextRoot);
        assert.equal(result.source, "saved");
        assert.equal((await stat(nextRoot)).isDirectory(),true,'missing nested workspace created by authenticated save');
        const sentinel=join(nextRoot,'existing.txt');await writeFile(sentinel,'preserve');
        await page.getByRole("button", { name: "保存目录", exact: true }).click();
        await page.getByText("已保存，仅新任务使用此目录。", { exact: true }).waitFor();
        assert.equal(await readFile(sentinel,'utf8'),'preserve','saving an existing root does not erase files');
        const allocated = await page.evaluate(async ({ input, root, existingRunId }) => {
          const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
          if (!response.ok) throw new Error(`Task creation rejected: ${await response.text()}`);
          const { task } = await response.json();
          const existing = await (await fetch(`/api/runs/${existingRunId}/workspace?view=summary`)).json();
          const cleanup = await fetch(`/api/tasks/${task.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
          if (!cleanup.ok) throw new Error("Disposable Task cleanup rejected");
          return { matches: task.workspacePath === `${root}/${task.id}`, oldPath: existing.run.task.taskWorkspacePath };
        }, { input: { title: "目录分配验收夹具", objective: "不启动 Provider", teamId: fixtureTask.teamId, workflowTemplateId: fixtureTask.workflowTemplateId }, root: nextRoot, existingRunId: fixtureRun.id });
        assert.equal(allocated.matches, true);
        assert.equal(allocated.oldPath, fixtureTask.workspacePath);
      }
      if (category === "repositories") {
        await page.locator('[data-git-provider="github"] input').waitFor();
        await page.locator('[data-git-provider="github"] button[type="submit"]').click();
        await page.getByText("请粘贴要保存的 Token。若要删除已有 Token，请使用移除操作。", { exact: true }).waitFor();
      }
      await page.screenshot({ path: `screenshots/electron-settings-${category}.png`, animations: "disabled" });
    }
    await page.screenshot({ path: `screenshots/electron-${view}.png`, animations: "disabled" });
    console.log(`PASS visible Electron navigation: ${view}`);
  }
  // Every former system dialog is now a main-owned app-styled window sized to
  // its content: external-link confirmation and the first-close choice.
  const linkDialogEvent = desktop.waitForEvent("window");
  await page.evaluate(() => window.open("https://example.com/some/path"));
  const linkDialog = await linkDialogEvent;
  await linkDialog.waitForLoadState("domcontentloaded");
  await linkDialog.locator('[data-dialog-choice="1"]').waitFor();
  assert.match(await linkDialog.locator('[data-dialog-title]').textContent(), /打开外部链接/);
  assert.match(await linkDialog.locator('[data-dialog-detail]').textContent(), /https:\/\/example\.com/);
  assert.deepEqual(await linkDialog.locator('[data-dialog-choice]').allTextContents(), ["取消", "打开"]);
  assert.equal(await linkDialog.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight && document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "external-link dialog has no scrollbars");
  const linkButton = await linkDialog.locator('[data-dialog-choice="1"]').boundingBox();
  assert.ok(linkButton && linkButton.y + linkButton.height <= await linkDialog.evaluate(() => innerHeight), "confirm action fully visible");
  await linkDialog.screenshot({ path: "screenshots/electron-external-link-dialog.png", animations: "disabled" });
  const linkDialogClosed = linkDialog.waitForEvent("close");
  await linkDialog.locator('[data-dialog-choice="0"]').click();
  await linkDialogClosed;
  assert.ok((await page.evaluate(() => location.href)).startsWith(desktopOrigin + "/"), "cancel never navigates or opens the browser");
  console.log("PASS app-styled external-link confirmation, sized to content without scrollbars, cancel is a no-op");
  if (process.platform === "darwin") {
    const closeDialogEvent = desktop.waitForEvent("window");
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const closeDialog = await closeDialogEvent;
    await closeDialog.waitForLoadState("domcontentloaded");
    await closeDialog.locator('[data-dialog-choice="2"]').waitFor();
    assert.deepEqual(await closeDialog.locator('[data-dialog-choice]').allTextContents(), ["退出程序", "保留在菜单栏", "取消"]);
    assert.equal(await closeDialog.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight && document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "first-close dialog has no scrollbars");
    for (const index of [0, 1, 2]) {
      const box = await closeDialog.locator(`[data-dialog-choice="${index}"]`).boundingBox();
      assert.ok(box && box.y + box.height <= await closeDialog.evaluate(() => innerHeight), `choice ${index} fully visible`);
    }
    await closeDialog.screenshot({ path: "screenshots/electron-first-close-dialog.png", animations: "disabled" });
    const closeDialogClosed = closeDialog.waitForEvent("close");
    await closeDialog.locator('[data-dialog-choice="2"]').click();
    await closeDialogClosed;
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true, "cancel keeps the main window visible");
    await assert.rejects(access(join(directory, "desktop-preferences.json")), /ENOENT/, "cancel saves no close preference");
    console.log("PASS app-styled first-close choice, cancel keeps the window and saves nothing");
    // The macOS menu About entry opens the app-styled app-dialog window; the
    // application menu contains no system About role anymore.
    const menuRoles = await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap((item) => (item.submenu?.items || []).map((sub) => sub.role || sub.id || sub.label)));
    assert.ok(!menuRoles.includes("about"), `no system About role remains in the menu: ${JSON.stringify(menuRoles)}`);
    const aboutDialogEvent = desktop.waitForEvent("window");
    await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("about-agentforge").click());
    const aboutDialog = await aboutDialogEvent;
    await aboutDialog.waitForLoadState("domcontentloaded");
    await aboutDialog.locator('[data-dialog-choice="0"]').waitFor();
    assert.match(await aboutDialog.locator('[data-dialog-title]').textContent(), /关于 AgentForge/);
    assert.match(await aboutDialog.locator('[data-dialog-message]').textContent(), /版本 /);
    assert.deepEqual(await aboutDialog.locator('[data-dialog-choice]').allTextContents(), ["好"]);
    assert.equal(await aboutDialog.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight && document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "About dialog has no scrollbars");
    const aboutButton = await aboutDialog.locator('[data-dialog-choice="0"]').boundingBox();
    assert.ok(aboutButton && aboutButton.y + aboutButton.height <= await aboutDialog.evaluate(() => innerHeight), "About action fully visible");
    await aboutDialog.screenshot({ path: "screenshots/electron-about-dialog.png", animations: "disabled" });
    const aboutDialogClosed = aboutDialog.waitForEvent("close");
    await aboutDialog.locator('[data-dialog-choice="0"]').click();
    await aboutDialogClosed;
    console.log("PASS app-styled About window replaces the system About panel");
  }
  await page.reload();
  await page.locator("#account-name").waitFor();
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue("--desktop-density").trim() === "compact");
  await page.locator('[data-view="teams"]').click();
  for (const width of [900, 1366, 1920]) {
    await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size, 860), width);
    await page.waitForFunction((size) => Math.round(document.querySelector(".sidebar").getBoundingClientRect().width) === (size <= 1000 ? 64 : 216), width);
    await page.screenshot({ path: `screenshots/electron-compact-${width}.png`, animations: "disabled" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no overflow at ${width}`);
  }
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.deepEqual(errors, []);
  await page.locator('[data-view="settings"]').click();
  await page.locator('[data-settings-page="general"]').click();
  await page.locator("#logout-button").click();
  await page.locator("#username").waitFor();
  console.log("PASS cold-start, rejected login, successful login, session reload, renderer isolation and logout");
} finally { await desktop.close(); }
