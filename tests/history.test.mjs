import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFixtureStore as createStore } from "./fixture-store.mjs";
import { historyCommands, communicationVisibility, historyTools } from "../server/history/index.mjs";
import { withHistoryTools, queryHistory } from "../server/history/bridge.mjs";
import { runClaudeCodeCli, runCodexCli, redactExternalText } from "../server/runtime/local-cli.mjs";

// A clean checkout has no ignored runtime directory; test fixtures own their setup.
await mkdir(new URL("../.data/", import.meta.url), { recursive: true });

const employee="agent_analyst", peer="agent_designer";
const send=(s,c,content,mentionAgentIds=[]) => s.sendCommunication(c,{content,mentionAgentIds,clientRequestId:randomUUID()});
const query=(s,tool,args={},id=employee) => s.historyQuery(id,tool,args);
const privateChat=s => s.openCommunication({kind:"agent",targetId:employee});
const groupChat=s => s.openCommunication({kind:"team",targetId:"team_product_delivery"});

test("history pages load bounded JSON while session enumeration loads summaries only", (t)=>{
  const state=createStore().snapshot();
  state.communicationConversations=[{id:"large",kind:"agent",targetId:employee,name:"large history"}];
  state.communicationMessages=Array.from({length:250},(_,i)=>({id:`bounded-${i}`,conversationId:"large",content:"正文".repeat(2000)+i,createdAt:"2026-10-01T00:00:00Z"}));
  const h=historyCommands(state);
  h.historyQuery(employee,"list_sessions");
  const reads=[],prepare=DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype,"prepare",function(sql){
    const statement=prepare.call(this,sql),all=statement.all.bind(statement);
    statement.all=(...args)=>{const rows=all(...args); reads.push({sql,rows});return rows;};
    return statement;
  });
  const first=h.historyQuery(employee,"read_conversation",{conversationId:"large",limit:3});
  assert.deepEqual(first.items.map(r=>r.recordId),["bounded-0","bounded-1","bounded-2"]);
  assert.equal(first.hasMore,true);
  const payloadReads=reads.filter(r=>r.rows.some(row=>Object.hasOwn(row,"json")));
  assert.equal(payloadReads.length,1);
  assert.equal(payloadReads[0].rows.length,4,"only one requested page plus lookahead crosses the SQLite boundary");
  assert.ok(reads.some(r=>r.sql.includes("fingerprint") && !r.rows.some(row=>Object.hasOwn(row,"json"))));
  reads.length=0;
  assert.equal(h.historyQuery(employee,"list_sessions",{limit:1}).items[0].conversationId,"large");
  assert.ok(reads.every(r=>r.rows.every(row=>!Object.hasOwn(row,"json")&&!Object.hasOwn(row,"body"))));
  const second=h.historyQuery(employee,"read_conversation",{conversationId:"large",limit:3,cursor:first.nextCursor});
  assert.deepEqual(second.items.map(r=>r.recordId),["bounded-3","bounded-4","bounded-5"]);
});

test("compact history metadata migrates old indexes and rolls back visibility/content changes atomically",async()=>{
  const root=await mkdtemp(new URL("../.data/history-compact-test-",import.meta.url));
  const path=join(root,"state.sqlite"),state=createStore().snapshot();
  state.communicationConversations=[{id:"compact",kind:"team",targetId:"team_product_delivery",name:"before"}];
  state.communicationMessages=[{id:"compact-message",conversationId:"compact",content:"原内容",visibleToAgentIds:[employee],createdAt:"2026-10-01T00:00:00Z"},{id:"changed-legacy",conversationId:"compact",content:"旧内容",visibleToAgentIds:[employee],createdAt:"2026-10-01T00:00:00Z"}];
  let inspection;
  try{
    const original=historyCommands(state,{databasePath:path});
    original.historyQuery(employee,"read_context",{recordId:"compact-message"});
    inspection=new DatabaseSync(path+".history.sqlite");
    const before=inspection.prepare("SELECT id FROM records WHERE key=?").get("compact-message").id;
    inspection.exec("DROP TABLE record_index");
    inspection.exec("CREATE TRIGGER reject_legacy_rewrite BEFORE UPDATE ON records WHEN OLD.key='compact-message' BEGIN SELECT RAISE(ABORT,'unchanged legacy body rewritten'); END");
    state.communicationMessages[1].content="迁移前已变更";
    state.communicationMessages[1].visibleToAgentIds=[peer];
    const h=historyCommands(state,{databasePath:path});
    assert.equal(h.historyQuery(employee,"read_context",{recordId:"compact-message"}).content,"原内容");
    assert.equal(inspection.prepare("SELECT id FROM records WHERE key=?").get("compact-message").id,before);
    assert.equal(h.historyQuery(peer,"read_context",{recordId:"changed-legacy"}).content,"迁移前已变更");
    assert.equal(h.historyQuery(employee,"read_context",{recordId:"changed-legacy"}).content,"迁移前已变更");
    const plan=inspection.prepare("EXPLAIN QUERY PLAN SELECT r.id,r.key,i.fingerprint FROM records r LEFT JOIN record_index i INDEXED BY history_fingerprint_cover ON i.id=r.id").all();
    assert.ok(plan.some(row=>row.detail.includes("COVERING INDEX history_fingerprint_cover")),"fingerprint reconciliation does not fetch the wider metadata table for every row");
    inspection.exec("DROP TRIGGER reject_legacy_rewrite");
    inspection.exec("CREATE TRIGGER reject_compact BEFORE UPDATE ON record_index BEGIN SELECT RAISE(ABORT,'compact rollback'); END");
    state.communicationMessages[0].content="更新内容";
    state.communicationMessages[0].visibleToAgentIds=[peer];
    state.communicationConversations[0].name="after";
    assert.throws(()=>h.historyQuery(peer,"read_context",{recordId:"compact-message"}),/compact rollback/);
    assert.equal(inspection.prepare("SELECT body FROM records WHERE key=?").get("compact-message").body,"原内容");
    assert.equal(inspection.prepare("SELECT count(*) AS n FROM visibility WHERE record=?").get(before).n,state.agents.length);
    inspection.exec("DROP TRIGGER reject_compact");
    assert.equal(h.historyQuery(peer,"read_context",{recordId:"compact-message"}).content,"更新内容");
    assert.equal(h.historyQuery(employee,"read_context",{recordId:"compact-message"}).content,"更新内容");
    assert.equal(h.historyQuery(peer,"list_sessions").items[0].title,"after");
    state.communicationMessages=[];
    assert.equal(h.historyQuery(peer,"list_sessions").items.length,0);
    assert.equal(inspection.prepare("SELECT count(*) AS n FROM record_index WHERE id=?").get(before).n,0);
  }finally{inspection?.close();await rm(root,{recursive:true,force:true});}
});

test("database paging applies task/date filters before limiting and keeps session high water",()=>{
  const state=createStore().snapshot();
  state.communicationConversations=Array.from({length:7},(_,i)=>({id:`session-${i}`,kind:"agent",targetId:employee,name:`session ${i}`}));
  state.communicationMessages=state.communicationConversations.flatMap((c,i)=>Array.from({length:4},(_,j)=>({id:`session-message-${i}-${j}`,conversationId:c.id,content:"分页检索",createdAt:i<5?"2026-09-01T00:00:00Z":"2026-10-01T00:00:00Z"})));
  const h=historyCommands(state);
  const args={query:"检索",after:"2026-10-01",before:"2026-10-02",limit:2};
  let page=h.historyQuery(employee,"search_private_chat",args),seen=page.items.map(r=>r.recordId);
  while(page.hasMore){page=h.historyQuery(employee,"search_private_chat",{...args,cursor:page.nextCursor});seen.push(...page.items.map(r=>r.recordId));}
  assert.deepEqual(seen,state.communicationMessages.slice(20).map(m=>m.id));
  assert.throws(()=>h.historyQuery(employee,"search_private_chat",{...args,taskId:"not-a-task"}),/参数/);
  for(const id of ["older","target"]){
    state.tasks.push({id:`task-${id}`,title:id});
    state.runs.push({id:`run-${id}`,taskId:`task-${id}`,participants:[{id:employee,type:"agent"}],startedAt:"2026-10-01T00:00:00Z"});
    state.messages.push(...Array.from({length:7},(_,i)=>({id:`${id}-${i}`,runId:`run-${id}`,recipient:{type:"team"},content:"检索",createdAt:"2026-10-01T00:00:00Z"})));
  }
  const scoped=h.historyQuery(employee,"search_task_activity",{query:"检索",taskId:"task-target",runId:"run-target",limit:2});
  assert.deepEqual(scoped.items.map(r=>r.recordId),["target-0","target-1"]);
  assert.equal(scoped.hasMore,true);
  page=h.historyQuery(employee,"list_sessions",{limit:2});seen=page.items.map(r=>r.conversationId);
  state.communicationConversations.push({id:"later",kind:"agent",targetId:employee});
  state.communicationMessages.push({id:"later-message",conversationId:"later",content:"later"});
  while(page.hasMore){page=h.historyQuery(employee,"list_sessions",{limit:2,cursor:page.nextCursor});seen.push(...page.items.map(r=>r.conversationId));}
  assert.deepEqual(seen,[...Array.from({length:7},(_,i)=>`session-${i}`),"run-older","run-target"]);
});

test("real task E2E retains visible human confirmation and actual history inquiries",async()=>{
 const source=await readFile(new URL("../scripts/test-prompt-e2e.mjs",import.meta.url),"utf8");
 assert.match(source,/data-open-completion-confirm/);assert.match(source,/#ack-completion/);
 assert.match(source,/confirm-completion.*isDisabled/);assert.match(source,/search_task_activity/);
 assert.doesNotMatch(source,/api\([^\n]*confirm-completion/);
});

test("keyword search is full-text, Chinese short/literal AND, scoped, and read-only",()=>{
  const s=createStore(), c=privateChat(s), other=s.openCommunication({kind:"agent",targetId:peer});
  const m=send(s,c.id,"需求 ABC 中文短词 测 100% _ ' OR 1=1 --"), before=JSON.stringify(s.snapshot());
  for (const keyword of ["需求","测","abc 需求","100%","_","' OR 1=1 --"]) assert.equal(query(s,"search_private_chat",{query:keyword}).items[0].recordId,m.id);
  assert.equal(query(s,"search_private_chat",{query:"不存在"}).items.length,0);
  assert.equal(query(s,"search_private_chat",{query:"需求",conversationId:other.id}).items.length,0);
  assert.equal(query(s,"search_private_chat",{query:"需求"},peer).items[0].recordId,m.id);
  assert.equal(query(s,"read_conversation",{conversationId:c.id},peer).items[0].recordId,m.id);
  assert.equal(query(s,"read_context",{recordId:m.id},peer).content,m.content);
  assert.equal(JSON.stringify(s.snapshot()),before);
  const record=query(s,"read_context",{recordId:m.id});
  assert.equal(record.conversationId,c.id);assert.equal("sessionId" in record,false);
  assert.notEqual(redactExternalText(JSON.stringify(record)),"[REDACTED]");
});

test("all conversation history traverses stable pages, new records don't enter old cursor; long bodies are recoverable",()=>{
  const s=createStore(),c=privateChat(s), ids=[];
  for(let i=0;i<125;i++) ids.push(send(s,c.id,`历史消息 ${i}`).id);
  let page=query(s,"read_conversation",{conversationId:c.id,limit:17}), found=page.items.map(r=>r.recordId);
  const cursor=page.nextCursor;
  const tampered=JSON.parse(Buffer.from(cursor,"base64url").toString());tampered.high++;
  assert.throws(()=>query(s,"read_conversation",{conversationId:c.id,limit:17,cursor:Buffer.from(JSON.stringify(tampered)).toString("base64url")}),/游标/);
  send(s,c.id,"后插入");
  while(page.hasMore){page=query(s,"read_conversation",{conversationId:c.id,limit:17,cursor:page.nextCursor});found.push(...page.items.map(r=>r.recordId));}
  assert.deepEqual(found,ids);
  assert.throws(()=>query(s,"read_conversation",{conversationId:c.id,limit:17,cursor},peer),/游标/);
  assert.throws(()=>query(s,"search_private_chat",{limit:17,cursor}),/游标/);
  const text="全文".repeat(15000)+"末尾关键词", m=send(s,c.id,text);
  assert.equal(query(s,"search_private_chat",{query:"末尾关键词"}).items[0].recordId,m.id);
  let offset=0,reconstructed="";
  do{const chunk=query(s,"read_context",{recordId:m.id,offset,length:1333});reconstructed+=chunk.content;offset=chunk.nextOffset;}while(offset!==null);
  assert.equal(reconstructed,text);
  for(const args of [{agentId:peer},{limit:101},{limit:0},{after:"bad"},{query:"x".repeat(201)},{cursor:"bad"}]) assert.throws(()=>query(s,"search_private_chat",args));
});

test("group visibility is frozen independently from mentions, new membership does not disclose old messages",()=>{
  const s=createStore(),c=groupChat(s), team=s.listTeams().find(t=>t.id===c.targetId);
  const m=send(s,c.id,"定向但全群可见",[employee]);
  assert.equal(query(s,"search_group_chat",{query:"全群"},peer).items[0].recordId,m.id);
  s.updateTeam(team.id,{memberAgentIds:team.memberAgentIds.filter(id=>id!==peer)});
  const hidden=send(s,c.id,"离开后的保密内容",[employee]);
  assert.equal(query(s,"search_group_chat",{query:"保密"},peer).items[0].recordId,hidden.id);
  assert.equal(query(s,"read_context",{recordId:m.id},peer).content,m.content);
  s.updateTeam(team.id,{memberAgentIds:team.memberAgentIds});
  send(s,c.id,"重新加入后提问",[peer]);
  let delivery;
  while((delivery=s.claimCommunication(c.id))) {
    if(delivery.agentId===peer) assert.ok(!s.communicationContext(c.id,delivery.id).messages.some(r=>r.id===hidden.id));
    s.completeCommunication(c.id,delivery.id,"答复");
  }
  assert.equal(query(s,"search_group_chat",{query:"保密"},peer).items[0].recordId,hidden.id);
});

test("legacy group history is conservative and explicitly partial",()=>{
  const s=createStore(),c=groupChat(s),m=send(s,c.id,"旧群记录",[employee]);
  const state=s.snapshot(); delete state.communicationMessages[0].visibleToAgentIds;
  const projection=historyCommands(state);
  assert.deepEqual(communicationVisibility(state,state.communicationConversations[0],state.communicationMessages[0]),[employee]);
  assert.equal(projection.historyQuery(employee,"search_group_chat",{}).items[0].coverage,"legacy_partial");
  assert.equal(projection.historyQuery(peer,"search_group_chat",{}).items[0].recordId,m.id);
  assert.equal(projection.historyQuery(peer,"read_context",{recordId:m.id}).content,m.content);
});

test("response budget reduces page size without losing long messages or Trace events",()=>{
  const s=createStore(),c=privateChat(s),ids=[];
  for(let i=0;i<7;i++)ids.push(send(s,c.id,"长文本".repeat(4000)+i).id);
  let cursor,seen=[];
  do{
    const page=query(s,"read_conversation",{conversationId:c.id,limit:100,...(cursor?{cursor}:{})});
    assert.ok(JSON.stringify(page.items).length<25000);
    seen.push(...page.items.map(m=>m.recordId));cursor=page.nextCursor;
  }while(cursor);
  assert.deepEqual(seen,ids);
  const run=s.createRun(s.listTasks()[0].id),trace=s.createTrace(run.id,{workflowNodeId:"requirements",agentId:employee}),eventIds=[];
  for(let i=0;i<7;i++)eventIds.push(s.addEvent({type:"runtime.event",runId:run.id,actor:{id:employee},message:"执行原文".repeat(3000),data:{traceId:trace.id}}).id);
  cursor=null;seen=[];
  do{
    const page=query(s,"read_trace",{traceId:trace.id,limit:100,...(cursor?{cursor}:{})});seen.push(...page.items.map(m=>m.recordId));cursor=page.nextCursor;
  }while(cursor);
  assert.deepEqual(seen,eventIds);
});

test("task membership, stable manager mapping, own traces, shared artifacts, deletion reconciliation",async()=>{
  const s=createStore(),run=s.createRun(s.listTasks()[0].id), node="requirements";
  const own=s.createTrace(run.id,{workflowNodeId:node,agentId:employee});
  const manager=s.createTrace(run.id,{workflowNodeId:node,agentId:run.manager.id});
  const event=s.addEvent({type:"trace.output",runId:run.id,actor:{id:employee},message:"工具结果".repeat(5000),data:{traceId:own.id}});
  s.addMessage({runId:run.id,content:"团队共享依据"});
  const personal=s.addMessage({runId:run.id,sender:{type:"agent",id:employee},recipientHuman:true,content:"个人澄清"});
  assert.ok(query(s,"search_task_activity",{query:"共享依据"},peer).items.length);
  assert.equal(query(s,"search_task_activity",{query:"个人澄清"},peer).items[0].recordId,personal.id);
  assert.equal(query(s,"read_context",{recordId:personal.id},peer).content,"个人澄清");
  assert.equal(query(s,"read_trace",{traceId:own.id}).items[0].recordId,event.id);
  assert.equal(query(s,"search_task_activity",{query:"工具结果"}).items[0].recordId,event.id);
  assert.equal(query(s,"search_task_activity",{query:"工具结果"},peer).items[0].recordId,event.id);
  assert.ok(query(s,"read_context",{recordId:event.id}).hasMore);
  assert.equal(query(s,"read_trace",{traceId:own.id},peer).items[0].recordId,event.id);
  assert.equal(query(s,"read_trace",{traceId:manager.id},run.manager.sourceAgentId).items.length,0);
  const state=s.snapshot(), artifactContent="abcdef";state.artifacts.push({id:"a",runId:run.id,name:"docs/a.md",storagePath:"safe",sha256:createHash("sha256").update(artifactContent).digest("hex"),bytes:Buffer.byteLength(artifactContent),createdAt:new Date().toISOString()});
  const projection=historyCommands(state);
  let options;
  assert.equal((await queryHistory(projection,peer,"read_artifact",{artifactId:"a",offset:2,length:3},{readArtifactBytes:async(path,input)=>{ assert.equal(path,"safe"); options=input; return Buffer.from(artifactContent); }})).content,"cde");
  assert.deepEqual(options,{expected:{storagePath:"safe",sha256:state.artifacts.at(-1).sha256,bytes:Buffer.byteLength(artifactContent)}});
  await assert.rejects(queryHistory(projection,peer,"read_artifact",{artifactId:"a"},{readArtifactBytes:async()=>{throw new Error("private path");}}),/交付文件/);
  state.runs=[]; state.tasks=[];
  assert.throws(()=>projection.historyQuery(employee,"read_context",{recordId:own.id}),/不可访问/);
});

test("index rebuild/restart and renaming keep stable ownership",async()=>{
  const root=await mkdtemp(new URL("../.data/history-test-", import.meta.url));
  try{
    const databasePath=join(root,"state.sqlite"),s=createStore({databasePath}),c=privateChat(s),m=send(s,c.id,"重启留存");
    query(s,"search_private_chat",{});
    s.updateAgent(employee,{name:"新名字",runtime:{provider:"claude-code",model:"changed"}});
    const reopened=createStore({databasePath});
    assert.equal(query(reopened,"read_context",{recordId:m.id}).content,m.content);
    assert.throws(()=>query(reopened,"read_context",{recordId:m.id},"new-same-name"));
    for(const suffix of ["","-wal","-shm"])await rm(databasePath+".history.sqlite"+suffix,{force:true});
    const rebuilt=createStore({databasePath});
    assert.equal(query(rebuilt,"read_context",{recordId:m.id}).content,m.content);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("CLI history configuration preserves positional prompt and is available to both adapters",async()=>{
  const root=await mkdtemp(new URL("../.data/history-cli-test-", import.meta.url));
  try{
    const executable=join(root,"provider.mjs");
    await writeFile(executable,'#!/usr/bin/env node\nconst a=process.argv.slice(2);console.log(JSON.stringify({type:"result",structured_output:{argv:a}}));\n');await chmod(executable,0o755);
    const base={runtime:{executable},workspacePath:root,traceDirectory:root,outputSchema:{},prompt:"exact test prompt",runId:"history-cli",onEvent:async()=>{},historyMcp:{configPath:join(root,"config.json"),command:process.execPath,args:["adapter.mjs"],env:{AGENTFORGE_HISTORY_SOCKET:"private-socket",ELECTRON_RUN_AS_NODE:"1"}}};
    const response=await runClaudeCodeCli(base),args=JSON.parse(response.finalText).argv;
    assert.deepEqual(args.slice(-4),["--mcp-config",base.historyMcp.configPath,"--",base.prompt]);
    await writeFile(executable,'#!/usr/bin/env node\nif(process.argv.includes(\"features\")){console.log(\"skip_host_skill_discovery stable false\");process.exit(0);}if(process.argv.includes(\"mcp\")&&process.argv.includes(\"list\")){console.log(\"[]\");process.exit(0);}\nconst a=process.argv.slice(2);console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({argv:a})}}));\n');
    const codex=JSON.parse((await runCodexCli({...base,schemaPath:"schema.json",finalPath:join(root,"final.json")})).finalText).argv;
    assert.ok(codex.includes('mcp_servers.agentforge_history.command='+JSON.stringify(process.execPath)));
    assert.ok(codex.includes('mcp_servers.agentforge_history.env.AGENTFORGE_HISTORY_SOCKET="private-socket"'));
    assert.ok(codex.includes('mcp_servers.agentforge_history.env.ELECTRON_RUN_AS_NODE="1"'), 'packaged history MCP must run Electron as Node, without leaking this flag to the Codex process');
    assert.ok(codex.includes('mcp_servers.agentforge_history.required=true'), 'a missing platform history service must not silently become an unavailable capability');
    assert.equal(codex.at(-1),base.prompt);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("unready platform MCP fails the invocation rather than allowing an invisible tool capability",async()=>{
  const root=await mkdtemp(new URL("../.data/history-unready-test-", import.meta.url));
  try{
    const executable=join(root,"provider.mjs");
    await writeFile(executable,'#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"system",subtype:"init",mcp_servers:[{name:"agentforge_history",status:"failed"}],tools:[]}));setTimeout(()=>{},10000);');await chmod(executable,0o755);
    await assert.rejects(runClaudeCodeCli({runtime:{executable},workspacePath:root,traceDirectory:root,outputSchema:{},prompt:"test",runId:"unready-test",onEvent:async()=>{},historyMcp:{configPath:"test"}}),/未就绪/);
    await writeFile(executable,'#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"system",subtype:"init",mcp_servers:[{name:"agentforge_history",status:"connected"}],tools:["Bash"]}));setTimeout(()=>{},10000);');
    await assert.rejects(runClaudeCodeCli({runtime:{executable},workspacePath:root,traceDirectory:root,outputSchema:{},prompt:"test",runId:"unready-test",onEvent:async()=>{},historyMcp:{configPath:"test"}}),/未装载/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("filters, session enumeration, archived facts, missing records and binary files",async()=>{
  const s=createStore(),c=privateChat(s),g=groupChat(s);
  const m=send(s,c.id,"过滤日期"), gm=send(s,g.id,"群聊特有",[employee]);
  const sessions=query(s,"list_sessions",{}).items;
  assert.ok(sessions.some(x=>x.conversationId===c.id&&x.kind==="private"));
  assert.ok(sessions.some(x=>x.conversationId===g.id&&x.kind==="group"));
  assert.equal(query(s,"search_group_chat",{conversationId:g.id,query:"特有",after:"2000-01-01",before:"2100-01-01"}).items[0].recordId,gm.id);
  assert.equal(query(s,"search_private_chat",{after:"2100-01-01"}).items.length,0);
  assert.equal(query(s,"search_private_chat",{before:"2000-01-01"}).items.length,0);
  assert.equal(query(s,"read_context",{recordId:m.id,offset:100}).content,"");
  const r=s.createRun(s.listTasks()[0].id),snapshot=s.snapshot();snapshot.tasks.find(t=>t.id===r.taskId).archivedAt=new Date().toISOString();
  snapshot.artifacts.push({id:"binary",runId:r.id,name:"docs/image.png",storagePath:"fixture"});
  const h=historyCommands(snapshot);
  assert.equal(h.historyQuery(employee,"search_task_activity",{runId:r.id}).items[0].recordId,r.id);
  assert.equal(h.historyQuery(employee,"search_task_activity",{taskId:"foreign"}).items.length,0);
  await assert.rejects(queryHistory(h,employee,"read_artifact",{artifactId:"binary"},{readArtifactBytes:async()=>Buffer.from([0,1,2])}),/二进制/);
  assert.throws(()=>query(s,"read_trace",{traceId:m.id}),/不可访问/);
  assert.throws(()=>query(s,"read_artifact",{artifactId:m.id}),/不可访问/);
  assert.throws(()=>query(s,"toString",{}),/参数/);
  assert.throws(()=>query(s,"read_context",{recordId:m.id,length:16001}),/length 最多 16000/);
  assert.throws(()=>query(s,"search_private_chat",{limit:101}),/limit 最多 100/);
  assert.throws(()=>query(s,"read_context",{recordId:m.id,offset:-1}),/参数/);
});

test("real MCP SDK handshake/tool calls bind identity, paginate and clean up after errors",async()=>{
  const s=createStore(),c=privateChat(s),m=send(s,c.id,"MCP真实协议中文"),agent=s.listAgents().find(a=>a.id===employee);
  let path;
  await withHistoryTools(s,agent,{runtime:{},prompt:"test"},async input=>{
    path=input.historyMcp.configPath;
    assert.equal((await stat(path)).mode & 0o777,0o600);
    const config=JSON.parse(await readFile(path,"utf8"));
    assert.equal(config.mcpServers.agentforge_history.alwaysLoad,true);
    assert.deepEqual(Object.keys(config.mcpServers.agentforge_history.env),["AGENTFORGE_HISTORY_SOCKET"]);
    const socket=config.mcpServers.agentforge_history.env.AGENTFORGE_HISTORY_SOCKET;
    assert.ok(socket.startsWith(tmpdir()) || socket.startsWith("/tmp/"));
    assert.ok(Buffer.byteLength(socket)<100,"the invocation socket must remain below the macOS pathname limit");
    const transport=new StdioClientTransport({command:input.historyMcp.command,args:input.historyMcp.args,env:input.historyMcp.env,stderr:"pipe"});
    const client=new Client({name:"history-test",version:"1"});
    try{
      await client.connect(transport);
      const tools=(await client.listTools()).tools;
      assert.equal(tools.length,8);
      const artifactTool=tools.find(tool=>tool.name==="read_artifact");
      const searchTool=tools.find(tool=>tool.name==="search_private_chat");
      assert.equal(artifactTool.inputSchema.properties.length.maximum,16000);
      assert.match(artifactTool.inputSchema.properties.length.description,/nextOffset/);
      assert.equal(searchTool.inputSchema.properties.limit.maximum,100);
      const output=await client.callTool({name:"search_private_chat",arguments:{query:"真实协议"}});
      assert.equal(JSON.parse(output.content[0].text).items[0].recordId,m.id);
      const denied=await client.callTool({name:"search_private_chat",arguments:{agentId:peer}});
      assert.equal(denied.isError,true);
    }finally{await client.close();}
  });
  await assert.rejects(stat(path),/ENOENT/);
  await assert.rejects(withHistoryTools(s,agent,{runtime:{},prompt:"test"},async input=>{path=input.historyMcp.configPath;throw new Error("provider failed");}),/provider failed/);
  await assert.rejects(stat(path),/ENOENT/);
});

test("reserved server name cannot be overridden and concurrent MCP invocations don't mix employee identity",async()=>{
  const root=await mkdtemp(new URL("../.data/history-reserved-test-", import.meta.url));
  const s=createStore(),a=s.listAgents().find(a=>a.id===employee),b=s.listAgents().find(a=>a.id===peer);
  try{
    const reserved=join(root,"reserved.json");await writeFile(reserved,JSON.stringify({mcpServers:{agentforge_history:{command:"bad"}}}));
    await assert.rejects(withHistoryTools(s,a,{runtime:{mcpConfigPaths:[reserved]},prompt:"test"},async()=>assert.fail("must not invoke")),/保留/);
    send(s,privateChat(s).id,"员工甲独有");send(s,s.openCommunication({kind:"agent",targetId:peer}).id,"员工乙独有");
    await Promise.all([a,b].map(agent=>withHistoryTools(s,agent,{runtime:{},prompt:"test"},async input=>{
      const client=new Client({name:"parallel-test",version:"1"});
      try{
        await client.connect(new StdioClientTransport({command:input.historyMcp.command,args:input.historyMcp.args,env:input.historyMcp.env,stderr:"pipe"}));
        const result=await client.callTool({name:"search_private_chat",arguments:{query:"独有"}});
        const records=JSON.parse(result.content[0].text).items;
        assert.deepEqual(records.map((record)=>record.content).sort(),["员工甲独有","员工乙独有"].sort());
      }finally{await client.close();}
    })));
  }finally{await rm(root,{recursive:true,force:true});}
});
