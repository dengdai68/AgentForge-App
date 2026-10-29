import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCodexAppServer,nativeItem} from '../server/runtime/codex-app-server.mjs';
import {hasActiveExecution,terminateExecution} from '../server/runtime/registry.mjs';

async function fixture(t,mode='success') {
  const root=await mkdtemp(join(tmpdir(),'af-native-unit-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const executable=join(root,'codex.mjs'),capture=join(root,'requests.jsonl');
  await writeFile(executable,`#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
const mode=${JSON.stringify(mode)},id='0199a213-81c0-7800-8aa1-bbab2a035a53';
const send=v=>console.log(JSON.stringify(v));
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);appendFileSync(${JSON.stringify(capture)},line+'\\n');if(r.id===undefined)return;
 const reply=result=>send({id:r.id,result});
 if(r.method==='initialize'||r.method==='skills/extraRoots/set')return reply({});
 if(r.method==='skills/list')return reply({data:[{skills:mode==='missing'?[]:[{name:'selected',path:${JSON.stringify(join(root,'SKILL.md'))}},{name:'ambient',path:'/ambient/SKILL.md'}],errors:[]}]});
 if(r.method==='thread/resume'&&mode==='missing-session')return send({id:r.id,error:{code:-1,message:'no rollout found for thread id'}});
 if(r.method.startsWith('thread/'))return reply({thread:{id:mode==='mismatch'?'0199a213-81c0-7800-8aa1-bbab2a035a54':id}});
 if(r.method==='turn/start'){
  reply({turn:{id:'turn-1'}});
  if(mode==='hang')return;
  if(mode==='retry'){send({method:'error',params:{willRetry:true,error:{message:'retry'}}});return;}
  if(mode==='request'){send({id:900,method:'item/tool/requestUserInput',params:{}});return;}
  const params={threadId:id,turnId:'turn-1',item:{id:'message-1',type:'agentMessage',text:'{"ok":true}'}};
  send({method:'item/completed',params});send({method:'turn/completed',params:{threadId:id,turn:{id:'turn-1',status:mode==='failure'?'failed':'completed',error:mode==='failure'?{message:'original failure'}:null}}});
 }
});`,{mode:0o700});
  const input={runtime:{executable,skillPaths:[join(root,'SKILL.md')]},workspacePath:root,traceDirectory:root,finalPath:join(root,'final.json'),runId:root,systemPrompt:'PERSONA_ONLY',prompt:'USER_ONLY',idleTimeoutMs:10000,onEvent:async()=>{}};
  const options={args:['app-server'],normalizeEvent:e=>e,cancelledError:m=>Object.assign(new Error(m),{name:'RuntimeCancelledError'}),missingSessionError:m=>Object.assign(new Error(m),{name:'RuntimeSessionMissingError'})};
  return {root,input,options,capture,invoke:(patch={})=>runCodexAppServer({...input,...patch},options)};
}

test('native selected skills use extra roots and per-thread enablement, never prompt path injection',async t=>{
  const f=await fixture(t),result=await f.invoke({outputSchema:{type:'object'}});
  assert.equal(JSON.parse(result.finalText).ok,true);
  const requests=(await readFile(f.capture,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.find(r=>r.method==='skills/extraRoots/set').params.extraRoots,[f.root]);
  const thread=requests.find(r=>r.method==='thread/start');
  assert.deepEqual(thread.params.config['skills.config'],[{path:join(f.root,'SKILL.md'),enabled:true},{path:'/ambient/SKILL.md',enabled:false}]);
  assert.equal(thread.params.developerInstructions,'PERSONA_ONLY');
  const turn=requests.find(r=>r.method==='turn/start');assert.deepEqual(turn.params.input,[{type:'text',text:'USER_ONLY'}]);
  assert.deepEqual(turn.params.outputSchema,{type:'object'});assert.equal(hasActiveExecution(f.input.runId),false);
});

test('native resume preserves exact provider thread identity',async t=>{
  const f=await fixture(t);await f.invoke({session:{resume:true,sessionId:'0199a213-81c0-7800-8aa1-bbab2a035a53'}});
  const requests=(await readFile(f.capture,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(requests.some(r=>r.method==='thread/resume'&&r.params.excludeTurns));
  assert.ok(!requests.some(r=>r.method==='thread/start'));
});

test('employees sharing a cwd have independent native roots and enablement',async t=>{
  const a=await fixture(t),b=await fixture(t);
  await Promise.all([a.invoke(),b.invoke({workspacePath:a.root})]);
  for(const f of [a,b]){
    const requests=(await readFile(f.capture,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(requests.find(r=>r.method==='skills/extraRoots/set').params.extraRoots,[f.root]);
    const enabled=requests.find(r=>r.method==='thread/start').params.config['skills.config'].filter(row=>row.enabled);
    assert.deepEqual(enabled,[{path:join(f.root,'SKILL.md'),enabled:true}]);
  }
});

test('selected Hook trust is explicitly passed to the native thread, not assumed from root flags',async t=>{
  const f=await fixture(t);
  await runCodexAppServer(f.input,{...f.options,args:['--dangerously-bypass-hook-trust','app-server']});
  const requests=(await readFile(f.capture,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.find(r=>r.method==='thread/start').params.config.bypass_hook_trust,true);
});

for(const [mode,pattern] of [['missing',/未被 Codex 原生发现/],['mismatch',/会话 ID/],['failure',/original failure/],['missing-session',/未找到指定会话/],['request',/需要交互式处理/],['retry',/连续重试/]]) {
  test(`native ${mode} fails honestly and releases its execution slot`,async t=>{
    const f=await fixture(t,mode);
    await assert.rejects(f.invoke({apiRetryTimeoutMs:50,...(['mismatch','missing-session'].includes(mode)?{session:{resume:true,sessionId:'0199a213-81c0-7800-8aa1-bbab2a035a53'}}:{})}),pattern);
    assert.equal(hasActiveExecution(f.input.runId),false);
  });
}

test('native cancellation and idle timeout stop the owned process and release its slot',async t=>{
  for(const cancel of [false,true]){
    const f=await fixture(t,'hang');const result=f.invoke({idleTimeoutMs:cancel?2000:70});
    if(cancel)setTimeout(()=>terminateExecution(f.input.runId,'stop probe'),100);
    await assert.rejects(result,cancel?/stop probe/:/超过等待时间/);assert.equal(hasActiveExecution(f.input.runId),false);
  }
});

test('native items preserve public command/file/MCP bodies and distinct call IDs',()=>{
  const a=nativeItem({id:'a',type:'commandExecution',command:'node test.mjs',aggregatedOutput:'done',exitCode:0});
  assert.equal(a.type,'command_execution');assert.equal(a.aggregated_output,'done');assert.equal(a.exit_code,0);
  const b=nativeItem({id:'b',type:'mcpToolCall',server:'history',tool:'list_sessions',arguments:{},result:{items:[]}});
  assert.equal(b.tool,'mcp__history__list_sessions');assert.equal(b.id,'b');
  assert.equal(nativeItem({type:'reasoning',summary:['public'],content:['summary']}).text,'public\nsummary');
  assert.equal(nativeItem({type:'unknown'}),null);
});
