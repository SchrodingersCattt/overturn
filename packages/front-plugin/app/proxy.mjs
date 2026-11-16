// The credential-holding endpoint the Front plugin talks to.
//
// A Front plugin page is loaded by a browser, so it must not carry a project key: Front's relay
// posts here instead, and this process (which nobody can read from a browser) attaches the key.
//
//   OVERTURN_API_KEY=ov_live_…  OVERTURN_BASE_URL=https://api.overturn.run  PORT=8788  node proxy.mjs
//
// Then set the plugin's `overturn_base_url` to this host. The relay only forwards the paths Front
// allows for the app, and this proxy only forwards the one path Overturn needs.

import { createServer } from "node:http";

/** A capture body is one conversation; anything much larger is not one. */
export const MAX_BODY_BYTES = 1_048_576;

export const CAPTURE_PATH = "/v1/capture";

/**
 * Forwards one capture to Overturn with the project key attached. Pure enough to test: the
 * upstream call is an injected fetch.
 */
export function createCaptureProxy(opts) {
  const upstream = `${opts.baseUrl.replace(/\/+$/, "")}${CAPTURE_PATH}`;
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((message, error) => console.error(message, error ?? ""));

  return async function handle(req, res) {
    const send = (status, body, contentType = "application/json") => {
      res.writeHead(status, { "content-type": contentType });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.method !== "POST") return send(405, { error: "POST only" });
    const path = (req.url ?? "").split("?")[0];
    if (path !== CAPTURE_PATH) return send(404, { error: "not found" });

    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) return send(413, { error: "body too large" });

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return send(413, { error: "body too large" });
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      const response = await doFetch(upstream, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The whole point of this process: the key never reaches the plugin.
          authorization: `Bearer ${opts.apiKey}`,
        },
        body,
      });
      const text = await response.text();
      return send(response.status, text, response.headers.get("content-type") ?? "application/json");
    } catch (error) {
      log("overturn proxy: the upstream call failed", error);
      return send(502, { error: "upstream unavailable" });
    }
  };
}

function main() {
  const apiKey = process.env.OVERTURN_API_KEY;
  const baseUrl = process.env.OVERTURN_BASE_URL ?? "https://api.overturn.run";
  const port = Number(process.env.PORT ?? 8788);
  if (!apiKey) {
    console.error("Refusing to start: OVERTURN_API_KEY is not set, so there is no credential to attach.");
    process.exit(1);
  }
  const server = createServer(createCaptureProxy({ apiKey, baseUrl }));
  server.listen(port, () => {
    console.log(`Overturn capture proxy on ${port} → ${baseUrl}${CAPTURE_PATH} (key attached server-side)`);
    console.log(
      `Set the Front plugin's overturn_base_url to ${process.env.OVERTURN_APP_URL ?? `http://localhost:${port}`}`,
    );
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href.replace(/\\/g, "/")) {
  main();
}
