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

async function setupRotating() {
  const dir = makeScratchDir("gw-rot-");
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
  const seen: string[] = [];
  const fake = await startFakeUpstream((_req, res, hit) => {
    const auth = hit.headers.authorization;
    seen.push(Array.isArray(auth) ? auth[0] ?? "" : (auth ?? ""));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  ctx.fakes.push(fake.close);
  const base = `http://127.0.0.1:${fake.port}/loop`;
  const gw = await createGateway({
    keysPath,
    tokenPath,
    upstreams: { openai: `${base}/openai/v1`, anthropic: `${base}/anthropic/v1`, google: `${base}/google/v1beta` },
  });
  ctx.gateways.push(gw);
  const port = await listenGateway(gw.server as http.Server);
  return { baseUrl: gatewayUrl(port), token, seen, gw };
}

describe("gateway request rotation", () => {
  it("sequential_requests_alternate_a_b_and_update_counts", async () => {
    const { baseUrl, token, seen } = await setupRotating();
    for (let i = 0; i < 4; i += 1) {
      const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
      assert.equal(res.status, 200);
      await res.text();
    }
    // Independent oracle: file order go-1 then go-2, starting at go-1.
    assert.deepEqual(seen, [`Bearer ${KEY_A}`, `Bearer ${KEY_B}`, `Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);

    const health = await fetch(`${baseUrl}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await readJsonBody(health);
    const byLabel = Object.fromEntries(body.keys.map((k: { label: string; requests: number }) => [k.label, k.requests]));
    assert.equal(byLabel[LABEL_A], 2);
    assert.equal(byLabel[LABEL_B], 2);
    assert.equal(body.requests, 4);
  });

  it("concurrent_healthy_requests_divide_evenly", async () => {
    const { baseUrl, token, seen } = await setupRotating();
    const n = 8;
    await Promise.all(
      Array.from({ length: n }, () =>
        fetch(`${baseUrl}/openai/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: "m" }),
        }).then(async (r) => {
          assert.equal(r.status, 200);
          await r.text();
        }),
      ),
    );
    const a = seen.filter((s) => s === `Bearer ${KEY_A}`).length;
    const b = seen.filter((s) => s === `Bearer ${KEY_B}`).length;
    assert.equal(a + b, n);
    assert.equal(a, n / 2);
    assert.equal(b, n / 2);
  });
});
