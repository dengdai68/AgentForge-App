// Explicit real-Provider acceptance; all configuration/data/files are isolated.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,open,stat} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {_electron as electron} from 'playwright-core';
import {createAuth} from '../server/auth.mjs';

if(process.env.AGENTFORGE_WORKSPACE_REAL!=='1')throw Error('Set AGENTFORGE_WORKSPACE_REAL=1 to authorize a real Claude code-development task.');
const resumed=Boolean(process.env.AGENTFORGE_WORKSPACE_RESUME);
const root=resumed?resolve(process.env.AGENTFORGE_WORKSPACE_RESUME):await mkdtemp(join(tmpdir(),'af-workspace-case-'));
assert.equal(dirname(root),resolve(tmpdir()),'resume only an isolated fixture in the system temporary directory');
assert.match(basename(root),/^af-workspace-case-[A-Za-z0-9]+$/);
if(resumed){const previous=JSON.parse(await readFile(join(root,'evidence.json'),'utf8'));assert.equal(previous.root,root);assert.equal(previous.real,true);assert.equal(previous.result,'FAIL','resume only a failed acceptance, without rerunning its model task');}
const home=join(root,'home'),data=join(home,'.agentforge/desktop');await mkdir(home,{recursive:true});
const password=randomBytes(24).toString('hex'),auth=createAuth({databasePath:join(data,'auth.sqlite')});await auth.setAdministrator('workspace-qa',password);auth.close();
const actual=process.env.AGENTFORGE_WORKSPACE_CLAUDE || execFileSync('/usr/bin/which',['claude'],{encoding:'utf8'}).trim();
const wrapper=join(root,'real-claude');await writeFile(wrapper,'#!/bin/sh\nHOME='+JSON.stringify(homedir())+' exec '+JSON.stringify(actual)+' "$@"\n',{mode:0o700});
const clip=join(root,'fixture.mp4');if(!resumed)execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-t','1','-c:v','libx264','-pix_fmt','yuv420p',clip]);
const appPath=process.env.AGENTFORGE_WORKSPACE_APP;
const app=await electron.launch({...(appPath?{executablePath:resolve(appPath,'Contents/MacOS/AgentForge'),args:['--user-data-dir='+join(root,'profile')]}:{args:['apps/electron/main.mjs','--user-data-dir='+join(root,'profile')]}),env:{...process.env,HOME:home,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR || join(homedir(),'.claude'),AGENTFORGE_DESKTOP_DATA_ROOT:data,AGENTFORGE_LOG_DIR:join(root,'logs')},timeout:90000});
const evidence={root,packaged:Boolean(appPath),real:true,resumed,result:'RUNNING'};
const wait=async(label,check,timeout=900000)=>{const start=Date.now();let last=0;while(Date.now()-start<timeout){const value=await check();if(value)return value;if(Date.now()-last>30000){console.log('WAIT',label);last=Date.now()}await new Promise(done=>setTimeout(done,500))}throw Error('timeout: '+label)};
try{
  const page=await app.firstWindow();await page.waitForURL(/^http:\/\/127\.0\.0\.1:/,{timeout:60000});const base=new URL(page.url()).origin;
  console.log('EVIDENCE',root);
  const login=async p=>{await p.goto(base+'/login');await p.locator('#username').fill('workspace-qa');await p.locator('#password').fill(password);await p.getByRole('button',{name:'登录',exact:true}).click();await p.locator('#account-name').waitFor();};await login(page);
  const api=(path,body,method=body?'POST':'GET')=>page.evaluate(async({path,body,method})=>{const response=await fetch(path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value},{path,body,method});
  await writeFile(join(root,'endpoint.json'),JSON.stringify({origin:base,instanceId:(await api('/api/health')).instanceId}),{mode:0o600});
  const cli=(args,input='')=>new Promise((done,reject)=>{const child=spawn(process.execPath,['cli/main.mjs',...args,'--json','--endpoint-file',join(root,'endpoint.json'),'--session-file',join(root,'cli/session.json')]);let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('close',code=>code?reject(Error(err||out)):done(JSON.parse(out).data));child.stdin.end(typeof input==='string'?input:JSON.stringify(input))});
  const create=(group,input)=>cli([group,'create','--file','-'],input);
  await cli(['auth','login','--username','workspace-qa','--password-stdin'],password+'\n');await cli(['plugins','auto-update','--file','-'],{enabled:false});
  let task,run,testerId;
  if(resumed){
    const listing=await cli(['tasks','list','--all']);task=listing.items.find(item=>item.title==='WORKSPACE-85｜自定义目录代码开发与独立测试');assert.ok(task,'existing real task must exist');
    const progress=await cli(['tasks','progress',task.id]);run={id:progress.runId};assert.ok(run.id);
    testerId=(await api('/api/agents')).agents.find(item=>item.name==='独立代码验证者').id;
  }else{
  const profile=await create('runtimes',{name:'真实工作目录验收',provider:'claude-code',executable:wrapper});
  const employee=(await create('agents',{name:'目录开发者',capabilities:['Node.js','代码实现'],systemPrompt:'实际实现并运行测试，不猜测命令结果。只在任务工作目录交付，不push、不修改配置凭据。',runtime:{profileId:profile.id}})).agent;
  const tester=(await create('agents',{name:'独立代码验证者',capabilities:['独立测试','Node.js'],systemPrompt:'独立读取实现与测试，不相信作者摘要；运行真实测试和额外边界，记录失败与未验证项，不替作者做实现。只在任务工作目录交付。',runtime:{profileId:profile.id}})).agent;
  const manager=(await create('agents',{name:'研发协调者',kind:'manager',systemPrompt:'工作流只有build和verify。先派工目录开发者执行build，收到交接后派工独立代码验证者执行verify，收到独立通过报告后提交人类验收。业务问题交回对应成员，不自己实现或测试。',runtime:{profileId:profile.id}})).agent;
  const team=(await create('teams',{name:'全工作目录真实研发验收',managerAgentId:manager.id,memberAgentIds:[employee.id,tester.id]})).team;
  const flow=(await create('workflows',{name:'自定义目录代码交付',nodes:[{id:'build',title:'实现工具',staffingGuidance:'选择目录开发者',artifactPaths:['src/','tests/','reports/','artifacts/preparation/assets/'],deliverable:`实现 src/title-index.mjs 导出 summarizeTitles(rows)，仅接受数组，每项必须为含非空字符串title的对象；返回按trim后title的首次出现顺序去重的标题数组。编写 tests/title-index.test.mjs，至少6个node:test覆盖合法与非法输入。先实际执行 node -e 'process.exit(7)'，作为预期失败记录；再执行真实 node --test。将样例结果写入根 summary.json，命令与结果写 reports/build.md。将现成真实1秒媒体 ${clip} 复制到 artifacts/preparation/assets/source.mp4，不重新下载。所有产物均在任务工作目录，不创建docs目录。`,dependsOn:[]},{id:'verify',title:'独立验证',staffingGuidance:'选择独立代码验证者，不得为代码作者',artifactPaths:['reports/'],deliverable:'独立读取src和tests中的实际文件，运行node --test，独立检查空数组、重复标题、保留顺序、中文、trim、非法对象/标题/非数组；可新增 tests/independent.test.mjs，但不能改实现以掩盖问题。写 reports/review.md，清楚记录真实命令、通过数、预期失败及未验证项；用ffprobe验证 artifacts/preparation/assets/source.mp4可读且约1秒。失败交回开发者，成功交接经理。',dependsOn:['build']}]})).workflowTemplate;
  assert.deepEqual(flow.nodes[0].artifactPaths,['src/','tests/','reports/','artifacts/preparation/assets/']);
  task=(await create('tasks',{title:'WORKSPACE-85｜自定义目录代码开发与独立测试',objective:'按工作流交付可运行标题去重工具、独立测试报告、根结果文件及真实样例媒体；全部位于非docs目录，交付后等待人类确认。',teamId:team.id,workflowTemplateId:flow.id})).task;
  run=(await cli(['tasks','start',task.id])).run;testerId=tester.id;
  }
  const state=()=>api('/api/runs/'+run.id+'/workspace?view=summary');
  const final=await wait('real development and independent test',async()=>{const w=await state();if(['failed','awaiting_human'].includes(w.run.status))throw Error('unexpected '+w.run.status);return w.run.status==='awaiting_acceptance'?w:null});
  const workspace=final.run.task.workspacePath;
  const testOutput=execFileSync(process.execPath,['--test','--test-reporter=tap'],{cwd:workspace,encoding:'utf8'});await writeFile(join(root,'independent-harness-test.log'),testOutput);assert.match(testOutput,/# fail 0/);
  for(const path of ['src/title-index.mjs','tests/title-index.test.mjs','reports/build.md','reports/review.md','summary.json','artifacts/preparation/assets/source.mp4']){assert.ok((await stat(join(workspace,path))).size>0);assert.ok(final.artifacts.some(item=>item.name===path),'snapshot records '+path)}
  assert.equal(final.traces.find(item=>item.workflowNodeId==='verify' && item.type==='node').agentId,testerId);
  assert.equal(execFileSync('git',['-C',workspace,'status','--porcelain'],{encoding:'utf8'}).includes('artifacts/'),true);
  const huge=await open(join(workspace,'artifacts/preparation/assets/large-test.bin'),'w');await huge.truncate(298473832);await huge.close();
  const bytes=Buffer.alloc(600*1024,0xab);await writeFile(join(workspace,'artifacts/preparation/assets/download.bin'),bytes);
  await mkdir(join(workspace,'data/many'),{recursive:true});await Promise.all(Array.from({length:1005},(_,i)=>writeFile(join(workspace,'data/many',String(i).padStart(4,'0')+'.txt'),'paging fixture')));
  await writeFile(join(workspace,'.env'),'private fixture sentinel');await writeFile(join(workspace,'.agentforge-workspace.json'),'{obsolete invalid fixture}');
  const changes=await api('/api/runs/'+run.id+'/working-directory/changes');assert.ok(changes.repositories.flatMap(repo=>repo.changes).some(item=>item.path==='artifacts/preparation/assets/source.mp4'));
  const tooLarge=await api('/api/runs/'+run.id+'/working-directory/diff?path=artifacts/preparation/assets/large-test.bin');assert.equal(tooLarge.tooLarge,true);
  const openFolder=async(p,path)=>{const folder=p.locator(`[data-directory-path="${path}"]`);await folder.waitFor();if(!await folder.evaluate(el=>el.open))await folder.locator(':scope > summary').click();};
  for(const [surface,p] of [['desktop',page]]){
    await p.goto(base+'/runs/'+run.id);await p.locator('#directory-mode').click();await p.locator('[data-directory-path=artifacts]').waitFor();
    for(const path of ['artifacts','artifacts/preparation','artifacts/preparation/assets'])await openFolder(p,path);
    await p.locator('[data-select-working-file="artifacts/preparation/assets/source.mp4"]').waitFor();
    assert.equal(await p.locator('[data-select-working-file=".env"]').count(),0);
    await p.locator('[data-select-working-file="artifacts/preparation/assets/large-test.bin"]').click();await p.getByText(/超过预览上限/).waitFor();assert.equal(await p.locator('[data-download-working-file]').isEnabled(),true);
    await p.locator('[data-select-working-file="artifacts/preparation/assets/download.bin"]').click();
    const destination=join(root,surface+'-download.bin');
    if(surface==='desktop'){
      await app.evaluate(({BrowserWindow},destination)=>{globalThis.__workspaceDownload=null;BrowserWindow.getAllWindows()[0].webContents.session.once('will-download',(_event,item)=>{item.setSavePath(destination);item.once('done',(_event,state)=>globalThis.__workspaceDownload=state);});},destination);
      await p.locator('[data-download-working-file]').click();assert.equal(await wait('native file download',()=>app.evaluate(()=>globalThis.__workspaceDownload),30000),'completed');
    }else{const downloadPromise=p.waitForEvent('download');await p.locator('[data-download-working-file]').click();const download=await downloadPromise;await download.saveAs(destination);}
    assert.deepEqual(await readFile(destination),bytes);
    for(const path of ['data','data/many'])await openFolder(p,path);await p.locator('[data-load-more-directory="data/many"]').waitFor();
    while(await p.locator('[data-load-more-directory="data/many"]').count()){await p.locator('[data-load-more-directory="data/many"]').click();await wait('next file page',async()=>!await p.locator('[data-load-more-directory="data/many"]:disabled').count(),30000)}
    assert.equal(await p.locator('[data-select-working-file^="data/many/"]').count(),1005);
    await p.locator('[data-refresh-directory]').click();await p.locator('[data-select-working-file="artifacts/preparation/assets/source.mp4"]').waitFor();
    await p.locator('[data-ws-tab=diff]').click();await p.locator('[data-select-diff="artifacts/preparation/assets/source.mp4"]').waitFor();await p.locator('[data-select-diff="artifacts/preparation/assets/large-test.bin"]').click();await p.getByText(/文件较大/).waitFor();
    await p.screenshot({path:join(root,surface+'-wide.png')});if(surface==='desktop')await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(760,600));else await p.setViewportSize({width:760,height:600});await p.waitForFunction(()=>innerWidth===760);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.screenshot({path:join(root,surface+'-narrow.png')});
  }
  await page.locator('[data-open-completion-confirm]').click();assert.equal(await page.locator('#confirm-completion').isDisabled(),true);await page.locator('#ack-completion').check();await page.locator('#confirm-completion').click();const done=await wait('human confirmation',async()=>{const w=await state();return w.run.status==='completed'?w:null});assert.equal(done.run.confirmedBy,'human_operator');
  evidence.task={taskId:task.id,runId:run.id,traceCount:done.traces.length,humanConfirmation:done.run.confirmedBy,workspace};evidence.result='PASS';console.log('PASS',root);
}catch(error){evidence.result='FAIL';evidence.error=error.message;throw error;}
finally{await writeFile(join(root,resumed?'evidence-resumed.json':'evidence.json'),JSON.stringify(evidence,null,2));await app.close();}
