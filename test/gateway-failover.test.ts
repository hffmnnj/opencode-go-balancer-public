import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
  readJsonBody,
  startFakeUpstream,
  writeKeysFile,
  writeTokenFile,
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

async function setupFailover(opts: {
  nowMs: number;
  onRequest: (req: http.IncomingMessage, res: http.ServerResponse, hitAuth: string) => void;
  hits: string[];
}) {
  const dir = makeScratchDir("gw-fail-");
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
  let nowMs = opts.nowMs;
  const fake = await startFakeUpstream((req, res) => {
    const chunks: Buffer[] = [];
    // startFakeUpstream already recorded the hit; recover auth from last hit via header sniff:
    // simpler: read directly from req headers here (same request).
    const auth = req.headers.authorization;
    const hitAuth = Array.isArray(auth) ? (auth[0] ?? "") : (auth ?? "");
    opts.hits.push(hitAuth);
    // Drain body then delegate (body already consumed by helper? helper consumes; here just decide).
    opts.onRequest(req, res, hitAuth);
    void chunks;
  });
  ctx.fakes.push(fake.close);
  const base = `http://127.0.0.1:${fake.port}/loop`;
  const gw = await createGateway({
    keysPath,
    tokenPath,
    upstreams: { openai: `${base}/openai/v1`, anthropic: `${base}/anthropic/v1`, google: `${base}/google/v1beta` },
    now: () => nowMs,
  });
  ctx.gateways.push(gw);
  const port = await listenGateway(gw.server as http.Server);
  return {
    baseUrl: gatewayUrl(port),
    token,
    setNow: (v: number) => {
      nowMs = v;
    },
    getNow: () => nowMs,
  };
}

async function postOpenai(baseUrl: string, token: string) {
  const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

describe("gateway failover and cooldown", () => {
  it("failover_once_on_401_before_stream", async () => {
    const hits: string[] = [];
    let calls = 0;
    const { baseUrl, token } = await setupFailover({
      nowMs: 1_700_000_000_000,
      hits,
      onRequest: (_req, res, hitAuth) => {
        calls += 1;
        if (hitAuth === `Bearer ${KEY_A}` && calls === 1) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "bad key" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    });
    const r = await postOpenai(baseUrl, token);
    assert.equal(r.status, 200);
    assert.deepEqual(hits, [`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);

    const health = await readJsonBody(
      await fetch(`${baseUrl}/health`, { headers: { authorization: `Bearer ${token}` } }),
    );
    assert.equal(health.failovers, 1);
  });

  it("failover_on_429_honors_retry_after_without_short_cap", async () => {
    const hits: string[] = [];
    const t0 = 1_700_000_000_000;
    let mode = "first";
    const setup = await setupFailover({
      nowMs: t0,
      hits,
      onRequest: (_req, res, hitAuth) => {
        if (mode === "first") {
          if (hitAuth === `Bearer ${KEY_A}`) {
            res.writeHead(429, { "content-type": "application/json", "retry-after": "3600" });
            res.end(JSON.stringify({ error: { message: "slow down" } }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    });

    const first = await postOpenai(setup.baseUrl, setup.token);
    assert.equal(first.status, 200);
    assert.deepEqual(hits, [`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);

    const health1 = await readJsonBody(
      await fetch(`${setup.baseUrl}/health`, { headers: { authorization: `Bearer ${setup.token}` } }),
    );
    const entryA = health1.keys.find((k: { label: string }) => k.label === LABEL_A);
    // No short cap: 3600s Retry-After must cool for ~1h, not ~60s.
    assert.ok(entryA.cooldownMs > 60_000, `expected >60s cooldown, got ${entryA.cooldownMs}`);
    assert.ok(Math.abs(entryA.cooldownMs - 3_600_000) < 5_000, `got ${entryA.cooldownMs}`);

    // 60s later: A still cooling, must not be probed.
    setup.setNow(t0 + 60_000);
    hits.splice(0);
    mode = "second";
    const second = await postOpenai(setup.baseUrl, setup.token);
    assert.equal(second.status, 200);
    assert.deepEqual(hits, [`Bearer ${KEY_B}`]);

    // After the hour: A eligible again.
    setup.setNow(t0 + 3_601_000);
    hits.splice(0);
    const third = await postOpenai(setup.baseUrl, setup.token);
    assert.equal(third.status, 200);
    assert.ok(hits.includes(`Bearer ${KEY_A}`), `expected A reused, got ${JSON.stringify(hits)}`);
  });

  it("exhaustion_returns_429_without_probing_cooling_keys", async () => {
    const hits: string[] = [];
    const t0 = 1_700_000_000_000;
    const setup = await setupFailover({
      nowMs: t0,
      hits,
      onRequest: (_req, res) => {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
        res.end(JSON.stringify({ error: { message: "limit" } }));
      },
    });
    const first = await postOpenai(setup.baseUrl, setup.token);
    assert.equal(first.status, 429);
    assert.equal(hits.length, 2);
    assert.ok(first.headers.get("retry-after"), "exhausted 429 must carry retry-after");
    assert.ok(!first.text.includes(KEY_A) && !first.text.includes(KEY_B));

    hits.splice(0);
    const second = await postOpenai(setup.baseUrl, setup.token);
    assert.equal(second.status, 429);
    assert.equal(hits.length, 0);
    assert.ok(second.headers.get("retry-after"));
  });

  it("does_not_retry_on_5xx", async () => {
    const hits: string[] = [];
    const { baseUrl, token } = await setupFailover({
      nowMs: 1_700_000_000_000,
      hits,
      onRequest: (_req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" } }));
      },
    });
    const r = await postOpenai(baseUrl, token);
    assert.equal(r.status, 500);
    assert.equal(hits.length, 1);
  });

  it("does_not_retry_on_network_error", async () => {
    const hits: string[] = [];
    const { baseUrl, token } = await setupFailover({
      nowMs: 1_700_000_000_000,
      hits,
      onRequest: (_req, res) => {
        res.destroy();
      },
    });
    const r = await postOpenai(baseUrl, token);
    // Locally generated: must not be 200 and must not have retried.
    assert.ok(r.status === 502 || r.status === 500 || r.status === 504, `got ${r.status}`);
    assert.equal(hits.length, 1);
  });
});
