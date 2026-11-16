// The relay path, end to end: Front's relay posts the capture to the installer's proxy, and the
// proxy — never the plugin page — is where the project key lives.

import { describe, expect, it } from "vitest";
import { CAPTURE_PATH, createCaptureProxy, MAX_BODY_BYTES } from "../app/proxy.mjs";

/** A Node response that just records what was written to it. */
function fakeResponse() {
  const written = { status: 0, headers: {} as Record<string, string>, body: "" };
  return {
    written,
    writeHead: (status: number, headers?: Record<string, string>) => {
      written.status = status;
      written.headers = headers ?? {};
    },
    end: (body: string) => {
      written.body = typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

/** A request with a body, as Node's `IncomingMessage` presents itself to `for await`. */
function fakeRequest(body: string, opts: { method?: string; url?: string; length?: number } = {}) {
  const headers: Record<string, string> = { "content-length": String(opts.length ?? body.length) };
  return {
    method: opts.method ?? "POST",
    url: opts.url ?? CAPTURE_PATH,
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  };
}

function upstreamFor(
  seen: Array<{ url: string; init?: RequestInit }>,
  response = { status: 201, body: '{"kind":"edit"}' },
) {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("the capture proxy", () => {
  it("attaches the project key server-side and forwards the body untouched", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const handle = createCaptureProxy({
      apiKey: "ov_live_proxy",
      baseUrl: "https://api.overturn.run",
      fetchImpl: upstreamFor(seen),
    });
    const payload = JSON.stringify({
      source: "front",
      externalId: "fr:cnv_1",
      draft: { text: "a" },
      sent: { text: "b" },
    });
    const res = fakeResponse();

    await handle(fakeRequest(payload), res);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.overturn.run/v1/capture");
    expect(seen[0]?.init?.headers).toMatchObject({ authorization: "Bearer ov_live_proxy" });
    expect(seen[0]?.init?.body).toBe(payload);
    // The plugin only ever sees the upstream's answer.
    expect(res.written.status).toBe(201);
    expect(res.written.body).toBe('{"kind":"edit"}');
  });

  it("has no other route, and no other method", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const handle = createCaptureProxy({
      apiKey: "ov_live_proxy",
      baseUrl: "https://api.overturn.run",
      fetchImpl: upstreamFor(seen),
    });
    const other = fakeResponse();
    await handle(fakeRequest("{}", { url: "/v1/runs" }), other);
    expect(other.written.status).toBe(404);
    const get = fakeResponse();
    await handle(fakeRequest("{}", { method: "GET" }), get);
    expect(get.written.status).toBe(405);
    expect(seen).toHaveLength(0);
  });

  it("refuses a body larger than a conversation", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const handle = createCaptureProxy({
      apiKey: "ov_live_proxy",
      baseUrl: "https://api.overturn.run",
      fetchImpl: upstreamFor(seen),
    });
    const declared = fakeResponse();
    await handle(fakeRequest("{}", { length: MAX_BODY_BYTES + 1 }), declared);
    expect(declared.written.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("answers 502 rather than making the plugin think the capture went out", async () => {
    const failing = (async () => {
      throw new Error("upstream is down");
    }) as unknown as typeof fetch;
    const handle = createCaptureProxy({
      apiKey: "ov_live_proxy",
      baseUrl: "https://api.overturn.run",
      fetchImpl: failing,
      log: () => {},
    });
    const res = fakeResponse();
    await handle(fakeRequest("{}"), res);
    expect(res.written.status).toBe(502);
  });

  it("passes the upstream's refusal through with its status", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const handle = createCaptureProxy({
      apiKey: "ov_live_proxy",
      baseUrl: "https://api.overturn.run/",
      fetchImpl: upstreamFor(seen, { status: 401, body: '{"message":"invalid key"}' }),
    });
    const res = fakeResponse();
    await handle(fakeRequest("{}"), res);
    expect(res.written.status).toBe(401);
    expect(res.written.body).toBe('{"message":"invalid key"}');
    // A trailing slash in the configured base URL does not become a double slash upstream.
    expect(seen[0]?.url).toBe("https://api.overturn.run/v1/capture");
  });
});
