import { describe, expect, it } from "vitest";
import type { MemoryEvent } from "@companion/memory";
import { admitDurableMemoryClaim, serializeClaimMetadata } from "@companion/memory";
import {
  buildP8CurrentIdentityProjection,
  createDefaultP8IdentityAddress,
  resolveP8IdentityMention,
  type P8CurrentIdentityProjection,
  type P8IdentityMentionResolution
} from "./index.js";

const SCOPE = "scope-identity-mention";
const ADDRESS = createDefaultP8IdentityAddress("subject-identity-mention");
const PRIMARY = "user_primary";
const ZHANGSAN = "person_zhangsan";
const LISI = "person_lisi";
const YUVI = "person_yuvi";
const CURRENT_TIME = "2026-09-06T08:00:00.000Z";

let eventCounter = 0;

function identityEvent(overrides: {
  content: string;
  subject?: { entityId: string; surfaceMention?: string };
  assertor?: { entityId: string; surfaceMention?: string };
  provenanceClass?: "SELF_REPORT" | "EXTERNAL_CLAIM" | "DIRECT_OBSERVATION" | "ASSISTANT_INFERENCE";
  assertion?: {
    source: "user" | "assistant" | "system" | "mixed" | "unknown";
    verification: "verified" | "unverified" | "unknown";
  };
  metadata?: Record<string, unknown>;
  withoutClaim?: boolean;
}): MemoryEvent {
  eventCounter += 1;
  const id = `memory-identity-${eventCounter}`;
  const provenanceClass = overrides.provenanceClass ?? "SELF_REPORT";
  const claim =
    overrides.withoutClaim === true
      ? undefined
      : {
          provenanceClass,
          assertor: {
            entityId: overrides.assertor?.entityId ?? PRIMARY,
            ...(overrides.assertor?.surfaceMention === undefined
              ? {}
              : { surfaceMention: overrides.assertor.surfaceMention }),
            resolution: "resolved" as const
          },
          subject: {
            entityId: overrides.subject?.entityId ?? PRIMARY,
            ...(overrides.subject?.surfaceMention === undefined
              ? {}
              : { surfaceMention: overrides.subject.surfaceMention }),
            resolution: "resolved" as const
          }
        };
  return {
    id,
    kind: "fact",
    content: overrides.content,
    source: "mem0",
    sourceRecordId: id,
    scope: SCOPE,
    recordedAt: "2026-09-01T00:00:00.000Z",
    metadata: overrides.metadata ?? {},
    ...(overrides.assertion === undefined ? {} : { assertion: overrides.assertion }),
    ...(claim === undefined ? {} : { claim })
  };
}

function resolve(
  mention: string,
  events: readonly MemoryEvent[],
  options: {
    addressing?: boolean;
    channel?: "speech" | "typed";
    currentTime?: string;
    recentConversation?: readonly {
      messageReference: string;
      role: "user" | "assistant";
      content: string;
    }[];
    trustedAssertorEntityIds?: readonly string[];
  } = {}
): P8IdentityMentionResolution {
  return resolveP8IdentityMention({
    mention,
    address: ADDRESS,
    context: {
      scopeReference: SCOPE,
      currentTime: options.currentTime ?? CURRENT_TIME,
      ...(options.channel === undefined ? {} : { channel: options.channel }),
      ...(options.addressing === undefined ? {} : { addressing: options.addressing })
    },
    longTermEvents: events,
    ...(options.recentConversation === undefined
      ? {}
      : {
          recentConversation: options.recentConversation.map((message) => ({
            ...message,
            scopeReference: { reference: SCOPE }
          }))
        }),
    ...(options.trustedAssertorEntityIds === undefined
      ? {}
      : { trustedAssertorEntityIds: options.trustedAssertorEntityIds })
  });
}

function projection(events: readonly MemoryEvent[]): P8CurrentIdentityProjection {
  return buildP8CurrentIdentityProjection({
    address: ADDRESS,
    scopeReference: SCOPE,
    longTermEvents: events
  });
}

describe("P8 identity mention resolution: names and nicknames", () => {
  it("resolves a canonical name from trusted durable evidence", () => {
    const events = [
      identityEvent({
        content: "张三今天值班。",
        subject: { entityId: ZHANGSAN, surfaceMention: "张三" }
      })
    ];
    const resolution = resolve("张三", events, { trustedAssertorEntityIds: [PRIMARY] });
    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.entityId).toBe(ZHANGSAN);
    expect(resolution.surfaceMention).toBe("张三");
    expect(resolution.ephemeral).toBe(false);
    expect(resolution.candidates?.[0]).toMatchObject({
      basis: "name",
      tier: "TRUSTED_EXPLICIT",
      surfaceForm: "张三"
    });
  });

  it("resolves a trusted explicit nickname without rewriting any surface", () => {
    const assignment = identityEvent({
      content: "以后叫 YUVI 小鱼。",
      subject: { entityId: YUVI, surfaceMention: "小鱼" }
    });
    const resolution = resolve("小鱼", [assignment], { trustedAssertorEntityIds: [PRIMARY] });
    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.entityId).toBe(YUVI);
    expect(assignment.content).toBe("以后叫 YUVI 小鱼。");
  });

  it("keeps an unknown nickname unresolved instead of guessing", () => {
    const events = [
      identityEvent({
        content: "以后叫 YUVI 小鱼。",
        subject: { entityId: YUVI, surfaceMention: "小鱼" }
      })
    ];
    const resolution = resolve("大头", events, { trustedAssertorEntityIds: [PRIMARY] });
    expect(resolution.status).toBe("UNRESOLVED");
    expect(resolution.entityId).toBeUndefined();
    expect(resolution.unresolvedReason).toBe("no-evidence");
  });
});

describe("P8 identity mention resolution: STT variants", () => {
  const uvVariant = identityEvent({
    content: "以后也可以叫我 UV。",
    subject: { entityId: YUVI, surfaceMention: "UV" }
  });

  it("may resolve a speech variant under an addressing context", () => {
    const resolution = resolve("UV", [uvVariant], {
      addressing: true,
      channel: "speech",
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.entityId).toBe(YUVI);
    expect(resolution.surfaceMention).toBe("UV");
  });

  it("does not blindly resolve a topical latin mention into the persona", () => {
    const resolution = resolve("UV", [uvVariant], {
      addressing: false,
      channel: "speech",
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(resolution.status).toBe("UNRESOLVED");
    expect(resolution.entityId).toBeUndefined();
    expect(resolution.unresolvedReason).toBe("speech-variant-without-addressing");
  });

  it("never rewrites the raw transcript or the attested surfaces", () => {
    const before = JSON.stringify(uvVariant);
    const resolution = resolve("UV", [uvVariant], {
      addressing: true,
      channel: "speech",
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(JSON.stringify(uvVariant)).toBe(before);
    expect(resolution.surfaceMention).toBe("UV");
    expect(resolution.identityKey).toBe("uv");
  });
});

describe("P8 identity mention resolution: roles and titles", () => {
  const zhangsanMonitor = identityEvent({
    content: "张三现在是我们班班长。",
    subject: { entityId: ZHANGSAN, surfaceMention: "张三" }
  });
  const lisiHighSchoolMonitor = identityEvent({
    content: "李四是我高中班长。",
    subject: { entityId: LISI, surfaceMention: "李四" },
    metadata: { yuviIdentityValidUntil: "2021-06-30T00:00:00.000Z" }
  });

  it("resolves the current title from active scoped role evidence", () => {
    const resolution = resolve("班长", [zhangsanMonitor, lisiHighSchoolMonitor], {
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.entityId).toBe(ZHANGSAN);
    expect(resolution.candidates?.[0]?.roleTemporalState).toBe("active");
  });

  it("does not let an expired high-school role override the current role", () => {
    const current = resolve("班长", [zhangsanMonitor, lisiHighSchoolMonitor], {
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(current.entityId).toBe(ZHANGSAN);
    // The expired role stays available for explicit historical reference.
    const historical = resolve("我高中班长", [zhangsanMonitor, lisiHighSchoolMonitor], {
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(historical.status).toBe("RESOLVED");
    expect(historical.entityId).toBe(LISI);
    expect(historical.candidates?.[0]?.roleTemporalState).toBe("expired");
  });

  it("returns AMBIGUOUS for two active valid title candidates", () => {
    const dormBoss = identityEvent({
      content: "宿舍老大是张三。",
      subject: { entityId: ZHANGSAN, surfaceMention: "张三" }
    });
    const clubBoss = identityEvent({
      content: "社团老大是李四。",
      subject: { entityId: LISI, surfaceMention: "李四" }
    });
    const resolution = resolve("老大", [dormBoss, clubBoss], {
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(resolution.status).toBe("AMBIGUOUS");
    expect(resolution.entityId).toBeUndefined();
    expect(resolution.candidates?.map((candidate) => candidate.entityId)).toEqual([
      LISI,
      ZHANGSAN
    ]);
  });

  it("resolves contextual references ephemerally without persistence", () => {
    const resolution = resolve("小美", [], {
      recentConversation: [
        { messageReference: "m1", role: "user", content: "刚才发言的是小美" }
      ]
    });
    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.ephemeral).toBe(true);
    expect(resolution.entityId).toBeUndefined();
    expect(resolution.contextAnchor).toBe("recent-conversation:m1");
    const rebuilt = projection([]);
    expect(rebuilt.persons).toEqual([]);
  });
});

describe("P8 identity mention resolution: Memory/P8 boundary", () => {
  it("excludes superseded evidence before interpretation", () => {
    const original = identityEvent({
      content: "张三现在是我们班班长。",
      subject: { entityId: ZHANGSAN, surfaceMention: "张三" }
    });
    const correction = identityEvent({
      content: "现在是李四当班长。",
      subject: { entityId: LISI, surfaceMention: "李四" },
      metadata: { yuviClaimSupersedes: [original.id] }
    });
    const resolution = resolve("张三", [original, correction], {
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(resolution.status).toBe("UNRESOLVED");
    expect(resolution.unresolvedReason).toBe("no-evidence");
    const reassignment = resolve("李四", [original, correction], {
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(reassignment.status).toBe("RESOLVED");
    expect(reassignment.entityId).toBe(LISI);
  });

  it("never lets assistant inference override trusted evidence", () => {
    const trusted = identityEvent({
      content: "张三现在是我们班班长。",
      subject: { entityId: ZHANGSAN, surfaceMention: "张三" }
    });
    const assistantGuess = identityEvent({
      content: "李四现在是班长。",
      subject: { entityId: LISI, surfaceMention: "李四" },
      provenanceClass: "ASSISTANT_INFERENCE",
      assertor: { entityId: "assistant_yuvi" }
    });
    const withTrusted = resolve("班长", [trusted, assistantGuess], {
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(withTrusted.status).toBe("RESOLVED");
    expect(withTrusted.entityId).toBe(ZHANGSAN);

    const assistantOnly = resolve("班长", [assistantGuess], {
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(assistantOnly.status).toBe("UNRESOLVED");
    expect(assistantOnly.unresolvedReason).toBe("assistant-inference-only");
  });

  it("keeps third-party claims weaker than primary trusted evidence", () => {
    const thirdPartyOnly = identityEvent({
      content: "张三是班长。",
      subject: { entityId: ZHANGSAN, surfaceMention: "张三" },
      assertor: { entityId: "person_wangwu", surfaceMention: "王五" },
      provenanceClass: "EXTERNAL_CLAIM"
    });
    const alone = resolve("班长", [thirdPartyOnly], { trustedAssertorEntityIds: [PRIMARY] });
    expect(alone.status).toBe("UNRESOLVED");
    expect(alone.unresolvedReason).toBe("external-claim-only");
    expect(alone.candidates?.[0]).toMatchObject({ tier: "CANDIDATE_ONLY" });

    const primaryTrusted = identityEvent({
      content: "李四现在是班长。",
      subject: { entityId: LISI, surfaceMention: "李四" }
    });
    const mixed = resolve("班长", [thirdPartyOnly, primaryTrusted], {
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(mixed.status).toBe("RESOLVED");
    expect(mixed.entityId).toBe(LISI);
  });

  it("rebuilds the derived current identity projection from eligible evidence", () => {
    const zhangsan = identityEvent({
      content: "张三今天值班。",
      subject: { entityId: ZHANGSAN, surfaceMention: "张三" }
    });
    const supersedesZhangsan = identityEvent({
      content: "张三不再值班。",
      subject: { entityId: ZHANGSAN, surfaceMention: "张三" },
      metadata: { yuviClaimSupersedes: [zhangsan.id] }
    });
    const rebuilt = projection([zhangsan, supersedesZhangsan]);
    expect(rebuilt.projectionVersion).toBe("p8-identity.v1");
    expect(rebuilt.excludedIneligibleCount).toBe(1);
    expect(rebuilt.persons).toEqual([
      {
        entityId: ZHANGSAN,
        surfaceForms: [
          expect.objectContaining({
            surface: "张三",
            authority: "EXPLICIT_USER_ORIGINATED",
            evidenceReferences: [supersedesZhangsan.id]
          })
        ]
      }
    ]);
    expect(projection([zhangsan, supersedesZhangsan])).toEqual(rebuilt);
  });

  it("does not create Memory writes by itself and stays deterministic", () => {
    const events = [
      identityEvent({
        content: "张三今天值班。",
        subject: { entityId: ZHANGSAN, surfaceMention: "张三" }
      })
    ];
    const first = resolve("张三", events, { trustedAssertorEntityIds: [PRIMARY] });
    const second = resolve("张三", events, { trustedAssertorEntityIds: [PRIMARY] });
    expect(second).toEqual(first);
    expect(first.evidenceReferences).toEqual([events[0]!.id]);
    // Repeated resolution also never grows durable alias records.
    expect(projection(events)).toEqual(projection([...events, ...events]));
  });

  it("accepts only explicit new durable alias evidence through the existing Memory path", () => {
    // Atom 12 admission: a primary-user assignment about someone else is an
    // EXTERNAL_CLAIM with the primary as assertor; P8's trusted-assertor
    // boundary is what ranks it as the user's own explicit evidence.
    const admitted = admitDurableMemoryClaim({
      provenanceClass: "EXTERNAL_CLAIM",
      content: "以后叫我小鱼",
      rawText: "以后叫我小鱼",
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      subject: { entityId: YUVI, surfaceMention: "小鱼", resolution: "resolved" }
    });
    expect(admitted.decision).toBe("admit");
    if (admitted.decision !== "admit") return;
    const event: MemoryEvent = {
      id: "memory-explicit-alias",
      kind: "user_claim",
      content: admitted.content,
      source: "mem0",
      sourceRecordId: "explicit-alias",
      scope: SCOPE,
      metadata: serializeClaimMetadata(admitted.claim),
      assertion: admitted.assertion,
      claim: admitted.claim
    };
    const resolution = resolve("小鱼", [event], { trustedAssertorEntityIds: [PRIMARY] });
    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.entityId).toBe(YUVI);
    expect(resolution.candidates?.[0]).toMatchObject({ tier: "TRUSTED_EXPLICIT" });
    expect(event.claim?.rawText).toBe("以后叫我小鱼");

    // The same claim from a non-trusted assertor stays unverified hearsay.
    const hearsay = resolve("小鱼", [event], { trustedAssertorEntityIds: ["someone_else"] });
    expect(hearsay.status).toBe("UNRESOLVED");
    expect(hearsay.unresolvedReason).toBe("external-claim-only");
  });

  it("feeds Atom 12 resolved identities and is rejected when unresolved", () => {
    const trusted = identityEvent({
      content: "张三今天值班。",
      subject: { entityId: ZHANGSAN, surfaceMention: "张三" }
    });
    const resolution = resolve("张三", [trusted], { trustedAssertorEntityIds: [PRIMARY] });
    expect(resolution.status).toBe("RESOLVED");
    expect(
      admitDurableMemoryClaim({
        provenanceClass: "SELF_REPORT",
        content: "张三今天值班。",
        assertor: { entityId: resolution.entityId!, resolution: "resolved" },
        subject: { entityId: resolution.entityId!, resolution: "resolved" }
      }).decision
    ).toBe("admit");

    const unresolved = resolve("大头", [], { trustedAssertorEntityIds: [PRIMARY] });
    expect(unresolved.status).toBe("UNRESOLVED");
    expect(
      admitDurableMemoryClaim({
        provenanceClass: "SELF_REPORT",
        content: "大头今天值班。",
        assertor: { surfaceMention: "大头", resolution: "unresolved" },
        subject: { surfaceMention: "大头", resolution: "unresolved" }
      })
    ).toEqual({ decision: "reject", reason: "unresolved-identity" });
  });
});

describe("P8 identity mention resolution: voice boundary", () => {
  it("never resolves a person from speakerId", () => {
    const event = identityEvent({
      content: "有人正在说话。",
      withoutClaim: true,
      metadata: { speakerId: "spk_1" }
    });
    const resolution = resolve("spk_1", [event]);
    expect(resolution.status).toBe("UNRESOLVED");
    expect(resolution.unresolvedReason).toBe("no-evidence");
    expect(projection([event]).persons).toEqual([]);
  });

  it("never resolves a person from voiceProfileId", () => {
    const event = identityEvent({
      content: "有人正在说话。",
      withoutClaim: true,
      metadata: { voiceProfileId: "vp_1" }
    });
    const resolution = resolve("vp_1", [event]);
    expect(resolution.status).toBe("UNRESOLVED");
    expect(projection([event]).persons).toEqual([]);
  });

  it("never resolves a person from speakerClusterId", () => {
    const event = identityEvent({
      content: "有人正在说话。",
      withoutClaim: true,
      metadata: { speakerClusterId: "sc_1" }
    });
    const resolution = resolve("sc_1", [event]);
    expect(resolution.status).toBe("UNRESOLVED");
    expect(projection([event]).persons).toEqual([]);
  });
});
