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
  deferred,
  gatewayUrl,
  genToken,
  listenGateway,
  makeScratchDir,
  overwriteKeysFile,
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

async function postOpenai(baseUrl: string, token: string) {
  const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "m" }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

describe("gateway key reload", () => {
  it("atomic_reload_keeps_inflight_on_old_keys", async () => {
    const dir = makeScratchDir("gw-reload-atomic-");
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

    const gate = deferred<void>();
    const seen: string[] = [];
    let releaseUpstream!: () => void;
    const releaseGate = new Promise<void>((r) => {
      releaseUpstream = r;
    });
    const fake = await startFakeUpstream((req, res) => {
      const auth = req.headers.authorization;
      seen.push(Array.isArray(auth) ? (auth[0] ?? "") : (auth ?? ""));
      if (seen.length === 1) {
        // Hold the first (in-flight) request until the reload lands.
        gate.resolve();
        releaseGate.then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
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
    const baseUrl = gatewayUrl(port);

    const inflight = postOpenai(baseUrl, token);
    await gate.promise;
    overwriteKeysFile(keysPath, { keys: [{ label: "go-3", key: "test-key-c" }] });
    const reloaded = await (gw as { reloadKeys: () => boolean }).reloadKeys();
    assert.equal(reloaded, true);
    releaseUpstream();
    const first = await inflight;
    assert.equal(first.status, 200);
    // In-flight request captured the old pool (go-1).
    assert.deepEqual(seen, [`Bearer ${KEY_A}`]);

    const second = await postOpenai(baseUrl, token);
    assert.equal(second.status, 200);
    assert.deepEqual(seen, [`Bearer ${KEY_A}`, "Bearer test-key-c"]);
  });

  it("invalid_reload_retains_old_pool", async () => {
    const dir = makeScratchDir("gw-reload-invalid-");
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
    const fake = await startFakeUpstream((req, res) => {
      const auth = req.headers.authorization;
      seen.push(Array.isArray(auth) ? (auth[0] ?? "") : (auth ?? ""));
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
    const baseUrl = gatewayUrl(port);

    overwriteKeysFile(keysPath, "{ not json");
    const bad = await (gw as { reloadKeys: () => boolean }).reloadKeys();
    assert.equal(bad, false);

    const r = await postOpenai(baseUrl, token);
    assert.equal(r.status, 200);
    assert.equal(seen.length, 1);
    assert.ok(seen[0] === `Bearer ${KEY_A}` || seen[0] === `Bearer ${KEY_B}`);

    const health = await readJsonBody(
      await fetch(`${baseUrl}/health`, { headers: { authorization: `Bearer ${token}` } }),
    );
    assert.deepEqual(
      health.keys.map((k: { label: string }) => k.label).sort(),
      [LABEL_A, LABEL_B].sort(),
    );
  });

  it("duplicate_keys_on_reload_rejected_and_retained", async () => {
    const dir = makeScratchDir("gw-reload-dup-");
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
    const fake = await startFakeUpstream((_req, res) => {
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
    const baseUrl = gatewayUrl(port);

    overwriteKeysFile(keysPath, {
      keys: [
        { label: LABEL_A, key: KEY_A },
        { label: LABEL_B, key: KEY_A },
      ],
    });
    const dup = await (gw as { reloadKeys: () => boolean }).reloadKeys();
    assert.equal(dup, false);

    const health = await readJsonBody(
      await fetch(`${baseUrl}/health`, { headers: { authorization: `Bearer ${token}` } }),
    );
    assert.deepEqual(
      health.keys.map((k: { label: string }) => k.label).sort(),
      [LABEL_A, LABEL_B].sort(),
    );
  });

  it("empty_keys_explicitly_disables_upstream", async () => {
    const dir = makeScratchDir("gw-reload-empty-");
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
    let hits = 0;
    const fake = await startFakeUpstream((_req, res) => {
      hits += 1;
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
    const baseUrl = gatewayUrl(port);

    overwriteKeysFile(keysPath, { keys: [] });
    const reloaded = await (gw as { reloadKeys: () => boolean }).reloadKeys();
    assert.equal(reloaded, true);

    const health = await readJsonBody(
      await fetch(`${baseUrl}/health`, { headers: { authorization: `Bearer ${token}` } }),
    );
    assert.equal(health.ok, false);
    assert.equal(health.keys.length, 0);

    const r = await postOpenai(baseUrl, token);
    assert.equal(r.status, 503);
    assert.equal(hits, 0);
  });
});
