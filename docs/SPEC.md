# OpenCode Go connection router

## Goal

Alternate new Go agent sessions between the existing OpenCode account connections named `Default` and `Secondary`. Keep the selected account sticky across tool continuations, later prompts, and plugin reloads, except when rate limiting requires redirection.

When a managed request returns HTTP 429, record the cooldown against the account actually used by that request. Redirect subsequent requests, including native retries of the same session, to the healthy other account and persist the new selection. Respect valid `Retry-After` seconds or dates; use 60 seconds when absent or invalid. Keep the later deadline when multiple rejections arrive. If both accounts are locally cooling down, select the earliest-expiring account rather than raising a local cooldown exception; leave genuine upstream rejection and backoff to the native runtime. This supersedes the previous no-mid-session-failover requirement at the user's explicit request.

## Not doing

- No API-key gateway, additional listener, or copied credential store.
- No global account activation or provider changes to running agents.
- No custom fetch/replay loop or fallback on ambiguous network/auth/server errors. Native retry remains responsible for retrying failed model requests.
- No changes to non-Go providers or model choices.
- No extra OpenCode host, service restart, or database edits.

## Acceptance checks

1. Verify both named saved OAuth connections exist using the running main server, without displaying secrets.
2. New eligible sessions alternate between the two connections, including concurrent launches.
3. Each session retains its connection across normal requests and reloads. An HTTP 429 redirects its next request to the healthy saved account, persists that choice, and does not switch back merely because the original cooldown expires.
4. Sessions already using Go at activation are not reassigned. Missing or unusable pinned connections fail closed without account switching.
5. Use OpenCode's credential resolution and refresh lifecycle; never change the globally active account or log credentials.
6. Typecheck, focused router tests, and one supported live integration check pass. Clearly report any unavailable native verification.
7. HTTP 429 cooldowns survive router reloads, skip limited accounts for new sessions, honor Retry-After without shortening a later deadline, and never cause a local cooldown exception even when both accounts are limited. Delayed responses cool the actual request account, not a subsequently changed pin. Responses remain unconsumed and unchanged. Native retries are accelerated only when another saved account is healthy.

## Implementation boundary

Use native scoped HTTP hooks and existing account connection identities. Matching published 2.0.32 core source establishes native refresh and account-header semantics. Historical API-key gateway code remains inactive and is not part of the live routing path. Sessions created at or before the first activation cutoff remain unmanaged because V2 does not expose their historical account identity.
