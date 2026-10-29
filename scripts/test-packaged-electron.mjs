// Packaged macOS Beta smoke test. It deliberately has no dependency on a globally installed Node runtime.
import assert from "node:assert/strict";
import { access, appendFile, chmod, cp, mkdtemp, mkdir, readFile, readdir, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { _electron as electron } from "playwright-core";
import { desktopStoragePaths } from "../apps/electron/runtime-paths.mjs";
import { createStore } from '../server/store.mjs';
import { withHistoryTools } from '../server/history/bridge.mjs';
import { runCodexCli } from '../server/runtime/local-cli.mjs';

const appBundle = resolve(process.env.AGENTFORGE_PACKAGED_APP || "release/mac-arm64/AgentForge.app");
const executable = join(appBundle, "Contents", "MacOS", "AgentForge");
await access(executable);
await mkdir(".data", { recursive: true });
const evidenceRoot = await mkdtemp(resolve(".data/packaged-electron-e2e-"));
const profile = join(evidenceRoot, "profile");
// The packaged instance state lives under an isolated HOME fixture, never the
// operator's real ~/.agentforge; Chromium-managed files stay in --user-data-dir.
const home = join(evidenceRoot, "home");
await mkdir(home, { mode: 0o700 });
const storage = desktopStoragePaths(join(home, ".agentforge", "desktop"), { home });
const endpointFile = join(storage.dataRoot, "desktop-endpoint.json");
const urlFor = (page, path) => new URL(path, page.url()).href;
const execute = promisify(execFile);
const cliLauncher = join(appBundle, 'Contents/Resources/cli/agentforge');
const cliSession = join(evidenceRoot, 'cli-private/session.json');
async function packagedCli(args, input = '', installed, json = true) {
  const result = await new Promise((done, reject) => {
    const commandArgs = [...args, '--session-file', cliSession, '--endpoint-file', endpointFile, ...(json ? ['--json'] : [])];
    const child = spawn(installed ? `/bin/${installed.shell}` : cliLauncher, installed ? ['-ilc', 'agentforge "$@"', 'agentforge-e2e', ...commandArgs] : commandArgs, { env: { ...process.env, ...(installed ? { HOME: installed.home, ZDOTDIR: installed.home } : {}), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
  assert.equal(result.code, 0, result.stdout || result.stderr);
  return json ? JSON.parse(result.stdout).data : result.stdout;
}
async function terminalLogin(sessionFile, keystrokes, expectedCode = 0) {
  // macOS system expect allocates a real PTY even when CI's own stdin is a pipe.
  // Send fixture keys only after the hidden prompt; never persist the transcript.
  const result = await new Promise((done, reject) => {
    const program = `set timeout 20
spawn -noecho $env(AF_TEST_CLI) auth login --username $env(AF_TEST_USERNAME) --session-file $env(AF_TEST_SESSION) --endpoint-file $env(AF_TEST_ENDPOINT) --json
expect {
  "请输入密码：" { send -- $env(AF_TEST_KEYS) }
  timeout { exit 124 }
  eof { exit 125 }
}
expect {
  eof { catch wait result; exit [lindex $result 3] }
  timeout { exit 124 }
}`;
    const child = spawn('/usr/bin/expect', ['-c', program], { detached: true, env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb', AF_TEST_CLI: cliLauncher, AF_TEST_USERNAME: username, AF_TEST_SESSION: sessionFile, AF_TEST_ENDPOINT: endpointFile, AF_TEST_KEYS: keystrokes }, stdio: ['ignore', 'pipe', 'pipe'] });
    let transcript = '', sent = false;
    const timeout = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} reject(new Error('Interactive CLI timed out')); }, 30000);
    const collect = chunk => {
      transcript += chunk;
      if (!sent && transcript.includes('请输入密码：')) sent = true;
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); done({ transcript, sent, code }); });
  });
  assert.equal(result.sent, true, 'real terminal displayed a password prompt');
  assert.equal(result.code, expectedCode, 'interactive CLI exit code');
  assert.ok(!result.transcript.includes(password), 'password must not echo');
  const typedPrefix = keystrokes.match(/^[A-Za-z0-9-]{8,}/)?.[0].slice(0, 12);
  if (typedPrefix) assert.ok(!result.transcript.includes(typedPrefix), 'typed password prefix must not echo');
  const start = result.transcript.indexOf('{'); assert.ok(start >= 0);
  return JSON.parse(result.transcript.slice(start).trim());
}
assert.equal((await packagedCli(['schema', 'agents'])).group, 'agents');
const terminalHelp = await execute(cliLauncher, ['help'], { env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 30000 });
assert.match(terminalHelp.stdout, /^AgentForge 是一个 AI 团队操作系统/); assert.equal(terminalHelp.stderr, '');
assert.ok(!terminalHelp.stdout.startsWith('{')); assert.match(terminalHelp.stdout, /可核验的交付物/);
assert.doesNotMatch(terminalHelp.stdout, /逐层查看|GROUP|OPERATION/);
assert.match(terminalHelp.stdout, /查看具体操作参数：在命令后加 --help，例如 agentforge agents get --help。/);
assert.match(await packagedCli(['agents', 'get', '--help'], '', undefined, false), /ID：必填精确资源ID/);
assert.doesNotMatch(terminalHelp.stdout, /典型交付流程|核心概念|JSON 输入模板|runtime\.extensionSelection/);
console.log('PASS bundled AI CLI offline schema without a global Node/PATH installation');
// Validate the actual distribution bundle, not just its inherited Mach-O signature.
await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", appBundle]);
const tamperedBundle = join(evidenceRoot, "tampered.app");
await cp(appBundle, tamperedBundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", tamperedBundle]);
await appendFile(join(tamperedBundle, "Contents/Resources/app.asar"), "\npackaged-integrity-test\n");
await assert.rejects(execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", tamperedBundle]), (error) => error.code === 1,
  "a changed application resource must fail strict signature verification");
console.log("PASS packaged signature integrity and rejection of a tampered disposable copy (not Developer ID/notarization)");
// The operator-run one-time data migration script ships outside the asar.
await access(join(appBundle, "Contents", "Resources", "scripts", "migrate-data-home.mjs"));
for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
  assert.deepEqual(await readFile(join(appBundle,'Contents','Resources','licenses','electron',name)), await readFile(resolve('node_modules/electron/dist',name)), 'Electron/Chromium license text must survive packaging');
}
console.log("PASS packaged bundle ships the one-time data migration script");
// Actual stdio MCP through the packaged Electron Node-mode private-file launcher.
// This verifies ASAR/module resolution, not a model invocation.
const mcpProof = randomBytes(16).toString('hex');
const mcpConfigPath = join(evidenceRoot,'selected-mcp.json');
const mcpConfig = JSON.stringify({mcpServers:{selected:{command:process.execPath,args:[resolve('scripts/marketplace-probe-mcp.mjs'),join(evidenceRoot,'selected-mcp.log'),mcpProof]}}});
await writeFile(mcpConfigPath,mcpConfig,{mode:0o600});
const mcpClient = new Client({name:'packaged-market-check',version:'1.0.0'});
try {
  await mcpClient.connect(new StdioClientTransport({command:executable,args:[join(appBundle,'Contents/Resources/app.asar/server/runtime/mcp-launcher.mjs'),mcpConfigPath,createHash('sha256').update(mcpConfig).digest('hex'),'selected'],env:{PATH:'/usr/bin:/bin',ELECTRON_RUN_AS_NODE:'1',HOME:home},stderr:'pipe'}));
  const result = await mcpClient.callTool({name:'read_validation_code',arguments:{}});
  assert.ok(JSON.stringify(result).includes(mcpProof));
} finally { await mcpClient.close(); }
console.log('PASS packaged selected MCP launcher: real protocol and private configuration');
// Consume the actual Codex adapter arguments, not a separately invented MCP
// config: a missing Electron Node flag must break this real SDK handshake.
const historyProvider = join(evidenceRoot, 'history-provider.mjs');
await writeFile(historyProvider, `#!${process.execPath}
import assert from 'node:assert/strict';
import {Client} from ${JSON.stringify(pathToFileURL(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href)};
import {StdioClientTransport} from ${JSON.stringify(pathToFileURL(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href)};
const args=process.argv.slice(2);
if(args.includes('features')) { console.log('skip_host_skill_discovery stable false'); process.exit(0); }
if(args.includes('mcp')&&args.includes('list')) { console.log('[]'); process.exit(0); }
assert.equal(process.env.ELECTRON_RUN_AS_NODE,undefined);
const config={env:{HOME:${JSON.stringify(home)},PATH:'/usr/bin:/bin'}};
for(const arg of args) if(arg.startsWith('mcp_servers.agentforge_history.')) {
  const [key,...value]=arg.slice('mcp_servers.agentforge_history.'.length).split('=');
  if(key.startsWith('env.')) config.env[key.slice(4)]=JSON.parse(value.join('='));
  else config[key]=JSON.parse(value.join('='));
}
assert.equal(config.required,true); assert.equal(config.env.ELECTRON_RUN_AS_NODE,'1');
const client=new Client({name:'packaged-history-check',version:'1.0.0'});
try {
  await client.connect(new StdioClientTransport({command:config.command,args:config.args,env:config.env,stderr:'pipe'}));
  const tools=await client.listTools(); assert.equal(tools.tools.length,8);
  const sessions=await client.callTool({name:'list_sessions',arguments:{}});
  assert.ok(!sessions.isError); assert.equal(JSON.parse(sessions.content[0].text).items.length,1);
  const result=await client.callTool({name:'search_private_chat',arguments:{query:${JSON.stringify(mcpProof)}}});
  assert.ok(!result.isError); assert.ok(JSON.stringify(result).includes(${JSON.stringify(mcpProof)}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"historyVerified":true}'}}));
} finally {await client.close();}
`, {mode:0o700});
const historyStore = createStore();
const historyAgent = historyStore.createAgent({name:'打包历史检索'});
const historyChat = historyStore.openCommunication({kind:'agent',targetId:historyAgent.id});
historyStore.sendCommunication(historyChat.id,{content:mcpProof,clientRequestId:randomBytes(16).toString('hex')});
const previousElectronNode = process.env.AGENTFORGE_ELECTRON_NODE;
process.env.AGENTFORGE_ELECTRON_NODE = executable;
try {
  const result = await withHistoryTools(historyStore,historyAgent,{runtime:{executable:historyProvider},workspacePath:home,traceDirectory:evidenceRoot,finalPath:join(evidenceRoot,'history-final.json'),prompt:'read stored history',runId:'packaged-history',onEvent:async()=>{}},runCodexCli);
  assert.equal(JSON.parse(result.finalText).historyVerified,true);
} finally {
  if(previousElectronNode===undefined) delete process.env.AGENTFORGE_ELECTRON_NODE; else process.env.AGENTFORGE_ELECTRON_NODE=previousElectronNode;
  historyStore.close();
}
console.log('PASS Codex adapter registers packaged history MCP: eight real tools and a stored random record, Node mode only in the MCP child');
// Native Skill transport must also run from ASAR under bundled Electron Node.
// This is an explicit protocol fixture, not a real-model activation claim.
const nativeProvider=join(evidenceRoot,'native-provider.mjs'),nativeSkill=join(evidenceRoot,'SKILL.md');
await writeFile(nativeSkill,'---\nname: packaged-native\ndescription: Protocol fixture\n---\nFixture only.');
await writeFile(nativeProvider,`#!${process.execPath}
import{createInterface}from'node:readline';
const send=v=>console.log(JSON.stringify(v));
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),reply=result=>send({id:r.id,result});if(r.id===undefined)return;
 if(r.method==='initialize'||r.method==='skills/extraRoots/set')return reply({});
 if(r.method==='skills/list')return reply({data:[{skills:[{path:${JSON.stringify(nativeSkill)},name:'packaged-native'}],errors:[]}]});
 if(r.method==='thread/start')return reply({thread:{id:'0199a213-81c0-7800-8aa1-bbab2a035a53'}});
 if(r.method==='turn/start'){
  reply({turn:{id:'turn'}});send({method:'item/completed',params:{threadId:'0199a213-81c0-7800-8aa1-bbab2a035a53',turnId:'turn',item:{id:'message',type:'agentMessage',text:'{"nativeProtocol":true}'}}});
  send({method:'turn/completed',params:{threadId:'0199a213-81c0-7800-8aa1-bbab2a035a53',turn:{id:'turn',status:'completed'}}});
 }
});`,{mode:0o700});
const nativeAdapter=pathToFileURL(join(appBundle,'Contents/Resources/app.asar/server/runtime/codex-app-server.mjs')).href;
const nativeProbe=await execute(executable,['--input-type=module','-e',`
import{runCodexAppServer}from ${JSON.stringify(nativeAdapter)};
const result=await runCodexAppServer({runtime:{executable:${JSON.stringify(nativeProvider)},skillPaths:[${JSON.stringify(nativeSkill)}]},workspacePath:${JSON.stringify(home)},traceDirectory:${JSON.stringify(evidenceRoot)},runId:'packaged-native',prompt:'fixture',onEvent:async()=>{}},{args:['app-server'],normalizeEvent:e=>e,cancelledError:m=>new Error(m),missingSessionError:m=>new Error(m)});
console.log(result.finalText);
`],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AGENTFORGE_LOG_DIR:join(evidenceRoot,'native-logs')},timeout:30000});
assert.equal(JSON.parse(nativeProbe.stdout.trim()).nativeProtocol,true);
console.log('PASS bundled native Skill protocol adapter: ASAR imports, selected discovery, thread/turn and process cleanup (controlled fixture)');
const inheritedDatabase = join(evidenceRoot, "inherited-agentforge.sqlite");
const inheritedAuthDatabase = join(evidenceRoot, "inherited-auth.sqlite");
const username = "packaged-beta";
const password = randomBytes(20).toString("hex");
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AGENTFORGE_")));
const shellRoot = join(evidenceRoot, 'shell-profile'), shellBin = join(shellRoot, 'custom-version/bin');
const shellProof = randomBytes(16).toString('hex');
await mkdir(shellBin, { recursive: true });
await writeFile(join(shellRoot, '.zprofile'), 'export AF_PROFILE_LOADED=yes\n');
await writeFile(join(shellRoot, '.zshrc'), `print -r -- "$ZSH_EXECUTION_STRING"\nprint -r -- 'startup-noise-${shellProof}'\nexport AF_SHELL_PROOF=${shellProof}\nexport PATH='${shellBin}':/usr/bin:/bin:/usr/sbin:/sbin\nexport AGENTFORGE_DB_PATH='${join(evidenceRoot, 'shell-must-not-be-used.sqlite')}'\n`);

async function api(page, path, { method = "GET", body } = {}) {
  const result = await page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }, { path, method, body });
  if (result.status < 200 || result.status >= 300) throw new Error(`${method} ${path} failed: ${result.body?.error || result.status}`);
  return result.body;
}

async function waitFor(label, check, timeout = 90000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ""}`);
}

async function installFixtureProvider() {
  const script = join(evidenceRoot, "provider.mjs");
  const launcher = join(shellBin, "agentforge-shell-provider.mjs");
  await writeFile(script, `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const criteria = JSON.parse((prompt.split("任务验收标准：")[1] || "[]").split(String.fromCharCode(10))[0]);
const roster = JSON.parse((prompt.split("可咨询角色：")[1] || "[]").split(String.fromCharCode(10))[0]);
const evidence = [...prompt.matchAll(/"id":"(artifact_[^"]+)"/g)].map((match) => match[1]).slice(0, 1);
const workspace = (prompt.split("任务工作目录：")[1] || "").split(String.fromCharCode(10))[0].trim();
if (process.env.ELECTRON_RUN_AS_NODE || process.env.AGENTFORGE_BOOTSTRAP_TOKEN) throw new Error("control-plane bootstrap environment leaked to Provider fixture");
if (process.env.AF_SHELL_PROOF !== ${JSON.stringify(shellProof)} || process.env.AF_PROFILE_LOADED !== 'yes') throw new Error('shell environment did not reach the Provider');
let result = { kind: "node_result", summary: "Packaged execution content fixture", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "fixture input is sufficient", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes("人类沟通中回答")) result = { reply: "Packaged unread fixture reply", handoffToAgentId: null };
else if (prompt.includes('"purpose":"delivery_review"')) result.deliveryReview = { verdict: "pass", restartFromNodeId: "packaged_verify", findings: ["packaged fixture evidence reviewed"] };
else if (prompt.includes("任务级项目经理")) result.managerDecision = { nextNodeId: prompt.includes('"type":"node"') ? null : "packaged_verify", nextAgentId: prompt.includes('"type":"node"') ? null : roster.find(member => member.type === "agent" && member.kind === "business")?.id, rationale: "fixture selects a business member from the frozen roster" };
else {
  if (!workspace) throw new Error("fixture did not receive the Task workspace");
  await new Promise(resolve => setTimeout(resolve, 7000)); // bounded UI observation of an actual running fixture Trace
  mkdirSync(join(workspace, "docs/packaged"), { recursive: true });
  mkdirSync(join(workspace, "docs/empty"), { recursive: true });
  mkdirSync(join(workspace, "docs/other"), { recursive: true });
  writeFileSync(join(workspace, "docs/packaged/report.md"), "# Packaged Beta evidence\\n\\nAgentForge captured this local fixture artifact.\\n");
  writeFileSync(join(workspace, "docs/other/context.md"), "# Another changed folder\\n");
}
for (let index = 0; index < 75; index++) console.log(JSON.stringify({type:"system", subtype:"init"}));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Packaged execution content fixture" }, { type: "thinking", thinking: "Public fixture reasoning block" }, { type: "tool_use", id: "packaged-call", name: "Bash", input: { command: "fixture-only command" } }, { type: "tool_use", id: "packaged-read", name: "Read", input: { file_path: "docs/packaged/report.md" } }, { type: "tool_use", id: "packaged-read-failed", name: "Read", input: { file_path: "missing.md" } }, { type: "tool_use", id: "packaged-write", name: "Write", input: { file_path: "docs/packaged/report.md", content: "# Packaged Beta evidence" + String.fromCharCode(10) + "<tag> remains literal fixture text" } }] } }));
console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "packaged-call", content: "fixture-only output" }, { type: "tool_result", tool_use_id: "packaged-read", content: "fixture read body must stay hidden" }, { type: "tool_result", tool_use_id: "packaged-read-failed", content: "ENOENT: missing.md", is_error: true }, { type: "tool_result", tool_use_id: "packaged-write", content: "File written" }] } }));
console.log(JSON.stringify({ type: "result", result: JSON.stringify(result) }));
`);
  // The packaged control plane has already booted without a global Node PATH.
  // This synthetic Provider is deliberately an external test fixture, matching
  // the product boundary that real Claude/Codex CLIs are installed by the user.
  await symlink(process.execPath, join(shellBin, "node"));
  await writeFile(launcher, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nif (!process.env.PATH.split(':').includes(${JSON.stringify(shellBin)})) throw new Error('shell-only CLI PATH missing');\ntry { await import(${JSON.stringify(pathToFileURL(script).href)}); } catch(error) { console.error(error); process.exitCode = 1; }\nwriteFileSync(${JSON.stringify(join(evidenceRoot, "fixture-provider.exit"))}, String(process.exitCode || 0));\n`);
  await chmod(launcher, 0o755);
  return 'agentforge-shell-provider.mjs';
}

async function runPackagedTask(page) {
  const workspaceRoot = join(evidenceRoot, "configured-workspaces");
  await mkdir(workspaceRoot, { recursive: true });
  await page.locator('[data-view="settings"]').click();
  await page.locator('[data-settings-page="workspace"]').click();
  await page.locator("#default-workspace-root").fill(workspaceRoot);
  await page.getByRole("button", { name: "保存目录", exact: true }).click();
  await page.getByText("已保存，仅新任务使用此目录。", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidenceRoot, "packaged-workspace-settings.png"), animations: "disabled" });
  const fixture = await installFixtureProvider();
  const connection = await api(page, '/api/settings/runtime-profiles', {method:'POST', body:{name:'打包执行夹具连接',provider:'claude-code',executable:fixture}});
  const worker = await api(page, "/api/agents", { method: "POST", body: { name: "打包验证员工", capabilities: ["本地文件交付"], kind: "business", runtime: { profileId: connection.id } } });
  const manager = await api(page, "/api/agents", { method: "POST", body: { name: "打包任务经理", kind: "manager", runtime: { profileId: connection.id } } });
  const team = await api(page, "/api/teams", { method: "POST", body: { name: "打包 Beta 验证团队", memberAgentIds: [worker.agent.id], managerAgentId: manager.agent.id } });
  const workflow = await api(page, "/api/workflow-templates", { method: "POST", body: { name: "打包 Beta 单节点验证", nodes: [{ id: "packaged_verify", title: "打包交付验证", staffingGuidance: "选择能够生成并核验本地文件的业务成员", dependsOn: [], artifactPaths: ["docs/packaged/"] }] } });
  const title = "PACKAGE-E2E｜本机 Beta 交付闭环";

  await page.reload();
  await page.waitForFunction((expected) => document.querySelector("#account-name")?.textContent === expected, username);
  await page.locator('[data-view="tasks"]').click();
  await page.locator("#tasks-view.active").waitFor();
  await page.getByRole("button", { name: "＋ 新建任务", exact: true }).click();
  const form = page.locator("#task-form");
  await form.waitFor();
  await form.locator('[name="title"]').fill(title);
  await form.locator('[name="objective"]').fill("验证已打包客户端能真实编排一个本地 Agent 交付、保留 Artifact，并由人类确认完成。");
  await form.locator('[name="acceptanceCriteria"]').fill("生成可读取的 docs/packaged/report.md\n项目经理根据节点交接提交人类验收");
  await form.locator('[name="workflowTemplateId"]').selectOption(workflow.workflowTemplate.id);
  await form.locator('[name="teamId"]').selectOption(team.team.id);
  await form.getByText("由项目经理选择执行成员", { exact: true }).waitFor();
  assert.equal(await form.locator('[name^="nodeAssignment_"]').count(), 0);
  await form.getByRole("button", { name: "创建并开始", exact: true }).click();
  await form.waitFor({ state: "detached" });

  const started = await waitFor("Task 和 Run 创建", async () => {
    const bootstrap = await api(page, "/api/bootstrap");
    const task = bootstrap.tasks.find((item) => item.title === title);
    const run = bootstrap.runs.find((item) => item.taskId === task?.id);
    return task && run ? { task, run } : null;
  });
  await page.locator('[data-ws-tab="console"]').click();
  const activeRole = page.locator(`[data-select-agent="${worker.agent.id}"][data-execution-state="running"]`);
  await activeRole.waitFor({timeout:20000});
  await activeRole.click();
  assert.notEqual(await activeRole.evaluate(el => getComputedStyle(el).backgroundColor), await page.locator('[data-execution-state="idle"]').first().evaluate(el => getComputedStyle(el).backgroundColor));
  assert.equal(await activeRole.evaluate(el=>getComputedStyle(el).backgroundColor), 'rgb(238, 245, 255)', 'selected running role retains the semantic blue surface');
  await page.screenshot({path:join(evidenceRoot,'packaged-running-role.png')});
  const workspace = await waitFor("打包 Agent 协作、Artifact 与经理复核", async () => {
    const current = await api(page, `/api/runs/${started.run.id}/workspace`);
    return current.run.status === "awaiting_acceptance" ? current : null;
  });
  const artifact = workspace.artifacts.find((item) => item.name === "docs/packaged/report.md");
  assert.equal(workspace.run.task.taskWorkspacePath, join(workspaceRoot, started.task.id));
  assert.ok(artifact, "the worker must create a trace-bound Artifact");
  const content = await api(page, `/api/runs/${started.run.id}/artifacts/${artifact.id}/content`);
  assert.match(content.content, /Packaged Beta evidence/);
  assert.ok(workspace.run.acceptanceRequest?.traceId);
  assert.equal(workspace.traces.some((trace) => trace.type === "delivery_review"), false);
  assert.deepEqual(workspace.run.task.nodeAssignments, {});
  assert.ok(workspace.traces.some(trace => trace.type === "node" && trace.agentId === worker.agent.id && trace.status === "completed"), "manager must select the actual frozen business member");

  await page.goto(urlFor(page, `/runs/${started.run.id}`));
  const openCompletion = page.locator("[data-open-completion-confirm]");
  await openCompletion.waitFor({ timeout: 60000 });
  assert.equal(await page.locator('.workspace-summary [data-open-completion-confirm]').count(), 1);
  assert.equal(await page.locator('.workspace-acceptance').count(), 0);
  assert.equal(await page.locator('#collaboration-panel .collaboration-review').count(), 0, 'manager conclusion is a normal collaboration message, never a pinned duplicate panel');
  assert.equal(await page.locator('[data-stop-inquiries]').count(), 0);
  await openCompletion.click();
  const completion = page.locator("#confirm-completion");
  await completion.waitFor();
  assert.equal(await completion.isDisabled(), true, "a model/manager pass must not complete the Task before human acknowledgement");
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 560));
  const confirmBounds = await completion.boundingBox();
  assert.ok(confirmBounds && confirmBounds.y + confirmBounds.height <= await page.evaluate(() => innerHeight), "short-window human action stays visible");
  await page.screenshot({ path: join(evidenceRoot, "packaged-human-gate-short.png"), animations: "disabled" });
  await page.locator("#ack-completion").check();
  assert.equal(await completion.isDisabled(), false);
  await completion.click();
  const completed = await waitFor("visible human confirmation", async () => {
    const current = await api(page, `/api/runs/${started.run.id}/workspace?view=summary`);
    return current.run.status === "completed" ? current : null;
  });
  assert.equal(completed.run.confirmedBy, "human_operator");
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 860));
  await page.screenshot({ path: join(evidenceRoot, "packaged-task-completed.png"), animations: "disabled" });
  let currentFolders;
  for (const tab of ["collaboration", "directory", "diff", "console"]) {
    await page.locator(tab === "directory" ? '#directory-mode' : `[data-ws-tab="${tab}"]`).click();
    if (tab === "directory") {
      for(const path of ['docs','docs/packaged','docs/other','docs/empty']){
        const folder=page.locator(`[data-directory-path="${path}"]`);await folder.waitFor();if(!await folder.evaluate(el=>el.open))await folder.locator(':scope > summary').click();
      }
      await page.locator('[data-select-working-file="docs/packaged/report.md"]').waitFor();
      currentFolders = (await page.locator('#working-directory-panel .explorer-folder > summary').allTextContents()).map(text=>text.replaceAll('›','').trim()).filter(text=>text!=='empty');
      assert.deepEqual(await page.locator('.file-source-switch button').allTextContents(), ['当前文件', 'CHANGE']);
      assert.equal(await page.locator('[data-ws-tab="artifacts"], #artifact-snapshots-panel').count(), 0);
      const titleBox = await page.locator('.workspace-title h3').boundingBox(), backBox = await page.getByRole('button', { name: '返回任务列表', exact: true }).boundingBox();
      assert.ok(titleBox.x - backBox.x - backBox.width >= 10, 'back icon and title have deliberate spacing');
    }
    if (tab === "diff") {
      await page.locator('[data-select-diff="docs/packaged/report.md"]').waitFor();
      assert.deepEqual((await page.locator('#working-diff-panel .explorer-folder > summary').allTextContents()).map(text=>text.replaceAll('›','').trim()), currentFolders);
      assert.equal(await page.locator('.source-control-group h4').count(), 0);
      assert.equal(await page.locator('#working-diff-panel .artifact-root').filter({ hasText: '没有更改' }).count(), 0, 'directory roots never repeat no-change messages');
      assert.equal(await page.locator('#working-diff-panel .artifact-root').evaluateAll(roots => roots.every(root => {
        const style = getComputedStyle(root); return style.marginBottom === '0px' && style.paddingBottom === '0px';
      })), true, 'CHANGE root sections share the current-file no-reserved-space style');
      await page.locator('[data-select-diff="docs/packaged/report.md"]').click();
      await page.locator('#working-diff-panel .source-diff-add').first().waitFor();
      await page.locator('#working-diff-panel [data-diff-directory="docs/packaged"] > summary').click();
      await page.locator('.file-source-switch [data-ws-tab="directory"]').click();
      await page.locator('[data-select-working-file="docs/packaged/report.md"]').waitFor();
      assert.equal(await page.locator('[data-select-working-file="docs/packaged/report.md"]').isVisible(), true, 'CHANGE collapse does not collapse current files');
      await page.locator('[data-ws-tab="diff"]').click();
      assert.equal(await page.locator('[data-select-diff="docs/packaged/report.md"]').isVisible(), false, 'CHANGE collapse survives switching views');
      const folders=page.locator('#working-diff-panel [data-diff-directory="docs"] > .artifact-tree-list > li > details');
      for(const folder of await folders.all())if(await folder.evaluate(el=>el.open))await folder.locator(':scope > summary').click();
      const rows = await folders.locator(':scope > summary').all();assert.equal(rows.length,2);
      const first = await rows[0].boundingBox(), second = await rows[1].boundingBox();
      assert.ok(second.y-first.y-first.height<=2,'collapsed CHANGE siblings have no reserved group space');
      await page.locator('#working-diff-panel [data-diff-directory="docs/packaged"] > summary').click();
    }
    if (tab === "console") {
      const latestTrace=[...workspace.traces].sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt))[0];
      await page.locator(`[data-select-agent="${latestTrace.agentId}"].selected`).waitFor();
      await page.locator(".log-row .log-time").first().waitFor();
      await page.locator(`[data-select-agent="${worker.agent.id}"]`).click();
      await page.locator(".log-row .log-time").first().waitFor();
      const older = page.locator('[data-console-older]');
      await older.waitFor();
      assert.equal(await page.locator('.log-row-trace-prompt').count(), 0, 'partial tail does not pin the earlier prompt');
      await older.click();
      await page.locator('.log-row-trace-prompt').waitFor();
      assert.equal(await page.locator('.log-row-trace-prompt').count(), 1);
      const inputPrompt = page.locator('.prompt-snapshot').first();
      await inputPrompt.locator('summary').click();
      await inputPrompt.locator('.prompt-snapshot-text').waitFor();
      assert.match(await inputPrompt.innerText(), /\[应用系统指令\][\s\S]*\[本轮输入\]/);
      assert.doesNotMatch(await inputPrompt.innerText(), /快照范围以/);
      assert.match(await inputPrompt.innerText(), /Claude Code 会话 ID/);
      assert.notEqual((await inputPrompt.locator('.console-session-id code').innerText()).trim(), '未记录');
      await inputPrompt.locator('summary').click();
      assert.equal(await page.locator('#trace-stream .tool-audit').count(), 0);
      assert.doesNotMatch(await page.locator('#trace-stream').innerText(), /result: Provider 已返回结构化结果|tool_progress: 模型已更新执行进展/);
      assert.equal(await page.locator('[data-execution-state="running"]').count(), 0, 'completed members return to neutral');
      await page.locator(".log-row:not(:has(details)) [data-console-content]").first().scrollIntoViewIfNeeded();
      await page.locator('[data-execution-kind="text"]').first().waitFor();
      assert.match(await page.locator('[data-execution-kind="text"]').first().textContent(), /Packaged execution content fixture/);
      assert.equal(((await page.locator('#trace-stream .log-row:not(.log-row-trace-prompt)').allTextContents()).join('\n').match(/Packaged execution content fixture/g) || []).length, 1, 'handoff does not echo TEXT as system output; prompt audit is separate');
      const bash = page.locator('.console-tool-call[data-tool-name="Bash"]').first();
      await bash.scrollIntoViewIfNeeded();
      await bash.getByText('fixture-only command', { exact: true }).waitFor();
      assert.equal(await bash.getAttribute('open'), null, 'Bash command is visible before expanding');
      await bash.locator(':scope > summary').click();
      await bash.locator('[data-execution-kind="output"]').waitFor();
      assert.match(await bash.textContent(), /fixture-only output/);
      await bash.locator(':scope > summary').click();
      const reads = page.locator('.console-tool-call[data-tool-name="Read"]');
      await reads.first().scrollIntoViewIfNeeded();
      await reads.first().getByText('docs/packaged/report.md', { exact: true }).waitFor();
      assert.equal(await reads.first().getAttribute('open'), null, 'grouped Read filename is visible before expanding');
      await reads.first().locator(':scope > summary').click();
      await reads.first().getByText('Done', { exact: true }).waitFor();
      assert.doesNotMatch(await reads.first().textContent(), /fixture read body must stay hidden/);
      await reads.nth(1).locator(':scope > summary').click();
      await reads.nth(1).getByText('ENOENT: missing.md', { exact: true }).waitFor();
      assert.doesNotMatch(await reads.nth(1).textContent(), /Done/);
      const write = page.locator('.console-tool-call[data-tool-name="Write"]').first();
      await write.scrollIntoViewIfNeeded();
      await write.getByText('docs/packaged/report.md', { exact: true }).waitFor();
      assert.equal(await write.getAttribute('open'), null);
      await write.locator(':scope > summary').click();
      await write.getByText('写入内容', { exact: true }).waitFor();
      assert.match(await write.locator('[data-execution-kind="input"] code').textContent(), /# Packaged Beta evidence\n<tag> remains literal fixture text/);
      assert.equal(await write.locator('tag').count(), 0, 'Write content is escaped source text');
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 600));
      await write.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: join(evidenceRoot, 'packaged-console-tools-narrow.png') });
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 860));
      console.log('PASS collapsed Bash/Read/Write summaries, grouped Read Done/error, literal Write content and narrow Console');
      assert.equal(await page.locator('.workspace-mode-tabs [data-toggle-task-details]').count(), 1);
      assert.equal(await page.locator(".log-row:has(.log-time)").first().evaluate((row) => row.querySelector(".log-time").getBoundingClientRect().right <= row.querySelector(".log-body").getBoundingClientRect().left), true, "console timestamp must not overlap the message");
    }
    await page.screenshot({ path: join(evidenceRoot, `packaged-workspace-${tab}.png`), animations: "disabled" });
  }
  await page.locator('#directory-mode').click();
  await page.locator('[data-select-working-file="docs/packaged/report.md"]').click();
  await page.locator("#working-directory-panel .markdown-preview").waitFor();
  const reportPath = join(completed.run.task.workspacePath, 'docs/packaged/report.md');
  const original = await readFile(reportPath);
  // Electron owns DownloadItem events; a browser Page 'download' event is not
  // the acceptance signal. Only redirect the native save destination into the
  // disposable fixture, then verify the real completed file.
  const savedFile = join(evidenceRoot, 'selected-file-download.md');
  await desktop.evaluate(({ BrowserWindow }, destination) => {
    globalThis.__afSelectedFileDownload = null;
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(destination);
      item.once('done', (_event, state) => { globalThis.__afSelectedFileDownload = { state, name: item.getFilename(), path: item.getSavePath() }; });
    });
  }, savedFile);
  await page.locator('[data-download-working-file]').click();
  const download = await waitFor('Electron native file download', () => desktop.evaluate(() => globalThis.__afSelectedFileDownload), 20000);
  assert.equal(download.state, 'completed'); assert.equal(download.name, 'report.md'); assert.equal(download.path, savedFile);
  assert.deepEqual(await readFile(savedFile), original);
  const downloadUrl = urlFor(page, `/api/runs/${started.run.id}/working-directory/content?download=1&path=docs%2Fpackaged%2Freport.md`);
  assert.equal((await fetch(downloadUrl)).status, 401, 'download requires the normal administrator session');
  const downloaded = await page.request.get(downloadUrl);
  assert.match(downloaded.headers()['content-disposition'], /^attachment;/);
  assert.equal(downloaded.headers()['content-type'], 'application/octet-stream');
  assert.equal(downloaded.headers()['cache-control'], 'no-store');
  assert.deepEqual(await downloaded.body(), original);
  const binaryName = "下载 '样例'.bin", binary = Buffer.alloc(600 * 1024, 0xab);
  await writeFile(join(completed.run.task.workspacePath, 'docs/packaged', binaryName), binary);
  const binaryResponse = await page.request.get(urlFor(page, `/api/runs/${started.run.id}/working-directory/content?download=1&path=${encodeURIComponent('docs/packaged/' + binaryName)}`));
  assert.equal(binaryResponse.status(), 200);
  assert.ok(binaryResponse.headers()['content-disposition'].includes("filename*=UTF-8''" + encodeURIComponent(binaryName).replaceAll("'", '%27')));
  assert.deepEqual(await binaryResponse.body(), binary, 'binary download is complete beyond the text-preview limit');
  for (const path of ['docs/.env', '../package.json', 'docs/packaged/missing.md']) {
    const denied = await page.request.get(urlFor(page, `/api/runs/${started.run.id}/working-directory/content?download=1&path=${encodeURIComponent(path)}`));
    assert.equal(denied.status(), 400);
  }
  await unlink(reportPath);
  await page.locator('[data-download-working-file]').click();
  await page.locator('#toast.error').filter({ hasText: '下载失败' }).waitFor();
  assert.ok(page.url().endsWith(`/runs/${started.run.id}`), 'failed download stays on the task');
  await writeFile(reportPath, original);
  console.log('PASS selected-file download preserves bytes/name, streams binary beyond preview limit, enforces authentication/path boundaries and reports missing files in place');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 560));
  const reader = await page.locator("#working-directory-panel .markdown-preview").boundingBox();
  assert.ok(reader && reader.height >= 100, "short-window file reader retains usable height");
  assert.equal(await page.locator("[data-refresh-directory]").evaluate((button) => getComputedStyle(button).whiteSpace), "nowrap");
  const downloadBox = await page.locator('[data-download-working-file]').boundingBox(), refreshBox = await page.locator('[data-refresh-directory]').boundingBox();
  assert.ok(downloadBox && refreshBox && downloadBox.x + downloadBox.width <= refreshBox.x && Math.abs(downloadBox.y - refreshBox.y) < 2, 'download stays beside refresh in a short narrow window');
  const toolbarBox = await page.locator('#working-directory-panel .directory-toolbar').boundingBox();
  assert.ok(Math.abs(toolbarBox.x + toolbarBox.width - refreshBox.x - refreshBox.width) < 2, 'download and refresh stay at the toolbar right edge');
  await page.screenshot({ path: join(evidenceRoot, "packaged-file-short.png"), animations: "disabled" });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 860));
  await page.getByRole('button', { name: '返回任务列表', exact: true }).click();
  const search = page.locator('#task-search-form');
  await search.locator('[name="name"]').fill(title);
  await search.getByRole('button', { name: '搜索', exact: true }).click();
  await page.locator(`[data-open-task="${started.task.id}"]`).click();
  await page.getByRole('button', { name: '返回任务列表', exact: true }).click();
  assert.equal(await search.locator('[name="name"]').inputValue(), title, 'back preserves the task search');
  await search.getByRole('button', { name: '重置', exact: true }).click();
  await page.getByLabel(`${title}的更多操作`, { exact: true }).click();
  await page.locator(`[data-archive-task="${started.task.id}"]`).click();
  // Archiving confirms through the in-app confirmDialog (never a native dialog).
  const archiveConfirm = page.locator(".modal.confirm-dialog");
  await archiveConfirm.waitFor();
  assert.match(await archiveConfirm.locator(".confirm-dialog-message").textContent(), /归档已完成任务/);
  await archiveConfirm.locator("[data-confirm-dialog-accept]").click();
  await page.getByText("任务已归档，交付记录已保留。", { exact: true }).waitFor();
  await page.locator('[data-task-center-page="archive"]').click();
  await page.getByLabel(`${title}的更多操作`, { exact: true }).click();
  await page.locator(`[data-unarchive-task="${started.task.id}"]`).waitFor();
  await page.locator(`[data-unarchive-task="${started.task.id}"]`).click();
  await waitFor("Task restored from archive", async () => {
    const restored = await api(page, "/api/bootstrap");
    return restored.tasks.find((task) => task.id === started.task.id)?.archivedAt === null;
  });
  console.log(`PASS packaged local Task → Agent fixture → Artifact → review → visible human confirmation (${started.run.id})`);
  await packagedCli(['auth', 'login', '--username', username, '--password-stdin'], password + '\n');
  const cliTasks = await packagedCli(['tasks', 'list', '--search', title, '--all']);
  assert.ok(cliTasks.items.some(task => task.id === started.task.id));
  assert.ok(cliTasks.items.every(task => !Object.hasOwn(task, 'objective') && !Object.hasOwn(task, 'workflowSnapshot')));
  const detail = await packagedCli(['tasks', 'get', started.task.id]);
  assert.deepEqual(detail.team, { id: team.team.id, name: team.team.name });
  assert.deepEqual(detail.workflow, { id: workflow.workflowTemplate.id, name: workflow.workflowTemplate.name });
  assert.deepEqual(detail.manager, { id: manager.agent.id, name: manager.agent.name });
  for (const key of ['memberSnapshots', 'managerSnapshot', 'managerRuntime', 'workflowSnapshot', 'repositoryBindings']) assert.equal(Object.hasOwn(detail, key), false, key);
  const textDetail = await packagedCli(['tasks', 'get', started.task.id], '', undefined, false);
  assert.match(textDetail, new RegExp(`agentforge teams get ${team.team.id}`));
  assert.doesNotMatch(textDetail, /memberSnapshots|systemPrompt|managerRuntime|allowedTools/);
  assert.equal((await packagedCli(['teams', 'get', detail.team.id])).name, team.team.name);
  assert.equal((await packagedCli(['workflows', 'get', detail.workflow.id])).name, workflow.workflowTemplate.name);
  assert.equal((await packagedCli(['agents', 'get', detail.manager.id])).name, manager.agent.name);
  const receipt = await packagedCli(['tasks', 'create', '--file', '-'], JSON.stringify({ title: 'CLI 创建回执验收', objective: '只创建元数据用于输出检查，不启动模型。', teamId: team.team.id, workflowTemplateId: workflow.workflowTemplate.id }));
  assert.deepEqual(Object.keys(receipt.task).sort(), ['id', 'status', 'title']);
  assert.equal(receipt.task.status, 'backlog');
  assert.equal((await packagedCli(['tasks', 'get', receipt.task.id])).objective, '只创建元数据用于输出检查，不启动模型。');
  const cliProgress = await packagedCli(['tasks', 'progress', started.task.id]);
  assert.equal(cliProgress.runId, started.run.id);
  assert.equal(cliProgress.runStatus, 'completed');
  assert.ok(cliProgress.participants.every(item => Object.keys(item).sort().join(',') === 'id,name'));
  assert.ok((await packagedCli(['tasks', 'artifacts', started.task.id, '--all'])).items.length > 0);
  assert.ok((await packagedCli(['tasks', 'collaboration', started.task.id, '--all'])).items.length > 0);
  assert.equal((await packagedCli(['tasks', 'questions', started.task.id])).total, 0);
  console.log('PASS bundled task CLI progressive text/JSON, write receipt, explicit related lookups, progress, collaboration, questions and Artifacts');
  return { worker: worker.agent, team: team.team, workspaceRoot, runWorkspace: workspace.run.task.workspacePath };
}

async function runResetAndUnread(page, proof) {
  const externalFile = join(proof.workspaceRoot, "external-user-file.txt");
  await writeFile(externalFile, "disposable external sibling must survive factory reset");
  const { conversation } = await api(page, "/api/communications", { method: "POST", body: { kind: "agent", targetId: proof.worker.id } });
  await api(page, `/api/communications/${conversation.id}/messages`, { method: "POST", body: { content: "Disposable unread fixture probe", clientRequestId: randomBytes(12).toString("hex") } });
  await waitFor("unread employee reply", async () => (await api(page, "/api/notifications")).communicationUnreadCount === 1);
  await page.goto(urlFor(page, `/communication/${conversation.id}`));
  await page.getByLabel("聊天记录", { exact: true }).getByText("Packaged unread fixture reply", { exact: true }).waitFor();
  const speakerColors = await page.locator('.communication-message header strong').evaluateAll(nodes => nodes.map(node=>getComputedStyle(node).color));
  assert.ok(new Set(speakerColors).size >= 2, 'human and employee names use distinguishable accents');
  const alignment=await page.locator('.communication-message').evaluateAll(rows=>rows.map(node=>({human:node.classList.contains('from-human'),left:node.getBoundingClientRect().left})));
  assert.ok(alignment.find(row=>row.human).left>alignment.find(row=>!row.human).left+15,'packaged human messages align right, employees left');
  await page.screenshot({path:join(evidenceRoot,'packaged-communication-colors.png')});
  await waitFor("visible conversation read acknowledgement", async () => (await api(page, "/api/notifications")).communicationUnreadCount === 0);
  const group = (await api(page, '/api/communications', {method:'POST', body:{kind:'team', targetId:proof.team.id}})).conversation;
  await api(page, `/api/communications/${group.id}/messages`, {method:'POST',body:{content:'Group color fixture',mentionAgentIds:[proof.worker.id],clientRequestId:randomBytes(12).toString('hex')}});
  await waitFor('group fixture reply', async () => (await api(page, `/api/communications/${group.id}`)).messages.some(message=>message.sender.type==='agent'));
  await page.goto(urlFor(page, `/communication/${group.id}`));
  await page.locator('.communication-message:not(.from-human)').waitFor();
  assert.ok((await page.locator('.communication-message header strong').evaluateAll(nodes=>new Set(nodes.map(node=>getComputedStyle(node).color)).size)) >= 2);
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(800,650));
  await page.screenshot({path:join(evidenceRoot,'packaged-group-colors-narrow.png')});
  assert.equal(await page.locator('.communication-main').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1320,860));
  const before = await api(page, "/api/bootstrap");
  await page.goto(urlFor(page, "/settings/workspace"));
  await page.getByRole("button", { name: "清除所有数据", exact: true }).click();
  const form = page.locator("#reset-data-form"), submit = form.getByRole("button", { name: "清除并重新开始", exact: true });
  assert.equal(await submit.isDisabled(), true);
  await form.locator('[name="password"]').fill("wrong-disposable-password");
  await form.locator('[name="confirmation"]').fill("清除所有数据");
  await submit.click();
  await form.getByText("当前密码不正确", { exact: true }).waitFor();
  assert.equal((await api(page, "/api/bootstrap")).installationId, before.installationId);
  await form.locator('[name="password"]').fill(password);
  await submit.click();
  await page.locator("#setup-form").waitFor();
  assert.equal(await page.evaluate(async () => (await fetch("/api/bootstrap")).status), 401);
  await assert.rejects(access(proof.runWorkspace), /ENOENT/);
  assert.equal(await readFile(externalFile, "utf8"), "disposable external sibling must survive factory reset");
  await page.screenshot({ path: join(evidenceRoot, "packaged-reset-first-setup.png"), animations: "disabled" });
  await page.locator("#username").fill("packaged-reset");
  await page.locator("#password").fill(password);
  await page.locator("#confirmation").fill(password);
  await page.getByRole("button", { name: "创建管理员并进入工作区", exact: true }).click();
  await page.locator("#account-name").waitFor();
  const after = await api(page, "/api/bootstrap");
  assert.notEqual(after.installationId, before.installationId);
  assert.equal(after.runs.length, 0);
  assert.deepEqual(after.tasks, [], "reset must not recreate a portal task or bundle cwd");
  assert.deepEqual(after.teams, []);
  assert.equal(after.agents.length, 3);
  assert.ok(after.agents.every(employee => !('role' in employee)));
  assert.equal((await api(page, '/api/workflow-templates')).workflowTemplates.length, 1);
  assert.equal(after.agents.some(item => item.id === proof.worker.id), false);
  assert.deepEqual((await api(page, "/api/communications")).conversations, []);
  assert.deepEqual(await api(page, "/api/notifications"), { taskAttentionCount: 0, communicationUnreadCount: 0 });
  console.log("PASS packaged unread acknowledgement, rejected reset password, factory reset, external-file preservation and fresh administrator setup");
}

const launchOptions = {
  executablePath: executable,
  args: [`--user-data-dir=${profile}`],
  // The control plane must use the Electron-bundled Node runtime, not a developer's global `node`.
  env: { ...environment, HOME: home, SHELL: '/bin/zsh', ZDOTDIR: shellRoot, AGENTFORGE_DB_PATH: inheritedDatabase, AGENTFORGE_AUTH_DB_PATH: inheritedAuthDatabase, AGENTFORGE_RUNTIME_CONFIG_ROOT: join(evidenceRoot, "inherited-runtime"), HOST: "0.0.0.0", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  timeout: 60000
};
const desktop = await electron.launch(launchOptions);
let ownedOrigin;

async function verifyTrayFocus(page) {
  const reopenFromTray = async () => {
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    // Invoke the actual native Tray menu callback, not app.activate or a fake DOM event.
    await desktop.evaluate(() => globalThis.agentforgeTestTrayMenu.items.find(item => item.label === "打开 AgentForge").click());
    await page.waitForFunction(() => document.hasFocus());
  };
  await page.goto(urlFor(page, "/tasks"));
  const navigation = page.locator('.nav-item[data-view="tasks"]');
  await navigation.focus();
  await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
  assert.equal(await navigation.evaluate(node => document.activeElement === node && getComputedStyle(node).outlineWidth === "2px"), true);
  const selectedBackground = await navigation.evaluate(node => getComputedStyle(node).backgroundColor);
  await page.screenshot({ path: join(evidenceRoot, "tray-before-keyboard-focus.png"), animations: "disabled" });
  await reopenFromTray();
  try {
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.nav-item[data-view="tasks"]')).outlineStyle === "none", undefined, { timeout: 5000 });
  } catch (error) {
    await page.screenshot({ path: join(evidenceRoot, "tray-focus-regression.png"), animations: "disabled" });
    throw error;
  }
  assert.equal(await navigation.evaluate(node => document.activeElement === node && node.classList.contains("active")), true, "restoration must retain navigation focus and selection");
  assert.equal(await navigation.evaluate(node => getComputedStyle(node).backgroundColor), selectedBackground);
  await page.screenshot({ path: join(evidenceRoot, "tray-restored-no-ring.png"), animations: "disabled" });
  await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
  assert.equal(await navigation.evaluate(node => document.activeElement === node && getComputedStyle(node).outlineWidth === "2px" && !node.hasAttribute("data-desktop-restored-focus")), true, "Tab must restore the accessible focus ring");
  await page.screenshot({ path: join(evidenceRoot, "tray-keyboard-ring-restored.png"), animations: "disabled" });
  await reopenFromTray();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.nav-item[data-view="tasks"]')).outlineWidth === "2px");
  const input = page.locator('#task-search-form [name="name"]');
  await input.fill("unsaved query");
  await input.evaluate(node => node.setSelectionRange(2, 5));
  await reopenFromTray();
  assert.deepEqual(await input.evaluate(node => ({ focused: document.activeElement === node, value: node.value, start: node.selectionStart, end: node.selectionEnd, marked: node.hasAttribute("data-desktop-restored-focus") })), { focused: true, value: "unsaved query", start: 2, end: 5, marked: false });
  await input.fill("");
  await page.goto(urlFor(page, "/settings/general"));
  console.log("PASS native Tray restoration: no stale navigation ring; Tab/Enter rings and text draft/caret preserved");
}

try {
  const page = await desktop.firstWindow({ timeout: 120000 });
  ownedOrigin = new URL(page.url()).origin;
  assert.notEqual(ownedOrigin, "http://127.0.0.1:4310", "packaged client must not attach to Web");
  await desktop.evaluate(({ Tray }) => {
    const original = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function(menu) { globalThis.agentforgeTestTrayMenu = menu; return original.call(this, menu); };
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.locator("#setup-form").waitFor({ timeout: 60000 });
  await page.goto(`${ownedOrigin}/login`);
  await page.locator("#desktop-setup-guidance").waitFor();
  assert.equal(await page.locator("#source-setup-guidance").isVisible(), false);
  assert.equal(await page.locator("#login-help").isVisible(), false);
  assert.doesNotMatch(await page.locator("body").innerText(), /npm run|复用 4310/);
  await desktop.evaluate(({ Menu }) => {
    const navigation = Menu.getApplicationMenu().items.find(item => item.label === "导航");
    navigation.submenu.items.find(item => item.label === "首页 / 重新连接").click();
  });
  await page.locator("#setup-form").waitFor();
  await page.screenshot({ path: join(evidenceRoot, "packaged-first-run-in-app.png"), animations: "disabled" });
  assert.equal(await page.locator('head #agentforge-desktop-style').count(), 1, 'packaged setup has desktop style before render');
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#confirmation").fill("different-password");
  await page.getByRole("button", { name: "创建管理员并进入工作区", exact: true }).click();
  await page.getByText("两次输入的密码不一致。", { exact: true }).waitFor();
  await page.locator("#confirmation").fill(password);
  await page.getByRole("button", { name: "创建管理员并进入工作区", exact: true }).click();
  await page.locator("#account-name").waitFor({ timeout: 60000 });
  await page.waitForFunction((expected) => document.querySelector("#account-name")?.textContent === expected, username);
  assert.equal(await page.locator("#account-name").textContent(), username);
  const cliLogin = await packagedCli(['auth', 'login', '--username', username, '--password-stdin'], password + '\n');
  assert.equal(cliLogin.username, username);
  const cliProfiles = await packagedCli(['runtimes', 'list', '--all']);
  const humanProfiles = await packagedCli(['runtimes', 'list'], '', undefined, false);
  assert.match(humanProfiles, /Runtime列表/); assert.match(humanProfiles, /Provider/); assert.match(humanProfiles, /模型/); assert.ok(!humanProfiles.startsWith('{'));
  assert.equal(cliProfiles.items.length, 2);
  for (const runtime of [{profileId:null},{profileId:cliProfiles.items[0].id,extensionSelection:null},{skillPaths:[]}]) {
    const rejected=await page.evaluate(async body=>{
      const response=await fetch('/api/agents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      return response.status;
    },{name:'当前协议拒绝探针',runtime});
    assert.equal(rejected,400,'packaged HTTP rejects explicit nulls and obsolete fields');
  }
  for(const input of [
    {name:'禁止独立JSON',mcpJson:'{"mcpServers":{}}'},
    {name:'禁止单Skill选择',runtime:{profileId:cliProfiles.items[0].id,extensionSelection:{skillIds:[],mcpIds:[],pluginIds:[]}}}
  ]) {
    const status=await page.evaluate(async body=>(await fetch('/api/agents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,input);
    assert.equal(status,400,'packaged HTTP rejects retired extension input');
  }
  const unusedCodex = cliProfiles.items.find(profile => profile.provider === 'codex' && profile.employeeCount === 0);
  assert.ok(unusedCodex);
  await packagedCli(['runtimes', 'delete', unusedCodex.id, '--yes']);
  assert.equal((await api(page, '/api/settings/runtime-profiles')).profiles.some(profile => profile.id === unusedCodex.id), false, 'an unused default is deletable');
  const cliCustom = await packagedCli(['runtimes', 'create', '--file', '-'], JSON.stringify({ name: 'Packaged CLI disposable', provider: 'claude-code' }));
  await packagedCli(['runtimes', 'delete', cliCustom.id, '--yes']);
  await packagedCli(['auth', 'logout']);
  await assert.rejects(execute(cliLauncher, ['agents', 'list', '--session-file', cliSession, '--endpoint-file', endpointFile]), error => error.code === 3 && error.stdout === '' && /AUTH_REQUIRED/.test(error.stderr) && /处理建议/.test(error.stderr));
  console.log('PASS bundled CLI real HTTP authentication, private session and Runtime create/delete without global Node');
  const terminalSession = join(evidenceRoot, 'terminal-private/session.json');
  const interactive = await terminalLogin(terminalSession, password.slice(0, -1) + 'X\x7f' + password.slice(-1) + '\r');
  assert.equal(interactive.ok, true); assert.equal(interactive.data.username, username);
  assert.equal((await stat(terminalSession)).mode & 0o777, 0o600);
  const terminalState = await execute(cliLauncher, ['auth', 'status', '--session-file', terminalSession, '--endpoint-file', endpointFile, '--json']);
  assert.equal(JSON.parse(terminalState.stdout).data.username, username);
  await execute(cliLauncher, ['auth', 'logout', '--session-file', terminalSession, '--endpoint-file', endpointFile, '--json']);
  const cancelledSession = join(evidenceRoot, 'cancelled-session.json');
  const cancelled = await terminalLogin(cancelledSession, '\x03', 130);
  assert.equal(cancelled.ok, false); assert.equal(cancelled.error.code, 'CANCELLED');
  await assert.rejects(stat(cancelledSession), { code: 'ENOENT' });
  const wrong = await terminalLogin(cancelledSession, 'synthetic-wrong-password\r', 3);
  assert.equal(wrong.ok, false); assert.equal(wrong.error.code, 'AUTH_REQUIRED');
  await assert.rejects(stat(cancelledSession), { code: 'ENOENT' });
  console.log('PASS real PTY hidden login with backspace, status/logout, Ctrl+C and rejected password; TERM=dumb, no global Node');
  const reuseShell = join(evidenceRoot, 'reuse-shell'), expectedLoad = join(reuseShell, 'shell-loaded');
  await mkdir(reuseShell);
  await writeFile(join(reuseShell, '.zshrc'), `print loaded > '${expectedLoad}'\n`);
  // A second desktop with its own HOME owns an isolated ~/.agentforge/desktop instance.
  const reusedHome = join(evidenceRoot, 'reused-home');
  await mkdir(reusedHome, { mode: 0o700 });
  const reused = await electron.launch({ ...launchOptions, args: [`--user-data-dir=${join(evidenceRoot, 'reused-profile')}`], env: { ...launchOptions.env, HOME: reusedHome, ZDOTDIR: reuseShell } });
  try {
    const reusedPage = await reused.firstWindow();
    await reusedPage.locator('#setup-form').waitFor();
    assert.notEqual(new URL(reusedPage.url()).origin, ownedOrigin, 'parallel desktop owns another service');
    await access(expectedLoad);
  } finally { await reused.close(); }
  assert.equal((await fetch(`${ownedOrigin}/api/health`)).status, 200, 'closing another desktop preserves the first client service');
  console.log('PASS parallel desktop has an isolated service and does not disturb the first client');
  const fresh = await api(page, "/api/bootstrap");
  assert.deepEqual(fresh.tasks, [], "first install must have no sample Task");
  assert.deepEqual(fresh.teams, [], "first install must not prebuild a team");
  assert.equal(fresh.agents.length, 3, 'only three editable employee examples');
  assert.ok(fresh.agents.every(employee => !('role' in employee)));
  assert.equal((await api(page, '/api/workflow-templates')).workflowTemplates.length, 1, 'only one example workflow');
  const missingCli = await api(page, "/api/settings/runtime-profiles", { method: "POST", body: { name: "Missing CLI diagnosis fixture", provider: "claude-code", executable: join(evidenceRoot, "not-installed-cli") } });
  const failure = await api(page, `/api/settings/runtime-profiles/${missingCli.id}/test`, { method: "POST", body: {} });
  assert.equal(failure.ok, false);
  const { filePath } = await api(page, "/api/settings/log-files");
  const diagnostics = (await readFile(filePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(diagnostics.some(row => row.event === "provider.spawn_error" && row.error.code === "ENOENT"));
  const diagnosis = diagnostics.find(row => row.event === "provider.launch_diagnostic");
  assert.equal(diagnosis.candidates[0].exists, false);
  assert.equal(diagnosis.workingDirectory.usable, true);
  assert.ok(diagnosis.nextSteps.some(step => step.includes("设置 → Runtime")));
  console.log("PASS packaged missing CLI: original ENOENT, actual PATH/cwd/candidates and actionable private-file diagnosis");
  await page.goto(urlFor(page, '/settings/runtime'));
  const deletable = page.locator(`[data-runtime-profile="${missingCli.id}"]`);
  await deletable.waitFor();
  assert.equal(await page.locator('[data-runtime-profile][open]').count(), 0);
  assert.equal(await page.locator('[data-settings-page="runtime"]').innerText(), 'Runtime');
  const referenced = cliProfiles.items.find(profile => profile.employeeCount > 0);
  assert.equal(await page.locator(`[data-runtime-profile="${referenced.id}"] [data-delete-runtime]`).isDisabled(), true, 'real current-employee references prevent deletion, not built-in identity');
  assert.equal(await page.getByText('本机执行说明与版本', { exact: true }).count(), 0);
  await deletable.locator('summary').click(); await deletable.locator('[data-delete-runtime]').click();
  await page.locator('[data-cancel-runtime-delete]').click();
  assert.ok((await api(page, '/api/settings/runtime-profiles')).profiles.some(profile => profile.id === missingCli.id));
  await deletable.locator('[data-delete-runtime]').click(); await page.locator('[data-confirm-runtime-delete]').click();
  await deletable.waitFor({ state: 'detached' });
  await page.screenshot({ path: join(evidenceRoot, 'packaged-runtime-collapsed.png') });
  console.log('PASS packaged Runtime hierarchy, collapsed forms, reference rejection and unused-default/custom deletion');
  const exampleFlow = (await api(page, '/api/workflow-templates')).workflowTemplates[0];
  await api(page, `/api/workflow-templates/${exampleFlow.id}`, { method: 'DELETE', body: {} });
  for (const employee of fresh.agents) await api(page, `/api/agents/${employee.id}`, { method: 'DELETE', body: {} });
  assert.deepEqual((await api(page, '/api/bootstrap')).agents, [], 'every unreferenced example employee, including the manager, is deletable');
  assert.deepEqual((await api(page, '/api/workflow-templates')).workflowTemplates, []);
  console.log('PASS minimal first-run catalog has no built-in deletion protection');
  if (process.platform === "darwin") {
    await page.goto(urlFor(page, "/settings/general"));
    await page.getByText("尚未设置；首次关闭窗口时会询问，取消不会保存选择。", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => Object.keys(window.agentforgeDesktop).sort()), ["copyWorkspacePath", "getCliInstallation", "getPreferences", "installCli", "setCloseMode"]);
    await page.locator('[data-settings-page="cli"]').click();
    await assert.rejects(page.evaluate(() => window.agentforgeDesktop.getPreferences()), /仅允许/);
    const cliHome = join(evidenceRoot, 'installed-cli-home');
    await mkdir(cliHome, { mode: 0o700 });
    const originalHome = await desktop.evaluate(({ app }) => ({ home: app.getPath('home'), zdotdir: process.env.ZDOTDIR }));
    try {
      await desktop.evaluate(({ app }, home) => { app.setPath('home', home); delete process.env.ZDOTDIR; }, cliHome);
      await page.locator('[data-cli-refresh]').click();
      await page.locator('[data-cli-install]:not([disabled])').waitFor();
      const cancelledWindow = desktop.waitForEvent('window');
      await page.locator('[data-cli-install]').click();
      const cancellation = await cancelledWindow;
      await cancellation.waitForLoadState('domcontentloaded');
      await cancellation.locator('[data-command-path]').waitFor();
      assert.match(await cancellation.locator('[data-command-path]').textContent(), new RegExp(cliHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(await cancellation.locator('[data-choice="cancel"]').evaluate(button => button === document.activeElement), true);
      assert.equal(await cancellation.evaluate(() => typeof window.require), 'undefined');
      const dialogState = await cancellation.locator('[data-choice="install"]').evaluate(button => ({ bottom: button.getBoundingClientRect().bottom, height: innerHeight, color: getComputedStyle(document.body).backgroundColor, font: getComputedStyle(document.body).fontFamily }));
      assert.ok(dialogState.bottom <= dialogState.height && dialogState.font.length > 0, 'styled consent has loaded CSS and a visible action');
      await cancellation.screenshot({ path: join(evidenceRoot, 'packaged-cli-install-confirm.png'), animations: 'disabled' });
      await cancellation.locator('[data-choice="cancel"]').click();
      await page.getByText('已取消，未安装。', { exact: true }).waitFor();
      await assert.rejects(access(join(cliHome, '.local/bin/agentforge')), /ENOENT/);
      const confirmedWindow = desktop.waitForEvent('window');
      await page.locator('[data-cli-install]').click();
      const confirmation = await confirmedWindow;
      await confirmation.waitForLoadState('domcontentloaded');
      await confirmation.locator('[data-choice="install"]').click();
      await page.getByText('已安装。请新开终端运行 agentforge help；已有终端需重新打开。', { exact: true }).waitFor();
      const installation = await page.evaluate(() => window.agentforgeDesktop.getCliInstallation());
      assert.equal(installation.installed, true);
      assert.ok(['zsh', 'bash'].includes(installation.shell));
      const result = await execute(`/bin/${installation.shell}`, ['-ilc', 'agentforge schema agents --json'], { env: { HOME: cliHome, ZDOTDIR: cliHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb' }, timeout: 30000 });
      assert.equal(JSON.parse(result.stdout).data.group, 'agents');
      const terminal = await execute(`/bin/${installation.shell}`, ['-ilc', 'agentforge help agents'], { env: { HOME: cliHome, ZDOTDIR: cliHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb' }, timeout: 30000 });
      assert.ok(!terminal.stdout.startsWith('{')); assert.match(terminal.stdout, /子命令/);
      assert.doesNotMatch(terminal.stdout, /JSON 输入模板/);
      const commandHelp = await execute(`/bin/${installation.shell}`, ['-ilc', 'agentforge agents create --help'], { env: { HOME: cliHome, ZDOTDIR: cliHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb' }, timeout: 30000 });
      assert.match(commandHelp.stdout, /runtime.extensionSelection.pluginIds/); assert.match(commandHelp.stdout, /JSON 输入模板/);
      const shell = { shell: installation.shell, home: cliHome };
      await packagedCli(['auth', 'login', '--username', username, '--password-stdin'], password + '\n', shell);
      assert.match(await packagedCli(['runtimes', 'list'], '', shell, false), /Provider/);
      const configured = await packagedCli(['runtimes', 'create', '--file', '-'], JSON.stringify({ name: 'Installed shell CLI proof', provider: 'claude-code' }), shell);
      assert.ok((await api(page, '/api/settings/runtime-profiles')).profiles.some(item => item.id === configured.id));
      await packagedCli(['runtimes', 'delete', configured.id, '--yes'], '', shell);
      await packagedCli(['auth', 'logout'], '', shell);
      await page.screenshot({ path: join(evidenceRoot, 'packaged-cli-installed.png'), animations: 'disabled' });
      console.log('PASS General styled host consent cancellation/installation and fresh-shell progressive help/login/configuration/HTTP readback/logout, fixture home only');
    } finally {
      await desktop.evaluate(({ app }, saved) => {
        app.setPath('home', saved.home);
        if (saved.zdotdir === undefined) delete process.env.ZDOTDIR; else process.env.ZDOTDIR = saved.zdotdir;
      }, originalHome);
    }
    await page.goto(urlFor(page, "/settings/general"));
    await assert.rejects(page.evaluate(() => window.agentforgeDesktop.getCliInstallation()), /仅允许/);
    // First close asks through the app-styled dialog window; cancel keeps the
    // main window visible and saves no preference.
    const closingEvent = desktop.waitForEvent('window');
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const closing = await closingEvent;
    await closing.waitForLoadState('domcontentloaded');
    await closing.locator('[data-dialog-choice="2"]').waitFor();
    assert.deepEqual(await closing.locator('[data-dialog-choice]').allTextContents(), ['退出程序', '保留在菜单栏', '取消']);
    assert.equal(await closing.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight && document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'first-close dialog has no scrollbars');
    await closing.screenshot({ path: join(evidenceRoot, 'packaged-first-close-dialog.png'), animations: 'disabled' });
    const closingClosed = closing.waitForEvent('close');
    await closing.locator('[data-dialog-choice="2"]').click();
    await closingClosed;
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true, 'cancel must keep the window visible');
    await assert.rejects(access(join(storage.dataRoot, "desktop-preferences.json")), /ENOENT/);
    await page.locator('input[name="closeMode"][value="tray"]').check();
    const blockedPreference = join(storage.dataRoot, "desktop-preferences.json.tmp");
    await mkdir(blockedPreference);
    try {
      await page.locator('[data-close-form] button[type="submit"]').click();
      await page.getByText("保存失败，原设置未更改。请重试；详细原因见运行日志。", { exact: true }).waitFor();
      assert.equal(await page.locator('input[name="closeMode"][value="tray"]').isChecked(), true);
      await assert.rejects(access(join(storage.dataRoot, "desktop-preferences.json")), /ENOENT/);
      assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    } finally { await rmdir(blockedPreference); }
    await page.locator('[data-close-form] button[type="submit"]').click();
    await page.getByText("已保存；后续关闭窗口按此设置执行。", { exact: true }).waitFor();
    await waitFor("saved tray preference", async () => JSON.parse(await readFile(join(storage.dataRoot, "desktop-preferences.json"), "utf8")).closeMode === "tray");
    await page.screenshot({ path: join(evidenceRoot, "packaged-general-settings.png"), animations: "disabled" });
    assert.equal(await page.evaluate(async () => {
      try { await window.agentforgeDesktop.setCloseMode("invalid"); return false; } catch { return true; }
    }), true, "invalid mode must be rejected without changing the saved preference");
    assert.equal(JSON.parse(await readFile(join(storage.dataRoot, "desktop-preferences.json"), "utf8")).closeMode, "tray");
    await page.goto(urlFor(page, "/settings/appearance"));
    assert.equal(await page.evaluate(async () => {
      try { await window.agentforgeDesktop.getPreferences(); return false; } catch { return true; }
    }), true, "main process must reject preference access outside the exact General route");
    assert.equal(await page.evaluate(async () => {
      try { await window.agentforgeDesktop.installCli(); return false; } catch { return true; }
    }), true, 'CLI install outside General must be rejected');
    await page.goto(urlFor(page, "/settings/general"));
    await page.locator('input[name="closeMode"][value="tray"]:checked').waitFor();
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    assert.equal((await fetch(`${ownedOrigin}/api/health`)).status, 200, "hiding preserves owned service");
    await desktop.evaluate(({ app }) => app.emit("activate"));
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    await verifyTrayFocus(page);
    console.log("PASS packaged Mac close-to-tray hides/restores the window and preserves owned service");
  }
  assert.equal(await page.locator('head #agentforge-desktop-style').count(), 1);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--desktop-presentation').trim()), 'workbench');
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  const webWindow = desktop.waitForEvent("window");
  await desktop.evaluate(async ({ BrowserWindow }, origin) => {
    const browser = new BrowserWindow({ width: 1200, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await browser.loadURL(`${origin}/settings/general`);
  }, ownedOrigin);
  const webSettings = await webWindow;
  try {
    await webSettings.getByText("关闭窗口行为仅适用于 macOS 客户端，请在客户端中设置。", { exact: true }).waitFor();
    assert.equal(await webSettings.locator('[data-close-form]').isVisible(), false);
    assert.equal(await webSettings.evaluate(() => typeof window.agentforgeDesktop), "undefined");
    assert.equal(await webSettings.locator('head #agentforge-desktop-style').count(), 0);
    await webSettings.setViewportSize({ width: 390, height: 844 });
    assert.equal(await webSettings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await webSettings.screenshot({ path: join(evidenceRoot, "packaged-web-general-narrow.png"), animations: "disabled" });
    assert.equal(await webSettings.locator('[data-settings-page="cli"], [data-settings-panel="cli"]').count(), 0);
    await webSettings.goto(`${ownedOrigin}/settings/cli`);
    await webSettings.locator('[data-settings-panel="general"]:not([hidden])').waitFor();
    for (const category of ["appearance", "workspace"]) {
      await webSettings.locator(`[data-settings-page="${category}"]`).click();
      await webSettings.locator(`[data-settings-panel="${category}"]:not([hidden])`).waitFor();
      await webSettings.reload();
      await webSettings.locator(`[data-settings-panel="${category}"]:not([hidden])`).waitFor();
      assert.equal(await webSettings.locator('[data-settings-page="navigation"], [data-settings-page="data"]').count(), 0);
      if (category === "appearance") {
        await webSettings.locator('[data-display-option="showGroups"]').uncheck();
        await webSettings.reload();
        assert.equal(await webSettings.locator('[data-display-option="showGroups"]').isChecked(), false);
      }
      if (category === "workspace") {
        await webSettings.locator('[data-reset-all]').click();
        assert.equal(await webSettings.locator('#reset-data-form button[type="submit"]').isDisabled(), true);
        await webSettings.locator('[data-cancel-reset]').click();
      }
      assert.equal(await webSettings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await webSettings.screenshot({ path: join(evidenceRoot, `packaged-web-${category}-narrow.png`), animations: "disabled" });
    }
  } finally { await webSettings.close(); }
  console.log("PASS General settings Web-only applicability and narrow layout without desktop authority/style");
  assert.deepEqual(await page.evaluate(async () => (await fetch("/api/auth/bootstrap-status")).json()), { available: false, configured: true });

  const auth = await stat(storage.AGENTFORGE_AUTH_DB_PATH);
  const metadata = await stat(storage.AGENTFORGE_DB_PATH);
  assert.ok(auth.isFile());
  assert.ok(metadata.isFile());
  assert.ok(storage.dataRoot.startsWith(home + '/'), 'packaged instance state lives under the isolated HOME data home');
  await assert.rejects(access(join(profile, "agentforge.sqlite")), /ENOENT/, 'Chromium userData must not hold the application database');
  assert.equal((await stat(storage.dataRoot)).mode & 0o777, 0o700);
  await assert.rejects(access(inheritedDatabase), /ENOENT/);
  await assert.rejects(access(inheritedAuthDatabase), /ENOENT/);
  await assert.rejects(access(join(evidenceRoot, 'shell-must-not-be-used.sqlite')), /ENOENT/);

  await page.screenshot({ path: join(evidenceRoot, "packaged-first-run.png"), animations: "disabled" });
  const resetProof = await runPackagedTask(page);
  const logStatus = await api(page, '/api/settings/log-files');
  const logText = (await Promise.all((await readdir(logStatus.directory)).filter(name => name.endsWith('.jsonl')).map(name => readFile(join(logStatus.directory, name), 'utf8')))).join('\n');
  assert.equal(logText.includes(shellProof), false, 'shell environment and startup noise must never be logged');
  const shellRecords = logText.split('\n').filter(Boolean).map(JSON.parse).filter(row => row.event === 'desktop.shell_environment');
  assert.equal(shellRecords.filter(row => row.status === 'applied').length, 1, 'resolve shell environment once per host');
  assert.equal(shellRecords.find(row => row.status === 'applied').afterPath.split(':')[0], shellBin);
  await writeFile(join(evidenceRoot, 'shell-startup-evidence.json'), JSON.stringify(shellRecords, null, 2));
  console.log('PASS packaged zprofile/zshrc environment reaches a shell-only CLI/Node and remains absent from logs');
  await page.locator('[data-view="settings"]').click();
  await page.locator('[data-settings-page="general"]').click();
  await page.locator("#logout-button").click();
  await page.locator("#username").waitFor();
  await page.locator("#username").fill(username);
  await page.locator("#password").fill("incorrect-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#password")?.value === "");
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator("#account-name").waitFor();
  await page.waitForFunction((expected) => document.querySelector("#account-name")?.textContent === expected, username);
  assert.deepEqual(pageErrors, []);
  await runResetAndUnread(page, resetProof);
  assert.deepEqual(pageErrors, []);
  console.log(`PASS packaged macOS Beta first-run setup, isolated data, bundled control plane, task lifecycle and login at ${evidenceRoot}`);
} finally {
  await desktop.close();
}

if (process.platform === "darwin") {
  const reopened = await electron.launch(launchOptions);
  const reopenedProcess = reopened.process();
  try {
    const reopenedPage = await reopened.firstWindow({ timeout: 60000 });
    await reopenedPage.waitForURL(url => url.hostname === '127.0.0.1' && url.port !== '4310', { timeout: 60000 });
    await reopenedPage.goto(urlFor(reopenedPage, "/settings/general"));
    if (new URL(reopenedPage.url()).pathname === "/login") {
      await reopenedPage.locator('#username').fill("packaged-reset");
      await reopenedPage.locator('#password').fill(password);
      await reopenedPage.getByRole("button", { name: "登录", exact: true }).click();
      await reopenedPage.locator('#account-name').waitFor();
      await reopenedPage.goto(urlFor(reopenedPage, "/settings/general"));
    }
    await reopenedPage.locator('input[name="closeMode"][value="tray"]:checked').waitFor();
    await reopenedPage.locator('input[name="closeMode"][value="quit"]').check();
    await reopenedPage.locator('[data-close-form] button[type="submit"]').click();
    await reopenedPage.getByText("已保存；后续关闭窗口按此设置执行。", { exact: true }).waitFor();
    await waitFor("saved quit preference", async () => JSON.parse(await readFile(join(storage.dataRoot, "desktop-preferences.json"), "utf8")).closeMode === "quit");
    const exited = new Promise(resolve => reopenedProcess.once("exit", resolve));
    await reopened.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(error => { if (!/closed/i.test(error.message)) throw error; });
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("close in quit mode did not exit")), 10000).unref())]);
    assert.equal(reopenedProcess.exitCode, 0);
    console.log("PASS packaged Mac close preference survives restart; quit mode really exits");
  } finally { if (reopenedProcess.exitCode === null && reopenedProcess.signalCode === null) await reopened.close(); }

  await waitFor('previous owned service stopped', async () => !await fetch(`${ownedOrigin}/api/health`).then(() => true, () => false));
  const slowShell = join(evidenceRoot, 'slow-shell'), slowProfile = join(evidenceRoot, 'cancel-profile');
  await mkdir(slowShell);
  // This pre-navigation instance gets its own HOME so its data root is fresh.
  const slowHome = join(evidenceRoot, 'cancel-home');
  await mkdir(slowHome, { mode: 0o700 });
  const slowDatabase = join(slowHome, '.agentforge', 'desktop', 'agentforge.sqlite');
  const shellPidFile = join(slowShell, 'shell.pid'), lateFile = join(slowShell, 'late-marker');
  await writeFile(join(slowShell, '.zshenv'), `print -r -- $$ > '${shellPidFile}'\n/bin/sleep 30\nprint late > '${lateFile}'\n`);
  // Playwright's app connection waits for the first navigated page. For this
  // pre-navigation case use the same loopback Node inspector directly.
  const cancellingProcess = spawn(executable, ['--inspect=127.0.0.1:0', `--user-data-dir=${slowProfile}`], { env: { ...launchOptions.env, HOME: slowHome, ZDOTDIR: slowShell }, stdio: ['ignore', 'ignore', 'pipe'] });
  let inspectorUrl, inspector, shellPid, inspectorBanner = '';
  cancellingProcess.stderr.on('data', chunk => { inspectorBanner = (inspectorBanner + chunk).slice(-4096); inspectorUrl ||= inspectorBanner.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1]; });
  try {
    await waitFor('slow shell really started', () => access(shellPidFile).then(() => true, () => false));
    shellPid = Number((await readFile(shellPidFile, 'utf8')).trim()); assert.ok(Number.isInteger(shellPid) && shellPid > 1);
    process.kill(shellPid, 0);
    await assert.rejects(access(lateFile), /ENOENT/, 'capture must still be pending before quit');
    await assert.rejects(access(join(slowProfile, 'agentforge.sqlite')), /ENOENT/, 'userData keeps no application database');
    await assert.rejects(access(slowDatabase), /ENOENT/, 'backend must not exist before quit');
    await waitFor('main inspector ready', () => Boolean(inspectorUrl));
    inspector = new WebSocket(inspectorUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('main inspector connection timed out')), 10000);
      inspector.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      inspector.addEventListener('error', () => { clearTimeout(timer); reject(new Error('main inspector connection failed')); }, { once: true });
    });
    const exited = new Promise(resolve => cancellingProcess.once('exit', resolve));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('main quit command timed out')), 10000);
      inspector.addEventListener('message', event => {
        const response = JSON.parse(event.data);
        if (response.id !== 1) return;
        clearTimeout(timer);
        if (response.error || response.result?.exceptionDetails || response.result?.result?.value !== true) reject(new Error('main quit command was rejected'));
        else resolve();
      });
      inspector.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "(() => { const app = require('electron').app; setImmediate(() => app.quit()); return true; })()", includeCommandLineAPI: true, returnByValue: true } }));
    });
    inspector.close();
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('quit blocked by shell initialization')), 10000).unref())]);
    assert.equal(cancellingProcess.exitCode, 0);
    await waitFor('capture shell stopped', async () => { try { process.kill(shellPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
    await assert.rejects(access(lateFile), /ENOENT/);
    await assert.rejects(access(slowDatabase), /ENOENT/);
    assert.equal(await fetch(`${ownedOrigin}/api/health`).then(() => true, () => false), false);
    console.log('PASS quit during real slow shell capture cancels its process group and never starts a late backend');
  } finally {
    inspector?.close();
    if (cancellingProcess.exitCode === null && cancellingProcess.signalCode === null) {
      if (shellPid) { try { process.kill(-shellPid, 'SIGKILL'); } catch { /* Already reaped by the application. */ } }
      cancellingProcess.kill('SIGKILL');
    }
  }
}
