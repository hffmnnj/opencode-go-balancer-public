# Connection router roadmap

## Current state

- The plugin runs on an existing OpenCode V2 host (tested against 2.0.32),
  in-process through native scoped HTTP hooks and native
  credential resolution: no gateway, second listener, or copied token store.
- Two saved OpenCode Go connections can be configured through `connectionLabels`
  on the configured integration. The globally active connection is never
  changed.
- Session pins, the round-robin cursor, the activation cutoff, and rate-limit
  cooldowns persist in native plugin storage.

## Implemented behavior

- New eligible sessions alternate between the two saved connections. Each
  session keeps its assigned connection across tool continuations, later
  prompts, compaction, and plugin reloads.
- An explicit HTTP 429 supersedes strict pinning: the session and its native
  retries move to the healthy other connection, the new pin persists, and
  delayed responses are attributed to the connection that actually served the
  request.
- If both connections are locally limited, a new session selects the
  earliest-expiring connection without raising a local cooldown exception.
  Genuine upstream rejection still uses native backoff.
- Sessions created at or before the activation cutoff remain unmanaged because
  no historical account identity is inferred. Non-Go traffic is unaffected.

## Verification

- Repository checks: `npm run typecheck`, `npm test`, and `git diff --check`.
  A focused credential-boundary review covered credential handling.
- Live checks covered alternating pins across new sessions, tool
  continuations, and native status reads from different project directories,
  which returned the same cutoff, cursor, and pin count.
- No upstream 429 has been deliberately induced. Redirect, `Retry-After`,
  both-limited selection, and reload behavior are covered by focused tests;
  native retry limits and backoff remain authoritative.

## Delivery

- The account-based router superseded the historical API-key gateway, which
  stays inactive. `README.md` and `SPEC.md` describe the current contract.
- Delivery history is in the repository's pull requests:
  https://github.com/hffmnnj/opencode-go-balancer/pulls

## Follow-ups

- Only an explicit HTTP 429 is handled, not errors inside an HTTP 200 stream.
  A reload between dispatch and response can lose that request's cooldown
  evidence; it cannot attribute the cooldown to another connection.
