// Native Skill transport for selected Codex capabilities. Store still owns
// sessions; this invocation-local stdio process never writes domain state.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { registerExecution, hasActiveExecution } from './registry.mjs';
import { cliEnvironment } from './cli-environment.mjs';
import { diagnostic } from '../diagnostics.mjs';

export function nativeItem(item) {
  const type = ({agentMessage:'agent_message',reasoning:'reasoning',commandExecution:'command_execution',mcpToolCall:'mcp_tool_call',fileChange:'file_change',webSearch:'web_search'})[item.type];
  if (!type) return null;
  return { ...item, type, text: type === 'reasoning' ? [...(item.summary || []), ...(item.content || [])].join('\n') : item.text,
    tool: item.type === 'mcpToolCall' ? `mcp__${item.server}__${item.tool}` : item.tool,
    aggregated_output: item.aggregatedOutput, exit_code: item.exitCode };
}

export async function runCodexAppServer(input, { args, normalizeEvent, cancelledError, missingSessionError }) {
  const {runtime, workspacePath, traceDirectory, onEvent, session} = input;
  const key = input.executionKey || input.runId;
  if (input.canStart && !input.canStart()) throw cancelledError('执行在启动前已暂停或终止');
  if (hasActiveExecution(key)) throw new Error('该执行会话已有本地 Agent 进程在执行');
  const command = runtime.executable || 'codex';
  const child = spawn(command, args, {cwd:workspacePath, env:cliEnvironment(command,{AGENTFORGE_TRACE_OUTPUT_DIR:`${traceDirectory}/output`}), stdio:['pipe','pipe','pipe'], detached:process.platform !== 'win32'});
  const pending = new Map(); let serial=0, closed=false, cancelled=null, finalText='', threadId=null, turnId=null, failure=null;
  let killTimer;
  const signal = name => {try {process.platform==='win32'?child.kill(name):process.kill(-child.pid,name);}catch{}};
  const stop = () => {if(closed)return;signal('SIGTERM');if(!killTimer){killTimer=setTimeout(()=>{if(!closed)signal('SIGKILL')},3000);killTimer.unref();}};
  const unregister = registerExecution(key,{terminate(reason){cancelled=cancelledError(reason);abort(cancelled);}});
  let complete, rejectComplete;
  const completion = new Promise((resolve,reject)=>{complete=resolve;rejectComplete=reject}); completion.catch(()=>{});
  let idle, retryTimer;
  const abort = error => { failure ||= error; for(const p of pending.values())p.reject(failure);pending.clear();rejectComplete(failure);stop(); };
  const touch = () => {clearTimeout(idle);idle=setTimeout(()=>abort(new Error('Codex 原生调用超过等待时间，详见运行日志')),input.idleTimeoutMs || 600000);idle.unref();};
  const send = value => child.stdin.write(JSON.stringify(value)+'\n');
  const request = (method,params) => new Promise((resolve,reject)=>{if(failure)return reject(failure);const id=++serial;pending.set(id,{resolve,reject,method});send({id,method,params});});
  const emit = async frame => {for(const event of [normalizeEvent(frame)].flat().filter(Boolean)) await onEvent(event);};
  const bind = async id => {
    if(threadId && threadId !== id)throw new Error('Provider 返回的会话 ID 与当前成员绑定不一致');
    if(session?.resume && session.sessionId !== id)throw new Error('Provider 返回的会话 ID 与当前成员绑定不一致');
    if(!threadId){threadId=id;await emit({type:'thread.started',thread_id:id});}
  };
  child.stdin.on('error',error=>abort(error));
  child.on('error',error=>{diagnostic('provider.spawn_error',{error});abort(error)});
  child.on('close',(code,signal)=>{closed=true;diagnostic('provider.exit',{code,signal,childPid:child.pid});if(!finalText || failure)abort(failure || new Error(`Codex 原生进程提前退出 (${code ?? signal})`));});
  const errors=createInterface({input:child.stderr});
  const stderrTask=(async()=>{for await(const line of errors)diagnostic('provider.stderr',{text:line});})();
  const reader=createInterface({input:child.stdout});
  const receive=(async()=>{
    try { for await(const line of reader) {
      if(!line.trim())continue;
      const message=JSON.parse(line);diagnostic('provider.stdout',{frame:message});touch();
      if(message.id !== undefined && !message.method) {
        const waiter=pending.get(message.id);if(!waiter)continue;pending.delete(message.id);
        if(message.error){const error=new Error(`Codex ${waiter.method}: ${message.error.message}`);error.rpcCode=message.error.code;waiter.reject(error);}else waiter.resolve(message.result);
        continue;
      }
      if(message.id !== undefined) {send({id:message.id,error:{code:-32601,message:'Interactive server requests are not supported by this unattended Runtime'}});throw new Error(`Codex 需要交互式处理：${message.method}`);}
      const p=message.params || {};
      if(message.method==='error' && p.willRetry && !retryTimer){retryTimer=setTimeout(()=>abort(new Error('Codex API 连续重试超过等待时间')),input.apiRetryTimeoutMs || 300000);retryTimer.unref();}
      if(message.method==='thread/started')await bind(p.thread.id);
      if(['item/started','item/completed'].includes(message.method)) {
        clearTimeout(retryTimer);retryTimer=null;
        if(p.threadId !== threadId || (turnId && p.turnId !== turnId))continue;
        const item=nativeItem(p.item);if(!item)continue;
        if(message.method==='item/completed' && item.type==='agent_message')finalText=item.text || '';
        await emit({type:message.method==='item/started'?'item.started':'item.completed',item});
      }
      if(message.method==='error' && !p.willRetry)throw new Error(p.error?.message || 'Codex 原生调用失败');
      if(message.method==='turn/completed' && p.threadId===threadId) {
        if(p.turn.status!=='completed')throw new Error(p.turn.error?.message || `Codex turn ${p.turn.status}`);
        if(!finalText.trim())throw new Error('Codex 未返回可验证的最终结构化结果');
        complete();
      }
    }} catch(error){abort(error);}
  })();
  diagnostic('provider.spawn',{command,cwd:workspacePath,childPid:child.pid,provider:'Codex app-server'});touch();
  try {
    await request('initialize',{clientInfo:{name:'agentforge',title:'AgentForge',version:'1.0.0'},capabilities:{experimentalApi:true}});send({method:'initialized'});
    await request('skills/extraRoots/set',{extraRoots:[...new Set((runtime.skillPaths || []).map(path=>dirname(path)))]});
    const catalog=await request('skills/list',{cwds:[workspacePath],forceReload:true});
    const selected=new Set((runtime.skillPaths || []).map(path=>resolve(path)));
    const rows=catalog.data.flatMap(row=>row.skills);
    for(const path of selected)if(!rows.some(row=>resolve(row.path)===path))throw new Error('所选 Skill 未被 Codex 原生发现；检查插件格式和 CLI 版本');
    for(const row of catalog.data)if(row.errors?.some(error=>[...selected].some(path=>path.startsWith(resolve(error.path || '')+'/') || path===resolve(error.path || ''))))throw new Error('所选 Skill 原生解析失败');
    const config={'features.skip_host_skill_discovery':false,'skills.config':rows.map(row=>({path:row.path,enabled:selected.has(resolve(row.path))}))};
    // App-server does not inherit the top-level CLI's hook-trust switch.
    // Apply its native thread override only for vetted selected command hooks.
    if(args.includes('--dangerously-bypass-hook-trust'))config.bypass_hook_trust=true;
    diagnostic('provider.native_skills',{selectedCount:selected.size,disabledCount:rows.filter(row=>!selected.has(resolve(row.path))).length});
    const params={cwd:workspacePath,developerInstructions:input.systemPrompt || '',approvalPolicy:'never',sandbox:'danger-full-access',config,...(runtime.model?{model:runtime.model}:{})};
    let thread;
    try {thread=await request(session?.resume?'thread/resume':'thread/start',{...params,...(session?.resume?{threadId:session.sessionId,excludeTurns:true}:{})});}
    catch(error){if(session?.resume && /no rollout|not found|does not exist|could not find/i.test(error.message))throw missingSessionError('Codex 未找到指定会话');throw error;}
    await bind(thread.thread.id);
    const outputSchema=input.outputSchema || (input.schemaPath?JSON.parse(await readFile(input.schemaPath,'utf8')):undefined);
    const turn=await request('turn/start',{threadId,input:[{type:'text',text:input.prompt}],...(runtime.effort?{effort:runtime.effort}:{}),...(outputSchema?{outputSchema}:{})});turnId=turn.turn.id;
    await completion;
    if(cancelled)throw cancelled;
    if(input.finalPath)await writeFile(input.finalPath,finalText,{mode:0o600});
    return {finalText};
  } catch(error){diagnostic('provider.native_error',{error});throw cancelled || error;}
  finally {clearTimeout(idle);clearTimeout(retryTimer);stop();await Promise.allSettled([receive,stderrTask]);clearTimeout(killTimer);unregister();}
}
