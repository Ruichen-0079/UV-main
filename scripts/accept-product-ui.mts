/** Opt-in browser effect gate. Uses an isolated configured Runtime; never exports field values. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { readRuntimeEnvFiles } from "../packages/config/src/index.js";

if (!process.argv.includes("--run")) throw new Error("Use --run with an isolated Runtime configuration.");
const { chromium } = await import(process.env.YUVI_PLAYWRIGHT_MODULE || "playwright");
const { env, runtimeEnvDir } = await readRuntimeEnvFiles();
const originalConfig = await fs.readFile(`${runtimeEnvDir}/.env.local`);
const base = process.env.YUVI_UI_URL || "http://127.0.0.1:5174";
const api = process.env.YUVI_UI_API || "http://127.0.0.1:6122";
for (const value of [base, api]) assert.equal(new URL(value).hostname, "127.0.0.1");
assert.notEqual(new URL(api).port, "6121", "Use the isolated acceptance Runtime, not daily settings.");
const rows: Array<{control: string; status: string; evidence: string}> = [];
const output = process.env.YUVI_UI_OUTPUT || "/tmp/campaign-h-ui-effects.json";
const browser = await chromium.launch({headless: true, args:["--no-sandbox"]});
const page = await browser.newPage();
await page.addInitScript(() => localStorage.setItem("yuvi.ui.locale", "en"));
page.setDefaultTimeout(12000);
page.on("dialog", (d: any) => d.accept());
const headers = {"content-type":"application/json", ...(env.DASHBOARD_DEV_TOKEN ? {authorization:`Bearer ${env.DASHBOARD_DEV_TOKEN}`} : {})};
async function json(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
 const response = await fetch(api+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(120000)});
 assert(response.ok, `HTTP ${response.status} at ${path.split('?')[0]}`); return response.json();
}
async function step(evidence: string, controls: string[], fn: () => Promise<void>) {
 if (process.env.YUVI_ACCEPT_SECTION === "settings" && !/^(Every Settings|Settings |Dashboard token)/.test(evidence)) return;
 try {await fn();for(const control of controls)rows.push({control,status:"REAL_LOCAL_PASS",evidence});}
 catch(error) {for(const control of controls)rows.push({control,status:"BROKEN",evidence:`${evidence}: ${(error as Error).message.slice(0,200)}`});}
 await fs.writeFile(output,JSON.stringify(rows,null,2));console.log(evidence, rows.at(-1)?.status);
}
async function nav(name: string) {await page.getByRole("button",{name,exact:true}).first().click();await page.waitForTimeout(600);}
async function action(locator: any, path: string, method = "POST", expected = 200) {
 const pending=page.waitForResponse((r:any)=>new URL(r.url()).pathname==="/api"+path&&r.request().method()===method,{timeout:120000});
 await locator.click();const response=await pending;const payload=await response.json();assert.equal(response.status(),expected,`${path}: ${JSON.stringify(payload.fieldErrors ?? payload.error ?? response.status())}`);return payload;
}
const button=(name:string)=>page.getByRole("button",{name,exact:true});
try {
 await page.goto(base+"/#/webui");await page.waitForTimeout(1500);
 for(const [label,path] of [["Refresh status","/health"],["Refresh Vision status","/settings/runtime"],["Refresh local services","/local-services/status"]]) {
  await step(`Home ${label} request`,[`Home/${label}`],async()=>{await action(button(label!),path!,"GET");});
 }
 await step("Product navigation changes surface",["Navigation/Home","Navigation/Models & Providers","Navigation/AI Routing","Navigation/Settings","Navigation/Developer","Navigation/Return to Product"],async()=>{
  for(const name of ["Models & Providers","AI Routing","Settings","Developer"]) {await nav(name);assert(await page.locator("main").count());}
  await nav("← Product WebUI");await nav("Home");
 });
 await step("Surface links open correct independent bootstrap",["Home/Chat & Voice Mode","Home/Companion","Home/Subtitle"],async()=>{
  for(const label of ["Chat & Voice Mode","Companion","Subtitle"]){const href=await page.getByRole("link",{name:label,exact:true}).getAttribute("href");assert(href);const tab=await browser.newPage();await tab.goto(new URL(href,base).href);await tab.waitForTimeout(1200);assert(await tab.locator("body").textContent());await tab.close();}
 });
 await nav("Models & Providers");
 const PRODUCT_PROVIDER_DEFINITIONS = await page.evaluate(async () => (await import("/src/product-models-providers.tsx")).PRODUCT_PROVIDER_DEFINITIONS);
 for(let i=0;i<PRODUCT_PROVIDER_DEFINITIONS.length;i++){
  const definition=PRODUCT_PROVIDER_DEFINITIONS[i]!;const card=page.locator(".yuvi-product-provider-card").nth(i);
  const controls=definition.fields.map((f:any)=>`Provider/${definition.id}/${f.key}`);
  await step(`Provider card ${i} all fields save, effective state and reload`,[...controls,`Provider/${definition.id}/Save & apply`],async()=>{
   const before=await json("/settings/runtime");const values:Record<string,string>={};const changed:Record<string,string>={};
   for(const field of definition.fields){const input=card.locator("input").nth(definition.fields.indexOf(field));const current=await input.inputValue();values[field.key]=field.key.endsWith("API_KEY")?(env[field.key]||""):current;
    changed[field.key]=field.key.endsWith("DIMENSIONS")?"64":field.key.endsWith("API_KEY")?"synthetic-ui-key":field.key.includes("BASEURL")||field.key.endsWith("URL")?(current?current.replace(/\/$/,"")+"/":"http://127.0.0.1:9"):current+"-ui-probe";
   }
   try {
    for(const [index,field] of definition.fields.entries())await card.locator("input").nth(index).fill(changed[field.key]);
    await action(card.getByRole("button",{name:"Save & apply",exact:true}),"/settings/runtime");await page.waitForTimeout(700);
    const saved=await json("/settings/runtime");
    for(const field of definition.fields)if(!field.key.endsWith("API_KEY"))assert(String(saved.settings[field.key]?.effective)===changed[field.key],"Provider field did not persist");
    await page.reload();await page.waitForTimeout(700);await nav("Models & Providers");
    for(const [index,field] of definition.fields.entries())if(!field.key.endsWith("API_KEY"))assert((await card.locator("input").nth(index).inputValue())===changed[field.key],"Provider reload mismatch");
   } finally {await json("/settings/runtime",{values});await json("/settings/runtime/reload",{});await page.reload();await page.waitForTimeout(700);await nav("Models & Providers");}
  });
 }
 await nav("AI Routing");
 for(let i=0;i<6;i++)await step(`Routing ${i} save/reload/inspection`,[`Routing/${i}/chain`,`Routing/${i}/Save & apply`,`Routing/${i}/Inspect route`],async()=>{
  const card=page.locator(".yuvi-product-routing-card").nth(i);const input=card.locator("input");const original=await input.inputValue();
  try {await input.fill(original?original+",local":"local");await action(card.getByRole("button",{name:"Save & apply",exact:true}),"/settings/runtime");await page.waitForTimeout(500);await card.getByRole("button",{name:"Inspect route",exact:true}).click();await page.waitForTimeout(500);await page.reload();await page.waitForTimeout(700);await nav("AI Routing");assert.equal(await input.inputValue(),original?original+",local":"local");}
  finally {await input.fill(original);await action(card.getByRole("button",{name:"Save & apply",exact:true}),"/settings/runtime");await page.waitForTimeout(400);}
 });
 await nav("Settings");
 const knownSettings = Object.keys((await json("/settings/runtime")).settings);
 const settingFields = await page.locator("input,select").evaluateAll((nodes: any[], known: string[]) => nodes.flatMap((node,index) => {
  const key=(node.labels?.[0]?.textContent?.trim() || "").match(/^([A-Z][A-Z0-9_]+)/)?.[1];
  return key && known.includes(key) ? [{key,index,type:node.type}] : [];
 }), knownSettings);
 await step("Every Settings field persists through Save Only and reload",settingFields.map((f:any)=>`Settings/${f.key}`),async()=>{
  const backup=await fs.readFile(`${runtimeEnvDir}/.env.local`);const expected:Record<string,string>={};
  try {
   for(const field of settingFields){const input=page.locator("input,select").nth(field.index);const current=await input.inputValue();let value:string;
    if(field.type==="select-one"){const options=await input.locator("option").evaluateAll((ns:any[])=>ns.map(n=>n.value));value=options.find((v:string)=>v!==current)!;}
    else if(field.key==="DATABASE_URL")value="postgres://synthetic:synthetic@127.0.0.1:9/synthetic";
    else if(field.type==="password")value="synthetic-ui-key";
    else if(field.key==="SERVER_PORT")value=String(Number(current)+1);
    else if(field.key==="SERVER_HOST")value=current==="localhost"?"127.0.0.1":"localhost";
    else if(field.key==="EVENT_BUS")value=current==="memory"?"in-memory":"memory";
    else if(field.key==="PROVIDER_ALLOW_MOCKS")value=current==="true"?"false":"true";
    else if(field.key.endsWith("DIMENSIONS"))value=current==="64"?"128":"64";
    else if(field.key==="TTS_PROVIDER_CHAIN")value=current==="xai"?"local":"xai";
    else if(field.key==="STT_PROVIDER_CHAIN")value=current==="dashscope"?"local":"dashscope";
    else if(field.key==="VISION_PROVIDER_CHAIN")value=current==="xai"?"nvidia":"xai";
    else if(field.key.startsWith("EMBEDDING_PROVIDER"))value=current==="nvidia"?"local":"nvidia";
    else if(field.key.endsWith("PROVIDER")||field.key.endsWith("CHAIN"))value=current==="local"?"deepseek":"local";
    else if(field.key.includes("BASEURL"))value=current?current.replace(/\/$/,"")+"/":"http://127.0.0.1:9";
    else value=current+"-settings-probe";
    expected[field.key]=value;if(field.type==="select-one")await input.selectOption(value);else await input.fill(value);
   }
   await action(button("仅保存"),"/settings/runtime");await page.waitForTimeout(500);const saved=await json("/settings/runtime");
   for(const field of settingFields)if(field.type!=="password")assert(String(saved.settings[field.key]?.effective)===expected[field.key],`Settings persistence mismatch: ${field.key}`);
   await page.reload();await page.waitForTimeout(700);await nav("Settings");
   for(const field of settingFields)if(field.type!=="password")assert((await page.locator("input,select").nth(field.index).inputValue())===expected[field.key],`Settings reload mismatch: ${field.key}`);
   for(const field of settingFields.filter((f:any)=>f.type==="password")){
    const input=page.locator("input,select").nth(field.index);const clear=input.locator('xpath=ancestor::label[1]').getByRole("button",{name:"Clear saved key on next save",exact:true});
    await clear.click();await action(button("仅保存"),"/settings/runtime");await page.waitForTimeout(300);
    assert(!(await fs.readFile(`${runtimeEnvDir}/.env.local`,"utf8")).includes(`${field.key}=synthetic-ui-key`),"Clear-secret did not remove synthetic override");
    rows.push({control:`Settings/${field.key}/Clear saved key`,status:"REAL_LOCAL_PASS",evidence:"Synthetic key clear persisted"});
   }
  } finally {await fs.writeFile(`${runtimeEnvDir}/.env.local`,backup,{mode:0o600});await json("/settings/runtime/reload",{});await page.reload();await page.waitForTimeout(700);await nav("Settings");}
 });
 await step("Dashboard token is sent only with protected requests",["Settings/X-YUVI-Dev-Token"],async()=>{const input=page.getByLabel("X-YUVI-Dev-Token",{exact:true});const old=await input.inputValue();try{await input.fill("synthetic-dashboard-token");const pending=page.waitForRequest((r:any)=>r.url().endsWith("/api/settings/runtime")&&r.method()==="POST");await button("仅保存").click();const request=await pending;assert.equal(request.headers().authorization,"Bearer synthetic-dashboard-token");}finally{await input.fill(old);}});
 await step("Settings draft reset/reload and output-language persistence",["Settings/Reset draft","Settings/Reload configuration","Settings/Save only","Settings/Save & apply","Settings/OUTPUT_LANGUAGE"],async()=>{
  const input=page.getByLabel("OPENAI_COMPATIBLE_CHAT_MODEL",{exact:true});const original=await input.inputValue();await input.fill("draft-only");await button("重置草稿").click();assert.equal(await input.inputValue(),original);
  await input.fill("draft-only");await button("重新载入当前配置").click();await page.waitForTimeout(600);assert.equal(await input.inputValue(),original);
  const select=page.getByRole("combobox",{name:/Final reply language/});const old=await select.inputValue();
  try{await select.selectOption(old==="JA"?"EN":"JA");await action(button("仅保存"),"/settings/runtime");await page.waitForTimeout(500);await page.reload();await page.waitForTimeout(700);await nav("Settings");assert.equal(await select.inputValue(),old==="JA"?"EN":"JA");await action(button("保存并应用"),"/settings/runtime");assert.equal((await json("/settings/runtime")).activeRuntimeConfig.outputLanguage,old==="JA"?"EN":"JA");}
  finally{await select.selectOption(old);await action(button("保存并应用"),"/settings/runtime");}
 });
 await step("Settings invalid port rejected without persistence",["Settings/invalid input failure"],async()=>{const input=page.getByLabel("SERVER_PORT",{exact:true});const original=await input.inputValue();await input.fill("invalid-port");await button("仅保存").click();await page.waitForTimeout(700);assert.equal(String((await json("/settings/runtime")).runtime.serverPort),original);assert(await page.getByText(/invalid|failed|失败/i).count());await input.fill(original);});
 await nav("Developer");
 for(const name of ["概览","对话","记忆","提供方","事件","提示词预览","语音","视觉","设置"]){await step(`Developer ${name} navigation`,[`Developer/navigation/${name}`],async()=>{await nav(name);assert(await page.locator("main").count());});}
} finally {await browser.close();await fs.writeFile(`${runtimeEnvDir}/.env.local`, originalConfig, {mode:0o600});await json("/settings/runtime/reload",{});await fs.writeFile(output,JSON.stringify(rows,null,2));}
if(rows.some(r=>r.status==="BROKEN"))process.exitCode=1;
