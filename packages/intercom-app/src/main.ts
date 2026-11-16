import type { CaptureResult } from "@overturn-ai/shared";
import {
  type CanvasPayload,
  COMPONENT,
  clickedOrigin,
  failedCanvas,
  idleCanvas,
  namingCanvas,
  notWatchingCanvas,
  type ReadyCanvasInput,
  readCanvasState,
  readyCanvas,
  reasonCodeFromClick,
} from "./canvas";
import {
  type AppSettings,
  aiSignals,
  type CanvasRequest,
  type DraftEvidence,
  type DraftState,
  decideOnCapture,
  draftFromRun,
  draftFromTeammate,
  fieldsFrom,
  type IntercomConversation,
  inScope,
  isDraftSized,
  newestReply,
  type PendingSend,
  pickRecordedDraft,
  settingsFrom,
} from "./capture";

/** The small slice of the host this app needs, so the same code runs in a worker or in tests. */
export interface Runtime {
  settings: AppSettings;
  fetchImpl: typeof fetch;
  now: () => number;
}

export function runtimeFrom(
  config: Record<string, unknown>,
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Runtime {
  return {
    settings: settingsFrom(config),
    fetchImpl: opts.fetchImpl ?? fetch,
    now: opts.now ?? (() => Date.now()),
  };
}

function authHeaders(settings: AppSettings): Record<string, string> {
  return settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {};
}

/** Canvas Kit sends the conversation, but never promises the parts are in it. */
function hasParts(conversation: IntercomConversation): boolean {
  return (conversation.conversation_parts?.conversation_parts?.length ?? 0) > 0;
}

/**
 * The conversation the app reasons about. The request's own object is used as-is; a partial
 * conversation is only read back from the Intercom API when a draft is already known or the
 * teammate is naming one — never for a conversation nothing has been drafted in, which issue #21
 * keeps out of scope.
 */
export async function conversationFor(
  req: CanvasRequest,
  runtime: Runtime,
  opts: { readFull: boolean },
): Promise<IntercomConversation | null> {
  const conversation = req.conversation ?? null;
  if (!conversation?.id || hasParts(conversation) || !opts.readFull) return conversation;
  const { settings } = runtime;
  if (!settings.intercomToken) return conversation;
  try {
    const res = await runtime.fetchImpl(
      `${settings.intercomApiBase}/conversations/${encodeURIComponent(String(conversation.id))}?display_as=plaintext`,
      {
        headers: {
          authorization: `Bearer ${settings.intercomToken}`,
          accept: "application/json",
          "intercom-version": "2.18",
        },
      },
    );
    if (!res.ok) return conversation;
    const full = (await res.json()) as IntercomConversation;
    return full?.id ? full : conversation;
  } catch {
    return conversation;
  }
}

/** A drafting agent that recorded its run with the SDK: the draft is its output. */
async function findRecordedDraft(
  conversation: IntercomConversation,
  runtime: Runtime,
): Promise<DraftState | null> {
  const { settings } = runtime;
  if (!settings.apiKey) return null;
  try {
    // A handful, because the newest run on this conversation may be one of our own captures.
    const url = `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`ic:${conversation.id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=10`;
    const res = await runtime.fetchImpl(url, { headers: authHeaders(settings) });
    if (!res.ok) return null;
    const page = (await res.json()) as { items?: unknown };
    const run = pickRecordedDraft(page.items);
    if (!run) return null;
    return draftFromRun(run, runtime.now(), fieldsFrom(conversation, settings));
  } catch {
    // No recorded draft; the teammate names the one in the composer instead.
    return null;
  }
}

async function postCapture(runtime: Runtime, body: unknown): Promise<CaptureResult> {
  const res = await runtime.fetchImpl(`${runtime.settings.baseUrl}/v1/capture`, {
    method: "POST",
    headers: { ...authHeaders(runtime.settings), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = new Error(`capture ${res.status}`) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return (await res.json()) as CaptureResult;
}

/**
 * What went out. A reply Intercom shows is used only when it landed after the draft appeared —
 * an older reply went out before this draft and is context, not the send. Text the teammate typed
 * in the panel is taken, but it is their word rather than a verified send, so it is marked as
 * such in the payload. A note stays a note; the decision refuses it when notes are off.
 */
export function pendingSend(
  conversation: IntercomConversation,
  draft: DraftState | null,
  typed: string,
  actor: string | null,
): PendingSend | null {
  const text = typed.trim();
  const reply = newestReply(conversation, { sinceMs: draft?.at ?? null, actor });
  if (text) {
    // Prefilled by us from the thread, edited by the teammate: still a reply Intercom shows.
    if (reply?.afterDraft && text === reply.text) {
      return {
        text,
        type: reply.type,
        at: reply.at,
        basis: "thread",
        partId: reply.id,
        author: reply.author,
      };
    }
    return { text, type: reply?.type ?? "publicReply", at: null, basis: "typed", unverified: true };
  }
  if (reply?.afterDraft) {
    return {
      text: reply.text,
      type: reply.type,
      at: reply.at,
      basis: "thread",
      partId: reply.id,
      author: reply.author,
    };
  }
  return null;
}

function readyBase(
  conversation: IntercomConversation,
  draft: DraftState,
  settings: AppSettings,
  state: { sentText: string; reasonCode: string | null; note: string },
  actor: string | null,
): ReadyCanvasInput {
  const reply = newestReply(conversation, { sinceMs: draft.at, actor });
  return {
    draft,
    settings,
    conversation,
    sentText: state.sentText.trim() || (reply?.afterDraft ? reply.text : ""),
    reasonCode: state.reasonCode,
    note: state.note,
    signals: aiSignals(conversation),
    ...(reply && !reply.afterDraft ? { staleReply: reply } : {}),
  };
}

/**
 * One Canvas Kit webhook for both flows: Initialize (no `component_id`) draws the canvas, and
 * Submit (a click, with `current_canvas`, `input_values` and `component_id`) answers it.
 *
 * Nothing here can stop Intercom from sending a reply, so `require_reason` holds the *capture*
 * back — visibly, in the canvas — and a failure to record is reported in the panel. The send
 * itself is never touched.
 */
export async function handleCanvasRequest(req: CanvasRequest, runtime: Runtime): Promise<CanvasPayload> {
  const { settings } = runtime;
  const state = readCanvasState(req);
  const clicked = state.clicked;
  const actor = req.admin?.email?.trim() || req.admin?.name?.trim() || null;
  /**
   * Nothing is read from Intercom until a draft is known or the teammate is naming, timing or
   * capturing one: issue #21 keeps a conversation with no draft in it out of scope.
   */
  const needsThread =
    !!state.draft ||
    clickedOrigin(clicked) !== null ||
    reasonCodeFromClick(clicked) !== null ||
    clicked === COMPONENT.save;
  const shallow = req.conversation ?? null;
  if (!shallow?.id) return idleCanvas(null);
  if (!inScope(shallow, settings)) return notWatchingCanvas(settings.scopeTag);

  // A recorded run is found by conversation id alone, so the panel can say Draft inserted before
  // anything else about the conversation is read.
  const recorded = !state.draft && clicked === "" ? await findRecordedDraft(shallow, runtime) : null;
  const conversation = await conversationFor(req, runtime, { readFull: needsThread || !!recorded });
  if (!conversation?.id) return idleCanvas(null);

  if (clicked === COMPONENT.nameDraft) return namingCanvas(state.draftText);
  if (clicked === COMPONENT.reset || clicked === COMPONENT.startOver) return idleCanvas(null);

  const told = clickedOrigin(clicked);
  if (told) {
    const named = state.draftText.trim() || state.draft?.text || "";
    if (!isDraftSized(named, settings)) {
      return namingCanvas(
        state.draftText,
        `A draft this short is not worth a case: paste at least ${settings.minDraftChars} characters.`,
      );
    }
    // Intercom's own flag upgrades "an assist wrote it" to a fact we were told, never the reverse.
    const evidence: DraftEvidence =
      told.evidence === "assist" && aiSignals(conversation).answerGenerated ? "fin" : told.evidence;
    const draft = draftFromTeammate(
      named,
      told.origin,
      evidence,
      runtime.now(),
      fieldsFrom(conversation, settings),
    );
    return readyCanvas(readyBase(conversation, draft, settings, { ...state, reasonCode: null }, actor));
  }

  const chip = reasonCodeFromClick(clicked);
  if (chip && state.draft) {
    return readyCanvas(readyBase(conversation, state.draft, settings, { ...state, reasonCode: chip }, actor));
  }

  if (clicked === COMPONENT.save) {
    const draft = state.draft;
    if (!draft) return idleCanvas(null, aiSignals(conversation));
    const base = readyBase(conversation, draft, settings, state, actor);
    const decision = decideOnCapture({
      conversation,
      draft,
      sent: pendingSend(conversation, draft, state.sentText, actor),
      reasonCode: state.reasonCode,
      reason: state.note,
      actor,
      workspaceId: req.workspace_id ?? null,
      settings,
      now: runtime.now(),
    });
    if (decision.action === "skip") {
      if (decision.why === "note") {
        return failedCanvas(
          "The newest thing here is an internal note; notes are only recorded with capture_notes on.",
          base,
        );
      }
      return failedCanvas(
        "No reply after this draft to compare against yet. Paste what you sent, and it is recorded as confirmed by you.",
        base,
      );
    }
    if (decision.action === "need-reason") {
      return failedCanvas(
        "Pick why you changed it (one click) — nothing is recorded without a reason.",
        base,
      );
    }
    try {
      const result = await postCapture(runtime, decision.body);
      return readyCanvas({
        ...base,
        last: {
          changed: result.changed,
          dedup: result.deduplicated,
          unverified: decision.body.metadata?.sentBasis === "typed",
        },
        caseTitle: result.case?.title ?? null,
      });
    } catch (error) {
      // Never hide a failure, and never lose what the teammate typed: hand the canvas straight back.
      const status = (error as { status?: number }).status ?? "network";
      return failedCanvas(
        `Overturn could not save this correction (${status}). Your reply is untouched.`,
        base,
      );
    }
  }

  // Initialize, or a click we do not know: the draft a run recorded, else ask for the one in the composer.
  const liveDraft = state.draft ?? recorded;
  if (liveDraft) return readyCanvas(readyBase(conversation, liveDraft, settings, state, actor));
  return idleCanvas(null, aiSignals(conversation));
}
