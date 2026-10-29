import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, stat, writeFile, chmod, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRuntimeConfiguration, parseMcpJson, readPluginCatalog, gitPluginSource } from "../server/runtime/configuration.mjs";
import { createCatalogFixtureStore as createStore } from "./fixture-store.mjs";
import { runClaudeCodeCli, runCodexCli, separateRuntimeSession, runtimeFailureSummary, runtimeFailureDetail, retryableRuntimeFailure, executionContent, promptSnapshot } from "../server/runtime/local-cli.mjs";
const codexProbeFixture = 'if(process.argv.includes("features")){console.log("skip_host_skill_discovery stable false");process.exit(0);}if(process.argv.includes("mcp")&&process.argv.includes("list")){console.log("[]");process.exit(0);}\n';

test("dispatch prompt snapshots keep business text but redact credential shapes", () => {
  const snapshot = promptSnapshot('你是「员工」。\n任务：展示优化\napi_key: PROMPT_SECRET_SENTINEL\nghp_abcdefghijklmnopqrstuv\n-----BEGIN PRIVATE KEY-----\nKEY_SENTINEL\n-----END PRIVATE KEY-----\nhttps://user:PASS_SENTINEL@host/repo.git\n正常业务文本');
  assert.equal(snapshot.kind, "prompt-snapshot");
  assert.match(snapshot.prompt.text, /展示优化/);
  assert.match(snapshot.prompt.text, /正常业务文本/);
  assert.doesNotMatch(snapshot.prompt.text, /PROMPT_SECRET_SENTINEL|KEY_SENTINEL|PASS_SENTINEL|ghp_abcdefghijkl/);
  assert.equal(snapshot.prompt.redacted, true);
  assert.equal(snapshot.prompt.truncated, false);
  const clean = promptSnapshot('没有任何凭据形态的普通提示词');
  assert.equal(clean.prompt.redacted, false);
  const huge = promptSnapshot('提示'.repeat(200000));
  assert.equal(huge.prompt.truncated, true);
  assert.ok(Buffer.byteLength(huge.prompt.text, "utf8") <= 150003);
  assert.ok(JSON.stringify(huge).length <= 300000, "snapshot JSON stays inside the run-files size fence");
});

test("prompt snapshot budget includes JSON escaping and envelope bytes", () => {
  for (const input of ['"'.repeat(150000), '\\'.repeat(160000), '😀"\n'.repeat(100000)]) {
    const snapshot = promptSnapshot(input);
    assert.equal(snapshot.prompt.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 300000);
    assert.ok(!snapshot.prompt.text.includes("\uFFFD"));
  }
});

test("execution content is bounded, redacted and separated from durable event metadata", () => {
  const content = executionContent({ text: 'hello <script>alert(1)</script>\nPRIVATE PROMPT\nghp_abcdefghijklmnopqrstuv', input: { command: 'node --test', token: 'TOKEN_SENTINEL' }, output: 'Authorization: SECRET_SENTINEL\n-----BEGIN PRIVATE KEY-----\nKEY_SENTINEL\n-----END PRIVATE KEY-----\n' + 'x'.repeat(13000), thinking: 'Check edge cases' }, 'PRIVATE PROMPT');
  assert.match(content.fields.input.text, /node --test/);
  assert.equal(content.fields.output.truncated, true);
  assert.equal(content.fields.output.text.length, 12000);
  assert.doesNotMatch(JSON.stringify(content), /PRIVATE PROMPT|TOKEN_SENTINEL|SECRET_SENTINEL|KEY_SENTINEL|ghp_abcdefghijkl/);
  const separated = separateRuntimeSession({ data: { auditVersion: 2, sessionId: 'private-session' }, content });
  assert.equal(separated.content, content);
  assert.equal(separated.auditEvent.content, undefined);
  assert.equal(separated.auditEvent.data.sessionId, undefined);
  const secrets = executionContent({ output: 'AWS_SECRET_ACCESS_KEY=ENV_SENTINEL\nexport CUSTOM_ACCESS_TOKEN="ENV_SENTINEL"\n--password FLAG_SENTINEL\nnormal output', input: { privateKey: 'KEY_SENTINEL' } });
  assert.doesNotMatch(JSON.stringify(secrets), /ENV_SENTINEL|FLAG_SENTINEL|KEY_SENTINEL/);
  assert.match(secrets.fields.output.text, /normal output/);
});

test("Claude preserves every public block and failed tool result without leaking user echoes", async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-content-blocks-'));
  try {
    const executable = join(root, 'fixture.mjs'), events = [];
    await writeFile(executable, `#!/usr/bin/env node
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'thinking',thinking:'Check input shape',signature:'PRIVATE_SIGNATURE'},{type:'text',text:'I will run tests.'},{type:'tool_use',id:'one',name:'Bash',input:{command:'node --test'}},{type:'tool_use',id:'two',name:'Read',input:{file_path:'src/app.js'}}]}}));
console.log(JSON.stringify({type:'user',message:{content:[{type:'text',text:'PRIVATE_USER_ECHO'},{type:'tool_result',tool_use_id:'one',is_error:true,content:'Error: expected 2 got 1'},{type:'tool_result',tool_use_id:'two',content:'export const app = 1;'}]}}));
console.log(JSON.stringify({type:'result',structured_output:{ok:true}}));`);
    await chmod(executable, 0o755);
    await runClaudeCodeCli({ runtime: { executable }, workspacePath: root, traceDirectory: root, finalPath: join(root,'final.json'), outputSchema: {}, prompt: 'task instructions', runId: 'blocks', onEvent: async event => events.push(event) });
    assert.equal(events.filter(e => e.data.toolUseId).length, 2);
    assert.equal(events.filter(e => e.data.toolResultId).length, 2);
    assert.equal(events.find(e => e.data.toolResultId === 'one').data.status, 'failed');
    assert.equal(events.find(e => e.data.toolResultId === 'one').content.fields.output.text, 'Error: expected 2 got 1');
    assert.ok(events.some(e => e.content?.fields.thinking?.text === 'Check input shape'));
    assert.ok(events.some(e => e.content?.fields.text?.text === 'I will run tests.'));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SIGNATURE|PRIVATE_USER_ECHO/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing CLI gives actionable safe failure instead of a generic retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-missing-cli-")), events = [];
  try {
    await assert.rejects(runClaudeCodeCli({ runtime: { executable: join(root, "SECRET_SENTINEL") }, workspacePath: root, traceDirectory: root, outputSchema: {}, prompt: "private prompt", runId: "missing-cli", onEvent: async e => events.push(e) }), e => {
      assert.match(e.message, /spawn .*SECRET_SENTINEL ENOENT/);
      assert.doesNotMatch(e.message, /private prompt/);
      assert.equal(retryableRuntimeFailure(e), false);
      return true;
    });
    for (const text of ["401 not logged in token=SECRET", "ECONNREFUSED secret=SECRET", "unknown option SECRET", "EACCES SECRET"]) {
      const safe = runtimeFailureSummary(text);
      assert.doesNotMatch(safe, /SECRET/);
      assert.equal(runtimeFailureSummary(safe), safe);
      assert.doesNotMatch(safe, /Provider 执行失败/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('original errors retain actionable details while retry eligibility is separate and conservative', () => {
  assert.equal(runtimeFailureDetail('API Error: 401 token=secretvalue'), 'API Error: 401 token=[REDACTED]');
  for(const message of ['ENOENT missing-cli','EACCES /some/path','API Error: 401','Unknown failure','invalid plugin hash','Provider 执行失败，请稍后重试。']) assert.equal(retryableRuntimeFailure(new Error(message)), false, message);
  for(const message of ['API Error: 429 rate_limit','API Error: 503','ECONNRESET']) assert.equal(retryableRuntimeFailure(new Error(message)), true, message);
  assert.equal(retryableRuntimeFailure(Object.assign(new Error('503'),{retryable:false})),false);
});

test("provider CLI environment never inherits Electron bootstrap settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-electron-env-"));
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  const previousBootstrap = process.env.AGENTFORGE_BOOTSTRAP_TOKEN;
  process.env.ELECTRON_RUN_AS_NODE = "1";
  process.env.AGENTFORGE_BOOTSTRAP_TOKEN = "a".repeat(64);
  try {
    const executable = join(root, "fixture.mjs"), events = [];
    await writeFile(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"result",result:JSON.stringify({electronRunAsNode:process.env.ELECTRON_RUN_AS_NODE || null,bootstrapToken:process.env.AGENTFORGE_BOOTSTRAP_TOKEN || null})}));\n');
    await chmod(executable, 0o755);
    const result = JSON.parse((await runClaudeCodeCli({ runtime: { executable }, workspacePath: root, traceDirectory: root, outputSchema: {}, prompt: "test", runId: "electron-env", onEvent: async event => events.push(event) })).finalText);
    assert.equal(result.electronRunAsNode, null);
    assert.equal(result.bootstrapToken, null);
    assert.ok(events.some(event => event.providerEventType === "result"));
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous;
    if (previousBootstrap === undefined) delete process.env.AGENTFORGE_BOOTSTRAP_TOKEN;
    else process.env.AGENTFORGE_BOOTSTRAP_TOKEN = previousBootstrap;
    await rm(root, { recursive: true, force: true });
  }
});

test("private configuration exposes no deprecated plugin or hand-written path adapters", () => {
  const config = createRuntimeConfiguration("/unused-test-root");
  for (const name of ["resolvePlugins", "readPlugins", "saveMcp", "readMcp"]) assert.equal(config[name], undefined);
});

test("MCP installed versions are private and malformed/compound input rejects", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-mcp-test-"));
  try {
    const config=createRuntimeConfiguration(root), market=(await import('../server/runtime/marketplace.mjs')).createMarketplace(await realpath(root));
    const input={kind:'mcp',name:'Local',description:'Test',content:JSON.stringify({mcpServers:{local:{command:'node',args:['server.mjs']}}})};
    const a=await market.add(input),b=await market.add(input);
    const binding=await market.resolve({pluginIds:[],mcpIds:[a.id]},'claude-code');
    assert.notEqual(a.id,b.id);assert.equal((await stat(binding.mcpConfigPaths[0])).mode&0o777,0o600);
    assert.deepEqual(JSON.parse(await readFile(binding.mcpConfigPaths[0],'utf8')),JSON.parse(input.content));
    assert.equal(market.configure,undefined);assert.equal(market.mcpJson,undefined);
    assert.throws(()=>parseMcpJson("{"),/格式/);
    assert.throws(()=>parseMcpJson('{"mcpServers":{"bad":{"args":[]}}}'),/command/);
    assert.throws(()=>parseMcpJson('{"mcpServers":[]}'),/对象/);
    assert.throws(()=>parseMcpJson('{"mcpServers":{"bad":{"type":"http","url":"file:///tmp/a"}}}'),/HTTP/);
    await assert.rejects(config.importPlugins("file:///tmp/repo"),/HTTPS/);
    await assert.rejects(config.importPlugins("https://user:secret@example.org/repo"),/凭据/);
  } finally {await rm(root,{recursive:true,force:true});}
});
test("GitHub and GitLab pull tokens stay private, host-bound and removable", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-git-credentials-"));
  try {
    const config = createRuntimeConfiguration(root), githubToken = "github-test-token", gitlabToken = "gitlab-test-token";
    assert.deepEqual(await config.listGitCredentials(), { providers: [
      { id: "github", label: "GitHub", host: "github.com", configured: false },
      { id: "gitlab", label: "GitLab", host: "gitlab.com", configured: false }
    ] });
    await config.saveGitCredential("github", githubToken);
    const stored = join(root, "git-credentials.json");
    assert.equal((await stat(stored)).mode & 0o777, 0o600);
    assert.equal((await config.resolveGitCredential("https://github.com/acme/private.git")).token, githubToken);
    assert.equal(await config.resolveGitCredential("https://gitlab.com/acme/private.git"), null);
    assert.equal(await config.resolveGitCredential("git@github.com:acme/private.git"), null);
    assert.equal(await config.resolveGitCredential("https://github.com:8443/acme/private.git"), null);
    await config.saveGitCredential("gitlab", gitlabToken);
    assert.deepEqual(await config.resolveGitCredential("https://gitlab.com/acme/private.git"), { provider: "gitlab", host: "gitlab.com", username: "oauth2", token: gitlabToken });
    const listed = await config.listGitCredentials();
    assert.deepEqual(listed.providers.map((provider) => provider.configured), [true, true]);
    assert.doesNotMatch(JSON.stringify(listed), /github-test-token|gitlab-test-token/);
    await assert.rejects(config.saveGitCredential("github", "line\nbreak"), /换行/);
    await assert.rejects(config.saveGitCredential("unknown", "token"), /GitHub/);
    await config.removeGitCredential("github");
    assert.equal(await config.resolveGitCredential("https://github.com/acme/private.git"), null);
    await rm(stored);
    await writeFile(join(root, "outside.json"), JSON.stringify({ version: 1, providers: {} }));
    await symlink(join(root, "outside.json"), stored);
    await assert.rejects(config.listGitCredentials(), /无效/);
    const linkedRoot = join(root, "linked-runtime-config"), outsideRoot = join(root, "outside-runtime-config");
    await mkdir(outsideRoot);
    await symlink(outsideRoot, linkedRoot);
    await assert.rejects(createRuntimeConfiguration(linkedRoot).listGitCredentials(), /私有运行配置目录/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex selection persists and native member session resumes without cross-member reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-codex-state-"));
  try {
    const databasePath = join(root, "state.sqlite"), store = createStore({ databasePath, workspaceRoot: root });
    const manager = store.createAgent({ name: "Custom manager", role: "项目经理", kind: "manager", runtime: { provider: "codex" } });
    const team = store.createTeam({ name: "Test team", managerAgentId: manager.id, memberAgentIds: ["agent_analyst", manager.id] });
    const task = store.createTask({ title: "Read-only test", objective: "Test", teamId: team.id, workflowTemplateId: "software_delivery", nodeAssignments: { requirements: "agent_analyst", design: "agent_analyst", development: "agent_analyst", testing: "agent_analyst", bug_fix: "agent_analyst", regression: "agent_analyst" } });
    const run = store.createRun(task.id); store.initializeDispatches(run.id);
    const delivery = store.claimDispatch(run.id), trace = store.createTrace(run.id, { workflowNodeId: delivery.workflowNodeId, agentId: delivery.recipientAgentId }); store.attachDispatchTrace(delivery.id, trace.id);
    assert.equal(store.prepareMemberSession(delivery.id, trace.id, root).resume, false);
    assert.equal(store.snapshot().traces.find(item => item.id === trace.id).providerSessionId, null, 'placeholder UUID is not a confirmed Codex ID');
    store.bindProviderSession(trace.id, "0199a213-81c0-7800-8aa1-bbab2a035a53");
    assert.throws(() => store.bindProviderSession(trace.id, "0199a213-81c0-7800-8aa1-bbab2a035a54"), /不一致/);
    store.completeTrace(trace.id, { status: "failed" }); store.retryDispatch(delivery.id, "429", 0);
    const restarted = createStore({ databasePath }), next = restarted.claimDispatch(run.id), trace2 = restarted.createTrace(run.id, { workflowNodeId: next.workflowNodeId, agentId: next.recipientAgentId }); restarted.attachDispatchTrace(next.id, trace2.id);
    const session = restarted.prepareMemberSession(next.id, trace2.id, root);
    assert.equal(session.resume, true); assert.equal(session.sessionId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
    assert.equal(restarted.listAgents().find((item) => item.id === manager.id).runtime.provider, "codex");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("plugin catalog lists local plugins and rejects manifest/source symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-plugin-test-"));
  try {
    const repo = join(root, "repo"), manifest = join(repo, ".claude-plugin/marketplace.json");
    await mkdir(join(repo, ".claude-plugin"), { recursive: true }); await mkdir(join(repo, "first"));
    await writeFile(manifest, JSON.stringify({ plugins: [{ name: "first", source: "./first" }, { name: "external", source: { source: "github", repo: "example/plugin" } }] }));
    const result = await readPluginCatalog(repo); assert.equal(result.plugins.length, 2); assert.equal(result.plugins[1].remoteSource.url, 'https://github.com/example/plugin.git');
    await writeFile(manifest, JSON.stringify({ plugins: [{ name: "escape", source: "./../" }] }));
    await assert.rejects(readPluginCatalog(repo), /越界/);
    await rm(manifest); await writeFile(join(root, "outside.json"), '{"plugins":[]}'); await symlink(join(root, "outside.json"), manifest);
    await assert.rejects(readPluginCatalog(repo), /越界/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git marketplace source normalization follows shared GitHub/url/subdir selectors without executing untrusted source types',()=>{
  assert.deepEqual(gitPluginSource({source:'github',repo:'obra/superpowers',ref:'v7',sha:'a'.repeat(40)}),{url:'https://github.com/obra/superpowers.git',path:'./',ref:'v7',sha:'a'.repeat(40)});
  assert.deepEqual(gitPluginSource({source:'git-subdir',url:'openai/plugins',path:'./plugins/demo'}),{url:'https://github.com/openai/plugins.git',path:'./plugins/demo'});
  for(const source of [{source:'url',url:'https://user:secret@host/repo'},{source:'url',url:'file:///private/data'},{source:'git-subdir',url:'https://host/repo',path:'../outside'},{source:'url',url:'https://host/repo',ref:'--upload-pack=evil'},{source:'url',url:'https://host/repo',sha:'short'},{source:'command',command:'touch /tmp/not-allowed'},{source:'npm',package:'test'}]) assert.throws(()=>gitPluginSource(source));
});
test('real Superpowers Codex url-relative source and local object sources resolve from the marketplace root',async()=>{
  const root=await mkdtemp(join(tmpdir(),'af-superpowers-source-'));
  try{
    await mkdir(join(root,'.agents/plugins'),{recursive:true});
    await writeFile(join(root,'.agents/plugins/marketplace.json'),JSON.stringify({plugins:[{name:'superpowers',source:{source:'url',url:'./'}},{name:'local',source:{source:'local',path:'./'}}]}));
    const result=await readPluginCatalog(root);assert.equal(result.plugins.length,2);assert.ok(result.plugins.every(item=>item.path));assert.ok(result.plugins.every(item=>!item.remoteSource));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('Codex tools keep one input per native call, late search arguments and distinct search actions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-codex-phases-')); t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex.mjs'), events = [];
  const frames = [
    { type: 'item.started', item: { id: 'weather', type: 'mcp_tool_call', tool: 'maps_weather', arguments: { city: '北京' } } },
    { type: 'item.completed', item: { id: 'weather', type: 'mcp_tool_call', tool: 'maps_weather', arguments: { city: '北京' }, result: { text: '晴' } } },
    { type: 'item.started', item: { id: 'search', type: 'web_search' } },
    { type: 'item.completed', item: { id: 'search', type: 'web_search', action: { type: 'search', query: '北京天气' } } },
    { type: 'item.completed', item: { id: 'open', type: 'web_search', action: { type: 'open_page', url: 'https://example.com/weather' } } },
    { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: 'complete' } }
  ];
  await writeFile(executable, '#!/usr/bin/env node\n' + codexProbeFixture + 'for (const frame of ' + JSON.stringify(frames) + ') console.log(JSON.stringify(frame));'); await chmod(executable, 0o755);
  await runCodexCli({ runtime: { executable }, workspacePath: root, traceDirectory: root, finalPath: join(root, 'final.json'), prompt: 'probe', runId: 'phases', onEvent: async event => events.push(event) });
  assert.match(events.find(event => event.data?.toolUseId === 'weather').content.fields.input.text, /北京/);
  const weather = events.find(event => event.data?.toolResultId === 'weather'); assert.equal(weather.content.fields.input, undefined); assert.match(weather.content.fields.output.text, /晴/);
  assert.match(events.find(event => event.data?.toolResultId === 'search').content.fields.input.text, /北京天气/);
  assert.match(events.find(event => event.data?.toolResultId === 'open').content.fields.input.text, /open_page/);
});

test("Codex adapter uses explicit resume, retains only tool audit metadata and classifies provider failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-codex-cli-"));
  try {
    const executable = join(root, "fixture.mjs"), events = [];
    await writeFile(executable, `#!/usr/bin/env node\n${codexProbeFixture}const args=process.argv.slice(2);console.error(JSON.stringify({token:'QUALITY_SENTINEL_STDERR'}));console.log(JSON.stringify({type:'thread.started',thread_id:'0199a213-81c0-7800-8aa1-bbab2a035a53'}));console.log(JSON.stringify({type:'item.completed',item:{id:'tool1',type:'command_execution',command:'curl -H "Authorization: Bearer QUALITY_SENTINEL_COMMAND"',aggregated_output:'{"Authorization":"QUALITY_SENTINEL_OUTPUT"}',status:'completed'}}));console.log(JSON.stringify({type:'item.started',item:{id:'tool2',type:'mcp_tool_call',arguments:['Authorization: QUALITY_SENTINEL_ARRAY']}}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(args)}}));if(args.at(-1)==='fail')console.log(JSON.stringify({type:'turn.failed',error:{message:'test failure'}}));if(args.at(-1)==='stderr-fail'){console.log(JSON.stringify({type:'turn.failed',error:{message:'Codex model capacity exhausted'}}));console.error('Reading additional input from stdin...');process.exitCode=1;}`); await chmod(executable, 0o755);
    const input = { runtime: { executable }, workspacePath: root, traceDirectory: root, schemaPath: join(root, "schema.json"), finalPath: join(root, "final.json"), prompt: "test", runId: "test", session: { resume: true, sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53" }, onEvent: async (event) => events.push(event) };
    const result = await runCodexCli(input), args = JSON.parse(result.finalText);
    assert.equal(args[0], 'exec'); assert.ok(args.includes('features.apps=false')); assert.equal(args[args.indexOf('resume') + 1], input.session.sessionId);
    assert.ok(args.includes("--output-schema")); assert.ok(!args.includes("--last"));
    assert.equal(events.find((event) => event.data.toolResultId)?.message, "本机工具已返回结果");
    assert.equal(events.find((event) => event.data.toolResultId)?.data.toolOutput, undefined);
    assert.equal(events.find((event) => event.data.toolResultId)?.data.toolInput, undefined);
    assert.equal(events.find((event) => event.data.toolUseId === "tool2")?.data.toolInput, undefined);
    assert.equal(events.find((event) => event.providerEventType === "stderr")?.message, "Provider 诊断输出已隐藏");
    assert.doesNotMatch(JSON.stringify(events), /QUALITY_SENTINEL/);
    await assert.rejects(runCodexCli({ ...input, prompt: "fail" }), /test \[REDACTED\]ure/);
    const structuredFailureEvents = [];
    await assert.rejects(runCodexCli({ ...input, prompt: "stderr-fail", onEvent: async (event) => structuredFailureEvents.push(event) }), (error) => {
      assert.match(error.message, /Codex model capacity exhausted/);
      assert.doesNotMatch(error.message, /Reading additional input from stdin/);
      return true;
    });
    assert.ok(structuredFailureEvents.some((event) => event.message === "Provider 请求受限，请稍后重试。"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude adapter preserves a classified JSONL provider failure when stderr is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-claude-terminal-failure-"));
  try {
    const executable = join(root, "fixture.mjs"), events = [];
    await writeFile(executable, `#!/usr/bin/env node
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"API Error: 502 upstream service temporarily unavailable"}]}}));
console.log(JSON.stringify({type:"result",subtype:"success",result:"{}"}));
process.exitCode=1;`);
    await chmod(executable, 0o755);
    await assert.rejects(runClaudeCodeCli({
      runtime: { executable }, workspacePath: root, traceDirectory: root, outputSchema: {}, prompt: "test", runId: "claude-terminal-failure", onEvent: async (event) => events.push(event)
    }), (error) => {
      assert.match(error.message, /API Error: 502 upstream service temporarily unavailable/);
      assert.doesNotMatch(error.message, /没有可用错误输出/);
      return true;
    });
    assert.ok(events.some((event) => event.message === "模型已更新执行进展"));
    assert.doesNotMatch(JSON.stringify(events), /upstream service/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude adapter does not treat ordinary assistant text as a terminal failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-claude-ordinary-text-"));
  try {
    const executable = join(root, "fixture.mjs");
    await writeFile(executable, `#!/usr/bin/env node
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"This report explains why a prior run failed."}]}}));
process.exitCode=1;`);
    await chmod(executable, 0o755);
    await assert.rejects(runClaudeCodeCli({
      runtime: { executable }, workspacePath: root, traceDirectory: root, outputSchema: {}, prompt: "test", runId: "claude-ordinary-text", onEvent: async () => {}
    }), (error) => {
      assert.match(error.message, /Claude Code exit=1/);
      assert.doesNotMatch(error.message, /prior run failed/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude runtime emits durable-safe lifecycle and tool summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-claude-audit-events-"));
  try {
    const executable = join(root, "fixture.mjs"), events = [];
    await writeFile(executable, `#!/usr/bin/env node
console.error("STDERR_AUDIT_SENTINEL /private/provider-diagnostic");
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"11111111-1111-4111-8111-111111111111"}));
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"PROMPT_AUDIT_SENTINEL /private/task-prompt"}]}}));
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",id:"tool-audit",name:"Bash",input:{command:"cat /private/TOOL_INPUT_SENTINEL"}}]}}));
console.log(JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"tool-audit",content:"TOOL_OUTPUT_SENTINEL"}]}}));
console.log(JSON.stringify({type:"result",structured_output:{ok:true}}));`);
    await chmod(executable, 0o755);
    const result = await runClaudeCodeCli({ runtime: { executable }, workspacePath: root, traceDirectory: root, finalPath: join(root, "final.json"), outputSchema: {}, prompt: "test", runId: "claude-audit-events", onEvent: async (event) => events.push(event) });
    assert.equal(result.finalText, JSON.stringify({ ok: true }));
    assert.ok(events.some((event) => event.message === "已请求本机工具" && event.data.toolName === "Bash"));
    assert.ok(events.some((event) => event.message === "本机工具已返回结果" && event.data.toolResultId === "tool-audit"));
    assert.ok(events.every((event) => event.data.auditVersion === 2));
    assert.ok(events.every((event) => event.data.toolInput === undefined && event.data.toolOutput === undefined));
    const persisted = events.map((event) => separateRuntimeSession(event).auditEvent);
    assert.doesNotMatch(JSON.stringify(persisted), /AUDIT_SENTINEL|11111111-1111-4111-8111-111111111111|\/private\//);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Console renders only audit summaries, including legacy runtime and Trace failures", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const consoleRenderer = source.slice(source.indexOf("function isCurrentRuntimeAudit"), source.indexOf("function artifactSnapshotTree"));
  assert.match(consoleRenderer, /历史运行记录已按当前审计边界隐藏原始内容/);
  assert.match(consoleRenderer, /历史 Trace 失败原因已按当前审计边界隐藏原始内容/);
  assert.match(consoleRenderer, /auditVersion === 2/);
  assert.doesNotMatch(consoleRenderer, /toolInput|toolOutput|COMMAND|INPUT|OUTPUT/);
});

test("workflow list is compact; detail owns the graph and complete node information", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const list = source.slice(source.indexOf("function renderWorkflows()"), source.indexOf("function workflowDetails("));
  assert.ok(list.includes("data-workflow-details")); assert.ok(!list.includes("workflowDiagramCanvas("));
  const detail = source.slice(source.indexOf("function workflowDetails("), source.indexOf("/* ---------- 数字员工"));
  for (const text of ["data-detail-node", "前置交接", "职责与交付目标", 'mountWorkflowDiagram("details"']) assert.ok(detail.includes(text));
});

test("Claude and Codex invocations pass the configured model and effort to the real CLI arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-effort-args-"));
  try {
    const claudeArgs = join(root, "claude-args.json");
    const claude = join(root, "claude-fixture.mjs");
    await writeFile(claude, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(claudeArgs)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "result", structured_output: { ok: true } }));`);
    await chmod(claude, 0o755);
    await runClaudeCodeCli({ runtime: { executable: claude, model: "sonnet", effort: "high", skillPaths: [], pluginPaths: [], mcpConfigPaths: [] }, workspacePath: root, traceDirectory: root, finalPath: join(root, "final.json"), outputSchema: {}, prompt: "test", runId: "claude-effort-args", onEvent: async () => {} });
    const claudeArgv = JSON.parse(await readFile(claudeArgs, "utf8"));
    assert.deepEqual(claudeArgv.slice(claudeArgv.indexOf("--model"), claudeArgv.indexOf("--model") + 2), ["--model", "sonnet"]);
    assert.deepEqual(claudeArgv.slice(claudeArgv.indexOf("--effort"), claudeArgv.indexOf("--effort") + 2), ["--effort", "high"]);
    await assert.rejects(runClaudeCodeCli({ runtime: { executable: claude, effort: "high;rm", skillPaths: [], pluginPaths: [], mcpConfigPaths: [] }, workspacePath: root, traceDirectory: root, outputSchema: {}, prompt: "test", runId: "claude-bad-effort", onEvent: async () => {} }), /思考等级配置无效/);
    const claudeDefaultArgs = join(root, "claude-default-args.json");
    await writeFile(claude, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(claudeDefaultArgs)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "result", structured_output: { ok: true } }));`);
    await runClaudeCodeCli({ runtime: { executable: claude, skillPaths: [], pluginPaths: [], mcpConfigPaths: [] }, workspacePath: root, traceDirectory: root, outputSchema: {}, prompt: "test", runId: "claude-no-effort", onEvent: async () => {} });
    const claudeDefault = JSON.parse(await readFile(claudeDefaultArgs, "utf8"));
    assert.ok(!claudeDefault.includes("--model") && !claudeDefault.includes("--effort"), "empty model/effort never emit flags");

    const codexArgs = join(root, "codex-args.json");
    const codex = join(root, "codex-fixture.mjs");
    await writeFile(codex, `#!/usr/bin/env node
${codexProbeFixture}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(codexArgs)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "{\\"status\\":\\"ok\\"}" } }));`);
    await chmod(codex, 0o755);
    await runCodexCli({ runtime: { executable: codex, model: "gpt-real", effort: "ultra", skillPaths: [], pluginPaths: [], mcpConfigPaths: [] }, workspacePath: root, traceDirectory: root, finalPath: join(root, "codex-final.json"), prompt: "test", runId: "codex-effort-args", onEvent: async () => {} });
    const codexArgv = JSON.parse(await readFile(codexArgs, "utf8"));
    assert.deepEqual(codexArgv.slice(codexArgv.indexOf("--model"), codexArgv.indexOf("--model") + 2), ["--model", "gpt-real"]);
    assert.ok(codexArgv.includes('model_reasoning_effort="ultra"'), "codex effort goes through the recognized -c model_reasoning_effort override");
    assert.equal(codexArgv[codexArgv.indexOf('model_reasoning_effort="ultra"') - 1], "-c");
    await assert.rejects(runCodexCli({ runtime: { executable: codex, effort: "Ultra", skillPaths: [], pluginPaths: [], mcpConfigPaths: [] }, workspacePath: root, traceDirectory: root, prompt: "test", runId: "codex-bad-effort", onEvent: async () => {} }), /思考等级配置无效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
