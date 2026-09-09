import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { MEMORY_CLAIM_METADATA as M, currentEligibleMemoryEvents } from "../claim.js";
import { parseMemoryScope } from "../scope.js";
import { admitVoiceProfilePersonBinding, voiceProfileBindingWriteFields } from "../voice-profile-binding.js";
import type { MemoryEvent, MemoryProvider, MemoryWriteEventInput, MemoryWriteEventOutcome } from "../provider.js";

const source = "local-controller-evidence";
const record = z.object({ id: z.string().uuid(), recordedAt: z.string().datetime(), input: z.record(z.unknown()) }).strict();
const envelope = z.object({ version: z.literal(1), records: z.array(record), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A narrow explicit-controller evidence adapter. No retrieval, extraction, or general writes. */
export class LocalControllerEvidenceProvider implements MemoryProvider {
  private readonly directory: string;
  private readonly file: string;
  constructor(dataRoot: string) {
    if (!isAbsolute(dataRoot)) throw new Error("Controller evidence requires an absolute DATA root.");
    this.directory = join(dataRoot, "controller-evidence");
    this.file = join(this.directory, "events.json");
  }
  async retrieveRelevant() {
    return { status: "unavailable" as const, events: [], source, limited: false, errorCode: "LOCAL_EVIDENCE_HAS_NO_SEARCH" };
  }
  private normalize(input: MemoryWriteEventInput, previous: MemoryEvent[]): MemoryWriteEventInput {
    const scope = parseMemoryScope(input.scope);
    if (!scope.userId.startsWith("voice-profile:") || !scope.characterId.trim()) throw new Error("Unsupported evidence scope.");
    const supersedes = input.metadata?.[M.supersedes];
    if (supersedes !== undefined && (!Array.isArray(supersedes) || !supersedes.length || supersedes.some(id => typeof id !== "string" || !previous.some(e => e.id === id && e.scope === input.scope)))) throw new Error("Invalid correction references.");
    if (input.kind === "correction" && !input.claim && Array.isArray(supersedes) && input.content === "Local controller removed this voice binding.") {
      return { kind: "correction", content: input.content, scope: input.scope, metadata: { [M.supersedes]: [...supersedes] } };
    }
    const claim = input.claim;
    if ((input.kind !== "user_claim" && input.kind !== "correction") || claim?.assertor.entityId !== "local-explicit-controller" || claim.assertor.resolution !== "resolved" || claim.provenanceClass !== "EXTERNAL_CLAIM" || claim.subject.resolution !== "resolved" || !claim.subject.entityId) throw new Error("Only explicit controller bindings are supported.");
    const voiceProfileId = scope.userId.slice("voice-profile:".length);
    if (input.metadata?.["yuviVoiceProfileId"] !== voiceProfileId || input.metadata?.["yuviVoiceProfileBinding"] !== "assignment") throw new Error("Invalid binding metadata.");
    const admitted = admitVoiceProfilePersonBinding({ voiceProfileId, personId: claim.subject.entityId, assertor: claim.assertor, provenanceClass: claim.provenanceClass, trustedController: true, content: input.content });
    if (admitted.decision !== "admit") throw new Error("Invalid binding evidence.");
    if (input.kind === "correction" && !supersedes) throw new Error("Correction requires supersession.");
    const fields = voiceProfileBindingWriteFields(admitted);
    return { ...fields, kind: input.kind, scope: input.scope, metadata: { ...fields.metadata, ...(supersedes ? { [M.supersedes]: supersedes } : {}) } };
  }
  private read(): { records: z.infer<typeof record>[]; events: MemoryEvent[] } {
    let fd: number;
    try { fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], events: [] }; throw error; }
    let parsed: z.infer<typeof envelope>;
    try {
      const directory = lstatSync(this.directory), file = fstatSync(fd);
      if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || !file.isFile() || (file.mode & 0o077)) throw new Error("Controller evidence must remain private.");
      parsed = envelope.parse(JSON.parse(readFileSync(fd, "utf8")));
    } finally { closeSync(fd); }
    if (digest(parsed.records) !== parsed.sha256) throw new Error("Controller evidence checksum mismatch.");
    const events: MemoryEvent[] = [];
    for (const row of parsed.records) {
      if (events.some(e => e.sourceRecordId === row.id)) throw new Error("Duplicate evidence ID.");
      const input = this.normalize(row.input as MemoryWriteEventInput, events);
      if (digest(input) !== digest(row.input)) throw new Error("Invalid controller evidence record.");
      events.push({ ...input, id: `${source}:${row.id}`, source, sourceRecordId: row.id, recordedAt: row.recordedAt, metadata: input.metadata ?? {} });
    }
    return { records: parsed.records, events };
  }
  async getEvent({ id, scope }: { id: string; scope: string }): Promise<MemoryEvent | null> {
    const { events } = this.read();
    const event = events.find(e => e.id === id && e.scope === scope);
    if (!event) return null;
    const scoped = events.filter(e => e.scope === scope);
    const eligible = currentEligibleMemoryEvents(scoped);
    // An incomplete reference index cannot revive removed evidence or hide conflicting assignments.
    if (!eligible.some(e => e.id === id)) return { ...event, metadata: { ...event.metadata, [M.memoryStatus]: "superseded" } };
    const subjects = new Set(eligible.filter(e => e.claim).map(e => e.claim!.subject.entityId));
    if (event.claim && subjects.size > 1) return null;
    return event;
  }
  async writeEvent(input: MemoryWriteEventInput): Promise<MemoryWriteEventOutcome> {
    let locked = false;
    let temporary: string | undefined;
    const lock = join(this.directory, "write.lock");
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Evidence directory must be private.");
      mkdirSync(lock, { mode: 0o700 }); locked = true;
      const { records, events } = this.read();
      const normalized = this.normalize(input, events);
      const id = randomUUID();
      records.push({ id, recordedAt: new Date().toISOString(), input: normalized });
      temporary = join(this.directory, `${id}.tmp`);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); writeFileSync(fd, JSON.stringify({ version: 1, records, sha256: digest(records) })); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.file); temporary = undefined;
      const dir = openSync(this.directory, constants.O_RDONLY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
      return { status: "written", eventId: `${source}:${id}` };
    } catch {
      return { status: "rejected", errorCode: "LOCAL_CONTROLLER_EVIDENCE_UNAVAILABLE", failureClass: "ambiguous" };
    } finally {
      if (temporary) { try { unlinkSync(temporary); } catch {} }
      if (locked) rmdirSync(lock);
    }
  }
}
