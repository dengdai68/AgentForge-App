// Selected-only Codex command hook handoff. The shell command stays in the
// integrity-checked private plugin, never in Provider command-line arguments.
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {spawn} from 'node:child_process';
import {readExtensionFile} from './marketplace.mjs';
import {diagnostic} from '../diagnostics.mjs';

try {
  const [path,sha256,treeSha256,eventIndex,groupIndex,hookIndex]=process.argv.slice(2);
  await readExtensionFile({kind:'plugin',path,sha256,treeSha256});
  const root=dirname(dirname(path)),plan=JSON.parse(await readFile(join(root,'.agentforge/codex.json'),'utf8'));
  const hook=plan.hooks[Number(eventIndex)]?.matchers[Number(groupIndex)]?.hooks[Number(hookIndex)];
  if(hook?.type!=='command' || typeof hook.command!=='string') throw new Error('插件 Hook 绑定无效');
  const data=join(dirname(root),'data');await mkdir(data,{recursive:true,mode:0o700});
  const env={...process.env,PLUGIN_ROOT:root,CLAUDE_PLUGIN_ROOT:root,PLUGIN_DATA:data,CLAUDE_PLUGIN_DATA:data};
  delete env.ELECTRON_RUN_AS_NODE;delete env.AGENTFORGE_BOOTSTRAP_TOKEN;
  const child=spawn('/bin/sh',['-c',hook.command],{env,stdio:'inherit'});
  child.on('error',error=>{diagnostic('plugin.hook_spawn_failed',{error});process.exitCode=1;});
  child.on('exit',(code,signal)=>{process.exit(code ?? (signal?1:0));});
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));
} catch(error) {diagnostic('plugin.hook_configuration_failed',{error});process.stderr.write('Selected plugin hook configuration is unavailable\n');process.exitCode=1;}
