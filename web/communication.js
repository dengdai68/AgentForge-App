import { paginate, paginationMarkup } from "./pagination.mjs";
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const date = (value) => new Date(value).toLocaleString("zh-CN", { hour12: false });

export function latestConversationId(conversations = []) {
  return conversations.reduce((latest,item)=>!latest || (Date.parse(item.updatedAt)||0)>(Date.parse(latest.updatedAt)||0)?item:latest,null)?.id || null;
}

export function memberMentionMarkup(html, names = [], document = globalThis.document) {
  const members = [...new Set(names.filter(name => typeof name === 'string' && name))].sort((a, b) => b.length - a.length);
  if (!members.length || !document?.createTreeWalker) return html;
  const container = document.createElement('div'); container.innerHTML = html;
  const pattern = new RegExp('@(?:' + members.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g');
  const walker = document.createTreeWalker(container, 4), nodes = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('code,pre,a,.member-mention')) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue, matches = [...text.matchAll(pattern)];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment(); let offset = 0;
    for (const match of matches) {
      fragment.append(document.createTextNode(text.slice(offset, match.index)));
      const mention = document.createElement('strong'); mention.className = 'member-mention'; mention.textContent = match[0]; fragment.append(mention);
      offset = match.index + match[0].length;
    }
    fragment.append(document.createTextNode(text.slice(offset))); node.replaceWith(fragment);
  }
  return container.innerHTML;
}

export function formatCommunicationContent(content, { parse, sanitize, mentions = [] } = {}) {
  const fallback = `<span class="communication-plain">${escapeHtml(content)}</span>`;
  if (typeof parse !== "function" || typeof sanitize !== "function") return memberMentionMarkup(fallback, mentions);
  try {
    const html = parse(String(content));
    if (typeof html !== "string") return memberMentionMarkup(fallback, mentions);
    return memberMentionMarkup(sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "video", "audio", "picture", "source", "iframe", "style", "form", "input", "button"], FORBID_ATTR: ["style"], ALLOW_DATA_ATTR: false }), mentions);
  } catch { return memberMentionMarkup(fallback, mentions); }
}

export function activeMention(value, caret, selected = []) {
  const match = value.slice(0, caret).match(/@([^@\n]{0,60})$/);
  if (!match || selected.some((member) => match[1].startsWith(member.name + " "))) return null;
  return match;
}

// Stable per-sender accents, never an inferred execution or business status.
export function communicationSenderTone(sender = {}) {
  if (sender.type === "human") return "info";
  const key = String(sender.id || sender.name || "agent");
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return hash % 2 ? "violet" : "teal";
}

export function createCommunicationUI({ api, navigate, notify, prepareContent = async () => {}, renderContent = escapeHtml, renderConsole = () => {}, onRead = () => {} }) {
  let host, currentId = null, generation = 0, timer, contacts = [], conversations = [];
  let listLoaded = false, listError = "", listRequest = null, listPage = 1;
  const views = new Map();
  const view = (key) => {
    if (!views.has(key)) views.set(key, { messages: new Map(), readMessageIds: new Set(), deliveries: new Map(), draft: "", mentions: [], attachments: [], consoleOpen: false, consoleAgentId: null, consoleMembers: [], consolePages: new Map(), consoleRequest: null, consoleError: '', requestId: null, hasMore: false, before: null, loaded: false, sending: false, latestError: "", olderError: "", historyEpoch: 0, latestRequest: null, olderRequest: null });
    return views.get(key);
  };
  const query = (selector) => host?.querySelector(selector);
  const isCurrent = (key, token) => host?.isConnected && key === currentId && token === generation;
  function renderReadErrors() {
    const state = currentId && view(currentId);
    query(".communication-error").textContent = [listError, state?.latestError, state?.olderError].filter(Boolean).join(" · ");
  }
  function renderList() {
    const page = paginate(conversations, listPage); listPage = page.page;
    query(".communication-list").innerHTML = page.items.map((item) => `<button class="communication-contact ${item.id === currentId ? "selected" : ""}" data-chat-id="${escapeHtml(item.id)}"><span class="communication-avatar">${item.kind === "team" ? "群" : escapeHtml(item.name.slice(0, 1))}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.preview || (item.kind === "team" ? "团队群聊" : "数字员工私聊"))}</small></span>${item.unreadCount ? `<span class="communication-unread" aria-label="${item.unreadCount} 条未读">${item.unreadCount}</span>` : ""}</button>`).join("") || `<p class="field-hint">${listError ? "会话列表读取失败，正在重连。" : listLoaded ? "还没有会话，点击 ＋ 选择员工或团队开始。" : "正在读取会话…"}</p>`;
    query(".communication-pager").innerHTML = paginationMarkup(page, "communications");
    queryAll("[data-chat-id]").forEach((button) => button.onclick = () => navigate(button.dataset.chatId));
  }
  function queryAll(selector) { return [...(host?.querySelectorAll(selector) || [])]; }
  async function markVisibleRead() {
    const key = currentId, token = generation;
    if (!key || host?.ownerDocument?.visibilityState === "hidden") return;
    const state = view(key), list = query(".communication-messages");
    if (!list || !state.conversation?.unreadCount || !state.latestVisibleMessageId || state.reading || list.scrollHeight - list.scrollTop - list.clientHeight > 80) return;
    state.reading = true;
    try {
      const result = await api(`/api/communications/${key}/read`, { method: "POST", body: JSON.stringify({ messageId: state.latestVisibleMessageId }) });
      if (!isCurrent(key, token)) return;
      state.conversation = result.conversation;
      conversations = conversations.map(item => item.id === key ? result.conversation : item);
      renderList(); onRead();
    } catch { /* A failed acknowledgement keeps the messages unread; retry on the next poll. */ }
    finally { state.reading = false; }
  }
  function renderMessages() {
    if (!currentId) return;
    const state = view(currentId), list = query(".communication-messages");
    const bottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const top = list.scrollTop, height = list.scrollHeight;
    const messages = [...state.messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const html = messages.map((message) => {
      const original = state.conversation?.kind === "team" && state.messages.get(message.replyToMessageId);
      const attachments = (message.attachments || []).map(file => `<a class="communication-attachment" href="/api/communications/${encodeURIComponent(currentId)}/attachments/${encodeURIComponent(file.id)}" download="${escapeHtml(file.name)}" data-attachment-download><span aria-hidden="true">↧</span><span>${escapeHtml(file.name)}</span><small>${file.bytes} B</small></a>`).join('');
      return `<article class="communication-message ${message.sender.type === "human" ? "from-human" : ""}" data-tone="${communicationSenderTone(message.sender)}"><header><strong>${escapeHtml(message.sender.name)}</strong><time>${escapeHtml(date(message.createdAt))}</time></header>${message.handoffTo ? `<p class="communication-handoff">转交给 ${escapeHtml(message.handoffTo.name)} · 请对方回复</p>` : ""}${original ? `<blockquote>回复 ${escapeHtml(original.sender.name)}：${escapeHtml(original.content.slice(0, 100))}</blockquote>` : ""}<div class="communication-body communication-markdown">${renderContent(message.content, (state.conversation?.members || []).map(member => member.name))}</div>${attachments ? `<div class="communication-message-attachments">${attachments}</div>` : ''}</article>`;
    }).join("") || `<div class="communication-empty">${state.latestError ? "聊天记录读取失败，正在重连。" : state.loaded ? "从一句话开始沟通。消息将持续保留。" : "正在读取聊天记录…"}</div>`;
    if (list.innerHTML !== html) {
      list.innerHTML = html;
      if (state.loadingOlder) list.scrollTop = top + list.scrollHeight - height;
      else list.scrollTop = bottom ? list.scrollHeight : top;
    }
    query(".communication-older").hidden = !state.hasMore;
    query(".communication-older").disabled = Boolean(state.olderRequest?.generation === generation);
  }
  async function loadMessages(older = false) {
    const key = currentId, token = generation;
    if (!key) return;
    const state = view(key);
    const slot = older ? "olderRequest" : "latestRequest";
    const errorSlot = older ? "olderError" : "latestError";
    if (state[slot]?.generation === token || (older && (!state.loaded || !state.hasMore || !state.before))) return;
    const request = { generation: token, epoch: state.historyEpoch, before: state.before, sentMessages: [] };
    state[slot] = request;
    if (older) query(".communication-older").disabled = true;
    try {
      const [result] = await Promise.all([
        api(`/api/communications/${key}${older ? "?before=" + encodeURIComponent(request.before) : ""}`),
        prepareContent().catch(() => {}) // A missing display dependency must not hide messages.
      ]);
      if (!isCurrent(key, token) || (older && request.epoch !== state.historyEpoch)) return;
      if (!older && state.loaded && result.messages.length && !result.messages.some((message) => state.readMessageIds.has(message.id))) {
        // A missed window is re-anchored, never joined across a hidden history gap.
        // POST confirms one message, not coverage of intervening history.
        state.messages.clear(); state.readMessageIds.clear(); state.deliveries.clear(); state.loaded = false;
        // POST acknowledgements received after this GET began are newer facts.
        request.sentMessages.forEach((message) => state.messages.set(message.id, message));
        state.historyEpoch++;
        state.olderRequest = null;
        state.olderError = "";
      }
      if (!older) { state.conversation = result.conversation; state.latestVisibleMessageId = result.messages.at(-1)?.id; }
      result.messages.forEach((message) => { state.messages.set(message.id, message); state.readMessageIds.add(message.id); });
      result.deliveries.forEach((delivery) => state.deliveries.set(delivery.id, delivery));
      if (!state.loaded || older) { state.before = result.nextBefore; state.hasMore = result.hasMore; }
      state.loaded = true; state.loadingOlder = older;
      state[errorSlot] = "";
      query(".communication-heading").textContent = state.conversation.name;
      query(".communication-subtitle").textContent = state.conversation.kind === "team" ? "团队群聊 · 不 @ 全员回复，@ 可指定成员 · 支持成员单次转交" : "长期私聊 · 与任务执行上下文隔离";
      renderMessages(); state.loadingOlder = false;
      if (!older) void markVisibleRead();
      renderReadErrors();
    } catch (error) {
      if (!isCurrent(key, token) || (older && request.epoch !== state.historyEpoch)) return;
      state[errorSlot] = older ? `更早消息读取失败：${error.message}（历史和草稿保留，可再次加载更早消息）` : `聊天记录读取失败：${error.message}（历史和草稿保留，正在重连）`;
      if (!state.loaded) query(".communication-heading").textContent = "会话读取失败";
      renderReadErrors(); renderMessages();
    } finally {
      if (state[slot] === request) state[slot] = null;
      if (isCurrent(key, token)) query(".communication-older").disabled = Boolean(state.olderRequest?.generation === token);
    }
  }
  async function poll() {
    if (!host || listRequest?.generation === generation) return;
    const request = { generation }; listRequest = request;
    const token = generation;
    try {
      const result = await api("/api/communications");
      if (!host || token !== generation) return;
      conversations = result.conversations; listLoaded = true; listError = ""; renderList(); renderReadErrors();
      if(!currentId){const latest=latestConversationId(conversations);if(latest)navigate(latest);}
    } catch (error) { if (host && token === generation) { listError = `会话列表读取失败：${error.message}（历史和草稿保留，正在重连）`; renderList(); renderReadErrors(); } }
    finally { if (listRequest === request) listRequest = null; }
  }
  function consolePage(state) {
    if (!state.consolePages.has(state.consoleAgentId)) state.consolePages.set(state.consoleAgentId, { events: new Map(), traces: [], loaded: false, hasMore: false, before: null });
    return state.consolePages.get(state.consoleAgentId);
  }
  function renderConsolePanel() {
    if (!currentId) return;
    const state = view(currentId), panel = query('[data-communication-console]');
    panel.hidden = !state.consoleOpen; panel.dataset.open = String(state.consoleOpen);
    query('.communication-panes').classList.toggle('console-open', state.consoleOpen);
    query('[data-toggle-communication-console]').setAttribute('aria-expanded', String(state.consoleOpen));
    query('[data-toggle-communication-console]').textContent = `控制台 ${state.consoleOpen ? '‹' : '›'}`;
    if (!state.consoleOpen) return;
    const members = query('[data-communication-members]');
    members.hidden = state.consoleMembers.length < 2;
    const html = members.hidden ? '' : state.consoleMembers.map(agent => `<button type="button" class="small-button ${agent.id === state.consoleAgentId ? 'selected' : ''} ${agent.running ? 'is-running' : ''}" data-communication-agent="${escapeHtml(agent.id)}" aria-pressed="${agent.id === state.consoleAgentId}">${agent.running ? '<span class="console-tool-running" aria-label="执行中"></span>' : ''}${escapeHtml(agent.name)}</button>`).join('');
    if (members.innerHTML !== html) {
      members.innerHTML = html;
      members.querySelectorAll('button').forEach(button => button.onclick = () => { state.consoleAgentId = button.dataset.communicationAgent; state.consoleRequest = null; state.consoleRenderKey = null; renderConsolePanel(); void loadConsole(); });
    }
    query('[data-communication-console-error]').textContent = state.consoleError;
    const page = consolePage(state);
    query('[data-communication-console-older]').hidden = !page.hasMore;
    query('[data-communication-console-older]').disabled = Boolean(state.consoleRequest);
    const stream = query('[data-communication-stream]');
    const agent = state.consoleMembers.find(row => row.id === state.consoleAgentId);
    if (!agent) { stream.textContent = state.consoleRequest ? '正在读取控制台…' : '此会话尚无执行记录。'; return; }
    const key = JSON.stringify([agent.id, [...page.events.keys()], page.traces]);
    if (state.consoleRenderKey === key) return;
    state.consoleRenderKey = key;
    const reading = page.reading || { following: true, top: 0, open: [], closed: [] };
    if (stream.dataset.agentId === agent.id && stream.children.length) {
      reading.following = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 48;
      reading.top = stream.scrollTop;
      reading.open = [...stream.querySelectorAll('details[open][data-console-key]')].map(node => node.dataset.consoleKey);
      reading.closed = [...stream.querySelectorAll('details[data-default-open]:not([open])')].map(node => node.dataset.consoleKey);
    }
    const height = stream.scrollHeight;
    stream.dataset.agentId = agent.id;
    renderConsole(stream, { events: [...page.events.values()], traces: page.traces, hasMore: page.hasMore, refresh: Boolean(state.consoleRefresh), basePath: `/api/communications/${encodeURIComponent(currentId)}` }, agent);
    state.consoleRefresh = false;
    for (const details of stream.querySelectorAll('details[data-console-key]')) details.open = reading.open.includes(details.dataset.consoleKey) || (details.dataset.defaultOpen !== undefined && !reading.closed.includes(details.dataset.consoleKey));
    stream.scrollTop = state.consolePrepend ? reading.top + stream.scrollHeight - height : reading.following ? stream.scrollHeight : reading.top;
    state.consolePrepend = false; page.reading = reading;
  }
  async function loadConsole(older = false) {
    const key = currentId, token = generation;
    if (!key) return;
    const state = view(key), page = consolePage(state);
    if (!state.consoleOpen || state.consoleRequest || older && (!page.hasMore || !page.before)) return;
    const request = { agentId: state.consoleAgentId }; state.consoleRequest = request;
    renderConsolePanel();
    try {
      const params = new URLSearchParams({ limit: '50', ...(request.agentId ? { agentId: request.agentId } : {}), ...(older ? { before: page.before } : {}) });
      const result = await api(`/api/communications/${key}/console?${params}`);
      if (!isCurrent(key, token) || !state.consoleOpen || state.consoleRequest !== request) return;
      state.consoleMembers = result.agents;
      if (!request.agentId && result.agents.length) {
        state.consoleAgentId = (result.agents.find(agent => agent.running) || result.agents[0]).id;
        state.consoleRequest = null; state.consoleRenderKey = null; renderConsolePanel(); void loadConsole(); return;
      }
      if (!older && page.loaded && result.events.length && !result.events.some(event => page.events.has(event.id))) { page.events.clear(); page.loaded = false; }
      for (const event of result.events) page.events.set(event.id, event);
      page.traces = result.traces;
      if (!page.loaded || older) { page.before = result.nextBefore; page.hasMore = result.hasMore; }
      page.loaded = true; state.consoleError = ''; state.consolePrepend = older;
    } catch (error) { if (isCurrent(key, token) && state.consoleRequest === request) state.consoleError = `控制台读取失败：${error.message}；记录保留，可刷新重试。`; }
    finally { if (state.consoleRequest === request) state.consoleRequest = null; if (isCurrent(key, token)) renderConsolePanel(); }
  }
  function renderAttachments() {
    const state = view(currentId), container = query('[data-chat-attachments]');
    container.innerHTML = state.attachments.map(item => `<span class="communication-attachment pending"><span>${escapeHtml(item.file.name)}</span><button type="button" class="text-action" data-remove-chat-attachment="${item.id}" aria-label="移除附件 ${escapeHtml(item.file.name)}"${state.sending ? ' disabled' : ''}>×</button></span>`).join('');
    container.querySelectorAll('button').forEach(button => button.onclick = () => { state.attachments = state.attachments.filter(item => item.id !== button.dataset.removeChatAttachment); state.requestId = null; renderAttachments(); });
  }
  function mentionMenu() {
    const input = query("textarea"), state = view(currentId), menu = query(".communication-mentions");
    state.mentions = state.mentions.filter((member) => input.value.includes("@" + member.name));
    const match = activeMention(input.value, input.selectionStart, state.mentions);
    if (!match || state.conversation?.kind !== "team") { menu.hidden = true; return; }
    const members = state.conversation.members.filter((member) => member.status === "active" && member.name.toLowerCase().includes(match[1].toLowerCase()));
    menu.innerHTML = members.map((member, index) => `<button type="button" role="option" aria-selected="${index === 0}" data-chat-mention="${escapeHtml(member.id)}">${escapeHtml(member.name)}</button>`).join("") || "<p>没有匹配成员</p>";
    menu.hidden = false;
    menu.querySelectorAll("button").forEach((button) => button.onclick = () => {
      const member = members.find((item) => item.id === button.dataset.chatMention);
      input.setRangeText("@" + member.name + " ", input.selectionStart - match[0].length, input.selectionStart, "end");
      state.mentions = [...state.mentions.filter((item) => item.id !== member.id), member];
      state.draft = input.value; state.requestId = null; menu.hidden = true; input.focus();
    });
  }
  function setupConversation() {
    const area = query(".communication-main");
    if (!currentId) { area.innerHTML = '<div class="communication-empty"><h2>沟通</h2><p>选择数字员工开始私聊，或进入团队群聊。</p><small>历史长期保存 · 不受任务归档影响</small></div>'; return; }
    const state = view(currentId);
    state.consoleRenderKey = null;
    area.innerHTML = `<div class="communication-panes">
      <section class="communication-chat">
        <header class="communication-header"><div><h2 class="communication-heading"></h2><p class="communication-subtitle"></p></div><button type="button" class="text-action communication-console-toggle" data-toggle-communication-console aria-controls="communication-console-panel" aria-expanded="${state.consoleOpen}">控制台 ›</button></header>
        <button class="small-button communication-older" hidden>加载更早消息</button><div class="communication-messages" aria-label="聊天记录"></div>
        <form class="communication-composer"><div class="communication-mentions" role="listbox" aria-label="@ 成员" hidden></div><textarea id="communication-input" aria-label="输入消息" placeholder="输入消息；群聊输入 @ 选择成员" rows="3">${escapeHtml(state.draft)}</textarea><div class="communication-draft-attachments" data-chat-attachments></div><p class="field-hint" data-chat-upload-status role="status"></p><input type="file" multiple data-chat-file hidden><div class="communication-composer-actions"><button type="button" class="small-button" data-chat-attach aria-label="添加附件"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><span>附件</span></button><span>Enter 发送 · Shift + Enter 换行</span><button class="primary-button" type="submit">发送</button></div></form>
      </section>
      <aside id="communication-console-panel" class="communication-console" data-communication-console hidden>
        <div class="communication-console-toolbar"><div class="communication-console-actions"><button type="button" class="text-action" data-communication-console-latest>↓ 最新</button><button type="button" class="text-action" data-communication-console-refresh>刷新</button></div></div><div class="communication-console-members" data-communication-members aria-label="控制台成员" hidden></div><button type="button" class="text-action communication-console-older" data-communication-console-older hidden>加载更早记录</button><p class="communication-console-error" data-communication-console-error role="alert"></p><div class="communication-trace-stream" data-communication-stream tabindex="0" role="log" aria-label="沟通控制台"></div>
      </aside>
    </div>`;
    query(".communication-heading").textContent = state.conversation?.name || (state.latestError ? "会话读取失败" : "加载会话…");
    query(".communication-subtitle").textContent = state.conversation ? (state.conversation.kind === "team" ? "团队群聊 · 不 @ 全员回复，@ 可指定成员 · 支持成员单次转交" : "长期私聊 · 与任务执行上下文隔离") : "";
    renderMessages();
    renderAttachments(); renderConsolePanel();
    query('[data-toggle-communication-console]').onclick = () => { state.consoleOpen = !state.consoleOpen; state.consoleRequest = null; state.consoleRenderKey = null; renderConsolePanel(); if (state.consoleOpen) void loadConsole(); };
    query('[data-communication-console-older]').onclick = () => void loadConsole(true);
    query('[data-communication-console-refresh]').onclick = () => { state.consoleRenderKey = null; state.consoleRefresh = true; void loadConsole(); };
    query('[data-communication-console-latest]').onclick = () => { const stream = query('[data-communication-stream]'); stream.scrollTop = stream.scrollHeight; };
    const fileInput = query('[data-chat-file]');
    query('[data-chat-attach]').onclick = () => { if (!state.sending) fileInput.click(); };
    fileInput.onchange = () => {
      if (state.sending) return;
      for (const file of fileInput.files) {
        if (file.size > 20 * 1024 * 1024) { notify(`「${file.name}」超过单文件 20 MiB 上限。`, true); continue; }
        state.attachments.push({ id: crypto.randomUUID(), file, uploaded: null });
      }
      fileInput.value = ''; state.requestId = null; renderAttachments();
    };
    query('.communication-messages').onclick = async event => {
      const link = event.target.closest('[data-attachment-download]');
      if (!link) return;
      event.preventDefault();
      try {
        const response = await fetch(link.href);
        if (!response.ok) throw new Error((await response.json()).error || '附件下载失败');
        const url = URL.createObjectURL(await response.blob()), download = document.createElement('a');
        download.href = url; download.download = link.download; download.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) { notify(error.message, true); }
    };
    query(".communication-messages").onscroll = () => { void markVisibleRead(); };
    query(".communication-older").onclick = () => loadMessages(true).catch((error) => notify(error.message, true));
    const form = query("form"), input = query("textarea"), submit = form.querySelector('[type="submit"]');
    submit.disabled = state.sending;
    input.oninput = () => { state.draft = input.value; state.requestId = null; mentionMenu(); };
    input.onkeydown = (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      const modified = event.shiftKey || event.metaKey || event.altKey || event.ctrlKey;
      const menu = query(".communication-mentions"), buttons = [...menu.querySelectorAll("button")];
      if (!menu.hidden && buttons.length && !modified && ["Tab", "Enter", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        let index = Math.max(0, buttons.findIndex((button) => button.getAttribute("aria-selected") === "true"));
        if (["Tab", "Enter"].includes(event.key)) buttons[index].click();
        else { index = (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length; buttons.forEach((button, i) => button.setAttribute("aria-selected", String(i === index))); }
        return;
      }
      if (event.key === "Escape") menu.hidden = true;
      if (event.key === "Enter") {
        event.preventDefault();
        if (modified) { input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new Event("input")); }
        else form.requestSubmit();
      }
    };
    form.onsubmit = async (event) => {
      event.preventDefault(); const key = currentId, token = generation, content = input.value;
      if (state.sending || (!content.trim() && !state.attachments.length)) return;
      if (content.length > 32000) { notify("消息最多 32000 字符。", true); return; }
      state.requestId ||= crypto.randomUUID();
      const requestId = state.requestId;
      const mentionAgentIds = state.mentions.filter((member) => content.includes("@" + member.name)).map((member) => member.id);
      const attachments = [...state.attachments];
      state.sending = true; submit.disabled = true; renderAttachments();
      try {
        for (const item of attachments) {
          if (item.uploaded) continue;
          if (isCurrent(key, token)) query('[data-chat-upload-status]').textContent = `正在上传 ${item.file.name}…`;
          const result = await api(`/api/communications/${key}/attachments?name=${encodeURIComponent(item.file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: item.file });
          item.uploaded = result.attachment;
        }
        const { message } = await api(`/api/communications/${key}/messages`, { method: "POST", body: JSON.stringify({ content, mentionAgentIds, attachmentIds: attachments.map(item => item.uploaded.id), clientRequestId: requestId }) });
        state.messages.set(message.id, message);
        state.attachments = state.attachments.filter(item => !attachments.includes(item));
        state.latestRequest?.sentMessages.push(message);
        if (state.draft === content) { state.draft = ""; state.mentions = []; state.requestId = null; if (isCurrent(key, token)) input.value = ""; }
        if (isCurrent(key, token)) { query(".communication-mentions").hidden = true; renderMessages(); const list = query(".communication-messages"); list.scrollTop = list.scrollHeight; }
      } catch (error) { notify(error.message, true); }
      finally { state.sending = false; if (host && currentId === key) { query('form [type="submit"]').disabled = false; query('[data-chat-upload-status]').textContent = ''; renderAttachments(); } }
    };
  }
  function showContactPicker(open) {
    const trigger = query("[data-new-chat]");
    const dialog = document.createElement("dialog");
    dialog.className = "communication-picker";
    dialog.setAttribute("aria-labelledby", "communication-picker-title");
    dialog.innerHTML = '<header><div><h2 id="communication-picker-title">发起对话</h2><p>选择数字员工私聊，或进入团队群聊</p></div><button type="button" class="small-button" aria-label="关闭选择">关闭</button></header><label for="communication-search">搜索员工或团队</label><input id="communication-search" type="search" placeholder="搜索名称、能力简介或团队" autocomplete="off"><div class="communication-picker-list"></div><div class="communication-picker-pager"></div>';
    host.append(dialog);
    const input = dialog.querySelector("input"), list = dialog.querySelector(".communication-picker-list"), pager = dialog.querySelector(".communication-picker-pager");
    let pickerPage = 1;
    const render = () => {
      const term = input.value.trim().toLowerCase();
      const matches = contacts.filter((item) => [item.name, item.description, item.mission].some((value) => String(value || "").toLowerCase().includes(term)));
      const page = paginate(matches, pickerPage); pickerPage = page.page;
      list.innerHTML = page.items.map((item) => `<button type="button" class="communication-contact" data-kind="${item.kind}" data-target="${escapeHtml(item.id)}"><span class="communication-avatar">${item.kind === "team" ? "群" : escapeHtml(item.name.slice(0, 1))}</span><span><strong>${escapeHtml(item.name)}</strong><small>${item.kind === "team" ? "团队群聊" : "数字员工"}</small></span></button>`).join("") || '<p class="communication-picker-empty">没有匹配的员工或团队</p>';
      pager.innerHTML = paginationMarkup(page, "contacts");
      list.querySelectorAll("button").forEach((button) => button.onclick = () => { dialog.close(); open(button.dataset.kind, button.dataset.target); });
    };
    input.oninput = () => { pickerPage = 1; render(); };
    pager.onclick = (event) => { const button = event.target.closest("[data-page]"); if (button) { pickerPage = Number(button.dataset.page); render(); } };
    dialog.querySelector('[aria-label="关闭选择"]').onclick = () => dialog.close();
    dialog.onclose = () => { dialog.remove(); trigger?.focus(); };
    dialog.onclick = (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } };
    input.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); list.querySelector("button")?.click(); } };
    render(); dialog.showModal(); input.focus();
  }
  return {
    async open(kind, targetId) {
      const existing = conversations.find((item) => item.kind === kind && item.targetId === targetId);
      if (existing) { navigate(existing.id); return; }
      try { const result = await api("/api/communications", { method: "POST", body: JSON.stringify({ kind, targetId }) }); navigate(result.conversation.id); }
      catch (error) { notify(error.message, true); }
    },
    mount(element, state, selectedId) {
      const fresh = host !== element; host = element;
      contacts = [...state.agents.map((item) => ({ ...item, kind: "agent" })), ...state.teams.map((item) => ({ ...item, kind: "team" }))];
      if (fresh) {
        host.innerHTML = '<div class="communication-error" role="status"></div><div class="communication-layout"><aside class="communication-sidebar"><div class="communication-sidebar-heading"><h2>沟通</h2><button type="button" class="small-button" data-new-chat aria-label="新建对话"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg></button></div><div class="communication-list"></div><div class="communication-pager"></div></aside><section class="communication-main"></section></div>';
        query("[data-new-chat]").onclick = () => showContactPicker((kind, id) => this.open(kind, id));
        query(".communication-pager").onclick = (event) => { const button = event.target.closest("[data-page]"); if (button) { listPage = Number(button.dataset.page); renderList(); } };
      }
      const changed = fresh || currentId !== selectedId;
      if (changed) { generation++; currentId = selectedId; setupConversation(); }
      const update = () => { poll(); loadMessages(); void loadConsole(); };
      renderList(); renderReadErrors();
      if (changed || !timer) { clearInterval(timer); timer = setInterval(update, 2000); update(); }
    },
    unmount() { clearInterval(timer); timer = null; host = null; currentId = null; generation++; }
  };
}
