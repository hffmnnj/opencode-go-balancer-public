import http from "node:http";
import https from "node:https";
import { constants, openSync, fstatSync, readFileSync, closeSync, watchFile, unwatchFile } from "node:fs";
import { timingSafeEqual } from "node:crypto";

export interface GatewayOptions {
  keysPath: string;
  tokenPath: string;
  upstreams?: { openai: string; anthropic: string; google: string };
  maxBodyBytes?: number;
  headerTimeoutMs?: number;
  chunkTimeoutMs?: number;
  now?: () => number;
}
type Protocol = "openai" | "anthropic" | "google";
interface Key { readonly label: string; readonly key: string; requests: number; until: number }
interface Pool { readonly keys: Key[]; next: number }
export const upstreamDefaults = {
  openai: "https://opencode.ai/inference/go/openai/v1",
  anthropic: "https://opencode.ai/inference/go/anthropic/v1",
  google: "https://opencode.ai/inference/go/google/v1beta",
} as const;

// Open before inspecting: no symlink following or stat/read replacement race.
export function readPrivateFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 ||
        (process.getuid && stat.uid !== process.getuid()) || stat.size > 64 * 1024) {
      throw new Error("Invalid private file");
    }
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
export function readLocalToken(path: string): string {
  const token = readPrivateFile(path).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Invalid local token");
  return token;
}

const hop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
export function strippedHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  const nominated = (headers.get("connection") ?? "").split(",").map(x => x.trim().toLowerCase());
  for (const name of [...headers.keys()]) {
    if (hop.has(name) || nominated.includes(name) || name === "host" || name === "cookie" || name === "cookie2" ||
        name === "set-cookie" || name === "authorization" || name === "x-api-key" || name === "api-key" ||
        name === "x-goog-api-key" || name === "x-auth-token" || name === "x-opencode-org-id" ||
        name === "openai-organization" || name === "openai-project" || name === "x-organization-id") headers.delete(name);
  }
  return headers;
}
export function matchRoute(path: string): { protocol: Protocol; suffix: string } | undefined {
  if (/^\/openai\/v1\/(chat\/completions|responses(?:\/compact)?)$/.test(path)) return { protocol: "openai", suffix: path.slice("/openai/v1".length) };
  if (path === "/anthropic/v1/messages") return { protocol: "anthropic", suffix: "/messages" };
  if (/^\/google\/v1beta\/models\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}:(generateContent|streamGenerateContent)$/.test(path)) return { protocol: "google", suffix: path.slice("/google/v1beta".length) };
  return undefined;
}
export function allowedQuery(search: URLSearchParams, protocol: Protocol): boolean {
  return [...search].every(([key, value]) => protocol === "google" && key === "alt" && value === "sse") && [...search].length <= 1;
}
function nodeHeaders(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach(item => result.append(name, item));
    else if (value !== undefined) result.set(name, value);
  }
  return result;
}
function json(res: http.ServerResponse, status: number, payload: unknown, extra: Record<string, string> = {}): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store", ...extra });
  res.end(body);
}
function failure(res: http.ServerResponse, status: number, extra?: Record<string, string>): void {
  json(res, status, { error: { message: "Gateway request unavailable", type: "balancer_error" } }, extra);
}

export function createGateway(options: GatewayOptions): { server: http.Server; reloadKeys(): boolean; close(): Promise<void> } {
  const token = Buffer.from(`Bearer ${readLocalToken(options.tokenPath)}`);
  const now = options.now ?? Date.now;
  const maxBody = options.maxBodyBytes ?? 64 * 1024 * 1024;
  const headerTimeout = options.headerTimeoutMs ?? 30_000;
  const chunkTimeout = options.chunkTimeoutMs ?? 300_000;
  for (const limit of [maxBody, headerTimeout, chunkTimeout]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid gateway limit");
  }
  const bases = { ...upstreamDefaults, ...options.upstreams };
  if (options.upstreams) for (const base of Object.values(options.upstreams)) {
    const url = new URL(base);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error("Test upstream must be loopback HTTP");
  }
  let pool: Pool = { keys: [], next: 0 };
  let requests = 0, failovers = 0, active = 0, bufferedBytes = 0;
  const maxBufferedBytes = 128 * 1024 * 1024;
  function reloadKeys(): boolean {
    try {
      const parsed: unknown = JSON.parse(readPrivateFile(options.keysPath));
      if (!parsed || typeof parsed !== "object" || !("keys" in parsed) || !Array.isArray(parsed.keys) || parsed.keys.length > 2) return false;
      const keys: Key[] = [];
      for (const entry of parsed.keys as unknown[]) {
        if (!entry || typeof entry !== "object" || !("key" in entry) || typeof entry.key !== "string" || !("label" in entry) || typeof entry.label !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.label) || Object.keys(entry).some(key => key !== "label" && key !== "key")) return false;
        if (entry.key === "") continue;
        if (!/^[\x21-\x7e]{1,4096}$/.test(entry.key) || keys.some(key => key.key === entry.key || key.label === entry.label)) return false;
        const previous = pool.keys.find(key => key.key === entry.key && key.label === entry.label);
        keys.push({ label: entry.label, key: entry.key, requests: previous?.requests ?? 0, until: previous?.until ?? 0 });
      }
      if (keys.length === pool.keys.length && keys.every((key, i) => key.key === pool.keys[i]?.key && key.label === pool.keys[i]?.label)) return true;
      pool = { keys, next: 0 };
      return true;
    } catch { return false; }
  }
  if (!reloadKeys()) throw new Error("Invalid private key configuration");
  function pick(snapshot: Pool, exclude?: Key): Key | undefined {
    for (let step = 0; step < snapshot.keys.length; step++) {
      const index = (snapshot.next + step) % snapshot.keys.length;
      const key = snapshot.keys[index]!;
      if (key !== exclude && key.until <= now()) { snapshot.next = (index + 1) % snapshot.keys.length; return key; }
    }
    return undefined;
  }
  function cooling(res: http.ServerResponse, snapshot: Pool): void {
    const wait = Math.max(1, Math.ceil(Math.min(...snapshot.keys.map(key => Math.max(0, key.until - now()))) / 1000));
    failure(res, 429, { "retry-after": String(wait) });
  }
  function retryDelay(value: string | string[] | undefined): number {
    if (typeof value !== "string") return 60_000;
    const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : NaN;
    const delay = Number.isNaN(seconds) ? Date.parse(value) - now() : seconds;
    return Number.isFinite(delay) ? Math.max(0, delay) : 60_000;
  }
  async function forward(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, target: URL, protocol: Protocol, key: Key): Promise<boolean> {
    key.requests++;
    const headers = strippedHeaders(nodeHeaders(req.headers));
    headers.set("content-length", String(body.length));
    headers.set(protocol === "anthropic" ? "x-api-key" : protocol === "google" ? "x-goog-api-key" : "authorization", protocol === "openai" ? `Bearer ${key.key}` : key.key);
    return new Promise(resolve => {
      let settled = false;
      let response: http.IncomingMessage | undefined;
      let timer: NodeJS.Timeout;
      const finish = (retry: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        res.off("close", cancel);
        resolve(retry);
      };
      const upstream = (target.protocol === "https:" ? https : http).request(target, { method: "POST", headers: Object.fromEntries(headers) });
      const cancel = () => { response?.destroy(); upstream.destroy(); finish(false); };
      res.once("close", cancel);
      timer = setTimeout(() => { failure(res, 504); cancel(); }, headerTimeout);
      timer.unref();
      upstream.once("response", incoming => {
        response = incoming;
        clearTimeout(timer);
        const status = incoming.statusCode ?? 502;
        if ([401, 403, 429].includes(status)) {
          key.until = Math.max(key.until, now() + (status === 429 ? retryDelay(incoming.headers["retry-after"]) : 300_000));
          // Never consume or expose an upstream rejection body (may contain credentials).
          incoming.destroy(); upstream.destroy(); finish(true); return;
        }
        const outgoing = strippedHeaders(nodeHeaders(incoming.headers));
        res.writeHead(status, Object.fromEntries(outgoing));
        const resetTimer = () => {
          clearTimeout(timer);
          timer = setTimeout(() => { res.destroy(); cancel(); }, chunkTimeout);
          timer.unref();
        };
        resetTimer();
        incoming.on("data", resetTimer);
        incoming.once("end", () => finish(false));
        incoming.once("error", () => { res.destroy(); cancel(); });
        incoming.once("aborted", () => { res.destroy(); cancel(); });
        incoming.pipe(res);
      });
      upstream.once("error", () => { if (!settled) { failure(res, 502); cancel(); } });
      upstream.end(body);
    });
  }
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) { failure(res, 401); req.resume(); return; }
    const raw = req.url ?? "";
    // Reject absolute-form targets, encodings, dot normalization and fragments.
    if (!raw.startsWith("/") || raw.startsWith("//") || /[%\\#]/.test(raw) || raw.includes("/../") || raw.includes("/./")) { failure(res, 400); req.resume(); return; }
    const url = new URL(raw, "http://127.0.0.1");
    if (req.method === "GET" && ["/health", "/status"].includes(url.pathname) && !url.search) {
      json(res, 200, { ok: pool.keys.some(key => key.until <= now()), keys: pool.keys.map(key => ({ label: key.label, requests: key.requests, cooldownMs: Math.max(0, key.until - now()) })), requests, failovers });
      req.resume(); return;
    }
    const route = matchRoute(url.pathname);
    if (!route || !allowedQuery(url.searchParams, route.protocol)) { failure(res, 404); req.resume(); return; }
    if (req.method !== "POST") { failure(res, 405); req.resume(); return; }
    const snapshot = pool;
    if (!snapshot.keys.length) { failure(res, 503); req.resume(); return; }
    if (active >= 32) { failure(res, 503); req.resume(); return; }
    let key = pick(snapshot);
    if (!key) { cooling(res, snapshot); req.resume(); return; }
    active++; requests++;
    let reservedBytes = 0;
    try {
      const body = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0, done = false;
        const timer = setTimeout(() => end(408), headerTimeout);
        timer.unref();
        const cleanup = () => { clearTimeout(timer); req.off("data", data); req.off("end", complete); req.off("aborted", aborted); req.off("error", aborted); res.off("close", aborted); };
        const end = (status: number) => { if (done) return; done = true; cleanup(); failure(res, status); req.resume(); reject(new Error("Body unavailable")); };
        const data = (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBody) { end(413); return; }
          if (bufferedBytes + chunk.length > maxBufferedBytes) { end(503); return; }
          bufferedBytes += chunk.length;
          reservedBytes += chunk.length;
          chunks.push(chunk);
        };
        const complete = () => { if (done) return; done = true; cleanup(); resolve(Buffer.concat(chunks, size)); };
        const aborted = () => end(400);
        req.on("data", data); req.once("end", complete); req.once("aborted", aborted); req.once("error", aborted); res.once("close", aborted);
      });
      if (res.destroyed) return;
      const target = new URL(bases[route.protocol].replace(/\/+$/, "") + route.suffix + url.search);
      const rejected = await forward(req, res, body, target, route.protocol, key);
      if (!rejected || res.destroyed) return;
      const alternative = pick(snapshot, key);
      if (alternative) {
        failovers++;
        key = alternative;
        if (!await forward(req, res, body, target, route.protocol, key) || res.destroyed) return;
      }
      cooling(res, snapshot);
    } catch { failure(res, 400); }
    finally { active--; bufferedBytes -= reservedBytes; }
  }
  const server = http.createServer((req, res) => { void handle(req, res).catch(() => failure(res, 500)); });
  server.headersTimeout = headerTimeout;
  server.requestTimeout = headerTimeout;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("upgrade", (_req, socket) => socket.destroy());
  watchFile(options.keysPath, { interval: 1000, persistent: false }, reloadKeys);
  return {
    server, reloadKeys,
    async close() {
      unwatchFile(options.keysPath, reloadKeys);
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) { resolve(); return; }
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
