// A Node server with the same two Canvas Kit routes, for an install that is not on a worker
// platform. Point the Developer Hub's Initialize and Submit URLs at it:
//   POST /intercom/initialize   and   POST /intercom/submit
//
//   node app/server.mjs            # reads app/config.json, or the environment
//
// Secrets never belong in a canvas: the API key and the Intercom token are read here, server-side,
// and the signature is checked with the app's client secret before anything is recorded.

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleCanvasRequest, runtimeFrom } from "./assets/main.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_KEYS = [
  "overturn_api_key",
  "overturn_base_url",
  "agent",
  "reason_pack",
  "require_reason",
  "capture_notes",
  "min_draft_chars",
  "scope_tag",
  "max_context_parts",
  "decision_fields",
  "intercom_token",
  "intercom_api_base",
];

function config() {
  const fromEnv = {
    overturn_api_key: process.env.OVERTURN_API_KEY,
    overturn_base_url: process.env.OVERTURN_BASE_URL,
    agent: process.env.OVERTURN_AGENT,
    reason_pack: process.env.OVERTURN_REASON_PACK,
    require_reason: process.env.OVERTURN_REQUIRE_REASON,
    capture_notes: process.env.OVERTURN_CAPTURE_NOTES,
    min_draft_chars: process.env.OVERTURN_MIN_DRAFT_CHARS,
    scope_tag: process.env.OVERTURN_SCOPE_TAG,
    max_context_parts: process.env.OVERTURN_MAX_CONTEXT_PARTS,
    decision_fields: process.env.OVERTURN_DECISION_FIELDS,
    intercom_token: process.env.INTERCOM_ACCESS_TOKEN,
    intercom_api_base: process.env.INTERCOM_API_BASE,
  };
  let fromFile = {};
  try {
    fromFile = JSON.parse(readFileSync(path.join(here, "config.json"), "utf8"));
  } catch {
    // no config.json; the environment has it
  }
  const merged = {};
  for (const key of CONFIG_KEYS) {
    const value = fromEnv[key] ?? fromFile[key];
    if (value !== undefined && value !== null && value !== "") merged[key] = value;
  }
  return merged;
}

function signatureOk(rawBody, header, secret) {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const got = Buffer.from(String(header));
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}
const port = Number(process.env.PORT ?? 8787);
const secret = process.env.INTERCOM_CLIENT_SECRET;
/** Local development only: without a secret, an unsigned request can record anything. */
const allowUnsigned = process.env.OVERTURN_ALLOW_UNSIGNED === "1";
const settings = config();

/** A Canvas Kit request is a conversation snapshot; anything larger is not one. */
const MAX_BODY_BYTES = Number(process.env.OVERTURN_MAX_BODY_BYTES ?? 1_048_576);

// Fail closed: an unsigned public capture webhook is a way to forge a project's records, so the
// process does not start without a secret unless the operator explicitly says this is local dev.
if (!secret && !allowUnsigned) {
  console.error(
    "Refusing to start: INTERCOM_CLIENT_SECRET is not set, so Intercom's X-Body-Signature cannot be\n" +
      "checked and anyone who learns this URL could forge captures. Set it (Developer Hub → Authentication)\n" +
      "or, for local development only, set OVERTURN_ALLOW_UNSIGNED=1.",
  );
  process.exit(1);
}

const server = createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET") return send(200, { ok: true, service: "overturn-intercom-app" });
  if (req.method !== "POST") return send(405, { error: "POST only" });
  if (url.pathname !== "/intercom/initialize" && url.pathname !== "/intercom/submit") {
    return send(404, { error: "not found" });
  }
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) return send(413, { error: "body too large" });

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      send(413, { error: "body too large" });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", async () => {
    if (aborted) return;
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!signatureOk(raw, req.headers["x-body-signature"], secret)) {
      return send(401, { error: "bad signature" });
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return send(400, { error: "bad json" });
    }
    try {
      send(200, await handleCanvasRequest(payload, runtimeFrom(settings)));
    } catch (error) {
      send(200, {
        canvas: {
          content: {
            components: [
              {
                type: "text",
                text: `Overturn could not answer this request (${error.message}).`,
                style: "muted",
              },
            ],
          },
        },
      });
    }
  });
});

server.listen(port, () => {
  const base = (process.env.OVERTURN_APP_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
  console.log(`Overturn for Intercom listening on ${port}`);
  console.log(`Initialize flow webhook URL: ${base}/intercom/initialize`);
  console.log(`Submit flow webhook URL:     ${base}/intercom/submit`);
  if (!settings.overturn_api_key) console.log("No OVERTURN_API_KEY: nothing will be recorded.");
  if (!secret) console.log("WARNING: OVERTURN_ALLOW_UNSIGNED=1 — signatures are NOT checked.");
});
