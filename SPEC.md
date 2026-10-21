# Two-account OpenCode Go session router

> Status: activated and verified with two native Go agent sessions.

The authoritative contract is [`docs/SPEC.md`](docs/SPEC.md). This file is a
short pointer plus the key behavioral contract. It replaces the obsolete
two-API-key gateway specification that previously lived here.

## Key behavioral contract

- Alternate new Go agent sessions once at first launch between the two
  already-connected saved OAuth accounts named `Default` and `Secondary`.
  Both belong to integration `opencode` and back provider `opencode-go`.
- Keep the selected account sticky across normal requests and reloads. On a
  managed rate limit, redirect the next request or native retry to the healthy
  other account, persist that selection, and do not switch back after expiry.
- Never globally activate accounts and never change the globally active
  account. Sessions already running at activation are not switched.
- Do not raise local cooldown exceptions, even when both accounts are locally
  limited: select the earliest-expiring account and retain native backoff.
  Missing or unusable saved connections and unsafe destinations still fail closed.
- Use native credential resolution and refresh. No copied tokens and no
  API-key files.
- Native scoped HTTP hooks enforce the pin. See `docs/DEPLOY.md` for activation,
  existing-session exclusions, operational limits and rollback precautions.

## Historical gateway files are inactive

The earlier API-key gateway design (local listener, key files, service unit,
gateway routing plugin, and the previous acceptance checks and roadmap in
this file) is historical and inactive. Historical gateway source remains in
the repository but is not part of the live routing path. The old service is
inactive; only the account-based router plugin is enabled globally.
