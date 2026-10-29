// Opt-in real Claude + visible browser test, isolated business/auth data. Uses fixed port 4310.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { chromium } from "playwright-core";
import { createCatalogFixtureStore as createStore } from "../tests/fixture-store.mjs";
import { createAuth } from "../server/auth.mjs";
import { verifyHistoryEvidence } from "./verify-history-evidence.mjs";

if (await fetch("http://127.0.0.1:4310/api/health").then(()=>true,()=>false)) throw new Error("请先停止已核实的 AgentForge 服务；测试不会终止端口占用者");
await mkdir(".data",{recursive:true}); await mkdir("screenshots",{recursive:true});
const resume=process.env.AGENTFORGE_HISTORY_E2E_RESUME;
const root=resume?resolve(resume):await mkdtemp(resolve(".data/history-e2e-"));
assert.equal(dirname(root),resolve(".data"));assert.match(basename(root),/^history-e2e-[a-zA-Z0-9]+$/);
const databasePath=join(root,"state.sqlite"), authPath=join(root,"auth.sqlite");
const password=randomBytes(24).toString("hex"), auth=createAuth({databasePath:authPath});
await auth.setAdministrator("history-e2e",password);auth.close();
const store=createStore({databasePath,workspaceRoot:join(root,"workspaces")});
const analyst="agent_analyst", designer="agent_designer", manager="system_project_manager";
const historical=resume?store.snapshot().communicationMessages:[];
const secret=resume?historical.find(m=>m.content.startsWith("历史验收暗号："))?.content.split("：")[1]:"松针-"+randomBytes(4).toString("hex");
const groupCode=resume?historical.find(m=>m.content.startsWith("团队历史代号："))?.content.split("：")[1]:"榕树-"+randomBytes(4).toString("hex");
assert.ok(secret&&groupCode);
const privateChat=store.openCommunication({kind:"agent",targetId:analyst});
const group=store.openCommunication({kind:"team",targetId:"team_product_delivery"});
function seed(chat,content,recipients=[]) {
  store.sendCommunication(chat,{content,mentionAgentIds:recipients,clientRequestId:randomUUID()});
  let item;while((item=store.claimCommunication(chat))) store.completeCommunication(chat,item.id,"已保存测试资料。");
}
let task;
if(!resume){
store.transaction(()=>{
  seed(privateChat.id,`历史验收暗号：${secret}`);
  for(let i=0;i<65;i++)seed(privateChat.id,`归档背景资料 ${i}，不包含暗号。`);
});
seed(group.id,`团队历史代号：${groupCode}`,[analyst]);
const other=store.openCommunication({kind:"agent",targetId:designer});seed(other.id,"设计师私人标记：不可向其他员工开放");
const managerChat=store.openCommunication({kind:"agent",targetId:manager});seed(managerChat.id,"项目经理历史规则：历史验收任务采用只读查询与 Markdown 证据交付，不能发布代码。");
const team=store.createTeam({name:"历史查询验收团队",memberAgentIds:[analyst,designer]});
const flow=store.createWorkflowTemplate({name:"跨场景历史查询验收",nodes:[
  {id:"lookup",title:"历史检索与证据",staffingGuidance:"擅长从历史资料检索事实并保留来源的成员",dependsOn:[],artifactPaths:["docs/lookup/"]},
  {id:"verify",title:"独立证据核验",staffingGuidance:"不是作者，能独立核对历史证据和文件的成员",dependsOn:["lookup"],artifactPaths:["docs/verify/"]}
]});
task=store.createTask({title:"HISTORY-E2E｜私聊、群聊到任务的历史检索闭环",teamId:team.id,workflowTemplateId:flow.id,nodeAssignments:{lookup:analyst,verify:designer},objective:
  "这是平台历史工具验收，不是开发软件。lookup 员工必须直接调用 mcp__agentforge_history__search_private_chat 搜索“历史验收暗号”，调用 mcp__agentforge_history__search_group_chat 搜索“团队历史代号”，再 mcp__agentforge_history__read_context 读两条原文，将实际值与 recordId 写入 docs/lookup/evidence.md。这些原文不在当前任务上下文中，必须真实调用历史 MCP，不允许读取平台数据库或通过 Bash 访问 socket。verify 员工只核对该 Markdown 含实际两条检索原文、来源 ID，然后直接调用 mcp__agentforge_history__search_task_activity 查询当前任务“历史检索”，写 docs/verify/report.md。只写各自指定文档，不改代码、不调用外网、不发布。项目经理首先直接调用 mcp__agentforge_history__search_private_chat 查询“项目经理历史规则”，然后依次安排 lookup、verify；两份实际文档满足标准后进入交付复核与待人类验收。无需额外澄清。"});
}else{task=store.listTasks().find(t=>t.title==="HISTORY-E2E｜私聊、群聊到任务的历史检索闭环");assert.ok(task);}
const backend=spawn(process.execPath,["server/index.mjs"],{cwd:process.cwd(),detached:true,env:{...process.env,AGENTFORGE_DB_PATH:databasePath,AGENTFORGE_AUTH_DB_PATH:authPath,AGENTFORGE_RUN_FILES_ROOT:join(root,"runs"),AGENTFORGE_RUNTIME_CONFIG_ROOT:join(root,"runtime"),AGENTFORGE_WORKSPACE_ROOT:join(root,"workspaces")},stdio:["ignore","pipe","pipe"]});
backend.stdout.on("data",chunk=>process.stdout.write(chunk));
backend.stderr.on("data",chunk=>process.stderr.write(chunk));
let browser,runId;
const stopBackend=()=>{try{process.kill(-backend.pid,"SIGTERM");}catch{backend.kill("SIGTERM");}};
process.once("SIGTERM",async()=>{if(browser)await browser.close();stopBackend();process.exit(1);});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,fn,timeout=600000){const start=Date.now();let last=0;while(Date.now()-start<timeout){const value=await fn();if(value){console.log("PASS "+label);return value;}if(Date.now()-last>20000){console.log("WAIT "+label);last=Date.now();}await sleep(1000);}throw new Error("超时："+label);}
try{
  await wait("服务健康",()=>{if(backend.exitCode!==null)throw new Error("测试后台提前退出");return fetch("http://127.0.0.1:4310/api/health").then(r=>r.ok,()=>false);},120000);
  assert.equal((await fetch(`http://127.0.0.1:4310/api/agents/${analyst}/history/list_sessions`,{method:"POST",headers:{"Content-Type":"application/json",Origin:"http://127.0.0.1:4310"},body:"{}"})).status,401);
  browser=await chromium.launch({channel:"chrome",headless:false});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("http://127.0.0.1:4310/");await page.locator("#username").fill("history-e2e");await page.locator("#password").fill(password);await page.getByRole("button",{name:"登录",exact:true}).click();await page.locator("#account-name").waitFor();
  const api=async(path,body)=>page.evaluate(async({path,body})=>{const response=await fetch(path,body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(JSON.stringify(data));return data;},{path,body});
  const search=await api(`/api/agents/${analyst}/history/search_private_chat`,{query:"历史验收暗号"});assert.ok(search.items[0].content.includes(secret));
  const foreign=await api(`/api/agents/${designer}/history/search_private_chat`,{query:"历史验收暗号"});assert.equal(foreign.items.length,0);
  let privateReply;
  if(!resume){
  await page.goto(`http://127.0.0.1:4310/communication/${privateChat.id}`);await page.locator("#communication-input").waitFor();
  await page.locator("#communication-input").fill("请使用平台历史 MCP 搜索“历史验收暗号”和“团队历史代号”，读取两条原文再告诉我实际的两个值，并给出来源 recordId。不要猜测，不要读取本机数据库。");await page.locator("#communication-input").press("Enter");
  privateReply=await wait("浏览器私聊真实 Claude 跨私聊/群聊检索",async()=>{const c=await api(`/api/communications/${privateChat.id}`);const failed=c.deliveries.find(d=>d.status==="failed");if(failed)throw new Error(failed.error);return c.messages.find(m=>m.sender.type==="agent"&&m.content.includes(secret)&&m.content.includes(groupCode));});
  await wait("浏览器呈现私聊回复",()=>page.locator(".communication-body").filter({hasText:secret}).count());
  await page.screenshot({path:"screenshots/history-private-e2e.png"});
  await api(`/api/communications/${group.id}/messages`,{content:"请用 MCP 搜索本群历史的“团队历史代号”，回答实际值并引用 recordId。不要读本机数据库。",mentionAgentIds:[analyst],clientRequestId:randomUUID()});
  await page.goto(`http://127.0.0.1:4310/communication/${group.id}`);
  await wait("群聊真实 Claude 历史查询",async()=>{const c=await api(`/api/communications/${group.id}`);return c.messages.find(m=>m.sender.type==="agent"&&m.content.includes(groupCode));});
  await page.screenshot({path:"screenshots/history-group-e2e.png"});
  }else{privateReply=historical.find(m=>m.conversationId===privateChat.id&&m.sender.type==="agent"&&m.content.includes(secret)&&m.content.includes(groupCode));assert.ok(privateReply);}
  const existing=store.listRuns().find(r=>r.taskId===task.id);
  runId=existing?.id || (await api(`/api/tasks/${task.id}/run`,{})).run.id;
  await page.goto(`http://127.0.0.1:4310/runs/${runId}`);
  const workspace=await wait("真实两角色任务交付并等待人类验收",async()=>{const w=await api(`/api/runs/${runId}/workspace?view=summary`);if(w.run?.status==="awaiting_human")throw new Error("出现未计划澄清");return ["awaiting_acceptance","completed"].includes(w.run?.status)?w:null;},2700000);
  assert.ok(workspace.artifacts.length>=2);
  const full=await api(`/api/runs/${runId}/workspace`);
  assert.ok(full.events.some(e=>e.data?.toolUseId&&e.data?.toolName==="mcp__agentforge_history__search_private_chat"),"task MCP invocation recorded");
  assert.ok(full.events.some(e=>e.data?.toolUseId&&e.data?.toolName==="mcp__agentforge_history__search_task_activity"),"task history invocation recorded");
  if(workspace.run.status!=="completed"){
    assert.equal(workspace.run.status,"awaiting_acceptance");
    const openCompletion=page.locator("[data-open-completion-confirm]");
    await openCompletion.waitFor();
    await openCompletion.click();
    await page.waitForFunction(()=>{
      const backdrop=document.querySelector("#modal-backdrop"), modal=backdrop?.querySelector(".modal");
      return backdrop?.classList.contains("open")&&modal&&getComputedStyle(backdrop).opacity==="1"&&getComputedStyle(modal).opacity==="1";
    });
    const completion=page.locator("#confirm-completion");
    assert.equal(await completion.isDisabled(),true,"completion stays unavailable before the human acknowledgement");
    await page.screenshot({path:"screenshots/history-acceptance-e2e.png"});
    await page.locator("#ack-completion").check();
    assert.equal(await completion.isDisabled(),false,"acknowledgement enables the visible completion action");
    await completion.click();
    await wait("浏览器显式人类确认完成",async()=>{const w=await api(`/api/runs/${runId}/workspace?view=summary`);return w.run?.status==="completed";});
    await page.locator(".workspace-summary .status-pill.completed").waitFor();
  }
  assert.equal((await api(`/api/runs/${runId}/workspace?view=summary`)).run.status,"completed");
  await page.reload();await sleep(1500);await page.screenshot({path:"screenshots/history-task-e2e.png"});
  if(!task.archivedAt)await api(`/api/tasks/${task.id}/archive`,{});
  await page.goto(`http://127.0.0.1:4310/communication/${privateChat.id}`);
  await page.locator("#communication-input").fill(`请核验刚刚归档的任务 ${task.id} / Run ${runId}。必须用 search_task_activity 查询 evidence.md，read_artifact 读取该交付快照，再 read_trace 读取你在此 Run 中的个人执行事件。回复必须包含“归档后核验通过”、实际暗号与证据文件内容摘要。不要读取本机数据库。`);
  await page.locator("#communication-input").press("Enter");
  await wait("归档任务到私聊的真实跨场景查询",async()=>{const c=await api(`/api/communications/${privateChat.id}`);return c.messages.find(m=>m.sender.type==="agent"&&m.content.includes("归档后核验通过")&&m.content.includes(secret));});
  await page.screenshot({path:"screenshots/history-archived-e2e.png"});
  const communication=await api(`/api/communications/${privateChat.id}`);
  const delivery=communication.deliveries.find(d=>d.messageId===privateReply.replyToMessageId);
  const events=await api(`/api/communications/${privateChat.id}/deliveries/${delivery.id}/events`);
  assert.ok(JSON.stringify(events).includes("search_private_chat"),"real chat MCP invocation recorded");
  assert.deepEqual(errors,[]);
  await writeFile(join(root,"evidence.json"),JSON.stringify({taskId:task.id,runId,privateChatId:privateChat.id,groupChatId:group.id,privateReplyId:privateReply.id,artifactIds:workspace.artifacts.map(a=>a.id),result:"PASS",browserErrors:errors},null,2));
  console.log(JSON.stringify(await verifyHistoryEvidence(root)));
  console.log("PASS real Claude + Chrome + HTTP + task completion; evidence: "+root);
}finally{if(browser)await browser.close();stopBackend();}
