import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:https';
const exec=promisify(execFile);
// A real local HTTPS Git smart-HTTP origin, not a mocked SHA or a writable
// external repository. TLS bypass and Git config isolation exist only in this
// test worker and its fixture children, never in application configuration.
export async function gitOrigin(t,{keep=false}={}){
  const root=await mkdtemp(join(tmpdir(),'af-plugin-updates-')),source=join(root,'source'),repositories=join(root,'repos');
  await mkdir(source);await mkdir(repositories);
  const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_SSL_NO_VERIFY:'true'};
  const git=(...args)=>exec('git',['-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','commit.gpgsign=false',...args],{env});
  await git('init','-b','main',source);await git('init','--bare',join(repositories,'repo.git'));
  await git('-C',source,'remote','add','origin',join(repositories,'repo.git'));
  const commit=async()=>{await git('-C',source,'add','.');await git('-C',source,'commit','--allow-empty','-m','fixture');await git('-C',source,'push','origin','main');return (await git('-C',source,'rev-parse','HEAD')).stdout.trim()};
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=localhost'],{env});
  const server=createServer({key:await readFile(join(root,'key.pem')),cert:await readFile(join(root,'cert.pem'))},(request,response)=>{
    const url=new URL(request.url,'https://localhost');
    const child=spawn('git',['http-backend'],{env:{...env,GIT_PROJECT_ROOT:repositories,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),REQUEST_METHOD:request.method,CONTENT_TYPE:request.headers['content-type']||'',CONTENT_LENGTH:request.headers['content-length']||''},stdio:['pipe','pipe','pipe']});
    let pending=Buffer.alloc(0),headers=false;
    child.stdout.on('data',chunk=>{if(headers){response.write(chunk);return;}pending=Buffer.concat([pending,chunk]);const boundary=pending.indexOf('\r\n\r\n');if(boundary<0)return;const fields={};let status=200;for(const line of pending.subarray(0,boundary).toString().split('\r\n')){const index=line.indexOf(':');if(index<0)continue;const key=line.slice(0,index),value=line.slice(index+1).trim();if(key.toLowerCase()==='status')status=Number(value.split(' ')[0]);else fields[key]=value;}response.writeHead(status,fields);headers=true;response.write(pending.subarray(boundary+4));pending=null;});
    child.on('error',()=>{response.writeHead(500);response.end()});child.on('close',()=>response.end());child.stderr.resume();request.pipe(child.stdin);child.stdin.on('error',()=>{});
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const previous=process.env.GIT_SSL_NO_VERIFY;process.env.GIT_SSL_NO_VERIFY='true';
  t.after(async()=>{previous===undefined?delete process.env.GIT_SSL_NO_VERIFY:process.env.GIT_SSL_NO_VERIFY=previous;server.closeAllConnections();await new Promise(done=>server.close(done));if(!keep)await rm(root,{recursive:true,force:true})});
  return {root,source,git,commit,url:`https://127.0.0.1:${server.address().port}/repo.git`};
}
