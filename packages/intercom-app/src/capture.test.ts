import { describe, expect, it } from "vitest";
import {
  type AppSettings,
  contextFrom,
  conversationUrl,
  DEFAULT_SETTINGS,
  decideOnCapture,
  draftFromRun,
  draftFromTeammate,
  draftTag,
  fieldsFrom,
  type IntercomConversation,
  inScope,
  isCaptureRun,
  isDraftSized,
  newestReply,
  originLine,
  type PendingSend,
  pickRecordedDraft,
  quickReasons,
  sentFrom,
  settingsFrom,
  statusLine,
  storeDraft,
  storedDraft,
  stripHtml,
} from "./capture";

/** A conversation shaped like `GET /conversations/{id}`, the parts oldest first. */
const conversation: IntercomConversation = {
  id: "21547896",
  title: "Where is my refund?",
  source: {
    subject: "Where is my refund?",
    body: "<p>I was charged twice for order 8841.&nbsp;Can you refund the duplicate?</p>",
    author: { type: "user", id: "5f1", email: "dana@example.com", name: "Dana" },
  },
  conversation_parts: {
    conversation_parts: [
      {
        id: "p1",
        part_type: "comment",
        body: "<p>Thanks for flagging it �?I am checking now.</p>",
        author: { type: "admin", email: "ray@carrier.com" },
        created_at: 1_761_900_000,
      },
      {
        id: "p2",
        part_type: "note",
        body: "Duplicate charge confirmed in Stripe.",
        author: { type: "admin", email: "ray@carrier.com" },
        created_at: 1_761_900_060,
      },
      {
        id: "p3",
        part_type: "comment",
        body: "<p>The duplicate is refunded and lands within 5 business days.</p>",
        author: { type: "admin", email: "ray@carrier.com" },
        created_at: 1_761_900_120,
      },
      { id: "p4", part_type: "comment", body: "", author: { type: "admin" }, created_at: 1_761_900_180 },
      { id: "p5", part_type: "comment", body: "<p>gone</p>", redacted: true, created_at: 1_761_900_240 },
    ],
  },
  tags: { tags: [{ name: "billing" }, { name: "ai_drafted" }] },
  contacts: [{ id: "5f1", email: "dana@example.com", name: "Dana" }],
  custom_attributes: { order_status: "refunded" },
};

const draftText =
  "Hi Dana, the duplicate charge is refunded and should land in 5 business days. Sorry for the trouble.";
const sentText = "Hi Dana, the duplicate charge is refunded and lands in 2 business days.";

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_SETTINGS,
  apiKey: "ov_live_test",
  ...over,
});

const aiDraft = draftFromTeammate(draftText, "ai", "assist", 1_761_900_000_000);

/** A send that came from the thread, so a test that is not about provenance does not have to say so. */
const send = (
  text: string,
  type: PendingSend["type"] = "publicReply",
  at: string | null = null,
): PendingSend => ({ text, type, at, basis: "thread", partId: "p3", author: "ray@carrier.com" });

describe("settings", () => {
  it("parses the install config", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      overturn_api_key: "ov_live_x",
      agent: "billing-reply",
      reason_pack: "claims",
      require_reason: "false",
      capture_notes: "true",
      min_draft_chars: "120",
      max_context_parts: "10",
      scope_tag: "ai_drafted",
      decision_fields: "order_status:status, refund_reason",
      intercom_token: "dG9r",
      intercom_api_base: "https://api.eu.intercom.io/",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.apiKey).toBe("ov_live_x");
    expect(s.agent).toBe("billing-reply");
    expect(s.reasonPack).toBe("claims");
    expect(s.requireReason).toBe(false);
    expect(s.captureNotes).toBe(true);
    expect(s.minDraftChars).toBe(120);
    expect(s.maxContextParts).toBe(10);
    expect(s.scopeTag).toBe("ai_drafted");
    expect(s.decisionFields).toEqual([
      { id: "order_status", label: "status" },
      { id: "refund_reason", label: "refund_reason" },
    ]);
    expect(s.intercomToken).toBe("dG9r");
    expect(s.intercomApiBase).toBe("https://api.eu.intercom.io");
  });

  it("falls back to the support pack, a required reason and the public API", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.reasonPack).toBe("support");
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    expect(settingsFrom({ reason_pack: "garbage" }).reasonPack).toBe("support");
    expect(settingsFrom({ min_draft_chars: "0" }).minDraftChars).toBe(DEFAULT_SETTINGS.minDraftChars);
  });

  it("reason_pack picks the chips: support by default, claims when a claims team opts in", () => {
    const support = quickReasons(settings()).map((r) => r.code);
    expect(support).toContain("wrong_answer");
    expect(support).toContain("should_escalate");
    expect(support).not.toContain("reserve_too_low");
    const claims = quickReasons(settings({ reasonPack: "claims" })).map((r) => r.code);
    expect(claims).toContain("wrong_coverage_decision");
    // both packs keep tone/wording, so the suite exclusion applies to either
    expect(claims).toContain("tone_wording");
    expect(support).toContain("tone_wording");
  });

  it("a scope tag limits which conversations are watched at all", () => {
    expect(inScope(conversation, settings())).toBe(true);
    expect(inScope(conversation, settings({ scopeTag: "ai_drafted" }))).toBe(true);
    expect(inScope(conversation, settings({ scopeTag: "vip" }))).toBe(false);
  });
});

describe("the thread", () => {
  it("strips html the way a reader sees it", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
  });

  it("maps the conversation to capture context, oldest first, skipping redacted and empty parts", () => {
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "I was charged twice for order 8841. Can you refund the duplicate?",
        at: null,
      },
      {
        role: "agent",
        author: "ray@carrier.com",
        content: "Thanks for flagging it �?I am checking now.",
        at: "2025-10-31T08:40:00.000Z",
      },
      {
        role: "note",
        author: "ray@carrier.com",
        content: "Duplicate charge confirmed in Stripe.",
        at: "2025-10-31T08:41:00.000Z",
      },
      {
        role: "agent",
        author: "ray@carrier.com",
        content: "The duplicate is refunded and lands within 5 business days.",
        at: "2025-10-31T08:42:00.000Z",
      },
    ]);
  });

  it("keeps the end of a long thread, which is what the decision is about", () => {
    const many: IntercomConversation = {
      ...conversation,
      conversation_parts: {
        conversation_parts: Array.from({ length: 12 }, (_, i) => ({
          id: `p${i}`,
          part_type: "comment",
          body: `message ${i}`,
          author: { type: i % 2 ? "admin" : "user" },
          created_at: 1_761_900_000 + i * 60,
        })),
      },
    };
    const ctx = contextFrom(many, { maxContextParts: 3 });
    expect(ctx).toHaveLength(3);
    expect(ctx.map((m) => m.content)).toEqual(["message 9", "message 10", "message 11"]);
  });

  it("never guesses a role it was not told", () => {
    const odd: IntercomConversation = {
      ...conversation,
      source: { body: "hello", author: { type: "some_new_thing" } },
      conversation_parts: {
        conversation_parts: [{ id: "x", part_type: "comment", body: "hm", author: null, created_at: 1 }],
      },
    };
    expect(contextFrom(odd).map((m) => m.role)).toEqual(["system", "system"]);
  });

  it("what the thread shows is read with its part, its author and whether it landed after the draft", () => {
    expect(sentFrom(conversation)).toEqual({
      id: "p3",
      text: "The duplicate is refunded and lands within 5 business days.",
      type: "publicReply",
      at: "2025-10-31T08:42:00.000Z",
      atMs: Date.parse("2025-10-31T08:42:00.000Z"),
      author: "ray@carrier.com",
      afterDraft: true,
      byActor: false,
    });
    expect(newestReply(conversation, { actor: "ray@carrier.com" })?.byActor).toBe(true);
    expect(newestReply(conversation, { sinceMs: 1_761_900_200_000 })?.afterDraft).toBe(false);
    expect(newestReply(conversation, { sinceMs: 1_761_900_000_000 })?.afterDraft).toBe(true);
    const noteLast: IntercomConversation = {
      ...conversation,
      conversation_parts: {
        conversation_parts: [
          ...(conversation.conversation_parts?.conversation_parts ?? []),
          {
            id: "p6",
            part_type: "note",
            body: "internal: refunded twice by mistake",
            created_at: 1_761_900_300,
          },
        ],
      },
    };
    expect(sentFrom(noteLast)?.type).toBe("note");
    expect(sentFrom({ id: "1" })).toBeNull();
  });

  it("reads the decision fields an admin named, and only those", () => {
    expect(fieldsFrom(conversation, { decisionFields: [] })).toEqual({});
    expect(
      fieldsFrom(conversation, {
        decisionFields: [
          { id: "order_status", label: "status" },
          { id: "nope", label: "nope" },
        ],
      }),
    ).toEqual({ status: "refunded", nope: null });
    expect(fieldsFrom({ id: "1" }, { decisionFields: [{ id: "order_status", label: "status" }] })).toEqual({
      status: null,
    });
  });

  it("links back to the conversation only when Intercom told us the workspace", () => {
    expect(conversationUrl(conversation, "abcd123")).toBe(
      "https://app.intercom.com/a/inbox/abcd123/inbox/conversation/21547896",
    );
    expect(conversationUrl(conversation, null)).toBeNull();
    expect(conversationUrl(conversation, undefined)).toBeNull();
  });
});

describe("draft origin", () => {
  it("tags only what it was told: ai, manual, or unknown �?never a guess", () => {
    expect(draftTag(draftFromTeammate(draftText, "ai", "assist").origin)).toBe("draft:ai");
    expect(draftTag(draftFromTeammate(draftText, "manual", "typed").origin)).toBe("draft:manual");
    expect(draftTag(draftFromTeammate(draftText, "unknown", "not-stated").origin)).toBe("draft:unknown");
  });

  it("an assist that recorded its run with the SDK is ai, timed from the run itself", () => {
    const d = draftFromRun(
      {
        id: "0199a0d0-0000-7000-8000-000000000000",
        output: draftText,
        model: "gpt-4.1-mini",
        startedAt: "2025-10-31T08:40:00.000Z",
      },
      5,
    );
    expect(d).toMatchObject({
      origin: "ai",
      evidence: "recorded",
      at: Date.parse("2025-10-31T08:40:00.000Z"),
      runId: "0199a0d0-0000-7000-8000-000000000000",
      model: "gpt-4.1-mini",
    });
    // No timestamp on the run: the moment we read it is all we have.
    expect(draftFromRun({ id: "r", output: draftText }, 5).at).toBe(5);
  });

  it("a run a capture synthesized is never read back as a drafting agent's draft", () => {
    expect(isCaptureRun({ id: "r", metadata: { capture: "intercom" } })).toBe(true);
    expect(isCaptureRun({ id: "r", tags: ["capture:zendesk", "draft:ai"] })).toBe(true);
    expect(isCaptureRun({ id: "r", tags: ["draft:recorded"], metadata: { env: "prod" } })).toBe(false);
    const items = [
      {
        id: "captured-run",
        output: draftText,
        metadata: { capture: "intercom" },
        tags: ["capture:intercom"],
      },
      { id: "agent-run", output: draftText, model: "gpt-4.1-mini", startedAt: "2025-10-31T08:40:00.000Z" },
    ];
    expect(pickRecordedDraft(items)).toMatchObject({ id: "agent-run", model: "gpt-4.1-mini" });
    expect(pickRecordedDraft([items[0]])).toBeNull();
    expect(pickRecordedDraft([{ id: "x", output: "  " }])).toBeNull();
    expect(pickRecordedDraft("nonsense")).toBeNull();
  });

  it("says out loud why the tag is what it is", () => {
    expect(originLine(draftFromTeammate(draftText, "unknown", "not-stated"))).toContain("draft:unknown");
    expect(originLine(draftFromTeammate(draftText, "manual", "typed"))).toContain("draft:manual");
    expect(originLine({ ...aiDraft, evidence: "assist" })).toContain("draft:ai");
    expect(originLine(null)).toBeNull();
  });

  it("only a reply-sized text counts as a draft", () => {
    expect(isDraftSized(draftText, DEFAULT_SETTINGS)).toBe(true);
    expect(isDraftSized("Hi Dana,", DEFAULT_SETTINGS)).toBe(false);
    expect(isDraftSized("x".repeat(80), DEFAULT_SETTINGS)).toBe(true);
  });

  it("round-trips the draft through the canvas, and drops a value it cannot trust", () => {
    expect(storedDraft({ stored_data: storeDraft(aiDraft) })).toEqual(aiDraft);
    expect(storedDraft({ stored_data: { overturn_draft: "{not json" } })).toBeNull();
    expect(storedDraft({ stored_data: { overturn_draft: JSON.stringify({ text: "  " }) } })).toBeNull();
    expect(
      storedDraft({ stored_data: { overturn_draft: JSON.stringify({ text: draftText, origin: "fin" }) } }),
    ).toMatchObject({
      origin: "unknown",
      evidence: "not-stated",
    });
    expect(storedDraft(null)).toBeNull();
  });
});

describe("decideOnCapture", () => {
  const base = {
    conversation,
    draft: aiDraft,
    sent: send(draftText, "publicReply", "2025-10-31T11:22:00.000Z"),
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@carrier.com",
    workspaceId: "abcd123",
    settings: settings({ requireReason: false }),
  };
  it("skips without a draft, without a reply, on notes, and out of scope", () => {
    expect(decideOnCapture({ ...base, draft: null })).toEqual({ action: "skip", why: "no-draft" });
    expect(decideOnCapture({ ...base, sent: null })).toEqual({ action: "skip", why: "empty" });
    expect(decideOnCapture({ ...base, sent: send("<p></p>") })).toEqual({
      action: "skip",
      why: "empty",
    });
    expect(decideOnCapture({ ...base, sent: send(sentText, "note") })).toEqual({
      action: "skip",
      why: "note",
    });
    expect(decideOnCapture({ ...base, settings: settings({ scopeTag: "vip" }) })).toEqual({
      action: "skip",
      why: "out-of-scope",
    });
    expect(
      decideOnCapture({
        ...base,
        sent: send(sentText, "note"),
        settings: settings({ captureNotes: true, requireReason: false }),
      }).action,
    ).toBe("capture");
  });

  it("sending the draft unchanged is an approve capture", () => {
    const d = decideOnCapture(base);
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("intercom");
    expect(d.body.externalId).toBe("ic:21547896");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.actor).toBe("ray@carrier.com");
    expect(d.body.subject).toBe("Where is my refund?");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.draft.fields).toBeUndefined();
    expect(d.body.tags).toEqual(["draft:ai", "public-reply"]);
    expect(d.body.reasonCode).toBeNull();
    expect(d.body.url).toBe("https://app.intercom.com/a/inbox/abcd123/inbox/conversation/21547896");
    expect(d.body.context).toHaveLength(4);
    expect(d.body.metadata).toMatchObject({
      workspace: "abcd123",
      requester: "dana@example.com",
      draftEvidence: "assist",
      sentBasis: "thread",
      sentPartId: "p3",
      sentAuthor: "ray@carrier.com",
      sentAt: "2025-10-31T11:22:00.000Z",
    });
  });

  it("marks a send the teammate typed rather than leaving it looking verified", () => {
    const d = decideOnCapture({
      ...base,
      sent: { text: sentText, type: "publicReply", basis: "typed", unverified: true },
      now: aiDraft.at,
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.metadata).toMatchObject({ sentBasis: "typed", sentUnverified: true, sentPartId: null });
    // Nothing in the thread dates the send, so the recording moment is the only clock there is.
    expect(d.body.secondsToSend).toBe(0);
  });

  it("times the send from the reply's own stamp, not from the recording", () => {
    const d = decideOnCapture({
      ...base,
      draft: { ...aiDraft, at: 10_000 },
      sent: {
        text: sentText,
        type: "publicReply",
        at: new Date(14_250).toISOString(),
        basis: "thread",
        partId: "p9",
      },
      now: 900_000,
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(4.3);
  });

  it("a changed reply is an edit capture carrying the reason", () => {
    const d = decideOnCapture({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Refunds settle in 2 days here",
      sent: send(sentText),
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual([]);
    expect(d.body.reason).toBe("Refunds settle in 2 days here");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("2 business days");
    // An unchanged send cannot carry a reason code: nothing was changed, nothing to score.
    const same = decideOnCapture({ ...base, reasonCode: "wrong_answer" });
    if (same.action !== "capture") throw new Error(same.action);
    expect(same.body.reasonCode).toBeNull();
  });

  it("require_reason (the default) holds a changed capture until a code is picked; a note alone is not enough", () => {
    const strict = settings({ requireReason: true });
    const changed = send(sentText);
    expect(decideOnCapture({ ...base, settings: strict, sent: changed })).toEqual({
      action: "need-reason",
      changedFields: [],
    });
    expect(decideOnCapture({ ...base, settings: strict, sent: changed, reason: "exclusion" }).action).toBe(
      "need-reason",
    );
    const ok = decideOnCapture({ ...base, settings: strict, sent: changed, reasonCode: "wrong_answer" });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") expect(ok.body.reasonCode).toBe("wrong_answer");
    // Sending it as drafted never needs a reason.
    expect(decideOnCapture({ ...base, settings: strict }).action).toBe("capture");
  });

  it("decision fields ride along and a changed field is a change", () => {
    const withFields = settings({
      requireReason: false,
      decisionFields: [{ id: "order_status", label: "status" }],
    });
    // The draft read the fields when it appeared; the conversation says what was decided at send time.
    const decided: IntercomConversation = {
      ...conversation,
      custom_attributes: { order_status: "escalated" },
    };
    const d = decideOnCapture({
      ...base,
      conversation: decided,
      settings: withFields,
      draft: { ...aiDraft, fields: { status: "refunded" } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.draft.fields).toEqual({ status: "refunded" });
    expect(d.body.sent.fields).toEqual({ status: "escalated" });
  });

  it("records how long the draft sat in front of the teammate when nothing was sent yet", () => {
    const d = decideOnCapture({
      ...base,
      draft: { ...aiDraft, at: 10_000 },
      sent: { text: sentText, type: "publicReply", basis: "typed", unverified: true },
      now: 14_250,
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(4.3);
  });

  it("a recorded draft attaches to its run", () => {
    const d = decideOnCapture({
      ...base,
      draft: draftFromRun(
        { id: "0199a0d0-0000-7000-8000-000000000000", output: draftText, model: "gpt-4.1-mini" },
        1,
      ),
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
    expect(d.body.tags?.[0]).toBe("draft:ai");
  });

  it("a hand-typed draft is tagged manual, and an unstated one unknown", () => {
    const manual = decideOnCapture({ ...base, draft: draftFromTeammate(draftText, "manual", "typed") });
    if (manual.action !== "capture") throw new Error(manual.action);
    expect(manual.body.tags).toEqual(["draft:manual", "public-reply"]);
    const unknown = decideOnCapture({
      ...base,
      draft: draftFromTeammate(draftText, "unknown", "not-stated"),
    });
    if (unknown.action !== "capture") throw new Error(unknown.action);
    expect(unknown.body.tags).toEqual(["draft:unknown", "public-reply"]);
    expect(unknown.body.draftModel).toBeNull();
  });

  it("a note that is recorded is tagged as one", () => {
    const d = decideOnCapture({
      ...base,
      settings: settings({ captureNotes: true, requireReason: false }),
      sent: send(sentText, "note"),
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.tags).toEqual(["draft:ai", "internal-note"]);
  });

  it("trims, and never sends an untrimmed or html-laden answer", () => {
    const d = decideOnCapture({
      ...base,
      draft: draftFromTeammate(`  <p>${draftText}</p>  `, "manual", "typed"),
      sent: send(`<p>${sentText}</p>`),
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draft.text).toBe(draftText);
    expect(d.body.sent.text).toBe(sentText);
    expect(d.body.sent.text).not.toContain("<p>");
  });
});

describe("statusLine", () => {
  it("says exactly what the teammate needs to see", () => {
    expect(statusLine(null, null)).toBe("Waiting for the draft");
    expect(statusLine({ ...aiDraft, text: "one two three" }, null)).toBe("Draft inserted · 3 words");
    expect(statusLine(draftFromTeammate("one two three", "manual", "typed"), null)).toBe(
      "Draft typed by you · 3 words",
    );
    expect(statusLine(draftFromTeammate("one two three", "unknown", "not-stated"), null)).toBe(
      "Draft · 3 words · origin not stated",
    );
    expect(statusLine(null, { changed: false, dedup: false })).toBe("Sent as drafted · approved");
    expect(statusLine(null, { changed: true, dedup: false })).toBe("Captured · edit saved as a case");
    expect(statusLine(null, { changed: true, dedup: true })).toBe("Captured · already in the suite");
  });
});
