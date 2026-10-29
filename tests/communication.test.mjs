import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createCatalogFixtureStore as createStore } from "./fixture-store.mjs";
import { createCommunicationService } from "../server/communication.mjs";
import { RuntimeSessionMissingError, runClaudeCodeCli } from "../server/runtime/local-cli.mjs";
import { registerExecution } from "../server/runtime/registry.mjs";
import { activeMention, communicationSenderTone, createCommunicationUI, formatCommunicationContent, latestConversationId } from "../web/communication.js";
import { createMarketplace } from "../server/runtime/marketplace.mjs";

test('unselected communication chooses the latest updated conversation with stable ties and empty state',()=>{
  assert.equal(latestConversationId(),null);
  assert.equal(latestConversationId([{id:'old',updatedAt:'2026-10-01'},{id:'latest',updatedAt:'2026-10-03'},{id:'middle',updatedAt:'2026-10-02'}]),'latest');
  assert.equal(latestConversationId([{id:'a',updatedAt:'bad'},{id:'b',updatedAt:'bad'}]),'a');
});

test("communication sender accents are stable, bounded and do not claim execution state", async t => {
  assert.equal(communicationSenderTone({ type: "human", id: "x" }), "info");
  assert.equal(communicationSenderTone({ type: "agent", id: "one", name: "renamed" }), communicationSenderTone({ type: "agent", id: "one", name: "old" }));
  for (const id of ["one", "two", '<script>alert(1)</script>', "中文", ""]) assert.ok(["teal", "violet"].includes(communicationSenderTone({ type: "agent", id })));
  const f = communicationReaderFixture(t);
  f.mount(); f.take("").resolve({ conversations: [], contacts: [] });
  const result = f.result(["01"]); result.messages[0].sender = { type: "human", name: "<b>name</b>" };
  f.take("/a").resolve(result); await f.flush();
  assert.match(f.query(".communication-messages").innerHTML, /data-tone="info"/);
  assert.match(f.query(".communication-messages").innerHTML, /&lt;b&gt;name&lt;\/b&gt;/);
});

test('communication list marks only incoming unread replies, never pending outgoing work', async t => {
  const f = communicationReaderFixture(t);
  f.mount();
  f.take('').resolve({ conversations: [{ id: 'a', kind: 'agent', name: 'Employee', unreadCount: 0, pending: 1 }] });
  f.take('/a').resolve(f.result([])); await f.flush();
  assert.doesNotMatch(f.query('.communication-list').innerHTML, /<i|communication-unread|待回复消息/);
  f.tick();
  f.take('').resolve({ conversations: [{ id: 'a', kind: 'agent', name: 'Employee', unreadCount: 2, pending: 1 }] });
  f.take('/a').resolve(f.result([])); await f.flush();
  assert.match(f.query('.communication-list').innerHTML, /aria-label="2 条未读"/);
  assert.doesNotMatch(f.query('.communication-list').innerHTML, /<i|待回复消息/);
});

test('attachment upload failure retains the draft and references without sending a partial message', async t => {
  const f = communicationReaderFixture(t);
  f.mount(); f.take('').resolve({ conversations: [] }); f.take('/a').resolve(f.result([])); await f.flush();
  const files = f.query('[data-chat-file]');
  files.files = [{ name: 'a.txt', size: 1 }, { name: 'b.txt', size: 1 }]; files.onchange();
  const input = f.query('textarea'); input.value = '保留原草稿'; input.oninput();
  const sending = f.query('form').onsubmit({ preventDefault() {} });
  f.take('/a/attachments?name=a.txt').resolve({ attachment: { id: 'attachment-one' } }); await f.flush();
  f.take('/a/attachments?name=b.txt').reject(new Error('disk full')); await sending;
  assert.equal(input.value, '保留原草稿');
  assert.equal(f.pending.some(row => row.url.endsWith('/messages')), false);
  assert.match(f.query('[data-chat-attachments]').innerHTML, /a\.txt/); assert.match(f.query('[data-chat-attachments]').innerHTML, /b\.txt/);
  const retry = f.query('form').onsubmit({ preventDefault() {} });
  assert.equal(f.pending.some(row => row.url.endsWith('name=a.txt')), false, 'successful upload is not repeated');
  f.take('/a/attachments?name=b.txt').resolve({ attachment: { id: 'attachment-two' } }); await f.flush();
  f.take('/a/messages').resolve({ message: { id: 'new', createdAt: '2026-01-01T00:00:00Z', sender: { type: 'human', name: '你' }, content: '保留原草稿', attachments: [] } });
  await retry; assert.equal(input.value, '');
});

function communicationReaderFixture(t) {
  const pending = [], intervals = new Set();
  t.mock.method(globalThis, "setInterval", (callback) => { intervals.add(callback); return callback; });
  t.mock.method(globalThis, "clearInterval", (callback) => intervals.delete(callback));
  const node = () => ({ innerHTML: "", textContent: "", hidden: false, disabled: false, value: "", dataset: {}, classList: { toggle() {} }, setAttribute() {}, scrollTop: 0, scrollHeight: 100, clientHeight: 100, selectionStart: 0, querySelectorAll: () => [] });
  const nodes = new Map();
  const query = (selector) => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); };
  Object.defineProperty(query(".communication-messages"), "scrollHeight", { get() { return (this.innerHTML.match(/<article /g) || []).length * 100; } });
  query("form").querySelector = () => query('form [type="submit"]');
  const host = { isConnected: true, innerHTML: "", querySelector: query, querySelectorAll: () => [] };
  const ui = createCommunicationUI({ api: (url) => new Promise((resolve, reject) => pending.push({ url, resolve, reject })), navigate() {}, notify() {} });
  const mount = (key = "a") => ui.mount(host, { agents: [], teams: [] }, key);
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const take = (suffix) => { const index = pending.findIndex((item) => item.url === `/api/communications${suffix}`); assert.notEqual(index, -1, `request ${suffix}`); return pending.splice(index, 1)[0]; };
  const result = (ids, { before = null, more = false, name = "A" } = {}) => ({ conversation: { id: name, kind: "agent", name }, messages: ids.map((id) => ({ id, createdAt: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`, sender: { type: "agent", name }, content: `message-${id}` })), deliveries: [], nextBefore: before, hasMore: more });
  t.after(() => ui.unmount());
  return { ui, host, query, mount, flush, take, pending, result, tick: () => [...intervals].forEach((callback) => callback()), intervals };
}

test('conversation Console has one chat-header toggle and closes without rebuilding chat or losing draft', async t => {
  const f = communicationReaderFixture(t); f.mount();
  f.take('').resolve({ conversations: [] }); f.take('/a').resolve(f.result([])); await f.flush();
  const html = f.query('.communication-main').innerHTML;
  assert.match(html, /class="communication-chat">\s*<header class="communication-header">[\s\S]*?data-toggle-communication-console[\s\S]*?<\/header>/);
  assert.match(html, /<aside[^>]*data-communication-console[^>]*>\s*<div class="communication-console-toolbar">/);
  assert.doesNotMatch(html, /communication-console-header|data-close-communication-console/);
  const toggle = f.query('[data-toggle-communication-console]');
  const attributes = {}; toggle.setAttribute = (name, value) => { attributes[name] = value; };
  const input = f.query('textarea'); input.value = '不可丢失的草稿'; input.oninput();
  toggle.onclick(); assert.equal(attributes['aria-expanded'], 'true');
  assert.equal(f.query('[data-communication-console]').hidden, false);
  toggle.onclick();
  assert.equal(attributes['aria-expanded'], 'false');
  assert.equal(f.query('[data-communication-console]').hidden, true);
  assert.equal(input.value, '不可丢失的草稿'); assert.equal(f.query('.communication-main').innerHTML, html);
  f.take('/a/console?limit=50').resolve({ agents: [], traces: [], events: [], hasMore: false, nextBefore: null }); await f.flush();
  assert.equal(f.query('[data-communication-console]').hidden, true, 'late response cannot reopen closed Console');
});

for (const count of [0, 1, 3]) test(`Console toolbar has only latest/refresh with ${count} members`, async t => {
  const f = communicationReaderFixture(t); f.mount();
  f.take('').resolve({ conversations: [] }); f.take('/a').resolve(f.result([])); await f.flush();
  const html = f.query('.communication-main').innerHTML;
  const toolbar = html.match(/<div class="communication-console-toolbar">([\s\S]*?)<\/div><\/div>/)[1];
  assert.equal((toolbar.match(/<button /g) || []).length, 2);
  assert.match(toolbar, /data-communication-console-latest/); assert.match(toolbar, /data-communication-console-refresh/);
  assert.doesNotMatch(toolbar, /data-communication-members|data-communication-console-older/);
  f.query('[data-toggle-communication-console]').onclick();
  const agents = Array.from({ length: count }, (_, i) => ({ id: `member-${i}`, name: `成员${i}`, running: false }));
  const result = { agents, traces: [], events: [], hasMore: false, nextBefore: null };
  f.take('/a/console?limit=50').resolve(result); await f.flush();
  if (count) { f.take('/a/console?limit=50&agentId=member-0').resolve(result); await f.flush(); }
  assert.equal(f.query('[data-communication-members]').hidden, count < 2);
  assert.equal((f.query('[data-communication-members]').innerHTML.match(/data-communication-agent=/g) || []).length, count < 2 ? 0 : count);
});

test("unread replies persist and read acknowledgements cannot skip unseen replies or cross conversations", async t => {
  const root = await mkdtemp(join(tmpdir(), "af-unread-")), databasePath = join(root, "state.sqlite");
  let store = createStore({ databasePath });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const employee = store.listAgents().find(item => item.kind !== "manager");
  const chat = store.openCommunication({ kind: "agent", targetId: employee.id });
  const reply = (requestId) => {
    store.sendCommunication(chat.id, { content: "fixture question", clientRequestId: requestId });
    const delivery = store.claimCommunication(chat.id);
    store.completeCommunication(chat.id, delivery.id, "fixture reply");
    return store.getCommunication(chat.id).messages.at(-1);
  };
  const first = reply("unread-fixture-1");
  assert.equal(store.getNavigationNotifications().communicationUnreadCount, 1);
  const second = reply("unread-fixture-2");
  assert.equal(store.markCommunicationRead(chat.id, first.id).unreadCount, 1);
  assert.equal(store.markCommunicationRead(chat.id, second.id).unreadCount, 0);
  assert.equal(store.markCommunicationRead(chat.id, first.id).unreadCount, 0);
  const other = store.openCommunication({ kind: "team", targetId: store.listTeams()[0].id });
  assert.throws(() => store.markCommunicationRead(other.id, second.id), /不属于/);
  reply("unread-fixture-3");
  store.close(); store = createStore({ databasePath });
  assert.equal(store.listCommunications().find(item => item.id === chat.id).unreadCount, 1);
  const legacy = new DatabaseSync(databasePath);
  const snapshot = JSON.parse(legacy.prepare("SELECT state_json FROM workspace_snapshots WHERE id=1").get().state_json);
  snapshot.communicationConversations.forEach(item => delete item.humanReadThroughMessageId);
  store.close();
  legacy.prepare("UPDATE workspace_snapshots SET state_json=? WHERE id=1").run(JSON.stringify(snapshot)); legacy.close();
  store = createStore({ databasePath });
  assert.equal(store.getNavigationNotifications().communicationUnreadCount, 0, "old messages establish the upgrade baseline");
  reply("unread-fixture-4");
  assert.equal(store.getNavigationNotifications().communicationUnreadCount, 1);
});

test("conversation only acknowledges the visible latest page, never a hidden window", async t => {
  const f = communicationReaderFixture(t);
  f.host.ownerDocument = { visibilityState: "hidden" };
  f.mount("a");
  const result = f.result(["1", "2"]); result.conversation.id = "a"; result.conversation.unreadCount = 2;
  f.take("").resolve({ conversations: [result.conversation] }); f.take("/a").resolve(result);
  await f.flush();
  assert.equal(f.pending.some(item => item.url.endsWith("/read")), false);
  f.host.ownerDocument.visibilityState = "visible";
  f.query(".communication-messages").onscroll();
  const read = f.take("/a/read"); read.resolve({ conversation: { ...result.conversation, unreadCount: 0 } });
  await f.flush();
  assert.match(f.query(".communication-list").innerHTML, /message-2|还没有会话|A/);
  assert.doesNotMatch(f.query(".communication-list").innerHTML, /2 条未读/);
});

test("communication reader distinguishes pending, empty and failed reads without erasing independent errors", async (t) => {
  const f = communicationReaderFixture(t); f.mount();
  assert.match(f.query(".communication-list").innerHTML, /正在读取会话/);
  assert.match(f.query(".communication-messages").innerHTML, /正在读取聊天记录/);
  f.take("/a").reject(new Error("history unavailable")); f.take("").resolve({ conversations: [] }); await f.flush();
  assert.match(f.query(".communication-error").textContent, /history unavailable/);
  assert.match(f.query(".communication-messages").innerHTML, /读取失败/);
  assert.equal(f.query(".communication-heading").textContent, "会话读取失败");
  assert.match(f.query(".communication-list").innerHTML, /还没有会话/);
  f.tick(); f.take("").reject(new Error("list unavailable")); f.take("/a").resolve(f.result([])); await f.flush();
  assert.match(f.query(".communication-error").textContent, /list unavailable/);
  assert.match(f.query(".communication-messages").innerHTML, /从一句话/);
  assert.doesNotMatch(f.query(".communication-list").innerHTML, /还没有会话/);
  f.tick(); f.take("").resolve({ conversations: [] }); f.take("/a").resolve(f.result([])); await f.flush();
  assert.equal(f.query(".communication-error").textContent, "");
});

test("communication reader bounds polling and retains cache and draft across failure and remount", async (t) => {
  const f = communicationReaderFixture(t); f.mount(); f.mount(); f.tick(); f.tick();
  assert.equal(f.pending.length, 2); assert.equal(f.intervals.size, 1);
  f.take("").resolve({ conversations: [{ id: "a", name: "A", kind: "agent" }] }); f.take("/a").resolve(f.result(["10"], { before: "10", more: true })); await f.flush();
  f.query("textarea").value = "draft kept"; f.query("textarea").oninput();
  f.tick(); f.take("").reject(new Error("offline")); f.take("/a").reject(new Error("offline")); await f.flush();
  assert.match(f.query(".communication-list").innerHTML, />A</);
  assert.match(f.query(".communication-messages").innerHTML, /message-10/);
  assert.equal(f.query("textarea").value, "draft kept");
  f.ui.unmount(); assert.equal(f.intervals.size, 0); f.tick(); assert.equal(f.pending.length, 0);
  f.mount(); assert.match(f.query(".communication-main").innerHTML, /draft kept/);
  assert.equal(f.query(".communication-heading").textContent, "A");
  f.take("").resolve({ conversations: [] }); f.take("/a").reject(new Error("still offline")); await f.flush();
  assert.equal(f.query(".communication-heading").textContent, "A");
});

test("communication reader rejects old route success and errors including same-chat remount", async (t) => {
  const f = communicationReaderFixture(t); f.mount(); const oldList = f.take(""), oldA = f.take("/a");
  f.mount("b"); f.take("").resolve({ conversations: [] }); f.take("/b").resolve(f.result(["20"], { name: "B" })); await f.flush();
  oldList.reject(new Error("old list")); oldA.reject(new Error("old A")); await f.flush();
  assert.equal(f.query(".communication-heading").textContent, "B"); assert.equal(f.query(".communication-error").textContent, "");
  f.tick(); const oldB = f.take("/b"), oldBList = f.take(""); f.ui.unmount(); f.mount("b");
  f.take("/b").resolve(f.result(["30"], { name: "B new" })); f.take("").resolve({ conversations: [] }); await f.flush();
  oldB.resolve(f.result(["10"], { name: "B stale" })); oldBList.resolve({ conversations: [] }); await f.flush();
  assert.equal(f.query(".communication-heading").textContent, "B new"); assert.match(f.query(".communication-messages").innerHTML, /message-30/); assert.doesNotMatch(f.query(".communication-messages").innerHTML, /message-10/);
});

test("communication reader deduplicates older pages and invalidates them when latest reanchors", async (t) => {
  const f = communicationReaderFixture(t); f.mount(); f.take("").resolve({ conversations: [] }); f.take("/a").resolve(f.result(["20", "21"], { before: "20", more: true })); await f.flush();
  f.query(".communication-older").onclick(); f.query(".communication-older").onclick();
  assert.equal(f.pending.length, 1); assert.equal(f.query(".communication-older").disabled, true);
  const oldPage = f.take("/a?before=20"); f.tick(); f.tick();
  assert.equal(f.pending.length, 2);
  f.take("").resolve({ conversations: [] }); f.take("/a").resolve(f.result(["40", "41"], { before: "40", more: true })); await f.flush();
  assert.equal(f.query(".communication-older").disabled, false);
  f.query(".communication-older").onclick(); const freshPage = f.take("/a?before=40");
  oldPage.resolve(f.result(["10", "11"], { before: "10", more: true })); await f.flush();
  assert.equal(f.query(".communication-older").disabled, true);
  assert.match(f.query(".communication-messages").innerHTML, /message-41/); assert.doesNotMatch(f.query(".communication-messages").innerHTML, /message-11/);
  freshPage.resolve(f.result(["30", "31"], { before: "30", more: true })); await f.flush();
  assert.match(f.query(".communication-messages").innerHTML, /message-31/); assert.match(f.query(".communication-messages").innerHTML, /message-41/);
  f.query(".communication-older").onclick(); f.take("/a?before=30").reject(new Error("older unavailable")); await f.flush();
  assert.equal(f.query(".communication-older").disabled, false); assert.match(f.query(".communication-error").textContent, /older unavailable/);
  f.tick(); f.take("").resolve({ conversations: [] }); f.take("/a").resolve(f.result(["40", "41"], { before: "40", more: true })); await f.flush();
  assert.match(f.query(".communication-error").textContent, /older unavailable/);
  f.query(".communication-older").onclick(); f.take("/a?before=30").resolve(f.result(["29"], { before: "29", more: true })); await f.flush();
  assert.equal(f.query(".communication-error").textContent, "");
});

test("communication latest polling preserves loaded older cursor, unique messages and reading anchor", async (t) => {
  const f = communicationReaderFixture(t); f.mount(); f.take("").resolve({ conversations: [] }); f.take("/a").resolve(f.result(["20", "21"], { before: "20", more: true })); await f.flush();
  f.query(".communication-messages").scrollTop = 15;
  f.query(".communication-older").onclick(); f.take("/a?before=20").resolve(f.result(["18", "19"], { before: "18", more: true })); await f.flush();
  assert.equal(f.query(".communication-messages").scrollTop, 215);
  f.tick(); f.tick(); f.tick(); assert.equal(f.pending.length, 2);
  f.take("").resolve({ conversations: [] }); f.take("/a").resolve(f.result(["21", "22"], { before: "21", more: true })); await f.flush();
  assert.equal((f.query(".communication-messages").innerHTML.match(/message-21/g) || []).length, 1);
  assert.match(f.query(".communication-messages").innerHTML, /message-18/);
  f.query(".communication-older").onclick(); f.take("/a?before=18").resolve(f.result(["17"])); await f.flush();
  assert.equal(f.query(".communication-older").hidden, true);
});

test("communication reanchor retains a persisted send acknowledged after the history request began", async (t) => {
  const f = communicationReaderFixture(t); f.mount(); f.take("").resolve({ conversations: [] }); f.take("/a").resolve(f.result(["10"])); await f.flush();
  f.tick(); const history = f.take("/a"); f.take("").resolve({ conversations: [] });
  f.query("textarea").value = "new persisted message"; f.query("textarea").oninput();
  const send = f.query("form").onsubmit({ preventDefault() {} });
  f.take("/a/messages").resolve({ message: { ...f.result(["30"]).messages[0], content: "new persisted message" } }); await send;
  history.resolve(f.result(["20"], { before: "20", more: true })); await f.flush();
  assert.match(f.query(".communication-messages").innerHTML, /message-20/);
  assert.match(f.query(".communication-messages").innerHTML, /new persisted message/);
  assert.doesNotMatch(f.query(".communication-messages").innerHTML, /message-10/);
});

test("communication POST acknowledgement cannot bridge unread history or hide its older cursor", async (t) => {
  const f = communicationReaderFixture(t); f.mount(); f.take("").resolve({ conversations: [] }); f.take("/a").resolve(f.result(["10"])); await f.flush();
  f.tick(); const history = f.take("/a"); f.take("").resolve({ conversations: [] });
  f.query("textarea").value = "new message"; f.query("textarea").oninput();
  const send = f.query("form").onsubmit({ preventDefault() {} }); f.take("/a/messages").resolve({ message: f.result(["30"]).messages[0] }); await send;
  history.resolve(f.result(["10"])); await f.flush();
  f.tick(); f.take("").resolve({ conversations: [] }); f.take("/a").resolve(f.result(["30", "31"], { before: "30", more: true })); await f.flush();
  assert.doesNotMatch(f.query(".communication-messages").innerHTML, /message-10/);
  assert.equal(f.query(".communication-older").hidden, false);
  f.query(".communication-older").onclick(); f.take("/a?before=30").resolve(f.result(["20", "21"], { before: "20", more: true })); await f.flush();
  assert.match(f.query(".communication-messages").innerHTML, /message-20/);
});

test("communication older response cannot roll back metadata refreshed by latest history", async (t) => {
  const f = communicationReaderFixture(t); f.mount(); f.take("").resolve({ conversations: [] }); f.take("/a").resolve(f.result(["20"], { name: "old", before: "20", more: true })); await f.flush();
  f.query(".communication-older").onclick(); const older = f.take("/a?before=20");
  f.tick(); f.take("").resolve({ conversations: [] }); f.take("/a").resolve(f.result(["20", "21"], { name: "new", before: "20", more: true })); await f.flush();
  older.resolve(f.result(["10"], { name: "old", before: "10", more: true })); await f.flush();
  assert.equal(f.query(".communication-heading").textContent, "new");
  assert.match(f.query(".communication-messages").innerHTML, /message-10/);
});

test("communication Markdown is sanitized and unavailable renderers preserve escaped text", () => {
  const content = "**审校**\n<script>alert(1)</script>";
  let policy;
  assert.equal(formatCommunicationContent(content, {
    parse: () => "<p><strong>审校</strong></p>",
    sanitize: (html, options) => { policy = options; return html; }
  }), "<p><strong>审校</strong></p>");
  assert.deepEqual(policy.USE_PROFILES, { html: true });
  assert.ok(policy.FORBID_TAGS.includes("img"));
  assert.ok(policy.FORBID_TAGS.includes("iframe"));
  const fallback = '<span class="communication-plain">**审校**\n&lt;script&gt;alert(1)&lt;/script&gt;</span>';
  assert.equal(formatCommunicationContent(content), fallback);
  assert.equal(formatCommunicationContent(content, { parse: () => { throw Error("unavailable"); }, sanitize: (value) => value }), fallback);
  assert.equal(formatCommunicationContent(content, { parse: async () => "unexpected async result", sanitize: (value) => value }), fallback);
});

test("mention selection ends query until a new @, including names with spaces", () => {
  const selected = [{ name: "Nexora · 需求分析师" }];
  const query = (value) => activeMention(value, value.length, selected);
  assert.equal(query("@Nexora · 需求分析师 请分析需求"), null);
  assert.equal(query("@Nexora · 需求分析师 "), null);
  assert.equal(query("@Nexora · 需求分析师 好的 @系统")[1], "系统");
  assert.equal(query("@")[1], "");
  assert.equal(query("普通消息"), null);
  assert.equal(activeMention("@Nexora · 需求分析师 你好", 4, selected)[1], "Nex");
});

const send = (store, key, content, mentionAgentIds = [], clientRequestId = randomUUID()) => store.sendCommunication(key, { content, mentionAgentIds, clientRequestId });

test('employee persona and MCP edits preserve native memory; real Runtime connection changes reset it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-chat-edits-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(), market = createMarketplace(join(root, 'extensions'));
  const chat = store.openCommunication({ kind: 'agent', targetId: 'agent_analyst' });
  const next = () => { send(store, chat.id, 'current message'); const item = store.claimCommunication(chat.id); return { item, session: store.prepareCommunicationSession(chat.id, item.id, root) }; };
  const first = next(); store.confirmCommunicationSession(chat.id, first.item.id, first.session.sessionId); store.completeCommunication(chat.id, first.item.id, 'remembered');
  store.updateAgent('agent_analyst', { name: '新的名称', description: '新的简介', systemPrompt: '新的职责', capabilities: ['Node.js'] });
  const second = next(); assert.equal(second.session.sessionId, first.session.sessionId); assert.equal(second.session.resume, true); store.completeCommunication(chat.id, second.item.id, 'updated persona');
  const entry = await market.add({ kind: 'mcp', name: 'Selected', description: '', content: JSON.stringify({ mcpServers: { proof: { command: 'node', args: ['proof.mjs'] } } }) });
  const selected = await market.resolve({ pluginIds: [], mcpIds: [entry.id] }, 'claude-code');
  store.updateAgent('agent_analyst', { runtime: { ...store.listAgents().find(item => item.id === 'agent_analyst').runtime, ...selected } });
  const third = next(); assert.equal(third.session.sessionId, first.session.sessionId); assert.equal(third.session.resume, true); assert.equal(third.item.agentSnapshot.runtime.extensionManifest[0].id, entry.id); store.completeCommunication(chat.id, third.item.id, 'updated extensions');
  store.updateAgent('agent_analyst', { runtime: { provider: 'claude-code', model: 'different-model' } });
  const changed = next(); assert.notEqual(changed.session.sessionId, first.session.sessionId); assert.equal(changed.session.resume, false);
  const resets = store.getCommunicationEvents(chat.id, changed.item.id).items.filter(item => item.type === 'session_reset'); assert.equal(resets.length, 1); assert.match(resets[0].content, /Runtime 连接变化/);
  assert.equal(store.getCommunication(chat.id).messages.length, 7, 'all chat messages remain stored'); store.close();
});

test("real CLI adapter permits distinct member keys and rejects duplicates before spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-cli-lock-"));
  try {
    const executable = join(root, "fixture.mjs");
    await writeFile(executable, '#!/usr/bin/env node\nimport {appendFileSync} from "node:fs";appendFileSync("spawned",process.pid+"\\n");console.log(JSON.stringify({type:"system",subtype:"init"}));setTimeout(()=>console.log(JSON.stringify({type:"result",structured_output:{reply:"ok"}})),150);');
    await chmod(executable, 0o755);
    const base = {runtime:{executable},workspacePath:root,traceDirectory:root,outputSchema:{},prompt:"test",runId:"same-group",onEvent:async()=>{}};
    const unregister = registerExecution("blocked-member", {terminate(){}});
    try { await assert.rejects(runClaudeCodeCli({...base,executionKey:"blocked-member"}), /已有/); }
    finally { unregister(); }
    await assert.rejects(readFile(join(root,"spawned")), /ENOENT/);
    const replies = await Promise.all([runClaudeCodeCli({...base,executionKey:"member-a"}),runClaudeCodeCli({...base,executionKey:"member-b"})]);
    assert.equal(replies.length,2);
    assert.equal((await readFile(join(root,"spawned"),"utf8")).trim().split("\n").length,2);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("CLI resumes the exact unconfirmed session when a previous process created it", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-existing-session-"));
  try {
    const executable = join(root,"fixture.mjs"), sessionId = randomUUID(), events=[];
    await writeFile(executable,'#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a.includes("--session-id")){console.error("Error: Session ID "+a[a.indexOf("--session-id")+1]+" is already in use.");process.exit(1);}console.log(JSON.stringify({type:"system",subtype:"init",session_id:a[a.indexOf("--resume")+1]}));console.log(JSON.stringify({type:"result",structured_output:{reply:"resumed"}}));');
    await chmod(executable,0o755);
    const result=await runClaudeCodeCli({runtime:{executable},workspacePath:root,traceDirectory:root,outputSchema:{},prompt:"test",runId:"existing-session",session:{sessionId,resume:false},onEvent:async e=>events.push(e)});
    assert.equal(JSON.parse(result.finalText).reply,"resumed");
    assert.ok(events.some(e=>e.providerEventType==="session_recovery" && e.data.sessionId===sessionId));
  } finally {await rm(root,{recursive:true,force:true});}
});

test("group members execute in parallel but a member keeps FIFO", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-parallel-chat-"));
  const store = createStore(), group = store.openCommunication({ kind: "team", targetId: "team_product_delivery" });
  const started = [], releases = [];
  const service = createCommunicationService(store, { root, invoke: async (input) => {
    started.push(input.workspacePath);
    await new Promise((resolve) => releases.push(resolve));
    return { finalText: JSON.stringify({ reply: "done" }) };
  } });
  try {
    send(store, group.id, "first", ["agent_analyst", "agent_designer"]);
    send(store, group.id, "second", ["agent_analyst"]);
    const running = service.kick(group.id), duplicate = service.kick(group.id);
    for (let i = 0; i < 100 && started.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(started.length, 2); assert.notEqual(started[0], started[1]);
    assert.equal(store.getCommunication(group.id).deliveries.filter((item) => item.status === "running").length, 2);
    releases.splice(0).forEach((resolve) => resolve());
    for (let i = 0; i < 100 && started.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(started.length, 3);
    releases.splice(0).forEach((resolve) => resolve()); await Promise.all([running, duplicate]);
    assert.equal(store.getCommunication(group.id).deliveries.filter((item) => item.status === "done").length, 3);
  } finally { releases.splice(0).forEach((resolve) => resolve()); await rm(root, { recursive: true, force: true }); }
});

test("broadcast freezes active digital recipients and replies never recursively fan out", () => {
  const store = createStore();
  store.updateAgent("agent_designer", { status: "inactive" });
  const group = store.openCommunication({ kind: "team", targetId: "team_product_delivery" });
  const message = send(store, group.id, "everyone");
  const deliveries = store.getCommunication(group.id).deliveries;
  assert.ok(deliveries.length > 1);
  assert.ok(deliveries.some((item) => item.agentId === "system_project_manager"));
  assert.ok(deliveries.every((item) => item.agentId !== "agent_designer" && item.agentSnapshot === undefined));
  assert.throws(() => send(store, group.id, "inactive", ["agent_designer"]), /停用/);
  store.updateAgent("agent_designer", { status: "active" });
  send(store, group.id, message.content, [], message.clientRequestId);
  assert.equal(store.getCommunication(group.id).deliveries.length, deliveries.length);
  const item = store.claimCommunication(group.id);
  store.completeCommunication(group.id, item.id, "reply");
  assert.equal(store.getCommunication(group.id).deliveries.length, deliveries.length);
});

test("explicit group handoff persists one child, survives restart and cannot relay again", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-chat-handoff-"));
  try {
    const databasePath = join(root, "state.sqlite"), store = createStore({ databasePath });
    const group = store.openCommunication({ kind: "team", targetId: "team_product_delivery" });
    const human = send(store, group.id, "让设计师审校规则", ["agent_analyst"]);
    const parent = store.claimCommunication(group.id);
    store.completeCommunication(group.id, parent.id, "请设计师核对149不通过", "agent_designer");
    store.completeCommunication(group.id, parent.id, "重复结果不能再发", "agent_engineer");
    const first = store.getCommunication(group.id), child = first.deliveries.find((row) => row.parentDeliveryId === parent.id);
    assert.equal(first.messages.length, 2);
    assert.equal(first.deliveries.length, 2);
    assert.equal(first.conversation.pending, 1);
    assert.equal(first.messages[1].handoffTo.id, "agent_designer");
    assert.equal(child.rootMessageId, human.id);
    assert.equal(child.messageId, first.messages[1].id);
    assert.equal(child.agentSnapshot, undefined);
    assert.equal(store.getCommunicationEvents(group.id, parent.id).items.filter((row) => row.type === "handoff_queued").length, 1);
    assert.equal(store.claimCommunication(group.id).id, child.id);
    const reopened = createStore({ databasePath });
    reopened.recoverCommunications();
    const claimed = reopened.claimCommunication(group.id);
    assert.equal(claimed.id, child.id);
    assert.equal(claimed.attempts, 2);
    const context = reopened.communicationContext(group.id, child.id);
    assert.deepEqual(context.handoffCandidates, []);
    assert.ok(context.messages.some((message) => message.id === human.id));
    assert.throws(() => reopened.completeCommunication(group.id, child.id, "再问别人", "agent_engineer"), /不能再次转交/);
    reopened.completeCommunication(group.id, child.id, "149不通过，建议查看资格");
    const final = reopened.getCommunication(group.id);
    assert.equal(final.messages[2].replyToMessageId, first.messages[1].id);
    assert.equal(final.conversation.pending, 0);
    assert.equal(final.deliveries.length, 2);
    assert.equal(reopened.snapshot().runs.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("handoff rejects private, self, foreign, inactive, departed and newly joined recipients without partial facts", () => {
  const store = createStore();
  const group = store.openCommunication({ kind: "team", targetId: "team_product_delivery" });
  const privateChat = store.openCommunication({ kind: "agent", targetId: "agent_analyst" });
  send(store, privateChat.id, "私聊不能转交");
  const direct = store.claimCommunication(privateChat.id);
  assert.throws(() => store.completeCommunication(privateChat.id, direct.id, "转交", "agent_designer"), /转交目标无效/);
  send(store, group.id, "审校", ["agent_analyst"]);
  const parent = store.claimCommunication(group.id);
  for (const target of ["agent_analyst", "foreign", "", {}, false]) {
    assert.throws(() => store.completeCommunication(group.id, parent.id, "转交", target), /转交目标无效/);
  }
  store.updateAgent("agent_designer", { status: "inactive" });
  assert.throws(() => store.completeCommunication(group.id, parent.id, "转交", "agent_designer"), /转交目标无效/);
  store.updateAgent("agent_designer", { status: "active" });
  store.updateTeam(group.targetId, { memberAgentIds: ["agent_analyst", "agent_engineer"] });
  assert.throws(() => store.completeCommunication(group.id, parent.id, "转交", "agent_designer"), /转交目标无效/);
  const newcomer = store.createAgent({ name: "新人", role: "审校", description: "新入组" });
  store.updateTeam(group.targetId, { memberAgentIds: ["agent_analyst", "agent_designer", newcomer.id] });
  assert.ok(!store.communicationContext(group.id, parent.id).handoffCandidates.some((row) => row.id === newcomer.id));
  assert.throws(() => store.completeCommunication(group.id, parent.id, "转交旧事实", newcomer.id), /转交目标无效/);
  store.updateAgent("agent_analyst", { status: "inactive" });
  assert.throws(() => store.completeCommunication(group.id, parent.id, "转交", "agent_designer"), /转交目标无效/);
  store.updateAgent("agent_analyst", { status: "active" });
  store.updateTeam(group.targetId, { memberAgentIds: ["agent_designer", newcomer.id] });
  assert.throws(() => store.completeCommunication(group.id, parent.id, "离组后转交", "agent_designer"), /转交目标无效/);
  assert.equal(store.getCommunication(group.id).messages.length, 1);
  assert.equal(store.getCommunication(group.id).deliveries.length, 1);
  store.updateTeam(group.targetId, { memberAgentIds: ["agent_analyst", "agent_designer", newcomer.id] });
  store.completeCommunication(group.id, parent.id, "合法转交", "agent_designer");
  const child = store.claimCommunication(group.id);
  store.completeCommunication(group.id, child.id, "审校答复");
  assert.ok(store.getCommunication(group.id).messages.every((message) => !message.visibleToAgentIds.includes(newcomer.id)));
});

test("handoff commit failure rolls back reply, queue and audit together", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-chat-atomic-"));
  let database;
  try {
    const databasePath = join(root, "state.sqlite"), store = createStore({ databasePath });
    const group = store.openCommunication({ kind: "team", targetId: "team_product_delivery" });
    send(store, group.id, "审校", ["agent_analyst"]);
    const parent = store.claimCommunication(group.id), before = store.snapshot();
    database = new DatabaseSync(databasePath);
    database.exec("CREATE TRIGGER fail_handoff BEFORE UPDATE ON workspace_snapshots BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END");
    assert.throws(() => store.completeCommunication(group.id, parent.id, "转交", "agent_designer"), /injected persistence failure/);
    assert.deepEqual(store.snapshot(), before);
    database.exec("DROP TRIGGER fail_handoff");
    const reopened = createStore({ databasePath });
    assert.deepEqual(reopened.snapshot().communicationDeliveries, before.communicationDeliveries);
    assert.deepEqual(reopened.snapshot().communicationEvents, before.communicationEvents);
    reopened.completeCommunication(group.id, parent.id, "转交", "agent_designer");
    assert.equal(reopened.getCommunication(group.id).deliveries.length, 2);
  } finally { database?.close(); await rm(root, { recursive: true, force: true }); }
});

test("communication schema requires only reply; omitted/null handoff saves private and group replies", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-chat-optional-handoff-"));
  const store = createStore();
  try {
    for (const target of [{kind:"agent",targetId:"agent_analyst"},{kind:"team",targetId:"team_product_delivery"}]) {
      const chat = store.openCommunication(target);
      for (const result of [{reply:"只有正文"},{reply:"显式不转交",handoffToAgentId:null}]) {
        send(store, chat.id, "普通回复", target.kind === "team" ? ["agent_analyst"] : []);
        const service = createCommunicationService(store, {root, invoke:async input => {
          assert.deepEqual(input.outputSchema.required,["reply"]);
          assert.equal(input.outputSchema.additionalProperties,false);
          assert.deepEqual(JSON.parse(await readFile(input.schemaPath,"utf8")),input.outputSchema);
          assert.deepEqual(input.outputSchema.properties.handoffToAgentId.type,["string","null"]);
          return {finalText:JSON.stringify(result)};
        }});
        await service.kick(chat.id);
        const saved = store.getCommunication(chat.id);
        assert.equal(saved.deliveries.at(-1).status,"done");
        assert.equal(saved.messages.at(-1).content,result.reply);
        assert.equal(saved.conversation.pending,0);
        assert.ok(saved.deliveries.every(item=>!item.parentDeliveryId));
      }
    }
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});

test("service drains a handoff with isolated sessions, retries only the failed recipient and rejects malformed output", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-chat-relay-runtime-"));
  try {
    const store = createStore(), group = store.openCommunication({ kind: "team", targetId: "team_product_delivery" }), calls = [];
    let failRecipient = true;
    const service = createCommunicationService(store, { root, invoke: async (input) => {
      calls.push(input);
      if (input.workspacePath.endsWith("agent_analyst")) return { finalText: JSON.stringify({ reply: "请审校149", handoffToAgentId: "agent_designer" }) };
      assert.ok(input.prompt.includes("请审校149"));
      assert.ok(input.systemPrompt.includes("本轮可转交成员：[]"));
      if (failRecipient) throw new Error("temporary reviewer failure");
      return { finalText: JSON.stringify({ reply: "149不通过", handoffToAgentId: null }) };
    } });
    send(store, group.id, "请转交", ["agent_analyst"]);
    await service.kick(group.id);
    const failed = store.getCommunication(group.id).deliveries.find((row) => row.status === "failed");
    assert.equal(failed.agentId, "agent_designer");
    assert.notEqual(calls[0].session.sessionId, calls[1].session.sessionId);
    assert.notEqual(calls[0].executionKey, calls[1].executionKey);
    failRecipient = false; store.retryCommunication(group.id, failed.id);
    await service.kick(group.id);
    assert.equal(calls.filter((input) => input.workspacePath.endsWith("agent_analyst")).length, 1);
    assert.equal(store.getCommunication(group.id).messages.length, 3);
    assert.equal(store.getCommunication(group.id).conversation.pending, 0);
    const privateChat = store.openCommunication({ kind: "agent", targetId: "agent_analyst" });
    for (const output of [{}, {reply:""}, {reply:42}, { reply: "bad", handoffToAgentId: [] }, { reply: "bad", handoffToAgentId: "" }, { reply: "bad", recipient: "agent_designer" }, { reply: "bad", handoffToAgentId: "agent_designer" }]) {
      send(store, privateChat.id, "reject malformed or unauthorized");
      const invalid = createCommunicationService(store, { root, invoke: async () => ({ finalText: JSON.stringify(output) }) });
      await invalid.kick(privateChat.id);
      const item = store.getCommunication(privateChat.id).deliveries.at(-1);
      assert.equal(item.status, "failed");
      store.cancelCommunication(privateChat.id, item.id);
    }
    assert.ok(store.getCommunication(privateChat.id).messages.every((message) => message.sender.type === "human"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("communication UI uses searchable dialog and hides runtime chrome and private quotes", async () => {
  const ui = await readFile(new URL("../web/communication.js", import.meta.url), "utf8");
  assert.ok(ui.includes('dialog.showModal()'));
  assert.ok(ui.includes('input.oninput = () => { pickerPage = 1; render(); }'));
  assert.ok(ui.includes('state.conversation?.kind === "team" && state.messages.get'));
  assert.ok(!ui.includes('data-chat-events'));
  assert.ok(!ui.includes('communication-delivery'));
  assert.ok(!ui.includes('已回复'));
  assert.ok(!ui.includes('<select'));
  assert.ok(ui.includes('state.messages.set(message.id, message)'));
  assert.ok(ui.includes('转交给 ${escapeHtml(message.handoffTo.name)}'));
  assert.ok(!ui.includes('await loadMessages(); const list'));
  assert.ok(!ui.includes('renderList(); await loadMessages()'));
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(app, /team-card-header.*directory-card-actions.*data-chat-team=.*data-edit-team=/);
  assert.match(app, /agent-card-top[\s\S]*?directory-card-actions.*data-chat-agent=.*data-edit-agent=[\s\S]*?<p>/);
});

test("communication private/group uniqueness, explicit mentions and restart retention are independent of tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-chat-store-"));
  try {
    const databasePath = join(root, "state.sqlite"), store = createStore({ databasePath });
    const privateChat = store.openCommunication({ kind: "agent", targetId: "agent_analyst" });
    assert.equal(store.openCommunication({ kind: "agent", targetId: "agent_analyst" }).id, privateChat.id);
    const group = store.openCommunication({ kind: "team", targetId: "team_product_delivery" });
    assert.equal(store.openCommunication({ kind: "team", targetId: "team_product_delivery" }).id, group.id);
    const clientRequestId = randomUUID();
    const first = send(store, privateChat.id, "保留完整原文\n第二行", [], clientRequestId);
    assert.equal(send(store, privateChat.id, first.content, [], clientRequestId).id, first.id);
    assert.throws(() => send(store, privateChat.id, "不同内容", [], clientRequestId), /另一条/);
    const broadcast = send(store, group.id, "没有 @ 全员回复");
    const expectedMembers = group.members.filter((member) => member.status === "active").map((member) => member.id);
    assert.deepEqual(store.getCommunication(group.id).deliveries.map((item) => item.agentId), expectedMembers);
    assert.equal(send(store, group.id, broadcast.content, [], broadcast.clientRequestId).id, broadcast.id);
    assert.equal(store.getCommunication(group.id).deliveries.length, expectedMembers.length);
    assert.throws(() => send(store, group.id, "bad", ["foreign"]), /成员/);
    assert.throws(() => store.sendCommunication(group.id, { content: "bad", clientRequestId, mentionAgentIds: null }), /列表/);
    send(store, group.id, "两人", ["agent_analyst", "agent_engineer"]);
    const targeted = store.getCommunication(group.id).deliveries.filter((item) => item.messageId !== broadcast.id);
    assert.equal(targeted.length, 2);
    assert.equal(targeted.some((item) => item.agentId === "system_project_manager"), false);
    assert.equal(store.getCommunication(group.id).deliveries.some((item) => "agentSnapshot" in item), false);
    const item = store.claimCommunication(privateChat.id);
    const session = store.prepareCommunicationSession(privateChat.id, item.id, root);
    store.confirmCommunicationSession(privateChat.id, item.id, session.sessionId);
    const disposableTask = store.createTask({ title: "Delete only this fixture", objective: "Communication survives Task deletion", workspacePath: root, teamId: store.listTeams()[0].id, workflowTemplateId: store.listWorkflowTemplates()[0].id });
    store.deleteTask(disposableTask.id);
    const reopened = createStore({ databasePath });
    reopened.recoverCommunications();
    assert.equal(reopened.getCommunication(privateChat.id).messages[0].content, first.content);
    assert.equal(reopened.getCommunication(group.id).messages.length, 2);
    const next = reopened.claimCommunication(privateChat.id);
    assert.equal(reopened.prepareCommunicationSession(privateChat.id, next.id, root).resume, true);
    assert.equal(reopened.snapshot().runs.length, 0);
    for (let i = 0; i < 110; i++) send(reopened, group.id, String(i));
    const page = reopened.getCommunication(group.id, { limit: 100 });
    assert.equal(page.messages.length, 100); assert.equal(page.hasMore, true);
    const older = reopened.getCommunication(group.id, { before: page.nextBefore, limit: 100 });
    assert.equal(older.messages.length, 12);
    assert.throws(() => reopened.getCommunication(privateChat.id, { before: page.nextBefore }), /游标/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("communication execution queues replies, resumes exact sessions, separates group/private and retries missing sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-chat-runtime-"));
  try {
    const store = createStore(), calls = [];
    const chat = store.openCommunication({ kind: "agent", targetId: "agent_analyst" });
    const invoke = async (input) => {
      calls.push(input);
      await input.onEvent({ providerEventType: "system", message: "init", data: { sessionId: input.session.sessionId } });
      await input.onEvent({ providerEventType: "assistant", message: "已收到", data: {} });
      return { finalText: JSON.stringify({ reply: "真实协议测试回复" }) };
    };
    const service = createCommunicationService(store, { root, invoke });
    send(store, chat.id, "first"); send(store, chat.id, "second");
    await Promise.all([service.kick(chat.id), service.kick(chat.id)]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].session.resume, false); assert.equal(calls[1].session.resume, true);
    assert.equal(calls[0].session.sessionId, calls[1].session.sessionId);
    assert.ok(!calls[1].prompt.includes("真实协议测试回复"), "native assistant replies are not replayed");
    assert.ok(!calls[1].prompt.includes('"content":"first"'), "previous user messages are not replayed");
    assert.ok(calls[1].prompt.includes('"content":"second"'));
    assert.match(calls[1].systemPrompt, /人类沟通中回答/);
    const group = store.openCommunication({ kind: "team", targetId: "team_product_delivery" });
    send(store, group.id, "hello", ["agent_analyst"]);
    await service.kick(group.id);
    assert.notEqual(calls[2].session.sessionId, calls[0].session.sessionId);
    assert.notEqual(calls[2].workspacePath, calls[0].workspacePath);
    assert.equal(store.getCommunication(chat.id).messages.length, 4);
    const delivery = store.getCommunication(chat.id).deliveries[0];
    const operationEvents = store.getCommunicationEvents(chat.id, delivery.id).items;
    assert.ok(operationEvents.length >= 3);
    assert.doesNotMatch(JSON.stringify(operationEvents), /sessionId|"session_id"/);
    send(store, chat.id, "missing");
    const failing = createCommunicationService(store, { root, invoke: async () => { throw new RuntimeSessionMissingError("missing"); } });
    await failing.kick(chat.id);
    const failed = store.getCommunication(chat.id).deliveries.find((item) => item.status === "failed");
    assert.ok(failed.nextAttemptAt);
    store.retryCommunication(chat.id, failed.id);
    await service.kick(chat.id);
    assert.equal(calls.at(-1).session.resume, false);
    assert.equal(store.getCommunication(chat.id).messages.length, 6);
    assert.equal(store.snapshot().runs.length, 0);
    send(store, chat.id, "invalid reply");
    const invalid = createCommunicationService(store, { root, invoke: async () => ({ finalText: "invalid" }) });
    await invalid.kick(chat.id);
    assert.equal(store.getCommunication(chat.id).messages.length, 7);
    assert.equal(store.getCommunication(chat.id).deliveries.at(-1).status, "failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("conversation summary keeps automatic retry deliveries visibly pending", () => {
  const store = createStore(), chat = store.openCommunication({ kind: "agent", targetId: "agent_analyst" });
  send(store, chat.id, "retry later");
  const delivery = store.claimCommunication(chat.id);
  store.failCommunication(chat.id, delivery.id, "temporary provider failure");
  assert.equal(store.listCommunications().find((item) => item.id === chat.id).pending, 1);
  assert.equal(store.getCommunication(chat.id).conversation.pending, 1);
  store.cancelCommunication(chat.id, delivery.id);
  assert.equal(store.listCommunications().find((item) => item.id === chat.id).pending, 0);
});

test("failed group member does not block peers; cancellation retains history and retry refreshes runtime", () => {
  const store = createStore(), group = store.openCommunication({ kind: "team", targetId: "team_product_delivery" });
  send(store, group.id, "two members", ["agent_analyst", "agent_designer"]);
  const first = store.claimCommunication(group.id);
  store.failCommunication(group.id, first.id, "unavailable");
  const next = store.claimCommunication(group.id);
  assert.equal(next.agentId, "agent_designer");
  store.completeCommunication(group.id, next.id, "peer reply");
  assert.equal(store.claimCommunication(group.id), null);
  store.updateAgent("agent_analyst", { runtime: { provider: "claude-code", model: "reconfigured" } });
  store.retryCommunication(group.id, first.id);
  const retried = store.claimCommunication(group.id);
  assert.equal(retried.agentSnapshot.runtime.model, "reconfigured");
  store.failCommunication(group.id, first.id, "still unavailable");
  store.cancelCommunication(group.id, first.id);
  assert.equal(store.getCommunication(group.id).messages.length, 2);
  assert.equal(store.getCommunication(group.id).deliveries[0].status, "cancelled");
  assert.deepEqual(store.pendingCommunications(), []);
  assert.ok(store.getCommunicationEvents(group.id, first.id).items.some((event) => event.type === "cancelled"));
});
