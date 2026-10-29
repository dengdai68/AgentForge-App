import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { applyPreferences, NAVIGATION, normalizePreferences, PREFERENCES_KEY, readPreferences, savePreferences } from "../web/preferences.mjs";
import { SETTINGS_PAGES, createClosePreferenceUI, createCliInstallationUI, createPluginUpdateSettingsUI } from "../web/settings.mjs";
import { createCatalogFixtureStore as createStore } from "./fixture-store.mjs";
import { mkdtemp, mkdir, rm, writeFile, realpath, stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, isAbsolute, normalize, parse } from "node:path";
import { STATUS_TEXT, buildConsoleEntries, taskActionLabel, taskMatchesFilter, taskNeedsAttention } from "../client/console-projections.mjs";
import { collaborationRecords } from "../client/console-projections.mjs";
import { createMarketplaceUI, createMcpMarketplaceUI } from "../web/marketplace.mjs";

function closePanel() {
  const options = ["quit", "tray"].map(value => ({ value, checked: false, disabled: true })), save = { disabled: true }, status = {}, retry = { hidden: true };
  const form = { querySelectorAll: () => options, querySelector: () => save, hidden: false };
  const panel = { hidden: false, querySelector: selector => ({ '[data-close-form]': form, '[data-close-status]': status, '[data-close-retry]': retry })[selector] };
  return { panel, options, save, status, retry, form, selected: () => options.find(option => option.checked)?.value || "", choose(value) { options.forEach(option => { option.checked = option.value === value; }); form.onchange(); } };
}
test('plugin update settings preserve draft during refresh, validate, save, run when disabled and dispose polling',async t=>{
  const enabled={checked:false},interval={value:''},save={},check={},status={},note={};
  const form={querySelector:key=>({'[name=enabled]':enabled,'[name=intervalMinutes]':interval,'[type=submit]':save})[key]};
  const panel={hidden:false,querySelector:key=>({'[data-plugin-update-form]':form,'[data-check-plugin-updates]':check,'[data-plugin-update-status]':status,'[data-plugin-update-note]':note})[key]};
  let saved={enabled:true,intervalMinutes:2},fail=false,calls=[];
  const ui=createPluginUpdateSettingsUI(panel,async(path,options)=>{calls.push({path,options});if(fail)throw Error('controlled failure');if(options?.method==='PUT')saved=JSON.parse(options.body);return {...saved,running:false,lastResult:{updatedPlugins:0}};});t.after(()=>ui.dispose());
  await ui.refresh();assert.equal(interval.value,'2');assert.equal(save.disabled,true);
  interval.value='7';form.oninput();await ui.refresh();assert.equal(interval.value,'7');assert.equal(save.disabled,false);
  interval.value='1.5';form.oninput();assert.equal(save.disabled,true);assert.match(note.textContent,/整数/);
  interval.value='7';enabled.checked=false;form.oninput();fail=true;await form.onsubmit({preventDefault(){}});assert.equal(interval.value,'7');assert.equal(save.disabled,false);assert.match(note.textContent,/失败/);
  fail=false;await form.onsubmit({preventDefault(){}});assert.deepEqual(saved,{enabled:false,intervalMinutes:7});assert.equal(save.disabled,true);assert.equal(check.disabled,false);
  await check.onclick();assert.equal(calls.at(-1).options.method,'POST');ui.dispose();const count=calls.length;await ui.refresh();assert.equal(calls.length,count);
});
test('task console defaults to the latest executed known member, not the last finished long call',async()=>{
  const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
  const select=vm.runInNewContext(source.slice(source.indexOf('function latestExecutedAgentId('),source.indexOf('function workspaceDirectoryDetails('))+';latestExecutedAgentId');
  const agents=[{id:'manager'},{id:'worker'}];
  assert.equal(select(agents,[]),null);
  assert.equal(select(agents,[{agentId:'worker',startedAt:'2026-10-01',endedAt:'2026-10-05'},{agentId:'manager',startedAt:'2026-10-02',endedAt:'2026-10-03'},{agentId:'unknown',startedAt:'2026-10-06'}]),'manager');
  assert.equal(select(agents,[{agentId:'manager',startedAt:'2026-10-02'},{agentId:'worker',startedAt:'2026-10-03',status:'running'}]),'worker');
  assert.match(source,/if \(!agents.some\(\(agent\) => agent.id === state.selectedAgentId\)\) state.selectedAgentId = tab === 'console' \? latestExecutedAgentId/);
});
test('workspace HTTP save creates missing directories, preserves existing files and never persists invalid paths',async t=>{
  await mkdir('.data',{recursive:true});const root=await mkdtemp(resolve('.data/workspace-create-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=await readFile(new URL('../server/index.mjs',import.meta.url),'utf8'),start=source.indexOf('  if (pathname === "/api/settings/workspace" && request.method === "PUT")'),end=source.indexOf('  // CLI paths',start);
  let saved=null,writes=0;
  async function save(workspaceRoot){let result;await vm.runInNewContext(`(async()=>{${source.slice(start,end)}})()`,{pathname:'/api/settings/workspace',request:{method:'PUT'},response:{},readJson:async()=>({workspaceRoot}),isAbsolute,normalize,parse,mkdir,realpath,stat,access,constants,version:'test',store:{updateWorkspaceSettings(input){saved=input.workspaceRoot;writes++;return input;}},sendJson(response,status,value){assert.equal(status,200);result=value;}});return result;}
  for(const invalid of ['/',root+'/../'.repeat(root.split('/').length),'relative','',null,'/bad\0path'])await assert.rejects(save(invalid));
  assert.equal(writes,0);
  const target=join(root,'任务 根','nested');assert.equal((await save(target)).workspaceRoot,await realpath(target));assert.equal((await stat(target)).isDirectory(),true);
  await writeFile(join(target,'keep.txt'),'keep');await save(target);assert.equal(await readFile(join(target,'keep.txt'),'utf8'),'keep');
  const blocker=join(root,'file');await writeFile(blocker,'file');await assert.rejects(save(join(blocker,'child')),error=>/目录无法创建/.test(error.message)&&Boolean(error.cause));assert.equal(saved,await realpath(target));assert.equal(writes,2);
});
test('collaboration aligns by sender, never by the human recipient or human filter',async()=>{
  const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8'),start=source.indexOf('function renderCollaboration('),end=source.indexOf('/* ---------- 任务空间数据与动作',start),dock={};
  const messages=[{id:'human',createdAt:'2026-01-01T00:00:00Z',sender:{type:'human',name:'操作者'},recipient:{type:'agent',name:'员工'},content:'HUMAN-CONTENT'},{id:'employee',createdAt:'2026-01-01T00:00:01Z',sender:{type:'agent',name:'员工'},recipient:{type:'human',name:'操作者'},content:'AGENT-TO-HUMAN'}];
  const render=vm.runInNewContext(`${source.slice(start,end)};renderCollaboration`,{$:selector=>selector==='#collaboration-panel'?dock:{addEventListener(){}},state:{workspace:{pendingQuestions:[]}},workspaceView:()=>({draft:''}),collaborationRecords,acceptanceReview:()=>null,esc:String,exactTime:String,collaborationMessageMarkup:content=>content,sendInstruction(){}});
  render({run:{id:'run',status:'paused',task:{}},messages},[]);
  const articles=dock.innerHTML.match(/<article[\s\S]*?<\/article>/g);assert.equal(articles.length,2);assert.match(articles[0],/class="collaboration-row from-human/);assert.match(articles[1],/AGENT-TO-HUMAN/);assert.doesNotMatch(articles[1],/from-human/);
});
test('plugin and MCP empty/error states are outside their card grid, and search transitions remain truthful',async t=>{
  for(const createUI of [createMarketplaceUI,createMcpMarketplaceUI]) {
    const nodes=new Map(),query=selector=>{if(!nodes.has(selector))nodes.set(selector,{hidden:false,dataset:{},querySelector:query,insertAdjacentHTML(){},setAttribute(key,value){this[key]=value;}});return nodes.get(selector);};
    const root={isConnected:true,querySelector:query};let fail=false;
    const ui=createUI({api:async()=>{if(fail)throw Error('read failed');return {plugins:[],entries:[]};},esc:String});
    t.after(()=>ui.unmount());
    ui.mount(root);await new Promise(done=>setImmediate(done));
    assert.match(root.innerHTML,/<div data-market-list hidden[^>]*><\/div><div class="market-directory-empty"/);
    assert.equal(query('[data-market-list]').innerHTML,'');assert.equal(query('[data-market-list]').hidden,true);assert.match(query('[data-market-empty]').textContent,/尚未安装/);
    query('input').oninput({target:{value:'missing'}});assert.equal(query('[data-market-empty]').textContent,'没有匹配项');
    ui.unmount();fail=true;ui.mount(root);await new Promise(done=>setImmediate(done));assert.equal(query('[data-market-empty]').textContent,'read failed');assert.equal(query('[data-market-empty]').role,'alert');
    query('input').oninput({target:{value:'another search'}});assert.equal(query('[data-market-empty]').textContent,'read failed','typing after a failed read must not imply an empty catalog');
  }
});
function cliPanel() {
  const install = {}, refresh = {}, status = {}, paths = {};
  return { install, refresh, status, paths, panel: { hidden: false, querySelector: key => ({ '[data-cli-install]': install, '[data-cli-refresh]': refresh, '[data-cli-status]': status, '[data-cli-paths]': paths })[key] } };
}
test('General CLI installation needs a desktop bridge and explicit click; cancel, failure, retry and detach are truthful', async () => {
  const web = cliPanel(); await createCliInstallationUI(web.panel).refresh();
  assert.equal(web.install.hidden, true); assert.match(web.status.textContent, /客户端宿主接口不可用/);
  let writes = 0, fail = false, cancelled = true;
  const mac = cliPanel(), value = { supported: true, canInstall: true, installed: false, commandPath: '/fixture/agentforge', profilePaths: ['/fixture/.zshrc'] };
  const ui = createCliInstallationUI(mac.panel, { getCliInstallation: async () => value, installCli: async () => {
    writes++; if (fail) throw new Error('failure'); return { ...value, cancelled, installed: !cancelled };
  } });
  await ui.refresh(); assert.equal(writes, 0); assert.equal(mac.install.disabled, false); assert.match(mac.paths.textContent, /\.zshrc/);
  await mac.install.onclick(); assert.equal(writes, 1); assert.match(mac.status.textContent, /已取消/);
  fail = true; await mac.install.onclick(); assert.equal(mac.install.disabled, true); assert.match(mac.status.textContent, /失败/);
  fail = false; cancelled = false; await mac.refresh.onclick(); await mac.install.onclick(); assert.match(mac.status.textContent, /已安装/);
  const late = cliPanel(); let finish;
  const detached = createCliInstallationUI(late.panel, { getCliInstallation: () => new Promise(resolve => { finish = resolve; }), installCli() {} });
  const pending = detached.refresh(); detached.dispose(); finish(value); await pending;
  assert.equal(late.paths.textContent, undefined);
});
test("General settings keeps Web separate and does not choose a Mac close default", async () => {
  const web = closePanel();
  await createClosePreferenceUI(web.panel, undefined).refresh();
  assert.equal(web.form.hidden, true); assert.match(web.status.textContent, /客户端宿主接口不可用/);
  const mac = closePanel(); let writes = 0;
  const ui = createClosePreferenceUI(mac.panel, { getPreferences: async () => ({ platform: "darwin", closeMode: null }), setCloseMode: async () => { writes++; } });
  await ui.refresh();
  assert.equal(mac.selected(), ""); assert.equal(mac.options.every(option => !option.checked), true); assert.equal(mac.save.disabled, true); assert.equal(writes, 0);
  assert.match(mac.status.textContent, /首次关闭/);
});
test("General settings preserves failed save drafts, retries and ignores late detached reads", async () => {
  const mac = closePanel(); let fail = true, reads = 0, saved = "quit";
  const desktop = { getPreferences: async () => { reads++; return { platform: "darwin", closeMode: saved }; }, setCloseMode: async mode => {
    if (fail) throw new Error("disk unavailable"); saved = mode; return { platform: "darwin", closeMode: mode };
  } };
  const ui = createClosePreferenceUI(mac.panel, desktop);
  await ui.refresh(); mac.choose("tray");
  await ui.refresh(); assert.equal(reads, 1, "focus must not overwrite an unsaved draft");
  await mac.form.onsubmit({ preventDefault() {} });
  assert.equal(saved, "quit"); assert.equal(mac.selected(), "tray"); assert.equal(mac.save.disabled, false); assert.match(mac.status.textContent, /保存失败/);
  fail = false; await mac.form.onsubmit({ preventDefault() {} });
  assert.equal(saved, "tray"); assert.equal(mac.save.disabled, true); assert.match(mac.status.textContent, /已保存/);
  let finish; const late = closePanel();
  const detached = createClosePreferenceUI(late.panel, { getPreferences: () => new Promise(resolve => { finish = resolve; }) });
  const pending = detached.refresh(); detached.dispose(); finish({ platform: "darwin", closeMode: "tray" }); await pending;
  assert.equal(late.selected(), "");
  const broken = closePanel(); let brokenRead = true;
  const retryUI = createClosePreferenceUI(broken.panel, { getPreferences: async () => { if (brokenRead) throw new Error("unavailable"); return { platform: "darwin", closeMode: null }; } });
  await retryUI.refresh(); assert.equal(broken.retry.hidden, false); assert.equal(broken.options.every(option => option.disabled), true);
  brokenRead = false; await broken.retry.onclick(); assert.equal(broken.retry.hidden, true); assert.equal(broken.options.every(option => !option.disabled), true);
});

test("Runtime headings stay subordinate and General uses an explicit native radio group", async () => {
  const settings = await readFile(new URL("../web/settings.mjs", import.meta.url), "utf8");
  const css = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
  const desktop = await readFile(new URL("../apps/electron/compact.css", import.meta.url), "utf8");
  assert.doesNotMatch(settings, /本机执行说明与版本|data-control-version|<select[^>]*name="closeMode"/);
  for (const mode of ["quit", "tray"]) assert.match(settings, new RegExp(`type="radio" name="closeMode" value="${mode}" disabled`));
  assert.match(settings, /fieldset class="settings-radio-group"><legend>关闭主窗口时/);
  assert.match(css, /summary h4 \{ font-size:14px; font-weight:500/);
  assert.match(desktop, /summary h4 \{ font-size:13px; font-weight:500/);
  assert.doesNotMatch(settings, /profile && !profile\.system/);
});

test("team editing preserves inactive selections and requires an available manager and business member", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const controller = source.slice(source.indexOf("function teamModal("), source.indexOf("const newTeamModal ="));
  const agents = [
    { id: "manager-active", kind: "manager", status: "active", name: "可用经理" },
    { id: "manager-inactive", kind: "manager", status: "inactive", name: "原经理" },
    { id: "member-active", kind: "business", status: "active", name: "可用员工" },
    { id: "member-inactive", kind: "business", status: "inactive", name: "原员工" },
  ];
  const handlers = {}, errors = [], calls = [], notices = [];
  const managerField = {}, membersField = {}, pickers = {};
  const form = {
    closest: () => ({ classList: { add() {} } }),
    name: { value: "仅改团队名" }, elements: { managerAgentId: managerField },
    querySelector: selector => selector === ".check-grid" ? membersField : null,
    addEventListener: (event, callback) => { handlers[event] = callback; },
  };
  let html = "", values = { name: "仅改团队名", mission: "", managerAgentId: "manager-inactive", memberAgentIds: ["member-active", "member-inactive"] };
  const context = {
    state: { agents }, toast: (...args) => notices.push(args), esc: String, roleColor: () => "", initialsOf: () => "",
    openModal: value => { html = value; }, $: selector => selector === "#team-manager-search" ? managerField : selector === "#team-members-search" ? membersField : form, clearInvalid() {},
    mountEmployeePicker: (host, options) => { pickers[options.name] = options; },
    setInvalid: (field, message) => errors.push({ field, message }),
    FormData: class { get(name) { return values[name]; } getAll(name) { return values[name]; } },
    api: async (path, options) => calls.push({ path, input: JSON.parse(options.body) }), closeModal() {}, refresh: async () => {},
  };
  vm.runInNewContext(`${controller}; teamModal({id:'team',name:'原团队',managerAgentId:'manager-inactive',memberAgentIds:['member-active','member-inactive']});`, context);
  assert.deepEqual(Array.from(pickers.managerAgentId.selectedIds), ["manager-inactive"]);
  assert.deepEqual(Array.from(pickers.memberAgentIds.selectedIds), ["member-active", "member-inactive"]);
  assert.ok(pickers.memberAgentIds.agents.some(agent => agent.id === "member-inactive"));
  await handlers.submit({ preventDefault() {} });
  assert.equal(calls.length, 0);
  assert.equal(errors[0].field, managerField);
  assert.match(errors[0].message, /可用的项目经理/);

  values = { ...values, managerAgentId: "manager-active", memberAgentIds: ["member-inactive"] };
  errors.length = 0;
  await handlers.submit({ preventDefault() {} });
  assert.equal(calls.length, 0);
  assert.equal(errors[0].field, membersField);
  assert.match(errors[0].message, /可用业务数字员工/);

  values.memberAgentIds = ["member-active", "member-inactive"];
  errors.length = 0;
  await handlers.submit({ preventDefault() {} });
  assert.equal(errors.length, 0);
  assert.equal(calls[0].path, "/api/teams/team");
  assert.deepEqual(calls[0].input.memberAgentIds, ["member-active", "member-inactive"], "saving a name does not silently discard inactive members");
  assert.equal(calls[0].input.managerAgentId, "manager-active", "replacement is an explicit selection, never an implicit first option");

  context.state.agents = agents.filter(agent => agent.id !== "manager-active");
  html = "";
  vm.runInNewContext("teamModal();", context);
  assert.equal(html, "");
  assert.match(notices.at(-1)[0], /创建或启用一位项目经理/);
});

test("configuration deletion responses cannot close or contaminate a replacement modal", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const controller = source.slice(source.indexOf("function configurationDeletionModal("), source.indexOf("function teamModal("));
  const fixture = () => {
    const button = { isConnected: true, disabled: false }, originalError = {}, replacementError = {}, requests = [], notices = [];
    let callback, resolve, reject, closed = 0, refreshed = 0, currentError = originalError;
    button.addEventListener = (_event, handler) => { callback = handler; };
    const context = {
      state: { agents: [{ id: "employee/1", name: "员工" }] }, toast: (...args) => notices.push(args), esc: String, openModal() {},
      $: selector => selector === "[data-confirm-configuration-delete]" ? button : currentError,
      api: (path, options) => { requests.push({ path, options }); return new Promise((yes, no) => { resolve = yes; reject = no; }); },
      closeModal: () => { closed++; }, refresh: async () => { refreshed++; },
    };
    vm.runInNewContext(`${controller}; configurationDeletionModal('agent','employee/1');`, context);
    return { button, originalError, replacementError, requests, notices,
      click: () => callback(), resolve: () => resolve({}), reject: () => reject(new Error("仍被团队使用")),
      replace() { button.isConnected = false; currentError = replacementError; }, closed: () => closed, refreshed: () => refreshed };
  };
  const success = fixture(), pendingSuccess = success.click();
  assert.equal(success.button.disabled, true);
  assert.equal(success.requests[0].path, "/api/agents/employee%2F1");
  success.replace(); success.resolve(); await pendingSuccess;
  assert.equal(success.closed(), 0, "an old successful delete must not close the new modal");
  assert.equal(success.refreshed(), 1, "the accepted deletion still refreshes the directory");
  assert.equal(success.replacementError.textContent, undefined);

  const staleFailure = fixture(), pendingFailure = staleFailure.click();
  staleFailure.replace(); staleFailure.reject(); await pendingFailure;
  assert.equal(staleFailure.closed(), 0);
  assert.equal(staleFailure.replacementError.textContent, undefined, "the error is not written to a new modal's feedback element");
  assert.match(staleFailure.notices.at(-1)[0], /仍被团队使用/);
  assert.equal(staleFailure.notices.at(-1)[1], true);

  const currentFailure = fixture(), pendingCurrent = currentFailure.click();
  currentFailure.reject(); await pendingCurrent;
  assert.equal(currentFailure.button.disabled, false, "the original modal can retry a rejected delete");
  assert.match(currentFailure.originalError.textContent, /仍被团队使用/);
  assert.equal(currentFailure.refreshed(), 0);
});

test("sidebar counts only human attention and unread replies rather than inventory", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const shell = source.slice(source.indexOf("function renderShell()"), source.indexOf("let navigationRequest"));
  const nodes = new Map();
  const context = { state: { currentView: "tasks", communicationUnreadCount: 3, runs: [{ taskId: "a", status: "running" }, { taskId: "b", status: "paused" }, { taskId: "b", status: "failed" }, { taskId: "archived", status: "failed", task: { archivedAt: "yesterday" } }] }, taskNeedsAttention,
    $: selector => { if (!nodes.has(selector)) nodes.set(selector, { style: {}, setAttribute() {} }); return nodes.get(selector); } };
  vm.runInNewContext(`${shell}; renderShell();`, context);
  assert.equal(nodes.get("#nav-task-count").textContent, 1);
  assert.equal(nodes.get("#nav-ws-hint").textContent, "待你处理");
  assert.equal(nodes.get("#nav-communication-count").textContent, 3);
  for (const id of ["team", "workflow", "agent"]) assert.equal(nodes.has(`#nav-${id}-count`), false);
  context.state.navigationNotifications = { taskAttentionCount: 0, communicationUnreadCount: 0 };
  vm.runInNewContext("renderShell();", context);
  assert.equal(nodes.get("#nav-task-count").hidden, true);
  assert.equal(nodes.get("#nav-communication-count").hidden, true);
});

test("overview presents execution facts without inferred completion percentages", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const renderSource = source.slice(source.indexOf("function renderOverview()"), source.indexOf("/* ---------- 任务中心 ---------- */"));
  const escape = value => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  function render(runs, tasks = []) {
    const panels = new Map();
    const context = {
      state: { runs, tasks, agents: [], events: [], teams: [] },
      $: selector => { if (!panels.has(selector)) panels.set(selector, { innerHTML: "" }); return panels.get(selector); },
      taskMatchesFilter, taskNeedsAttention, taskActionLabel, statusText: STATUS_TEXT, esc: escape,
      pill: status => `<span class="status-pill">${STATUS_TEXT[status]}</span>`,
      workspaceSummary: () => "系统受管目录", timeAgo: () => "刚刚",
    };
    vm.runInNewContext(`${renderSource}; renderOverview();`, context);
    assert.doesNotMatch(panels.get("#stats-grid").innerHTML, /已验收/);
    assert.match(panels.get("#stats-grid").innerHTML, /已接纳的 Run 内快照/);
    return { active: panels.get("#active-run-panel").innerHTML, stats: panels.get("#stats-grid").innerHTML };
  }
  const run = status => ({ id: `run-${status}`, status, task: { title: "<unsafe>", objective: "真实目标" }, traceCount: 3, artifactCount: 2 });
  for (const status of ["planning", "running", "awaiting_human", "review", "awaiting_acceptance", "paused", "blocked", "failed"]) {
    const { active } = render([run(status)]);
    assert.match(active, new RegExp(`data-open-run="run-${status}"`));
    assert.ok(active.includes(STATUS_TEXT[status]));
    assert.match(active, /3 条 Trace · 2 个文件/);
    assert.match(active, /&lt;unsafe&gt;/);
    assert.doesNotMatch(active, /<unsafe>|run-progress|width:|%|已完成/);
    assert.ok(active.includes(taskNeedsAttention(status) ? taskActionLabel(status) : "进入任务空间"));
  }
  const zero = render([{ ...run("running"), traceCount: 0, artifactCount: 0 }]);
  assert.match(zero.active, /0 条 Trace · 0 个文件/);
  const priority = render([run("running"), run("awaiting_acceptance")]);
  assert.match(priority.active, /data-open-run="run-awaiting_acceptance"/);
  assert.doesNotMatch(priority.active, /data-open-run="run-running"|已完成/);
  for (const runs of [[], [run("completed")], [run("cancelled")]]) {
    const { active } = render(runs);
    assert.match(active, /没有进行中或待处理任务/);
    assert.doesNotMatch(active, /data-open-run|run-progress|%/);
  }
  const completed = render([run("completed")], [{ title: "已验收任务", status: "done" }]);
  assert.match(completed.stats, /已完成任务[\s\S]*?stat-value">1</);
});

test("workspace removes delivery-version navigation without removing backend Artifact history", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /data-ws-tab="artifacts"|artifact-snapshots-panel|loadArtifactSnapshot|selectedArtifactId/);
  assert.match(source, /data-open-acceptance-directory/);
  assert.ok(source.includes('>CHANGE</button>'));
  assert.match(source, /data-back-to-tasks aria-label="返回任务列表"/);
  assert.ok(source.includes('if ((target = el("[data-back-to-tasks]"))) return setView("tasks")'));
  const apiSource = await readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
  assert.ok(apiSource.includes('runFiles.readArtifact'));
});

test("acceptance and deletion counts do not claim human-approved Artifacts and retain explicit acknowledgement", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const acceptance = { verified: true, findings: ["checked"], criteria: ["criterion"], artifactCount: 2, reviewTraceId: "trace", legacy: false };
  const run = { id: "run", status: "awaiting_acceptance", task: { title: "task" } };
  const nodes = new Map(), requests = [];
  const context = {
    state: { workspace: { run }, tasks: [{ id: "task", title: "task" }], runs: [{ id: "run", taskId: "task", artifactCount: 2 }] },
    esc: String, acceptance, run, acceptanceReview: () => acceptance, acceptanceCriteriaMarkup: () => "criteria",
    openModal: html => { context.html = html; }, toast: () => {}, api: (...args) => { requests.push(args); },
    $: selector => { if (!nodes.has(selector)) nodes.set(selector, { disabled: true, checked: false, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; } }); return nodes.get(selector); },
  };
  const collaboration = slice("function renderCollaboration(", "/* ---------- 任务空间数据与动作");
  assert.doesNotMatch(collaboration, /acceptancePanel|acceptanceReview|collaboration-review|经理交接说明/);
  assert.doesNotMatch(source, /data-stop-inquiries|停止答疑/);
  for (const [start, end, invocation, ack, confirm] of [
    ["function openCompletionModal(", "async function retryScheduledWorkspace(", "openCompletionModal('run')", "#ack-completion", "#confirm-completion"],
    ["function openDeleteTaskModal(", "function openTerminateModal(", "openDeleteTaskModal('task')", "#delete-task-acknowledged", "#confirm-delete-task"],
  ]) {
    vm.runInNewContext(`${slice(start, end)}; ${invocation};`, context);
    assert.doesNotMatch(context.html, /已验收/);
    assert.match(context.html, /2 项已接纳交付快照/);
    assert.match(context.html, /id="confirm-[^"]+" disabled/);
    const checkbox = nodes.get(ack), button = nodes.get(confirm);
    assert.equal(button.disabled, true);
    checkbox.checked = true; checkbox.handlers.change({ target: checkbox });
    assert.equal(button.disabled, false);
    checkbox.checked = false; checkbox.handlers.change({ target: checkbox });
    assert.equal(button.disabled, true);
    assert.deepEqual(requests, []);
  }
  // The completion dialog keeps the frozen standards text for the human's
  // final check against real delivered Artifacts.
  vm.runInNewContext(`${slice("function openCompletionModal(", "async function retryScheduledWorkspace(")}; openCompletionModal('run');`, context);
  assert.match(context.html, /任务验收标准/);
  assert.match(context.html, /criteria/);
});

test("console rendering keeps chronological events separate from directory sorting", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const slice = source.slice(source.indexOf("function renderChatStream("), source.indexOf("function rememberDirectoryReading("));
  const stream = { innerHTML: "", scrollHeight: 120, scrollTop: 0 };
  const context = { queueMicrotask: () => {}, $: () => stream, isTransportFrame: () => false, summarizeHistoricalAuditEntries: entries => entries, buildConsoleEntries: events => events.map(event => ({ type: "event", event })), renderChatEvent: event => event.id, state: { selectedRunId: "run", workspace: null } };
  vm.runInNewContext(`${slice}; renderChatStream([{id:'later',timestamp:'2026-01-02',actor:{id:'a'}},{id:'earlier',timestamp:'2026-01-01',actor:{id:'a'}}],{id:'a'});`, context);
  assert.equal(stream.innerHTML, "earlierlater");
  assert.equal(stream.scrollTop, 120);
});

test("console does not echo collaboration messages as a second system result", async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const slice = source.slice(source.indexOf('function renderChatStream('), source.indexOf('function rememberDirectoryReading('));
  for (const id of ['employee', 'manager']) {
    const stream = { innerHTML: '', scrollHeight: 100 };
    const events = [
      { id: 'provider-text', type: 'runtime.event', actor: { id }, timestamp: '2026-01-01' },
      { id: 'duplicate-handoff', type: 'message.sent', actor: { id }, timestamp: '2026-01-02' },
      { id: 'failure', type: 'trace.failed', actor: { id }, timestamp: '2026-01-03' },
    ];
    const context = { queueMicrotask: () => {}, $: () => stream, isTransportFrame: () => false, summarizeHistoricalAuditEntries: rows => rows, buildConsoleEntries: rows => rows.map(event => ({ type: 'event', event })), renderChatEvent: event => `[${event.id}]`, state: { selectedRunId: 'run', workspace: null }, events, agent: { id } };
    vm.runInNewContext(`${slice}; renderChatStream(events, agent);`, context);
    assert.equal(stream.innerHTML, '[provider-text][failure]');
    assert.equal(events.length, 3, 'stored collaboration facts are not mutated');
  }
});

test('CHANGE shares complete workspace hierarchy and retains deleted files and gitlinks', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const { workingDirectoryIcon } = await import('../client/console-projections.mjs');
  const context = vm.createContext({ workingDirectoryIcon, esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;') });
  vm.runInContext(source.slice(source.indexOf('function directoryNodeIcon('), source.indexOf('function renderWorkingDirectory(')) + source.slice(source.indexOf('function workingChangesTree('), source.indexOf('function rememberDiffReading(')), context);
  const view = { directoryOpen: {}, directory: { directories: [{ path: 'docs/content', type: 'files' }] } };
  const repo = { path: '', changes: [{ path: 'docs/content/nested/a.js', status: 'M' }, { path: 'docs/content/deleted.md', status: 'D' }] };
  const current = context.workingFileTree([{type:'directory',path:'docs',name:'docs',children:[{ type: 'directory', path: 'docs/content', name: 'content', children: [{ type: 'directory', path: 'docs/content/nested', name: 'nested', children: [{ type: 'file', path: 'docs/content/nested/a.js', name: 'a.js' }] }] }]}], view, 'vscode-light');
  const change = context.workingChangesTree(repo, view, 'vscode-light');
  assert.deepEqual([...current.matchAll(/<summary>(.*?)<\/summary>/g)].map(match => match[1]), [...change.matchAll(/<summary>(.*?)<\/summary>/g)].map(match => match[1]));
  assert.match(change, /data-diff-directory="docs\/content"/);
  assert.match(change, /data-diff-directory="docs"/);
  assert.match(change, /data-select-diff="docs\/content\/deleted.md"/);
  assert.doesNotMatch(current, /deleted.md|source-status/);
  view.changes = { repositories: [{ path: '', changes: [{ path: 'repos/app', submodule: true, status: 'M' }] }] };
  const gitlink = context.workingChangesTree({changes:[{path:'repos/app',submodule:true,status:'M'}]}, view, 'classic');
  assert.match(gitlink, /data-select-diff="repos\/app"/);
  assert.match(gitlink, /查看仓库提交变化/);
});

test('CHANGE is independent of the current-file directory page and can show deleted paths', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const view = { changesRequest: 0, changes: null };
  const load = vm.runInNewContext(`${source.slice(source.indexOf('async function loadWorkingChanges('), source.indexOf('async function loadWorkingDiff('))}; loadWorkingChanges`, {
    workspaceView: () => view, renderWorkingChanges: () => {}, api: async () => ({ repositories: [] }), loadWorkingDirectory: async () => { view.directoryError = '工作目录不可读取'; }
  });
  await load('run');
  assert.deepEqual(view.changes,{repositories:[]});assert.equal(view.changesLoading, false);assert.equal(view.changesError,null);
});

test('CHANGE omits per-directory no-change labels and only declares a truthful overall empty state', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const view = { changes: { repositories: [] } }, tree = { scrollTop: 0 };
  const host = { innerHTML: '', dataset: {}, querySelector: () => tree };
  const render = vm.runInNewContext(`${source.slice(source.indexOf('function renderWorkingChanges('), source.indexOf('async function loadWorkingChanges('))}; renderWorkingChanges;`, {
    state: { selectedRunId: 'run' }, $: () => host, workspaceView: () => view,
    rememberDiffReading: () => {}, presentationPreferences: {}, esc: String,
    workingChangesTree: repo => `<ul>${repo.path || 'docs'}</ul>`, workingDiffMarkup: () => ''
  });
  const repo = (path, changes = [], rest = {}) => ({ path, initialized: true, changes, ...rest });
  const check = (repositories, count, extras = {}) => {
    Object.assign(view, { changes: { repositories }, changesError: null, changesLoading: false }, extras);
    render('run');
    assert.equal((host.innerHTML.match(/没有更改/g) || []).length, count);
    assert.ok([...host.innerHTML.matchAll(/<section class="artifact-root">(.*?)<\/section>/g)].every(match => !match[1].includes('没有更改')));
  };
  check([repo(''), repo('repos/clean'), repo('repos/changed', [{ path: 'repos/changed/a.js', status: 'M' }])], 0);
  check([repo(''), repo('repos/clean')], 1);
  assert.match(host.innerHTML, /role="status" data-changes-empty/);
  check([repo(''), repo('repos/broken', [], { error: '读取失败' })], 0); assert.match(host.innerHTML, /读取失败/);
  check([repo('', [], { initialized: false })], 0); assert.match(host.innerHTML, /尚未初始化 Git/);
  check([repo('')], 0, { changesLoading: true });
  check([repo('')], 0, { changesError: '请求失败' });
  check([], 0);
  check([repo('', [{ path: 'repos/clean', submodule: true, status: 'M' }]), repo('repos/clean')], 0);
});

test('file downloads capture the selected path, avoid duplicate clicks and surface errors in place', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function downloadWorkingFile('), source.indexOf('async function loadWorkingFile('));
  const view = { selectedPath: null }, links = [], errors = [], revoked = [];
  let fetches = 0, respond, cleanup;
  const context = {
    workspaceView: () => view, renderWorkingDirectory: () => {}, toast: (...args) => errors.push(args),
    fetch: () => { ++fetches; return new Promise(resolve => { respond = resolve; }); },
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: url => revoked.push(url) },
    setTimeout: fn => { cleanup = fn; },
    document: { body: { append: link => links.push(link) }, createElement: () => ({ click() { this.clicked = true; }, remove() { this.removed = true; } }) }
  };
  const download = vm.runInNewContext(`${body}; downloadWorkingFile;`, context);
  await download('run'); assert.equal(fetches, 0);
  view.selectedPath = 'docs/原文.md';
  const pending = download('run');
  await download('run'); assert.equal(fetches, 1);
  view.selectedPath = 'docs/another.md';
  respond({ ok: true, blob: async () => ({}) }); await pending;
  assert.equal(links[0].download, '原文.md'); assert.equal(links[0].clicked, true); assert.equal(links[0].removed, true);
  assert.equal(view.downloadingPath, null); cleanup(); assert.deepEqual(revoked, ['blob:fixture']);
  const failed = download('run'); respond({ ok: false, json: async () => ({ error: '文件不存在' }) }); await failed;
  assert.deepEqual(errors, [['下载失败：文件不存在', true]]);
  assert.equal(links.length, 1); assert.equal(view.downloadingPath, null);
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes(':is(#working-directory-panel, #working-diff-panel) .artifact-root { margin:0; padding:0; min-height:0; }'));
  assert.match(source, /data-download-working-file \$\{!view.selectedPath \|\| view.downloadingPath \? "disabled"/);
});

test("console timeline binds a prompt entry to each invocation's own Trace", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const slice = source.slice(source.indexOf("function tracePromptMarkup("), source.indexOf("function consoleFailurePanel("))
    + source.slice(source.indexOf("function renderChatStream("), source.indexOf("function rememberDirectoryReading("));
  const stream = { innerHTML: "", scrollHeight: 0, scrollTop: 0 };
  const traces = [
    { id: "trace-old", workflowNodeId: "requirements", startedAt: "t0", promptRef: null },
    { id: "trace-new", workflowNodeId: "development", startedAt: "t1", promptRef: { storagePath: "runs/run-1/traces/trace-new/prompt-snapshot.json" } },
  ];
  const context = {
    queueMicrotask: () => {}, $: () => stream, isTransportFrame: () => false,
    summarizeHistoricalAuditEntries: entries => entries,
    buildConsoleEntries, // the real projection, including Trace-aware tool grouping
    renderChatEvent: event => `<row>${event.id}</row>`,
    renderToolEntry: entry => `<tool>${entry.event.id}</tool>`,
    renderToolGroup: group => `<group>${group.tools.map((tool) => tool.event.id).join(",")}</group>`,
    state: { selectedRunId: "run-1", workspace: { run: { id: "run-1" }, traces } },
    esc: String, exactTime: value => value,
  };
  vm.runInNewContext(`${slice}; renderChatStream([
    { id: "e1", timestamp: "2026-01-01", actor: { id: "a" }, data: { traceId: "trace-old" } },
    { id: "e2", timestamp: "2026-01-02", actor: { id: "a" }, data: { traceId: "trace-new" } },
    { id: "e3", timestamp: "2026-01-03", actor: { id: "a" }, data: { traceId: "trace-missing" } },
  ], { id: "a" });`, context);
  const html = stream.innerHTML;
  // Each invocation's prompt entry precedes its own events and binds that Trace.
  const order = ['data-console-key="prompt:trace-old"', "<row>e1</row>", 'data-console-key="prompt:trace-new"', "<row>e2</row>", "<row>e3</row>"];
  assert.deepEqual(order.map((needle) => html.indexOf(needle)).every((index) => index >= 0), true);
  assert.deepEqual([...order.keys()].slice(1).every((index) => html.indexOf(order[index]) > html.indexOf(order[index - 1])), true);
  // Missing snapshot says so honestly; a saved snapshot is fetched on demand.
  assert.match(html, /该次调用未保存提示词快照/);
  assert.match(html, /data-prompt-snapshot="trace-new"/);
  // A Trace outside the current read model is never given fabricated content.
  assert.match(html, /提示词快照不可定位/);
  assert.equal((html.match(/log-row-trace-prompt/g) || []).length, 3);
});

test("prompt entries follow invocation records and tool groups respect Trace boundaries", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const slice = source.slice(source.indexOf("function tracePromptMarkup("), source.indexOf("function consoleFailurePanel("))
    + source.slice(source.indexOf("function renderChatStream("), source.indexOf("function rememberDirectoryReading("));
  const mkContext = (stream, traces) => ({
    queueMicrotask: () => {}, $: () => stream, isTransportFrame: () => false,
    summarizeHistoricalAuditEntries: entries => entries,
    buildConsoleEntries, // the real projection: same-name tools from different Traces must not merge
    renderChatEvent: event => `<row>${event.id}</row>`,
    renderToolEntry: entry => `<tool>${entry.event.id}</tool>`,
    renderToolGroup: group => `<group>${group.tools.map((tool) => tool.event.id).join(",")}</group>`,
    state: { selectedRunId: "run-1", workspace: { run: { id: "run-1" }, traces } },
    esc: String, exactTime: value => value,
  });
  // A running invocation that has not emitted any visible event yet still
  // exposes its own prompt entry; entries come from Trace records, not events.
  const streamA = { innerHTML: "", scrollHeight: 0, scrollTop: 0 };
  vm.runInNewContext(`${slice}; renderChatStream([
    { id: "e1", type: "runtime.event", timestamp: "2026-01-01T00:10:00Z", actor: { id: "a" }, data: { traceId: "trace-done", providerEventType: "assistant" } },
  ], { id: "a" });`, mkContext(streamA, [
    { id: "trace-done", agentId: "a", workflowNodeId: "requirements", startedAt: "2026-01-01T00:00:00Z", status: "completed", promptRef: { storagePath: "runs/run-1/traces/trace-done/prompt-snapshot.json" } },
    { id: "trace-running", agentId: "a", workflowNodeId: "development", startedAt: "2026-01-01T01:00:00Z", status: "running", promptRef: { storagePath: "runs/run-1/traces/trace-running/prompt-snapshot.json" } },
  ]));
  assert.match(streamA.innerHTML, /data-console-key="prompt:trace-done"/);
  assert.match(streamA.innerHTML, /data-console-key="prompt:trace-running"/);
  assert.ok(streamA.innerHTML.indexOf("prompt:trace-running") > streamA.innerHTML.indexOf("<row>e1</row>"), "the fresh invocation's entry follows the older one");
  assert.match(streamA.innerHTML, /data-prompt-snapshot="trace-running"/);
  // A silent call can be recovered as failed on startup without producing a
  // member event. It must remain visible even though it started after the last event.
  const streamRecovered = { innerHTML: "", scrollHeight: 0, scrollTop: 0 };
  vm.runInNewContext(`${slice}; renderChatStream([
    { id: "prior", timestamp: "2026-01-01T00:10:00Z", actor: { id: "a" }, data: { traceId: "older" } },
  ], { id: "a" }, { hasMore: true });`, mkContext(streamRecovered, [
    { id: "older", agentId: "a", startedAt: "2026-01-01T00:00:00Z" },
    { id: "recovered", agentId: "a", startedAt: "2026-01-01T01:00:00Z", status: "failed", promptRef: { storagePath: "saved" } },
  ]));
  assert.match(streamRecovered.innerHTML, /data-prompt-snapshot="recovered"/);
  // Two consecutive same-name tools from different invocations: no merged
  // group, and each invocation keeps its own prompt entry before its tool.
  const streamB = { innerHTML: "", scrollHeight: 0, scrollTop: 0 };
  vm.runInNewContext(`${slice}; renderChatStream([
    { id: "u1", type: "runtime.event", timestamp: "2026-01-01T00:05:00Z", actor: { id: "a" }, data: { traceId: "t1", presentation: "tool", toolName: "Bash", toolUseId: "u1" } },
    { id: "u2", type: "runtime.event", timestamp: "2026-01-01T01:05:00Z", actor: { id: "a" }, data: { traceId: "t2", presentation: "tool", toolName: "Bash", toolUseId: "u2" } },
  ], { id: "a" });`, mkContext(streamB, [
    { id: "t1", agentId: "a", workflowNodeId: "n", startedAt: "2026-01-01T00:00:00Z", promptRef: { storagePath: "runs/run-1/traces/t1/prompt-snapshot.json" } },
    { id: "t2", agentId: "a", workflowNodeId: "n", startedAt: "2026-01-01T01:00:00Z", promptRef: { storagePath: "runs/run-1/traces/t2/prompt-snapshot.json" } },
  ]));
  const htmlB = streamB.innerHTML;
  assert.equal((htmlB.match(/<group>/g) || []).length, 0, "tools from different invocations are never visually grouped");
  const orderB = ['data-console-key="prompt:t1"', "<tool>u1</tool>", 'data-console-key="prompt:t2"', "<tool>u2</tool>"];
  assert.ok(orderB.every((needle) => htmlB.includes(needle)), "both invocations keep their own prompt entry and tool row");
  assert.ok([...orderB.keys()].slice(1).every((index) => htmlB.indexOf(orderB[index]) > htmlB.indexOf(orderB[index - 1])), "prompt entry precedes its own invocation's tool");
});

test("prompt is a paginated chronological entry, including interleaved invocations", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const slice = source.slice(source.indexOf("function tracePromptMarkup("), source.indexOf("function consoleFailurePanel("))
    + source.slice(source.indexOf("function renderChatStream("), source.indexOf("function rememberDirectoryReading("));
  const stream = { innerHTML: "", scrollHeight: 0, scrollTop: 0 };
  const traces = [{ id: "long", agentId: "a", startedAt: "2026-01-01T00:00:00Z", status: "running", promptRef: {} }, { id: "short", agentId: "a", startedAt: "2026-01-01T00:03:00Z", promptRef: {} }];
  const context = { queueMicrotask: () => {}, $: () => stream, isTransportFrame: e => e.type === "transport",
    summarizeHistoricalAuditEntries: entries => entries, buildConsoleEntries,
    renderChatEvent: e => `<row>${e.id}</row>`,
    state: { selectedRunId: "r", workspace: { run: { id: "r" }, traces } }, esc: String, exactTime: String };
  const event = (id, minute, traceId, type = "runtime.event") => ({ id, type, actor: { id: "a" }, timestamp: `2026-01-01T00:0${minute}:00Z`, data: { traceId } });
  context.events = [event("tail", 5, "long")];
  vm.runInNewContext(`${slice}; renderChatStream(events, {id:"a"}, {hasMore:true})`, context);
  assert.doesNotMatch(stream.innerHTML, /prompt:/, "even a running call's start is not pinned above a partial tail");
  context.events = [event("before", 2), event("first", 4, "long"), event("other", 4, "short"), event("last", 5, "long")];
  vm.runInNewContext(`renderChatStream(events, {id:"a"}, {hasMore:true})`, context);
  assert.doesNotMatch(stream.innerHTML, /prompt:long/);
  assert.ok(stream.innerHTML.indexOf("before") < stream.innerHTML.indexOf("prompt:short"));
  context.events.unshift(event("start", 0, "long"));
  context.events.unshift({ id: "pre-call", type: "runtime.event", actor: { id: "a" }, timestamp: "2025-12-31T23:59:00Z", data: {} });
  vm.runInNewContext(`renderChatStream(events, {id:"a"}, {hasMore:false})`, context);
  const html = stream.innerHTML;
  assert.equal((html.match(/data-console-key="prompt:long"/g) || []).length, 1, "interleaving never duplicates a prompt");
  const order = ['<row>pre-call</row>', 'data-console-key="prompt:long"', '<row>start</row>', '<row>before</row>', 'data-console-key="prompt:short"', '<row>first</row>', '<row>last</row>'];
  assert.ok(order.every((value, index) => html.indexOf(value) >= 0 && (!index || html.indexOf(value) > html.indexOf(order[index - 1]))));
  context.events = [event("transport-boundary", 0, "long", "transport"), event("tail", 5, "long")];
  vm.runInNewContext(`renderChatStream(events, {id:"a"}, {hasMore:true})`, context);
  assert.match(stream.innerHTML, /prompt:long/, "hidden transport frames still establish the loaded page boundary");
});

test("tool audit rows expand safe facts without rendering raw provider fields", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderToolCall("), end = source.indexOf("function renderToolEntry", start);
  const render = new Function("esc", "exactTime", "isCurrentRuntimeAudit", "consoleContentMarkup", "isShellTool", `${source.slice(start, end)}; return renderToolCall;`)(value => String(value).replaceAll("<", "&lt;"), value => value, event => event.data?.auditVersion === 2, () => "", name => name === "Bash");
  const event = { id: "safe-id", timestamp: "now", data: { auditVersion: 2, toolName: "Read", traceId: "trace-1", toolUseId: "call-1", input: "SECRET_SENTINEL", output: "SECRET_SENTINEL" } };
  const html = render({ event, result: null });
  assert.match(html, /<details data-console-key="tool:safe-id"/);
  assert.match(html, /<summary>/);
  assert.doesNotMatch(html, /审计信息|trace-1|call-1/);
  assert.match(html, /参数和输出未保存/);
  assert.doesNotMatch(html, /SECRET_SENTINEL/);
  const structured = render({ event: { ...event, data: { ...event.data, toolName: "StructuredOutput", contentRef: {} } } });
  assert.match(structured, /^<div class="log-row/);
  assert.match(structured, /<div data-console-key="tool:safe-id"/);
  assert.doesNotMatch(structured, /class="tool-audit"/);
  assert.doesNotMatch(source, /执行记录|class="chat-thinking"/);
  assert.match(render({ event: { ...event, data: { ...event.data, status: "failed" } } }), /失败/);
  assert.doesNotMatch(render({ event: { ...event, data: { toolName: "SECRET_SENTINEL" } } }), /SECRET_SENTINEL/);
  // Real Edit records open by default and carry the tool name for the hydrate
  // pass; other tools and historical records stay collapsed.
  const edit = render({ event: { ...event, data: { ...event.data, toolName: "Edit" } } });
  assert.match(edit, /data-tool-name="Edit"/);
  assert.match(edit, /data-default-open open/);
  assert.doesNotMatch(render({ event, result: null }), /data-default-open/);
  assert.doesNotMatch(render({ event: { ...event, data: { toolName: "Edit" } } }), /data-default-open/);
  const completedRead = { ...event, runId: "run-safe", data: { ...event.data, status: "completed", contentRef: {} } };
  assert.match(render({ event: completedRead }), /data-console-summary="safe-id"/);
  assert.match(render({ event: completedRead }), />Done<\/p>/);
  assert.doesNotMatch(render({ event: { ...completedRead, data: { ...completedRead.data, status: "failed" } } }), />Done<\/p>/);
  assert.doesNotMatch(render({ event: { ...completedRead, data: { ...completedRead.data, status: "running" } } }), />Done<\/p>/);
});

test("workspace settings persist and affect only new Tasks with atomic audit", async () => {
  await mkdir(".data", { recursive: true });
  const directory = await mkdtemp(resolve(".data/workspace-settings-test-"));
  const databasePath = join(directory, "state.sqlite");
  const store = createStore({ databasePath, workspaceRoot: join(directory, "original") });
  const input = { title: "目录验收", objective: "保存新任务路径", teamId: store.listTeams()[0].id, workflowTemplateId: store.listWorkflowTemplates()[0].id };
  const old = store.createTask(input), run = store.createRun(old.id);
  for (const invalid of ["/", "relative", "", null, "/invalid\0path"]) assert.throws(() => store.updateWorkspaceSettings({ workspaceRoot: invalid }));
  assert.equal(store.getWorkspaceSettings().source, "startup");
  assert.throws(() => store.transaction(() => { store.updateWorkspaceSettings({ workspaceRoot: join(directory, "rolled-back") }); throw new Error("rollback fixture"); }), /rollback fixture/);
  assert.equal(store.getWorkspaceSettings().source, "startup");
  assert.equal(store.snapshot().events.some(e => e.type === "settings.workspace_updated"), false);
  const nextRoot = join(directory, "new");
  store.updateWorkspaceSettings({ workspaceRoot: nextRoot });
  const next = store.createTask(input);
  assert.equal(next.workspacePath, join(nextRoot, next.id));
  assert.equal(store.snapshot().tasks.find(t => t.id === old.id).workspacePath, old.workspacePath);
  assert.equal(store.listRuns().find(r => r.id === run.id).workspacePath, run.workspacePath);
  const restored = createStore({ databasePath, workspaceRoot: join(directory, "other-startup-default") });
  assert.deepEqual(restored.getWorkspaceSettings(), { workspaceRoot: nextRoot, source: "saved" });
  const audit = restored.snapshot().events.filter(e => e.type === "settings.workspace_updated");
  assert.equal(audit.length, 1);
  assert.doesNotMatch(JSON.stringify(audit), /workspace-settings-test-/);
  store.addEvent({ type: "trace.failed", runId: run.id, actor: { id: run.manager.id }, message: "LEGACY_SECRET_SENTINEL", data: {} });
  assert.doesNotMatch(JSON.stringify(store.getRunWorkspace(run.id, { summary: true }).failureEvents), /LEGACY_SECRET_SENTINEL/);
  for (let i = 0; i < 24; i++) store.addEvent({ type: "trace.failed", runId: run.id, actor: { id: run.manager.id }, message: "CLI 不可启动", data: { auditVersion: 2 } });
  const failures = store.getRunWorkspace(run.id, { summary: true }).failureEvents;
  assert.equal(failures.length, 20);
  assert.doesNotMatch(JSON.stringify(failures), /LEGACY_SECRET_SENTINEL/);
});

test("overview task titles and metadata form separate lines", async () => {
  const css = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
  const desktop = await readFile(new URL("../apps/electron/compact.css", import.meta.url), "utf8");
  const rules = selector => css.match(new RegExp(`^\\.${selector} \\{([^}]+)\\}`, "m"))[1];
  for (const selector of ["task-row-title", "task-row-meta"]) assert.match(rules(selector), /display:block/);
  assert.match(rules("task-row-title"), /overflow:hidden; text-overflow:ellipsis; white-space:nowrap/);
  assert.match(rules("task-row-copy"), /min-width:0/);
  assert.match(rules("task-row-meta"), /margin-top:5px/);
  assert.match(desktop, /\.task-row-title\s*\{[^}]*white-space:\s*normal/);
});

function memoryStorage() {
  const entries = new Map();
  return { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}

test("Runtime settings keep the shared card spacing container during loading failure", async () => {
  const source = await readFile(new URL("../web/settings.mjs", import.meta.url), "utf8");
  const css = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
  assert.match(source, /<div class="repository-access-grid" data-runtime-config><\/div>/);
  assert.match(css, /\.repository-access-grid\{display:grid;gap:12px\}/);
  const container = { className: "repository-access-grid", innerHTML: "", isConnected: true };
  const context = {
    root: { querySelector: () => container }, runtimeLoaded: false,
    api: async () => { throw new Error("unavailable"); },
    escape: value => value,
  };
  const start = source.indexOf("  async function loadRuntimes()"), end = source.indexOf("  async function loadWorkspace()", start);
  await vm.runInNewContext(`${source.slice(start, end)}; loadRuntimes()`, context);
  assert.equal(container.className, "repository-access-grid");
  assert.match(container.innerHTML, /role="alert">unavailable/);
  assert.match(container.innerHTML, /data-retry-runtime/);
  assert.equal(context.runtimeLoaded, false);
});

test("task search combines name, exact status and stable team identity", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const matches = vm.runInNewContext(`${source.slice(source.indexOf("function taskMatchesSearch("), source.indexOf("function renderTasks()"))}; taskMatchesSearch`);
  const task = { title: "验收 Alpha 门户", status: "awaiting_acceptance", teamId: "team-a", team: { id: "team-a", name: "交付团队" } };
  assert.equal(matches(task, { name: " ALPHA ", status: "awaiting_acceptance", teamId: "team-a" }), true);
  for (const query of [{ name: "不存在" }, { status: "done" }, { teamId: "team-b" }, { name: "门户", status: "running", teamId: "team-a" }]) assert.equal(matches(task, query), false);
  assert.equal(matches(task), true);
  assert.equal(matches({ title: "旧任务", status: "done", team: { id: "old-team" } }, { teamId: "old-team" }), true);
  assert.equal(matches({}, { name: "任务" }), false);
  assert.equal(task.status, "awaiting_acceptance");
  assert.match(source, /name="runtimeProfileId"/);
  assert.doesNotMatch(source, /name="executable"/);
  const settings = await readFile(new URL('../web/settings.mjs', import.meta.url), 'utf8');
  assert.match(settings, /name="executable"/);
  assert.match(settings, /data-test-runtime/);
});

test("presentation choices survive reload without storing credentials or domain state", () => {
  const storage = memoryStorage();
  const choices = { version: 1, theme: "minimal", hiddenViews: ["manual", "agents", "manual", "settings", "unknown"], showGroups: false, showIcons: false, showCounts: false, token: "private-sentinel", task: { status: "done" } };
  assert.equal(savePreferences(choices, () => storage), true);
  const restored = readPreferences(() => storage);
  assert.deepEqual(restored, { version: 2, theme: "minimal", hiddenViews: ["overview", "agents", "manual"], showGroups: false, showIcons: false, showCounts: false, showUnread: true, directoryTheme: "vscode-light" });
  assert.doesNotMatch(storage.getItem(PREFERENCES_KEY), /private-sentinel|token|task|settings|unknown/);
  assert.deepEqual(normalizePreferences(null).hiddenViews, ["overview", "manual"]);
  assert.deepEqual(normalizePreferences({ version: 2, hiddenViews: [] }).hiddenViews, [], "a deliberate later choice can show overview");
  // The working-directory theme is a local display preference with three
  // honest options; unknown or missing values fall back to the default.
  assert.equal(normalizePreferences({ version: 2, directoryTheme: "vscode-dark" }).directoryTheme, "vscode-dark");
  assert.equal(normalizePreferences({ version: 2, directoryTheme: "classic" }).directoryTheme, "classic");
  assert.equal(normalizePreferences({ version: 2, directoryTheme: "injected" }).directoryTheme, "vscode-light");
  assert.equal(normalizePreferences(null).directoryTheme, "vscode-light");
});

test("broken or unavailable local storage cannot prevent default navigation", () => {
  const defaults = normalizePreferences(null);
  for (const raw of ["{broken", "null", "[]", '"text"', '{"version":3,"theme":"minimal","hiddenViews":["tasks"]}']) {
    const storage = memoryStorage(); storage.setItem(PREFERENCES_KEY, raw);
    assert.deepEqual(readPreferences(() => storage), defaults);
  }
  assert.deepEqual(normalizePreferences({ version: 1, theme: "injected", hiddenViews: "tasks", showIcons: "false" }), defaults);
  const unavailable = () => { throw new Error("storage disabled"); };
  assert.deepEqual(readPreferences(unavailable), defaults);
  assert.equal(savePreferences({ ...defaults, theme: "minimal" }, unavailable), false);
  assert.equal(savePreferences(defaults, () => ({ setItem() { throw new Error("quota"); } })), false);
});

test("hiding every optional entry leaves Settings reachable and empty groups hidden", () => {
  const items = [...NAVIGATION.map(({ id }) => ({ dataset: { view: id }, hidden: false })), { dataset: { view: "settings" }, hidden: true }];
  const groups = ["OPERATIONS", "BUILD", "REFERENCE"].map((name) => ({ hidden: false, querySelectorAll: () => items.filter((item) => NAVIGATION.some((entry) => entry.id === item.dataset.view && entry.group === name)) }));
  const document = {
    documentElement: { dataset: {} },
    querySelector: () => null,
    querySelectorAll: (selector) => selector === "[data-navigation-group]" ? groups : items,
  };
  applyPreferences(document, { version: 2, theme: "minimal", hiddenViews: [...NAVIGATION.map(({ id }) => id), "settings"] });
  assert.equal(items.at(-1).hidden, false);
  assert.equal(items.slice(0, -1).every((item) => item.hidden), true);
  assert.equal(groups.every((group) => group.hidden), true);
  assert.equal(document.documentElement.dataset.theme, "minimal");
  applyPreferences(document, normalizePreferences(null));
  assert.equal(items.find((item) => item.dataset.view === "overview").hidden, true);
  assert.equal(items.filter((item) => !["overview", "manual"].includes(item.dataset.view)).every((item) => !item.hidden), true);
  assert.equal(items.find(item => item.dataset.view === "manual").hidden, true);
  assert.deepEqual(groups.map(group => group.hidden), [false, false, true]);
  assert.equal(document.documentElement.dataset.theme, "warm");
});

test("settings categories are refreshable routes and configuration leaves the employee shell", async () => {
  assert.deepEqual(Object.keys(SETTINGS_PAGES), ["general", "appearance", "workspace", "cli", "repositories", "runtime", "plugins", "logs"]);
  const settings = await readFile(new URL("../web/settings.mjs", import.meta.url), "utf8");
  const panel = name => settings.split(`data-settings-panel="${name}"`)[1].split("</section>")[0];
  assert.match(panel("appearance"), /navigation-options/);
  assert.match(panel("workspace"), /data-reset-all/);
  assert.match(panel("cli"), /data-cli-install/);
  assert.doesNotMatch(panel("general"), /data-cli-install/);
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const routeSource = app.slice(app.indexOf("function routeFromLocation()"), app.indexOf("const initialRoute"));
  for (const page of Object.keys(SETTINGS_PAGES)) {
    const route = vm.runInNewContext(`${routeSource}\nrouteFromLocation()`, { location: { pathname: `/settings/${page}`, hash: "" } });
    assert.equal(route.view, "settings"); assert.equal(route.settingsPage, page);
    const hosted = vm.runInNewContext(`${routeSource}\nrouteFromLocation()`, { location: { pathname: `/settings/${page}`, hash: "" }, window: { agentforgeDesktop: {} } });
    assert.equal(hosted.settingsPage, page);
  }
  assert.equal(vm.runInNewContext(`${routeSource}\nrouteFromLocation()`, { location: { pathname: "/settings", hash: "" } }).settingsPage, "general");
  const shell = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(shell, /data-view="settings" aria-label="设置"/);
  assert.doesNotMatch(shell, /class="runtime-card"|manage-git-credentials|bypass/);
  assert.doesNotMatch(app, /gitCredentialModal/);
});

test("Console initializes Settings with ready validation helpers", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const initialization = app.slice(0, app.indexOf("/* ---------- 壳层 ---------- */")).replace(/^import .*;\n/gm, "");
  let dependencies;
  vm.runInNewContext(initialization, {
    location: { pathname: "/settings/repositories", hash: "" },
    document: {}, window: { addEventListener() {} },
    createCommunicationUI: () => ({}), readPreferences: () => normalizePreferences(null), applyPreferences() {},
    createSettingsUI: (value) => { dependencies = value; return {}; },
    createMarketplaceUI: () => ({}), createMcpMarketplaceUI: () => ({}), openModal() {}, closeModal() {},
  });
  assert.equal(typeof dependencies.clearInvalid, "function");
  assert.equal(typeof dependencies.setInvalid, "function");
  assert.equal(typeof dependencies.api, "function");
});

test("in-app confirm dialog resolves on buttons and cancels on modal close", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const slice = app.slice(app.indexOf("function openModal("), app.indexOf("function clearInvalidField"));
  const classList = () => { const set = new Set(); return { add: (...names) => names.forEach(name => set.add(name)), remove: (...names) => names.forEach(name => set.delete(name)), contains: name => set.has(name) }; };
  const button = () => ({ handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; }, click() { this.handlers.click?.(); }, focus() {} });
  const cancelButton = button(), acceptButton = button();
  const modal = { classList: classList(), scrollTop: 5 };
  const backdrop = { classList: classList(), attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
  const content = {
    closest: () => modal, replaceChildren() {}, innerHTML: "",
    querySelector(selector) {
      if (selector === "[data-confirm-dialog-cancel]") return cancelButton;
      if (selector === "[data-confirm-dialog-accept]") return acceptButton;
      if (selector.startsWith("input,")) return { focus() {} };
      return null;
    },
  };
  const run = vm.runInNewContext(`${slice}\n({ confirmDialog, closeModal })`, {
    disposeWorkflowGraphs() {}, resetRequestActive: false,
    esc: (value = "") => String(value),
    $: selector => ({ "#modal-content": content, "#modal-backdrop": backdrop })[selector],
  });
  const declined = run.confirmDialog({ title: "删除工作流", message: "删除工作流「示例」？该操作不可恢复。", confirmLabel: "删除工作流", danger: true });
  assert.equal(backdrop.classList.contains("open"), true);
  assert.equal(modal.classList.contains("confirm-dialog"), true);
  assert.match(content.innerHTML, /confirm-dialog-actions/);
  assert.match(content.innerHTML, /small-button danger/);
  assert.doesNotMatch(content.innerHTML, /form-actions/, "confirm dialogs must not use the scrolling form-actions grouping");
  cancelButton.click();
  assert.equal(await declined, false, "cancel button resolves false");
  assert.equal(backdrop.classList.contains("open"), false);
  const accepted = run.confirmDialog({ title: "归档任务", message: "归档？", confirmLabel: "归档任务" });
  acceptButton.click();
  assert.equal(await accepted, true, "accept resolves true");
  const dismissed = run.confirmDialog({ title: "移除拉取 Token", message: "移除？", confirmLabel: "移除 Token", danger: true });
  run.closeModal();
  assert.equal(await dismissed, false, "backdrop/Escape close resolves cancelled without side effects");
});

test("Runtime model picker and effort options follow the real catalog with honest fallbacks", async () => {
  const { runtimeEffortOptions, RUNTIME_EFFORT_LEVELS } = await import("../web/settings.mjs");
  const { CLAUDE_EFFORT_LEVELS, CODEX_EFFORT_LEVELS } = await import("../server/runtime/model-catalog.mjs");
  assert.deepEqual(RUNTIME_EFFORT_LEVELS["claude-code"], CLAUDE_EFFORT_LEVELS, "Web fallback mirrors the server-observed Claude vocabulary");
  assert.deepEqual(RUNTIME_EFFORT_LEVELS.codex, CODEX_EFFORT_LEVELS, "Web fallback mirrors the server-observed Codex vocabulary");

  const codexCatalog = { models: [{ id: "gpt-real", levels: [{ id: "low" }, { id: "high", default: true }] }, { id: "gpt-quiet", levels: [] }] };
  const known = runtimeEffortOptions("codex", "gpt-real", codexCatalog);
  assert.deepEqual(known.options.map(option => option.value), ["", "low", "high"], "catalog levels restrict options to the model's real support");
  assert.ok(known.options.find(option => option.value === "high").label.includes("模型默认"));
  assert.match(known.note, /codex debug models/);
  const quiet = runtimeEffortOptions("codex", "gpt-quiet", codexCatalog);
  assert.deepEqual(quiet.options.map(option => option.value), [""], "models without declared levels offer no invalid options");
  const manual = runtimeEffortOptions("codex", "manual-model", codexCatalog);
  assert.deepEqual(manual.options.map(option => option.value), ["", ...CODEX_EFFORT_LEVELS], "manual codex models get the global vocabulary with an honest note");
  assert.match(manual.note, /不在目录中/);
  const noCatalog = runtimeEffortOptions("codex", "gpt-real", null);
  assert.deepEqual(noCatalog.options.map(option => option.value), ["", ...CODEX_EFFORT_LEVELS]);

  const claudeCatalog = { models: [
    { id: "sonnet", levels: CLAUDE_EFFORT_LEVELS, note: "未声明模型能力；档位由 CLI 按模型实际支持解析，不支持时回退" },
    { id: "no-effort-model", levels: [], note: "配置声明该模型不支持思考档位" }
  ] };
  assert.deepEqual(runtimeEffortOptions("claude-code", "sonnet", claudeCatalog).options.map(option => option.value), ["", ...CLAUDE_EFFORT_LEVELS]);
  const declared = runtimeEffortOptions("claude-code", "no-effort-model", claudeCatalog);
  assert.deepEqual(declared.options.map(option => option.value), [""], "declared no-effort capability offers no levels");
  assert.match(declared.note, /不支持思考档位/);
  const claudeManual = runtimeEffortOptions("claude-code", "custom-model", claudeCatalog);
  assert.deepEqual(claudeManual.options.map(option => option.value), ["", ...CLAUDE_EFFORT_LEVELS]);
  assert.match(claudeManual.note, /手工输入/);

  const source = await readFile(new URL("../web/settings.mjs", import.meta.url), "utf8");
  assert.match(source, /class="model-options" role="listbox"/, "model input keeps free text with a themed suggestion list");
  assert.match(source, /\/api\/settings\/runtime-profiles\/models\?provider=/, "the picker queries the real authenticated catalog endpoint");
  assert.match(source, /模型列表加载失败：/, "catalog failure is shown honestly");
  assert.match(source, /模型列表为空/, "empty catalog is shown honestly");
  assert.match(source, /当前值不在列表中（手工输入）/, "manual values are labelled as outside the loaded list");
  assert.match(source, /原思考等级不适用于当前模型，已清除/, "switching models clears an inapplicable saved effort instead of silently keeping it");
  assert.match(source, /'name','provider','model','executable','profile','effort'/, "effort is submitted with the profile");
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(app, /思考 " \+ esc\(agent\.runtime\.effort\)/, "employee cards show the saved effort");
});

test("Runtime form initializes the saved effort into the select (QA-RT-01)", async () => {
  const source = await readFile(new URL("../web/settings.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  async function loadRuntimes()"), end = source.indexOf("  async function loadWorkspace()", start);
  const section = source.slice(start, end);
  assert.match(section, /syncEffort\(\);\s*\n\s*\/\/ Setting a select value before its options exist silently no-ops[\s\S]*?if \(value\.effort\) effortSelect\.value = value\.effort;/, "saved effort is applied after the option set exists");
  assert.ok(section.indexOf("effortSelect.value = value.effort") < section.indexOf("form.addEventListener('submit'"), "initialization happens before submit wiring");
  // The value survives a later catalog load only when it remains applicable;
  // syncEffort keeps the control value when it is in the option set.
  assert.match(section, /if \(previous && options\.some\(option => option\.value === previous\)\) effortSelect\.value = previous;/);
});

test("Runtime catalog requests are sequenced so stale responses never overwrite a newer list (PR review)", async () => {
  const source = await readFile(new URL("../web/settings.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  async function loadRuntimes()"), end = source.indexOf("  async function loadWorkspace()", start);
  const section = source.slice(start, end);
  assert.match(section, /const catalog = \{ state: 'idle', data: null, error: '', request: 0 \}/, "per-card request counter");
  assert.match(section, /const request = \+\+catalog\.request;/, "every load is sequenced");
  assert.equal((section.match(/request !== catalog\.request\) return;/g) || []).length, 2, "stale success and failure responses are both ignored");
  assert.match(section, /provider\.addEventListener\('change', .*catalog\.request\+\+/s, "provider switch invalidates an in-flight request even without a reload");
  assert.match(section, /executable\.addEventListener\('change', .*catalog\.request\+\+/s, "executable switch invalidates an in-flight request");
  assert.match(section, /const provider = form\.elements\.provider\.value, executable = form\.elements\.executable\.value\.trim\(\);\s*\n\s*try/, "query parameters are captured at request start, not at response time");
});

test("recovered console failures are collapsed without hiding active retries", async () => {
 const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
 const code = source.slice(source.indexOf('function consoleFailurePanel('), source.indexOf('function renderConsolePage('));
 const render = new Function('esc', code + ';return consoleFailurePanel;')(String);
 const failure = {actor:{id:'a'},timestamp:'2026-10-25T10:21:34Z',message:'Provider failed',data:{traceId:'old',auditVersion:2}};
 const workspace = {run:{status:'running'},failureEvents:[failure],dispatches:[{recipientAgentId:'a',traceIds:['old','retry'],status:'done'}]};
 assert.match(render(workspace,'a'), /<details class="console-failure console-failure-history">/);
 assert.doesNotMatch(render(workspace,'a'), /data-open-runtime-settings|<details[^>]+open/);
 workspace.dispatches[0].status='queued';workspace.dispatches[0].nextRetryAt='2026-10-25T10:22:34Z';workspace.dispatches[0].attempts=1;
 assert.match(render(workspace,'a'), /等待重试/);assert.doesNotMatch(render(workspace,'a'), /<details/);
 workspace.run.status='awaiting_acceptance';assert.match(render(workspace,'a'), /<details/);
});

test('Diff explorer nests changed files, preserves collapsed directories and escapes paths', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const {workingDirectoryIcon} = await import('../client/console-projections.mjs');
  const context = vm.createContext({workingDirectoryIcon, esc: value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')});
  vm.runInContext(source.slice(source.indexOf('function directoryNodeIcon'),source.indexOf('function renderWorkingDirectory')) + source.slice(source.indexOf('function workingChangesTree'),source.indexOf('function renderWorkingChanges')),context);
  const repo = {path:'repos/app',changes:[{path:'repos/app/src/a.js',status:'M'},{path:'repos/app/src/nested/<b>.js',status:'A'},{path:'repos/app/tests/a.js',status:'D'}]};
  const html = context.workingChangesTree(repo,{selectedDiffPath:'repos/app/src/a.js',diffTreeOpen:{'repos/app/src':false}},'vscode-light');
  assert.match(html,/data-diff-directory="repos\/app\/src" >/);
  assert.match(html,/data-diff-directory="repos\/app\/src\/nested" open/);
  assert.match(html,/class="artifact-tree-file selected" data-select-diff="repos\/app\/src\/a.js"/);
  assert.match(html,/data-select-diff="repos\/app\/tests\/a.js"/);
  assert.match(html,/&lt;b>.js/);
  assert.match(html,/icons\/vscode/);
  assert.doesNotMatch(context.workingChangesTree(repo,{},'classic'),/<img/);
});

test('Edit diff separates block rows without extra newline text nodes, retaining source blank lines', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const {editDiff} = await import('../client/console-projections.mjs');
  const context = vm.createContext({editDiff,esc:String});
  vm.runInContext(source.slice(source.indexOf('function editDiffMarkup'),source.indexOf('async function hydrateConsoleContent')),context);
  const html = context.editDiffMarkup({filePath:'src/a.js',oldText:'a\n\nb',newText:'a\n\nc'});
  assert.doesNotMatch(html,/<\/span>\n/);
  assert.match(html,/<span class="diff-line diff-context">  <\/span>/);
  assert.match(html,/<span class="diff-line diff-del">-b<\/span>/);
  assert.match(html,/<span class="diff-line diff-add">\+c<\/span>/);
});

test('file tool bodies show Write text rather than its JSON envelope and preserve fallback', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const { toolFileInput } = await import('../client/console-projections.mjs');
  const render = vm.runInNewContext(`${source.slice(source.indexOf('function fileToolFieldMarkup('), source.indexOf('// Git-style diff for a real Edit'))}; fileToolFieldMarkup`, {
    toolFileInput, esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  });
  const field = { text: JSON.stringify({ file_path: 'a.js', content: '<script>\nconst answer = 42;\n' }), redacted: true, truncated: true };
  const html = render('input', field, 'Write');
  assert.match(html, /写入内容/); assert.match(html, /&lt;script>\nconst answer = 42;\n/);
  assert.match(html, /已脱敏/); assert.match(html, /已截断/);
  assert.doesNotMatch(html, /<script>|file_path|&quot;content/);
  assert.equal(render('input', { text: '{"file_path":"a"}' }, 'Read'), '');
  assert.equal(render('input', { text: '{"file_path":"a","content":""}' }, 'Write').includes('<code></code>'), true);
  assert.equal(render('input', { text: '{"file_path":"a","content":42}' }, 'Write'), null);
  assert.equal(render('input', { text: '{"file_path":"a","content":"unclosed' }, 'Write'), null);
  assert.equal(render('output', { text: 'permission denied' }, 'Write'), null, 'failure output keeps generic rendering');
});

test('split Diff aligns replacements, preserves line numbers and escapes code',async()=>{
 const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
 const context=vm.createContext({esc:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;')});
 vm.runInContext(source.slice(source.indexOf('function workingDiffMarkup'),source.indexOf('function workingChangesTree')),context);
 const preview={patch:'--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n same\n-old\n+<new>\n end\n'};
 const split=context.workingDiffMarkup(preview,'split');
 assert.match(split,/source-diff-split/);assert.match(split,/修改前/);assert.match(split,/&lt;new>/);assert.doesNotMatch(split,/<new>/);
 assert.match(split,/<tr><td class="source-line-number source-diff-del">2<\/td>.*old.*source-diff-add">2<\/td>.*&lt;new>/);
 assert.doesNotMatch(context.workingDiffMarkup(preview),/source-diff-split/);
 assert.match(context.workingDiffMarkup({patch:'@@ -1 +1 @@\n--- content\n+++ content\n'},'split'),/-- content/);
 assert.match(context.workingDiffMarkup({patch:'@@ -1 +1 @@\n--- content\n+++ content\n'},'split'),/\+\+ content/);
});

test('console session labels use the event Trace and never expose a provisional Codex ID as native',async()=>{
 const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
 const context=vm.createContext({esc:value=>String(value).replaceAll('<','&lt;')});
 vm.runInContext(source.slice(source.indexOf('function consoleSessionMarkup'),source.indexOf('function renderChatEvent')),context);
 const event={type:'session.created',actor:{id:'agent'},data:{traceId:'trace',sessionId:'allocated'}};
 const trace={id:'trace',agentId:'agent',providerSessionId:'allocated',sessionMode:'new'};
 const claude={runtime:{provider:'claude-code'}},codex={runtime:{provider:'codex'}};
 assert.match(context.consoleSessionMarkup(event,trace,claude),/Claude Code 会话 ID.*allocated/);
 assert.match(context.consoleSessionMarkup(event,trace,codex),/等待 Provider 初始化/);
 assert.doesNotMatch(context.consoleSessionMarkup(event,trace,codex),/allocated/);
 const bound={...trace,providerSessionId:'native-thread'};
 assert.match(context.consoleSessionMarkup(event,bound,codex),/Codex 会话 ID.*native-thread/);
 for(const [agent,data] of [[claude,{providerEventType:'system',subtype:'init'}],[codex,{providerEventType:'thread.started'}]]) {
  assert.match(context.consoleSessionMarkup({...event,type:'runtime.event',data:{...event.data,auditVersion:2,...data}},bound,agent),/native-thread/);
 }
 assert.equal(context.consoleSessionMarkup(event,{...bound,id:'other'},codex),'');
 assert.equal(context.consoleSessionMarkup({...event,type:'trace.completed'},bound,codex),'');
 assert.match(context.consoleSessionMarkup({...event,type:'session.resumed'},bound,codex),/native-thread/);
});

test('console bodies defer closed disclosures and stop queued reads after leaving the task', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function consoleContentVisible('), end = source.indexOf('let consoleContentObserver', start);
  const state = { currentView: 'workspace' }, view = { tab: 'console' };
  const visible = vm.runInNewContext(`${source.slice(start, end)}; consoleContentVisible`, { state, workspaceView: () => view });
  const group = { tagName: 'DETAILS', open: false }, tool = { tagName: 'DETAILS', open: true, parentElement: group };
  const node = { isConnected: true, parentElement: tool };
  assert.equal(visible(node), false, 'nested content must wait for outer group');
  group.open = true; assert.equal(visible(node), true);
  tool.open = false; assert.equal(visible(node), false);
  const summary = { parentElement: tool };
  const header = { isConnected: true, dataset: { consoleSummary: 'event-1' }, parentElement: summary };
  tool.dataset = { toolName: 'Bash' };
  assert.equal(visible(header), true, 'tool summary loads while its own disclosure is closed');
  group.open = false; assert.equal(visible(header), false, 'closed outer groups still defer summaries');
  group.open = true;
  tool.open = true; node.isConnected = false; assert.equal(visible(node), false);
  node.isConnected = true; view.tab = 'collaboration'; assert.equal(visible(node), false);
  view.tab = 'console'; state.currentView = 'tasks'; assert.equal(visible(node), false);
  assert.match(source, /if \(tab === "console" && selected\)/);
  assert.doesNotMatch(source, /state.selectedAgentId = executing\?/);
  assert.match(source, /limit: "50"/);
});

test('tool summaries load without opening bodies, deduplicate reads and bound concurrency', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const { toolCommandSummary } = await import('../client/console-projections.mjs');
  let reads = 0, active = 0, peak = 0;
  const cache = new Map();
  const hydrate = vm.runInNewContext(`${source.slice(source.indexOf('async function hydrateConsoleContent('), source.indexOf('const promptSnapshotCache'))}; hydrateConsoleContent`, {
    consoleContentVisible: node => node.isConnected, consoleContentCache: cache, toolCommandSummary,
    api: async url => {
      reads++; peak = Math.max(peak, ++active); await Promise.resolve(); active--;
      if (url.endsWith('/broken')) throw new Error('integrity failure');
      return { fields: { input: { text: '{"command":"npm test"}' } } };
    }
  });
  const node = id => ({ isConnected: true, dataset: { consoleSummary: id, contentRun: 'run' }, closest: selector => selector === '[data-tool-name]' ? { dataset: { toolName: 'Bash' } } : null });
  const first = node('same'), second = node('same'), failed = node('broken');
  await hydrate([first, second, failed, ...Array.from({ length: 8 }, (_, i) => node(String(i)))]);
  assert.equal(reads, 10, 'the same content reference is fetched only once');
  assert.ok(peak <= 4);
  assert.equal(first.textContent, 'npm test'); assert.equal(second.textContent, 'npm test');
  assert.match(failed.textContent, /不可读取或校验失败/);
  const detached = node('detached'); detached.isConnected = false;
  await hydrate([detached]); assert.equal(reads, 10);
});

test('command and file tool groups expose their rows by default but other groups stay closed', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const { isShellTool } = await import('../client/console-projections.mjs');
  const render = vm.runInNewContext(`${source.slice(source.indexOf('function renderToolGroup('), source.indexOf('function consoleSessionMarkup('))}; renderToolGroup`, {
    isCurrentRuntimeAudit: event => event.data.auditVersion === 2, isShellTool, exactTime: String, esc: String, renderToolCall: () => '<tool-row>'
  });
  const group = name => ({ toolName: name, tools: [{ event: { id: 'one', data: { auditVersion: 2 } } }] });
  for (const name of ['Bash', 'Read', 'Write']) assert.match(render(group(name)), /data-default-open open/);
  assert.doesNotMatch(render(group('Grep')), /data-default-open/);
});

test('employee search limits large directories and excludes selected or inactive employees', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function employeeSearchResults('), end = source.indexOf('function mountEmployeePicker(', start);
  const search = vm.runInNewContext(`${source.slice(start, end)}; employeeSearchResults`);
  const agents = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), name: `员工 ${i}`, description: '媒体制作', capabilities: ['字幕'], status: i === 1 ? 'inactive' : 'active' }));
  assert.equal(search(agents, '', new Set()).length, 0);
  const results = search(agents, ' 媒体 ', new Set(['0']));
  assert.equal(results.length, 20);
  assert.equal(results.some(agent => ['0', '1'].includes(agent.id)), false);
  assert.equal(search(agents, '员工 4999', new Set())[0].id, '4999');
  assert.equal(search(agents, '字幕', new Set()).length, 20);
  assert.equal(search(agents, '不匹配', new Set()).length, 0);
});
