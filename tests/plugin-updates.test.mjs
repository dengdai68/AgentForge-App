import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createStore} from '../server/store.mjs';
import {createMarketplace} from '../server/runtime/marketplace.mjs';
import {remotePluginRevision} from '../server/runtime/configuration.mjs';
import {createPluginUpdates,pluginUpdateSources,pluginUpdateIntervalMs} from '../server/plugin-updates.mjs';

const pause=ms=>new Promise(done=>setTimeout(done,ms));

test('update period is validated atomically, persisted, and reschedules without a network call',async t=>{
  const root=await mkdtemp(join(tmpdir(),'af-period-')),store=createStore({databasePath:join(root,'state.sqlite')});t.after(()=>{store.close();return rm(root,{recursive:true,force:true})});
  let calls=0;const updater=createPluginUpdates({getStore:()=>store,marketplace:{catalog:async()=>{calls++;return {plugins:[]}}}});t.after(()=>updater.stop());
  assert.deepEqual(store.getPluginUpdateSettings(),{enabled:true,intervalMinutes:2});updater.start();
  const value=updater.configure({intervalMinutes:7});assert.equal(value.intervalMs,420000);assert.ok(Math.abs(Date.parse(value.nextCheckAt)-Date.now()-420000)<1000);
  for(const input of [{},[],null,{enabled:0},{intervalMinutes:0},{intervalMinutes:1441},{intervalMinutes:1.5},{intervalMinutes:'2'},{enabled:false,intervalMinutes:0},{extra:true}])assert.throws(()=>updater.configure(input));
  assert.deepEqual(store.getPluginUpdateSettings(),{enabled:true,intervalMinutes:7});assert.equal(calls,0);
  updater.configure({enabled:false});assert.equal(updater.status().nextCheckAt,null);await updater.check();assert.equal(calls,1);assert.equal(updater.status().nextCheckAt,null);
});

import {gitOrigin} from './plugin-git-fixture.mjs';

test('real Git commit polling updates selected plugins, retains frozen files and skips deleted plugins/MCPs',async t=>{
  const origin=await gitOrigin(t);
  await mkdir(join(origin.source,'.claude-plugin'));await mkdir(join(origin.source,'alpha/.claude-plugin'),{recursive:true});await mkdir(join(origin.source,'alpha/skills/check'),{recursive:true});await mkdir(join(origin.source,'beta/.claude-plugin'),{recursive:true});
  await writeFile(join(origin.source,'.claude-plugin/marketplace.json'),JSON.stringify({name:'fixture',plugins:[{name:'alpha',source:'./alpha'},{name:'beta',source:'./beta'}]}));
  await writeFile(join(origin.source,'alpha/.claude-plugin/plugin.json'),JSON.stringify({name:'alpha',version:'1.0.0',mcpServers:{probe:{command:'node',args:['--version']}}}));
  await writeFile(join(origin.source,'beta/.claude-plugin/plugin.json'),' {"name":"beta"}');
  await writeFile(join(origin.source,'alpha/skills/check/SKILL.md'),'---\nname: check\ndescription: test\n---\nBEFORE');
  const initialRevision=await origin.commit();await origin.git('-C',join(origin.root,'repos/repo.git'),'symbolic-ref','HEAD','refs/heads/main');
  await origin.git('-C',origin.source,'branch','stable');await origin.git('-C',origin.source,'tag','-a','v1','-m','fixture',initialRevision);await origin.git('-C',origin.source,'push','origin','stable','v1');
  const market=createMarketplace(join(origin.root,'runtime')),store=createStore({databasePath:join(origin.root,'state.sqlite')});t.after(()=>store.close());
  const installed=await market.import({url:origin.url}),old=installed.plugins.find(p=>p.name==='alpha'),beta=installed.plugins.find(p=>p.name==='beta');
  store.removeExtension({kind:'plugin',id:beta.id,name:beta.name});
  const frozen=await market.resolve({pluginIds:[old.id],mcpIds:installed.mcps.map(m=>m.id)},'codex');
  const employee=store.createAgent({name:'原生更新验证',runtime:{provider:'codex',...frozen}});
  const updater=createPluginUpdates({getStore:()=>store,marketplace:market,intervalMs:process.env.AGENTFORGE_PLUGIN_UPDATE_SCHEDULE_REAL==='1'?pluginUpdateIntervalMs:500});t.after(()=>updater.stop());
  assert.equal(updater.status().enabled,true);assert.equal(pluginUpdateIntervalMs,120000);
  await writeFile(join(origin.source,'alpha/skills/check/SKILL.md'),'---\nname: check\ndescription: test\n---\nAFTER');
  const revision=await origin.commit();assert.equal(await remotePluginRevision({url:origin.url}),revision);
  assert.equal(await remotePluginRevision({url:origin.url,ref:'stable'}),initialRevision);assert.equal(await remotePluginRevision({url:origin.url,ref:'v1'}),initialRevision);assert.equal(await remotePluginRevision({url:origin.url,sha:initialRevision}),initialRevision);
  const start=Date.now();updater.start();
  for(let i=0;i<1500 && !updater.status().lastCheckedAt;i++)await pause(100);
  const result=updater.status().lastResult;assert.equal(result.updatedPlugins,1);assert.deepEqual(result.errors,[]);
  if(process.env.AGENTFORGE_PLUGIN_UPDATE_SCHEDULE_REAL==='1')assert.ok(Date.now()-start>=120000);
  updater.configure({enabled:false});
  const updated=store.listAgents().find(a=>a.id===employee.id).runtime;
  assert.notEqual(updated.extensionSelection.pluginIds[0],old.id);assert.deepEqual(updated.extensionSelection.mcpIds,frozen.extensionSelection.mcpIds);
  assert.match(await readFile(updated.skillPaths[0],'utf8'),/AFTER/);assert.match(await readFile(frozen.skillPaths[0],'utf8'),/BEFORE/);
  assert.equal((await market.mcpCatalog()).entries.length,installed.mcps.length);
  assert.equal((await readdir(join(origin.root,'runtime/plugins'))).length,1,'automatic source checkouts are disposable; initial manual source remains');
  assert.deepEqual((await market.catalog()).plugins.filter(p=>!store.isExtensionRemoved('plugin',p.id)).map(p=>p.name),['alpha']);
  assert.equal((await updater.check()).updatedPlugins,0);
  // Same manifest version, incompatible new Hook: no partial employee update.
  await writeFile(join(origin.source,'alpha/.claude-plugin/plugin.json'),JSON.stringify({name:'alpha',version:'1.0.0',hooks:{CwdChanged:[{hooks:[{type:'command',command:'true'}]}]}}));await origin.commit();
  assert.equal((await updater.check()).errors.length,1);assert.deepEqual(store.listAgents().find(a=>a.id===employee.id).runtime,updated);
  await writeFile(join(origin.source,'alpha/.claude-plugin/plugin.json'),' {"name":"alpha","version":"1.0.1"}');await origin.commit();assert.equal((await updater.check()).updatedPlugins,1);
});

test('checks never overlap, disable persists and stopping aborts in-flight network work',async t=>{
  const root=await mkdtemp(join(tmpdir(),'af-update-state-')),databasePath=join(root,'state.sqlite');t.after(()=>rm(root,{recursive:true,force:true}));let store=createStore({databasePath});
  const marketplace={catalog:async()=>({plugins:[{id:'installed',name:'probe',source:{url:'https://example.invalid/repo.git',revision:'a'}}]})};
  let calls=0;const updater=createPluginUpdates({getStore:()=>store,marketplace,probe:async(_,{signal})=>{calls++;await new Promise(done=>signal.addEventListener('abort',done,{once:true}));throw new Error('cancelled')}});
  const first=updater.check();assert.equal(first,updater.check());await pause(10);assert.equal(calls,1);updater.configure({enabled:false,intervalMinutes:3});updater.stop();await first;assert.equal(updater.status().running,false);assert.equal(updater.status().nextCheckAt,null);
  store.close();store=createStore({databasePath});assert.deepEqual(store.getPluginUpdateSettings(),{enabled:false,intervalMinutes:3});store.close();
});

test('origin tracking groups shared markets and preserves pinned dependency refs',()=>{
  const groups=pluginUpdateSources([{name:'a',source:{url:'https://git.invalid/child.git',ref:'stable',sha:'f'.repeat(40),revision:'f'.repeat(40),origin:{url:'https://git.invalid/market.git',revision:'root'}}},{name:'b',source:{url:'https://git.invalid/market.git',revision:'root'}},{name:'local',source:{url:'file:///tmp/example',revision:'local'}}]);
  assert.equal(groups.length,1);assert.equal(groups[0].plugins.length,2);assert.equal(groups[0].specs.length,2);assert.equal(groups[0].specs.find(s=>s.ref==='stable').sha,'f'.repeat(40));
});
test('a network failure in one origin does not block the remaining origins',async t=>{
  const root=await mkdtemp(join(tmpdir(),'af-update-error-')),store=createStore({databasePath:join(root,'state.sqlite')});t.after(()=>{store.close();return rm(root,{recursive:true,force:true})});
  let calls=0;
  const marketplace={catalog:async()=>({plugins:['broken','healthy'].map(name=>({id:name,name,source:{url:`https://${name}.invalid/repo.git`,revision:'current'}}))})};
  const updater=createPluginUpdates({getStore:()=>store,marketplace,probe:async spec=>{calls++;if(spec.url.includes('broken'))throw Error('fixture network failure');return 'current'}});t.after(()=>updater.stop());
  const result=await updater.check();assert.equal(calls,2);assert.equal(result.checkedSources,2);assert.equal(result.errors.length,1);assert.equal(result.updatedPlugins,0);
});
test('a shared failing dependency is probed only once per cycle across origins',async t=>{
  const root=await mkdtemp(join(tmpdir(),'af-shared-source-')),store=createStore({databasePath:join(root,'state.sqlite')});t.after(()=>{store.close();return rm(root,{recursive:true,force:true})});
  const counts=new Map(),marketplace={catalog:async()=>({plugins:['a','b'].map(name=>({id:name,name,source:{url:'https://shared.invalid/plugin.git',revision:'old',origin:{url:`https://${name}.invalid/market.git`,revision:'current'}}}))})};
  const updater=createPluginUpdates({getStore:()=>store,marketplace,probe:async spec=>{counts.set(spec.url,(counts.get(spec.url)||0)+1);if(spec.url.includes('shared'))throw Error('offline');return 'current'}});t.after(()=>updater.stop());
  assert.equal((await updater.check()).errors.length,2);assert.equal(counts.get('https://shared.invalid/plugin.git'),1);
});
