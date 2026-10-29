// Independent assertions over real persisted E2E facts, not model claims or init tool lists.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRunFiles } from "../server/run-files.mjs";

export async function verifyHistoryEvidence(directory) {
  const root=resolve(directory);
  assert.equal(dirname(root),resolve(".data"));assert.match(basename(root),/^history-e2e-[a-zA-Z0-9]+$/);
  const evidence=JSON.parse(await readFile(join(root,"evidence.json"),"utf8"));
  const db=new DatabaseSync(join(root,"state.sqlite"),{readOnly:true});
  let state,events,chatEvents;
  try{
    state=JSON.parse(db.prepare("SELECT state_json FROM workspace_snapshots").get().state_json);
    const read=name=>db.prepare("SELECT value_json FROM workspace_event_rows WHERE collection=? ORDER BY position").all(name).map(r=>JSON.parse(r.value_json));
    events=read("events");chatEvents=read("communicationEvents");
  }finally{db.close();}
  const run=state.runs.find(r=>r.id===evidence.runId),task=state.tasks.find(t=>t.id===evidence.taskId);
  assert.equal(run.status,"completed");assert.equal(run.confirmedBy,"human_operator");assert.ok(task.archivedAt);
  const calls=(rows,tool)=>rows.filter(e=>e.data?.toolUseId&&e.data?.toolName===`mcp__agentforge_history__${tool}`);
  const paired=(rows,tool)=>calls(rows,tool).some(call=>rows.some(result=>result.data?.toolResultId===call.data.toolUseId));
  const lookup=state.traces.find(t=>t.runId===run.id&&t.type==="node"&&t.workflowNodeId==="lookup"&&t.status==="completed");
  const verify=state.traces.find(t=>t.runId===run.id&&t.type==="node"&&t.workflowNodeId==="verify"&&t.status==="completed");
  assert.ok(lookup&&verify);
  for(const tool of ["search_private_chat","search_group_chat","read_context"])assert.ok(paired(events.filter(e=>e.data?.traceId===lookup.id),tool),`lookup native ${tool} call/result`);
  assert.ok(paired(events.filter(e=>e.data?.traceId===verify.id),"search_task_activity"),"verify native task lookup");
  assert.ok(paired(events.filter(e=>e.actor?.id===run.manager.id),"search_private_chat"),"manager uses stable employee history");
  for(const tool of ["search_private_chat","search_group_chat","read_context","search_task_activity","read_artifact","read_trace"])assert.ok(paired(chatEvents,tool),`communication native ${tool} call/result`);
  const secret=state.communicationMessages.find(m=>m.content.startsWith("历史验收暗号："))?.content.split("：")[1];
  const group=state.communicationMessages.find(m=>m.content.startsWith("团队历史代号："))?.content.split("：")[1];
  const files=createRunFiles({root:join(root,"runs")}),artifact=state.artifacts.find(a=>a.runId===run.id&&a.name==="docs/lookup/evidence.md");
  assert.ok(artifact);
  assert.ok(paired(chatEvents,"read_artifact"),"chat invoked and received Artifact history evidence");
  assert.ok(paired(chatEvents,"read_trace"),"chat invoked and received Trace history evidence");
  assert.doesNotMatch(JSON.stringify(chatEvents),/toolInput|toolOutput/,"communication audit retains tool identity/status, not tool arguments or output");
  const bytes=await files.readArtifactBytes(artifact.storagePath),content=bytes.toString("utf8");
  assert.ok(secret&&group&&content.includes(secret)&&content.includes(group),"actual Artifact contains retrieved facts");
  assert.equal(createHash("sha256").update(bytes).digest("hex"),artifact.sha256);
  const traceSessions=run.memberSessions;
  const privateSession=state.communicationConversations.find(c=>c.id===evidence.privateChatId).sessions.agent_analyst;
  const groupSession=state.communicationConversations.find(c=>c.id===evidence.groupChatId).sessions.agent_analyst;
  assert.notEqual(privateSession.sessionId,groupSession.sessionId);
  assert.notEqual(privateSession.sessionId,traceSessions.agent_analyst.sessionId);
  assert.equal(new Set(state.communicationConversations.filter(c=>c.kind==="agent"&&c.targetId==="agent_analyst").map(c=>c.id)).size,1);
  return {runId:run.id,status:run.status,archived:true,artifactSha256:artifact.sha256,nativeTaskCalls:events.filter(e=>e.data?.toolUseId&&e.data?.toolName?.startsWith("mcp__agentforge_history__")).length,nativeChatCalls:chatEvents.filter(e=>e.data?.toolUseId&&e.data?.toolName?.startsWith("mcp__agentforge_history__")).length,sessionIsolation:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await verifyHistoryEvidence(process.argv[2]),null,2));
