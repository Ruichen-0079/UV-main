/**
 * Live Mem0 chat-path e2e (no Tauri GUI). Uses explicit user/persona IDs.
 * Run with Sidecar up: node --import tsx scripts/mem0-live-e2e.mts
 */
import {
  MEMORY_SCOPE_MISSING,
  MemoryService,
  InMemoryMemoryRepository,
  classifyMem0Turn,
  createMemoryBackend
} from "../packages/memory/src/index.ts";

const baseUrl = process.env.MEM0_BASE_URL ?? "http://127.0.0.1:6131";
// Unique user per run avoids leftover facts polluting forget/recall assertions.
const user =
  process.env.MEMORY_SUBJECT_USER_ID ??
  `e2e-local-user-${Date.now().toString(36)}`;
const char = process.env.MEMORY_PERSONA_ID ?? "lumi";
// infer=true often needs ~3 minutes with DeepSeek tool rounds.
const writeTimeoutMs = Number(process.env.MEM0_E2E_WRITE_TIMEOUT_MS ?? 300_000);

const backend = createMemoryBackend({
  kind: "mem0",
  mem0BaseUrl: baseUrl,
  mem0TimeoutMs: 600,
  mem0WriteTimeoutMs: writeTimeoutMs
});
const svc = new MemoryService(
  new InMemoryMemoryRepository(),
  undefined,
  undefined,
  undefined,
  { enabled: false },
  { kind: "mem0", mem0: backend, searchTimeoutMs: 600, writeTimeoutMs: writeTimeoutMs }
);
console.error(`e2e scope user=${user} persona=${char} baseUrl=${baseUrl}`);

const results: Record<string, unknown> = {};

// Scope missing
const miss = await svc.retrieveRelevantMemoriesWithMetadata({
  text: "x",
  subjectUserId: user
});
results.scopeMissing = miss.fallbackReason === MEMORY_SCOPE_MISSING;

// A normal preference (infer=true). Use a clear stable preference so the
// Memory LLM is more likely to extract a fact than "unchanged".
const tA = performance.now();
const wA = await svc.storeConversationTurn({
  userMessage: "请注意：我以后都希望你用很简短的回复，一句话即可。这是我的稳定偏好。",
  assistantMessage: "明白，我会尽量简短回复。",
  subjectUserId: user,
  personaId: char,
  sessionId: "conv-a1"
});
results.A_write = { ...wA, ms: Math.round(performance.now() - tA) };
await sleep(800);
const tS = performance.now();
const rA = await svc.retrieveRelevantMemoriesWithMetadata({
  text: "回复偏好 简短",
  subjectUserId: user,
  personaId: char
});
results.A_searchMs = Math.round(performance.now() - tS);
results.A_recall = rA.memories.map((m) => m.displayText);
results.A_usedMemory =
  wA.ok === true &&
  wA.infer === true &&
  rA.memories.some((m) => /简短|short|一句话/i.test(m.displayText));

// B explicit remember
const kindB = classifyMem0Turn({
  userMessage: "请记住：我喜欢科幻作品",
  assistantMessage: "收到"
});
const wB = await svc.storeConversationTurn({
  userMessage: "请记住：我喜欢科幻作品",
  assistantMessage: "收到",
  subjectUserId: user,
  personaId: char
});
results.B = { kind: kindB, write: wB };
await sleep(300);
const rB = await svc.retrieveRelevantMemoriesWithMetadata({
  text: "science fiction",
  subjectUserId: user,
  personaId: char
});
results.B_sci = rB.memories
  .filter((m) => /科幻|science|fiction/i.test(m.displayText))
  .map((m) => m.displayText);

// C forget + 15s wait (no re-add from this process)
const wC = await svc.storeConversationTurn({
  userMessage: "忘记我喜欢科幻作品",
  assistantMessage: "好的",
  subjectUserId: user,
  personaId: char
});
const fC = await svc.forgetExplicitMemory({
  userMessage: "忘记我喜欢科幻作品",
  subjectUserId: user,
  personaId: char
});
results.C_writeSkip = wC;
results.C_forget = fC;
await sleep(15_000);
const rC = await svc.retrieveRelevantMemoriesWithMetadata({
  text: "科幻作品",
  subjectUserId: user,
  personaId: char
});
results.C_afterWait = rC.memories
  .filter((m) => /科幻|science|fiction/i.test(m.displayText))
  .map((m) => m.displayText);

// D correction
const d1 = await svc.storeConversationTurn({
  userMessage: "我最喜欢红色",
  assistantMessage: "记下了红色",
  subjectUserId: user,
  personaId: char
});
await sleep(500);
const d2 = await svc.storeConversationTurn({
  userMessage: "说错了，真正喜欢的是蓝色，不是红色",
  assistantMessage: "已更新为蓝色",
  subjectUserId: user,
  personaId: char
});
await sleep(500);
const rD = await svc.retrieveRelevantMemoriesWithMetadata({
  text: "喜欢什么颜色",
  subjectUserId: user,
  personaId: char
});
const blob = rD.memories.map((m) => m.displayText).join(" | ");
results.D = {
  d1,
  d2,
  recall: blob,
  blue: /蓝|blue/i.test(blob),
  redOnly: /红|red/i.test(blob) && !/蓝|blue/i.test(blob)
};

// E offline
const dead = createMemoryBackend({
  kind: "mem0",
  mem0BaseUrl: "http://127.0.0.1:59999",
  mem0TimeoutMs: 200,
  mem0WriteTimeoutMs: 500
});
const deadSvc = new MemoryService(
  new InMemoryMemoryRepository(),
  undefined,
  undefined,
  undefined,
  { enabled: false },
  { kind: "mem0", mem0: dead, searchTimeoutMs: 200, writeTimeoutMs: 500 }
);
const offline = await deadSvc.retrieveRelevantMemoriesWithMetadata({
  text: "hello",
  subjectUserId: user,
  personaId: char
});
results.E_offline = { count: offline.count, fallback: offline.fallbackUsed };
const rE = await svc.retrieveRelevantMemoriesWithMetadata({
  text: "简短",
  subjectUserId: user,
  personaId: char
});
results.E_recovery = rE.count > 0;

console.log(JSON.stringify(results, null, 2));
const bWrite = (results.B as { write: { infer?: boolean; memoryId?: string } }).write;
const cForget = results.C_forget as { deleted: number; memoryIds: string[] };
const pass =
  results.scopeMissing === true &&
  results.A_usedMemory === true &&
  bWrite.infer === false &&
  cForget.deleted >= 1 &&
  // Forgotten sci-fi id must not reappear after wait
  !(results.C_afterWait as string[]).some((t) => /科幻|science|fiction/i.test(t)) &&
  (results.D as { blue: boolean; redOnly: boolean }).blue === true &&
  (results.D as { redOnly: boolean }).redOnly === false &&
  (results.E_offline as { count: number }).count === 0 &&
  results.E_recovery === true;

console.log(pass ? "E2E_PASS" : "E2E_FAIL");
process.exit(pass ? 0 : 1);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
