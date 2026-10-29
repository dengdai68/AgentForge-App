// Post-E2E restart and visible browser regression. Only accepts an isolated history fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { chromium } from "playwright-core";
import { createAuth } from "../server/auth.mjs";
import { verifyHistoryEvidence } from "./verify-history-evidence.mjs";

const root=resolve(process.argv[2] || "");
assert.equal(dirname(root),resolve(".data"));assert.match(basename(root),/^history-e2e-[a-zA-Z0-9]+$/);
if(await fetch("http://127.0.0.1:4310/api/health").then(()=>true,()=>false))throw new Error("4310 必须空闲；不会终止已有进程");
console.log(JSON.stringify(await verifyHistoryEvidence(root)));
const evidence=JSON.parse(await readFile(join(root,"evidence.json"),"utf8"));
const password=randomBytes(24).toString("hex"),auth=createAuth({databasePath:join(root,"auth.sqlite")});
await auth.setAdministrator("history-restart-test",password);auth.close();
const backend=spawn(process.execPath,["server/index.mjs"],{env:{...process.env,AGENTFORGE_DB_PATH:join(root,"state.sqlite"),AGENTFORGE_AUTH_DB_PATH:join(root,"auth.sqlite"),AGENTFORGE_RUN_FILES_ROOT:join(root,"runs"),AGENTFORGE_RUNTIME_CONFIG_ROOT:join(root,"runtime"),AGENTFORGE_WORKSPACE_ROOT:join(root,"workspaces")},stdio:["ignore","inherit","inherit"]});
let browser;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
  for(let i=0;i<120;i++){if(await fetch("http://127.0.0.1:4310/api/health").then(r=>r.ok,()=>false))break;await sleep(1000);}
  browser=await chromium.launch({channel:"chrome",headless:false});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("http://127.0.0.1:4310/");await page.locator("#username").fill("history-restart-test");await page.locator("#password").fill(password);await page.getByRole("button",{name:"登录",exact:true}).click();await page.locator("#account-name").waitFor();
  const response=await page.evaluate(async id=>{const r=await fetch(`/api/agents/agent_analyst/history/search_task_activity`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:id,query:"evidence.md"})});return {status:r.status,data:await r.json()};},evidence.runId);
  assert.equal(response.status,200);assert.ok(response.data.items.length);
  await page.goto(`http://127.0.0.1:4310/communication/${evidence.privateChatId}`);
  await page.locator(".communication-message:not(.from-human) .communication-body").filter({hasText:"归档后核验通过"}).waitFor();
  await page.screenshot({path:"screenshots/history-restart-e2e.png"});
  for(const [route,text] of [["data-model","员工历史与可见性"],["system-architecture","只读历史工具"],["task-flow","按需找回历史"]]){
    await page.goto(`http://127.0.0.1:4310/manual/${route}`);await page.getByRole("heading",{name:text,exact:true}).waitFor();
    await page.getByRole("heading",{name:text,exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:`screenshots/history-manual-${route}.png`});
  }
  assert.deepEqual(errors,[]);
  console.log("PASS persisted history after real server restart, archived query, visible chat and all three manual pages; no browser errors");
}finally{if(browser)await browser.close();backend.kill("SIGTERM");}
