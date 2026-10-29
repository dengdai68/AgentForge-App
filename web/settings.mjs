import { DIRECTORY_THEMES, NAVIGATION, normalizePreferences } from "./preferences.mjs";

export const SETTINGS_PAGES = { general: "常规", appearance: "外观", workspace: "工作目录", cli: "命令行 CLI", repositories: "仓库访问", runtime: "Runtime", plugins: "插件更新", logs: "运行日志" };
const escape = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

// Mirrors the provider effort vocabularies observed from the real CLIs in
// server/runtime/model-catalog.mjs; tests assert both sides stay equal. The
// catalog endpoint refines per-model availability whenever it loads.
export const RUNTIME_EFFORT_LEVELS = { "claude-code": ["low", "medium", "high", "xhigh", "max"], codex: ["low", "medium", "high", "xhigh", "max", "ultra"] };

// Effort select options for a provider/model pair. catalog is null until the
// real source loads (or after it failed); fallbacks are labelled honestly and
// never pretend per-model knowledge the platform does not have.
export function runtimeEffortOptions(provider, modelId, catalog) {
  const defaults = [{ value: "", label: "默认（CLI 决定）" }];
  const entry = modelId && catalog?.models ? catalog.models.find(item => item.id === modelId) : null;
  if (provider === "claude-code") {
    if (entry) {
      if (!entry.levels?.length) return { options: defaults, note: entry.note || "配置声明该模型不支持思考档位。" };
      return { options: [...defaults, ...entry.levels.map(id => ({ value: id, label: id }))], note: entry.note || "" };
    }
    return { options: [...defaults, ...RUNTIME_EFFORT_LEVELS["claude-code"].map(id => ({ value: id, label: id }))], note: modelId ? "模型不在列表中（手工输入）；档位按 Claude Code CLI 集合展示，实际支持以调用为准。" : "档位由 CLI 按模型实际支持解析，不支持时回退。" };
  }
  if (entry) {
    const levels = (entry.levels || []).map(level => ({ value: level.id, label: level.default ? `${level.id}（模型默认）` : level.id }));
    if (!levels.length) return { options: defaults, note: "目录中该模型未声明思考档位。" };
    return { options: [...defaults, ...levels], note: "档位来自 codex debug models 目录；账号实际可用性以调用为准。" };
  }
  return { options: [...defaults, ...RUNTIME_EFFORT_LEVELS.codex.map(id => ({ value: id, label: id }))], note: modelId ? "模型不在目录中（手工输入）；档位按 Codex 全局集合展示，逐模型支持以调用为准。" : "未选择模型；逐模型档位在选择模型后精确展示，当前为 Codex 全局集合。" };
}

export function createClosePreferenceUI(panel, desktop) {
  const form = panel.querySelector('[data-close-form]');
  const options = [...form.querySelectorAll('[name="closeMode"]')];
  const selected = () => options.find(option => option.checked)?.value || "";
  const save = form.querySelector('[type="submit"]'), status = panel.querySelector('[data-close-status]');
  const retry = panel.querySelector('[data-close-retry]');
  let saved = null, ready = false, busy = false, disposed = false, request = 0;
  const dirty = () => ready && selected() !== (saved || "");
  const sync = () => { options.forEach(option => { option.disabled = !ready || busy; }); save.disabled = !dirty() || busy || !["quit", "tray"].includes(selected()); };
  function accept(value) {
    if (value?.platform !== "darwin" || ![null, "quit", "tray"].includes(value.closeMode)) throw new Error("客户端偏好不可用");
    saved = value.closeMode; options.forEach(option => { option.checked = option.value === saved; }); ready = true;
  }
  async function refresh() {
    if (disposed || panel.hidden || busy || dirty()) return;
    if (!desktop) { form.hidden = true; status.textContent = "客户端宿主接口不可用，请重新打开应用。"; return; }
    const id = ++request; busy = true; sync(); retry.hidden = true;
    try {
      const value = await desktop.getPreferences();
      if (disposed || id !== request) return;
      accept(value); status.textContent = saved ? "已保存；后续关闭窗口按此设置执行。" : "尚未设置；首次关闭窗口时会询问，取消不会保存选择。";
    } catch {
      if (!disposed && id === request) { ready = false; status.textContent = "读取客户端偏好失败，请重试。"; retry.hidden = false; }
    } finally { if (!disposed && id === request) { busy = false; sync(); } }
  }
  form.onchange = () => { status.textContent = dirty() ? "尚未保存。" : "设置未更改。"; sync(); };
  form.onsubmit = async event => {
    event.preventDefault(); if (save.disabled) return;
    busy = true; sync(); status.textContent = "正在保存…";
    try {
      const value = await desktop.setCloseMode(selected());
      if (disposed) return;
      accept(value); status.textContent = "已保存；后续关闭窗口按此设置执行。";
    } catch { if (!disposed) status.textContent = "保存失败，原设置未更改。请重试；详细原因见运行日志。"; }
    finally { if (!disposed) { busy = false; sync(); } }
  };
  retry.onclick = refresh;
  sync();
  return { refresh, dispose() { disposed = true; ++request; } };
}

export function createCliInstallationUI(panel, desktop) {
  const button = panel.querySelector('[data-cli-install]'), retry = panel.querySelector('[data-cli-refresh]');
  const status = panel.querySelector('[data-cli-status]'), paths = panel.querySelector('[data-cli-paths]');
  let disposed = false, busy = false, available = false;
  function accept(value) {
    available = value.canInstall === true;
    paths.textContent = [value.commandPath, ...(value.profilePaths || [])].filter(Boolean).join('\n');
    status.textContent = value.cancelled ? (value.installed ? '已取消重新安装；现有 CLI 保持不变。' : '已取消，未安装。') : value.installed ? '已安装。请新开终端运行 agentforge help；已有终端需重新打开。' : value.message || '尚未安装。确认后仅写入当前用户的命令与受管 PATH 配置块。';
    button.textContent = value.installed ? '重新安装 CLI' : '安装 CLI';
    button.hidden = !value.supported;
  }
  const sync = () => { button.disabled = busy || !available; retry.disabled = busy; };
  async function run(install = false) {
    if (disposed || busy || (!install && panel.hidden)) return;
    if (!desktop?.getCliInstallation || !desktop?.installCli) {
      button.hidden = true; retry.hidden = true;
      status.textContent = '客户端宿主接口不可用，请重新打开应用后安装 CLI。'; return;
    }
    busy = true; sync(); status.textContent = install ? '请在客户端确认安装…' : '正在检查 CLI 安装…';
    try {
      const value = await (install ? desktop.installCli() : desktop.getCliInstallation());
      if (!disposed) accept(value);
    } catch {
      if (!disposed) { available = false; status.textContent = 'CLI 安装检查或操作失败，请刷新后重试；不会使用 sudo 或覆盖其他命令。'; }
    } finally { if (!disposed) { busy = false; sync(); } }
  }
  button.onclick = () => { if (!button.disabled) return run(true); };
  retry.onclick = () => run(); sync();
  return { refresh: () => run(), dispose() { disposed = true; } };
}

export function createPluginUpdateSettingsUI(panel, api) {
  const form=panel.querySelector('[data-plugin-update-form]'), enabled=form.querySelector('[name=enabled]'), interval=form.querySelector('[name=intervalMinutes]');
  const save=form.querySelector('[type=submit]'), check=panel.querySelector('[data-check-plugin-updates]'), status=panel.querySelector('[data-plugin-update-status]'), note=panel.querySelector('[data-plugin-update-note]');
  let saved=null, observed=null, busy=false, disposed=false, request=0, timer;
  const dirty=()=>saved && (enabled.checked!==saved.enabled || Number(interval.value)!==saved.intervalMinutes);
  const valid=()=>/^\d+$/.test(interval.value) && Number(interval.value)>=1 && Number(interval.value)<=1440;
  const sync=()=>{
    enabled.disabled=interval.disabled=!saved || busy;
    save.disabled=!dirty() || !valid() || busy;
    check.disabled=!saved || busy || Boolean(observed?.running);
  };
  function accept(value) {
    const preserve=dirty(); saved={enabled:value.enabled,intervalMinutes:value.intervalMinutes};observed=value;
    if(!preserve){enabled.checked=saved.enabled;interval.value=String(saved.intervalMinutes);}
    status.textContent=value.running?'正在检查 Git 插件…':value.lastCheckedAt?`最近检查 ${new Date(value.lastCheckedAt).toLocaleString()} · 更新 ${value.lastResult?.updatedPlugins || 0} 个插件${value.lastResult?.errors?.length?` · ${value.lastResult.errors.length} 个来源未更新，详情见运行日志`:''}`:'尚未检查';
    if(value.nextCheckAt)status.textContent+=` · 下次 ${new Date(value.nextCheckAt).toLocaleTimeString()}`;
    else if(!value.enabled)status.textContent+=' · 自动更新已关闭';
  }
  function schedule(){clearTimeout(timer);if(!disposed && !panel.hidden)timer=setTimeout(refresh,5000);}
  async function refresh() {
    if(disposed || panel.hidden || busy)return;
    const id=++request;
    try{const value=await api('/api/runtime/marketplace/updates');if(disposed || id!==request)return;accept(value);}
    catch(error){if(!disposed && id===request)status.textContent=error.message;}
    finally{if(!disposed && id===request){sync();schedule();}}
  }
  form.oninput=()=>{note.textContent=valid()?(dirty()?'尚未保存。':''): '检查周期须为 1–1440 的整数分钟。';sync();};
  form.onsubmit=async event=>{
    event.preventDefault();if(save.disabled)return;
    busy=true;++request;clearTimeout(timer);sync();note.textContent='正在保存…';
    try{
      const value=await api('/api/runtime/marketplace/updates/settings',{method:'PUT',body:JSON.stringify({enabled:enabled.checked,intervalMinutes:Number(interval.value)})});
      if(disposed)return;saved=null;accept(value);note.textContent='已保存。';
    }catch(error){if(!disposed)note.textContent=`保存失败：${error.message}`;}
    finally{if(!disposed){busy=false;sync();schedule();}}
  };
  check.onclick=async()=>{
    if(check.disabled)return;
    busy=true;++request;clearTimeout(timer);sync();
    try{const value=await api('/api/runtime/marketplace/updates',{method:'POST',body:'{}'});if(!disposed)accept(value);}
    catch(error){if(!disposed)status.textContent=error.message;}
    finally{if(!disposed){busy=false;sync();schedule();}}
  };
  sync();
  return {refresh,pause(){++request;clearTimeout(timer);},dispose(){disposed=true;++request;clearTimeout(timer);}};
}

export function createSettingsUI({ api, notify, navigate, getPreferences, updatePreferences, clearInvalid, setInvalid, onWorkspaceSaved = () => {}, openModal, closeModal, confirmDialog, onDataReset, onResetStarted = () => {}, onResetFailed = () => {} }) {
  let root = null, repositoriesLoaded = false, workspaceLoaded = false, runtimeLoaded = false;
  let logRequest = 0, currentPage = null;
  let closePreferenceUI = null, cliInstallationUI = null, pluginUpdateUI = null;
  const refreshHostSettings = () => {
    if (currentPage === "general") void closePreferenceUI?.refresh();
    if (currentPage === "cli") void cliInstallationUI?.refresh();
    if (currentPage === "plugins") void pluginUpdateUI?.refresh();
  };
  function confirmDataReset() {
    openModal(`<h2>清除所有数据</h2><p class="modal-intro">永久删除此工作区的账号、任务与沟通记录、数字员工、团队、工作流、Runtime 与扩展配置、仓库 Token、交付文件及系统创建的任务目录。清除后重新设置管理员。</p><p class="settings-note">外部已有项目目录、工作根目录及本机 Claude Code / Codex 登录与会话保留。请先停止正在执行的任务和沟通。此操作无法撤销。</p><form id="reset-data-form"><div class="form-field"><label for="reset-current-password">当前密码</label><input id="reset-current-password" name="password" type="password" autocomplete="current-password" required /></div><div class="form-field"><label for="reset-confirmation">输入「清除所有数据」确认</label><input id="reset-confirmation" name="confirmation" autocomplete="off" required /></div><p data-reset-error role="alert"></p><div class="form-actions"><button class="ghost-button" type="button" data-cancel-reset>取消</button><button class="danger-button" type="submit" disabled>清除并重新开始</button></div></form>`);
    const form = document.querySelector("#reset-data-form"), button = form.querySelector('[type="submit"]');
    form.oninput = () => { button.disabled = !form.elements.password.value || form.elements.confirmation.value !== "清除所有数据"; };
    form.querySelector('[data-cancel-reset]').onclick = closeModal;
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      form.querySelector('[data-cancel-reset]').disabled = true;
      onResetStarted();
      form.querySelector('[data-reset-error]').textContent = "正在清除，请保持窗口打开…";
      try {
        const result = await api("/api/settings/reset", { method: "POST", body: JSON.stringify({ password: form.elements.password.value, confirmation: form.elements.confirmation.value }) });
        onDataReset(result.next);
      } catch (error) {
        onResetFailed();
        form.querySelector('[data-cancel-reset]').disabled = false;
        form.elements.password.value = "";
        form.querySelector('[data-reset-error]').textContent = error.message;
        form.oninput();
      }
    };
  }

  async function loadLogs() {
    const panel = root?.querySelector('[data-settings-panel="logs"]');
    if (!panel || panel.hidden) return;
    const request = ++logRequest;
    const status = panel.querySelector('[data-log-status]');
    try {
      const result = await api("/api/settings/log-files");
      if (request !== logRequest || !panel.isConnected || panel.hidden) return;
      panel.querySelector('[data-log-directory]').textContent = result.directory;
      panel.querySelector('[data-log-file]').textContent = result.filePath;
      status.textContent = result.available ? "日志写入正常" : `日志不可写：${result.error?.code || ""} ${result.error?.message || ""}`;
    } catch (error) {
      if (request === logRequest && panel.isConnected) status.textContent = `读取路径失败：${error.message}`;
    }
  }

  async function loadRuntimes() {
    const container = root.querySelector('[data-runtime-config]');
    runtimeLoaded = true;
    container.innerHTML = '<p role="status">正在读取 Runtime 配置…</p>';
    try {
      const { profiles } = await api('/api/settings/runtime-profiles');
      if (!container.isConnected) return;
      container.replaceChildren();
      for (const profile of [...profiles, null]) {
        const card = document.createElement('details'); card.className = 'repository-access-card';
        card.dataset.runtimeProfile = profile?.id || 'new';
        const value = profile || { name: '', provider: 'claude-code', model: '', executable: '', profile: '', effort: '' };
        const modelListId = `runtime-models-${profile?.id || 'new'}`;
        card.innerHTML = `<summary><h4>${profile ? escape(profile.name) : '新增 Runtime'}</h4><span class="field-hint">${profile ? `${escape(profile.provider)} · ${profile.employeeCount} 位员工${profile.system ? ' · 默认' : ''}` : '展开填写配置'}</span></summary><form class="runtime-profile-form"><div class="form-grid">
          <div class="form-field"><label>配置名称<input name="name" value="${escape(value.name)}" required maxlength="120" /></label></div>
          <div class="form-field"><label>Provider<select name="provider" ${profile ? 'disabled' : ''}><option value="claude-code" ${value.provider === 'claude-code' ? 'selected' : ''}>Claude Code</option><option value="codex" ${value.provider === 'codex' ? 'selected' : ''}>Codex</option></select></label></div>
          <div class="form-field runtime-model-field"><label for="${modelListId}-input">模型</label><div class="runtime-model-row"><div class="runtime-model-picker"><input id="${modelListId}-input" name="model" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${modelListId}" value="${escape(value.model)}" placeholder="选择或输入模型" autocomplete="off" spellcheck="false" /><button type="button" class="model-picker-toggle" aria-label="展开模型列表" aria-controls="${modelListId}">⌄</button><div id="${modelListId}" class="model-options" role="listbox" aria-label="模型列表" hidden></div></div><button type="button" class="model-refresh" data-refresh-models aria-label="刷新模型列表" title="刷新模型列表"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7M20 7v5"/></svg></button></div><p class="field-hint" data-model-status>模型列表：尚未加载。</p></div>
          <div class="form-field"><label>思考等级<select name="effort"></select></label><p class="field-hint" data-effort-status></p></div>
          <div class="form-field"><label>CLI 路径<input name="executable" value="${escape(value.executable || '')}" placeholder="留空使用服务 PATH 中的 CLI" spellcheck="false" /></label></div>
          <div class="form-field" data-cli-profile ${value.provider === 'codex' ? '' : 'hidden'}><label>Codex profile<input name="profile" value="${escape(value.profile)}" placeholder="可选：本机 config.toml 中的 profile" /></label></div>
          </div><p class="field-hint">${profile ? `${profile.employeeCount} 位员工使用；保存影响新任务和新沟通投递，已有任务不变。` : '保存后可在数字员工中选择。'}认证沿用本机 CLI 登录。</p>
          <div class="form-actions"><button class="primary-button compact" type="submit">${profile ? '保存配置' : '添加配置'}</button>${profile ? '<button type="button" class="small-button" data-test-runtime>测试连接</button>' : ''}${profile ? `<button type="button" class="danger-button compact" data-delete-runtime ${profile.employeeCount ? 'disabled title="请先为使用此配置的员工切换 Runtime（含停用员工）"' : ''}>删除配置</button>` : ''}</div>
          <p role="status" data-runtime-result style="overflow-wrap:anywhere;user-select:text"></p></form>`;
        container.append(card);
        const form = card.querySelector('form'), status = card.querySelector('[data-runtime-result]');
        const modelInput = form.elements.model, effortSelect = form.elements.effort;
        const modelStatus = card.querySelector('[data-model-status]'), effortStatus = card.querySelector('[data-effort-status]');
        const modelOptions = card.querySelector('.model-options');
        let activeOption = -1;
        function closeModels() { modelOptions.hidden = true; modelInput.setAttribute('aria-expanded', 'false'); modelInput.removeAttribute('aria-activedescendant'); activeOption = -1; }
        function showModels(all = false) { syncModel(all); modelOptions.hidden = false; modelInput.setAttribute('aria-expanded', 'true'); }
        function chooseModel(id) { modelInput.value = id; closeModels(); modelInput.dispatchEvent(new Event('input', { bubbles: true })); closeModels(); modelInput.focus(); }
        card.querySelector('.model-picker-toggle').addEventListener('click', () => { if (modelOptions.hidden) { modelInput.focus(); showModels(true); } else closeModels(); });
        modelInput.addEventListener('click', () => showModels(true));
        modelInput.addEventListener('keydown', event => {
          if (event.key === 'Escape') { event.preventDefault(); closeModels(); return; }
          if (event.key === 'Tab') { closeModels(); return; }
          if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
          if (event.key === 'Enter') { if (!modelOptions.hidden && activeOption >= 0) { event.preventDefault(); chooseModel(modelOptions.children[activeOption].dataset.value); } return; }
          event.preventDefault(); if (modelOptions.hidden) showModels();
          const options = [...modelOptions.querySelectorAll('[role="option"]')]; if (!options.length) return;
          activeOption = activeOption < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1) : (activeOption + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          options.forEach((option, index) => option.setAttribute('aria-selected', String(index === activeOption)));
          modelInput.setAttribute('aria-activedescendant', options[activeOption].id); options[activeOption].scrollIntoView({ block: 'nearest' });
        });
        card.addEventListener('focusout', event => { if (!card.querySelector('.runtime-model-picker').contains(event.relatedTarget)) closeModels(); });
        const catalog = { state: 'idle', data: null, error: '', request: 0 };
        const findModel = () => catalog.data?.models?.find(item => item.id === modelInput.value.trim()) || null;
        function syncModel(all = false) {
          modelOptions.replaceChildren(); activeOption = -1; modelInput.removeAttribute('aria-activedescendant');
          const query = all ? "" : modelInput.value.trim().toLowerCase();
          if (catalog.state === 'ok') for (const item of catalog.data.models.filter(item => !query || `${item.id} ${item.label || ''}`.toLowerCase().includes(query))) {
            const option = document.createElement('div'); option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false'); option.id = `${modelListId}-${modelOptions.children.length}`;
            option.dataset.value = item.id; option.textContent = item.id + (item.resolvedTo ? ` → ${item.resolvedTo}` : '');
            option.addEventListener('mousedown', event => event.preventDefault()); option.addEventListener('click', () => chooseModel(item.id)); modelOptions.append(option);
          }
          if (!modelOptions.children.length) { const empty = document.createElement('p'); empty.textContent = catalog.state === 'loading' ? '正在加载…' : catalog.state === 'failed' ? '加载失败，可重试或手工输入' : '无匹配模型，可手工输入'; modelOptions.append(empty); }
          const model = modelInput.value.trim();
          if (catalog.state === 'loading') modelStatus.textContent = '模型列表：正在加载…';
          else if (catalog.state === 'failed') modelStatus.textContent = `模型列表加载失败：${catalog.error}；仍可手工输入模型名。`;
          else if (catalog.state === 'ok' && !catalog.data.models.length) modelStatus.textContent = `模型列表为空（来源：${catalog.data.source}）；可手工输入。`;
          else if (catalog.state === 'ok') {
            const found = findModel();
            modelStatus.textContent = `模型列表（${catalog.data.source}）：${catalog.data.models.length} 个可选，输入即筛选；也可手工输入。` + (model ? found ? `当前值在列表中${found.current ? '，为本机当前生效模型' : ''}。` : '当前值不在列表中（手工输入），可保存；实际可用性以连接测试与真实调用为准。' : '留空使用 CLI 默认模型。');
          } else modelStatus.textContent = '模型列表：尚未加载。';
        }
        function syncEffort(cleared = '') {
          const previous = effortSelect.value;
          const { options, note } = runtimeEffortOptions(form.elements.provider.value, modelInput.value.trim(), catalog.state === 'ok' ? catalog.data : null);
          effortSelect.replaceChildren(...options.map(option => { const element = document.createElement('option'); element.value = option.value; element.textContent = option.label; return element; }));
          if (previous && options.some(option => option.value === previous)) effortSelect.value = previous;
          else if (previous) { effortSelect.value = ''; cleared = '原思考等级不适用于当前模型，已清除；保存前请重新选择。'; }
          effortStatus.textContent = [cleared, note].filter(Boolean).join(' ');
        }        async function loadCatalog() {
          // Sequence every request: a response that returns after the user
          // switched provider/executable or refreshed is stale and must never
          // overwrite the newer list or touch the effort options.
          const request = ++catalog.request;
          catalog.state = 'loading'; catalog.error = ''; syncModel();
          const provider = form.elements.provider.value, executable = form.elements.executable.value.trim();
          try {
            const data = await api(`/api/settings/runtime-profiles/models?provider=${encodeURIComponent(provider)}${executable ? `&executable=${encodeURIComponent(executable)}` : ''}`);
            if (!form.isConnected || request !== catalog.request) return;
            catalog.data = data; catalog.state = 'ok';
          } catch (error) {
            if (!form.isConnected || request !== catalog.request) return;
            catalog.data = null; catalog.error = error.message; catalog.state = 'failed';
          }
          syncModel(); syncEffort();
        }
        card.addEventListener('toggle', () => { if (card.open && catalog.state === 'idle') loadCatalog(); });
        card.querySelector('[data-refresh-models]').addEventListener('click', () => { catalog.state = 'idle'; loadCatalog(); });
        modelInput.addEventListener('input', () => { showModels(); syncEffort(); });
        form.elements.executable.addEventListener('change', () => { if (catalog.state !== 'idle') { catalog.request++; catalog.state = 'idle'; catalog.data = null; if (card.open) loadCatalog(); else { syncModel(); syncEffort(); } } });
        syncModel();
        syncEffort();
        // Setting a select value before its options exist silently no-ops;
        // apply the saved effort only after the option set is built.
        if (value.effort) effortSelect.value = value.effort;
        let dirty = false;
        form.addEventListener('input', () => { dirty = true; status.textContent = '尚未保存；请保存后测试。'; });
        form.elements.provider.addEventListener('change', () => { card.querySelector('[data-cli-profile]').hidden = form.elements.provider.value !== 'codex'; catalog.request++; catalog.state = 'idle'; catalog.data = null; if (card.open) loadCatalog(); else { syncModel(); syncEffort(); } });
        const busy = value => form.querySelectorAll('input,select,button').forEach(control => { control.disabled = value || Boolean(profile && control.name === 'provider') || Boolean(profile?.employeeCount && control.hasAttribute('data-delete-runtime')); });
        form.addEventListener('submit', async event => {
          event.preventDefault(); busy(true);
          const input = Object.fromEntries(['name','provider','model','executable','profile','effort'].map(key => [key, form.elements[key].value.trim()]));
          try {
            const saved = await api(`/api/settings/runtime-profiles${profile ? '/' + encodeURIComponent(profile.id) : ''}`, { method: profile ? 'PUT' : 'POST', body: JSON.stringify(input) });
            if (!form.isConnected) return;
            if (!profile) { await loadRuntimes(); return; }
            card.querySelector('h4').textContent = saved.name;
            dirty = false; status.textContent = '已保存。可测试此配置。';
          } catch (error) { if (form.isConnected) status.textContent = error.message; }
          finally { busy(false); }
        });
        card.querySelector('[data-test-runtime]')?.addEventListener('click', async () => {
          if (dirty) { status.textContent = '请先保存修改，再测试已保存的配置。'; return; }
          busy(true); status.textContent = '正在实际调用模型（最长约 90 秒）…';
          try {
            const result = await api(`/api/settings/runtime-profiles/${encodeURIComponent(profile.id)}/test`, { method: 'POST', body: '{}' });
            if (form.isConnected) status.textContent = `${result.ok ? '连接测试通过：已收到有效模型应答' : result.timedOut ? '连接测试超时' : '连接测试失败'} · ${(result.durationMs / 1000).toFixed(1)} 秒。日志：${result.logPath} · ${result.testId}`;
          } catch (error) { if (form.isConnected) status.textContent = `测试请求失败：${error.message}`; }
          finally { busy(false); }
        });
        card.querySelector('[data-delete-runtime]')?.addEventListener('click', () => {
          openModal(`<h2>删除 Runtime 配置</h2><p>删除「${escape(profile.name)}」？仅移除此配置，不删除 CLI 登录或历史任务。仍被员工引用时服务端会拒绝。</p><div class="form-actions"><button class="ghost-button" data-cancel-runtime-delete>取消</button><button class="danger-button" data-confirm-runtime-delete>删除配置</button></div><p role="alert" data-runtime-delete-error></p>`);
          const confirm = document.querySelector('[data-confirm-runtime-delete]');
          const feedback = document.querySelector('[data-runtime-delete-error]');
          document.querySelector('[data-cancel-runtime-delete]').onclick = closeModal;
          confirm.onclick = async () => {
            confirm.disabled = true;
            try {
              await api(`/api/settings/runtime-profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE', body: '{}' });
              if (confirm.isConnected) closeModal();
              if (container.isConnected && currentPage === 'runtime') await loadRuntimes(); else runtimeLoaded = false;
            } catch (error) { if (confirm.isConnected) { feedback.textContent = error.message; confirm.disabled = false; } }
          };
        });
      }
    } catch (error) { if (container.isConnected) { runtimeLoaded = false; container.innerHTML = `<p role="alert">${escape(error.message)}</p><button class="small-button" data-retry-runtime>重新读取</button>`; } }
  }

  async function loadWorkspace() {
    const container = root.querySelector("[data-workspace-config]");
    workspaceLoaded = true;
    container.innerHTML = '<p role="status">正在读取配置…</p>';
    try {
      const result = await api("/api/settings/workspace");
      if (!container.isConnected) return;
      container.innerHTML = `<form id="workspace-settings-form"><div class="form-field"><label for="default-workspace-root">默认工作目录</label><input id="default-workspace-root" name="workspaceRoot" value="${escape(result.workspaceRoot || "")}" spellcheck="false" required /><p class="field-hint">输入绝对目录，例如 /Users/你的用户名/agentforge。不存在的目录会在保存时自动创建，每个新任务使用独立子目录。</p><div class="field-error" role="alert"></div></div><p class="settings-note">保存后立即用于新建任务，重启后保留。已有任务和交付快照不会迁移；只修改任务工作目录，不改变应用数据位置。</p><div class="form-actions"><button class="primary-button compact" type="submit">保存目录</button><span data-workspace-status role="status"></span></div></form>`;
      const form = container.querySelector("form");
      form.addEventListener("submit", async (event) => {
        event.preventDefault(); clearInvalid(form);
        const button = form.querySelector("button"), status = form.querySelector("[data-workspace-status]");
        button.disabled = true; status.textContent = "";
        try {
          const saved = await api("/api/settings/workspace", { method: "PUT", body: JSON.stringify({ workspaceRoot: form.elements.workspaceRoot.value.trim() }) });
          onWorkspaceSaved(saved);
          if (!form.isConnected) return;
          form.elements.workspaceRoot.value = saved.workspaceRoot;
          status.textContent = "已保存，仅新任务使用此目录。";
        } catch (error) { if (form.isConnected) setInvalid(form.elements.workspaceRoot, error.message); }
        finally { button.disabled = false; }
      });
    } catch (error) {
      if (container.isConnected) container.innerHTML = `<p role="alert">${escape(error.message)}</p><button class="small-button" data-retry-workspace>重新读取</button>`;
    }
  }

  function syncPreferences() {
    if (!root) return;
    const preferences = getPreferences();
    root.querySelectorAll('[name="theme"]').forEach((input) => { input.checked = input.value === preferences.theme; });
    root.querySelectorAll('[name="directoryTheme"]').forEach((input) => { input.checked = input.value === preferences.directoryTheme; });
    root.querySelectorAll("[data-nav-visible]").forEach((input) => { input.checked = !preferences.hiddenViews.includes(input.dataset.navVisible); });
    root.querySelectorAll("[data-display-option]").forEach((input) => { input.checked = preferences[input.dataset.displayOption]; });
  }

  function changePreferences(value) {
    const saved = updatePreferences(value);
    const status = root.querySelector("[data-preferences-status]");
    status.textContent = saved ? "已自动保存到当前客户端。" : "仅本次生效：当前环境无法保存偏好，刷新后可能恢复默认。";
    status.classList.toggle("error", !saved);
    syncPreferences();
  }

  function renderProvider(card, provider) {
    const label = escape(provider.label), id = escape(provider.id);
    card.innerHTML = `<div class="repository-access-card-head"><div><h4>${label}</h4><p>HTTPS · ${escape(provider.host)}</p></div><span class="status-pill ${provider.configured ? "active" : "paused"}">${provider.configured ? "已配置" : "未配置"}</span></div>
      <p class="field-hint">${provider.id === "github" ? "使用具有 Contents: Read 权限的 fine-grained personal access token。" : "使用具有 read_repository 权限的 personal access token。"} 保存后不会显示原值。</p>
      <form class="git-credential-form" novalidate><div class="form-field"><label for="git-token-${id}">${label} Token</label><input id="git-token-${id}" name="token" type="password" autocomplete="new-password" spellcheck="false" placeholder="粘贴新的 Token" /><div class="field-error" role="alert"></div></div><div class="form-actions"><button type="submit" class="primary-button compact">保存 Token</button>${provider.configured ? `<button type="button" class="ghost-button" data-remove-git-token="${id}">移除 Token</button>` : ""}</div></form>`;
    const form = card.querySelector("form");
    const busy = (disabled) => form.querySelectorAll("button").forEach((button) => { button.disabled = disabled; });
    const accept = (result) => {
      if (!card.isConnected) return;
      const updated = result.providers?.find((item) => item.id === provider.id);
      if (updated) renderProvider(card, updated);
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); clearInvalid(form);
      const input = form.elements.token;
      if (!input.value.trim()) { setInvalid(input, "请粘贴要保存的 Token。若要删除已有 Token，请使用移除操作。"); return; }
      busy(true);
      try {
        const result = await api(`/api/runtime/git-credentials/${encodeURIComponent(provider.id)}`, { method: "PUT", body: JSON.stringify({ token: input.value }) });
        input.value = "";
        accept(result);
        notify(`${provider.label} Token 已保存；原值不会回显。`);
      } catch (error) { busy(false); notify(error.message, true); }
    });
    card.querySelector("[data-remove-git-token]")?.addEventListener("click", async () => {
      if (!await confirmDialog({ title: "移除拉取 Token", message: `移除 ${provider.label} 的本机拉取 Token？之后私有 HTTPS 仓库将改用本机 Git 的其他认证方式或无法拉取。`, confirmLabel: "移除 Token", danger: true })) return;
      busy(true);
      try {
        const result = await api(`/api/runtime/git-credentials/${encodeURIComponent(provider.id)}`, { method: "DELETE", body: "{}" });
        inputClear(form); accept(result); notify(`${provider.label} Token 已移除。`);
      } catch (error) { busy(false); notify(error.message, true); }
    });
  }

  function inputClear(container) {
    container.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ""; });
  }

  async function loadRepositories() {
    const content = root.querySelector("#git-credential-config");
    repositoriesLoaded = true;
    content.innerHTML = '<div class="empty-state"><strong>正在读取本机配置</strong>不会回显已保存的 Token。</div>';
    try {
      const configuration = await api("/api/runtime/git-credentials");
      if (!content.isConnected) return;
      content.replaceChildren();
      for (const provider of configuration.providers || []) {
        if (!["github", "gitlab"].includes(provider.id)) continue;
        const card = content.ownerDocument.createElement("section");
        card.className = "repository-access-card"; card.dataset.gitProvider = provider.id;
        content.append(card); renderProvider(card, provider);
      }
      if (!content.children.length) content.innerHTML = '<div class="empty-state"><strong>没有可配置的代码托管平台</strong><button class="small-button" data-retry-repositories>重新读取</button></div>';
    } catch (error) {
      if (content.isConnected) content.innerHTML = `<div class="empty-state"><strong>仓库访问配置读取失败</strong><p>${escape(error.message)}</p><button class="small-button" data-retry-repositories>重新读取</button></div>`;
    }
  }

  function mount(target, page = "general") {
    const host = globalThis.window?.agentforgeDesktop;
    if (root !== target) {
      root = target;
      root.innerHTML = `<div class="settings-layout">
        <nav class="settings-nav" aria-label="设置分类">${Object.entries(SETTINGS_PAGES).map(([id, label]) => `<button type="button" data-settings-page="${id}">${label}</button>`).join("")}</nav>
        <div class="settings-content">
          <section class="settings-section" data-settings-panel="general" hidden>
            <h3>常规</h3><p class="settings-description">此设备上的客户端行为。</p>
            <form data-close-form><fieldset class="settings-radio-group"><legend>关闭主窗口时</legend><label class="settings-radio-option"><input type="radio" name="closeMode" value="quit" disabled /><span><strong>退出程序</strong><small>关闭客户端与它启动的本机后台。</small></span></label><label class="settings-radio-option"><input type="radio" name="closeMode" value="tray" disabled /><span><strong>保留在菜单栏</strong><small>继续运行，可通过 Mac 顶部图标重新打开窗口。</small></span></label></fieldset><p class="field-hint">Cmd+Q 始终退出程序。</p><div class="form-actions"><button class="primary-button compact" type="submit" disabled>保存</button></div></form>
            <p data-close-status role="status">正在读取客户端偏好…</p><button class="small-button" data-close-retry hidden>重试</button>
            <div class="settings-signout"><button type="button" class="ghost-button" id="logout-button">退出登录</button></div>
          </section>
          <section class="settings-section" data-settings-panel="cli" hidden>
            <h3>命令行 CLI</h3><p class="settings-description">在 Shell 中使用 agentforge，供受信任 AI 快速配置工作流、团队、数字员工、插件及 MCP。</p>
            <div class="form-actions"><button type="button" class="primary-button compact" data-cli-install disabled>安装 CLI</button><button type="button" class="small-button" data-cli-refresh>刷新</button></div>
            <p data-cli-status role="status">正在检查 CLI 安装…</p><pre data-cli-paths style="white-space:pre-wrap;overflow-wrap:anywhere;user-select:text"></pre>
            <p class="settings-note">仅 Mac 安装包支持，适用于默认配置目录的 zsh/bash。客户端确认窗口列出将写入的文件；不使用 sudo，不覆盖其他同名命令。安装后新开终端；移动客户端后请重新安装 CLI。自定义 Shell/ZDOTDIR 需手动配置。</p>
            <details><summary>AI 配置 CLI 使用说明</summary><p class="settings-note">先打开客户端，再由操作者登录 CLI；会话与浏览器独立，不读取浏览器 Cookie 或数据库。安装动作不会自动登录。</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere;user-select:text">agentforge help\nagentforge schema agents\nagentforge auth login --username YOUR_NAME</pre><p class="field-hint">无需系统 Node。help / schema 提供字段、依赖顺序和完整 JSON 模板；源码使用 npm --silent run cli -- help。交互登录隐藏输入密码；脚本显式使用 --password-stdin 管道，不放在命令参数。配置保存不等于任务执行，不能自动确认交付。CLI 会话是本机管理员权限，只交给可信 AI。</p></details>
          </section>
          <section class="settings-section" data-settings-panel="plugins" hidden>
            <h3>插件更新</h3><p class="settings-description">自动检查已安装 Git 插件；仅在 AgentForge 服务运行时生效。</p>
            <form data-plugin-update-form><label class="settings-check"><input type="checkbox" name="enabled" aria-label="插件自动更新" disabled>启用自动更新</label><div class="form-field plugin-update-interval"><label for="plugin-update-interval">检查周期（分钟）</label><input id="plugin-update-interval" type="number" name="intervalMinutes" min="1" max="1440" step="1" required disabled><p class="field-hint">默认 2 分钟，范围 1–1440 分钟。</p></div><div class="form-actions"><button type="submit" class="primary-button compact" disabled>保存</button><button type="button" class="small-button" data-check-plugin-updates disabled>立即检查</button></div><p data-plugin-update-note role="status"></p></form>
            <p data-plugin-update-status role="status">正在读取…</p><p class="settings-note">关闭自动更新后仍可立即检查；已开始的检查继续完成。本地目录与固定 SHA 不追随远端更新，不更新 MCP 或应用本身。当前员工使用新版本，已启动任务保留冻结配置。</p>
          </section>
          <section class="settings-section" data-settings-panel="logs" hidden>
            <h3>运行日志</h3><p class="settings-description">任务、私聊、群聊与本机服务的详细诊断写入本机文件，此处只显示路径。</p>
            <p class="settings-note">找不到 CLI 时，在日志文件中搜索 provider.launch_diagnostic：包含实际 PATH、目录与可执行文件检查，以及逐项排查建议。原始错误在同次调用的 provider.spawn_error / provider.stderr 中。</p><dl class="runtime-details"><div><dt>日志目录</dt><dd data-log-directory style="overflow-wrap:anywhere;user-select:text">正在读取…</dd></div><div><dt>当前服务日志</dt><dd data-log-file style="overflow-wrap:anywhere;user-select:text">正在读取…</dd></div></dl>
            <button class="small-button" data-logs-refresh>刷新路径</button><p data-log-status role="status">正在读取…</p>
            <p class="settings-note">JSONL 格式，保留错误原文、堆栈、进程退出信息及脱敏诊断输出。每进程独立文件，10 MiB 分卷，不自动删除旧卷；默认位于 ~/.agentforge/logs/&lt;实例标识&gt;，由操作者手工清理。请在运行服务的机器上打开此路径，分享日志前检查敏感内容。旧版本未保存的错误无法恢复。</p>
          </section>
          <p class="settings-save-status" data-preferences-status role="status">外观和展示偏好自动保存在当前客户端。</p>
          <section class="settings-section" data-settings-panel="appearance" aria-labelledby="appearance-title">
            <h3 id="appearance-title">界面主题</h3><p class="settings-description">外观偏好保存在当前客户端；客户端使用独立的管理工作台布局。</p>
            <fieldset class="theme-options"><legend class="visually-hidden">界面主题</legend>${[
              ["warm", "暖白", "暖色浅底与柔和层次。"],
              ["minimal", "极简", "平面层次、克制圆角与清晰的管理界面。"],
            ].map(([id, label, description]) => `<label class="theme-option"><input type="radio" name="theme" value="${id}" /><span class="theme-preview ${id}" aria-hidden="true"><i></i><span><b></b><em></em><em></em></span></span><strong>${label}</strong><small>${description}</small></label>`).join("")}</fieldset>
            <hr class="settings-divider" />
            <h3 id="directory-theme-title">工作目录主题</h3><p class="settings-description">只影响任务空间「工作目录」页签的文件树图标与选中文件的内容配色；交付快照、控制台、协作记录和其他页面不受影响。图标来自 vscode-icons（MIT）。</p>
            <fieldset class="theme-options"><legend class="visually-hidden">工作目录主题</legend>${DIRECTORY_THEMES.map((theme) => `<label class="theme-option directory-theme-option"><input type="radio" name="directoryTheme" value="${theme.id}" /><strong>${escape(theme.label)}</strong><small>${escape(theme.description)}</small></label>`).join("")}</fieldset>
            <hr class="settings-divider" />
            <div class="settings-section-heading"><h3 id="navigation-title">侧栏展示</h3><button type="button" class="small-button" data-reset-navigation>恢复默认展示</button></div>
            <p class="settings-description">选择侧栏中保留的入口。设置始终显示，隐藏入口不影响已有页面链接、任务执行或访问权限。</p>
            <div class="navigation-options">${["OPERATIONS", "BUILD", "REFERENCE"].map((group) => `<fieldset><legend>${group}</legend>${NAVIGATION.filter((item) => item.group === group).map(({ id, label }) => `<label class="settings-toggle"><span>${label}</span><input type="checkbox" data-nav-visible="${id}" aria-label="显示${label}" /></label>`).join("")}</fieldset>`).join("")}</div>
            <h4 class="settings-subheading">导航细节</h4>${[
              ["showGroups", "分组标题", "OPERATIONS / BUILD / REFERENCE；空分组自动隐藏。"],
              ["showIcons", "导航图标", "宽屏按偏好显示；窄窗口仍保留图标，方便识别入口。"],
              ["showCounts", "任务待处理提醒", "只显示待你回复、验收或处理的任务数；零值不显示。"],
              ["showUnread", "沟通未读提醒", "显示员工新回复的未读数；看到会话最新记录后清零。"],
            ].map(([id, label, hint]) => `<label class="settings-toggle"><span><strong>${label}</strong><small>${hint}</small></span><input type="checkbox" data-display-option="${id}" aria-label="显示${label}" /></label>`).join("")}
          </section>
          <section class="settings-section" data-settings-panel="repositories" aria-labelledby="repositories-title" hidden>
            <h3 id="repositories-title">仓库访问</h3><p class="settings-description">为 GitHub / GitLab 私有 HTTPS 仓库保存本机拉取 Token。仓库地址与分支仍在研发数字员工中绑定。</p>
            <div class="repository-access-boundary"><strong>仓库读取凭据</strong><span>此 Token 用于 clone/fetch；数字员工的其他操作由本机用户及其现有 Git 凭据执行。Token 不进入仓库 URL、任务、提示词、Artifact 或审计。</span></div>
            <div id="git-credential-config" class="repository-access-grid" aria-live="polite"></div>
          </section>
          <section class="settings-section" data-settings-panel="workspace" aria-labelledby="workspace-settings-title" hidden>
            <h3 id="workspace-settings-title">任务工作目录</h3><p class="settings-description">仅管理后续任务的文件存放位置，不改变应用数据位置。配置、鉴权、插件和应用缓存默认保存在 ~/.agentforge 下。</p>
            <div data-workspace-config></div>
            <hr class="settings-divider" />
            <h3 id="data-management-title">数据管理</h3><p class="settings-description">清除工作区数据，回到首次使用状态。</p><p class="settings-note">包含账号与会话、任务与沟通、数字员工与团队、工作流、Runtime、插件与 MCP 配置、仓库 Token、交付文件、系统创建的任务目录和当前实例诊断日志。外部已有项目及本机 CLI 登录与会话保留。旧版共用日志不自动删除。</p><button type="button" class="danger-button" data-reset-all>清除所有数据</button>
          </section>
          <section class="settings-section" data-settings-panel="runtime" aria-labelledby="runtime-title" hidden>
            <h3 id="runtime-title">Runtime</h3><p class="settings-description">统一管理执行配置，数字员工只选择配置。展开连接后编辑或测试；未使用的配置可删除。测试会实际调用模型，可能消耗已登录账号的额度；不加载员工技能或 MCP。</p>
            <div class="repository-access-grid" data-runtime-config></div>
          </section>
        </div></div>`;
      const layout = root.firstElementChild;
      closePreferenceUI = createClosePreferenceUI(root.querySelector('[data-settings-panel="general"]'), globalThis.window?.agentforgeDesktop);
      pluginUpdateUI = createPluginUpdateSettingsUI(root.querySelector('[data-settings-panel="plugins"]'), api);
      const cliPanel = root.querySelector('[data-settings-panel="cli"]');
      cliInstallationUI = createCliInstallationUI(cliPanel, host);
      globalThis.window?.addEventListener("focus", refreshHostSettings);
      layout.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (button?.hasAttribute("data-reset-all")) confirmDataReset();
        if (button?.dataset.settingsPage) navigate(button.dataset.settingsPage);
        if (button?.hasAttribute("data-logs-refresh")) loadLogs();
        if (button?.hasAttribute("data-retry-repositories")) loadRepositories();
        if (button?.hasAttribute("data-retry-workspace")) loadWorkspace();
        if (button?.hasAttribute("data-retry-runtime")) loadRuntimes();
        if (button?.hasAttribute("data-reset-navigation")) {
          const defaults = normalizePreferences(null);
          changePreferences({ ...getPreferences(), hiddenViews: defaults.hiddenViews, showGroups: defaults.showGroups, showIcons: defaults.showIcons, showCounts: defaults.showCounts, showUnread: defaults.showUnread });
        }
      });
      layout.addEventListener("change", (event) => {
        const input = event.target, preferences = getPreferences();
        if (input.name === "theme") changePreferences({ ...preferences, theme: input.value });
        if (input.name === "directoryTheme") changePreferences({ ...preferences, directoryTheme: input.value });
        if (input.dataset.navVisible) changePreferences({ ...preferences, hiddenViews: input.checked ? preferences.hiddenViews.filter((id) => id !== input.dataset.navVisible) : [...preferences.hiddenViews, input.dataset.navVisible] });
        if (input.dataset.displayOption) changePreferences({ ...preferences, [input.dataset.displayOption]: input.checked });
      });
    }
    syncPreferences();
    root.querySelectorAll("[data-settings-page]").forEach((button) => {
      const selected = button.dataset.settingsPage === page;
      button.classList.toggle("active", selected);
      if (selected) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    });
    root.querySelectorAll("[data-settings-panel]").forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== page; });
    if (currentPage !== page) {
      pluginUpdateUI?.pause();
      ++logRequest; currentPage = page;
      refreshHostSettings();
      if (page === "logs") loadLogs();
    }
    if (page === "repositories" && !repositoriesLoaded) loadRepositories();
    if (page === "workspace" && !workspaceLoaded) loadWorkspace();
    if (page === "runtime" && !runtimeLoaded) loadRuntimes();
    root.querySelector("[data-preferences-status]").hidden = page !== "appearance";
  }

  function unmount() {
    globalThis.window?.removeEventListener("focus", refreshHostSettings);
    closePreferenceUI?.dispose(); closePreferenceUI = null;
    cliInstallationUI?.dispose(); cliInstallationUI = null;
    pluginUpdateUI?.dispose(); pluginUpdateUI = null;
    ++logRequest;
    currentPage = null;
    if (root) { inputClear(root); root.replaceChildren(); }
    root = null; repositoriesLoaded = false; workspaceLoaded = false; runtimeLoaded = false;
  }
  return { mount, unmount, syncPreferences };
}
