import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,stat,lstat,symlink,rm,chmod,realpath,unlink,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMarketplace,selectionIds} from '../server/runtime/marketplace.mjs';
import {selectedExtensions,codexMarketArgs,claudeMarketEnvironment} from '../server/runtime/extensions.mjs';
import {runClaudeCodeCli} from '../server/runtime/local-cli.mjs';
import {createCatalogFixtureStore as createStore} from './fixture-store.mjs';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';

async function fixture(t) {
  await mkdir(resolve('.data'),{recursive:true});
  const root=await mkdtemp(resolve('.data/market-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,market:createMarketplace(root)};
}
async function plugin(root,name='proof',count=2,extra={}) {
  const source=join(root,name);await mkdir(join(source,'.claude-plugin'),{recursive:true});
  await writeFile(join(source,'.claude-plugin/plugin.json'),JSON.stringify({name,...extra}));
  for(let i=0;i<count;i++) {
    await mkdir(join(source,`skills/proof-${i}/references`),{recursive:true});
    await writeFile(join(source,`skills/proof-${i}/SKILL.md`),`---\nname: proof-${i}\ndescription: proof ${i}\n---\nRead references/proof.md`);
    await writeFile(join(source,`skills/proof-${i}/references/proof.md`),'support evidence');
  }
  return source;
}
const empty={pluginIds:[],mcpIds:[]};
test('omitted employee extension selection is empty, not ambient configuration', async () => {
  assert.deepEqual(await selectedExtensions({ provider: 'codex' }), {});
  assert.deepEqual(await selectedExtensions({ provider: 'claude-code' }), {});
});
const mcp={kind:'mcp',name:'Calculator',description:'Local arithmetic',content:JSON.stringify({mcpServers:{calculator:{command:'node',args:['server.mjs'],env:{EXAMPLE_TOKEN:'PRIVATE_SENTINEL'}}}})};
const install = async (market,root) => (await market.import({path:await plugin(root)})).plugins[0];

test('MCP edits preserve masked secrets and immutable files, and atomically rebind current employees only',async t=>{
  const {root,market}=await fixture(t),old=await market.add(mcp);
  const frozen=await market.resolve({...empty,mcpIds:[old.id]},'claude-code');
  const store=createStore({databasePath:join(root,'state.sqlite')});t.after(()=>store.close());
  const employee=store.createAgent({name:'编辑验证',runtime:{provider:'claude-code',...frozen}});
  const visible=await market.detail(old.id,'mcp');assert.ok(!JSON.stringify(visible).includes('PRIVATE_SENTINEL'));
  const edited=await market.mcpEditInput(old.id,{name:'新名称',content:JSON.stringify(visible.configuration)});
  assert.ok(edited.content.includes('PRIVATE_SENTINEL'));
  const next=await market.add(edited),runtime=await market.resolve({...empty,mcpIds:[next.id]},'claude-code');
  const result=store.replaceMcpExtension(old.id,next,[{agentId:employee.id,previousRuntime:employee.runtime,runtime}]);
  assert.equal(result.previousId,old.id);assert.deepEqual(result.employees,[{id:employee.id,name:employee.name}]);
  assert.deepEqual(store.listAgents().find(a=>a.id===employee.id).runtime.extensionSelection.mcpIds,[next.id]);
  assert.equal(store.isExtensionRemoved('mcp',old.id),true);
  assert.equal(await readFile(frozen.mcpConfigPaths[0],'utf8'),await readFile(runtime.mcpConfigPaths[0],'utf8'));
  assert.notEqual(frozen.mcpConfigPaths[0],runtime.mcpConfigPaths[0]);
  const patch=await market.mcpEditInput(next.id,{description:'只改说明'});assert.ok(patch.content.includes('PRIVATE_SENTINEL'));
  const config=JSON.parse(patch.content);delete config.mcpServers.calculator.env;
  assert.ok(!(await market.mcpEditInput(next.id,{content:JSON.stringify(config)})).content.includes('PRIVATE_SENTINEL'));
  const renamed={mcpServers:{renamed:visible.configuration.mcpServers.calculator}};
  await assert.rejects(market.mcpEditInput(next.id,{content:JSON.stringify(renamed)}),/隐藏值/);
  for(const input of [{},{role:'x'},{content:'invalid'}])await assert.rejects(market.mcpEditInput(next.id,input));
  const before=store.listAgents().find(a=>a.id===employee.id).runtime;
  store.updateAgent(employee.id,{runtime:{...before,extensionSelection:empty,extensionManifest:[],mcpConfigPaths:[],skillPaths:[],pluginPaths:[],pluginSources:[]}});
  assert.throws(()=>store.replaceMcpExtension(next.id,{...next,id:randomUUID()},[{agentId:employee.id,previousRuntime:before,runtime}]),/已变化/);
  assert.equal(store.isExtensionRemoved('mcp',next.id),false);
});
test('import replacement changes plugin and MCP bindings together, rolls back stale employees and retains frozen files',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root),oldPlugin=(await market.import({path:source})).plugins[0],oldMcp=await market.add(mcp);
  const store=createStore({databasePath:join(root,'import.sqlite')});t.after(()=>store.close());
  const duplicate=await market.add({...mcp,content:JSON.stringify({mcpServers:{another:{command:'node'}}})});
  const frozen=await market.resolve({pluginIds:[oldPlugin.id],mcpIds:[oldMcp.id,duplicate.id]},'claude-code');
  const employee=store.createAgent({name:'覆盖验证',status:'inactive',runtime:{provider:'claude-code',...frozen}});
  const nextPlugin=(await market.import({path:source})).plugins[0],nextMcp=await market.add({...mcp,description:'新说明'});
  const plan=store.planExtensionImport([nextPlugin,nextMcp],await market.list());
  const {replacements}=plan;assert.equal(replacements.length,3,'all previously duplicated names are retired');
  assert.deepEqual(plan.bindings[0].selection,{pluginIds:[nextPlugin.id],mcpIds:[nextMcp.id]},'merged references do not leave duplicate MCP choices');
  assert.throws(()=>store.planExtensionImport([nextMcp,nextMcp],[]),/重复安装名称/);
  const otherOrigin={...oldPlugin,id:randomUUID(),source:{url:'https://example.invalid/other.git'}};
  assert.deepEqual(store.planExtensionImport([nextPlugin],[otherOrigin]).replacements,[],'different plugin origins remain installed');
  const runtime=await market.resolve({pluginIds:[nextPlugin.id],mcpIds:[nextMcp.id]},'claude-code');
  const binding={agentId:employee.id,previousRuntime:employee.runtime,runtime};
  assert.throws(()=>store.replaceImportedExtensions(replacements,[]),/已变化/);
  assert.equal(store.isExtensionRemoved('plugin',oldPlugin.id),false);
  assert.throws(()=>store.replaceImportedExtensions(replacements,[{...binding,previousRuntime:{}}]),/已变化/);
  assert.deepEqual(store.listAgents().find(a=>a.id===employee.id).runtime,employee.runtime);
  const receipt=store.replaceImportedExtensions(replacements,[binding]);
  assert.deepEqual(receipt.employees,[{id:employee.id,name:employee.name}]);assert.equal(receipt.historyRetained,true);
  const current=store.listAgents().find(a=>a.id===employee.id);assert.equal(current.status,'inactive');assert.deepEqual(current.runtime.extensionSelection,runtime.extensionSelection);
  for(const item of replacements)assert.equal(store.isExtensionRemoved(item.kind,item.previousId),true);
  assert.match(await readFile(frozen.skillPaths[0],'utf8'),/Read references/);
  assert.match(await readFile(frozen.mcpConfigPaths[0],'utf8'),/PRIVATE_SENTINEL/);
  assert.throws(()=>store.replaceImportedExtensions(replacements,[binding]),/已变化/);
});
test('edited MCP really calls the new service while a frozen reference still calls the original',async t=>{
  const {root,market}=await fixture(t);
  const content=proof=>JSON.stringify({mcpServers:{proof:{command:process.execPath,args:[resolve('scripts/marketplace-probe-mcp.mjs'),join(root,'probe.log'),proof]}}});
  const old=await market.add({kind:'mcp',name:'真实工具编辑',description:'',content:content('BEFORE-EDIT')});
  const frozen=(await market.resolve({...empty,mcpIds:[old.id]},'claude-code')).extensionManifest[0];
  const updated=await market.add(await market.mcpEditInput(old.id,{content:content('AFTER-EDIT')}));
  const current=(await market.resolve({...empty,mcpIds:[updated.id]},'claude-code')).extensionManifest[0];
  for(const [ref,expected]of [[frozen,'BEFORE-EDIT'],[current,'AFTER-EDIT']]){
    const client=new Client({name:'edit-proof',version:'1'});try{await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('server/runtime/mcp-launcher.mjs'),ref.path,ref.sha256,'proof'],stderr:'pipe'}));assert.match((await client.callTool({name:'read_validation_code',arguments:{}})).content[0].text,new RegExp(expected));}finally{await client.close()}
  }
});

test('Codex stdio MCP preserves its working directory and does not advertise Claude compatibility',async t=>{
  const {root,market}=await fixture(t),log='cwd-proof.jsonl';
  const entry=await market.add({kind:'mcp',name:'cwd-proof',description:'',content:JSON.stringify({mcpServers:{proof:{command:process.execPath,args:[resolve('scripts/marketplace-probe-mcp.mjs'),log,'CWD-PROOF'],cwd:root,env_vars:['PATH']}}})});
  assert.deepEqual(entry.providers,['codex']);
  await assert.rejects(market.resolve({pluginIds:[],mcpIds:[entry.id]},'claude-code'),/MCP.*Claude Code.*不支持/);
  const ref=(await market.resolve({pluginIds:[],mcpIds:[entry.id]},'codex')).extensionManifest[0];
  const client=new Client({name:'cwd-proof',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[resolve('server/runtime/mcp-launcher.mjs'),ref.path,ref.sha256,'proof'],stderr:'pipe'});
  try {await client.connect(transport);assert.match((await client.callTool({name:'read_validation_code',arguments:{}})).content[0].text,/CWD-PROOF/);}
  finally {await client.close();}
  assert.match(await readFile(join(root,log),'utf8'),/called/);
  await assert.rejects(market.add({...mcp,content:JSON.stringify({mcpServers:{bad:{command:'node',cwd:'relative'}}})}),/绝对目录/);
});

test('private SDK bridge really initializes and calls tools over SSE and Streamable HTTP; redirects never forward auth',async t=>{
  const {market}=await fixture(t);let leaked=false,calls=0;
  const peers=new Map(),transports=[];
  const serverFor=()=>{const server=new Server({name:'remote-proof',version:'1'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'proof',description:'test',inputSchema:{type:'object',properties:{}}}]}));server.setRequestHandler(CallToolRequestSchema,async()=>{calls++;return {content:[{type:'text',text:'REMOTE-TRANSPORT-OK'}]};});return server;};
  const http=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/redirect'){res.writeHead(307,{Location:'/leak'});res.end();return;}
      if(url.pathname==='/leak'){leaked=true;res.end();return;}
      if(req.headers.authorization!=='Bearer synthetic-test-token'){res.writeHead(401);res.end();return;}
      if(url.pathname==='/sse' && req.method==='GET'){const transport=new SSEServerTransport('/messages',res);peers.set(transport.sessionId,transport);transports.push(transport);await serverFor().connect(transport);return;}
      if(url.pathname==='/messages'){const transport=peers.get(url.searchParams.get('sessionId'));if(!transport){res.writeHead(404);res.end();return;}await transport.handlePostMessage(req,res);return;}
      if(url.pathname==='/mcp'){const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});transports.push(transport);await serverFor().connect(transport);await transport.handleRequest(req,res);return;}
      res.writeHead(404);res.end();
    }catch{res.writeHead(500);res.end();}
  });
  await new Promise(done=>http.listen(0,'127.0.0.1',done));
  t.after(async()=>{await Promise.allSettled(transports.map(item=>item.close()));http.closeAllConnections();await new Promise(done=>http.close(done));});
  const origin=`http://127.0.0.1:${http.address().port}`;
  for(const type of ['sse','streamableHttp','http','streamable-http']) {
    const entry=await market.add({kind:'mcp',name:type,description:'',content:JSON.stringify({mcpServers:{proof:{type,url:origin+(type==='sse'?'/sse':'/mcp'),headers:{Authorization:'Bearer synthetic-test-token'}}}})});
    const runtime=await market.resolve({pluginIds:[],mcpIds:[entry.id]},'codex'),ref=runtime.extensionManifest[0];
    const client=new Client({name:'bridge-test',version:'1'});
    const transport=new StdioClientTransport({command:process.execPath,args:[resolve('server/runtime/mcp-launcher.mjs'),ref.path,ref.sha256,'proof'],stderr:'pipe'});
    await client.connect(transport);assert.equal((await client.listTools()).tools[0].name,'proof');
    assert.match((await client.callTool({name:'proof',arguments:{}})).content[0].text,/REMOTE-TRANSPORT-OK/);await client.close();
  }
  assert.equal(calls,4);
  const entry=await market.add({kind:'mcp',name:'redirect',description:'',content:JSON.stringify({mcpServers:{proof:{type:'http',url:origin+'/redirect',headers:{Authorization:'Bearer synthetic-test-token'}}}})});
  const ref=(await market.resolve({pluginIds:[],mcpIds:[entry.id]},'codex')).extensionManifest[0];
  const client=new Client({name:'redirect-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[resolve('server/runtime/mcp-launcher.mjs'),ref.path,ref.sha256,'proof'],stderr:'pipe'});
  await assert.rejects(client.connect(transport));await client.close();assert.equal(leaked,false);
});

test('whole-plugin install preserves 301 skills and support files as one immutable version',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root,'large',301);
  const {plugins:[entry]}=await market.import({path:source});
  assert.equal(entry.components.skills,301);assert.equal((await market.catalog()).plugins.length,1);
  const runtime={provider:'claude-code',...await market.resolve({...empty,pluginIds:[entry.id]},'claude-code')};
  assert.equal(runtime.skillPaths.length,301);assert.equal(runtime.pluginPaths.length,1);
  await rm(source,{recursive:true});
  assert.match(await readFile(join(runtime.skillPaths[0],'../references/proof.md'),'utf8'),/support evidence/);
  assert.deepEqual(Object.keys(await selectedExtensions(runtime)),[]);
  assert.equal((await createMarketplace(root).catalog()).plugins.length,1);
});
test('source-internal file and directory links materialize without changing names, bytes or executable mode',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root,'linked-source',1);
  await writeFile(join(source,'skills/proof-0/CLAUDE.md'),'linked instruction contents');
  await symlink('CLAUDE.md',join(source,'skills/proof-0/AGENTS.md'));
  await mkdir(join(source,'shared/中文 空格 #资料'),{recursive:true});
  await writeFile(join(source,'shared/中文 空格 #资料/说明.md'),'exact support bytes\n');
  await symlink('../../shared/中文 空格 #资料',join(source,'skills/proof-0/资料链接'));
  await writeFile(join(source,'shared/run.sh'),'#!/bin/sh\nprintf proof\n');await chmod(join(source,'shared/run.sh'),0o755);
  await symlink('shared/run.sh',join(source,'run'));
  await mkdir(join(source,'empty'),{recursive:true});
  const {plugins:[entry]}=await market.import({path:source});
  for(const provider of ['claude-code','codex']) {
    const runtime={provider,...await market.resolve({...empty,pluginIds:[entry.id]},provider)},skill=runtime.skillPaths[0],installed=resolve(skill,'../../..');
    assert.equal(await readFile(resolve(skill,'../AGENTS.md'),'utf8'),'linked instruction contents');
    assert.equal((await lstat(resolve(skill,'../AGENTS.md'))).isSymbolicLink(),false);
    assert.equal(await readFile(resolve(skill,'../资料链接/说明.md'),'utf8'),'exact support bytes\n');
    assert.equal((await lstat(resolve(skill,'../资料链接'))).isDirectory(),true);
    assert.equal((await lstat(join(installed,'empty'))).isDirectory(),true);
    assert.ok((await stat(join(installed,'run'))).mode&0o100);
    assert.equal((await lstat(join(installed,'run'))).isSymbolicLink(),false);
    assert.deepEqual(Object.keys(await selectedExtensions(runtime)),[]);
  }
  await rm(source,{recursive:true});
  assert.equal((await market.resolve({...empty,pluginIds:[entry.id]},'codex')).skillPaths.length,1);
});
test('marketplace plugin may materialize shared resources inside the same source repository only',async t=>{
  const {root,market}=await fixture(t),source=join(root,'market-source');await mkdir(join(source,'.claude-plugin'),{recursive:true});
  const first=await plugin(source,'first',0);await mkdir(join(source,'shared-skill'));
  await writeFile(join(source,'shared-skill/SKILL.md'),'---\nname: shared\n---\nShared source resource.');
  await mkdir(join(first,'skills'));await symlink('../../shared-skill',join(first,'skills/shared'));
  await writeFile(join(source,'.claude-plugin/marketplace.json'),JSON.stringify({plugins:[{name:'first',source:'./first'}]}));
  const {plugins:[entry]}=await market.import({path:source});assert.equal(entry.components.skills,1);
  await assert.rejects(market.import({path:first}),/超出来源目录/,'standalone import cannot read beyond its supplied source');
});
test('broken, cyclic and external source links identify the plugin/path and leave no partial batch',async t=>{
  const {root,market}=await fixture(t),source=join(root,'market-source');await mkdir(join(source,'.claude-plugin'),{recursive:true});
  await plugin(source,'first');const second=await plugin(source,'second');
  await writeFile(join(source,'.claude-plugin/marketplace.json'),JSON.stringify({plugins:[{name:'first',source:'./first'},{name:'second',source:'./second'}]}));
  for(const [target,reason] of [['missing',/不可读取/],['.',/循环/],[root,/超出来源目录/]]) {
    await symlink(target,join(second,'bad-link'));
    await assert.rejects(market.import({path:source}),error=>/second/.test(error.message) && /bad-link/.test(error.message) && reason.test(error.message) && /本批次未安装/.test(error.message));
    await unlink(join(second,'bad-link'));
    assert.equal((await market.catalog()).plugins.length,0);assert.equal((await market.mcpCatalog()).entries.length,0);
    assert.equal((await readdir(join(root,'installed-plugins'))).some(name=>name.startsWith('.install-')),false);
  }
  await symlink('b',join(second,'a'));await symlink('a',join(second,'b'));
  await assert.rejects(market.import({path:source}),/链接循环/);
});
test('special source files fail explicitly instead of hanging or silently omitting plugin content',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root);
  await promisify(execFile)('mkfifo',[join(source,'source.pipe')]);
  await assert.rejects(market.import({path:source}),/source\.pipe.*管道/);
  assert.equal((await market.catalog()).plugins.length,0);
});
test('source-wide installation publishes all plugins atomically and rejects retired inputs',async t=>{
  const {root,market}=await fixture(t),source=join(root,'source');await mkdir(join(source,'.claude-plugin'),{recursive:true});
  await plugin(source,'first');await plugin(source,'second');
  await writeFile(join(source,'.claude-plugin/marketplace.json'),JSON.stringify({plugins:[{name:'first',source:'./first'},{name:'second',source:'./second'}]}));
  const installed=await market.import({path:source});
  assert.deepEqual(installed.plugins.map(item=>item.name),['first','second']);assert.equal((await market.catalog()).plugins.length,2);
  for(const input of [{sourceId:randomUUID()},{path:source,pluginName:'first'},{path:source,url:'https://example.com/repo.git'}]) await assert.rejects(market.import(input),/只接受/);
  await writeFile(join(source,'second/.claude-plugin/plugin.json'),'{bad');
  await assert.rejects(market.import({path:source}),/JSON/);
  assert.equal((await market.catalog()).plugins.length,2,'failed batch leaves installed entries unchanged');
});
test('market aliases may install together but cannot bind the same native plugin namespace twice',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root,'same-native',1);
  await writeFile(join(source,'.claude-plugin/marketplace.json'),JSON.stringify({plugins:[{name:'stable',source:'./'},{name:'development',source:'./'}]}));
  const result=await market.import({path:source});assert.deepEqual(result.plugins.map(item=>item.name),['stable','development']);
  for(const provider of ['claude-code','codex'])await assert.rejects(market.resolve({pluginIds:result.plugins.map(item=>item.id),mcpIds:[]},provider),/命名空间.*same-native.*重复/);
});
test('details include Skills, Subagents and common command Hooks for both providers',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root);
  await mkdir(join(source,'agents'));await writeFile(join(source,'agents/reviewer.md'),'---\nname: reviewer\ndescription: Review evidence\n---\nReview');
  await mkdir(join(source,'hooks'));await writeFile(join(source,'hooks/hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:'echo test'}]}]}}));
  const {plugins:[entry]}=await market.import({path:source}),detail=await market.detail(entry.id,'plugin');
  assert.equal(detail.components.skills.length,2);assert.equal(detail.components.agents[0].name,'reviewer');assert.equal(detail.components.hooks[0].event,'SessionStart');
  assert.deepEqual(detail.providers,['claude-code','codex']);
  assert.equal((await market.resolve({...empty,pluginIds:[entry.id]},'codex')).extensionManifest.length,1);
});
test('dual manifests keep Claude Hooks and explicit empty Codex Hooks independent, with truthful component/runtime labels',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root);
  await mkdir(join(source,'.codex-plugin'));await mkdir(join(source,'hooks'));
  await writeFile(join(source,'.codex-plugin/plugin.json'),JSON.stringify({name:'proof',skills:'./skills/',hooks:{}}));
  await writeFile(join(source,'hooks/hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:'echo selected'}]}]}}));
  const {plugins:[entry]}=await market.import({path:source}),detail=await market.detail(entry.id,'plugin');
  assert.deepEqual(entry.providers,['claude-code','codex']);assert.deepEqual(detail.components.hooks[0].providers,['claude-code']);
  const runtime=await market.resolve({pluginIds:[entry.id],mcpIds:[]},'codex');
  const projection=JSON.parse(await readFile(join(runtime.extensionManifest[0].path,'../../.agentforge/codex.json'),'utf8'));
  assert.deepEqual(projection.hooks,[],'explicit empty Codex Hooks do not inherit the Claude startup Hook');
  assert.equal(entry.compatibility.codex.supported,true);
});
test('dual manifests split provider-specific MCP definitions and resolve relative Codex cwd inside the immutable plugin',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root,'dual-mcp',0,{mcpServers:{proof:{command:'node',args:['${CLAUDE_PLUGIN_ROOT}/server.mjs']}}});
  await mkdir(join(source,'.codex-plugin'));
  await writeFile(join(source,'.codex-plugin/plugin.json'),JSON.stringify({name:'dual-mcp',mcpServers:'./.mcp.json'}));
  await writeFile(join(source,'.mcp.json'),JSON.stringify({mcpServers:{proof:{command:'node',args:['./server.mjs'],cwd:'.',env_vars:['PATH']}}}));
  await writeFile(join(source,'server.mjs'),'// fixture');
  const result=await market.import({path:source});assert.equal(result.mcps.length,2);
  for(const provider of ['claude-code','codex']) {
    const entry=result.mcps.find(item=>item.providers.length===1 && item.providers[0]===provider);assert.ok(entry);
    const detail=await market.detail(entry.id,'mcp'),service=detail.configuration.mcpServers.proof;
    if(provider==='codex'){assert.match(service.cwd,/installed-plugins\/.*\/plugin$/);assert.deepEqual(service.env_vars,['PATH']);}
    else {assert.match(service.args[0],/installed-plugins\/.*\/plugin\/server.mjs$/);assert.equal(service.cwd,undefined);}
    assert.equal((await market.resolve({pluginIds:[],mcpIds:[entry.id]},provider)).extensionManifest.length,1);
  }
});
test('incompatible plugin still installs, exposes exact reason and cannot be selected through runtime resolution',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root,'claude-only',1,{settings:{}});
  const {plugins:[entry]}=await market.import({path:source});
  assert.deepEqual(entry.providers,['claude-code']);assert.equal(entry.compatibility.codex.supported,false);
  assert.match(entry.compatibility.codex.reasons.join(' '),/settings/);
  await assert.rejects(market.resolve({pluginIds:[entry.id],mcpIds:[]},'codex'),/claude-only.*Codex.*settings/);
  assert.equal((await market.resolve({pluginIds:[entry.id],mcpIds:[]},'claude-code')).extensionManifest.length,1);
});
test('mixed marketplace fetches every Git remote entry, caches identical revisions, honors sha over ref and publishes one complete batch',async t=>{
  const {root,market}=await fixture(t),catalog=join(root,'catalog'),source=await plugin(root,'source'),bin=join(root,'bin'),log=join(root,'git-calls.jsonl');
  await mkdir(join(catalog,'.agents/plugins'),{recursive:true});await mkdir(bin);
  const pinned='a'.repeat(40);
  await writeFile(join(catalog,'.agents/plugins/marketplace.json'),JSON.stringify({plugins:[
    {name:'from-github',source:{source:'github',repo:'example/plugins',sha:pinned,ref:'deleted-ref'}},
    {name:'from-url',source:{source:'url',url:'https://github.com/example/plugins.git',sha:pinned}},
    {name:'from-subdir',source:{source:'git-subdir',url:'https://github.com/example/monorepo.git',path:'./sub',ref:'feature/memory'}}
  ]}));
  const git=join(bin,'git');
  await writeFile(git,`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args.includes('clone')){const target=args.at(-1);fs.cpSync(${JSON.stringify(source)},target,{recursive:true});fs.cpSync(${JSON.stringify(source)},path.join(target,'sub'),{recursive:true});}if(args.includes('rev-parse'))console.log('${pinned}');\n`,{mode:0o700});
  const previous=process.env.PATH;process.env.PATH=bin+':'+previous;
  try {
    const installed=await market.import({path:catalog});assert.deepEqual(installed.plugins.map(item=>item.name),['from-github','from-url','from-subdir']);
    assert.equal((await market.catalog()).plugins.length,3);
    const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse),clones=calls.filter(args=>args.includes('clone'));
    assert.equal(clones.length,2);assert.ok(!clones[0].includes('deleted-ref'));assert.ok(clones[1].includes('feature/memory'));
    assert.equal(calls.filter(args=>args.includes('fetch')).length,1);assert.ok(calls.some(args=>args.includes('fetch')&&args.at(-1)===pinned));
    assert.ok(installed.plugins.every(item=>item.source.revision===pinned));
    await writeFile(join(catalog,'.agents/plugins/marketplace.json'),JSON.stringify({plugins:[{name:'broken',source:{source:'git-subdir',url:'https://github.com/example/monorepo.git',path:'./missing'}}]}));
    await assert.rejects(market.import({path:catalog}),/broken.*本批次未安装/);assert.equal((await market.catalog()).plugins.length,3);
  }finally{process.env.PATH=previous;}
});
test('Codex and portable manifests adapt Markdown Commands into explicit Skill files without executing preprocessors',async t=>{
  const {root,market}=await fixture(t);
  for(const [index,manifest] of ['.codex-plugin/plugin.json','plugin.json'].entries()) {
    const source=await plugin(root,`portable-${index}`,1);await rm(join(source,'.claude-plugin/plugin.json'));
    await mkdir(join(source,manifest.includes('/')?'.codex-plugin':'commands'),{recursive:true});await mkdir(join(source,'commands'),{recursive:true});
    await writeFile(join(source,manifest),JSON.stringify({name:`portable-${index}`,skills:'./skills/'}));
    await writeFile(join(source,'commands/review.md'),'---\nargument-hint: file\n---\nReview $ARGUMENTS. Do not execute !`echo unexpanded` on import.');
    const result=await market.import({path:source});assert.equal(result.plugins[0].components.skills,2);assert.equal(result.plugins[0].components.commands,1);
    const selected=await market.resolve({pluginIds:[result.plugins[0].id],mcpIds:[]},'codex');assert.equal(selected.skillPaths.length,2);
    assert.match(await readFile(selected.skillPaths.at(-1),'utf8'),/不提供斜杠参数展开/);
    await assert.rejects(stat(join(source,'.agentforge')),{code:'ENOENT'});
  }
});
test('Codex projections execute each integrity-checked selected Hook, including repeated events, without command arguments',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root,'native',0,{hooks:'./extra.json'});
  await mkdir(join(source,'hooks'));
  await mkdir(join(source,'agents'));await writeFile(join(source,'agents/review.md'),'---\nname: review\ndescription: independent proof\n---\nReturn reviewed.');
  const log=join(root,'hooks.log'),config=word=>({hooks:{SessionStart:[{hooks:[{type:'command',command:`printf '${word}\\n' >> '${log}'`}]}]}});
  await writeFile(join(source,'hooks/hooks.json'),JSON.stringify(config('first')));await writeFile(join(source,'extra.json'),JSON.stringify(config('second')));
  const installed=await market.import({path:source}),runtime={provider:'codex',...await market.resolve({pluginIds:[installed.plugins[0].id],mcpIds:[]},'codex')};
  const executable=join(root,'codex.mjs');await writeFile(executable,'#!/usr/bin/env node\nconsole.log(process.argv.includes("features")?"skip_host_skill_discovery stable false":"[]");');await chmod(executable,0o755);
  const args=await codexMarketArgs({...runtime,executable},{},root,join(root,'trace'));
  assert.ok(args.includes('--dangerously-bypass-hook-trust'));assert.ok(!args.join(' ').includes('printf'));
  assert.ok(args.some(value=>value.startsWith('agents.af_')));
  const groups=JSON.parse(args.find(value=>value.startsWith('hooks.SessionStart=')).slice('hooks.SessionStart='.length).replace(/"([^"\\]+)"=/g,'"$1":'));
  assert.equal(groups.length,2);
  for(const group of groups)await promisify(execFile)('/bin/sh',['-c',group.hooks[0].command]);
  assert.equal(await readFile(log,'utf8'),'first\nsecond\n');
  await writeFile(join(source,'extra.json'),JSON.stringify({hooks:{Notification:[{hooks:[{type:'command',command:'echo not-portable'}]}]}}));
  const unsupported=await market.import({path:source});await assert.rejects(market.resolve({pluginIds:[unsupported.plugins[0].id],mcpIds:[]},'codex'),/不支持/);
});
test('market root explicit Skill declarations exclude other plugins default Skills',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root);
  await rm(join(source,'.claude-plugin/plugin.json'));
  await writeFile(join(source,'.claude-plugin/marketplace.json'),JSON.stringify({plugins:[{name:'one',source:'./',strict:false,skills:['./skills/proof-0']},{name:'two',source:'./',strict:false,skills:['./skills/proof-1']}]}));
  const installed=await market.import({path:source});
  assert.deepEqual(installed.plugins.map(item=>item.components.skills),[1,1]);
  const runtime=await market.resolve({...empty,pluginIds:[installed.plugins[0].id]},'claude-code');
  assert.equal(runtime.skillPaths.length,1);assert.match(runtime.skillPaths[0],/proof-0/);
});
test('default Hook file remains visible alongside custom Hook declarations',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root,'hooks',0,{hooks:'./custom-hooks.json'});
  await mkdir(join(source,'hooks'));
  await writeFile(join(source,'hooks/hooks.json'),JSON.stringify({hooks:{SessionStart:[]}}));
  await writeFile(join(source,'custom-hooks.json'),JSON.stringify({hooks:{Stop:[]}}));
  const {plugins:[entry]}=await market.import({path:source});
  assert.deepEqual((await market.detail(entry.id,'plugin')).components.hooks.map(item=>item.event),['SessionStart','Stop']);
  assert.deepEqual(entry.providers,['claude-code','codex']);
});
test('bundled MCP splits into independent selection; invalid paths and symlinks never partially install',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root,'invalid',1,{mcpServers:{service:{command:'node'}}});
  const result=await market.import({path:source});assert.equal(result.plugins.length,1);assert.equal(result.mcps.length,1);
  const selected=await market.resolve({...empty,pluginIds:[result.plugins[0].id]},'claude-code');
  assert.deepEqual(Object.keys(await selectedExtensions({provider:'claude-code',...selected})),[]);
  assert.equal((await market.mcpCatalog()).entries.length,1);
  await writeFile(join(source,'.claude-plugin/plugin.json'),JSON.stringify({name:'invalid',skills:['../outside']}));
  await assert.rejects(market.import({path:source}),/路径/);
  await writeFile(join(source,'.claude-plugin/plugin.json'),JSON.stringify({name:'invalid'}));
  await symlink(root,join(source,'linked'));await assert.rejects(market.import({path:source}),/链接/);
  assert.equal((await market.catalog()).plugins.length,1);
});
test('selection is plugin/MCP only, complete and duplicate-free',async t=>{
  const {market}=await fixture(t),entry=await market.add(mcp);
  assert.throws(()=>selectionIds({skillIds:[],mcpIds:[]}),/仅接受/);
  assert.throws(()=>selectionIds({pluginIds:[]}),/完整/);
  await assert.rejects(market.resolve({...empty,mcpIds:[entry.id,entry.id]},'claude-code'),/不重复/);
  await assert.rejects(market.resolve({...empty,pluginIds:[entry.id]},'claude-code'),/不可读取/);
});
test('malformed Hook reports a useful error without echoing source contents',async t=>{
  const {root,market}=await fixture(t),source=await plugin(root,'malformed',0,{hooks:'./private-hook.json'});
  await writeFile(join(source,'private-hook.json'),'PRIVATE_HOOK_SENTINEL invalid');
  await assert.rejects(market.import({path:source}),error=>/JSON/.test(error.message) && !error.message.includes('SENTINEL'));
});
test('MCP details redact credentials; unsupported fields and multi-server input reject',async t=>{
  const {market}=await fixture(t),entry=await market.add(mcp),detail=await market.detail(entry.id,'mcp');
  assert.match(detail.configuration.mcpServers.calculator.env.EXAMPLE_TOKEN,/REDACTED|已隐藏/);
  assert.doesNotMatch(JSON.stringify(detail),/PRIVATE_SENTINEL/);
  for(const content of ['{bad','{"mcpServers":{"a":{"command":"node"},"b":{"command":"node"}}}','{"mcpServers":{"agentforge_history":{"command":"node"}}}','{"mcpServers":{"x":{"command":"node","unknown":true}}}']) await assert.rejects(market.add({...mcp,content}));
  const remote=await market.add({...mcp,content:'{"mcpServers":{"remote":{"type":"http","url":"https://example.com/mcp"}}}'});
  assert.equal((await market.resolve({...empty,mcpIds:[remote.id]},'codex')).extensionManifest.length,1);
});

test('Claude market inherits only connection environment, never hooks or extension settings', async t => {
  const {root} = await fixture(t), path = join(root,'settings.json');
  await writeFile(path, JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://example.com',ARBITRARY_PLUGIN_SECRET:'excluded'},hooks:{test:'must-not-execute'},apiKeyHelper:'must-not-execute',enabledPlugins:{evil:true}}));
  const env = await claudeMarketEnvironment(path);
  assert.deepEqual(Object.keys(env), process.env.ANTHROPIC_BASE_URL === undefined ? ['ANTHROPIC_BASE_URL'] : []);
  assert.doesNotMatch(JSON.stringify(env), /excluded|must-not-execute|evil/);
  await writeFile(path,'invalid'); await assert.rejects(claudeMarketEnvironment(path),/无效/);
});

test('market versions are immutable, private, selectable and persistent without secret metadata', async t => {
  const {root,market} = await fixture(t);
  const a = await install(market,root), b = await market.add(mcp), c = await install(market,root);
  assert.notEqual(a.id,c.id);
  const list = await createMarketplace(root).list();
  assert.equal(list.length,3); assert.doesNotMatch(JSON.stringify(list),/PRIVATE_SENTINEL|server.mjs|mcpServers/);
  const runtime = await market.resolve({pluginIds:[a.id],mcpIds:[b.id]},'claude-code');
  assert.equal(runtime.skillPaths.length,2); assert.equal(runtime.mcpConfigPaths.length,1);
  assert.doesNotMatch(JSON.stringify(runtime),/PRIVATE_SENTINEL/);
  assert.equal((await stat(runtime.mcpConfigPaths[0])).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(await selectedExtensions(runtime)),['calculator']);
  assert.deepEqual(Object.keys(await selectedExtensions(await market.resolve({pluginIds:[],mcpIds:[]},'codex'))),[]);
});
test('market rejects invalid, duplicate, reserved, incompatible and missing selections', async t => {
  const {root,market} = await fixture(t);
  await assert.rejects(market.add({...mcp,content:'{bad'}));
  await assert.rejects(market.add({...mcp,content:'{"mcpServers":{"agentforge_history":{"command":"node"}}}'}));
  await assert.rejects(market.add({...mcp,content:'{"mcpServers":{"x":{"command":"node","unknown":true}}}'}));
  const a = await market.add(mcp), b = await market.add(mcp);
  await assert.rejects(market.resolve({pluginIds:[],mcpIds:[a.id,a.id]},'claude-code'));
  await assert.rejects(market.resolve({pluginIds:[],mcpIds:[a.id,b.id]},'claude-code'),/重复/);
  await assert.rejects(market.resolve({pluginIds:[a.id],mcpIds:[]},'claude-code'));
  const http = await market.add({...mcp,content:'{"mcpServers":{"http":{"type":"http","url":"https://example.com/mcp"}}}'});
  assert.equal((await market.resolve({pluginIds:[],mcpIds:[http.id]},'codex')).extensionManifest.length,1);
  await assert.rejects(market.resolve({pluginIds:['../outside'],mcpIds:[]},'claude-code'));
});
test('market integrity and path mismatch fail before provider execution', async t => {
  const {root,market} = await fixture(t), entry = await install(market,root);
  const runtime = {provider:'claude-code',...await market.resolve({pluginIds:[entry.id],mcpIds:[]},'claude-code')};
  await assert.rejects(selectedExtensions({...runtime,skillPaths:[]}),/不一致/);
  await writeFile(runtime.skillPaths[0],'tampered');
  await assert.rejects(selectedExtensions(runtime), error => error.code === 'EXTENSION_INTEGRITY_FAILED' && /SHA256 不匹配/.test(error.message) && error.retryable === false);
  await assert.rejects(runClaudeCodeCli({runtime:{...runtime,executable:join(root,'must-not-start')},workspacePath:root}),/SHA256 不匹配/);
  await rm(runtime.skillPaths[0]); await symlink(join(root,'outside'),runtime.skillPaths[0]);
  await assert.rejects(selectedExtensions(runtime), error => error.code === 'EXTENSION_INTEGRITY_FAILED' && /SKILL.md/.test(error.message));
});

test('market refuses a linked configuration root before creating a catalog outside it', async t => {
  const {root} = await fixture(t), outside = join(root,'outside'), linked = join(root,'linked');
  await mkdir(outside); await symlink(outside,linked);
  await assert.rejects(createMarketplace(linked).list(),/根目录/);
  assert.equal(await stat(join(outside,'marketplace')).then(()=>true,()=>false),false);
});
test('market accepts canonical ancestor aliases without losing installed plugin or MCP integrity',async t=>{
  const {root}=await fixture(t),actual=join(root,'actual'),alias=join(root,'alias');
  await mkdir(actual);await symlink(actual,alias);
  const market=createMarketplace(join(alias,'runtime'));
  assert.deepEqual(await market.catalog(),{plugins:[]});
  const entry=await install(market,root),service=await market.add(mcp);
  const canonicalRoot=join(await realpath(actual),'runtime');
  for(const provider of ['claude-code','codex']) {
    const runtime=await market.resolve({pluginIds:[entry.id],mcpIds:[service.id]},provider);
    assert.ok(runtime.extensionManifest.every(ref=>ref.path.startsWith(canonicalRoot+'/')));
    assert.equal(Object.keys(await selectedExtensions({provider,...runtime})).length,1);
  }
  assert.equal((await market.detail(entry.id,'plugin')).components.skills.length,2);
  assert.equal((await createMarketplace(join(alias,'runtime')).mcpCatalog()).entries.length,1);
  const other=join(root,'other');await mkdir(other);await unlink(alias);await symlink(other,alias);
  await assert.rejects(market.catalog(),error=>error.code==='MARKETPLACE_ROOT_CHANGED');
});
test('market still rejects linked managed child directories and records the failing path',async t=>{
  for(const name of ['marketplace','installed-plugins']) {
    const {root}=await fixture(t),outside=join(root,'outside'),managed=join(root,'runtime');
    await mkdir(outside);await mkdir(managed);await symlink(outside,join(managed,name));
    await assert.rejects(createMarketplace(managed).catalog(),error=>error.code==='MARKETPLACE_DIRECTORY_INVALID' && error.path===join(managed,name));
    assert.deepEqual(await readdir(outside),[]);
  }
});
test('MCP catalog rejects linked metadata without exposing the linked content',async t=>{
  const {root,market}=await fixture(t),entry=await market.add(mcp),file=join(root,'marketplace',entry.id,'entry.json'),privateFile=join(root,'private-content');
  await writeFile(privateFile,'PRIVATE_METADATA_SENTINEL');await rm(file);await symlink(privateFile,file);
  await assert.rejects(market.mcpCatalog(),error=>/元信息/.test(error.message) && !error.message.includes('SENTINEL'));
});

test('Claude refuses unavailable or implicitly loaded MCP before accepting output', async t => {
  const {root,market} = await fixture(t), entry = await market.add(mcp);
  const runtime = await market.resolve({pluginIds:[],mcpIds:[entry.id]},'claude-code');
  const executable = join(root,'cli.mjs');
  for (const servers of [[{name:'calculator',status:'failed'}],[{name:'calculator',status:'connected'},{name:'extra',status:'connected'}]]) {
    await writeFile(executable,`#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'system',subtype:'init',mcp_servers:${JSON.stringify(servers)}})); console.log(JSON.stringify({type:'result',structured_output:{ok:true}}));`); await chmod(executable,0o755);
    await assert.rejects(runClaudeCodeCli({runtime:{...runtime,executable},workspacePath:root,traceDirectory:root,finalPath:join(root,'final.json'),outputSchema:{},prompt:'work',runId:'market-reject',onEvent:async()=>{}}),/所选 MCP|未选择的 MCP/);
  }
});
test('Claude market launch disables implicit discovery and keeps only selected references', async t => {
  const {root,market} = await fixture(t), entry = await install(market,root);
  const runtime = await market.resolve({pluginIds:[entry.id],mcpIds:[]},'claude-code');
  const executable = join(root,'cli.mjs');
  await writeFile(executable,`#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'system',subtype:'init',mcp_servers:[]})); console.log(JSON.stringify({type:'result',structured_output:{args:process.argv.slice(2)}}));`); await chmod(executable,0o755);
  const result = JSON.parse((await runClaudeCodeCli({runtime:{...runtime,executable},workspacePath:root,traceDirectory:root,finalPath:join(root,'final.json'),outputSchema:{},prompt:'work',runId:'market-launch',onEvent:async()=>{}})).finalText);
  assert.ok(result.args.includes('--strict-mcp-config')); assert.ok(!result.args.includes('--disable-slash-commands'));
  assert.equal(JSON.parse(result.args[result.args.indexOf('--settings')+1]).disableBundledSkills,true);
  assert.equal(result.args[result.args.indexOf('--setting-sources')+1],'');
  assert.equal(result.args.at(-1), 'work');
  assert.equal(result.args[result.args.indexOf('--plugin-dir')+1],runtime.pluginPaths[0]);
  assert.equal(result.args.includes('--append-system-prompt-file'),false,'skill file paths are not synthesized into system instructions');
});
test('Codex market overrides discovery and passes private references rather than credentials', async t => {
  const {root,market} = await fixture(t), entry = await market.add(mcp);
  const runtime = await market.resolve({pluginIds:[],mcpIds:[entry.id]},'codex');
  const executable = join(root,'codex.mjs');
  await writeFile(executable,'#!/usr/bin/env node\nconsole.log(process.argv.includes("features") ? "skip_host_skill_discovery under development false" : JSON.stringify([{name:"ambient",enabled:true}]));'); await chmod(executable,0o755);
  const args = await codexMarketArgs({...runtime,executable}, await selectedExtensions(runtime));
  assert.ok(args.includes('features.skip_host_skill_discovery=true'));
  assert.ok(args.includes('features.apps=false'), 'account Apps are not employee-selected MCP servers');
  assert.ok(args.includes('features.plugins=false'));
  assert.ok(args.includes('mcp_servers.ambient.enabled=false'));
  assert.ok(!args.some(arg=>arg.startsWith('mcp_servers=')), 'parent override must not erase disabled servers');
  assert.match(args.join(' '),/mcp-launcher.mjs/); assert.doesNotMatch(args.join(' '),/PRIVATE_SENTINEL|EXAMPLE_TOKEN|server.mjs/);
  await writeFile(executable,'#!/usr/bin/env node\nconsole.log("old cli");');
  await assert.rejects(codexMarketArgs({...runtime,executable},{}),/不支持/);
});
test('Store freezes selected market versions and rejects mixed legacy paths', async t => {
  const {root,market} = await fixture(t), entry = await install(market,root);
  const runtime = {provider:'claude-code',...await market.resolve({pluginIds:[entry.id],mcpIds:[]},'claude-code')};
  const store = createStore({workspaceRoot:root});
  const employee = store.createAgent({name:'Selected',role:'需求分析师',runtime});
  const team = store.createTeam({name:'Market team',memberAgentIds:[employee.id]});
  const flow = store.createWorkflowTemplate({name:'Market task',nodes:[{id:'work',title:'Work',staffingGuidance:'能使用所选技能完成本地文件交付的成员',dependsOn:[],artifactPaths:['docs/work/']}]});
  const task = store.createTask({title:'Freeze',objective:'Check',teamId:team.id,workflowTemplateId:flow.id,nodeAssignments:{work:employee.id}});
  store.updateAgent(employee.id,{runtime:{provider:'claude-code',...await market.resolve({pluginIds:[],mcpIds:[]},'claude-code')}});
  assert.deepEqual(task.memberSnapshots[0].runtime.extensionSelection.pluginIds,[entry.id]);
  store.removeExtension({kind:'plugin',id:entry.id,name:entry.name});
  assert.deepEqual(store.getTask(task.id).memberSnapshots[0].runtime.extensionSelection.pluginIds,[entry.id]);
  assert.equal(await readFile(join(task.memberSnapshots[0].runtime.pluginPaths[0],'.claude-plugin/plugin.json'),'utf8').then(text=>JSON.parse(text).name),'proof','historical plugin remains usable');
  await assert.rejects(async()=>store.updateAgent(employee.id,{runtime:{...runtime,pluginPaths:[root]}}),/只能/);
});

test('extension removal blocks all current employee references, stale bindings and persists atomically without deleting frozen files', async t => {
  const {root,market}=await fixture(t),entry=await install(market,root),service=await market.add(mcp);
  const databasePath=join(root,'state.sqlite');let store=createStore({databasePath});
  t.after(()=>store.close());
  for(const [kind,item,key] of [['plugin',entry,'pluginIds'],['mcp',service,'mcpIds']]) {
    const resolved={provider:'claude-code',...await market.resolve({...empty,[key]:[item.id]},'claude-code')};
    const employee=store.createAgent({name:`Inactive ${kind}`,status:'inactive',runtime:resolved});
    assert.throws(()=>store.removeExtension({kind,id:item.id,name:item.name}),/Inactive.*请先/);
    assert.equal(store.isExtensionRemoved(kind,item.id),false);
    store.updateAgent(employee.id,{runtime:{provider:'claude-code',...await market.resolve(empty,'claude-code')}});
    assert.equal(store.removeExtension({kind,id:item.id,name:item.name}).historyRetained,true);
    assert.throws(()=>store.createAgent({name:'Stale create',runtime:resolved}),/已删除/);
    assert.throws(()=>store.updateAgent(employee.id,{runtime:resolved}),/已删除/);
    assert.throws(()=>store.removeExtension({kind,id:item.id,name:item.name}),/已删除/);
    assert.equal(store.listAgents().find(item=>item.id===employee.id).runtime.extensionSelection[key].length,0);
    await selectedExtensions(resolved);
  }
  store.close();store=createStore({databasePath});
  assert.equal(store.isExtensionRemoved('plugin',entry.id),true);
  assert.equal(store.isExtensionRemoved('mcp',service.id),true);
  const events=store.snapshot().events.filter(item=>item.type==='configuration.extension_deleted');
  assert.equal(events.length,2);assert.ok(events.every(item=>item.actor.type==='human'));
});

test('communication applies extension removal without rebuilding native memory', async t => {
  const {root,market} = await fixture(t), entry = await install(market,root);
  const store = createStore(), employee = store.createAgent({name:'Market chat',role:'Review',runtime:{provider:'claude-code',...await market.resolve({pluginIds:[entry.id],mcpIds:[]},'claude-code')}});
  const chat = store.openCommunication({kind:'agent',targetId:employee.id});
  const send = content => store.sendCommunication(chat.id,{content,mentionAgentIds:[],clientRequestId:crypto.randomUUID()});
  send('first');
  const first = store.claimCommunication(chat.id), session = store.prepareCommunicationSession(chat.id,first.id,root);
  store.confirmCommunicationSession(chat.id,first.id,session.sessionId);
  store.completeCommunication(chat.id,first.id,'first reply');
  store.updateAgent(employee.id,{runtime:{provider:'claude-code',...await market.resolve({pluginIds:[],mcpIds:[]},'claude-code')}});
  send('second');
  const second = store.claimCommunication(chat.id), next = store.prepareCommunicationSession(chat.id,second.id,root);
  assert.equal(next.resume,true); assert.equal(next.sessionId,session.sessionId);
  assert.deepEqual(second.agentSnapshot.runtime.extensionSelection, { pluginIds: [], mcpIds: [] });
  assert.ok(store.getCommunication(chat.id).messages.some(message=>message.content==='first reply'));
});
