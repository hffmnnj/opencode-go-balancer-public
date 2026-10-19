import { Plugin } from "@opencode/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { allowedQuery, matchRoute, readLocalToken, strippedHeaders } from "./gateway.ts";

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
    const token = readLocalToken(process.env.GO_BALANCER_TOKEN_FILE ?? join(homedir(), ".config/opencode-v2/opencode-go-balancer/local-token"));
    await ctx.session.hook("http.request", event => {
      event.request = redirectRequest(event.request, event.sessionID, token);
    }, { providerID: "opencode-go" });
    // The gateway owns bounded, rejection-only retries. Do not multiply them
    // through the session's default retry loop after an uncertain POST result.
    await ctx.session.hook("retry", event => {
      event.decision = { retry: false };
    }, { providerID: "opencode-go" });
  },
});
