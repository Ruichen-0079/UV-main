/** Opt-in, billable cache experiment using the real Character adapter and synthetic evidence. */
import fs from 'node:fs/promises';
import {readRuntimeEnvFiles} from '../packages/config/src/index.js';
import {PromptBuilder} from '../packages/prompt-builder/src/index.js';
import {createServerCharacterPort} from '../apps/server/src/character-runtime.js';
if(!process.argv.includes('--run')) throw new Error('Use --run for live provider calls.');
const {env}=await readRuntimeEnvFiles();
const rows:unknown[]=[];
const conversation=Array.from({length:14},(_,i)=>`User: For acceptance step ${i}, check the synthetic garden schedule.\nAssistant: Step ${i} has a bounded watering plan and no unresolved request.`).join('\n');
for(const layout of ['baseline','time-last']) for(let cycle=0;cycle<2;cycle++) for(const scenario of ['cold','consecutive','unchanged-persona-p8','changed-memory','changed-time','changed-context']){
 const idx=['cold','consecutive','unchanged-persona-p8','changed-memory','changed-time','changed-context'].indexOf(scenario);
 const prompt=new PromptBuilder().buildPrompt({systemIdentity:'You are YUVI, a local-first AI companion runtime agent.',characterStyle:'Warm, concise, conversational, and practical.',relationshipContext:'Only supplied evidence establishes familiarity.',currentTime:{isoTimestamp:`2026-09-08T10:${String(cycle*10+idx).padStart(2,'0')}:00Z`},directContext:conversation+(idx===5?'\nUser: The synthetic plan now includes basil.':''),directContextEnabled:true,retrievedMemories:[idx>=3?'The synthetic garden includes basil.':'The synthetic garden includes mint.'],memoryEnabled:true,currentSituation:'Ordinary synthetic acceptance conversation.',userMessage:'How is the garden plan looking?'});
 let captured:any;
 await createServerCharacterPort().generate({prompt,userMessage:'How is the garden plan looking?',generateChat:async input=>{captured=input;return {message:{role:'assistant',content:'{"disposition":"RESPOND","text":"The plan is ready."}'},finishReason:'stop'};}});
 { 
  const s=captured.messages[0].content;const marker='Semantic context:\n';const offset=s.indexOf(marker)+marker.length;const context=JSON.parse(s.slice(offset));const order=layout==='baseline'?['IDENTITY','PERSONA','RELATIONSHIP_CONTEXT','TEMPORAL_CONTEXT','RECENT_CONVERSATION','CONTINUITY','MEMORY_EVIDENCE','CURRENT_SITUATION']:['IDENTITY','PERSONA','RELATIONSHIP_CONTEXT','RECENT_CONVERSATION','CONTINUITY','MEMORY_EVIDENCE','CURRENT_SITUATION','TEMPORAL_CONTEXT'];context.sections.sort((a:any,b:any)=>order.indexOf(a.kind)-order.indexOf(b.kind));captured.messages[0].content=s.slice(0,offset)+JSON.stringify(context);
 }
 const start=performance.now();
 try{const response=await fetch(env.OPENAI_COMPATIBLE_API_BASEURL!.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${env.OPENAI_COMPATIBLE_API_KEY}`},body:JSON.stringify({model:env.OPENAI_COMPATIBLE_CHAT_MODEL,messages:captured.messages,temperature:0,max_tokens:128}),signal:AbortSignal.timeout(90000)});const result:any=await response.json();if(!response.ok)throw new Error(`HTTP ${response.status}`);const u=result.usage;rows.push({layout,cycle,scenario,latencyMs:Math.round(performance.now()-start),inputTokens:u?.prompt_tokens,outputTokens:u?.completion_tokens,cachedInputTokens:u?.prompt_tokens_details?.cached_tokens??null,cost:u?.estimated_cost??null});}catch(e){rows.push({layout,cycle,scenario,error:e instanceof Error?e.name:'error'});}
 await fs.writeFile('/tmp/campaign-h-cache-results.json',JSON.stringify(rows,null,2));console.log(JSON.stringify(rows.at(-1)));
}
