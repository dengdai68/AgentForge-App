// Private-file stdio handoff: secrets never become Codex's -c arguments.
import { spawn } from 'node:child_process';
import { readExtensionFile } from './marketplace.mjs';
import { parseMcpJson } from './configuration.mjs';
import { diagnostic, diagnosticRedactor } from '../diagnostics.mjs';
import { createInterface } from 'node:readline';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let redactConfiguration=diagnosticRedactor();
try {
  const [path, sha256, name] = process.argv.slice(2);
  const service = parseMcpJson(await readExtensionFile({path, sha256})).mcpServers[name];
  if (!service) throw new Error('MCP 服务不存在');
  redactConfiguration=diagnosticRedactor({secrets:[...Object.values(service.env || {}),...Object.values(service.headers || {})]});
  if (['http','sse'].includes(service.type)) {
    const redact=diagnosticRedactor({secrets:Object.values(service.headers || {})});
    const endpoint=new URL(service.url);
    const safeFetch=async(input,options={})=>{
      const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
      if(url.origin!==endpoint.origin) throw new Error('MCP 拒绝跨来源请求');
      const result=await fetch(input,{...options,redirect:'manual'});
      if(result.status>=300 && result.status<400) throw new Error('MCP 不跟随重定向；请填写最终服务地址');
      return result;
    };
    const options={fetch:safeFetch,requestInit:{headers:service.headers || {}},eventSourceInit:{fetch:safeFetch}};
    const remote=service.type==='sse'?new SSEClientTransport(endpoint,options):new StreamableHTTPClientTransport(endpoint,options);
    const stdio=new StdioServerTransport();
    let closing=false;
    const close=async()=>{if(closing)return;closing=true;await Promise.allSettled([remote.close(),stdio.close()]);};
    remote.onerror=error=>{diagnostic('mcp.transport_error',redact({name,type:service.type,error}));};
    remote.onclose=()=>{void close();};stdio.onclose=()=>{void close();};
    remote.onmessage=message=>{
      if(message.result?.protocolVersion && typeof remote.setProtocolVersion==='function') remote.setProtocolVersion(message.result.protocolVersion);
      void stdio.send(message).catch(error=>{diagnostic('mcp.stdout_error',redact({name,error}));void close();});
    };
    stdio.onmessage=message=>{void remote.send(message).catch(error=>{
      diagnostic('mcp.request_failed',redact({name,type:service.type,error}));
      if(Object.hasOwn(message,'id')) void stdio.send({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:redact({message:error.message}).message}});
    });};
    await remote.start();await stdio.start();
    process.stdin.once('end',()=>{void close();});
    for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{void close();});
  } else {
  const env = {...process.env, ...service.env};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AGENTFORGE_BOOTSTRAP_TOKEN;
  const child = spawn(service.command, service.args || [], {env, ...(service.cwd?{cwd:service.cwd}:{}), stdio: ['pipe', 'pipe', 'pipe']});
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
  const redact = diagnosticRedactor({ secrets: Object.values(service.env || {}) });
  createInterface({ input: child.stderr }).on('line', text => diagnostic('mcp.stderr', redact({ name, text, childPid: child.pid })));
  child.on('error', error => { diagnostic('mcp.spawn_failed', redact({ name, error })); process.stderr.write('Selected MCP could not start\n'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { diagnostic('mcp.exit', { name, code, signal }); process.exit(code ?? 1); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  process.stdin.on('end', () => child.kill('SIGTERM'));
  child.stdin.on('error', error => diagnostic('mcp.stdin_error', redact({ name, error })));
  }
} catch (error) { diagnostic('mcp.configuration_failed', redactConfiguration({ error })); process.stderr.write('Selected MCP configuration is unavailable\n'); process.exitCode = 1; }
