import Front, { HttpVerbsEnum } from "@frontapp/plugin-sdk";
import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  apiKeyInParams,
  type DraftOrigin,
  draftTag,
  draftTagBasis,
  quickReasons,
  settingsFrom,
} from "./capture";
import { type CapturePost, createWatcher, POLL_INTERVAL_MS } from "./watch";

/** A capture Overturn refused, carrying the status the panel shows. */
class CaptureError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

/**
 * Sends the capture through Front's relay. The plugin page is public — a key in its URL lands in
 * browser history, `Referer` headers and proxy logs — so the credential lives with the endpoint:
 * `overturn_base_url` points at your own proxy (see the README) or at an Overturn endpoint that
 * takes the workspace's key server-side. Nothing here holds a key.
 */
function captureClient(settings: AppSettings): CapturePost {
  const url = `${settings.baseUrl}/v1/capture`;
  return async (body: CaptureCreate): Promise<CaptureResult> => {
    const response = await Front.relayHttp({
      verb: HttpVerbsEnum.POST,
      url,
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (response.status >= 300) throw new CaptureError(`relay ${response.status}`, response.status);
    return response.body as CaptureResult;
  };
}

/** The Front instance the plugin is framed by, for the link back from a case. */
function frontOrigin(): string | null {
  const ancestor = location.ancestorOrigins?.[0];
  if (ancestor) return ancestor;
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  const params = new URLSearchParams(location.search);
  const paramObject = Object.fromEntries(params.entries());
  const settings = settingsFrom(paramObject);
  const debug = params.get("debug") === "true";
  if (apiKeyInParams(paramObject)) {
    console.warn(
      "overturn: the plugin no longer reads an API key from its URL — a key there ends up in browser " +
        "history, Referer headers and logs. Remove `overturn_api_key` and point `overturn_base_url` at " +
        "your own proxy, which holds the key server-side (see the README).",
    );
  }

  const watcher = createWatcher({
    post: captureClient(settings),
    settings,
    origin: frontOrigin(),
  });

  const status = el("div", { class: "status" }, "Connecting to Front…");
  // One click picks the reason (what the scorecard counts); the note is optional detail.
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const note = el("textarea", { class: "reason", rows: "2", placeholder: "Anything else? Optional." });
  // Who wrote the draft is the teammate's word, never ours: the detector only sees text move.
  const mark = el("button", { type: "button", class: "link" }, "This text is the draft and I wrote it");
  const markAi = el("button", { type: "button", class: "link" }, "This text is the draft, an AI wrote it");
  const origin = el(
    "div",
    { class: "origin" },
    "A draft that appears here is tagged draft:unknown unless you say who wrote it.",
  );
  const detail = el("div", { class: "detail" }, "");
  const debugLine = el("pre", { class: "debug" }, "");
  root.append(status, origin, quick, note, mark, markAi, detail);
  if (debug) root.append(debugLine);

  let picked: string | null = null;
  const chips: HTMLButtonElement[] = [];
  /** The reason went out with the capture; the next reply starts clean. */
  const clearReason = (): void => {
    picked = null;
    note.value = "";
    for (const chip of chips) chip.classList.remove("on");
  };
  const pick = async (code: string): Promise<void> => {
    picked = picked === code ? null : code;
    for (const chip of chips) chip.classList.toggle("on", chip.dataset.code === picked);
    if (await watcher.pickReason(picked, note.value)) clearReason();
    render();
  };
  for (const reason of quickReasons(settings)) {
    const chip = el("button", { type: "button", class: "chip", "data-code": reason.code }, reason.label);
    chip.addEventListener("click", () => void pick(reason.code));
    chips.push(chip);
    quick.appendChild(chip);
  }
  mark.addEventListener("click", () => void watcher.markDraft("manual").then(render));
  markAi.addEventListener("click", () => void watcher.markDraft("assist").then(render));

  const render = (): void => {
    const state = watcher.state();
    status.textContent = state.status;
    status.classList.toggle("held", state.held);
    for (const node of [quick, note, mark, markAi]) node.hidden = !state.watching;
    origin.hidden = !state.watching;
    origin.textContent = state.draft
      ? draftTagBasisLine(state.draft.origin)
      : "A draft that appears here is tagged draft:unknown unless you say who wrote it.";
    if (state.last?.kind === "captured" && state.last.caseTitle) {
      detail.textContent = `Case: ${state.last.caseTitle}`;
    } else if (state.last?.kind === "failed") {
      detail.textContent = "The reply went out; Overturn never holds it back.";
    } else {
      detail.textContent = "";
    }
  };

  // Front pushes a new context when the conversation or its draft changes; the timer covers the
  // teammate's edits, which Front does not push.
  Front.contextUpdates.subscribe((context) => {
    const one = context.type === "singleConversation" ? context : null;
    if (debug) {
      debugLine.textContent = one
        ? `singleConversation ${one.conversation.id} · draft ${one.conversation.draftId ?? "none"}`
        : context.type;
    }
    void watcher.onContext(one).then(render);
  });
  window.setInterval(() => void watcher.poll().then(render), POLL_INTERVAL_MS);
  render();
}

/** How the run will be tagged, in the teammate's words. */
function draftTagBasisLine(origin: DraftOrigin): string {
  return `Tagged ${draftTag(origin)} — ${draftTagBasis(origin)}.`;
}

const started = (): void => {
  void main().catch((error: unknown) => console.error("overturn: the plugin did not start", error));
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", started);
else started();
