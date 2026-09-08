const {chromium} = await import(process.env.YUVI_PLAYWRIGHT_MODULE || 'playwright');
if (!process.argv.includes('--run')) throw new Error('Use --run against an isolated configured Runtime.');import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const results=[];const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage();await page.addInitScript(() => localStorage.setItem("yuvi.ui.locale", "en"));page.setDefaultTimeout(12000);page.on('dialog', d=>d.accept());const base=process.env.YUVI_UI_URL || 'http://127.0.0.1:5174';const api=process.env.YUVI_UI_API || 'http://127.0.0.1:6122';assert.equal(new URL(api).hostname,'127.0.0.1');assert.notEqual(new URL(api).port,'6121');const marker='campaign-h-ui-'+Date.now();let memoryId;
async function step(name,fn){if(process.env.YUVI_SKIP_SPEECH === "1" && name.startsWith("Voice "))return;try{await fn();results.push({name,status:'REAL_LOCAL_PASS'});}catch(e){results.push({name,status:'BROKEN',error:e.message.slice(0,300)});}await fs.writeFile(process.env.YUVI_UI_ACTIONS_OUTPUT || '/tmp/campaign-h-ui-actions.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results.at(-1)));}
async function nav(name){await page.getByRole('button',{name,exact:true}).first().click();await page.waitForTimeout(700);}
async function action(name,path,method='POST'){const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api'+path&&r.request().method()===method,{timeout:120000});await page.getByRole('button',{name,exact:true}).click();const r=await pending;assert.equal(r.status(),200);return r.json();}
await page.goto(base+'/#/webui');await page.waitForTimeout(1200);await nav('Developer');await nav('记忆');
await step('Memory create all metadata fields and persistence',async()=>{
 await page.getByLabel('Content',{exact:true}).fill(marker+' synthetic garden memory');await page.getByLabel('Summary',{exact:true}).fill(marker+' summary');await page.getByRole('combobox',{name:/^Type/}).selectOption('semantic');await page.getByRole('combobox',{name:/^Scope/}).selectOption('session');await page.getByLabel('Scope ID',{exact:true}).fill(marker);await page.getByLabel('Importance',{exact:true}).fill('0.6');await page.getByLabel('Source',{exact:true}).fill('campaign-h-acceptance');await page.getByLabel('Tags',{exact:true}).fill('acceptance,synthetic');
 await page.getByRole('combobox',{name:/^Subtype/}).selectOption('project-fact');
 await page.getByRole('combobox',{name:/^Layer/}).selectOption('recall');
 await page.getByRole('combobox',{name:/^Status/}).selectOption('active');
 await page.getByLabel('Emotion Valence',{exact:true}).fill('0.2');
 await page.getByLabel('Emotion Arousal',{exact:true}).fill('0.3');
 for(const [label,offset] of [['Observed At',-60000],['Event Time',-60000],['Valid From',-86400000],['Valid Until',86400000],['Expires At',172800000]]) await page.getByLabel(label,{exact:true}).fill(new Date(Date.now()+offset).toISOString().slice(0,16));
 const created=await action('Create memory','/memory');memoryId=created.id;assert.ok(memoryId);const r=await fetch(api+'/memory/'+memoryId);assert.equal(r.status,200);const stored=await r.json();assert.equal(stored.content,marker+' synthetic garden memory');assert.equal(stored.scopeId,marker);assert.equal(stored.subtype,'project-fact');assert.equal(stored.memoryLayer,'recall');assert.equal(stored.emotionValence,0.2);assert.equal(stored.emotionArousal,0.3);for(const key of ['observedAt','eventTime','validFrom','validUntil','expiresAt'])assert.ok(stored[key]);await page.reload();await page.waitForTimeout(1000);await nav('Developer');await nav('记忆');assert.ok(await page.getByText(marker,{exact:false}).count());
});
await step('Memory search filter and clear real request',async()=>{
 try {
  await page.locator('select').filter({has:page.locator('option',{hasText:'All scopes'})}).selectOption('session');
  await page.getByPlaceholder('scopeId, e.g. yuvi-runtime').fill(marker);
  const pending=page.waitForResponse(r=>r.url().endsWith('/api/memory/search')&&r.request().method()==='POST');
  await page.getByPlaceholder('Search memory content').fill(marker);const response=await pending;assert.equal(response.status(),200);
  const data=await response.json();assert.ok(data.memories.some(m=>m.id===memoryId),'Synthetic scoped record absent from search');
  await page.waitForFunction(marker=>document.body.textContent.includes(marker),marker);
 } finally {await page.getByRole('button',{name:'Clear',exact:true}).click();await page.waitForTimeout(500);}
 assert.equal(await page.getByPlaceholder('Search memory content').inputValue(),'');
});
await step('Memory aborted search cannot overwrite cleared results',async()=>{
 let release;let arrived;const arrival=new Promise(resolve=>arrived=resolve);
 await page.route('**/api/memory/search',async route=>{
  if(route.request().postDataJSON().q!=='stale-race'){await route.continue();return;}
  const response=await route.fetch();arrived();await new Promise(resolve=>release=resolve);await route.fulfill({response});
 });
 try {
  await page.getByPlaceholder('Search memory content').fill('stale-race');await arrival;
  await page.getByRole('button',{name:'Clear',exact:true}).click();await page.waitForTimeout(500);
  release();await page.waitForTimeout(700);assert.ok(await page.locator('tr').filter({hasText:marker}).count(),'late empty search overwrote current records');
 } finally {release?.();await page.unroute('**/api/memory/search');}
});
await step('Memory View/Edit/Archive/Restore/Forget/Delete',async()=>{
 assert.ok(memoryId);const row=()=>page.locator('tr').filter({hasText:marker}).first();await row().getByRole('button',{name:'View',exact:true}).click();await page.waitForTimeout(300);await row().getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Content',{exact:true}).last().fill(marker+' edited');await action('Save changes','/memory/'+memoryId,'PATCH');await page.waitForTimeout(600);await row().getByRole('button',{name:'Archive',exact:true}).click();await page.waitForTimeout(600);assert.equal((await (await fetch(api+'/memory/'+memoryId)).json()).status,'archived');
 await page.getByLabel('archived',{exact:true}).check();await page.waitForTimeout(600);await row().getByRole('button',{name:'Restore',exact:true}).click();await page.waitForTimeout(600);assert.equal((await (await fetch(api+'/memory/'+memoryId)).json()).status,'active');await row().getByRole('button',{name:'Forget',exact:true}).click();await page.waitForTimeout(600);assert.equal((await (await fetch(api+'/memory/'+memoryId)).json()).status,'forgotten');
 const status=page.locator('select').filter({has:page.locator('option',{hasText:'All statuses'})});await status.selectOption('forgotten');await page.waitForTimeout(600);await row().getByRole('button',{name:'Delete',exact:true}).click();await action('Delete memory','/memory/'+memoryId,'DELETE');assert.equal((await fetch(api+'/memory/'+memoryId)).status,404);memoryId=undefined;
});
for(const [label,dryRun] of [['Run Maintenance Dry Run',true],['Run Maintenance',false]])await step(label,async()=>{const r=await action(label,'/memory/maintenance/run');assert.equal(r.summary.dryRun,dryRun);assert.equal(r.summary.failed,0);});
await nav('提供方');for(const capability of ['chat','reasoning','embedding','tts','stt','vision'])await step('Inspect '+capability+' chain',async()=>{const pending=page.waitForResponse(r=>r.url().includes('/providers/')&&r.request().method()==='POST');await page.getByRole('button',{name:'Inspect '+capability+' chain',exact:true}).click();assert.equal((await pending).status(),200);});
await nav('事件');await step('Events pause/resume/filter',async()=>{await page.getByRole('button',{name:'Pause',exact:true}).click();assert.ok(await page.getByRole('button',{name:'Resume',exact:true}).count());await page.getByRole('button',{name:'Resume',exact:true}).click();const select=page.locator('select');if(await select.locator('option').count()>1){await select.selectOption({index:1});await select.selectOption('all');}});
await nav('语音');await step('Voice real file transcription',async()=>{await page.getByLabel('sessionId',{exact:true}).fill(marker);await page.getByLabel('audio file',{exact:true}).setInputFiles(process.env.YUVI_ACCEPT_STT_WAV || '/tmp/campaign-h-speech.wav');const r=await action('Transcribe','/v1/audio/transcriptions');assert.ok(r.text?.trim());});
await step('Voice real generated speech',async()=>{await page.locator('textarea').last().fill('今日はゆっくり話しましょう。');const r=await action('Generate Speech','/v1/tts');assert.ok(r.audioBase64||r.audioUrl||r.audio);});
await step('Voice message with memory disabled',async()=>{await page.getByLabel('Read memory',{exact:true}).uncheck();await page.getByLabel('Write memory',{exact:true}).uncheck();const r=await action('Send Voice Message','/v1/voice/message');assert.ok(r.reply?.trim()||r.message?.reply||r.response?.reply);});
await nav('视觉');await step('Vision unavailable route returns truthful error',async()=>{await page.getByLabel('imageBase64',{exact:true}).fill('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=');const pending=page.waitForResponse(r=>r.url().includes('/vision/')&&r.request().method()==='POST');await page.getByRole('button',{name:'Analyze',exact:true}).click();const r=await pending;assert.ok(r.status()>=400);await page.waitForTimeout(300);assert.ok(await page.getByText(/unavailable|not configured|failed|error/i).count());});
if(memoryId)await fetch(api+'/memory/'+memoryId,{method:'DELETE'});
await browser.close();
if(results.some(r=>r.status==='BROKEN'))process.exitCode=1;
