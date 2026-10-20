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
            refresh: "unused-native-only", expires: 100_000,
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
