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

type Ctx = {
  dir: string;
  files: string[];
  fakes: Array<() => Promise<void>>;
  gateways: Array<{ close: () => Promise<void> }>;
};
const ctx: Ctx = { dir: "", files: [], fakes: [], gateways: [] };

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

async function setupGateway(opts?: {
  keys?: Array<{ label: string; key: string }>;
  token?: string;
  keysMode?: number;
  tokenMode?: number;
}) {
  const dir = makeScratchDir("gw-auth-");
  ctx.dir = dir;
  const keys = opts?.keys ?? [
    { label: LABEL_A, key: KEY_A },
    { label: LABEL_B, key: KEY_B },
  ];
  const token = opts?.token ?? genToken();
  const keysPath = writeKeysFile(dir, keys, opts?.keysMode ?? 0o600);
  const tokenPath = writeTokenFile(dir, token, opts?.tokenMode ?? 0o600);
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
  return { baseUrl: gatewayUrl(port), token, fake, keysPath, tokenPath, gw };
}

describe("gateway local auth", () => {
  it("health_requires_bearer_token_and_returns_shaped_body", async () => {
    const { baseUrl, token } = await setupGateway();

    const noAuth = await fetch(`${baseUrl}/health`);
    assert.equal(noAuth.status, 401);
    await noAuth.text();

    const wrong = await fetch(`${baseUrl}/health`, {
      headers: { authorization: "Bearer wrong-token-that-is-long-enough-0123456789" },
    });
    assert.equal(wrong.status, 401);
    await wrong.text();

    const ok = await fetch(`${baseUrl}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 200);
    const body = await readJsonBody(ok);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.keys));
    assert.equal(body.keys.length, 2);
    for (const entry of body.keys) {
      assert.ok(typeof entry.label === "string");
      assert.ok(typeof entry.requests === "number");
      assert.ok(typeof entry.cooldownMs === "number");
    }
    assert.ok(typeof body.requests === "number");
    assert.ok(typeof body.failovers === "number");
  });

  it("post_requires_bearer_token_without_touching_upstream", async () => {
    const { baseUrl, fake } = await setupGateway();
    assert.equal(fake.hits.length, 0);

    const noAuth = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    assert.equal(noAuth.status, 401);
    await noAuth.text();
    assert.equal(fake.hits.length, 0);

    const wrong = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token-that-is-long-enough-0123456789",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    assert.equal(wrong.status, 401);
    await wrong.text();
    assert.equal(fake.hits.length, 0);
  });

  it("method_path_allowlist_rejects_arbitrary_targets", async () => {
    const { baseUrl, token, fake } = await setupGateway();
    const auth = { authorization: `Bearer ${token}` };

    // Unknown target: must not forward.
    const evil = await fetch(`${baseUrl}/evil`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    assert.ok([404, 405].includes(evil.status), `expected 404/405 got ${evil.status}`);
    await evil.text();

    // Query string must not smuggle an allowlisted path.
    const smuggled = await fetch(`${baseUrl}/evil?x=/openai/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    assert.ok([404, 405].includes(smuggled.status));
    await smuggled.text();

    // Wrong method on an allowlisted path: must not forward.
    const wrongMethod = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      headers: auth,
    });
    assert.ok([404, 405].includes(wrongMethod.status));
    await wrongMethod.text();

    // Wrong method on health: must not succeed.
    const postHealth = await fetch(`${baseUrl}/health`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
    });
    assert.ok([404, 405].includes(postHealth.status));
    await postHealth.text();

    assert.equal(fake.hits.length, 0);
  });

  it("keys_file_must_be_mode_0600", { skip: process.platform === "win32" }, async () => {
    const dir = makeScratchDir("gw-auth-mode-");
    ctx.dir = dir;
    const token = genToken();
    const keysPath = writeKeysFile(
      dir,
      [
        { label: LABEL_A, key: KEY_A },
        { label: LABEL_B, key: KEY_B },
      ],
      0o644,
    );
    const tokenPath = writeTokenFile(dir, token, 0o600);
    ctx.files.push(keysPath, tokenPath);
    assert.throws(() =>
      (createGateway as (...a: never[]) => unknown)({
        keysPath,
        tokenPath,
      } as never),
    );
  });

  it("token_file_must_be_mode_0600_and_min_32_chars", { skip: process.platform === "win32" }, async () => {
    const dir = makeScratchDir("gw-auth-tokmode-");
    ctx.dir = dir;
    const keysPath = writeKeysFile(
      dir,
      [
        { label: LABEL_A, key: KEY_A },
        { label: LABEL_B, key: KEY_B },
      ],
      0o600,
    );
    const shortPath = writeTokenFile(dir, "short", 0o600);
    ctx.files.push(keysPath, shortPath);
    assert.throws(() =>
      (createGateway as (...a: never[]) => unknown)({
        keysPath,
        tokenPath: shortPath,
      } as never),
    );

    const widePath = writeTokenFile(dir, genToken(), 0o644);
    ctx.files.push(widePath);
    assert.throws(() =>
      (createGateway as (...a: never[]) => unknown)({
        keysPath,
        tokenPath: widePath,
      } as never),
    );
  });

  it("duplicate_labels_or_key_material_rejected", async () => {
    const dir = makeScratchDir("gw-auth-dup-");
    ctx.dir = dir;
    const tokenPath = writeTokenFile(dir, genToken(), 0o600);
    ctx.files.push(tokenPath);

    const dupLabel = writeKeysFile(
      dir,
      [
        { label: LABEL_A, key: KEY_A },
        { label: LABEL_A, key: KEY_B },
      ],
      0o600,
    );
    ctx.files.push(dupLabel);
    assert.throws(() =>
      (createGateway as (...a: never[]) => unknown)({
        keysPath: dupLabel,
        tokenPath,
      } as never),
    );

    const dupKey = writeKeysFile(
      dir,
      [
        { label: LABEL_A, key: KEY_A },
        { label: LABEL_B, key: KEY_A },
      ],
      0o600,
    );
    ctx.files.push(dupKey);
    assert.throws(() =>
      (createGateway as (...a: never[]) => unknown)({
        keysPath: dupKey,
        tokenPath,
      } as never),
    );
  });

  it("health_status_never_exposes_secrets", async () => {
    const { baseUrl, token } = await setupGateway();
    const res = await fetch(`${baseUrl}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(KEY_A), "health leaks key A");
    assert.ok(!text.includes(KEY_B), "health leaks key B");
    assert.ok(!text.includes(token), "health leaks bearer token");
    const body = JSON.parse(text);
    for (const entry of body.keys) {
      assert.ok(!("key" in entry), "health key entry must not include secret");
    }
    assert.ok(!("token" in body));
  });
});
