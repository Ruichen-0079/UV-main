/** Objective Main controls with a controlled SSE/STT response and synthetic microphone device. */
import assert from 'node:assert/strict';import fs from 'node:fs/promises';
if(!process.argv.includes('--run'))throw new Error('Use --run for browser acceptance.');
const {chromium}=await import(process.env.YUVI_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});const context=await browser.newContext({permissions:['microphone']});const page=await context.newPage();page.setDefaultTimeout(15000);const base=process.env.YUVI_UI_URL||'http://127.0.0.1:5174';const rows=[];
await page.addInitScript(()=>localStorage.setItem('yuvi.ui.locale','en'));
async function step(control,fn){try{await fn();rows.push({control,status:'AUTOMATED_PASS'});}catch(e){rows.push({control,status:'BROKEN',evidence:e.message.slice(0,260)});}await fs.writeFile('/tmp/campaign-h-main-controls.json',JSON.stringify(rows,null,2));console.log(rows.at(-1));}
try{
 await page.goto(base+'/#/main');
 await step('Main empty Send/transcription disabled',async()=>{assert.ok(await page.getByRole('button',{name:'Send message',exact:true}).isDisabled());assert.ok(await page.getByRole('button',{name:'Transcribe recording',exact:true}).isDisabled());});
 await step('Main message/session/read-write/TTS controls reach SSE request and truthful reply',async()=>{
  await page.getByRole('checkbox',{name:/Read Memory/}).uncheck();await page.getByRole('checkbox',{name:/Write Memory/}).uncheck();await page.getByRole('checkbox',{name:/TTS output/}).uncheck();await page.getByLabel('Session ID',{exact:true}).fill('campaign-h-synthetic-ui');
  let request;
  await page.route('**/api/v1/messages/stream',async route=>{request=route.request().postDataJSON();const common={messageId:'synthetic-message',sessionId:request.sessionId,traceId:'synthetic-trace'};await route.fulfill({status:200,contentType:'text/event-stream',body:'event: text-delta\ndata: '+JSON.stringify({...common,type:'text-delta',text:'Synthetic reply.'})+'\n\nevent: completed\ndata: '+JSON.stringify({...common,type:'completed',content:'Synthetic reply.',provider:'mock'})+'\n\n'});});
  await page.getByRole('textbox',{name:'Chat message',exact:true}).fill('Synthetic prompt.');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByText('Synthetic reply.',{exact:true}).waitFor();
  assert.equal(request.sessionId,'campaign-h-synthetic-ui');assert.equal(request.options.readMemory,false);assert.equal(request.options.writeMemory,false);assert.equal(request.text,'Synthetic prompt.');await page.unroute('**/api/v1/messages/stream');
  await page.reload();assert.ok(!await page.getByRole('checkbox',{name:/TTS output/}).isChecked());
 });
 await step('Main recording/stop/transcription respects mutual exclusion and result',async()=>{
  await page.getByRole('button',{name:'Record voice',exact:true}).click();await page.getByRole('button',{name:'Stop recording',exact:true}).waitFor();assert.ok(await page.getByRole('button',{name:'Start Voice Mode',exact:true}).isDisabled());await page.waitForTimeout(1200);await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  const transcribe=page.getByRole('button',{name:'Transcribe recording',exact:true});await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Transcribe recording'&&!b.disabled));
  let request;await page.route('**/api/v1/audio/transcriptions',async route=>{request=route.request().postDataJSON();await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'Synthetic recording.',provider:'mock',mock:true})});});
  await transcribe.click();await page.getByRole('textbox',{name:'Chat message',exact:true}).filter({hasText:''}).waitFor();await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Chat message"]')?.value==='Synthetic recording.');assert.ok(request.audioBase64?.length>100);await page.unroute('**/api/v1/audio/transcriptions');
 });
 await step('Main Voice Mode start/stop owns capture without concurrent recording',async()=>{
  await page.getByRole('button',{name:'Start Voice Mode',exact:true}).click();await page.getByRole('button',{name:'Stop Voice Mode',exact:true}).waitFor();assert.ok(await page.getByRole('button',{name:'Record voice',exact:true}).isDisabled());await page.getByRole('button',{name:'Stop Voice Mode',exact:true}).click();await page.getByRole('button',{name:'Start Voice Mode',exact:true}).waitFor();assert.ok(!await page.getByRole('button',{name:'Record voice',exact:true}).isDisabled());
 });
 const companion=await context.newPage();
 await step('Companion product surface stays avatar-only and resize-adaptive',async()=>{await companion.goto(base+'/#/companion');await companion.locator('[data-model-lifecycle="ready"]').waitFor({timeout:45000});assert.equal(await companion.getByRole('button',{name:'Full body',exact:true}).count(),0);assert.equal(await companion.getByRole('button',{name:'Portrait',exact:true}).count(),0);await companion.setViewportSize({width:360,height:540});await companion.locator('[data-framing="half"]').waitFor();});
 await companion.close();
}finally{await browser.close();}
if(rows.some(r=>r.status==='BROKEN'))process.exitCode=1;
