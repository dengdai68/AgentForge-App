// Isolated UI/API/CLI acceptance. No real model calls or operator instance writes.
import{mkdtemp,mkdir,writeFile}from'node:fs/promises';import{resolve,join}from'node:path';import{randomBytes}from'node:crypto';import{_electron as electron}from'playwright-core';import{createAuth}from'../server/auth.mjs';import assert from'node:assert/strict';
const packaged=process.env.AGENTFORGE_MCP_EDIT_APP;
const root=await mkdtemp(resolve('.data/mcp83-ui-'));await mkdir(join(root,'home'));const password=randomBytes(16).toString('hex');const auth=createAuth({databasePath:(packaged?join(root,'home/.agentforge/desktop/auth.sqlite'):join(root,'auth.sqlite'))});await auth.setAdministrator('edit-qa',password);auth.close();
const app=await electron.launch({...(packaged?{executablePath:resolve(packaged,'Contents/MacOS/AgentForge')}:{}),args:packaged?[]:['apps/electron/main.mjs'],env:{...process.env,HOME:join(root,'home'),AGENTFORGE_DESKTOP_DATA_ROOT:root},timeout:90000});
try{
const page=await app.firstWindow({timeout:90000});await page.waitForURL(/^http:\/\/127\.0\.0\.1:/,{timeout:60000});const origin=new URL(page.url()).origin;
await page.goto(origin+'/login');await page.locator('#username').fill('edit-qa');await page.locator('#password').fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('#account-name').waitFor();await page.goto(origin+'/teams');await page.getByText('还没有团队',{exact:true}).waitFor();console.log('TEAM_EMPTY',await page.locator('#teams-grid').innerText());await page.screenshot({path:join(root,'teams.png')});
await page.goto(origin+'/mcp-marketplace');await page.locator('[data-add-mcp]').click();await page.locator('[name=name]').fill('知识库');await page.locator('[name=description]').fill('初始说明');await page.locator('[name=content]').fill(JSON.stringify({mcpServers:{knowledge:{type:'http',url:'http://127.0.0.1:9999/mcp',headers:{Authorization:'Bearer fixture-secret'}}}}));await page.locator('#mcp-market-form [type=submit]').click();await page.locator('#mcp-market-form').waitFor({state:'detached'});await page.locator('[data-extension-detail]').first().click();await page.locator('.mcp-json-detail').waitFor();console.log('EDIT_BUTTONS',await page.getByRole('button',{name:'编辑',exact:true}).count());await page.screenshot({path:join(root,'mcp.png')});console.log('EVIDENCE',root);
{
assert.equal(await page.getByRole('button',{name:'编辑',exact:true}).count(),1);
await page.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('[name=name]').fill('编辑后的知识库');await page.locator('[name=content]').fill('invalid');await page.locator('#mcp-market-form [type=submit]').click();await page.locator('[data-market-error]').filter({hasText:/./}).waitFor();assert.equal(await page.locator('[name=name]').inputValue(),'编辑后的知识库');
await page.locator('[name=content]').fill(JSON.stringify({mcpServers:{knowledge:{type:'sse',url:'http://127.0.0.1:9999/events',headers:{Authorization:'[REDACTED]'}}}}));await page.locator('#mcp-market-form [type=submit]').click();await page.locator('#mcp-market-form').waitFor({state:'detached'});await page.locator('[data-extension-detail]').first().click();await page.locator('.mcp-json-detail').waitFor();assert.ok((await page.locator('.mcp-json-detail').innerText()).includes('/events'));assert.ok(!(await page.locator('.mcp-json-detail').innerText()).includes('fixture-secret'));
await page.setViewportSize({width:760,height:600});await page.getByRole('button',{name:'编辑',exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(root,'edit-narrow.png')});await page.getByRole('button',{name:'取消',exact:true}).click();
const api=async(path,body,method=body?'POST':'GET')=>page.evaluate(async({path,body,method})=>{const r=await fetch(path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()}},{path,body,method});
const installed=(await api('/api/runtime/mcp-marketplace')).data.entries[0], profile=(await api('/api/settings/runtime-profiles')).data.profiles.find(p=>p.provider==='claude-code');
const employee=(await api('/api/agents',{name:'绑定编辑验证',runtime:{profileId:profile.id,extensionSelection:{pluginIds:[],mcpIds:[installed.id]}}})).data.agent;assert.ok(employee?.id);
await writeFile(join(root,'endpoint.json'),JSON.stringify({origin,instanceId:(await api('/api/health')).data.instanceId}),{mode:0o600});
const {spawn}=await import('node:child_process');
const cli=(args,input='')=>new Promise((done,reject)=>{const c=spawn(process.execPath,['cli/main.mjs',...args,'--json','--endpoint-file',join(root,'endpoint.json'),'--session-file',join(root,'cli/session.json')]);let stdout='',stderr='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);c.once('error',reject);c.once('close',code=>{if(code!==0)reject(Error(stderr||stdout));else done(JSON.parse(stdout).data)});c.stdin.end(input)});
await cli(['auth','login','--username','edit-qa','--password-stdin'],password+'\n');const saved=await cli(['mcps','update',installed.id,'--file','-'],JSON.stringify({description:'CLI 实际更新'}));assert.equal(saved.previousId,installed.id);assert.ok(saved.employees.some(e=>e.id===employee.id));assert.ok(!JSON.stringify(saved).includes('fixture-secret'));
const agents=(await api('/api/agents')).data.agents;assert.deepEqual(agents.find(a=>a.id===employee.id).runtime.extensionSelection.mcpIds,[saved.id]);assert.equal((await api('/api/runtime/mcp-marketplace/'+installed.id, {name:'过期'},'PUT')).status,404);
const refused=await api('/api/runtime/mcp-marketplace/'+saved.id,{content:JSON.stringify({mcpServers:{knowledge:{command:'node',cwd:root}}})},'PUT');assert.equal(refused.status,400);assert.equal((await api('/api/runtime/mcp-marketplace')).data.entries.length,1);
console.log('PASS actual CLI/API rebind/incompatible/stale/secret checks',root);
// Repeat imports share the same authenticated command across UI and CLI.
await api('/api/runtime/marketplace/updates/settings',{enabled:false},'PUT');
for(const size of [{width:1280,height:850},{width:760,height:600}]){
  await page.setViewportSize(size);await page.goto(origin+'/roles');await page.locator('#roles-empty').waitFor();
  const roleEmpty=await page.locator('#roles-empty').evaluate(n=>({width:n.getBoundingClientRect().width,padding:getComputedStyle(n).padding,textAlign:getComputedStyle(n).textAlign,background:getComputedStyle(n).backgroundColor,borderRadius:getComputedStyle(n).borderRadius,parent:n.parentElement.id}));
  assert.equal(roleEmpty.parent,'roles-view');assert.ok(roleEmpty.width>400);assert.equal(roleEmpty.textAlign,'center');assert.notEqual(roleEmpty.background,'rgba(0, 0, 0, 0)');assert.notEqual(roleEmpty.borderRadius,'0px');
  assert.equal(await page.locator('#roles-view [data-action=new-role]').count(),1);assert.ok(await page.locator('#roles-grid').isHidden());
  await page.locator('#roles-search').fill('不存在');await page.getByText('没有匹配的角色',{exact:true}).waitFor();await page.locator('#roles-search').fill('');
  await page.screenshot({path:join(root,`roles-empty-${size.width}.png`)});
  await page.goto(origin+'/mcp-marketplace');await page.locator('[data-market-list] .agent-card').waitFor();
  await page.getByRole('searchbox',{name:'搜索MCP',exact:true}).fill('不存在');await page.locator('[data-market-empty]').filter({hasText:'没有匹配项'}).waitFor();
  const mcpEmpty=await page.locator('[data-market-empty]').evaluate(n=>({padding:getComputedStyle(n).padding,textAlign:getComputedStyle(n).textAlign,background:getComputedStyle(n).backgroundColor,borderRadius:getComputedStyle(n).borderRadius}));
  assert.equal(roleEmpty.padding,mcpEmpty.padding);assert.equal(roleEmpty.textAlign,mcpEmpty.textAlign);assert.equal(roleEmpty.background,mcpEmpty.background);assert.equal(roleEmpty.borderRadius,mcpEmpty.borderRadius);
}
await page.goto(origin+'/mcp-marketplace');await page.locator('[data-add-mcp]').click();
await page.locator('[name=name]').fill(' 编辑后的知识库 ');await page.locator('[name=description]').fill('重复导入更新');
await page.locator('[name=content]').fill(JSON.stringify({mcpServers:{knowledge:{command:'node',args:['replacement.mjs'],env:{TOKEN:'replacement-fixture-secret'}}}}));
await page.locator('#mcp-market-form [type=submit]').click();await page.locator('#mcp-market-form').waitFor({state:'detached'});
await page.locator('[data-market-list] .agent-card').filter({hasText:'重复导入更新'}).waitFor();
let mcps=(await api('/api/runtime/mcp-marketplace')).data.entries;assert.equal(mcps.length,1);assert.notEqual(mcps[0].id,saved.id);
let rebound=(await api('/api/agents')).data.agents.find(a=>a.id===employee.id);assert.deepEqual(rebound.runtime.extensionSelection.mcpIds,[mcps[0].id]);
const retained=mcps[0].id;
try{await cli(['mcps','create','--file','-'],JSON.stringify({name:mcps[0].name,content:JSON.stringify({mcpServers:{knowledge:{command:'node',cwd:root}}})}));assert.fail('incompatible overwrite must fail');}catch(error){assert.match(error.message,/不兼容/);}
assert.deepEqual((await api('/api/runtime/mcp-marketplace')).data.entries.map(m=>m.id),[retained]);
const parallelInput={name:'并发安装',description:'同名只留一条',content:JSON.stringify({mcpServers:{parallel:{command:'node'}}})};
const parallel=await Promise.all([api('/api/runtime/mcp-marketplace',parallelInput),api('/api/runtime/mcp-marketplace',parallelInput)]);assert.ok(parallel.every(r=>r.status===201));
assert.equal((await api('/api/runtime/mcp-marketplace')).data.entries.filter(m=>m.name==='并发安装').length,1);
const source=join(root,'repeat-source');await mkdir(join(source,'.claude-plugin'),{recursive:true});
const manifest=join(source,'.claude-plugin/plugin.json');const manifestValue={name:'repeat-proof',version:'1.0.0',mcpServers:{bundled:{command:'node',args:['before.mjs']}}};
await writeFile(manifest,JSON.stringify(manifestValue));
const first=await cli(['plugins','import','--file','-'],JSON.stringify({path:source}));assert.equal(first.plugins.length,1);assert.equal(first.mcps.length,1);
const selected=(await api('/api/agents',{name:'重复插件验证',status:'inactive',runtime:{profileId:profile.id,extensionSelection:{pluginIds:[first.plugins[0].id],mcpIds:[first.mcps[0].id]}}})).data.agent;assert.ok(selected?.id);
await writeFile(manifest,JSON.stringify({...manifestValue,version:'2.0.0',mcpServers:{bundled:{command:'node',args:['after.mjs']}}}));
const second=await cli(['plugins','import','--file','-'],JSON.stringify({path:source}));assert.equal(second.replacements.length,2);assert.ok(second.employees.some(a=>a.id===selected.id));
assert.equal((await api('/api/runtime/marketplace')).data.plugins.length,1);
rebound=(await api('/api/agents')).data.agents.find(a=>a.id===selected.id);assert.equal(rebound.status,'inactive');assert.deepEqual(rebound.runtime.extensionSelection,{pluginIds:[second.plugins[0].id],mcpIds:[second.mcps[0].id]});
assert.equal((await api('/api/runtime/marketplace/'+first.plugins[0].id)).status,404);
assert.equal((await api('/api/runtime/mcp-marketplace/'+first.mcps[0].id)).status,404);
const beforeFailure=(await api('/api/runtime/marketplace')).data.plugins.map(p=>p.id);
await writeFile(manifest,JSON.stringify({...manifestValue,hooks:{CwdChanged:[{hooks:[{type:'command',command:'true'}]}]}}));
// Codex cannot load CwdChanged: add a Codex selector so the entire source fails.
const codexProfile=(await api('/api/settings/runtime-profiles')).data.profiles.find(p=>p.provider==='codex');
await api('/api/agents',{name:'不兼容保护',runtime:{profileId:codexProfile.id,extensionSelection:{pluginIds:[second.plugins[0].id],mcpIds:[]}}});
const failedImport=await api('/api/runtime/marketplace',{path:source});assert.equal(failedImport.status,400);
assert.deepEqual((await api('/api/runtime/marketplace')).data.plugins.map(p=>p.id),beforeFailure);
assert.deepEqual((await api('/api/agents')).data.agents.find(a=>a.id===selected.id).runtime.extensionSelection,rebound.runtime.extensionSelection);
await writeFile(manifest,JSON.stringify(manifestValue));
const other=join(root,'different-origin');await mkdir(join(other,'.claude-plugin'),{recursive:true});await writeFile(join(other,'.claude-plugin/plugin.json'),JSON.stringify({name:'repeat-proof'}));
assert.equal((await api('/api/runtime/marketplace',{path:other})).status,201);assert.equal((await api('/api/runtime/marketplace')).data.plugins.length,2);
console.log('PASS repeat import UI/CLI/API, parallel imports, distinct origins, bundled MCP rebinding, incompatible rollback and role empty layouts',root);
await page.goto(origin+'/teams');await page.getByText('还没有团队',{exact:true}).waitFor();assert.equal(await page.getByText('去创建数字员工',{exact:true}).count(),0);console.log('PASS UI edit/error/secret/cancel/narrow/team-empty',root);
}
}finally{await app?.close();}
