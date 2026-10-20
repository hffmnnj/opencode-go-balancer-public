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
};
function readState(value: unknown): State {
  if (!value || typeof value !== "object") throw new Error("Invalid Go router state");
  const s = value as Partial<State>;
  if (s.version !== 1 || !Number.isSafeInteger(s.cutoff) || s.cutoff! < 0 ||
      typeof s.activeAtActivation !== "string" || !s.activeAtActivation ||
      (s.next !== 0 && s.next !== 1) || !s.pins || typeof s.pins !== "object" || Array.isArray(s.pins) ||
      Object.values(s.pins).some(id => typeof id !== "string" || !id)) {
    throw new Error("Invalid Go router state");
  }
  return s as State;
}

export function assertGoDestination(input: string): void {
  const url = new URL(input);
  if (url.origin !== "https://opencode.ai" || url.username || url.password || url.hash ||
      !url.pathname.startsWith("/inference/go/")) throw new Error("Unexpected OpenCode Go destination");
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
    const initial: State = { version: 1, cutoff: now(), activeAtActivation: active.id, next: 0, pins: {} };
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
      };
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
        if (!id) {
          const selectedID = pair[saved.next].id;
          id = selectedID;
          await ctx.storage.set(stateKey, {
            ...saved, next: saved.next === 0 ? 1 : 0, pins: { ...saved.pins, [sessionID]: selectedID },
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
