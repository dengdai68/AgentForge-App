// Local source-control observations. These never decide whether work is accepted.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
const exec = promisify(execFile);
const MAX_BYTES = 512 * 1024;
const selectors = new Set(['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_PREFIX','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_IMPLICIT_WORK_TREE']);
async function git(root, args, options = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !selectors.has(key)));
  return exec('git', ['--no-optional-locks','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',root,...args], { env, timeout: 30000, maxBuffer: 4 * MAX_BYTES, ...options });
}
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function repository(root) {
  const info = await lstat(join(root,'.git')).catch(e => { if (e.code !== 'ENOENT') throw e; });
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
}
export async function initializeWorkspaceGit(root, sources = []) {
  // Never stage employee files or rewrite an existing repository's index/HEAD.
  if (await exists(join(root,'.git'))) return false;
  await git(root, ['init','--initial-branch=main']);
  const ignore = join(root,'.gitignore');
  if (!await exists(ignore)) await writeFile(ignore, '.agentforge/\n.DS_Store\nnode_modules/\n.env\n.env.*\n', { flag: 'wx' });
  await git(root, ['add','--','.gitignore']);
  for (const source of sources) {
    if (!/^repos\/[A-Za-z0-9._-]+$/.test(source.path) || ['repos/.','repos/..'].includes(source.path)) throw new Error('子模块路径无效');
    const child = join(root,source.path);
    if (!await repository(child)) continue;
    const head = await git(child,['rev-parse','--verify','HEAD']).catch(() => null);
    if (!head) continue;
    // Register an already-cloned repository as a real gitlink without cloning,
    // moving its .git directory, changing its branch or touching its index.
    await git(root,['config','-f','.gitmodules',`submodule.${source.path}.path`,source.path]);
    await git(root,['config','-f','.gitmodules',`submodule.${source.path}.url`,source.url]);
    await git(root,['config',`submodule.${source.path}.url`,source.url]);
    await git(root,['config',`submodule.${source.path}.active`,'true']);
    await git(root,['update-index','--add','--cacheinfo',`160000,${head.stdout.trim()},${source.path}`]);
  }
  if (await exists(join(root,'.gitmodules'))) await git(root,['add','--','.gitmodules']);
  await git(root,['-c','user.name=AgentForge','-c','user.email=agentforge@localhost','-c','commit.gpgsign=false','commit','-m','Initialize workspace source control']);
  return true;
}
// Read the original gitlink, not the child HEAD (which advances when employees commit).
// An absent baseline is explicitly labelled as HEAD-only; never guess from remote main.
async function comparisonBase(root, repositoryPath) {
  if (repositoryPath && await repository(root)) {
    const history = await git(root, ['rev-list', '--first-parent', 'HEAD']).catch(() => null);
    const initial = history?.stdout.trim().split('\n').at(-1);
    if (initial) {
      const tree = await git(root, ['ls-tree', initial, '--', repositoryPath]);
      const sha = /^160000 commit ([a-f0-9]{40,64})\t/.exec(tree.stdout)?.[1];
      if (sha) {
        await git(join(root, repositoryPath), ['cat-file', '-e', `${sha}^{commit}`]);
        return { ref: sha, label: '任务初始版本' };
      }
    }
  }
  if(!repositoryPath && await repository(root)){
    const history=await git(root,['rev-list','--first-parent','HEAD']).catch(()=>null);
    const initial=history?.stdout.trim().split('\n').at(-1);
    if(initial){
      const message=await git(root,['show','-s','--format=%s',initial]);
      if(message.stdout.trim()==='Initialize workspace source control')return {ref:initial,label:'任务初始版本'};
    }
  }
  return { ref: 'HEAD', label: repositoryPath ? 'HEAD（未记录任务初始版本）' : 'HEAD（工作目录）' };
}
export async function workspaceGitStatus(root, sources = [], visible = () => true) {
  const groups = [];
  for (const item of [{path:'',label:'工作目录'},...sources.map(s=>({path:s.path,label:s.path.split('/').at(-1)}))]) {
    const cwd = join(root,item.path);
    if (!await repository(cwd)) { groups.push({...item, initialized:false,changes:[]}); continue; }
    try {
      const base = await comparisonBase(root, item.path);
      const changes = new Map();
      const add = (path, status) => {
        const full = item.path ? `${item.path}/${path}` : path;
        const submodule = !item.path && sources.some(source => source.path === full);
        if (!visible(full) || (!item.path && sources.some(source=>full.startsWith(source.path+'/')))) return;
        changes.set(full, {path:full, repositoryPath:item.path, ...(submodule ? {submodule:true} : {}), status});
      };
      const hasBase = await git(cwd, ['rev-parse', '--verify', base.ref]).then(() => true, () => false);
      if (hasBase) {
        const result = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--no-renames', '--ignore-submodules=dirty', base.ref, '--']);
        const entries = result.stdout.split('\0');
        for (let i = 0; i < entries.length - 1; i += 2) add(entries[i+1], entries[i] === 'A' ? 'A' : entries[i] === 'D' ? 'D' : 'M');
      } else {
        const tracked = await git(cwd, ['ls-files', '-z']);
        for (const path of tracked.stdout.split('\0').filter(Boolean)) add(path, 'A');
      }
      const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
      for (const path of untracked.stdout.split('\0').filter(Boolean)) add(path, 'A');
      groups.push({...item,initialized:true,baseRef:base.ref,baseLabel:base.label,changes:[...changes.values()].sort((a,b)=>a.path.localeCompare(b.path))});
    } catch { groups.push({...item,initialized:true,changes:[],error:'无法读取 Git 差异或任务初始版本，请检查本机仓库后刷新。'}); }
  }
  return {repositories:groups,readAt:new Date().toISOString()};
}
// Validate every existing component even for deleted paths; missing final
// components are legal, redirects outside the workspace are not.
export async function sourceControlPath(root, path) {
  if (typeof path!=='string'||!path||isAbsolute(path)||path.includes('\\')||path.includes('\0')||path.split('/').some(p=>!p||p==='.'||p==='..')) throw new Error('Diff 文件路径无效');
  let current=resolve(root);
  for (const part of path.split('/')) {
    current=join(current,part);
    const info=await lstat(current).catch(e=>{if(e.code!=='ENOENT')throw e;});
    if(info?.isSymbolicLink())throw new Error('Diff 不读取符号链接');
  }
  return current;
}
export async function workspaceGitDiff(root, repositoryPath, path, { submodule = false, full = false } = {}) {
  const context = full ? '--unified=1000000' : '--unified=3';
  const cwd=join(root,repositoryPath), file=await sourceControlPath(root,path), local=relative(cwd,file).replaceAll('\\','/');
  if(local.startsWith('../')||isAbsolute(local))throw new Error('文件不属于当前仓库');
  if(!await repository(cwd))throw new Error('工作目录尚未初始化 Git');
  if (submodule) {
    const mode = await git(cwd,['ls-tree','HEAD','--',local]);
    if (!mode.stdout.startsWith('160000 ')) throw new Error('该目录不是已登记的 Git 子模块');
    const result = await git(cwd,['diff',context,'--no-ext-diff','--no-textconv','--no-color','--submodule=short','--ignore-submodules=dirty','HEAD','--',local]);
    return {path,submodule:true,binary:false,tooLarge:false,patch:result.stdout};
  }
  const comparison = await comparisonBase(root, repositoryPath);
  let base=null;
  const hasHead=await git(cwd,['rev-parse','--verify',comparison.ref]).then(()=>true,()=>false);
  if(hasHead){
    const size=await git(cwd,['cat-file','-s',`${comparison.ref}:${local}`]).catch(()=>null);
    if(size){if(Number(size.stdout)>MAX_BYTES)return {path,binary:false,tooLarge:true,patch:''};base=(await git(cwd,['show',`${comparison.ref}:${local}`],{encoding:'buffer'})).stdout;}
  }
  const info=await lstat(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
  if(info&&!info.isFile())throw new Error('Diff 仅支持常规文件');
  if(info?.size>MAX_BYTES)return {path,binary:false,tooLarge:true,patch:''};
  const current=info?await readFile(file):null;
  if(base?.includes(0)||current?.includes(0))return {path,binary:true,tooLarge:false,patch:''};
  let patch='';
  if(base!==null){
    patch=(await git(cwd,['diff',context,'--no-ext-diff','--no-textconv','--no-color','--no-renames',comparison.ref,'--',local])).stdout;
  }else if(current){
    // Untracked/added paths are not in HEAD; diff --no-index has exit status 1
    // for a successful comparison containing changes.
    try { patch=(await git(cwd,['diff',context,'--no-index','--no-ext-diff','--no-textconv','--no-color','--','/dev/null',file])).stdout; }
    catch(e){if(e.code!==1)throw e;patch=e.stdout;}
  }
  if (Buffer.byteLength(patch) > 2 * MAX_BYTES || patch.split('\n').length > 10000) return {path,binary:false,tooLarge:true,patch:''};
  return {path,binary:false,tooLarge:false,patch,baseRef:comparison.ref,baseLabel:comparison.label};
}
