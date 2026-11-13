# opencode-go-balancer

![OpenCode Go Balancer](assets/banner.png)

Account-based, session-pinned router for the `opencode-go` provider in OpenCode
V2. It alternates new Go sessions between two saved Go connections and keeps
each session on its chosen connection unless an explicit HTTP 429 requires a
redirect. It runs inside the existing host through native scoped HTTP hooks and
native credential resolution: no local gateway, second listener, or copied
token store.

Contract: [`docs/SPEC.md`](docs/SPEC.md). Activation, verification, and rollback:
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## Requirements

- OpenCode V2 2.0.32.
- One single main host process. Do not launch a second host.
- Two distinct saved OpenCode Go connections for the configured labels, on the
  Go integration named by `integrationID`. Each label must match exactly one
  saved OAuth or key connection.
- The default labels are `OpenCode Go` and `OpenCode Go 2` in primary/secondary
  order; the default `integrationID` is `opencode-go`.
- Node.js 26 or newer for local checks.

## Install

The plugin is loaded from an absolute directory. No npm package is published.

Back up the global configuration, then append this entry to its existing
`plugins` array without changing other entries:

```json
{
  "package": "/absolute/path/to/opencode-go-balancer",
  "options": { "enabled": true }
}
```

`enabled` must be `true`; the plugin does nothing otherwise. Optional settings:

- `connectionLabels`: two distinct nonempty strings in primary/secondary order.
  Defaults to `["OpenCode Go", "OpenCode Go 2"]`.
- `integrationID`: a nonempty integration ID. Defaults to `opencode-go`.

Use the configuration watcher; do not restart the host. Leave the globally
active connection unchanged. A successful first activation saves a cutoff.
Sessions created at or before that cutoff remain unmanaged because V2 cannot
establish their historical account identity.

## Routing behavior

- Alternate new Go agent sessions once at first Go HTTP dispatch, skipping a
  locally cooled connection when the other is healthy. Titles and compaction
  share the session's allocation.
- Keep the selected connection sticky across normal requests and plugin
  reloads.
- On a managed HTTP 429, redirect the next request or native retry to the
  healthy other connection and persist that selection. The session does not
  switch back merely because the original cooldown expires.
- If both connections are locally limited, choose the one with the earliest
  deadline; on equal deadlines the preferred connection wins. Do not raise a
  local cooldown exception. Genuine upstream limits still use native
  retry/backoff; redirection cannot manufacture quota.
- Resolve each pinned connection by saved connection ID through OpenCode's
  native lifecycle, including OAuth refresh and native key credentials. Replace
  the Bearer and `x-opencode-org-id` headers together for OAuth connections. No
  copied tokens or local key files.
- Leave sessions created at or before the activation cutoff unmanaged. Do not
  rewrite their credentials or assign them a new account.
- Do not change non-Go providers or model choices.

## State and safeguards

- The router never changes the globally active connection and never activates
  one globally.
- Pins, the round-robin cursor, the first-activation cutoff, and cooldowns live
  in native plugin storage and survive reloads. Plugin storage is stateful; keep
  the plugin entry and configured connection labels stable.
- A process-global queue serializes allocations across location instances.
- Do not delete plugin storage to bypass a cooldown. Deleting it loses pins,
  the cursor, the cutoff, and cooldown deadlines.
- Removing or renaming a required connection fails closed for new and pinned
  sessions. Missing, expired, or unusable native credentials also fail closed.

## Rate limits and failure policy

- Record cooldowns only from managed HTTP 429 responses. Do not consume, clone,
  replace, or otherwise alter the response or its body.
- Attribute a delayed response to the connection that actually served the
  request, not to a pin that changed after dispatch.
- Respect valid `Retry-After` seconds or HTTP dates, with a 1-second minimum and
  a 60-second fallback when the header is absent or invalid. Keep the later
  deadline when rejections overlap.
- Accelerate a native retry only when another saved connection is healthy.
  Native retry policy remains responsible for genuine upstream failures.
- Redirect on explicit rate limits only. Auth failures, malformed router state,
  unsafe destinations, and missing or ambiguous saved connections still fail
  closed.
- No API-key gateway, additional listener, copied credential store, custom
  fetch/replay loop, or active quota probing.

## Operational limits

- Native initialization can depend on the globally active connection before
  request hooks run. A failure there can block a healthy pinned connection.
- Managed sessions require HTTP. A WebSocket dispatch for a managed session is
  rejected rather than silently bypassing its pin. Current Go routes use native
  HTTP.
- Only explicit HTTP 429 responses are handled; errors inside an HTTP 200
  stream are not.
- A reload between dispatch and response can lose that request's cooldown
  evidence. It cannot attribute the cooldown to another connection.
- Live upstream HTTP 429 recovery remains unverified. Fake-hook tests are not
  live dispatch evidence, and native retry limits still apply.

## Verify

The authenticated, read-only RPC is `POST /api/rpc/go-router/status` with body
`{"input":{"sessionID":"<optional existing session ID>"}}` and the normal
location query. It returns the cutoff, next connection label, pinned-session
count, the requested session's connection ID or null, and cooldown deadlines in
milliseconds. It never resolves or returns credentials and never allocates a
new pin.

Use supported native agent launches, not manually created or replayed sessions.
Confirm two new Go sessions use alternating saved connection IDs, repeated calls
retain the same identity, and the globally active connection and main host
process are unchanged. Report native verification gaps explicitly.

## Rollback

Removing the plugin entry stops future request rewriting, which can change the
account used by an already managed session. Stop new Go work, let managed
sessions finish, then remove only this entry through the configuration watcher.
Retain native plugin storage; deleting it loses pins and the cursor. Re-enabling
routing cannot establish account identity for sessions that ran while routing
was off. See [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Historical gateway

Historical API-key gateway code remains in `src/gateway.ts`, `src/cli.ts`,
`scripts/set-keys.py`, `deploy/opencode-go-balancer.service`, `keys.example.json`,
and the legacy `redirectRequest` helper. It used a loopback listener and private
credential files under `~/.config/opencode-v2/opencode-go-balancer/` on
Linux/macOS or `~/.config/opencode/opencode-go-balancer/` on Windows. POSIX
`0600` mode and owner checks apply on Linux/macOS; Windows relies on NTFS ACLs.
The gateway is outside the router's path; leave its service stopped.

## Local checks

From the repository root:

```bash
npm install
npm run typecheck
npm test
```

The suite includes connection-router tests and historical gateway tests. Hook
tests use fake native capabilities, not a running host. Native verification has
covered alternating saved connections, tool continuations, shared status across
working directories, and an unchanged main host process. Forced live refresh
failure, compaction, live WebSocket rejection, and live upstream 429 recovery
were not exercised.
