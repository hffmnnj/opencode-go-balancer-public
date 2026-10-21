import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { createGateway } from "../src/gateway.ts";
import {
  KEY_A,
  KEY_B,
  LABEL_A,
  LABEL_B,
  cleanupScratchDir,
  gatewayUrl,
  genToken,
  listenGateway,
  makeScratchDir,
  startFakeUpstream,
  writeKeysFile,
  writeTokenFile,
  type RecordedHit,
} from "./helpers.ts";

const ctx: {
  dir: string;
  files: string[];
  fakes: Array<() => Promise<void>>;
  gateways: Array<{ close: () => Promise<void> }>;
} = { dir: "", files: [], fakes: [], gateways: [] };

afterEach(async () => {
  for (const gw of ctx.gateways.splice(0)) {
    try {
      await gw.close();
    } catch {
      // ignore
    }
  }
  for (const close of ctx.fakes.splice(0)) {
    try {
      await close();
    } catch {
      // ignore
    }
  }
  if (ctx.dir) {
    cleanupScratchDir(ctx.dir, ctx.files.splice(0));
    ctx.dir = "";
  }
});

async function setupTriple() {
  const dir = makeScratchDir("gw-route-");
  ctx.dir = dir;
  const token = genToken();
  const keysPath = writeKeysFile(
    dir,
    [
      { label: LABEL_A, key: KEY_A },
      { label: LABEL_B, key: KEY_B },
    ],
    0o600,
  );
  const tokenPath = writeTokenFile(dir, token, 0o600);
  ctx.files.push(keysPath, tokenPath);

  const openaiHits: RecordedHit[] = [];
  const anthropicHits: RecordedHit[] = [];
  const googleHits: RecordedHit[] = [];
  const openai = await startFakeUpstream((_req, res, hit) => {
    openaiHits.push(hit);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const anthropic = await startFakeUpstream((_req, res, hit) => {
    anthropicHits.push(hit);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const google = await startFakeUpstream((_req, res, hit) => {
    googleHits.push(hit);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  ctx.fakes.push(openai.close, anthropic.close, google.close);

  const gw = await createGateway({
    keysPath,
    tokenPath,
    upstreams: {
      openai: `http://127.0.0.1:${openai.port}/openai/v1`,
      anthropic: `http://127.0.0.1:${anthropic.port}/anthropic/v1`,
      google: `http://127.0.0.1:${google.port}/google/v1beta`,
    },
  });
  ctx.gateways.push(gw);
  const port = await listenGateway(gw.server as http.Server);
  return {
    baseUrl: gatewayUrl(port),
    token,
    openaiHits,
    anthropicHits,
    googleHits,
  };
}

async function postJson(baseUrl: string, token: string, p: string, body: unknown, extra?: Record<string, string>) {
  const res = await fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(extra ?? {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

describe("gateway protocol routing", () => {
  it("routes_each_accepted_path_to_its_configured_upstream", async () => {
    const { baseUrl, token, openaiHits, anthropicHits, googleHits } = await setupTriple();

    const cases: Array<{ path: string; want: "openai" | "anthropic" | "google" }> = [
      { path: "/openai/v1/chat/completions", want: "openai" },
      { path: "/openai/v1/responses", want: "openai" },
      { path: "/openai/v1/responses/compact", want: "openai" },
      { path: "/anthropic/v1/messages", want: "anthropic" },
      { path: "/google/v1beta/models/gemini-2.5-flash:generateContent", want: "google" },
      { path: "/google/v1beta/models/gemini-2.5-flash:streamGenerateContent", want: "google" },
    ];
    for (const c of cases) {
      const r = await postJson(baseUrl, token, c.path, { model: "m" });
      assert.equal(r.status, 200, `${c.path} got ${r.status}: ${r.text}`);
    }
    assert.equal(openaiHits.length, 3);
    assert.equal(anthropicHits.length, 1);
    assert.equal(googleHits.length, 2);
    for (const h of openaiHits) assert.match(h.url ?? "", /chat\/completions|responses/);
    assert.match(anthropicHits[0].url ?? "", /messages/);
    for (const h of googleHits) assert.match(h.url ?? "", /:generateContent|:streamGenerateContent/);
  });

  it("uses_per_protocol_credentials", async () => {
    const { baseUrl, token, openaiHits, anthropicHits, googleHits } = await setupTriple();

    await postJson(baseUrl, token, "/openai/v1/chat/completions", { model: "m" });
    await postJson(baseUrl, token, "/anthropic/v1/messages", { model: "m", messages: [] });
    await postJson(baseUrl, token, "/google/v1beta/models/gemini-2.5-flash:generateContent", {
      contents: [],
    });

    assert.equal(openaiHits.length, 1);
    assert.equal(anthropicHits.length, 1);
    assert.equal(googleHits.length, 1);

    const o = openaiHits[0].headers;
    assert.equal(o.authorization, `Bearer ${KEY_A}`);
    assert.equal(o["x-api-key"], undefined);
    assert.equal(o["x-goog-api-key"], undefined);

    const a = anthropicHits[0].headers;
    // Second request rotates to key B.
    assert.equal(a["x-api-key"], KEY_B);
    assert.equal(a.authorization, undefined);
    assert.equal(a["x-goog-api-key"], undefined);

    const g = googleHits[0].headers;
    assert.equal(g["x-goog-api-key"], KEY_A);
    assert.equal(g.authorization, undefined);
    assert.equal(g["x-api-key"], undefined);
  });

  it("strips_incoming_auth_cookies_org_and_connection_nominated_headers", async () => {
    const { baseUrl, token, openaiHits } = await setupTriple();
    // NOTE: fetch forbids the Connection header, so use raw http to prove
    // Connection-nominated headers are stripped by the gateway.
    const rawRes = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const target = new URL(`${baseUrl}/openai/v1/chat/completions`);
      const body = JSON.stringify({ model: "m" });
      const req = http.request(
        target,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            cookie: "session=evil",
            "x-api-key": "injected",
            "x-goog-api-key": "injected",
            "x-opencode-org-id": "org-evil",
            connection: "x-evil-hop, keep-alive",
            "x-evil-hop": "should-be-stripped",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    assert.equal(rawRes.status, 200);
    assert.equal(openaiHits.length, 1);
    const h = openaiHits[0].headers;
    assert.equal(h.cookie, undefined);
    assert.equal(h["x-opencode-org-id"], undefined);
    assert.equal(h["x-evil-hop"], undefined);
    // Gateway credential must never be forwarded; upstream sees the chosen Go key instead.
    assert.notEqual(h.authorization, `Bearer ${token}`);
    assert.equal(h.authorization, `Bearer ${KEY_A}`);
  });

  it("preserves_session_header_and_body_bytes", async () => {
    const { baseUrl, token, openaiHits } = await setupTriple();
    const payload = { model: "m", messages: [{ role: "user", content: "hello" }] };
    const raw = JSON.stringify(payload);
    const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-opencode-session": "sess-123",
      },
      body: raw,
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(openaiHits.length, 1);
    const hit = openaiHits[0];
    assert.equal(hit.headers["x-opencode-session"], "sess-123");
    assert.equal(hit.body.toString("utf8"), raw);
  });

  it("restricts_query_to_google_alt_sse", async () => {
    const { baseUrl, token, openaiHits, googleHits } = await setupTriple();
    // Arbitrary query on OpenAI is rejected and never forwarded.
    const bad = await fetch(`${baseUrl}/openai/v1/chat/completions?foo=bar`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "m" }),
    });
    assert.equal(bad.status, 404);
    await bad.text();
    assert.equal(openaiHits.length, 0);
    // The single allowlisted Google query is forwarded verbatim.
    const good = await fetch(
      `${baseUrl}/google/v1beta/models/gemini-2.5-flash:generateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ contents: [] }),
      },
    );
    assert.equal(good.status, 200);
    await good.text();
    assert.equal(googleHits.length, 1);
    assert.match(googleHits[0].url ?? "", /alt=sse/);
  });

  it("preserves_compressed_body_bytes", async () => {
    const { baseUrl, token, openaiHits } = await setupTriple();
    const raw = Buffer.from(JSON.stringify({ model: "m", messages: [] }), "utf8");
    const gz = zlib.gzipSync(raw);
    const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: gz,
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(openaiHits.length, 1);
    const hit = openaiHits[0];
    assert.equal(hit.headers["content-encoding"], "gzip");
    assert.deepEqual(hit.body, gz);
  });

  it("rejects_unsafe_google_model_paths", async () => {
    const { baseUrl, token, googleHits } = await setupTriple();
    const bad = [
      "/google/v1beta/models/..:generateContent",
      "/google/v1beta/models/a%2Fb:generateContent",
      "/google/v1beta/models/:generateContent",
    ];
    for (const p of bad) {
      const r = await postJson(baseUrl, token, p, { contents: [] });
      assert.ok([400, 404].includes(r.status), `${p} got ${r.status}`);
    }
    assert.equal(googleHits.length, 0);
  });
});
