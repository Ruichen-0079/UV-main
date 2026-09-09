import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalControllerEvidenceProvider } from "./local-controller-evidence.js";
import {
  admitVoiceProfilePersonBinding,
  voiceProfileBindingWriteFields
} from "../voice-profile-binding.js";
import { buildMemoryScope } from "../scope.js";
import { MemoryService } from "../service.js";
import { InMemoryMemoryRepository } from "../repository.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "yuvi-controller-evidence-"));
  roots.push(root);
  return {
    root,
    provider: new LocalControllerEvidenceProvider(root),
    scope: buildMemoryScope("voice-profile:voice-a", "persona")
  };
}
function binding(scope: string, personId = "person-a") {
  const admitted = admitVoiceProfilePersonBinding({
    voiceProfileId: "voice-a",
    personId,
    assertor: { entityId: "local-explicit-controller", resolution: "resolved" },
    trustedController: true,
    provenanceClass: "EXTERNAL_CLAIM"
  });
  if (admitted.decision !== "admit") throw new Error();
  return { ...voiceProfileBindingWriteFields(admitted), scope };
}
describe("local explicit-controller binding evidence", () => {
  it("keeps binding authority stable across Mem0 backend changes", () => {
    const { provider } = fixture();
    const local = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      undefined,
      { controllerEvidence: provider }
    );
    expect(local.getVoiceBindingProvider()).toBe(provider);
    expect(local.getMemoryProvider()).toBeUndefined();
    const external = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      undefined,
      { kind: "mem0", mem0: { kind: "mem0" } as never, controllerEvidence: provider }
    );
    expect(external.getVoiceBindingProvider()).toBe(provider);
    expect(external.getMemoryProvider()).not.toBe(provider);
  });
  it("reads the same durable binding after enabling and disabling Mem0", async () => {
    const { root, scope } = fixture();
    const service = (enabled: boolean) =>
      new MemoryService(
        new InMemoryMemoryRepository(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          kind: enabled ? "mem0" : "legacy",
          mem0: enabled ? ({ kind: "mem0" } as never) : undefined,
          controllerEvidence: new LocalControllerEvidenceProvider(root)
        }
      );
    const written = await service(false).getVoiceBindingProvider()!.writeEvent(binding(scope));
    expect(written.status).toBe("written");
    for (const enabled of [true, false, true]) {
      expect(
        await service(enabled).getVoiceBindingProvider()!.getEvent({ id: written.eventId!, scope })
      ).toMatchObject({ id: written.eventId, claim: { subject: { entityId: "person-a" } } });
    }
  });
  it("survives reconstruction with durable IDs, private files and isolated scopes", async () => {
    const { root, provider, scope } = fixture();
    const result = await provider.writeEvent(binding(scope));
    expect(result.status).toBe("written");
    const restarted = new LocalControllerEvidenceProvider(root);
    expect(await restarted.getEvent({ id: result.eventId!, scope })).toMatchObject({
      id: result.eventId,
      claim: { subject: { entityId: "person-a" } }
    });
    expect(
      await restarted.getEvent({
        id: result.eventId!,
        scope: buildMemoryScope("voice-profile:voice-a", "other")
      })
    ).toBeNull();
    expect(statSync(join(root, "controller-evidence")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "controller-evidence/events.json")).mode & 0o777).toBe(0o600);
  });
  it("rejects general memory and forged ambient/assistant binding claims", async () => {
    const { provider, scope } = fixture();
    expect(
      (await provider.writeEvent({ kind: "fact", content: "general memory", scope })).status
    ).toBe("rejected");
    const input = binding(scope);
    input.claim!.assertor.entityId = "ambient";
    expect((await provider.writeEvent(input)).status).toBe("rejected");
    expect(await provider.retrieveRelevant()).toMatchObject({ status: "unavailable", events: [] });
    expect("writeEventIdempotent" in provider).toBe(false);
  });
  it("does not let a missing correction reference revive a removed binding", async () => {
    const { root, provider, scope } = fixture();
    const result = await provider.writeEvent(binding(scope));
    expect(
      (
        await provider.writeEvent({
          kind: "correction",
          content: "Local controller removed this voice binding.",
          scope,
          metadata: { yuviClaimSupersedes: [result.eventId] }
        })
      ).status
    ).toBe("written");
    expect(
      await new LocalControllerEvidenceProvider(root).getEvent({ id: result.eventId!, scope })
    ).toMatchObject({ metadata: { yuviMemoryStatus: "superseded" } });
    expect(
      (
        await provider.writeEvent({
          kind: "correction",
          content: "Local controller removed this voice binding.",
          scope,
          metadata: { yuviClaimSupersedes: ["missing"] }
        })
      ).status
    ).toBe("rejected");
  });
  it("fails closed on conflicting assignments even when the index omits one", async () => {
    const { provider, scope } = fixture();
    const first = await provider.writeEvent(binding(scope));
    const second = await provider.writeEvent(binding(scope, "person-b"));
    expect(await provider.getEvent({ id: first.eventId!, scope })).toBeNull();
    expect(await provider.getEvent({ id: second.eventId!, scope })).toBeNull();
    const corrected = binding(scope, "person-b");
    expect(
      (
        await provider.writeEvent({
          ...corrected,
          kind: "correction",
          metadata: { ...corrected.metadata, yuviClaimSupersedes: [first.eventId, second.eventId] }
        })
      ).status
    ).toBe("written");
    expect(await provider.getEvent({ id: first.eventId!, scope })).toMatchObject({
      metadata: { yuviMemoryStatus: "superseded" }
    });
  });
  it("rejects reads and further writes on corruption, preserving the damaged evidence", async () => {
    const { root, provider, scope } = fixture();
    const result = await provider.writeEvent(binding(scope));
    const file = join(root, "controller-evidence/events.json");
    const damaged = readFileSync(file, "utf8").replaceAll("person-a", "person-b");
    writeFileSync(file, damaged);
    await expect(provider.getEvent({ id: result.eventId!, scope })).rejects.toThrow();
    expect((await provider.writeEvent(binding(scope))).status).toBe("rejected");
    expect(readFileSync(file, "utf8")).toBe(damaged);
  });
});
