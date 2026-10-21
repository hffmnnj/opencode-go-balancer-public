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

async function setupBase(opts?: { maxBodyBytes?: number; headerTimeoutMs?: number; chunkTimeoutMs?: number }) {
  const dir = makeScratchDir("gw-stream-");
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
  return { dir, token, keysPath, tokenPath };
}

function gatewayUpstreams(port: number) {
  const base = `http://127.0.0.1:${port}/loop`;
  return { openai: `${base}/openai/v1`, anthropic: `${base}/anthropic/v1`, google: `${base}/google/v1beta` };
}

describe("gateway streaming and limits", () => {
  it("streams_first_bytes_before_completion", async () => {
    const { token, keysPath, tokenPath } = await setupBase();
    const releaseSecond = deferred<void>();
    let hits = 0;
    const fake = await startFakeUpstream((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("chunk-one\n");
      releaseSecond.promise.then(() => {
        res.write("chunk-two\n");
        res.end();
      });
    });
    ctx.fakes.push(fake.close);
    const gw = await createGateway({ keysPath, tokenPath, upstreams: gatewayUpstreams(fake.port) });
    ctx.gateways.push(gw);
    const port = await listenGateway(gw.server as http.Server);
    const baseUrl = gatewayUrl(port);

    const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "m", stream: true }),
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    const firstText = new TextDecoder().decode(first.value);
    assert.match(firstText, /chunk-one/);
    // First bytes arrived before the upstream finished: release the rest only now.
    releaseSecond.resolve();
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    assert.match(rest, /chunk-two/);
    assert.equal(hits, 1);
  });

  it("client_disconnect_aborts_upstream_without_retry", async () => {
    const { token, keysPath, tokenPath } = await setupBase();
    const upstreamAborted = deferred<void>();
    let upstreamClosed = false;
    let hits = 0;
    const fake = await startFakeUpstream((_req, res) => {
      hits += 1;
      res.on("close", () => {
        upstreamClosed = true;
        upstreamAborted.resolve();
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("partial\n");
      // Never end; wait for client abort.
    });
    ctx.fakes.push(fake.close);
    const gw = await createGateway({ keysPath, tokenPath, upstreams: gatewayUpstreams(fake.port) });
    ctx.gateways.push(gw);
    const port = await listenGateway(gw.server as http.Server);
    const baseUrl = gatewayUrl(port);

    const ctrl = new AbortController();
    const pending = fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "m", stream: true }),
      signal: ctrl.signal,
    });
    const res = await pending;
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(upstreamClosed, false, "upstream must stay open before cancellation");
    ctrl.abort();
    try {
      await reader.read();
    } catch {
      // abort surfaces as error or done; either is fine
    }
    await Promise.race([
      upstreamAborted.promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("upstream not aborted")), 2000)),
    ]);
    assert.equal(hits, 1);
  });

  it("partial_stream_failure_is_never_replayed", async () => {
    const { token, keysPath, tokenPath } = await setupBase();
    const interrupt = deferred<void>();
    let hits = 0;
    const fake = await startFakeUpstream((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("good-bytes\n");
      // Fail only after the client has observed the first chunk.
      void interrupt.promise.then(() => res.destroy());
    });
    ctx.fakes.push(fake.close);
    const gw = await createGateway({ keysPath, tokenPath, upstreams: gatewayUpstreams(fake.port) });
    ctx.gateways.push(gw);
    const port = await listenGateway(gw.server as http.Server);
    const baseUrl = gatewayUrl(port);

    const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "m", stream: true }),
    });
    // Headers were already sent before the failure, so the client sees 200.
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(new TextDecoder().decode(first.value), "good-bytes\n");
    interrupt.resolve();
    await assert.rejects(reader.read(), { name: "TypeError" });
    assert.equal(hits, 1);
  });

  it("oversized_body_rejected_without_forwarding", async () => {
    const { token, keysPath, tokenPath } = await setupBase({ maxBodyBytes: 64 });
    let hits = 0;
    const fake = await startFakeUpstream((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    ctx.fakes.push(fake.close);
    const gw = await createGateway({
      keysPath,
      tokenPath,
      upstreams: gatewayUpstreams(fake.port),
      maxBodyBytes: 64,
    });
    ctx.gateways.push(gw);
    const port = await listenGateway(gw.server as http.Server);
    const baseUrl = gatewayUrl(port);

    const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(1024) }] }),
    });
    assert.equal(res.status, 413);
    await res.text();
    assert.equal(hits, 0);
  });

  it("upstream_header_timeout_terminates_without_retry", async () => {
    const { token, keysPath, tokenPath } = await setupBase();
    let hits = 0;
    const fake = await startFakeUpstream((_req, res) => {
      hits += 1;
      // Never send headers within the gateway timeout.
      setTimeout(() => {
        try {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        } catch {
          // gateway already gone
        }
      }, 1000);
    });
    ctx.fakes.push(fake.close);
    const gw = await createGateway({
      keysPath,
      tokenPath,
      upstreams: gatewayUpstreams(fake.port),
      headerTimeoutMs: 100,
    });
    ctx.gateways.push(gw);
    const port = await listenGateway(gw.server as http.Server);
    const baseUrl = gatewayUrl(port);

    const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "m" }),
    });
    assert.ok([502, 504].includes(res.status), `got ${res.status}`);
    await res.text();
    assert.equal(hits, 1);
  });
});
