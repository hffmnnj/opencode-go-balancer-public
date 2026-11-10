import { test } from "node:test";
import assert from "node:assert/strict";
import { Credential, Integration, type Plugin } from "@opencode/plugin";
import plugin from "../src/plugin.ts";
import type { RouterContext } from "../src/connections.ts";

type HttpEvent = Parameters<Parameters<Plugin.Context["session"]["hook"]>[1]>[0];
type RequestEvent = Extract<HttpEvent, { request: Request }>;
type ResponseEvent = Extract<HttpEvent, { response: Response }>;
type RetryEvent = Extract<HttpEvent, { decision: unknown }>;
type StatusResult = { cutoff: number; nextConnection: string; pinnedSessions: number; connectionID: string | null; cooldowns: Record<string, number> };

async function fixture() {
  const values = new Map<string, Parameters<RouterContext["storage"]["set"]>[1]>();
  const hooks: string[] = [];
  let request: ((event: RequestEvent) => void | Promise<void>) | undefined;
  let response: ((event: ResponseEvent) => void | Promise<void>) | undefined;
  let retry: ((event: RetryEvent) => void | Promise<void>) | undefined;
  let status: ((input: { sessionID?: string }) => Promise<unknown>) | undefined;
  const ctx = {
    options: { enabled: true },
    rpc: { register: async (_definition: unknown, handlers: { status: typeof status }) => { status = handlers.status; } },
    storage: { get: async (key: string) => values.get(key), set: async (key: string, value: Parameters<RouterContext["storage"]["set"]>[1]) => { values.set(key, value); } },
    integration: {
      get: async () => ({ data: { connections: [
        { type: "credential", id: "d", label: "OpenCode Go", method: "oauth" },
        { type: "credential", id: "s", label: "OpenCode Go 2", method: "oauth" },
      ] } }),
      connection: {
        active: async () => ({ type: "credential", id: "s", method: "oauth", label: "OpenCode Go 2" }),
        resolve: async (c: { id: string }) => Credential.OAuth.make({ type: "oauth", methodID: Integration.MethodID.make("device"), access: `access-${c.id}`,
          refresh: "native", expires: Date.now() + 3600_000, metadata: { orgID: `org-${c.id}`, server: "https://opencode.ai/console" } }),
      },
    },
    credential: { activate: async () => { throw new Error("Global activation is forbidden"); } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ time: { created: sessionID === "old" ? 1 : Date.now() + 1000 } }),
      hook: async (name: string, handler: (...args: never[]) => void | Promise<void>, scope: { providerID: string }) => {
        hooks.push(name);
        assert.deepEqual(scope, { providerID: "opencode-go" });
        if (name === "http.request") request = handler as (event: RequestEvent) => void | Promise<void>;
        if (name === "http.response") response = handler as (event: ResponseEvent) => void | Promise<void>;
        if (name === "retry") retry = handler as (event: RetryEvent) => void | Promise<void>;
      },
    },
  };
  // This fake supplies precisely the capabilities setup uses, not a running native host.
  await plugin.setup(ctx as unknown as Plugin.Context);
  assert.ok(request);
  assert.ok(response);
  assert.ok(status);
  assert.ok(retry);
  return { hooks, call: request, respond: response, retry, status };
}

function responseEvent(sessionID: string, statusCode: number, retryAfter?: string, providerID = "opencode-go") {
  const headers: Record<string, string> = {};
  if (retryAfter !== undefined) headers["retry-after"] = retryAfter;
  return {
    sessionID, kind: "primary", agent: "build", model: { providerID, id: "unchanged-model" },
    request: new Request("https://opencode.ai/inference/go/openai/v1/chat/completions?original=1", { method: "POST", body: "original body" }),
    response: new Response("upstream-body", { status: statusCode, headers }),
  } as ResponseEvent;
}
function event(sessionID: string, kind: "primary" | "title" | "compaction" | "generate" = "primary", providerID = "opencode-go") {
  return {
    sessionID, kind, agent: "build", model: { providerID, id: "unchanged-model" },
    request: new Request("https://opencode.ai/inference/go/openai/v1/chat/completions?original=1", {
      method: "POST", body: "original body", headers: { authorization: "Bearer active-secondary", "x-opencode-org-id": "active-org",
        "x-opencode-session": "original-affinity", "x-other": "keep", "content-type": "application/json" },
    }),
  } as RequestEvent;
}

function retryEvent(sessionID: string, status: number, providerID = "opencode-go"): RetryEvent {
  return { sessionID, agent: "build", model: { providerID, id: "unchanged-model" },
    error: { type: "rate_limit", message: "upstream error", status }, attempt: 2,
    decision: { retry: true, delay: 120_000 } } as RetryEvent;
}

test("auxiliary-first, primary, continuation, title and compaction share one pin; native retries remain enabled", async () => {
  const f = await fixture();
  assert.deepEqual(f.hooks, ["http.request", "http.response", "retry", "experimental.ws.handshake"]);
  for (const kind of ["title", "primary", "primary", "compaction", "generate"] as const) {
    const e = event("one", kind);
    await f.call(e);
    assert.equal(e.request.headers.get("authorization"), "Bearer access-d");
    assert.equal(e.request.headers.get("x-opencode-org-id"), "org-d");
  }
  const second = event("two");
  await f.call(second);
  assert.equal(second.request.headers.get("authorization"), "Bearer access-s");
});

test("status reports durable pins without resolving credentials or allocating sessions", async () => {
  const f = await fixture();
  const before = await f.status({ sessionID: "one" }) as StatusResult;
  assert.deepEqual(before, { cutoff: before.cutoff, nextConnection: "OpenCode Go", pinnedSessions: 0, connectionID: null, cooldowns: {} });
  await f.call(event("one"));
  const after = await f.status({ sessionID: "one" }) as StatusResult;
  assert.deepEqual(after, { cutoff: before.cutoff, nextConnection: "OpenCode Go 2", pinnedSessions: 1, connectionID: "d", cooldowns: {} });
  assert.deepEqual(await f.status({ sessionID: "unknown" }), {
    cutoff: before.cutoff, nextConnection: "OpenCode Go 2", pinnedSessions: 1, connectionID: null, cooldowns: {},
  });
  assert.doesNotMatch(JSON.stringify(after), /access-|org-|refresh/);
});

test("routing preserves URL, body, model, cancellation, session affinity and non-account headers", async () => {
  const f = await fixture();
  const e = event("new");
  const request = e.request;
  const model = e.model;
  const body = request.body;
  const signal = request.signal;
  await f.call(e);
  assert.equal(e.request, request);
  assert.equal(e.request.body, body);
  assert.equal(e.request.signal, signal);
  assert.equal(e.model, model);
  assert.equal(e.request.url, "https://opencode.ai/inference/go/openai/v1/chat/completions?original=1");
  assert.equal(e.request.headers.get("x-opencode-session"), "original-affinity");
  assert.equal(e.request.headers.get("x-other"), "keep");
  assert.equal(await e.request.text(), "original body");
});

test("non-Go and historical-session requests retain their original account headers", async () => {
  const f = await fixture();
  for (const e of [event("new", "primary", "other-provider"), event("old")]) {
    const request = e.request;
    await f.call(e);
    assert.equal(e.request, request);
    assert.equal(e.request.headers.get("authorization"), "Bearer active-secondary");
    assert.equal(e.request.headers.get("x-opencode-org-id"), "active-org");
  }
});

test("a managed 429 redirects native retry to OpenCode Go 2 with paired headers and a durable pin", async () => {
  const f = await fixture();
  const first = event("one");
  await f.call(first);
  // The managed 429 for the session pinned to OpenCode Go cools that account for 120s.
  await f.respond({ ...responseEvent("one", 429, "120"), request: first.request });
  const cooled = await f.status({ sessionID: "one" }) as StatusResult;
  assert.deepEqual(Object.keys(cooled.cooldowns), ["d"]);
  assert.ok(cooled.cooldowns["d"]! > Date.now());
  assert.equal(cooled.connectionID, "d");
  // Cursor pointed at OpenCode Go 2; the next session pins it, then skips cooled OpenCode Go.
  const second = event("two");
  await f.call(second);
  assert.equal(second.request.headers.get("authorization"), "Bearer access-s");
  const third = event("three");
  await f.call(third);
  assert.equal(third.request.headers.get("authorization"), "Bearer access-s");
  assert.equal(third.request.headers.get("x-opencode-org-id"), "org-s");
  const decision = retryEvent("one", 429);
  await f.retry(decision);
  assert.deepEqual(decision.decision, { retry: true, delay: 100 });
  const retry = event("one");
  await f.call(retry);
  assert.equal(retry.request.headers.get("authorization"), "Bearer access-s");
  assert.equal(retry.request.headers.get("x-opencode-org-id"), "org-s");
  assert.equal((await f.status({ sessionID: "one" }) as StatusResult).connectionID, "s");
});

test("only managed 429 responses are recorded and the response is never altered", async () => {
  const f = await fixture();
  const first = event("one");
  await f.call(first);
  // Other statuses, other providers and pin-less sessions record nothing.
  await f.respond(responseEvent("one", 500, "120"));
  await f.respond(responseEvent("one", 403, "120"));
  await f.respond(responseEvent("one", 429, "120", "other-provider"));
  await f.respond(responseEvent("old", 429, "120"));
  await f.respond(responseEvent("never-seen", 429, "120"));
  assert.deepEqual((await f.status({}) as StatusResult).cooldowns, {});
  // A managed 429 records the cooldown without consuming or replacing the response.
  const seen = responseEvent("one", 429, "120");
  Object.assign(seen, { request: first.request });
  const original = seen.response;
  await f.respond(seen);
  assert.equal(seen.response, original);
  assert.equal(seen.response.status, 429);
  assert.equal(seen.response.headers.get("retry-after"), "120");
  assert.equal(await seen.response.text(), "upstream-body");
  const cooled = await f.status({}) as StatusResult;
  assert.deepEqual(Object.keys(cooled.cooldowns), ["d"]);
  assert.ok(cooled.cooldowns["d"]! > Date.now());
  assert.doesNotMatch(JSON.stringify(cooled), /access-|org-|refresh/);
});

test("delayed concurrent 429s cool their actual request account, not the new session pin", async () => {
  const f = await fixture();
  const first = event("one");
  const delayed = event("one", "title");
  await Promise.all([f.call(first), f.call(delayed)]);
  await f.respond({ ...responseEvent("one", 429, "120"), request: first.request });
  const retries = [event("one"), event("one", "compaction")];
  await Promise.all(retries.map(e => f.call(e)));
  for (const e of retries) {
    assert.equal(e.request.headers.get("authorization"), "Bearer access-s");
    assert.equal(e.request.headers.get("x-opencode-org-id"), "org-s");
  }
  await f.respond({ ...responseEvent("one", 429, "300"), request: delayed.request });
  const after = await f.status({ sessionID: "one" }) as StatusResult;
  assert.equal(after.connectionID, "s");
  assert.deepEqual(Object.keys(after.cooldowns), ["d"]);
  await f.respond({ ...responseEvent("one", 429, "400"), request: retries[0]!.request });
  const decision = retryEvent("one", 429);
  await f.retry(decision);
  assert.deepEqual(decision.decision, { retry: true, delay: 120_000 });
  const bothCooled = event("one");
  await f.call(bothCooled);
  assert.equal(bothCooled.request.headers.get("authorization"), "Bearer access-d");
});

test("retry hook leaves auth, network, non-Go and unmanaged retry decisions unchanged", async () => {
  const f = await fixture();
  await f.call(event("one"));
  for (const e of [retryEvent("one", 401), retryEvent("one", 500),
    retryEvent("one", 429, "other-provider"), retryEvent("old", 429), retryEvent("unknown", 429)]) {
    e.decision = { retry: false };
    await f.retry(e);
    assert.deepEqual(e.decision, { retry: false });
  }
});
