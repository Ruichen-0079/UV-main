/** Browser contract tests use controlled responses; no live provider calls. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
if (!process.argv.includes("--run")) throw new Error("Use --run against the isolated H WebUI.");
const { chromium } = await import(process.env.YUVI_PLAYWRIGHT_MODULE || "playwright");
const base = process.env.YUVI_UI_URL || "http://127.0.0.1:5174";
assert.equal(new URL(base).hostname, "127.0.0.1");
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage(); page.setDefaultTimeout(12000);
await page.addInitScript(() => localStorage.setItem("yuvi.ui.locale", "en"));
const rows=[];
async function step(control, fn) { try { await fn(); rows.push({control,status:"AUTOMATED_PASS",evidence:"Controlled HTTP response + request, pending/disabled, and result assertions"}); } catch(e) { rows.push({control,status:"BROKEN",evidence:e.message.slice(0,250)}); } await fs.writeFile('/tmp/campaign-h-feedback-acceptance.json',JSON.stringify(rows,null,2)); console.log(rows.at(-1)); }
try {
 await page.goto(base+'/#/webui'); await page.getByRole('button',{name:'Models & Providers',exact:true}).first().click();
 const cards=page.locator('.yuvi-product-provider-card'); await cards.first().waitFor();
 for(let i=0;i<await cards.count();i++){
  const card=cards.nth(i); const buttons=card.getByRole('button').filter({hasNotText:'Save & apply'}); const count=await buttons.count();
  for(let j=0;j<count;j++){
   const button=buttons.nth(j); const name=await button.innerText();
   await step(`Provider card ${i}/${name}/pending and truthful failure`,async()=>{
    let release; let request; const arrival=new Promise(resolve=>{
     page.route('**/api/providers/verify/*',async route=>{ request=route.request(); resolve(); await new Promise(r=>release=r); const capability=new URL(request.url()).pathname.split('/').at(-1); const configOnly=['tts','stt','vision'].includes(capability);await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:false,capability,provider:'synthetic-unavailable',configured:false,readiness:'not_ready',observed:'unavailable',mock:false,configOnly,verificationMode:configOnly?'config_only':'live',errorCode:'ACCEPTANCE_UNAVAILABLE',error:'Synthetic provider unavailable',latencyMs:3})});});
    });
    await button.click();
    try {await Promise.race([arrival,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Verification request absent')),10000))]);assert.equal(request.method(),'POST');assert.ok(await button.isDisabled());assert.equal(await page.getByRole('progressbar').first().getAttribute('value'),null);}
    finally {release?.();}
    await page.locator('.yuvi-product-verification.is-error').waitFor();
    assert.match(await page.locator('.yuvi-product-verification').innerText(), /Connection failed|Configuration is not ready/);
    await page.waitForFunction(()=>!Array.from(document.querySelectorAll('.yuvi-product-provider-card button')).some(b=>b.disabled));
    assert.ok(!await page.getByText('Connected ·',{exact:false}).count());
    await page.unroute('**/api/providers/verify/*');
   });
  }
 }
 await step('Provider transport failure never reports saved/applied success',async()=>{
  await page.route('**/api/settings/runtime',route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'synthetic_unavailable'})}):route.continue());
  await cards.first().getByRole('button',{name:'Save & apply',exact:true}).click();await page.getByRole('status').filter({hasText:'Save failed:'}).waitFor();await page.unroute('**/api/settings/runtime');
 });
} finally {await browser.close();}
if(rows.some(r=>r.status==='BROKEN'))process.exitCode=1;
