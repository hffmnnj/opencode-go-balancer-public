# OpenCode Go connection router

## Goal

Alternate new Go agent sessions between the existing OpenCode account connections named `Default` and `Secondary`, then pin the selected connection for the lifetime of that session. Preserve cache affinity across tool continuations, retries, later prompts, and plugin reloads.

When a managed request returns HTTP 429, temporarily exclude that connection from new allocations. Use the other connection when available. Existing sessions never change accounts; their requests fail clearly while their pinned account is cooling down. Respect valid `Retry-After` seconds or dates; use 60 seconds when absent or invalid. Keep the later deadline when multiple rejections arrive. If both accounts are cooling down, reject new launches without allocating a pin or probing either account.

## Not doing

- No API-key gateway, additional listener, or copied credential store.
- No global account activation or provider changes to running agents.
- No mid-session account failover, request replay, or fallback on ambiguous network/auth/server errors.
- No changes to non-Go providers or model choices.
- No extra OpenCode host, service restart, or database edits.

## Acceptance checks

1. Verify both named saved OAuth connections exist using the running main server, without displaying secrets.
2. New eligible sessions alternate between the two connections, including concurrent launches.
3. Each session retains its connection across tool continuations, retries, auxiliary calls, later prompts, and plugin reloads.
4. Sessions already using Go at activation are not reassigned. Missing or unusable pinned connections fail closed without account switching.
5. Use OpenCode's credential resolution and refresh lifecycle; never change the globally active account or log credentials.
6. Typecheck, focused router tests, and one supported live integration check pass. Clearly report any unavailable native verification.
7. HTTP 429 cooldowns survive router reloads, skip limited accounts for new sessions, never change existing pins, honor Retry-After without shortening a later deadline, and reject safely when both accounts are limited. Responses remain unconsumed and unchanged.

## Implementation boundary

Use native scoped HTTP hooks and existing account connection identities. Matching published 2.0.32 core source establishes native refresh and account-header semantics. Historical API-key gateway code remains inactive and is not part of the live routing path. Sessions created at or before the first activation cutoff remain unmanaged because V2 does not expose their historical account identity.
