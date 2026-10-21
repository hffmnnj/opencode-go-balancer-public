# opencode-go-balancer

> The account router is activated on OpenCode V2 2.0.32. The current contract
> redirects rate-limited sessions to the other saved account rather than raising
> a local cooldown exception. See the roadmap for verification of this revision.

This repository provides an account-based, session-pinned router for the existing `opencode-go`
provider. The authoritative contract is [`docs/SPEC.md`](docs/SPEC.md).

## Routing behavior

- Alternate new Go agent sessions once at first launch between the two
  already-connected saved OAuth accounts named `Default` and `Secondary`
  (integration `opencode`, provider `opencode-go`).
- For new sessions, skip a connection known to be rate-limited and use the
  other account.
- Keep the selected account sticky across normal requests and plugin reloads.
  If it is rate-limited, redirect the next request or native retry to the healthy
  other account and persist that selection. The session does not switch back
  merely because the original account's cooldown expires.
- Resolve credentials through OpenCode's native credential lifecycle and
  refresh. No copied tokens, no API-key files.
- Leave sessions created at or before the first activation cutoff unmanaged.
  Their historical account identity cannot be established by V2, so the router
  does not rewrite their credentials or assign them a new account.

## Failure policy

- No API-key gateway, additional listener, or copied credential store.
- No global account activation and no provider changes to running agents.
  Existing sessions are never switched during activation.
- Redirect on explicit rate limits only. Auth failures, malformed router state,
  unsafe destinations, or missing/ambiguous saved connections still fail closed.
- The cooldown extension records HTTP 429 responses without consuming their
  bodies. Respect `Retry-After` seconds or dates, with a 60-second fallback when
  absent or invalid. Keep the later deadline when rejections overlap.
- While an account is cooling down, both new and existing sessions choose the
  healthy other account. If both are locally marked limited, choose the account
  with the earliest deadline instead of raising a router cooldown exception.
  Genuine upstream limits still use native retry/backoff; redirection cannot
  manufacture quota. There is no custom fetch/replay loop or active quota probing.
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
  is limited to explicit rate-limit redirection. Removing or renaming a required
  account fails closed.
- Activation and rollback are described in [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Local checks

From the repository root:

```bash
npm run typecheck
npm test
```

The full suite includes connection-router tests and 43 historical gateway tests.
Hook tests use fake native capabilities, not a running host. Earlier native Go
launches verified Default then Secondary with successful tool continuations,
shared status across locations, and an unchanged main host PID. Forced live
refresh failure, compaction, and WebSocket behavior were not exercised.

A real upstream HTTP 429 was observed on `Default` under the earlier strict-pin
policy. That policy deliberately stopped affected sessions and has now been
superseded at the user's request. Cooldowns begin when a managed request observes
HTTP 429; the router does not pre-query account quotas. Account redirection uses
native requests and retries, not a second credential store or a custom replay
loop. Unit/hook coverage is not evidence of a live upstream 429 recovery; see
the roadmap for current tested and untested paths.
