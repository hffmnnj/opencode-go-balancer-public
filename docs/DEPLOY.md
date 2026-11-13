# Deploy the connection router

## Prerequisites

- Existing single main OpenCode V2 server (tested against 2.0.32); do not
  launch a second host.
- Exactly one saved connection for each configured connection label on the
  configured integration. Keep the globally active connection unchanged.
- `npm run typecheck`, `npm test`, and credential-boundary review pass.
- The historical API-key gateway service stays stopped.

## Enable

Back up the active global configuration outside Git, preserving its permissions.
Append this entry to its existing `plugins` array without changing other entries:

```json
{
  "package": "/absolute/path/to/opencode-go-balancer",
  "options": { "enabled": true }
}
```

Use the existing configuration watcher; do not restart OpenCode. Query the main
server's authenticated plugin inventory for the affected location and confirm
`opencode-go-balancer` is active. Authentication must stay inside the requesting
process; never print credentials or put them in command-line arguments.

The first activation saves a cutoff. Sessions created at or before that cutoff
are unmanaged, not assigned an account retroactively. New sessions choose once
at their first Go HTTP dispatch. Titles and compaction share the same allocation.
Existing unrelated sessions and non-Go traffic are unaffected.

## Verify

The authenticated read-only RPC is `POST /api/rpc/go-router/status`, with body
`{"input":{"sessionID":"<optional existing session ID>"}}` and the normal
location query. It reports the cutoff, round-robin cursor label, pin count,
credential-ID cooldown deadlines in milliseconds, and requested session's
connection ID (or null). It never resolves or returns tokens
and never allocates a new session pin.

The cursor is not an availability prediction: new sessions skip any account whose
cooldown is still active. Do not delete saved pins to bypass a cooldown. Existing
sessions retain their saved caller even when it is limited, and native retry
decisions and backoff are not accelerated by this plugin. When both accounts are
locally limited, a new session selects the earliest-expiring account without a
local cooldown exception; upstream rejection still requires native backoff. Only
managed HTTP 429 responses update cooldowns; generic failures do not switch
accounts. Delayed responses are attributed to their actual request account.

The stored pin cannot establish a previously redirected session's original
caller. Updating the plugin does not restore that identity or repair already
incompatible reasoning; use a fresh session if the existing context fails.

Use supported native agent launches, not manually created or replayed sessions.
Confirm two new Go sessions use alternating saved connection IDs, and multiple
calls in either session retain the same identity. Check that the globally active
account and main server PID are unchanged. Report native verification gaps
explicitly; fake-hook tests are not live dispatch evidence.

## Disable

Removing the plugin entry stops future request rewriting, so it can change the
account used by an already managed session. Do not disable while such sessions
are running when cache affinity must be preserved. Stop new Go work, let managed
sessions finish, then remove only this entry through the configuration watcher.
Retain native plugin storage; deleting it loses pins and the cursor. Re-enabling
cannot establish account identity for sessions that ran while routing was off.
