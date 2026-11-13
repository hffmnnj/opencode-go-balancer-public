![OpenCode Go Balancer](https://unpkg.com/hffmnnj.go-balancer@0.1.0/assets/banner.png)

# OpenCode Go Balancer

> The account router retains the caller assigned to each managed session,
> including when that caller is rate-limited.

Account-based, session-pinned router for the `opencode-go` provider in OpenCode
V2. It alternates new Go sessions between two saved Go connections and keeps
each session on its chosen connection across requests, retries, and rate limits.
It runs inside the existing host through native scoped HTTP hooks and native
credential resolution: no local gateway, second listener, or copied token store.

The npm package is `hffmnnj.go-balancer`. Its runtime plugin ID remains
`opencode-go-balancer` so native plugin storage stays attached when replacing a
source-checkout entry.

Activation, verification, and rollback:
[`docs/DEPLOY.md`](https://github.com/hffmnnj/opencode-go-balancer/blob/main/docs/DEPLOY.md).

## Requirements

- OpenCode V2 2.0.32.
- One single main host process. Do not launch a second host.
- Two distinct saved OpenCode Go connections for the configured labels, on the
  Go integration named by `integrationID`. Each label must match exactly one
  saved OAuth or key connection.
- The default labels are `OpenCode Go` and `OpenCode Go 2` in primary/secondary
  order; the default `integrationID` is `opencode-go`.
- Bun-based OpenCode V2 for the installed plugin. The npm package ships
  TypeScript source, which plain Node.js cannot import from `node_modules`.
  Node.js 26 or newer is used for source-checkout development and tests.

## Install from npm

Back up the global configuration, then append this object to its existing
`plugins` array without changing other entries. OpenCode resolves the package
name from npm; no absolute checkout path is required.

```json
{
  "package": "hffmnnj.go-balancer",
  "options": { "enabled": true }
}
```

`enabled` must be `true`; the plugin does nothing otherwise. Optional settings:

- `connectionLabels`: two distinct nonempty strings in primary/secondary order.
  Defaults to `["OpenCode Go", "OpenCode Go 2"]`.
- `integrationID`: a nonempty integration ID. Defaults to `opencode-go`.

Before enabling, add both Go connections through OpenCode's normal Go sign-in or
API-key flow on the configured integration. Name them exactly to match
`connectionLabels`; each label must resolve to one saved connection, or the
plugin fails closed. The plugin resolves each connection by saved ID through the
native credential lifecycle, including native OAuth refresh and native key
credentials.

Credentials stay in native connection storage. Do not add tokens, key paths, or
gateway settings to plugin options, and do not create `keys.json`,
`local-token`, or any copied token file for this package; it does not read them.

Use the configuration watcher; do not restart the host. Leave the globally
active connection unchanged. A successful first activation saves a cutoff.
Sessions created at or before that cutoff remain unmanaged because V2 cannot
establish their historical account identity.

### Replacing a source-checkout entry

If the host currently loads the plugin from an absolute directory or `file://`
checkout, replace only that plugin object with the npm package object above and
keep its `options` unchanged. Remove the old entry rather than adding a second
copy.

The runtime plugin ID is `opencode-go-balancer` in both forms, so pins, the
round-robin cursor, the activation cutoff, and cooldown deadlines remain in
native plugin storage. Keep the plugin entry and configured connection labels
stable. Stop new Go work and let managed sessions finish before the reload:
plugin reactivation is not atomic.

## Routing behavior

- Alternate new Go agent sessions once at first Go HTTP dispatch, skipping a
  locally cooled connection when the other is healthy. Titles and compaction
  share the session's allocation.
- Keep the selected connection sticky across requests, retries, and rate limits
  while the plugin is active, including when that connection is rate-limited.
  Native provider backoff applies to a rate-limited session.
- Never redirect an existing session on rate limits. If both connections are
  locally limited, a new session chooses the one with the earliest deadline; on
  equal deadlines the round-robin candidate wins. An existing session keeps its
  pin. Do not raise a local cooldown exception; genuine upstream limits still
  use native retry/backoff.
- Resolve each pinned connection by saved connection ID through OpenCode's
  native lifecycle, including OAuth refresh and native key credentials. For
  OAuth connections, replace the Bearer and `x-opencode-org-id` headers
  together; key credentials supply their own Bearer token. No copied tokens or
  local key files.
- Leave sessions created at or before the activation cutoff unmanaged. Do not
  rewrite their credentials or assign them a new account.
- Do not change non-Go providers or model choices.

## State and safeguards

- The router never changes the globally active connection and never activates
  one globally.
- Pins, the round-robin cursor, the first-activation cutoff, and cooldowns live
  in native plugin storage keyed by the `opencode-go-balancer` runtime ID. They
  survive reloads and replacement of the source-checkout entry with the npm
  package. Plugin storage is stateful; keep the plugin entry and configured
  connection labels stable.
- A process-global queue serializes allocations across location instances.
- Do not delete plugin storage to bypass a cooldown. Deleting it loses pins,
  the cursor, the cutoff, and cooldown deadlines.
- Removing or renaming a required connection fails closed for new and pinned
  sessions. Missing, expired, or unusable native credentials also fail closed.
- Plugin reactivation is not atomic: requests dispatched while its hooks are
  unavailable can use the globally active connection. Avoid reloading while
  managed sessions are running.

## Rate limits and failure policy

- Record cooldowns only from managed HTTP 429 responses. Do not consume, clone,
  replace, or otherwise alter the response or its body.
- Attribute a delayed response to the connection that actually served the
  request, not to a pin that changed after dispatch.
- Respect valid `Retry-After` seconds or HTTP dates, with a 1-second minimum and
  a 60-second fallback when the header is absent or invalid. Keep the later
  deadline when rejections overlap.
- Never redirect an existing session on rate limits. Do not accelerate native
  retries or alter the upstream 429. Genuine upstream failures remain subject to
  native retry policy and backoff.
- Cooldowns begin when a managed request observes HTTP 429; the router does not
  pre-query account quotas.
- Auth failures, malformed router state, unsafe destinations, and missing or
  ambiguous saved connections still fail closed.
- No API-key gateway, additional listener, copied credential store, custom
  fetch/replay loop, or active quota probing.

## Verified current state

- The live host is OpenCode V2 2.0.32.
- Both configured connections (`OpenCode Go` and `OpenCode Go 2` by default)
  were verified through authenticated metadata reads without displaying secrets.
- `OpenCode Go 2` was the globally active account at last verification; the
  router must not change that.
- The old gateway service is inactive. Historical gateway source remains in
  `src/gateway.ts` and `src/cli.ts` and is outside the plugin's routing path.
- The router uses the scoped native `http.request` hook and resolves each
  pinned credential by ID, including native OAuth refresh and native Go API-key
  credentials. OAuth Bearer and account organization headers are replaced
  together.
- Activation used the configuration watcher without restarting the host or
  changing the globally active account. The authenticated `go-router/status`
  RPC reports pins and allocation metadata, never credential values.

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

The cursor is not an availability prediction: new sessions skip any connection
whose cooldown is still active. Only managed HTTP 429 responses update
cooldowns; generic failures do not switch connections. Delayed responses are
attributed to their actual request connection.

Use supported native agent launches, not manually created or replayed sessions.
Confirm two new Go sessions use alternating saved connection IDs, repeated calls
retain the same identity, and the globally active connection and main host
process are unchanged. Report native verification gaps explicitly. See the
[deployment guide](https://github.com/hffmnnj/opencode-go-balancer/blob/main/docs/DEPLOY.md)
for the full procedure.

## Rollback

Removing the plugin entry stops future request rewriting, which can change the
account used by an already managed session. Stop new Go work, let managed
sessions finish, then remove only this entry through the configuration watcher.
Retain native plugin storage; deleting it loses pins and the cursor. Re-enabling
routing cannot establish account identity for sessions that ran while routing
was off.

Existing pins are retained as stored. A session already redirected by an older
version is not automatically restored to its original caller; its old
caller-bound reasoning may remain unusable. Use a fresh session if the existing
context fails. See the
[deployment guide](https://github.com/hffmnnj/opencode-go-balancer/blob/main/docs/DEPLOY.md).

## Historical gateway

Historical API-key gateway code remains in `src/gateway.ts`, `src/cli.ts`,
`scripts/set-keys.py`, `deploy/opencode-go-balancer.service`, `keys.example.json`,
and the legacy `redirectRequest` helper. The npm package includes the TypeScript
sources under `src/` because the plugin imports shared helpers from
`src/gateway.ts`, but it does not include the Python key script, service file,
key example, or `docs/` directory. Those excluded gateway scripts and docs are
available only in the
[GitHub source checkout](https://github.com/hffmnnj/opencode-go-balancer).

The gateway used a loopback listener and private credential files under
`~/.config/opencode-v2/opencode-go-balancer/` on Linux/macOS or
`~/.config/opencode/opencode-go-balancer/` on Windows. POSIX `0600` mode and
owner checks apply on Linux/macOS; Windows relies on NTFS ACLs. The gateway is
outside the router's path; leave its service stopped. The npm package does not
install, start, or configure it automatically.

## Local checks (source checkout only)

These commands apply to the GitHub source checkout, not an installed npm
package:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

The suite includes connection-router tests and historical gateway tests. Hook
tests use fake native capabilities, not a running host. Gateway tests use
ephemeral loopback HTTP servers and fake local tokens, never live credentials.
`npm pack --dry-run` inspects the published file set.

Native verification has covered alternating saved connections, tool
continuations, shared status across working directories, and an unchanged main
host process. Forced live refresh failure, compaction, live WebSocket rejection,
and live upstream 429 recovery were not exercised.
