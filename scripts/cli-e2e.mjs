// Explicit isolated real-service CLI setup, shared by the real development E2E.
// Never uses the operator's default CLI session or database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function setupCliConfiguration({ root, api, page, username, password, repository }) {
  const origin = new URL(page.url()).origin;
  if (process.env.AGENTFORGE_DEVELOPMENT_E2E_RESUME) {
    const saved = JSON.parse(await readFile(join(root, 'cli-configuration-evidence.json'), 'utf8'));
    const agents = (await api('/api/agents')).agents, teams = (await api('/api/teams')).teams;
    const flows = (await api('/api/workflow-templates')).workflowTemplates;
    const result = { developer: agents.find(a => a.id === saved.developer), tester: agents.find(a => a.id === saved.tester), team: teams.find(t => t.id === saved.team), flow: flows.find(f => f.id === saved.flow) };
    assert.ok(Object.values(result).every(Boolean));
    assert.ok(saved.evidence.length >= 38 && saved.evidence.every(row => row.ok || [2, 3, 4].includes(row.code)));
    console.log('PASS preserved CLI configuration evidence; resume existing frozen task without reimport/reconfiguration');
    return result;
  }
  const sessionFile = join(root, 'cli-private', 'session.json'), evidence = [], textEvidence = [];
  const secret = randomBytes(20).toString('hex');
  async function cli(args, value, expected = 0, json = true) {
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [resolve('cli/main.mjs'), ...args, '--endpoint-file', join(root, 'desktop-endpoint.json'), '--session-file', sessionFile, ...(json ? ['--json'] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
      child.stdin.on('error', () => {});
      child.stdin.end(value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value));
    });
    assert.equal(result.code, expected, `${args[0]} ${args[1]}: ${result.stdout}`);
    assert.ok(![result.stdout, result.stderr].some(value => value.includes(password) || value.includes(secret)));
    const output = json ? JSON.parse(result.stdout) : { ok: expected === 0, data: expected === 0 ? result.stdout : result.stderr };
    if (json || expected === 0) assert.equal(result.stderr, '');
    else { assert.equal(result.stdout, ''); assert.match(result.stderr, /错误.*AUTH_REQUIRED/); assert.match(result.stderr, /处理建议/); }
    if (!json) textEvidence.push({ command: args.join(' '), ...result });
    evidence.push({ command: args.slice(0, 3).join(' '), format: json ? 'json' : 'text', code: result.code, ok: output.ok });
    return output.data;
  }
  const write = (group, operation, value, id, yes = false) => cli([group, operation, ...(id ? [id] : []), '--file', '-', ...(yes ? ['--yes'] : [])], value);
  const rootHelp = await cli([], undefined, 0, false);
  assert.match(rootHelp, /AI 团队操作系统/);
  assert.doesNotMatch(rootHelp, /典型交付流程|核心概念|JSON 输入模板|runtime\.extensionSelection/);
  const authHelp = await cli(['auth'], undefined, 0, false);
  assert.match(authHelp, /login/); assert.match(authHelp, /status/); assert.match(authHelp, /logout/);
  assert.doesNotMatch(authHelp, /runtime\.extensionSelection|JSON 输入模板/);
  const agentHelp = await cli(['agents', 'create', '--help'], undefined, 0, false);
  assert.match(agentHelp, /runtime\.extensionSelection\.pluginIds/);
  assert.match(agentHelp, /JSON 输入模板/);
  assert.doesNotMatch(agentHelp, /兼容旧|skillPaths|mcpConfigPaths|pluginPaths|pluginSources/);
  await cli(['agents', 'list'], undefined, 3, false);
  await cli(['agents', 'list'], undefined, 3);
  await cli(['auth', 'login', '--username', username, '--password-stdin'], password + '\n');
  assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(sessionFile, 'utf8')).includes(password));
  await cli(['auth', 'status']);
  assert.match(await cli(['auth', 'status'], undefined, 0, false), /CLI 会话有效/);
  assert.match(await cli(['runtimes', 'create', '--file', '-'], { name: 'CLI文本创建验证', provider: 'claude-code' }, 0, false), /已创建Runtime配置/);
  const textProfile = (await api('/api/settings/runtime-profiles')).profiles.find(item => item.name === 'CLI文本创建验证');
  assert.ok(textProfile); await cli(['runtimes', 'delete', textProfile.id, '--yes']);
  const connection = await write('runtimes', 'create', { name: 'CLI 实测 Claude', provider: 'claude-code' });
  const rejected = [];
  const beforeAgents = (await api('/api/agents')).agents.length, beforeProfiles = (await api('/api/settings/runtime-profiles')).profiles.length;
  const http = (path, method='GET', body) => page.evaluate(async ({path,method,body}) => {
    const response=await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  },{path,method,body});
  for (const key of ['skillPaths','mcpConfigPaths','pluginPaths','pluginSources','provider','model','executable','extensionManifest']) {
    const input={name:'拒绝探针',runtime:{profileId:connection.id,[key]:[]}};
    await cli(['agents','create','--file','-'],input,2);
    const response=await http('/api/agents','POST',input);
    assert.equal(response.status,400); rejected.push({key,status:response.status});
  }
  assert.equal((await api('/api/agents')).agents.length,beforeAgents);
  assert.equal((await api('/api/settings/runtime-profiles')).profiles.length,beforeProfiles,'rejected legacy input never creates a hidden connection');
  for (const [path,method,body] of [['/api/runtime/discovery','GET'],['/api/agents/unused/plugin-config','GET'],['/api/runtime/plugins/import','POST',{url:'https://example.invalid/never-clone.git'}]]) {
    assert.equal((await http(path,method,body)).status,404); rejected.push({path,status:404});
  }
  await writeFile(join(root,'current-configuration-rejections.json'),JSON.stringify(rejected,null,2));
  const defaultManager = (await cli(['agents', 'list', '--all'])).items.find(agent => agent.kind === 'manager');
  assert.ok(defaultManager);
  const publicImport = process.env.AGENTFORGE_CLI_PUBLIC_IMPORT === '1';
  const fixture=JSON.parse(await readFile(join(root,'plugin-fixture.json'),'utf8'));
  const source=publicImport?{url:'https://github.com/anthropics/skills.git'}:{path:fixture.repo};
  const installed=await write('plugins','import',source),plugin=installed.plugins[0];assert.ok(plugin);
  await cli(['plugins','list','--all']);
  assert.equal((await cli(['plugins','get',plugin.id])).components.skills.length,plugin.components.skills);
  const mcp=await write('mcps','create',{name:'CLI配置验收工具',description:'Only configured here',content:JSON.stringify({mcpServers:{cli_fixture:{command:process.execPath,args:[resolve('scripts/marketplace-probe-mcp.mjs'),join(root,'cli-mcp.log'),'fixture'],env:{CLI_SYNTHETIC_SECRET:secret}}}})});
  assert.ok(!(JSON.stringify(await cli(['mcps','get',mcp.id]))).includes(secret));
  const {agent:auxiliary}=await write('agents','create',{name:'CLI扩展配置验收',runtime:{profileId:connection.id,extensionSelection:{pluginIds:[plugin.id],mcpIds:[mcp.id]}}});
  let read=await cli(['agents','get',auxiliary.id]);
  assert.deepEqual(read.runtime.extensionSelection,{pluginIds:[plugin.id],mcpIds:[mcp.id]});
  await write('agents','update',{runtime:{profileId:connection.id}},auxiliary.id);
  assert.deepEqual((await cli(['agents','get',auxiliary.id])).runtime.extensionSelection,read.runtime.extensionSelection);
  await cli(['agents','update',auxiliary.id,'--file','-'],{mcpJson:'{"mcpServers":{}}'},2);
  await cli(['agents','update',auxiliary.id,'--file','-'],{runtime:{extensionSelection:{pluginIds:[],mcpIds:[],skillIds:[]}}},2);
  await write('agents','update',{runtime:{extensionSelection:{pluginIds:[],mcpIds:[]}}},auxiliary.id);
  await cli(['runtimes', 'delete', connection.id, '--yes'], undefined, 4);
  const profiles = (await cli(['runtimes', 'list', '--all'])).items;
  const referencedDefault = profiles.find(item => item.provider === 'claude-code' && item.id !== connection.id && item.employeeCount > 0);
  assert.ok(referencedDefault);
  await cli(['runtimes', 'delete', referencedDefault.id, '--yes'], undefined, 4);
  const unusedDefault = profiles.find(item => item.provider === 'codex' && item.employeeCount === 0);
  assert.ok(unusedDefault, 'fresh Codex example is unreferenced, not intrinsically protected');
  await cli(['runtimes', 'delete', unusedDefault.id, '--yes']);
  await cli(['runtimes', 'get', unusedDefault.id], undefined, 4);
  const disposable = await write('runtimes', 'create', { name: 'CLI可删除连接', provider: 'claude-code' });
  await cli(['runtimes', 'delete', disposable.id, '--yes']);
  await cli(['runtimes', 'get', disposable.id], undefined, 4);
  const employee = (name, responsibility) => write('agents', 'create', { name, kind: 'developer', repository, capabilities: ['Node.js ESM', '真实测试', '内容工具'], systemPrompt: `${responsibility}：实际执行、核验文件与测试，明确说明失败。只提交本地commit，不push或部署。`, runtime: { profileId: connection.id, extensionSelection: { mcpIds: [], pluginIds: [] } } });
  const { agent: developer } = await employee('CLI真实代码开发', '研发工程师');
  const { agent: tester } = await employee('CLI独立代码核验', '测试工程师');
  const { team } = await write('teams', 'create', { name: 'CLI代码开发实测团队', managerAgentId: defaultManager.id, memberAgentIds: [developer.id, tester.id] });
  await write('teams', 'update', { mission: '通过CLI配置，真实开发并独立核验' }, team.id);
  assert.equal((await cli(['teams', 'get', team.id])).memberAgentIds.length, 2);
  const definition = { name: 'CLI真实开发与独立测试', nodes: [
    { id: 'develop', title: '实现任务搜索工具', staffingGuidance: '选择擅长Node.js ESM、内容工具、真实执行测试的开发成员', dependsOn: [], artifactPaths: ['docs/development/'], deliverable: '在绑定仓库实现 task-search.mjs 和 task-search.test.mjs，实际node --test和本地commit（不push），docs/development/report.md记录命令/SHA/失败探针。' },
    { id: 'verify', title: '独立边界验证', staffingGuidance: '选择非作者、能独立执行Node.js测试的成员', dependsOn: ['develop'], handoffFrom: ['develop'], artifactPaths: ['docs/verification/'], deliverable: '独立读取源码并实际运行测试，核验空数组、非法输入、中文、状态/团队交集，docs/verification/report.md记录证据。' }
  ] };
  const { workflowTemplate: flow } = await write('workflows', 'create', definition);
  for (const key of ['ownerRole','repositoryPath','reuseOwnerFrom']) {
    const invalid={...definition,name:'拒绝工作流探针',nodes:[{...definition.nodes[0],[key]:'unsupported'}]};
    await cli(['workflows','create','--file','-'],invalid,2);
    assert.equal((await http('/api/workflow-templates','POST',invalid)).status,400);
  }
  await write('workflows', 'update', { ...definition, description: 'CLI创建并更新，真实执行验收' }, flow.id);
  assert.equal((await cli(['workflows', 'get', flow.id])).nodes.length, 2);
  assert.match(await cli(['agents', 'get', developer.id], undefined, 0, false), /执行与协作提示词/);
  assert.match(await cli(['teams', 'list', '--search', 'CLI代码'], undefined, 0, false), /CLI代码开发实测团队/);
  assert.match(await cli(['workflows', 'get', flow.id], undefined, 0, false), /staffingGuidance/);
  const { workflowTemplate: scratch } = await write('workflows', 'create', { ...definition, name: 'CLI临时删除验证' });
  await cli(['workflows', 'delete', scratch.id, '--yes']);
  const { agent: scratchAgent } = await write('agents', 'create', { name: 'CLI可删除员工', runtime: { profileId: connection.id } });
  const { team: scratchTeam } = await write('teams', 'create', { name: 'CLI可删除团队', managerAgentId: defaultManager.id, memberAgentIds: [scratchAgent.id] });
  await cli(['agents', 'delete', scratchAgent.id, '--yes'], undefined, 4);
  await cli(['teams', 'delete', scratchTeam.id, '--yes']);
  await cli(['agents', 'delete', scratchAgent.id, '--yes']);
  await cli(['agents', 'get', scratchAgent.id], undefined, 4);
  await page.goto(origin + '/settings/runtime');
  await page.locator(`[data-runtime-profile="${connection.id}"]`).waitFor();
  assert.equal(await page.locator('[data-runtime-profile][open]').count(), 0);
  assert.equal(await page.locator('[data-settings-page="runtime"]').innerText(), 'Runtime');
  assert.equal(await page.getByText('本机执行说明与版本', { exact: true }).count(), 0);
  const card = page.locator(`[data-runtime-profile="${connection.id}"]`);
  await card.locator('summary').click();
  assert.equal(await card.locator('[data-delete-runtime]').isDisabled(), true);
  const fresh = page.locator('[data-runtime-profile="new"]'); await fresh.locator('summary').click();
  await fresh.locator('[name="name"]').fill('UI可删除连接');
  await fresh.getByRole('button', { name: '添加配置', exact: true }).click();
  const created = await api('/api/settings/runtime-profiles');
  const uiProfile = created.profiles.find(item => item.name === 'UI可删除连接'); assert.ok(uiProfile);
  const uiCard = page.locator(`[data-runtime-profile="${uiProfile.id}"]`);
  await uiCard.locator('summary').click(); await uiCard.locator('[data-delete-runtime]').click();
  await page.locator('[data-cancel-runtime-delete]').click();
  assert.ok((await cli(['runtimes', 'list', '--all'])).items.some(item => item.id === uiProfile.id));
  await uiCard.locator('[data-delete-runtime]').click(); await page.locator('[data-confirm-runtime-delete]').click();
  await uiCard.waitFor({ state: 'detached' });
  await cli(['runtimes', 'get', uiProfile.id], undefined, 4);
  await page.screenshot({ path: join(root, 'cli-runtime-collapsed.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(root, 'cli-runtime-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await cli(['auth', 'logout']);
  await cli(['agents', 'list'], undefined, 3);
  await cli(['agents', 'list'], undefined, 3, false);
  await writeFile(join(root, 'cli-text-evidence.json'), JSON.stringify(textEvidence, null, 2));
  const skillCount=installed.plugins.reduce((count,item)=>count+item.components.skills,0);
  await writeFile(join(root, 'cli-configuration-evidence.json'), JSON.stringify({ evidence, publicImport, plugin: plugin.id, skills: skillCount, plugins: installed.plugins.length, mcp: mcp.id, developer: developer.id, tester: tester.id, team: team.id, flow: flow.id, noSecretInOutput: true }, null, 2));
  console.log(`PASS real CLI configuration: ${evidence.length} subprocess commands; ${installed.plugins.length} ${publicImport ? 'public' : 'isolated real-Git'} plugins / ${skillCount} Skills; UI deletion/collapse/narrow verified`);
  return { developer, tester, team, flow };
}
