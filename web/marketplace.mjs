import { paginate, paginationMarkup } from './pagination.mjs';

export function extensionAvatarColor(id) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return ['violet', 'cyan', 'amber', 'blue', 'green'][hash % 5];
}

const providerLabel = value => value==='codex'?'Codex':'Claude Code';
const supportReason=(item,provider)=>item.compatibility?.[provider]?.reasons?.join('；') || '此插件的组件与当前 Runtime 不兼容';
const runtimeBadges=(item,esc)=>`<span class="extension-runtime-badges">${['claude-code','codex'].map(provider=>`<span class="runtime-support" data-supported="${item.providers.includes(provider)}" title="${esc(item.providers.includes(provider)?'组件静态兼容；依赖与账号需在实际执行时验证':supportReason(item,provider))}">${providerLabel(provider)} · ${item.providers.includes(provider)?'支持':'不兼容'}</span>`).join('')}</span>`;
const components = (plugin,esc,key) => `<section class="plugin-detail-section">${plugin.components?.[key]?.length ? plugin.components[key].map(item=>`<div class="plugin-detail-component"><strong>${esc(item.name || item.event)}</strong>${item.providers?`<small class="component-runtimes">${esc(item.providers.map(providerLabel).join(' / '))}</small>`:''}${item.description?`<p>${esc(item.description)}</p>`:''}${item.path?`<code>${esc(item.path)}</code>`:''}${item.matchers?`<pre>${esc(JSON.stringify(item.matchers,null,2))}</pre>`:''}</div>`).join(''):'<p class="empty-state">未包含此类组件</p>'}</section>`;

function marketUI({api,esc,openModal,closeModal,confirmDialog,toast},kind) {
  let root=null,items=[],query='',pageNumber=1,loaded=false,readError='';
  const plugin=kind==='plugin', path=plugin?'/api/runtime/marketplace':'/api/runtime/mcp-marketplace', label=plugin?'插件':'MCP';
  function rows() {
    if(!root?.isConnected) return;
    const page=paginate(items.filter(item=>`${item.name} ${item.description || ''}`.toLowerCase().includes(query.trim().toLowerCase())),pageNumber);pageNumber=page.page;
    const list=root.querySelector('[data-market-list]'),empty=root.querySelector('[data-market-empty]');
    if(!loaded){list.hidden=true;list.innerHTML='';empty.hidden=false;empty.setAttribute('role',readError?'alert':'status');empty.textContent=readError || '正在读取已安装项…';root.querySelector('[data-market-pager]').innerHTML='';return;}
    list.hidden=!page.items.length;empty.hidden=Boolean(page.items.length);empty.setAttribute('role','status');
    empty.textContent=query?'没有匹配项':`尚未安装${label}，可手动安装后在员工中选择。`;
    list.innerHTML=page.items.map(item=>`<article class="agent-card installed-extension-card"><div class="extension-card-heading"><span class="agent-card-avatar extension-avatar color-${extensionAvatarColor(item.id)}" aria-hidden="true">${esc([...item.name].slice(0,2).join('').toUpperCase())}</span><button type="button" class="text-action extension-name" data-extension-detail="${esc(item.id)}">${esc(item.name)}</button></div><p class="extension-card-description">${esc(item.description || '未填写说明')}</p><div class="extension-card-meta"><span>${esc(item.version || item.id.slice(0,8))}</span>${runtimeBadges(item,esc)}</div><div class="directory-card-actions"><button type="button" class="small-button" data-extension-detail="${esc(item.id)}">详情</button></div></article>`).join('');
    root.querySelector('[data-market-pager]').innerHTML=paginationMarkup(page,plugin?'marketplace':'mcp');
  }
  async function load() {
    if(!root?.isConnected)return;
    const target=root;
    loaded=false;readError='';rows();
    try {const result=await api(path);if(root!==target || !target.isConnected)return;items=plugin?result.plugins:result.entries;loaded=true;rows();}
    catch(error) {if(root===target){readError=error.message;rows();}}
  }
  async function detail(id,errorMessage='') {
    if(!root?.isConnected)return;
    openModal(`<h2>${label}详情</h2><p class="modal-intro field-error" role="alert" data-extension-delete-error>${esc(errorMessage)}</p><div data-extension-detail-body role="status">正在读取…</div><div class="form-actions">${plugin?'':'<button type="button" class="small-button" data-edit-mcp disabled>编辑</button>'}<button type="button" class="small-button danger" data-delete-extension>删除</button><button type="button" class="ghost-button" data-close-modal>关闭</button></div>`);
    const target=document.querySelector('[data-extension-detail-body]');
    target.closest('.modal').classList.add('extension-detail-modal');
    target.closest('.modal').querySelector('[data-close-modal]').focus();
    const entry=items.find(item=>item.id===id);
    document.querySelector('[data-delete-extension]').onclick=async event=>{
      const view=root;
      event.currentTarget.disabled=true;
      const accepted=await confirmDialog({title:`删除${label}`,message:`从已安装列表删除「${entry?.name || label}」？正在被员工使用时不能删除；历史任务所需文件保留。${plugin?'独立安装的 MCP 不受影响。':''}`,confirmLabel:`删除${label}`,danger:true});
      if(root!==view || !view.isConnected)return;
      if(!accepted){if(!document.querySelector('#modal-content').childElementCount){await detail(id);document.querySelector('[data-delete-extension]')?.focus();}return;}
      try {await api(`${path}/${encodeURIComponent(id)}`,{method:'DELETE',body:'{}'});toast(`${label}已删除。`);await load();}
      catch(error){if(root===view && !document.querySelector('#modal-content').childElementCount)await detail(id,error.message);else toast(error.message,true);}
    };
    try {
      const item=await api(`${path}/${encodeURIComponent(id)}`);if(!target.isConnected)return;
      if(!plugin){const edit=target.closest('.modal').querySelector('[data-edit-mcp]');edit.disabled=false;edit.onclick=()=>installMcp(item);}
      target.removeAttribute('role');
      target.innerHTML=`<div class="extension-detail-overview"><span class="agent-card-avatar extension-avatar color-${extensionAvatarColor(item.id)}" aria-hidden="true">${esc([...item.name].slice(0,2).join('').toUpperCase())}</span><div><h3>${esc(item.name)}</h3><p>${esc(item.description || '')}</p><p class="field-hint">${esc(item.providers.map(providerLabel).join(' / '))}${item.source?` · ${esc(item.source.url)}`:''}</p></div></div>${plugin?`<div class="plugin-detail-tabs" role="tablist" aria-label="插件组件">${['skills','agents','hooks'].map((key,index)=>`<button type="button" role="tab" id="plugin-tab-${key}" aria-controls="plugin-component-panel" aria-selected="${index===0}" tabindex="${index===0?0:-1}" data-plugin-tab="${key}">${['Skill','Subagent','Hook'][index]} <span>${item.components[key].length}</span></button>`).join('')}</div><div id="plugin-component-panel" role="tabpanel" aria-labelledby="plugin-tab-skills" tabindex="0">${components(item,esc,'skills')}</div>`:`<pre class="mcp-json-detail">${esc(JSON.stringify(item.configuration,null,2))}</pre><p class="field-hint">${item.redacted?'配置中的鉴权值已隐藏。':''}原始 JSON 保存在本机私有配置目录，列表不携带此配置。</p>`}`;
      if(plugin){
        target.querySelector('.extension-detail-overview').insertAdjacentHTML('afterend',`<div class="plugin-runtime-compatibility">${runtimeBadges(item,esc)}${['claude-code','codex'].filter(provider=>!item.providers.includes(provider)).map(provider=>`<p class="field-hint">${providerLabel(provider)}：${esc(supportReason(item,provider))}</p>`).join('')}<p class="field-hint">支持表示组件静态兼容，不代表本机 CLI、依赖或账号已通过实际执行验证。</p></div>`);
        const tabs=[...target.querySelectorAll('[data-plugin-tab]')];const select=button=>{tabs.forEach(tab=>{tab.setAttribute('aria-selected',String(tab===button));tab.tabIndex=tab===button?0:-1;});const panel=target.querySelector('[role=tabpanel]');panel.setAttribute('aria-labelledby',button.id);panel.innerHTML=components(item,esc,button.dataset.pluginTab);};tabs.forEach((button,index)=>{button.onclick=()=>select(button);button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];select(next);next.focus();};});}
    } catch(error) {if(target.isConnected) {target.setAttribute('role','alert');target.textContent=error.message;}}
  }
  function installMcp(item) {
    if(item instanceof Event)item=null;
    const editing=Boolean(item),action=editing?'保存修改':'安装 MCP';
    openModal(`<h2>${editing?'编辑':'安装'} MCP</h2><p class="modal-intro">${editing?'保存为新版本并更新当前员工的选择；已启动任务和排队调用保持原配置。隐藏值保持原样即可保留，删除字段可清除。':'导入一个 MCP Server 的 JSON。同一安装名称再次导入会覆盖并更新当前员工选择，历史任务不变；首次安装不会自动绑定员工。'}</p><form id="mcp-market-form"><div class="form-field"><label>名称<input name="name" required maxlength="80"></label></div><div class="form-field"><label>说明<input name="description" maxlength="500"></label></div><div class="form-field"><label>MCP JSON<textarea name="content" rows="6" required spellcheck="false" autocomplete="off" placeholder='{"mcpServers":{"service":{"type":"streamableHttp","url":"https://example.com/mcp"}}}'></textarea></label></div><p class="field-hint">支持 stdio、SSE、Streamable HTTP；Claude Code 和 Codex 均可选择。不会安装依赖或修改全局 CLI。</p><p role="alert" data-market-error></p><div class="form-actions"><button type="button" class="ghost-button" data-close-modal>取消</button><button class="primary-button" type="submit">${action}</button></div></form>`);
    const form=document.querySelector('#mcp-market-form');
    if(editing){form.elements.name.value=item.name;form.elements.description.value=item.description || '';form.elements.content.value=JSON.stringify(item.configuration,null,2);}
    form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;
      try {const result=await api(editing?`${path}/${encodeURIComponent(item.id)}`:path,{method:editing?'PUT':'POST',body:JSON.stringify({name:form.elements.name.value,description:form.elements.description.value,content:form.elements.content.value})});if(form.isConnected)closeModal();toast(editing?'MCP 已更新，历史任务配置保持不变。':result.replacements?.length?`MCP 已覆盖，已更新 ${result.employees.length} 位员工；历史配置保留。`:'MCP 已安装，尚未绑定员工。');await load();}
      catch(error) {if(form.isConnected){form.querySelector('[data-market-error]').textContent=error.message;button.disabled=false;}}
    };
  }
  function installPlugin() {
    openModal(`<h2>手动安装插件</h2><p class="modal-intro">安装来源中的全部插件。同一来源与名称再次导入会覆盖并更新当前员工选择，历史任务不变。自带 MCP 单独入市场，按安装名称覆盖，不会随插件启用。</p><form id="market-entry-form"><fieldset class="source-type"><legend>来源类型</legend><label><input type="radio" name="sourceType" value="git" checked>Git 仓库</label><label><input type="radio" name="sourceType" value="local">本地目录</label></fieldset><div class="form-field"><label for="market-source">来源地址</label><input id="market-source" name="source" required autocomplete="off" spellcheck="false" placeholder="https://github.com/owner/plugins.git"></div><p class="field-hint">支持 Claude、Codex 和 Agent Plugins 清单；不执行安装脚本，不安装依赖。</p><p role="alert" data-market-error></p><div class="form-actions"><button type="button" class="ghost-button" data-close-modal>取消</button><button type="submit" class="primary-button">安装全部插件</button></div></form>`);
    const form=document.querySelector('#market-entry-form'),submit=form.querySelector('[type=submit]'),errorBox=form.querySelector('[data-market-error]');
    form.querySelectorAll('[name=sourceType]').forEach(input=>input.onchange=()=>{form.elements.source.placeholder=input.value==='local'?'/absolute/path/to/plugins':'https://github.com/owner/plugins.git';});
    form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;submit.textContent='正在安装…';errorBox.textContent='';
      try {const result=await api(path,{method:'POST',body:JSON.stringify({[form.elements.sourceType.value==='local'?'path':'url']:form.elements.source.value.trim()})});if(form.isConnected)closeModal();toast(`已安装 ${result.plugins.length} 个插件${result.mcps.length?'，另拆分 '+result.mcps.length+' 个 MCP':''}${result.replacements?.length?'；覆盖 '+result.replacements.length+' 个已有版本，更新 '+result.employees.length+' 位员工；历史配置保留。':'，尚未绑定员工。'}`);await load();}
      catch(error){if(form.isConnected){errorBox.textContent=error.message;submit.disabled=false;submit.textContent='安装全部插件';}}
    };
  }
  return {
    mount(target){if(root===target)return;root=target;
      root.innerHTML=`<div class="page-heading"><div><h2>${label}市场</h2><p>已安装${label} · 按员工独立选择使用</p></div></div><div class="directory-toolbar"><input type="search" aria-label="搜索${label}" placeholder="搜索"><button class="primary-button" ${plugin?'data-install-plugin':'data-add-mcp'}>手动安装${label}</button></div><p class="field-hint">在线市场浏览暂未开放，可通过手动安装添加。</p><div data-market-list hidden aria-live="polite"></div><div class="market-directory-empty" data-market-empty role="status">正在读取已安装项…</div><div data-market-pager></div>`;
      root.querySelector('input').value=query;root.querySelector('input').oninput=event=>{query=event.target.value;pageNumber=1;rows();};
      root.querySelector('[data-market-pager]').onclick=event=>{const button=event.target.closest('[data-page]');if(button){pageNumber=Number(button.dataset.page);rows();}};
      root.querySelector(plugin?'[data-install-plugin]':'[data-add-mcp]').onclick=plugin?installPlugin:installMcp;
      root.querySelector('[data-market-list]').onclick=event=>{const button=event.target.closest('[data-extension-detail]');if(button)void detail(button.dataset.extensionDetail);};void load();
    },
    unmount(){root=null;}
  };
}
export const createMcpMarketplaceUI = options => marketUI(options,'mcp');
export function createMarketplaceUI(options) {
  const {api,esc}=options;
  return {...marketUI(options,'plugin'),select(target,runtime,provider){
    const selected={plugin:new Set(runtime.extensionSelection?.pluginIds || []),mcp:new Set(runtime.extensionSelection?.mcpIds || [])};
    let catalogs={plugin:[],mcp:[]},loaded=false,currentProvider=provider;
    const painters=[];
    target.innerHTML=['plugin','mcp'].map(kind=>`<div class="extension-picker" data-picker="${kind}"><label for="employee-${kind}-search">${kind==='plugin'?'插件':'MCP'}</label><div class="extension-picker-search"><input id="employee-${kind}-search" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="employee-${kind}-options" autocomplete="off" placeholder="搜索并添加${kind==='plugin'?'插件':'MCP'}"><div class="extension-picker-options" id="employee-${kind}-options" role="listbox" hidden></div></div><div class="extension-picked"></div></div>`).join('')+'<p class="field-hint" data-selection-state>正在读取已安装插件与 MCP…</p>';
    function setup(kind){
      const picker=target.querySelector(`[data-picker="${kind}"]`),search=picker.querySelector('.extension-picker-search'),input=picker.querySelector('input'),list=picker.querySelector('[role=listbox]'),chips=picker.querySelector('.extension-picked');
      const close=(restoreFocus=false)=>{if(restoreFocus && list.contains(document.activeElement))input.focus({preventScroll:true});list.hidden=true;input.setAttribute('aria-expanded','false');};
      function paint(){
        const found=catalogs[kind].filter(item=>!selected[kind].has(item.id) && `${item.name} ${item.description}`.toLowerCase().includes(input.value.toLowerCase())).slice(0,20);
        list.innerHTML=found.map(item=>`<button type="button" role="option" aria-selected="false" data-add-extension="${esc(item.id)}" ${item.providers.includes(currentProvider)?'':`disabled title="${esc(supportReason(item,currentProvider))}"`}><strong>${esc(item.name)}</strong><small>${esc(item.description || '')}</small>${runtimeBadges(item,esc)}${item.providers.includes(currentProvider)?'':`<small>${esc(supportReason(item,currentProvider))}</small>`}</button>`).join('') || `<p class="field-hint">${loaded?'没有可添加的匹配项':'正在读取…'}</p>`;
        chips.innerHTML=[...selected[kind]].map(id=>{const item=catalogs[kind].find(item=>item.id===id),incompatible=item && !item.providers.includes(currentProvider);return `<span class="extension-chip" data-incompatible="${Boolean(incompatible)}">${esc(item?.name || '未安装版本 '+id.slice(0,8))}${incompatible?'<small>Runtime 不兼容</small>':''}<button type="button" data-remove-extension="${esc(id)}" aria-label="移除${esc(item?.name || id)}">×</button></span>`;}).join('') || '<span class="field-hint">未选择</span>';
      }
      const open=()=>{paint();list.hidden=false;input.setAttribute('aria-expanded','true');};
      input.onfocus=open;input.oninput=open;input.onclick=open;
      input.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}if(event.key==='ArrowDown'){event.preventDefault();input.onfocus();list.querySelector('button:not(:disabled)')?.focus();}};
      list.onkeydown=event=>{const buttons=[...list.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}};
      list.onclick=event=>{const button=event.target.closest('[data-add-extension]');if(!button || button.disabled)return;selected[kind].add(button.dataset.addExtension);input.value='';paint();input.focus();close();};
      chips.onclick=event=>{const button=event.target.closest('[data-remove-extension]');if(button){selected[kind].delete(button.dataset.removeExtension);paint();input.focus();close();}};
      picker.addEventListener('focusout',event=>{if(!search.contains(event.relatedTarget))close();});
      // Keep the input-to-options gap inside the picker; touch and keyboard
      // selection must not be cancelled by mouse-only hover dismissal.
      picker.onpointerleave=event=>{if(event.pointerType==='mouse')close(true);};
      (target.closest('form') || target).addEventListener('pointerdown',event=>{if(!picker.contains(event.target))close(true);});
      painters.push(paint);paint();
    }
    setup('plugin');setup('mcp');
    Promise.all([api('/api/runtime/marketplace'),api('/api/runtime/mcp-marketplace')]).then(([plugins,mcps])=>{if(!target.isConnected)return;catalogs={plugin:plugins.plugins,mcp:mcps.entries};loaded=true;painters.forEach(paint=>paint());target.querySelector('[data-selection-state]').textContent=runtime.extensionSelection?.skillIds?.length?'单 Skill 选择已移除，请重新选择完整插件后保存。':'插件和 MCP 只属于此员工，历史任务不变。';}).catch(error=>{if(target.isConnected)target.querySelector('[data-selection-state]').textContent=`扩展读取失败：${error.message}`;});
    return {provider(value){currentProvider=value;painters.forEach(paint=>paint());},value(){if(!loaded)throw new Error('扩展尚未读取成功，请关闭后重试');for(const kind of ['plugin','mcp'])for(const id of selected[kind]){const item=catalogs[kind].find(item=>item.id===id);if(!item)throw new Error('已选版本未安装，请移除后重新安装选择');if(!item.providers.includes(currentProvider))throw new Error(`「${item.name}」与 ${providerLabel(currentProvider)} 不兼容：${supportReason(item,currentProvider)}`);}return {pluginIds:[...selected.plugin],mcpIds:[...selected.mcp]};}};
  }};
}
