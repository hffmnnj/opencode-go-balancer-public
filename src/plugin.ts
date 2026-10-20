import { Plugin } from "@opencode/plugin";
import { Rpc } from "@opencode/plugin/rpc";
import { allowedQuery, matchRoute, strippedHeaders } from "./gateway.ts";
import { createConnectionRouter } from "./connections.ts";

export function redirectRequest(request: Request, sessionID: string, token: string, gatewayURL = "http://127.0.0.1:4790"): Request {
  const original = new URL(request.url);
  const prefix = "/inference/go";
  if (original.origin !== "https://opencode.ai" || original.username || original.password || !original.pathname.startsWith(prefix + "/") || request.method !== "POST") return request;
  const path = original.pathname.slice(prefix.length);
  const route = matchRoute(path);
  if (!route || !allowedQuery(original.searchParams, route.protocol)) return request;
  const gateway = new URL(gatewayURL);
  if (gateway.protocol !== "http:" || gateway.hostname !== "127.0.0.1" || gateway.username || gateway.password || gateway.pathname !== "/" || gateway.search || gateway.hash) throw new Error("Gateway must be loopback HTTP");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Invalid local token");
  const headers = strippedHeaders(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("x-opencode-session")) headers.set("x-opencode-session", sessionID);
  // Reuse the one-shot body; do not clone/tee or parse compressed payloads.
  const init: RequestInit & { duplex: "half" } = {
    method: request.method, headers, body: request.body, signal: request.signal,
    redirect: "error", duplex: "half",
  };
  return new Request(gateway.origin + path + original.search, init);
}

export default Plugin.define({
  id: "opencode-go-balancer",
  async setup(ctx) {
    if (ctx.options.enabled !== true) return;
    const router = createConnectionRouter(ctx);
    await router.initialize();
    await ctx.rpc.register(Rpc.define({
      id: "go-router",
      methods: {
        status: {
          input: { type: "object", properties: { sessionID: { type: "string" } }, additionalProperties: false },
          output: {
            type: "object",
            properties: {
              cutoff: { type: "integer" }, nextConnection: { type: "string", enum: ["Default", "Secondary"] },
              pinnedSessions: { type: "integer" }, connectionID: { type: ["string", "null"] },
              cooldowns: { type: "object", additionalProperties: { type: "integer" } },
            },
            required: ["cutoff", "nextConnection", "pinnedSessions", "connectionID", "cooldowns"], additionalProperties: false,
          },
        },
      },
      events: {},
    }), {
      status: async input => router.status((input as { sessionID?: string }).sessionID),
    });
    await ctx.session.hook("http.request", async event => {
      if (event.model.providerID !== "opencode-go") return;
      const headers = await router.headers(event.sessionID, event.request.url);
      if (!headers) return;
      // Preserve the original one-shot request and cancellation; never rewrite its body.
      headers.forEach((value, key) => event.request.headers.set(key, value));
    }, { providerID: "opencode-go" });
    await ctx.session.hook("http.response", async event => {
      if (event.model.providerID !== "opencode-go") return;
      // Only managed HTTP 429 evidence cools an account down. Never consume,
      // replace, clone or alter the response or its body here.
      if (event.response.status !== 429) return;
      await router.recordLimit(event.sessionID, event.request.url, event.response.headers.get("retry-after"));
    }, { providerID: "opencode-go" });
    await ctx.session.hook("experimental.ws.handshake", async event => {
      if (event.model.providerID === "opencode-go") await router.rejectUnsupportedWebSocket(event.sessionID);
    }, { providerID: "opencode-go" });
  },
});
