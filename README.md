# opencode-go-balancer

> Status: staged, **not activated**. The live Go provider still uses the
> working OAuth connection. Activation is blocked on two fresh API keys —
> the earlier prototype key expired and must never be reused.

Authenticated local gateway plus a small V2 plugin that exposes the one
existing `opencode-go` provider across **two** user-owned Go API keys.

## How requests are balanced

- Equal **request-level** round robin across the two keys — not equal token
  spend. A heavy request and a light request each count as one turn.
- Tradeoff: rotation can reduce upstream prompt-cache reuse, since
  consecutive requests in one conversation may carry different keys. The
  original conversation/session marker is always preserved so each
  conversation still reads as one session upstream.
- Upstream routes are fixed to the official Go endpoints for
  OpenAI / Anthropic / Google. Tests inject loopback endpoints in-process;
  production has no configurable arbitrary upstream.

## Failure policy (honest, no magic)

- **Never replayed:** ambiguous network failures, timeouts, 5xx responses,
  or a partially delivered stream. A retry could double-apply a request
  whose outcome is unknown, so the error is returned as-is.
- **Fail over at most once**, to the other key, and only on an explicit
  pre-stream rejection: HTTP 401/403/429. `Retry-After` is honored without
  a short cap; while every key is cooling down the gateway returns a local
  429 instead of probing cooling keys.
- The enabled plugin disables OpenCode's session-level retries for Go so
  the host does not multiply the gateway's attempts.
- **No automatic OAuth refresh.** This balancer only forwards the two
  configured API keys; it never touches, copies, or refreshes OAuth tokens.

## Keys live outside the repo

Keys are stored at `~/.config/opencode-v2/opencode-go-balancer/keys.json`:

```json
{ "keys": [{ "label": "go-1", "key": "..." }, { "label": "go-2", "key": "..." }] }
```

See `keys.example.json` for the shape (blank slots, no secrets).

- Enter keys with `python3 scripts/set-keys.py`. It prompts for **both**
  keys via hidden input, validates shape and rejects exact duplicates, and
  writes atomically — nothing is written until both keys validate.
- `keys.json` and `local-token` are mode `0600`, outside Git. Never copy
  OAuth tokens, expired keys, or workspace headers into them.

## Gateway operation

- Dependency-free Node gateway on **`127.0.0.1:4790` only** — never on the
  Tailnet; this gateway bears credentials, so local-only is by design.
- Authenticated with a random local bearer token in the separate mode-0600
  `local-token` file. The protected status endpoint reports readiness,
  key labels, and counts only — never keys, prompts, or upstream bodies.
- Check status by reading the token **inside the requesting process**
  (e.g. a script that reads the file and sets the header). Never paste the
  token literally into a `curl` command line or pass it as a shell
  process argument — both leak via history and `ps`.
- A systemd unit template is staged at `deploy/opencode-go-balancer.service`.
  Staged only: it is not enabled or activated.

## Plugin activation (only after both new keys validate)

No `provider` `baseURL` overrides anywhere — routing goes through the
plugin's `http.request` hook, preserving protocol paths, bodies, session
headers, and cancellation.

Add the plugin only once both fresh keys validate; until then the existing
OAuth connection is unaffected:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-go-balancer",
      "options": { "enabled": true }
    }
  ]
}
```

Append this entry to the existing `plugins` list; do not replace the list or
change your other providers. Start the gateway service before enabling the
plugin. Removing only this entry restores the normal Go connection.

## Local checks

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
python3 -m unittest discover -s test-ops -v
```

The HTTP tests use local fake upstreams. They do not prove that your Go
subscriptions are active or that live OpenCode routing has been activated.

## References

- Go console docs: https://opencode.ai/v2/docs/console/go/
- Plugin docs: https://opencode.ai/v2/docs/build/plugins/
- Contract and acceptance checks: `SPEC.md`
