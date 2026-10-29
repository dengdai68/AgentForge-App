import { mkdir, readFile, writeFile, realpath, lstat, rename, unlink, rm } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {diagnostic} from '../diagnostics.mjs';

const exec = promisify(execFile);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const gitHosts = Object.freeze({
  github: { id: "github", label: "GitHub", host: "github.com", username: "x-access-token" },
  gitlab: { id: "gitlab", label: "GitLab", host: "gitlab.com", username: "oauth2" }
});

function gitHost(provider) {
  if (typeof provider !== "string" || !gitHosts[provider]) throw new Error("仅支持配置 GitHub 或 GitLab Token");
  return gitHosts[provider];
}

function gitToken(value) {
  if (typeof value !== "string") throw new Error("Git Token 必须是文本");
  const token = value.trim();
  if (!token || token.length > 4096 || /[\0\r\n]/.test(token)) throw new Error("Git Token 不能为空、不能包含换行且最多 4096 个字符");
  return token;
}

function repositoryGitHost(url) {
  if (typeof url !== "string") return null;
  let remote;
  try { remote = new URL(url); } catch { return null; }
  if (remote.protocol !== "https:" || remote.username || remote.password || remote.port || remote.search || remote.hash) return null;
  return Object.values(gitHosts).find((host) => host.host === remote.hostname.toLowerCase()) || null;
}

function gitCredentialStatuses(credentials) {
  return {
    providers: Object.values(gitHosts).map(({ id, label, host }) => ({ id, label, host, configured: Boolean(credentials[id]) }))
  };
}
export function gitPluginSource(source) {
  if (!object(source) || !['github','url','git-subdir'].includes(source.source)) throw new Error(`暂不支持插件来源类型「${source?.source || '未知'}」，本批次不安装任何插件`);
  let url = source.source === 'github' ? source.repo : source.url;
  if (['github','git-subdir'].includes(source.source) && typeof url === 'string' && /^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}.git`;
  let remote;try {remote = new URL(url);} catch {throw new Error('插件仓库需要完整 HTTPS Git URL');}
  if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) throw new Error('插件仓库仅接受不含凭据的 HTTPS Git URL');
  if (source.ref !== undefined && (typeof source.ref !== 'string' || !source.ref || source.ref.length>256 || /^[\-]/.test(source.ref) || /[\x00-\x20\x7f]/.test(source.ref))) throw new Error('插件 Git ref 无效');
  if (source.sha !== undefined && (typeof source.sha !== 'string' || !/^[a-f0-9]{40}$/.test(source.sha))) throw new Error('插件 Git sha 必须为完整的 40 位小写提交 ID');
  const path = source.source === 'git-subdir' ? source.path : './';
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').includes('..')) throw new Error('插件子目录必须位于仓库内');
  return { url:remote.href, path, ...(source.ref ? {ref:source.ref} : {}), ...(source.sha ? {sha:source.sha} : {}) };
}
export async function remotePluginRevision(source,{signal}={}) {
  const spec=gitPluginSource({source:'url',...source});
  if(spec.sha)return spec.sha;
  const refs=spec.ref ? spec.ref.startsWith('refs/')?[spec.ref,spec.ref+'^{}']:[`refs/heads/${spec.ref}`,`refs/tags/${spec.ref}`,`refs/tags/${spec.ref}^{}`] : ['HEAD'];
  const {stdout}=await exec('git',['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','ls-remote','--exit-code','--',spec.url,...refs],{timeout:20000,maxBuffer:1024*1024,signal,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
  const rows=stdout.trim().split('\n').map(line=>line.split(/\s+/));
  const row=rows.find(([,ref])=>ref===`refs/heads/${spec.ref}`)||rows.find(([,ref])=>ref?.endsWith('^{}'))||rows[0];
  if(!/^[a-f0-9]{40}$/.test(row?.[0] || ''))throw new Error('插件来源未返回有效 Git 提交');
  return row[0];
}
export async function readPluginCatalog(directory) {
  const canonicalRoot = await realpath(directory);
  const readManifest = async (name) => {
    const path = await realpath(join(directory, name));
    if (!path.startsWith(canonicalRoot + "/")) throw new Error("插件清单路径越界");
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("插件清单过大");
    return JSON.parse(content);
  };
  let catalog, marketplace = true;
  for (const name of ['.agents/plugins/marketplace.json','.claude-plugin/marketplace.json']) {
    try { catalog = await readManifest(name); break; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('插件市场 JSON 无效或清单路径越界'); }
  }
  if (!catalog) for (const name of ['plugin.json','.codex-plugin/plugin.json','.claude-plugin/plugin.json']) {
    try { catalog = {plugins:[{...await readManifest(name),source:'./'}]}; marketplace=false; break; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('插件 JSON 无效或清单路径越界'); }
  }
  if (!catalog) throw new Error('仓库未包含 Claude、Codex 或 Agent Plugins 清单');
  if (!Array.isArray(catalog.plugins)) throw new Error("插件清单需要 plugins 数组");
  const plugins = [];
  for (const plugin of catalog.plugins) {
    if (!plugin || typeof plugin.name !== "string" || !plugin.name.trim()) throw new Error("插件清单名称无效");
    let source = object(plugin.source) && plugin.source.source === 'local' ? plugin.source.path : plugin.source;
    if(object(source) && source.source==='url' && typeof source.url==='string' && (source.url==='.' || source.url.startsWith('./'))) source=source.url;
    // Standalone manifests are read independently for each Provider later;
    // only actual marketplace entries may overlay component declarations.
    const fields = {name:plugin.name,description:String(plugin.description || ''),...Object.fromEntries((marketplace?['skills','mcpServers','strict','hooks','commands','agents','lspServers','outputStyles','settings','dependencies','userConfig','experimental']:[]).filter(key => plugin[key] !== undefined).map(key => [key,plugin[key]]))};
    if(object(source)) {plugins.push({...fields,remoteSource:gitPluginSource(source)});continue;}
    if(typeof source !== 'string' || !source || isAbsolute(source) || source.includes('\\') || source.split('/').includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(source)) throw new Error(`插件「${plugin.name}」目录越界或来源无效`);
    if(!source.startsWith('.') && !source.includes('/') && catalog.metadata?.pluginRoot) source=join(catalog.metadata.pluginRoot,source);
    const path = await realpath(resolve(directory, source)).catch(() => null);
    const rel = path && relative(canonicalRoot, path);
    if (!path || isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error("插件目录越界或不存在");
    plugins.push({ ...fields, path, sourceRoot:canonicalRoot, rootSkillSelection: marketplace && path === canonicalRoot && plugin.skills !== undefined });
  }
  return { plugins };
}
export function parseMcpJson(input) {
  if (typeof input !== "string" || Buffer.byteLength(input) > 128 * 1024) throw new Error("MCP JSON 必须是文本且不超过 128 KB");
  let value;
  try { value = JSON.parse(input || '{"mcpServers":{}}'); } catch { throw new Error("MCP JSON 格式不正确"); }
  if (!object(value) || !object(value.mcpServers) || Object.keys(value).some((key) => key !== "mcpServers")) throw new Error("MCP JSON 顶层只允许 mcpServers 对象");
  if (Object.keys(value.mcpServers).length > 50) throw new Error("MCP 服务最多 50 个");
  for (const [name, service] of Object.entries(value.mcpServers)) {
    if (!/^[\w-]{1,80}$/.test(name) || !object(service)) throw new Error("MCP 服务名称或配置无效");
    if (['http','streamableHttp','streamable-http'].includes(service.type) || (!service.type && service.url)) service.type = 'http';
    if (service.type === "http" || service.type === "sse") {
      let url; try { url = new URL(service.url); } catch { throw new Error("MCP HTTP 服务需要有效 URL"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("MCP URL 必须使用 HTTP(S)，不能内嵌凭据");
    } else if ((service.type && service.type !== "stdio") || typeof service.command !== "string" || !service.command.trim()) throw new Error("MCP stdio 服务需要 command");
    if (service.args !== undefined && (!Array.isArray(service.args) || service.args.some((arg) => typeof arg !== "string"))) throw new Error("MCP args 必须是字符串数组");
    if(service.cwd!==undefined && (typeof service.cwd!=='string' || !service.cwd || /[\0\r\n]/.test(service.cwd)))throw new Error('MCP cwd 必须为有效目录');
    if(service.env_vars!==undefined && (!Array.isArray(service.env_vars) || service.env_vars.some(name=>typeof name!=='string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))))throw new Error('MCP env_vars 必须为环境变量名称数组');
    for (const key of ["env", "headers"]) if (service[key] !== undefined && (!object(service[key]) || Object.values(service[key]).some((item) => typeof item !== "string"))) throw new Error("MCP env/headers 必须是字符串映射");
  }
  return value;
}

export function createRuntimeConfiguration(root) {
  const managedRoot = resolve(root), pluginRoot = resolve(root, "plugins"), catalogRoot = resolve(root, "catalogs"), gitCredentialsPath = resolve(root, "git-credentials.json");
  let gitCredentialWrite = Promise.resolve();
  const queueGitCredentialWrite = (work) => {
    const next = gitCredentialWrite.then(work, work);
    gitCredentialWrite = next.catch(() => {});
    return next;
  };
  const ensureManagedRoot = async () => {
    await mkdir(managedRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(managedRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("私有运行配置目录不可用");
    return managedRoot;
  };
  const readGitCredentials = async () => {
    try {
      const rootInfo = await lstat(managedRoot);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("私有运行配置目录不可用");
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
    let content;
    try {
      const info = await lstat(gitCredentialsPath);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 16 * 1024) throw new Error("Git 托管凭据配置无效");
      content = await readFile(gitCredentialsPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error("Git 托管凭据配置无效"); }
    if (!object(parsed) || parsed.version !== 1 || !object(parsed.providers) || Object.keys(parsed).some((key) => !["version", "providers"].includes(key))) throw new Error("Git 托管凭据配置无效");
    const credentials = {};
    for (const [provider, token] of Object.entries(parsed.providers)) {
      gitHost(provider);
      credentials[provider] = gitToken(token);
    }
    return credentials;
  };
  const writeGitCredentials = async (credentials) => {
    await ensureManagedRoot();
    const temporary = join(managedRoot, `.git-credentials-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, providers: credentials }), { mode: 0o600, flag: "wx" });
      await rename(temporary, gitCredentialsPath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  };
  return {
    async listGitCredentials() {
      return gitCredentialStatuses(await readGitCredentials());
    },
    async saveGitCredential(provider, token) {
      const host = gitHost(provider), value = gitToken(token);
      return queueGitCredentialWrite(async () => {
        const credentials = await readGitCredentials();
        credentials[host.id] = value;
        await writeGitCredentials(credentials);
        return gitCredentialStatuses(credentials);
      });
    },
    async removeGitCredential(provider) {
      const host = gitHost(provider);
      return queueGitCredentialWrite(async () => {
        const credentials = await readGitCredentials();
        delete credentials[host.id];
        await writeGitCredentials(credentials);
        return gitCredentialStatuses(credentials);
      });
    },
    async resolveGitCredential(url) {
      const host = repositoryGitHost(url);
      if (!host) return null;
      const token = (await readGitCredentials())[host.id];
      return token ? { provider: host.id, host: host.host, username: host.username, token } : null;
    },
    async importPlugins(source,{signal,transient=false}={}) {
      const { url, path: localPath } = typeof source === 'string' ? { url: source } : source || {};
      await ensureManagedRoot();
      await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
      const sources=new Map(), options={timeout:90000,maxBuffer:1024*1024,signal,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_LFS_SKIP_SMUDGE:'1'}};
      const directories=new Set();
      const dispose=async()=>{for(const directory of directories)await rm(directory,{recursive:true,force:true});};
      try {
      const git=args=>exec('git',['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never',...args],options);
      const fetchSource=async spec=>{
        const key=JSON.stringify([spec.url,spec.sha || spec.ref || '']);
        if(!sources.has(key)) {
          const directory=join(pluginRoot,randomUUID());
          directories.add(directory);
          try {
            await git(['clone','--depth=1','--no-recurse-submodules',...(spec.ref && !spec.sha?['--branch',spec.ref]:[]),'--',spec.url,directory]);
            if(spec.sha){await git(['-C',directory,'fetch','--depth=1','origin',spec.sha]);await git(['-C',directory,'checkout','--detach','FETCH_HEAD']);}
            const {stdout}=await git(['-C',directory,'rev-parse','HEAD']);
            sources.set(key,{directory:await realpath(directory),url:spec.url,revision:stdout.trim()});
          }catch(cause){throw new Error('插件仓库读取失败，请检查 HTTPS 地址、Git ref/sha 和本机 Git 权限',{cause});}
        }
        const repository=sources.get(key),path=await realpath(resolve(repository.directory,spec.path)).catch(()=>null);
        const rel=path && relative(repository.directory,path);
        if(!path || isAbsolute(rel) || rel==='..' || rel.startsWith('../') || !(await lstat(path)).isDirectory()) throw new Error('插件子目录越界或不存在');
        return {...repository,path};
      };
      let repository;
      if(localPath!==undefined){
        if(url!==undefined || typeof localPath!=='string' || !isAbsolute(localPath))throw new Error('请提供一个 HTTPS 仓库或本机绝对目录');
        const directory=await realpath(localPath);if(!(await lstat(directory)).isDirectory())throw new Error('插件来源必须为目录');
        repository={directory,url:`file://${directory}`,revision:'local'};
      }else repository=await fetchSource(gitPluginSource({source:'url',url}));
      const {plugins}=await readPluginCatalog(repository.directory);
      if (new Set(plugins.map((plugin) => plugin.name)).size !== plugins.length) throw new Error("插件来源包含重复的插件名称");
      for(let index=0;index<plugins.length;index++) {
        const {remoteSource,...plugin}=plugins[index];
        if(remoteSource){
          try {const fetched=await fetchSource(remoteSource);plugins[index]={...plugin,path:fetched.path,sourceRoot:fetched.directory,source:{...remoteSource,url:fetched.url,revision:fetched.revision}};}
          catch(cause){throw new Error(`插件「${plugin.name}」来源无法安装，本批次未安装；${cause.message}`,{cause});}
        }
      }
      const id=randomUUID(),catalog={id,url:repository.url,revision:repository.revision,importedAt:new Date().toISOString(),plugins};
      if(!transient){await mkdir(catalogRoot, { recursive: true, mode: 0o700 });await writeFile(join(catalogRoot, `${id}.json`), JSON.stringify(catalog), { mode: 0o600, flag: "wx" });}
      return transient?{...catalog,dispose}:catalog;
      }catch(error){if(transient)try{await dispose()}catch(cleanupError){diagnostic('plugins.source_cleanup_failed',{error:cleanupError})}throw error;}
    }
  };
}
