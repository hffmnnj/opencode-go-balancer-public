import type { Plugin } from "@opencode/plugin";
import type { ConnectionInfo } from "@opencode/client";

export interface RouterContext {
  storage: Pick<Plugin.Context["storage"], "get" | "set">;
  integration: {
    get(input: { integrationID: string }): Promise<{ data: { connections: ConnectionInfo[] } }>;
    connection: Pick<Plugin.Context["integration"]["connection"], "active" | "resolve">;
  };
  session: { get(input: { sessionID: string }): Promise<{ time: { created: number } }> };
}
const stateKey = "connections/v1";
const lockKey = Symbol.for("opencode-go-balancer.connections.v1.lock");
type Lock = { tail: Promise<void> };
const shared = globalThis as typeof globalThis & { [lockKey]?: Lock };
// V2 has one host process. Share the queue across location instances and module reloads.
const lock = shared[lockKey] ??= { tail: Promise.resolve() };
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = lock.tail.then(run);
  lock.tail = result.then(() => {}, () => {});
  return result;
}

type State = {
  version: 1;
  cutoff: number;
  activeAtActivation: string;
  next: 0 | 1;
  pins: Record<string, string>;
  cooldowns: Record<string, number>;
};
// Safe integers can exceed Date's range; every saved deadline must format as ISO.
const maximumDateMs = 8_640_000_000_000_000;
function readState(value: unknown): State {
  if (!value || typeof value !== "object") throw new Error("Invalid Go router state");
  const s = value as Partial<State>;
  if (s.version !== 1 || !Number.isSafeInteger(s.cutoff) || s.cutoff! < 0 ||
      typeof s.activeAtActivation !== "string" || !s.activeAtActivation ||
      (s.next !== 0 && s.next !== 1) || !s.pins || typeof s.pins !== "object" || Array.isArray(s.pins) ||
      Object.values(s.pins).some(id => typeof id !== "string" || !id)) {
    throw new Error("Invalid Go router state");
  }
  // Missing map predates the cooldown extension; default to empty so saved
  // pins, cursor and cutoff migrate unchanged. Reject malformed maps.
  let cooldowns: Record<string, number> = {};
  if (s.cooldowns !== undefined) {
    if (!s.cooldowns || typeof s.cooldowns !== "object" || Array.isArray(s.cooldowns) ||
        Object.entries(s.cooldowns).some(([id, until]) => !id || !Number.isSafeInteger(until) ||
          (until as number) < 0 || (until as number) > maximumDateMs)) {
      throw new Error("Invalid Go router state");
    }
    cooldowns = { ...(s.cooldowns as Record<string, number>) };
  }
  return { ...(s as State), cooldowns };
}

export function assertGoDestination(input: string): void {
  const url = new URL(input);
  if (url.origin !== "https://opencode.ai" || url.username || url.password || url.hash ||
      !url.pathname.startsWith("/inference/go/")) throw new Error("Unexpected OpenCode Go destination");
}

const cooldownFallbackMs = 60_000;
const cooldownMinimumMs = 1_000;
function retryDelayMs(raw: string | null | undefined, t: number): number {
  if (typeof raw !== "string") return cooldownFallbackMs;
  const text = raw.trim();
  if (!text) return cooldownFallbackMs;
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds < 0) return cooldownFallbackMs;
    const delay = seconds * 1000;
    if (!Number.isFinite(delay) || delay > maximumDateMs - t) return cooldownFallbackMs;
    return Math.max(cooldownMinimumMs, Math.ceil(delay));
  }
  const date = Date.parse(text);
  if (!Number.isSafeInteger(date)) return cooldownFallbackMs;
  if (date <= t) return cooldownMinimumMs;
  if (date > Number.MAX_SAFE_INTEGER) return cooldownFallbackMs;
  return Math.max(cooldownMinimumMs, date - t);
}

export function createConnectionRouter(ctx: RouterContext, now: () => number = Date.now) {
  async function connections() {
    const integration = await ctx.integration.get({ integrationID: "opencode" });
    const pair = ["Default", "Secondary"].map(label => {
      const matches = integration.data.connections.filter(c => c.type === "credential" && c.label === label);
      const match = matches[0];
      if (matches.length !== 1 || match.type !== "credential" || match.method !== "oauth") {
        throw new Error(`Go router requires one saved OAuth connection named ${label}`);
      }
      return match;
    });
    if (pair[0].id === pair[1].id) throw new Error("Go connections must be distinct");
    return pair;
  }
  async function state(): Promise<State> {
    const saved = await ctx.storage.get(stateKey);
    if (saved !== undefined) return readState(saved);
    await connections();
    const active = await ctx.integration.connection.active("opencode");
    if (active?.type !== "credential" || active.method !== "oauth") throw new Error("Expected an active OpenCode OAuth connection");
    const initial: State = { version: 1, cutoff: now(), activeAtActivation: active.id, next: 0, pins: {}, cooldowns: {} };
    await ctx.storage.set(stateKey, initial);
    return initial;
  }
  return {
    initialize: () => exclusive(async () => { await state(); await connections(); }),
    status: (sessionID?: string) => exclusive(async () => {
      const saved = await state();
      return {
        cutoff: saved.cutoff,
        nextConnection: saved.next === 0 ? "Default" : "Secondary",
        pinnedSessions: Object.keys(saved.pins).length,
        connectionID: sessionID && Object.hasOwn(saved.pins, sessionID) ? saved.pins[sessionID] : null,
        cooldowns: { ...saved.cooldowns },
      };
    }),
    recordLimit: (sessionID: string, destination: string, retryAfter: string | null | undefined) => exclusive(async () => {
      // Validate before touching state; never log the header or credentials.
      assertGoDestination(destination);
      const saved = await state();
      // Sessions without a pin are unmanaged or historical: nothing to cool down.
      const pinned = Object.hasOwn(saved.pins, sessionID) ? saved.pins[sessionID] : undefined;
      if (!pinned) return;
      const t = now();
      const deadline = t + retryDelayMs(retryAfter, t);
      const until = Math.max(saved.cooldowns[pinned] ?? 0, deadline);
      if (!Number.isSafeInteger(until)) return;
      await ctx.storage.set(stateKey, { ...saved, cooldowns: { ...saved.cooldowns, [pinned]: until } });
    }),
    rejectUnsupportedWebSocket: (sessionID: string) => exclusive(async () => {
      const saved = await state();
      if (!Object.hasOwn(saved.pins, sessionID)) {
        const session = await ctx.session.get({ sessionID });
        if (Number.isFinite(session.time.created) && session.time.created <= saved.cutoff) return;
      }
      // V2's HTTP hook does not intercept a WebSocket handshake. Never bypass a pin.
      throw new Error("Pinned Go routing requires native HTTP transport");
    }),
    async headers(sessionID: string, destination: string): Promise<Headers | undefined> {
      // Never resolve a secret for a configurable or redirected destination.
      assertGoDestination(destination);
      return exclusive(async () => {
        const saved = await state();
        let id = Object.hasOwn(saved.pins, sessionID) ? saved.pins[sessionID] : undefined;
        if (!id) {
          const session = await ctx.session.get({ sessionID });
          if (!Number.isFinite(session.time.created)) throw new Error("Missing session creation time");
          // Historical Go identity is not recorded by V2. Do not assert an unknown pin.
          if (session.time.created <= saved.cutoff) return undefined;
        }
        const pair = await connections();
        if (id) {
          const pinned: ConnectionInfo | undefined = pair.find(c => c.id === id);
          if (!pinned) throw new Error("Pinned Go connection is missing or renamed");
          const until = saved.cooldowns[id] ?? 0;
          // Never move a running session: fail its requests clearly while its
          // account cools down instead of resolving, reallocating or switching.
          if (until > now()) {
            throw new Error(`Go connection ${pinned.label} is rate-limited until ${new Date(until).toISOString()}; session keeps its pinned connection`);
          }
        } else {
          const t = now();
          const order = [pair[saved.next], pair[saved.next === 0 ? 1 : 0]];
          const chosen = order.find(c => (saved.cooldowns[c.id] ?? 0) <= t);
          if (!chosen) {
            const earliest = Math.min(saved.cooldowns[pair[0].id] ?? 0, saved.cooldowns[pair[1].id] ?? 0);
            throw new Error(`All Go connections are rate-limited until ${new Date(earliest).toISOString()}; no session pin allocated`);
          }
          id = chosen.id;
          await ctx.storage.set(stateKey, {
            ...saved, next: chosen.id === pair[0].id ? 1 : 0, pins: { ...saved.pins, [sessionID]: chosen.id },
          });
        }
        const connection: ConnectionInfo | undefined = pair.find(c => c.id === id);
        if (!connection) throw new Error("Pinned Go connection is missing or renamed");
        const value = await ctx.integration.connection.resolve(connection);
        if (value?.type !== "oauth" || !value.access || value.expires <= now() ||
            value.metadata?.server !== "https://opencode.ai/console" ||
            typeof value.metadata.orgID !== "string" || !value.metadata.orgID) {
          throw new Error("Pinned Go OAuth connection is unusable");
        }
        return new Headers({ authorization: `Bearer ${value.access}`, "x-opencode-org-id": value.metadata.orgID });
      });
    },
  };
}
