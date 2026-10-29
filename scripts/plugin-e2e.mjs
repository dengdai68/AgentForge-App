// Opt-in real Providers and handwritten extensions. All paths are disposable.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,stat,symlink,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runClaudeCodeCli} from '../server/runtime/local-cli.mjs';
import {createMarketplace} from '../server/runtime/marketplace.mjs';

export async function preparePluginFixture(root) {
  if(process.env.AGENTFORGE_DEVELOPMENT_E2E_RESUME) return {env:{},close(){}};
  const repo=join(root,'plugin-source'),proof=`plugin-${randomUUID()}`,markers=[`skill-${randomUUID()}`,`skill-${randomUUID()}`],log=join(root,'plugin-mcp.log'),hookLog=join(root,'plugin-hook.log');
  for(const path of ['.claude-plugin','agents','hooks','scripts']) await mkdir(join(repo,path),{recursive:true});
  await writeFile(join(repo,'.claude-plugin/plugin.json'),JSON.stringify({name:'verification-kit',description:'手写双 Skill、Subagent、Hook 与可拆分 MCP 插件',mcpServers:{selected_proof:{command:process.execPath,args:[resolve('scripts/marketplace-probe-mcp.mjs'),log,proof]}}}));
  for(let i=0;i<2;i++) {
    const dir=join(repo,'skills',`check-${i+1}`);await mkdir(dir,{recursive:true});
    const content=`---\nname: check-${i+1}\ndescription: Local verification\n---\nFor this development validation include marker ${markers[i]} in docs/development/report.md. Read this selected skill; do not inspect other employee configurations.\n`;
    if(i===0){await mkdir(join(repo,'shared'));await writeFile(join(repo,'shared/linked-skill.md'),content);await symlink('../../shared/linked-skill.md',join(dir,'SKILL.md'));}
    else await writeFile(join(dir,'SKILL.md'),content);
  }
  await writeFile(join(repo,'agents/proof-reader.md'),'---\nname: proof-reader\ndescription: Return a plugin component verification marker\ntools: Read\n---\nReturn SUBAGENT-NATIVE-PROOF exactly.');
  await writeFile(join(repo,'scripts/start.mjs'),`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(hookLog)},'started\\n');`);
  await writeFile(join(repo,'hooks/hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:`${process.execPath} "\${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs"`}]}]}}));
  await writeFile(join(root,'plugin-fixture.json'),JSON.stringify({repo,proof,markers,log,hookLog}));
  return {env:{},close(){}};
}
const fileExists=path=>stat(path).then(()=>true,()=>false);
export async function setupPluginMarketplace({page,api,root,developer,tester,manager}) {
  const fixture=JSON.parse(await readFile(join(root,'plugin-fixture.json'),'utf8'));
  if(process.env.AGENTFORGE_DEVELOPMENT_E2E_RESUME) {
    const saved=JSON.parse(await readFile(join(root,'plugin-install-evidence.json'),'utf8'));
    return deliveryCheck({api,root,developer,tester,fixture,plugin:saved.plugin});
  }
  await page.goto(new URL(page.url()).origin+'/marketplace');
  await page.locator('[data-install-plugin]').click();
  await page.locator('#market-source').fill('http://example.com/unsafe.git');
  assert.equal(await page.locator('[name=trusted]').count(),0);
  assert.equal(await page.locator('[data-read-plugin-source]').count(),0);
  await page.locator('#market-entry-form [type=submit]').click();
  await page.locator('[data-market-error]').filter({hasText:'HTTPS'}).waitFor();
  await page.locator('[name=sourceType][value=local]').check();
  await page.locator('#market-source').fill(fixture.repo);
  await page.locator('#market-entry-form [type=submit]').click();
  await page.locator('#market-entry-form').waitFor({state:'detached'});
  const catalog=await api('/api/runtime/marketplace'),plugin=catalog.plugins.find(item=>item.name==='verification-kit');
  assert.ok(plugin);assert.equal(plugin.components.skills,2);assert.equal(plugin.components.agents,1);assert.equal(plugin.components.hooks,1);
  assert.equal(catalog.entries,undefined);assert.equal(plugin.skillIds,undefined);
  assert.equal(await fileExists(fixture.hookLog),false,'install never executes hook');
  await page.locator('[data-extension-detail]').first().click();
  await page.getByRole('tab',{name:/Subagent/}).click();
  assert.match(await page.locator('[role=tabpanel]').textContent(),/proof-reader/);
  await page.getByRole('tab',{name:/Hook/}).click();
  assert.match(await page.locator('[role=tabpanel]').textContent(),/SessionStart/);
  await page.screenshot({path:'screenshots/plugin-detail-current.png'});
  await page.locator('#modal-close').click();
  await page.goto(new URL(page.url()).origin+'/mcp-marketplace');
  for(const name of ['unselected_proof']) {
    await page.locator('[data-add-mcp]').click();
    await page.locator('#mcp-market-form [name=name]').fill(name);
    assert.equal(await page.locator('#mcp-market-form [name=trusted]').count(),0);
    await page.locator('#mcp-market-form [name=content]').fill('{bad');
    await page.locator('#mcp-market-form [type=submit]').click();
    await page.locator('[data-market-error]').filter({hasText:'JSON'}).waitFor();
    await page.locator('#mcp-market-form [name=content]').fill(JSON.stringify({mcpServers:{[name]:{command:process.execPath,args:[resolve('scripts/marketplace-probe-mcp.mjs'),name==='selected_proof'?fixture.log:join(root,'unselected-mcp.log'),fixture.proof]}}}));
    await page.locator('#mcp-market-form [type=submit]').click();
    await page.locator('#mcp-market-form').waitFor({state:'detached'});
  }
  const services=(await api('/api/runtime/mcp-marketplace')).entries,selected=services.find(item=>item.name==='verification-kit · selected_proof');
  assert.ok(selected,'bundled MCP is installed independently from the plugin');
  await page.locator('[data-extension-detail]').first().click();
  await page.locator('.mcp-json-detail').waitFor();assert.match(await page.locator('.mcp-json-detail').textContent(),/mcpServers/);
  await page.locator('#modal-close').click();
  for(const [index,member] of [developer,tester,manager].entries()) {
    await page.goto(new URL(page.url()).origin+'/agents');
    await page.locator(`[data-edit-agent="${member.id}"]`).click();
    await page.waitForFunction(()=>document.querySelector('[data-selection-state]')?.textContent.includes('历史任务不变'));
    assert.equal(await page.locator('#employee-mcp-json').count(),0);assert.equal(await page.locator('[data-skill]').count(),0);
    if(index===0) {
      await page.locator('#employee-plugin-search').fill('verification');
      await page.locator(`[data-add-extension="${plugin.id}"]`).click();
      await page.locator('#employee-mcp-search').fill('selected_proof');
      await page.locator(`[data-add-extension="${selected.id}"]`).click();
      await page.locator(`[data-remove-extension="${selected.id}"]`).click();
      await page.locator('#employee-mcp-search').fill('selected_proof');
      await page.locator(`[data-add-extension="${selected.id}"]`).click();
      await page.screenshot({path:'screenshots/employee-plugin-current.png'});
    }
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await page.locator('#agent-form').waitFor({state:'detached'});
  }
  const members=(await api('/api/agents')).agents;
  const configured=members.find(item=>item.id===developer.id);
  const installed=await createMarketplace(join(root,'runtime')).resolve({pluginIds:[plugin.id],mcpIds:[]},'claude-code');
  assert.equal(installed.skillPaths.length,2);
  for(const path of installed.skillPaths)assert.equal((await lstat(path)).isSymbolicLink(),false,'installed Skill links materialize into regular immutable files');
  assert.deepEqual(configured.runtime.extensionSelection,{pluginIds:[plugin.id],mcpIds:[selected.id]});
  for(const member of [tester,manager]) assert.deepEqual(members.find(item=>item.id===member.id).runtime.extensionSelection,{pluginIds:[],mcpIds:[]});
  // A second real employee invocation with no extensions must not start the installed MCP or Hook.
  const dir=join(root,'empty-employee-probe');await mkdir(dir,{recursive:true});
  const empty=members.find(item=>item.id===tester.id).runtime,events=[];
  await runClaudeCodeCli({runtime:empty,workspacePath:dir,traceDirectory:dir,finalPath:join(dir,'final.json'),runId:'unselected-employee',prompt:'Reply only OK. Do not use tools, files, delegation or scheduled wakeups.',onEvent:async event=>events.push(event)});
  assert.equal(await fileExists(fixture.log),false);assert.equal(await fileExists(fixture.hookLog),false);
  assert.ok(!events.some(event=>event.data?.toolName?.includes('read_validation_code')));
  await api(`/api/agents/${developer.id}`,{systemPrompt:developer.systemPrompt+'\n扩展验收：实际读取所有显式选择的 Skill，并调用 selected_proof 的 read_validation_code MCP。调用 verification-kit:proof-reader 子代理，等待它完成，不使用 ScheduleWakeup。将 MCP 返回的 verificationCode、两个 Skill marker、子代理实际结果写入 docs/development/report.md。不要查看其他员工配置。'},'PUT');
  await writeFile(join(root,'plugin-install-evidence.json'),JSON.stringify({plugin,selectedMcp:selected.id,emptyEmployeeVerified:true}));
  console.log('PASS manual plugin/MCP UI install, detail, searchable selection, removal, and real unselected employee isolation');
  return deliveryCheck({api,root,developer,tester,fixture,plugin});
}
function deliveryCheck({api,root,developer,tester,fixture,plugin}) {
  return async (workspace,executionEvidence)=>{
    const report=workspace.artifacts.filter(item=>item.name==='docs/development/report.md' && !item.deleted).sort((a,b)=>b.version-a.version)[0];assert.ok(report);
    const content=(await api(`/api/runs/${workspace.run.id}/artifacts/${report.id}/content`)).content;
    for(const marker of [...fixture.markers,fixture.proof,'SUBAGENT-NATIVE-PROOF']) assert.ok(content.includes(marker),'report contains real extension proof');
    assert.match(await readFile(fixture.log,'utf8'),/called/);assert.match(await readFile(fixture.hookLog,'utf8'),/started/);
    assert.equal(await fileExists(join(root,'unselected-mcp.log')),false);
    const events=(await api(`/api/runs/${workspace.run.id}/console?agentId=${developer.id}&limit=500`)).events;
    assert.ok(events.some(event=>event.data?.toolName?.includes('read_validation_code')));
    assert.ok(events.some(event=>event.data?.toolName==='Agent'));
    const other=(await api(`/api/runs/${workspace.run.id}/console?agentId=${tester.id}&limit=500`)).events;
    assert.ok(!other.some(event=>event.data?.toolName?.includes('read_validation_code')));
    assert.ok(executionEvidence.some(event=>event.memberId===developer.id && event.fields.input?.text.includes('SKILL.md')));
    await writeFile(join(root,'plugin-task-evidence.json'),JSON.stringify({passed:true,runId:workspace.run.id,pluginId:plugin.id,report:report.id,selectedMcpCalled:true,subagentCalled:true,hookExecuted:true,unselectedMcpStarted:false}));
  };
}
