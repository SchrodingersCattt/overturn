# Overturn for Front

QA for AI-drafted replies, in the conversation sidebar. It watches the composer for the AI draft, diffs it against what the teammate actually sent, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. The drafting agent never has to be instrumented, and it does not matter who wrote the draft: Front AI, a snippet, a homegrown drafter or a paste. The support lead gets the untouched rate and the fixes by reason, by team and by week, on the Capture page.

## What the teammate sees

A small panel in the conversation sidebar:

- **Draft inserted · 112 words** once a draft lands in the reply box reply-sized in one go (an assist, a snippet, a paste). A composer that already holds a reply when the plugin loads is **found in the composer**; the two links under the panel say who wrote the text — "I wrote it" or "an AI wrote it" — because the plugin only ever saw text move.
- A **reason** picker with the installed pack's eight codes and an optional note.
- On send: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric. With *require a reason* on, a changed reply is not recorded until a code is picked.

Overturn failing never blocks the send; the panel says what happened and gets out of the way.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Start the capture proxy, which is what holds that key:
   ```bash
   OVERTURN_API_KEY=ov_live_… OVERTURN_BASE_URL=https://api.overturn.run PORT=8788 \
     node packages/front-plugin/app/proxy.mjs     # also shipped as dist/app/proxy.mjs
   ```
3. Build and host the plugin: `pnpm --filter @overturn-ai/front-plugin build` → `dist/overturn-front-plugin.zip`, unzipped on any static host (or your own). Front frames the page in the sidebar, so it has to be HTTPS and publicly reachable.
4. In Front: **Developers** → create an app → add a **plugin** feature of type **sidebar** with the plugin URL
   `https://<your-plugin-host>/index.html?overturn_base_url=https://<your-proxy-host>&agent=support-reply`.
5. Enable the plugin for the company, then open a conversation to see it.

The plugin page is loaded by a browser, so it carries **no credentials at all**: Front's relay (`relayHttp`) posts each capture to `overturn_base_url`, and the proxy attaches the project key server-side. A key in a plugin URL would sit in browser history, in `Referer` headers and in proxy logs, so the plugin does not read `overturn_api_key` — it warns if one is still in the URL. The proxy only forwards `POST /v1/capture`, refuses bodies over 1 MiB, and passes Overturn's answer (including a refusal) straight back; `src/relay.test.ts` covers that path.

Front plugins have no settings object like a Zendesk app has, so the settings ride in the plugin URL's query string:

| Parameter | Default | What it does |
| :-- | :-- | :-- |
| `overturn_base_url` | `https://api.overturn.run` | Where the capture goes, through Front's relay. Point it at your proxy (above), which holds the key. |
| `agent` | `support-reply` | The workflow; one regression suite per workflow. A claims team might use `claims-reply`. |
| `reason_pack` | `support` | `support` (vendor-neutral) or `claims`, the chips the teammate clicks. |
| `decision_fields` | — | Conversation custom attributes that *are* the decision, by name or id, e.g. `coverage,reserve,denial_reason`. Changes to these are scored exactly; the prose is scored by the judge. |
| `require_reason` | `true` | Hold a changed reply's capture until a reason code is picked. |
| `capture_comments` | `false` | Also send the conversation's comments as internal notes in the captured context. |
| `min_draft_chars` | `80` | Composer text shorter than this never counts as a draft. |
| `scope_tag` | — | Watch only conversations carrying this tag; every other conversation is never read. |

Add `?debug=true` (or `&debug=true`) to show the context the SDK is sending under the panel.

## How it reads Front

- The plugin is a **sidebar plugin**, so it is live for the whole time a conversation is open. A draft is discovered from `conversation.draftId` and read with `fetchDraft`; while a draft is open the plugin also re-reads it every 1.5s, because Front pushes context updates when the conversation or the draft changes but not when the teammate edits the text.
- **Nothing is read before a draft appears.** The thread (`listMessages`, and `listComments` when comments are captured) is read only after a draft existed and then left the composer — so a human-only conversation never leaves Front and never enters Overturn.
- The sent body is the newest message sent after the draft appeared, not the text the plugin last saw in the composer: the conversation is the record. If the draft was closed without a send, nothing is recorded.
- Front loads message bodies lazily, so a just-sent reply can arrive without one. The plugin **holds the draft** (and the reason picked for it) and looks again every 1.5s, up to five minutes, rather than recording an empty capture or losing it; if the body never arrives it says so and lets the draft go.
- `Message.from` is the address the reply went out from — on a shared inbox that is the shared address, not the teammate who clicked send — so it is recorded as provenance (`metadata.sentFrom`, `metadata.actorMatchesSentFrom`) and never used to decide who acted. Refusing a capture because a shared address differs from the teammate's own would drop most captures in the workspaces this is for.
- `secondsToSend` is measured from the moment the draft appeared to the message Front dated, not to the moment the plugin noticed it had gone.

### What the tag says about who wrote the draft

A jump in the composer, or reply-sized text already there when the plugin loads, is a **mechanism**: it is not evidence that a model wrote the text. Front's plugin SDK exposes no per-draft author, so the plugin tags `draft:unknown` unless the teammate says otherwise, and the panel says exactly that ("Tagged draft:unknown — nobody said who wrote it"). The two links mark the text as the draft and say who wrote it: **an AI wrote it** → `draft:ai`, **I wrote it** → `draft:manual`. `metadata.draftOrigin` and `metadata.draftTagBasis` keep that reasoning with the run, so the scorecard's AI-versus-human split only counts drafts whose origin somebody stated.

### About `require_reason`

Front's Plugin SDK has no pre-send hook. Verified against `@frontapp/plugin-sdk` 1.12.0: the only stream is `Front.contextUpdates`, the draft methods are `createDraft` / `updateDraft` / `fetchDraft` / `close` / `closeDraft`, and Front's send button is not the plugin's to hold. A plugin cannot veto a send.

So `require_reason` is enforced where it can be: a changed reply whose capture has no reason code is **held in the panel** ("Changed · pick why before Overturn records it") and posted the moment a chip is clicked, with the note. Nothing unexplained lands in the suite, and the teammate's send is never held up — a failed or blocked capture is never a failed reply. Recording an unexplained change instead, or pretending to block a send we cannot see, would both be worse. The picked reason belongs to one draft: closing a draft without sending, or starting a new one, clears it, so a stale reason can never label the next reply.

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test       # the payload builder, the watcher, the relay
pnpm --filter @overturn-ai/front-plugin typecheck
pnpm --filter @overturn-ai/front-plugin build      # dist/overturn-front-plugin.zip
```

`src/capture.ts` is the payload builder (pure, tested): settings, draft detection, the conversation as capture context, the draft-versus-sent decision, and what the origin tag is allowed to say. `src/watch.ts` is the watcher that turns Front contexts, drafts and sends into those decisions, written against a small `FrontLike` interface so it is tested with a mocked SDK (`src/watch.test.ts`) — no live Front account needed. `src/main.ts` is the SDK and DOM glue, and `app/proxy.mjs` is the credential-holding endpoint it posts through (`src/relay.test.ts`). `app/` is the page Front frames.
