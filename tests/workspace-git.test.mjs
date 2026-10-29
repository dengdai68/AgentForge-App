import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,open} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeWorkspaceGit} from '../server/workspace-git.mjs';
import {createRunFiles} from '../server/run-files.mjs';
const exec=promisify(execFile);
const git=(root,args)=>exec('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','-C',root,...args]);
async function repo(root){await mkdir(root,{recursive:true});await git(root,['init']);await writeFile(join(root,'readme.md'),'before\n');await git(root,['add','.']);await git(root,['commit','-m','baseline']);}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'af-source-control-'));
 const sources=[{path:'repos/one',url:'https://example.com/one.git'},{path:'repos/two',url:'https://example.com/two.git'}];
 await mkdir(join(root,'docs'),{recursive:true});for(const source of sources)await repo(join(root,source.path));
 const task={workspacePath:root,repositoryMode:'agent',repositorySources:sources};
 const files=createRunFiles({root:join(root,'.audit')});
 return {root,sources,task,files};
}
test('workspace Git initialization registers multiple child repositories without changing their state',async()=>{
 const {root,sources}=await fixture();try{
 const before=await git(join(root,'repos/one'),['rev-parse','HEAD']);
 await writeFile(join(root,'repos/one/readme.md'),'employee changes\n');
 await initializeWorkspaceGit(root,sources);
 const status=await git(root,['submodule','status']);assert.match(status.stdout,/repos\/one/);assert.match(status.stdout,/repos\/two/);
 const tree=await git(root,['ls-tree','HEAD','repos/one']);assert.match(tree.stdout,/160000 commit/);
 assert.equal((await git(join(root,'repos/one'),['rev-parse','HEAD'])).stdout,before.stdout);
 assert.equal(await readFile(join(root,'repos/one/readme.md'),'utf8'),'employee changes\n');
 assert.equal(await initializeWorkspaceGit(root,sources),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('source control shows actual root/child changes and diffs additions, staged edits and deletions',async()=>{
 const {root,sources,files,task}=await fixture();try{
 await writeFile(join(root,'docs/report.md'),'original\n');await git(root,['init']);await git(root,['add','docs/report.md']);await git(root,['commit','-m','document baseline']);
 await initializeWorkspaceGit(root,sources);
 await writeFile(join(root,'docs/report.md'),'updated\n');await git(root,['add','docs/report.md']);
 await writeFile(join(root,'repos/one/new.js'),'console.log("new");\n');
 await rm(join(root,'repos/two/readme.md'));
 await writeFile(join(root,'docs/.env'),'secret text');
 const changes=await files.listWorkingChanges(task);
 const all=changes.repositories.flatMap(r=>r.changes);
 assert.deepEqual(all.map(x=>[x.path,x.status]),[['docs/report.md','M'],['repos/one/new.js','A'],['repos/two/readme.md','D']]);
 const modified=await files.readWorkingDiff(task,'docs/report.md');assert.match(modified.patch,/-original\n\+updated/);
 const added=await files.readWorkingDiff(task,'repos/one/new.js');assert.match(added.patch,/\+console.log/);
 const deleted=await files.readWorkingDiff(task,'repos/two/readme.md');assert.match(deleted.patch,/-before/);
 await assert.rejects(files.readWorkingDiff(task,'docs/.env'),/敏感/);
 await assert.rejects(files.readWorkingDiff(task,'docs/../../outside'),/相对路径/);
 await symlink('/etc/passwd',join(root,'docs/link'));await assert.rejects(files.readWorkingDiff(task,'docs/link'),/符号链接/);
 await rm(join(root,'repos/one'),{recursive:true,force:true});
 await symlink(join(root,'repos/two'),join(root,'repos/one'));
 await assert.rejects(files.listWorkingChanges(task),/符号链接/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('whole workspace listing and CHANGE include root files, custom media and committed work without a manifest',async t=>{
 const root=await mkdtemp(join(tmpdir(),'af-all-workspace-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files=createRunFiles({root:join(root,'.agentforge/audit')}),task={workspacePath:root,repositoryMode:'agent',repositorySources:[]};
 await initializeWorkspaceGit(root);
 await mkdir(join(root,'artifacts/preparation/assets'),{recursive:true});
 const media=await open(join(root,'artifacts/preparation/assets/source.mp4'),'w');await media.truncate(298473832);await media.close();
 await writeFile(join(root,'summary.md'),'first\n');await git(root,['add','summary.md']);await git(root,['commit','-m','employee work']);
 await writeFile(join(root,'summary.md'),'updated\n');await writeFile(join(root,'.env'),'private');await writeFile(join(root,'.agentforge-workspace.json'),'{invalid old display list');
 const changes=(await files.listWorkingChanges(task)).repositories.flatMap(repo=>repo.changes);
 assert.deepEqual(changes.map(c=>c.path),['artifacts/preparation/assets/source.mp4','summary.md']);
 assert.equal(changes.find(c=>c.path==='summary.md').status,'A','comparison includes committed work since task initialization');
 const tree=await files.listWorkingDirectory(task);assert.ok(tree.entries.some(entry=>entry.path==='summary.md'));assert.ok(tree.entries.some(entry=>entry.path==='artifacts'));assert.ok(!tree.entries.some(entry=>entry.path==='docs'));
 const page=await files.listWorkingDirectory(task,{path:'artifacts/preparation/assets'});assert.equal(page.entries[0].bytes,298473832);
 assert.equal((await files.readWorkingDiff(task,page.entries[0].path)).tooLarge,true);
 assert.equal((await files.readWorkingFile(task,'summary.md')).content,'updated\n');
 await assert.rejects(files.readWorkingFile(task,'.env'),/敏感/);
});

test('directory paging reaches every ordinary file beyond 1000 without reading contents or following links',async t=>{
 const root=await mkdtemp(join(tmpdir(),'af-directory-pages-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files=createRunFiles({root:join(root,'.agentforge/audit')}),task={workspacePath:root};await mkdir(join(root,'node_modules'));
 await Promise.all(Array.from({length:1005},(_,i)=>writeFile(join(root,'node_modules',String(i).padStart(4,'0')+'.txt'),'x')));
 await writeFile(join(root,'node_modules/.env'),'private');await symlink('/etc',join(root,'node_modules/escape'));
 const paths=[];let offset=0;do{const page=await files.listWorkingDirectory(task,{path:'node_modules',offset});assert.ok(page.entries.length<=200);paths.push(...page.entries.map(entry=>entry.path));offset=page.nextOffset;}while(offset!==null);
 assert.equal(paths.length,1005);assert.equal(new Set(paths).size,1005);
 for(const options of [{path:'../outside'},{path:'.git'},{path:'node_modules/escape'},{path:'node_modules',offset:-1},{offset:1.5}])await assert.rejects(files.listWorkingDirectory(task,options));
});
test('binary and oversized files have explicit Diff fallbacks',async()=>{
 const {root,sources,files,task}=await fixture();try{
 await initializeWorkspaceGit(root,sources);
 await writeFile(join(root,'docs/image.bin'),Buffer.from([0,1,2]));
 await writeFile(join(root,'docs/large.txt'),'x'.repeat(524289));
 assert.equal((await files.readWorkingDiff(task,'docs/image.bin')).binary,true);
 assert.equal((await files.readWorkingDiff(task,'docs/large.txt')).tooLarge,true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('task diff retains committed child code and subsequent edits even after the parent advances',async()=>{
 const {root,sources,files,task}=await fixture();try{
 await initializeWorkspaceGit(root,sources);
 await writeFile(join(root,'repos/one/readme.md'),'committed child work\n');
 await git(join(root,'repos/one'),['add','readme.md']);await git(join(root,'repos/one'),['commit','-m','child work']);
 const status=await files.listWorkingChanges(task);
 assert.ok(status.repositories[0].changes.some(change=>change.path==='repos/one'&&change.submodule));
 assert.deepEqual(status.repositories[1].changes.map(c=>c.path),['repos/one/readme.md']);
 const code=await files.readWorkingDiff(task,'repos/one/readme.md');assert.match(code.patch,/-before\n\+committed child work/);
 assert.equal(code.baseLabel,'任务初始版本');
 const pointer=await files.readWorkingDiff(task,'repos/one');assert.equal(pointer.submodule,true);assert.match(pointer.patch,/-Subproject commit/);
 // Advancing the parent gitlink must not erase the task's original comparison.
 await git(root,['add','repos/one']);await git(root,['commit','-m','update child pointer']);
 await writeFile(join(root,'repos/one/readme.md'),'uncommitted continuation\n');
 const continued=await files.readWorkingDiff(task,'repos/one/readme.md');assert.match(continued.patch,/-before\n\+uncommitted continuation/);
 assert.equal((await files.listWorkingChanges(task)).repositories[1].changes.length,1);

 }finally{await rm(root,{recursive:true,force:true});}
});

test('full-file Diff includes unchanged context outside the default hunks',async()=>{
 const {root,sources,files,task}=await fixture();try{
 const child=join(root,'repos/one');
 const original=Array.from({length:40},(_,i)=>`line ${i}`).join('\n')+'\n';
 await writeFile(join(child,'readme.md'),original);await git(child,['add','.']);await git(child,['commit','-m','long baseline']);
 await initializeWorkspaceGit(root,sources);
 await writeFile(join(child,'readme.md'),original.replace('line 20','updated 20'));
 const limited=await files.readWorkingDiff(task,'repos/one/readme.md');
 const full=await files.readWorkingDiff(task,'repos/one/readme.md',{full:true});
 assert.doesNotMatch(limited.patch,/ line 0\n/);
 assert.match(full.patch,/ line 0\n/);assert.match(full.patch,/ line 39\n/);
 assert.match(full.patch,/-line 20\n\+updated 20/);
 }finally{await rm(root,{recursive:true,force:true});}
});
