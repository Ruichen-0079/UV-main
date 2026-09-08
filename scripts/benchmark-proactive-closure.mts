/** Opt-in live evaluation. Synthetic public cases only; no user logs, keys or raw responses exported. */
import fs from 'node:fs/promises';
import { readRuntimeEnvFiles } from '../packages/config/src/index.js';
import { characterOutputLanguageInstruction } from '../packages/character-abi/src/index.js';
import { PromptBuilder } from '../packages/prompt-builder/src/index.js';
import { createProviderRegistryFromEnv } from '../packages/providers/src/index.js';
if(!process.argv.includes('--run')) throw new Error('Use --run for billable live provider evaluation.');
const {env}=await readRuntimeEnvFiles();
const source=await fs.readFile(new URL('../packages/core/src/runtime-orchestrator.ts',import.meta.url),'utf8');
const instruction=source.match(/const proactiveInstruction = `([^`]+)`/)![1]!;
const cases=JSON.parse(await fs.readFile(new URL('./fixtures/proactive-closure-cases.json',import.meta.url),'utf8')) as [string,string,string][];
const models=(process.env.YUVI_BENCH_MODELS ?? 'meta-llama/Llama-3.3-70B-Instruct-Turbo,meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo,google/gemma-3-4b-it').split(',');
const results:any[]=[];
for(const model of models){
 const provider=createProviderRegistryFromEnv({...env,OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL:model,PROVIDER_INCLUDE_RAW_RESPONSES:'true'}).getProactiveDecisionProvider();
 for(let repeat=0;repeat<2;repeat++) for(const [id,expected,conversation] of cases){
  const prompt=new PromptBuilder().buildPrompt({systemIdentity:'You are YUVI, a local-first AI companion runtime agent.',characterStyle:`Warm, concise, conversational, and practical. Prefer short replies of about 1-3 sentences in ordinary chat and expand only when the user asks for detail.\n\n${characterOutputLanguageInstruction('AUTO')}`,relationshipContext:'Use remembered context only when relevant. Do not pretend to remember details that were not retrieved.',directContext:conversation,directContextEnabled:true,retrievedMemories:[],memoryEnabled:false,turnOrigin:'assistant-initiated',proactiveInstruction:instruction}).prompt;
  const start=performance.now();
  try{const output=await provider.decide({prompt},{signal:AbortSignal.timeout(45000)});const raw=(output.debug?.rawResponse as any)?.usage;
   results.push({model,id,repeat,expected,decision:output.decision,latencyMs:Math.round(performance.now()-start),...output.tokenUsage,cachedInputTokens:output.tokenUsage?.cachedInputTokens ?? raw?.prompt_tokens_details?.cached_tokens ?? null,cost:raw?.estimated_cost ?? null});
  }catch(e){results.push({model,id,repeat,expected,decision:'ERROR',latencyMs:Math.round(performance.now()-start),errorCode:(e as any).code??'error'});}
  await fs.writeFile(process.env.YUVI_BENCH_OUTPUT??'/tmp/campaign-h-proactive-results.json',JSON.stringify(results,null,2));
 }
 const rows=results.filter(r=>r.model===model);console.log(JSON.stringify({model,n:rows.length,correct:rows.filter(r=>r.decision===r.expected).length,fp:rows.filter(r=>r.expected==='NO_OP'&&r.decision==='REQUEST_TEXT').length,fn:rows.filter(r=>r.expected==='REQUEST_TEXT'&&r.decision!=='REQUEST_TEXT').length,errors:rows.filter(r=>r.decision==='ERROR').length,meanLatencyMs:Math.round(rows.reduce((s,r)=>s+r.latencyMs,0)/rows.length)}));
}
