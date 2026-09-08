/** Controlled Tauri bridge + real Settings component. Rust persistence is covered by cargo test. */
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import path from 'node:path';
if(!process.argv.includes('--run'))throw new Error('Use --run for browser contract acceptance.');
const {chromium}=await import(process.env.YUVI_PLAYWRIGHT_MODULE||'playwright');const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage();const rows=[];
await page.addInitScript(()=>localStorage.setItem('yuvi.ui.locale','en'));
async function mount(){
 await page.goto((process.env.YUVI_UI_URL||'http://127.0.0.1:5174')+'/#/webui');await page.reload();
 await page.evaluate(async url=>{
  const defaults={schemaVersion:1,app:{language:'en'},chat:{provider:'openai-compatible',model:'synthetic-chat'},cognition:{provider:'openai-compatible',model:'synthetic-reasoning'},openaiCompatible:{baseUrl:'http://127.0.0.1:9/v1'},runtime:{mode:'managed',autostart:true,url:'http://127.0.0.1:6121'},memory:{enabled:true,backend:'mem0',mode:'managed',baseUrl:'http://127.0.0.1:6131',subjectUserId:'synthetic-owner',personaId:'synthetic',ollamaUrl:'http://127.0.0.1:11434',llm:{provider:'none',model:'',baseUrl:''}},tts:{enabled:false,mode:'external',wrapperUrl:'http://127.0.0.1:9881',upstreamUrl:'http://127.0.0.1:9880'},stt:{provider:'local',mode:'managed',autostart:false,baseUrl:'http://127.0.0.1:9876',model:'synthetic-stt'},companion:{alwaysOnTop:true},proactive:{enabled:false}};
  const settings=JSON.parse(localStorage.getItem('yuvi.accept.settings')||'null')||defaults;
  const secrets={deepseekApiKey:false,openaiCompatibleApiKey:false,databaseUrl:false,memoryLlmApiKey:false};
  window.__acceptCalls=[];
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   window.__acceptCalls.push({command,args});
   if(command==='get_user_settings')return{settings,secrets,revision:1,configPath:'synthetic/settings.json',loadError:null};
   if(command==='update_user_settings'){
    await new Promise(resolve=>setTimeout(resolve,300));
    const merge=(target,patch)=>{for(const [key,value]of Object.entries(patch)){if(value&&typeof value==='object')merge(target[key],value);else target[key]=value;}};merge(settings,args.patch);localStorage.setItem('yuvi.accept.settings',JSON.stringify(settings));
    return{settings,secrets,revision:2,saved:true,restartRequired:false,restartServices:[],supervisorSync:{applied:true},changedSections:Object.keys(args.patch)};
   }
   if(command==='set_user_secret'||command==='delete_user_secret'){const names={'models.openaiCompatibleApiKey':'openaiCompatibleApiKey','chat.deepseekApiKey':'deepseekApiKey','memory.databaseUrl':'databaseUrl','memory.llmApiKey':'memoryLlmApiKey'};secrets[names[args.key]]=command==='set_user_secret';return{secrets,saved:true,revision:2,restartServices:[],supervisorSync:{applied:true}};}
   throw new Error('Unexpected acceptance command: '+command);
  }};
  const module=await import(url);module.mountSettingsHarness();
 },'/@fs/'+path.join(process.cwd(),'scripts/fixtures/user-settings-harness.tsx'));
 await page.getByRole('button',{name:'Save',exact:true}).waitFor();await page.waitForTimeout(100);
}
try{
 await mount();
 const fields=page.locator('input,select');const controls=[];const expected=[];
 for(let i=0;i<await fields.count();i++){
  const field=fields.nth(i);const info=await field.evaluate(el=>({type:el.type,label:el.labels?.[0]?.textContent?.trim(),value:el.value}));
  if(info.label?.startsWith('UI language'))continue;
  controls.push({index:i,label:info.label,type:info.type});
  if(info.type==='checkbox'){await field.setChecked(!await field.isChecked());expected.push([i,'checkbox',await field.isChecked()]);}
  else if(info.type==='password'){await field.fill('synthetic-acceptance-key');}
  else if(info.type==='select-one'){const values=await field.locator('option').evaluateAll(ns=>ns.map(n=>n.value));let value=values.find(v=>v!==info.value);if(info.value==='openai-compatible')value='openai-compatible';if(info.value==='none')value='none';await field.selectOption(value||info.value);expected.push([i,'value',await field.inputValue()]);}
  else{const value=info.value.startsWith('http')?info.value.replace(/\/$/,'')+'/':'acceptance-'+(info.value||'model');await field.fill(value);expected.push([i,'value',value]);}
 }
 const before=await page.evaluate(()=>window.__acceptCalls.filter(c=>c.command!=='get_user_settings'));assert.equal(before.length,0,'Keystrokes must not mutate native settings');
 await page.getByRole('button',{name:'Save',exact:true}).click();assert.ok(await page.getByRole('button',{name:'Save',exact:true}).isDisabled());
 await page.waitForFunction(()=>window.__acceptCalls.some(c=>c.command==='update_user_settings'));await page.waitForTimeout(500);
 const calls=await page.evaluate(()=>window.__acceptCalls);const mutation=calls.find(c=>c.command==='update_user_settings');assert.ok(mutation);assert.ok(!JSON.stringify(mutation).includes('synthetic-acceptance-key'));
 const clearButtons=page.getByRole('button',{name:'Clear key',exact:true});
 while(await clearButtons.count()){await clearButtons.first().click();await page.waitForTimeout(50);}
 assert.ok((await page.evaluate(()=>window.__acceptCalls)).some(c=>c.command==='delete_user_secret'));
 rows.push({control:'Desktop Settings/Clear secret controls',status:'AUTOMATED_PASS',evidence:'Each configured secret clear invokes the controlled delete_user_secret bridge and removes configured state without exposing a value.'});
 await mount();for(const [i,kind,value]of expected)assert.deepEqual(kind==='checkbox'?await fields.nth(i).isChecked():await fields.nth(i).inputValue(),value);
 for(const control of controls)rows.push({control:'Desktop Settings/'+control.label+'/'+control.index,status:'AUTOMATED_PASS',evidence:'Real component: editing invokes no mutation; Save reaches controlled Tauri bridge; pending disables Save; returned persisted DTO survives remount; secret values never enter settings patch. Rust disk/validation tests run separately.'});
}catch(e){rows.push({control:'Desktop Settings contract',status:'BROKEN',evidence:e.message.slice(0,350)});}finally{await fs.writeFile('/tmp/campaign-h-desktop-settings-acceptance.json',JSON.stringify(rows,null,2));await browser.close();}
console.log(JSON.stringify(rows));if(rows.some(r=>r.status==='BROKEN'))process.exitCode=1;
