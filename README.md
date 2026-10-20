# opencode-go-balancer

> Status: activated on OpenCode V2 2.0.32. Typecheck and 64 tests pass;
> independent credential-boundary review passed. Two real Go agent sessions
> completed on alternating saved connections with tool continuations.

This repository provides an account-based, session-pinned router for the existing `opencode-go`
provider. The authoritative contract is [`docs/SPEC.md`](docs/SPEC.md).

## Routing behavior

- Alternate new Go agent sessions once at first launch between the two
  already-connected saved OAuth accounts named `Default` and `Secondary`
  (integration `opencode`, provider `opencode-go`).
- For new sessions, skip a connection known to be rate-limited and use the
  other account.
- Pin the selected account for the whole session: later prompts, tool
  continuations, retries, auxiliary calls, and plugin reloads keep the same
  account so cache affinity is preserved.
- Resolve credentials through OpenCode's native credential lifecycle and
  refresh. No copied tokens, no API-key files.
- Leave sessions created at or before the first activation cutoff unmanaged.
  Their historical account identity cannot be established by V2, so the router
  does not rewrite their credentials or assign them a new account.

## Failure policy

- No API-key gateway, additional listener, or copied credential store.
- No global account activation and no provider changes to running agents.
  Existing sessions are never switched during activation.
- Never fail over mid-session: rate limits, auth failures, or a missing pinned
  connection do not switch an existing session to another account.
- The cooldown extension records HTTP 429 responses without consuming their
  bodies. Respect `Retry-After` seconds or dates, with a 60-second fallback when
  absent or invalid. Keep the later deadline when rejections overlap.
- While an account is cooling down, new sessions choose the other account;
  existing sessions pinned to it return a clear error rather than sending more
  requests or changing accounts. If both are limited, allocate nothing and
  report the earliest availability. No request replay or active quota probing.
- No changes to non-Go providers or model choices.

## Verified current state

- Live host is `2.0.32`.
- Both `Default` and `Secondary` connections have been verified through
  authenticated metadata reads, without displaying secrets.
- `Secondary` is currently the globally active account; the router must not
  change that.
- The old gateway service is inactive. Historical gateway source remains in
  the repository but is outside the new plugin's routing path.
- The router uses the scoped native `http.request` hook and resolves each
  pinned credential by ID, including native OAuth refresh. Bearer and account
  organization headers are replaced together.
- Activation used the configuration watcher without restarting the host or
  changing the globally active account. The authenticated `go-router/status`
  RPC reports pins and allocation metadata, never credential values.

## Operational limits

- Supports the existing single main OpenCode host process. A process-global
  queue serializes allocations across location instances; plugin-scoped native
  storage preserves pins, the cursor and first-activation cutoff across reloads.
- Native initialization can still depend on the globally active account before
  request hooks run. A failure there can block a healthy pinned account.
- Managed sessions require HTTP. WebSocket dispatch is rejected rather than
  silently bypassing a pin. Current Go routes use native HTTP.
- Do not delete router storage or disable/re-enable routing around new work if
  pin continuity is required. Token refresh is allowed; changing account identity
  is not. Removing or renaming a required account fails closed.
- Activation and rollback are described in [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Local checks

From the repository root:

```bash
npm run typecheck
npm test
```

The full suite includes 21 connection-router tests and 43 historical gateway
tests. Tests use fake native capabilities. Separately, native Go launches verified
Default then Secondary with successful tool continuations, unchanged pins, shared
status across two locations, and an unchanged main host PID. Forced live refresh
failure, live retries, live compaction, and WebSocket behavior were not exercised.
Cooldown behavior is covered with injected clocks and fake response hooks; a real
upstream 429 was not deliberately induced. Cooldowns begin when a managed request
observes HTTP 429; the router does not pre-query account quotas. A first request
that discovers a limit remains pinned and is not replayed on the other account.
