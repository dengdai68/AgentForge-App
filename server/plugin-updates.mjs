import {fileURLToPath} from 'node:url';
import {remotePluginRevision} from './runtime/configuration.mjs';
import {diagnostic} from './diagnostics.mjs';

export const pluginUpdateIntervalMs=120000;

// An origin can contain relative plugins and independently moving Git sources.
// Group by installation origin, while checking each distinct tracked ref once.
export function pluginUpdateSources(plugins) {
  const groups=new Map();
  for(const item of plugins){
    const source=item.source,origin=source?.origin || source;
    if(!origin?.url)continue;
    const specs=[origin,source].filter(spec=>spec?.url?.startsWith('https://'));
    if(!specs.length)continue;
    const group=groups.get(origin.url) || {url:origin.url,plugins:[],specs:[]};
    group.plugins.push(item);
    for(const spec of specs)if(!group.specs.some(old=>JSON.stringify([old.url,old.ref,old.sha,old.revision])===JSON.stringify([spec.url,spec.ref,spec.sha,spec.revision])))group.specs.push(spec);
    groups.set(origin.url,group);
  }
  return [...groups.values()];
}

export function createPluginUpdates({getStore,marketplace,probe=remotePluginRevision,intervalMs,canRun=()=>true}) {
  let timer=null,nextCheckAt=null,current=null,controller=null,stopped=false;
  let lastCheckedAt=null,lastResult=null;
  const duration=()=>intervalMs ?? getStore().getPluginUpdateSettings().intervalMinutes*60000;
  const status=()=>({...getStore().getPluginUpdateSettings(),intervalMs:duration(),running:Boolean(current),lastCheckedAt,nextCheckAt,lastResult});
  const schedule=()=>{
    clearTimeout(timer);nextCheckAt=null;
    if(stopped || current || !getStore().getPluginUpdateSettings().enabled)return;
    nextCheckAt=new Date(Date.now()+duration()).toISOString();
    timer=setTimeout(()=>{nextCheckAt=null;if(canRun())void check();else schedule();},duration());timer.unref?.();
  };
  async function perform(store,signal){
    const result={checkedSources:0,updatedPlugins:0,updates:[],errors:[]};
    const plugins=(await marketplace.catalog()).plugins.filter(item=>!store.isExtensionRemoved('plugin',item.id));
    const revisions=new Map();
    for(const group of pluginUpdateSources(plugins)){
      if(signal.aborted || !canRun() || getStore()!==store)break;
      let candidates=null,committed=false;
      try{
        result.checkedSources++;
        let changed=false;
        for(const spec of group.specs){
          const key=JSON.stringify([spec.url,spec.ref,spec.sha]);
          if(!revisions.has(key))revisions.set(key,Promise.resolve().then(()=>probe(spec,{signal})));
          if(await revisions.get(key)!==spec.revision)changed=true;
        }
        if(!changed)continue;
        candidates=await marketplace.import(group.url.startsWith('file:')?{path:fileURLToPath(group.url)}:{url:group.url},{pluginNames:[...new Set(group.plugins.map(item=>item.name))],includeMcps:false,signal,transient:true});
        const replacements=group.plugins.map(old=>{
          const next=candidates.plugins.find(item=>item.name===old.name);if(!next)throw new Error('来源中找不到已安装插件');
          return {...next,previousId:old.id};
        });
        const byId=new Map(replacements.map(item=>[item.previousId,item.id]));
        const users=store.listAgents().filter(item=>item.runtime?.extensionSelection?.pluginIds?.some(id=>byId.has(id)));
        const bindings=await Promise.all(users.map(async item=>({agentId:item.id,previousRuntime:item.runtime,runtime:{profileId:item.runtime.profileId,...await marketplace.resolve({...item.runtime.extensionSelection,pluginIds:item.runtime.extensionSelection.pluginIds.map(id=>byId.get(id)||id)},item.runtime.provider)}})));
        if(signal.aborted || !canRun() || getStore()!==store)throw new Error('插件更新已取消');
        const receipt=store.replacePluginExtensions(replacements,bindings);committed=true;
        result.updatedPlugins+=receipt.plugins.length;result.updates.push(...receipt.plugins);
        diagnostic('plugins.updated',{source:group.url,...receipt});
      }catch(error){
        diagnostic('plugins.update_failed',{source:group.url,error});
        if(!signal.aborted)result.errors.push({source:group.url,message:'更新未应用，当前版本保留；详情见本机日志'});
      }finally{
        if(candidates && !committed && getStore()===store)for(const item of candidates.plugins){
          try{store.removeExtension({kind:'plugin',id:item.id,name:item.name},{type:'system',id:'plugin-updater',name:'插件更新'});}catch(error){diagnostic('plugins.candidate_cleanup_failed',{error});}
        }
      }
    }
    return result;
  }
  function check(){
    if(current)return current;
    if(stopped || !canRun())return Promise.resolve(status());
    clearTimeout(timer);nextCheckAt=null;controller=new AbortController();
    current=perform(getStore(),controller.signal).then(result=>{lastResult=result;return result;}).catch(error=>{
      diagnostic('plugins.check_failed',{error});lastResult={checkedSources:0,updatedPlugins:0,updates:[],errors:[{message:'检查失败，详情见本机日志'}]};return lastResult;
    }).finally(()=>{lastCheckedAt=new Date().toISOString();current=null;controller=null;schedule();});
    return current;
  }
  return {status,check,start:schedule,reset(){lastCheckedAt=null;lastResult=null;schedule();},configure(input){getStore().setPluginUpdateSettings(input);schedule();return status();},stop(){stopped=true;clearTimeout(timer);nextCheckAt=null;controller?.abort();return current || Promise.resolve();}};
}
