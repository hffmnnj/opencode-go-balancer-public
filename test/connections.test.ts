import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConnectionInfo } from "@opencode/client";
import { Credential, Integration } from "@opencode/plugin";
import { createConnectionRouter, type RouterContext } from "../src/connections.ts";

const destination = "https://opencode.ai/inference/go/openai/v1/chat/completions";
function fixture() {
  const values = new Map<string, Parameters<RouterContext["storage"]["set"]>[1]>();
  const resolved: string[] = [];
  let connections: ConnectionInfo[] = [
    { type: "credential", id: "default-id", label: "Default", method: "oauth" },
    { type: "credential", id: "secondary-id", label: "Secondary", method: "oauth" },
  ];
  let failResolve = false;
  let missing = false;
  let failWrite = false;
  const ctx: RouterContext = {
    storage: {
      get: async key => structuredClone(values.get(key)),
      set: async (key, value) => {
        if (failWrite) throw new Error("disk unavailable");
        values.set(key, structuredClone(value));
      },
    },
    integration: {
      get: async () => ({ data: { connections } }),
      connection: {
        active: async () => connections.find(c => c.type === "credential" && c.id === "secondary-id"),
        resolve: async c => {
          assert.equal(c.type, "credential");
          if (c.type !== "credential") throw new Error("not saved");
          resolved.push(c.id);
          assert.match(JSON.stringify(values.get("connections/v1")), new RegExp(c.id));
          if (failResolve) throw new Error("native refresh failed");
          if (missing) return undefined;
          return Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("device"), access: `token-${c.id}`,
            refresh: "unused-native-only", expires: 1_000_000_000,
            metadata: { server: "https://opencode.ai/console", orgID: `workspace-${c.id}` } });
        },
      },
    },
    session: { get: async ({ sessionID }) => ({ time: { created: sessionID.startsWith("old") ? 99 : 101 } }) },
  };
  return { ctx, values, resolved, setConnections: (c: ConnectionInfo[]) => { connections = c; },
    failResolve: () => { failResolve = true; }, missing: () => { missing = true; },
    failWrite: () => { failWrite = true; } };
}

test("new concurrent sessions alternate, repeated calls and a second router retain pins", async () => {
  const f = fixture();
  const a = createConnectionRouter(f.ctx, () => 100);
  const b = createConnectionRouter({ ...f.ctx, storage: { ...f.ctx.storage } }, () => 900);
  await Promise.all([a.initialize(), b.initialize()]);
  const headers = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? b : a).headers(`new-${i}`, destination)));
  assert.deepEqual(headers.map(h => h?.get("authorization")), [
    "Bearer token-default-id", "Bearer token-secondary-id", "Bearer token-default-id", "Bearer token-secondary-id",
    "Bearer token-default-id", "Bearer token-secondary-id", "Bearer token-default-id", "Bearer token-secondary-id",
  ]);
  for (const router of [a, b]) {
    assert.equal((await router.headers("new-0", destination))?.get("x-opencode-org-id"), "workspace-default-id");
  }
  assert.equal((await a.headers("next", destination))?.get("authorization"), "Bearer token-default-id");
  assert.deepEqual(await f.ctx.integration.connection.active("opencode"),
    { type: "credential", id: "secondary-id", label: "Secondary", method: "oauth" });
  assert.equal(JSON.stringify([...f.values]).includes("token-"), false);
  assert.equal(JSON.stringify([...f.values]).includes("unused-native-only"), false);
});

test("historical sessions remain unmanaged after reload and do not consume allocations", async () => {
  const f = fixture();
  await createConnectionRouter(f.ctx, () => 100).initialize();
  const router = createConnectionRouter(f.ctx, () => 1000);
  await router.initialize();
  assert.equal(await router.headers("old-running", destination), undefined);
  assert.deepEqual(f.resolved, []);
  assert.equal((await router.headers("new", destination))?.get("authorization"), "Bearer token-default-id");
});

test("a failed or missing pinned resolve never falls back to the active account", async () => {
  for (const failure of ["throw", "missing"] as const) {
    const f = fixture();
    const router = createConnectionRouter(f.ctx, () => 100);
    await router.initialize();
    await router.headers("new", destination);
    failure === "throw" ? f.failResolve() : f.missing();
    await assert.rejects(router.headers("new", destination), failure === "throw" ? /native refresh failed/ : /unusable/);
    assert.deepEqual(f.resolved, ["default-id", "default-id"]);
  }
});

test("removed pinned identity and ambiguous names fail closed", async () => {
  const f = fixture();
  const router = createConnectionRouter(f.ctx, () => 100);
  await router.initialize();
  await router.headers("new", destination);
  f.setConnections([
    { type: "credential", id: "replacement", label: "Default", method: "oauth" },
    { type: "credential", id: "secondary-id", label: "Secondary", method: "oauth" },
  ]);
  await assert.rejects(router.headers("new", destination), /Pinned Go connection is missing/);
  f.setConnections([
    { type: "credential", id: "one", label: "Default", method: "oauth" },
    { type: "credential", id: "two", label: "Default", method: "oauth" },
    { type: "credential", id: "three", label: "Secondary", method: "oauth" },
  ]);
  await assert.rejects(router.headers("another", destination), /one saved OAuth connection named Default/);
  assert.deepEqual(f.resolved, ["default-id"]);
});

test("durable allocation must succeed before a secret is resolved", async () => {
  const f = fixture();
  const router = createConnectionRouter(f.ctx, () => 100);
  await router.initialize();
  f.failWrite();
  await assert.rejects(router.headers("new", destination), /disk unavailable/);
  assert.deepEqual(f.resolved, []);
});

test("unsupported WebSocket cannot bypass a new pin or consume an allocation; historical sessions are unmanaged", async () => {
  const f = fixture();
  const router = createConnectionRouter(f.ctx, () => 100);
  await router.initialize();
  await router.rejectUnsupportedWebSocket("old");
  await assert.rejects(router.rejectUnsupportedWebSocket("new"), /requires native HTTP/);
  assert.deepEqual(f.resolved, []);
  assert.equal((await router.headers("other", destination))?.get("authorization"), "Bearer token-default-id");
  await assert.rejects(router.rejectUnsupportedWebSocket("other"), /requires native HTTP/);
});

test("unexpected Go destinations are rejected before reading or resolving credentials", async () => {
  const f = fixture();
  const router = createConnectionRouter(f.ctx, () => 100);
  for (const url of ["http://opencode.ai/inference/go/a", "https://evil.test/inference/go/a",
    "https://opencode.ai/inference/zen/a", "https://user@opencode.ai/inference/go/a"]) {
    await assert.rejects(router.headers("new", url), /Unexpected OpenCode Go destination/);
  }
  assert.deepEqual(f.resolved, []);
  assert.equal(f.values.size, 0);
  assert.equal((await router.headers("new", destination))?.get("authorization"), "Bearer token-default-id");
});

function savedPins(f: ReturnType<typeof fixture>) {
  return f.values.get("connections/v1") as unknown as {
    pins: Record<string, string>; next: 0 | 1; cooldowns?: Record<string, number>;
  };
}

test("a cooled Default repins to Secondary before resolving and stays there after reload and expiry", async () => {
  const f = fixture();
  let t = 100;
  const router = createConnectionRouter(f.ctx, () => t);
  await router.initialize();
  assert.equal((await router.headers("a", destination))?.get("authorization"), "Bearer token-default-id");
  assert.equal((await router.headers("b", destination))?.get("authorization"), "Bearer token-secondary-id");
  assert.deepEqual((await router.status()).cooldowns, {});
  // A managed 429 for the session pinned to Default cools that account for 120s.
  await router.recordLimit("a", destination, "120", "default-id");
  assert.deepEqual((await router.status()).cooldowns, { "default-id": 120_100 });
  t = 200;
  // The cursor points at Default, yet new sessions skip the cooled account.
  assert.equal((await router.headers("c", destination))?.get("authorization"), "Bearer token-secondary-id");
  assert.equal((await router.headers("d", destination))?.get("authorization"), "Bearer token-secondary-id");
  const rerouted = await router.headers("a", destination);
  assert.equal(rerouted?.get("authorization"), "Bearer token-secondary-id");
  assert.equal(rerouted?.get("x-opencode-org-id"), "workspace-secondary-id");
  assert.deepEqual(savedPins(f).pins, { a: "secondary-id", b: "secondary-id", c: "secondary-id", d: "secondary-id" });
  t = 130_000;
  const reloaded = createConnectionRouter(f.ctx, () => t);
  assert.equal((await reloaded.headers("a", destination))?.get("authorization"), "Bearer token-secondary-id");
  // The healthy pinned session is unaffected.
  assert.equal((await router.headers("b", destination))?.get("x-opencode-org-id"), "workspace-secondary-id");
});

test("a cooled Secondary is skipped once the cursor points at it", async () => {
  const f = fixture();
  let t = 100;
  const router = createConnectionRouter(f.ctx, () => t);
  await router.initialize();
  assert.equal((await router.headers("a", destination))?.get("authorization"), "Bearer token-default-id");
  assert.equal((await router.headers("b", destination))?.get("authorization"), "Bearer token-secondary-id");
  await router.recordLimit("b", destination, "120", "secondary-id");
  t = 200;
  // Cursor points at Default, which is healthy, so alternation continues.
  assert.equal((await router.headers("c", destination))?.get("authorization"), "Bearer token-default-id");
  // Cursor now points at cooled Secondary, so the new session skips to Default.
  assert.equal((await router.headers("d", destination))?.get("authorization"), "Bearer token-default-id");
  const retried = await router.headers("b", destination);
  assert.equal(retried?.get("authorization"), "Bearer token-default-id");
  assert.equal(retried?.get("x-opencode-org-id"), "workspace-default-id");
  assert.deepEqual(savedPins(f).pins, { a: "default-id", b: "default-id", c: "default-id", d: "default-id" });
});

test("both cooled accounts still route to the earliest expiry and preserve pins on equal deadlines", async () => {
  const f = fixture();
  let t = 100;
  const router = createConnectionRouter(f.ctx, () => t);
  await router.initialize();
  await router.headers("a", destination);
  await router.headers("b", destination);
  await router.recordLimit("a", destination, "120", "default-id");
  await router.recordLimit("b", destination, "300", "secondary-id");
  t = 200;
  assert.equal((await router.headers("c", destination))?.get("authorization"), "Bearer token-default-id");
  assert.equal((await router.headers("b", destination))?.get("authorization"), "Bearer token-default-id");
  assert.deepEqual(savedPins(f).pins, { a: "default-id", b: "default-id", c: "default-id" });
  assert.equal(await router.hasHealthyConnection("a"), false);
  t = 100;
  await router.recordLimit("a", destination, "300", "default-id");
  assert.equal((await router.headers("a", destination))?.get("authorization"), "Bearer token-default-id");
  // The allocation cursor points at Secondary. A tied, cooled Secondary pin
  // must remain Secondary too, rather than always preferring Default.
  assert.equal((await router.headers("d", destination))?.get("authorization"), "Bearer token-secondary-id");
  assert.equal((await router.headers("d", destination))?.get("authorization"), "Bearer token-secondary-id");
});

test("expired cooldowns restore normal alternation", async () => {
  const f = fixture();
  let t = 100;
  const router = createConnectionRouter(f.ctx, () => t);
  await router.initialize();
  await router.headers("a", destination);
  // Zero seconds still cools for one second instead of allowing an immediate retry loop.
  await router.recordLimit("a", destination, "0", "default-id");
  assert.deepEqual((await router.status()).cooldowns, { "default-id": 1100 });
  t = 500;
  assert.equal((await router.headers("b", destination))?.get("authorization"), "Bearer token-secondary-id");
  t = 2000;
  assert.equal((await router.headers("c", destination))?.get("authorization"), "Bearer token-default-id");
  assert.equal((await router.headers("a", destination))?.get("authorization"), "Bearer token-default-id");
});

test("retry-after accepts seconds and HTTP dates, keeps the later deadline, and falls back to 60s", async () => {
  const f = fixture();
  const t = 100;
  const router = createConnectionRouter(f.ctx, () => t);
  await router.initialize();
  await router.headers("a", destination);
  await router.recordLimit("a", destination, "120", "default-id");
  assert.deepEqual((await router.status()).cooldowns, { "default-id": 120_100 });
  // A shorter valid delay never shortens the existing later deadline.
  await router.recordLimit("a", destination, "60", "default-id");
  assert.deepEqual((await router.status()).cooldowns, { "default-id": 120_100 });
  // Garbage never shortens it either: the 60s fallback loses to the later deadline.
  await router.recordLimit("a", destination, "not-a-retry-after", "default-id");
  assert.deepEqual((await router.status()).cooldowns, { "default-id": 120_100 });
  // A legitimate long delay is honored without an arbitrary cap.
  await router.recordLimit("a", destination, "3600", "default-id");
  assert.deepEqual((await router.status()).cooldowns, { "default-id": 3_600_100 });

  const dated = fixture();
  const drouter = createConnectionRouter(dated.ctx, () => t);
  await drouter.initialize();
  await drouter.headers("a", destination);
  await drouter.recordLimit("a", destination, new Date(9_000).toUTCString(), "default-id");
  assert.deepEqual((await drouter.status()).cooldowns, { "default-id": 9_000 });
  // A date at or before now cools for one second instead of expiring immediately.
  await drouter.recordLimit("a", destination, new Date(50).toUTCString(), "default-id");
  assert.deepEqual((await drouter.status()).cooldowns, { "default-id": 9_000 });

  for (const retryAfter of ["banana", "-5", "", "   ", "9000000000000", "99999999999999999999", "Infinity", null]) {
    const g = fixture();
    const grouter = createConnectionRouter(g.ctx, () => t);
    await grouter.initialize();
    await grouter.headers("a", destination);
    await grouter.recordLimit("a", destination, retryAfter, "default-id");
    assert.deepEqual((await grouter.status()).cooldowns, { "default-id": 60_100 }, `fallback for ${String(retryAfter)}`);
  }
});

test("legacy state without cooldowns migrates unchanged and cooldowns survive reload", async () => {
  const f = fixture();
  f.values.set("connections/v1", {
    version: 1, cutoff: 100, activeAtActivation: "secondary-id", next: 0, pins: { a: "default-id" },
  });
  let t = 100;
  const router = createConnectionRouter(f.ctx, () => t);
  await router.initialize();
  assert.deepEqual(await router.status("a"), {
    cutoff: 100, nextConnection: "Default", pinnedSessions: 1, connectionID: "default-id", cooldowns: {},
  });
  await router.recordLimit("a", destination, "120", "default-id");
  const reloaded = createConnectionRouter(f.ctx, () => t);
  await reloaded.initialize();
  t = 200;
  assert.equal((await reloaded.headers("a", destination))?.get("authorization"), "Bearer token-secondary-id");
  assert.equal((await reloaded.headers("b", destination))?.get("authorization"), "Bearer token-secondary-id");
  assert.deepEqual(f.resolved, ["secondary-id", "secondary-id"]);
});

test("malformed cooldown maps are rejected", async () => {
  for (const cooldowns of [{ "default-id": "soon" }, { "default-id": 1.5 }, { "default-id": -1 },
    { "default-id": 9_000_000_000_000_000 }, ["x"], null, 42]) {
    const f = fixture();
    f.values.set("connections/v1", {
      version: 1, cutoff: 100, activeAtActivation: "secondary-id", next: 0, pins: {}, cooldowns,
    });
    await assert.rejects(createConnectionRouter(f.ctx, () => 100).initialize(), /Invalid Go router state/);
  }
});

test("concurrent repins are durable before resolving and never change global activation or the cursor", async () => {
  const f = fixture();
  const router = createConnectionRouter(f.ctx, () => 100);
  await router.initialize();
  await router.headers("a", destination);
  await router.recordLimit("a", destination, "120", "default-id");
  const resolve = f.ctx.integration.connection.resolve;
  f.ctx.integration.connection = {
    ...f.ctx.integration.connection,
    resolve: async connection => {
      assert.equal(savedPins(f).pins.a, "secondary-id");
      return resolve(connection);
    },
  };
  const reloaded = createConnectionRouter(f.ctx, () => 100);
  const results = await Promise.all([router.headers("a", destination), reloaded.headers("a", destination)]);
  assert.deepEqual(results.map(h => [h?.get("authorization"), h?.get("x-opencode-org-id")]), [
    ["Bearer token-secondary-id", "workspace-secondary-id"], ["Bearer token-secondary-id", "workspace-secondary-id"],
  ]);
  assert.equal(savedPins(f).next, 1);
  assert.deepEqual(await f.ctx.integration.connection.active("opencode"),
    { type: "credential", id: "secondary-id", label: "Secondary", method: "oauth" });
});

test("failed durable repin and native refresh fail closed without resolving a fallback account", async () => {
  for (const failure of ["write", "refresh"] as const) {
    const f = fixture();
    const router = createConnectionRouter(f.ctx, () => 100);
    await router.headers("a", destination);
    await router.recordLimit("a", destination, "120", "default-id");
    if (failure === "write") f.failWrite(); else f.failResolve();
    await assert.rejects(router.headers("a", destination), failure === "write" ? /disk unavailable/ : /native refresh failed/);
    assert.deepEqual(f.resolved, failure === "write" ? ["default-id"] : ["default-id", "secondary-id"]);
    assert.equal(savedPins(f).pins.a, failure === "write" ? "default-id" : "secondary-id");
  }
});

test("limits are ignored for sessions without a pin and invalid destinations are rejected first", async () => {
  const f = fixture();
  const router = createConnectionRouter(f.ctx, () => 100);
  await router.initialize();
  await router.recordLimit("unknown", destination, "120", "default-id");
  await router.recordLimit("old-nothing", destination, "120", "default-id");
  assert.deepEqual((await router.status()).cooldowns, {});
  assert.equal(f.values.size, 1);
  await assert.rejects(router.recordLimit("unknown", "https://evil.test/inference/go/a", "120", "default-id"), /Unexpected OpenCode Go destination/);
  assert.equal(f.values.size, 1);
  await router.headers("a", destination);
  const before = JSON.stringify(f.values.get("connections/v1"));
  await assert.rejects(router.recordLimit("a", "http://opencode.ai/inference/go/a", "5", "default-id"), /Unexpected OpenCode Go destination/);
  assert.equal(JSON.stringify(f.values.get("connections/v1")), before);
  assert.deepEqual((await router.status()).cooldowns, {});
});
