import { describe, it } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { redirectRequest } from "../src/plugin.ts";

// Oracle: SPEC.md + brief contract. Boundary: redirectRequest pure helper.
// Real SDK module under test via ../src/plugin.ts; no host launch, no real token file.
// Fake local token only (64 hex chars, never a real secret).
const FAKE_TOKEN = "f".repeat(64);
const SESSION_ID = "ses-test-123";
const DEFAULT_GATEWAY = "http://127.0.0.1:4790";
const OFFICIAL = "https://opencode.ai";

function makeRequest(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit | null;
    signal?: AbortSignal | null;
  } = {},
): Request {
  const { method = "POST", headers = {}, body = null, signal = null } = init;
  const requestInit: RequestInit & { duplex?: "half" } = { method, headers };
  if (body !== null) {
    requestInit.body = body;
    requestInit.duplex = "half";
  }
  if (signal) requestInit.signal = signal;
  return new Request(url, requestInit);
}

async function bodyBytes(res: Request): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

describe("plugin redirectRequest go-only routing", () => {
  it("redirects_each_go_protocol_to_loopback_gateway_preserving_path", async () => {
    const cases: Array<{ inputSuffix: string }> = [
      { inputSuffix: "/openai/v1/chat/completions" },
      { inputSuffix: "/anthropic/v1/messages" },
      { inputSuffix: "/google/v1beta/models/gemini-2.5-flash:generateContent" },
    ];
    for (const c of cases) {
      const req = makeRequest(`${OFFICIAL}/inference/go${c.inputSuffix}`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m" }),
      });
      const out = redirectRequest(req, SESSION_ID, FAKE_TOKEN);
      assert.notEqual(out, req);
      assert.equal(out.url, `${DEFAULT_GATEWAY}${c.inputSuffix}`);
      assert.equal(out.method, "POST");
      // Each case uses a fresh one-shot body; do not reuse across asserts.
      await out.arrayBuffer();
    }
  });

  it("redirects_google_stream_suffix_and_preserves_allowlisted_alt_sse_query", () => {
    const req = makeRequest(
      `${OFFICIAL}/inference/go/google/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [] }),
      },
    );
    const out = redirectRequest(req, SESSION_ID, FAKE_TOKEN);
    assert.equal(
      out.url,
      `${DEFAULT_GATEWAY}/google/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
    );
  });

  it("preserves_json_body_bytes_verbatim", async () => {
    const raw = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] });
    const req = makeRequest(`${OFFICIAL}/inference/go/openai/v1/chat/completions`, {
      headers: { "content-type": "application/json" },
      body: raw,
    });
    const out = redirectRequest(req, SESSION_ID, FAKE_TOKEN);
    assert.deepEqual(await bodyBytes(out), Buffer.from(raw, "utf8"));
  });

  it("preserves_compressed_body_bytes_verbatim", async () => {
    const raw = Buffer.from(JSON.stringify({ model: "m", messages: [] }), "utf8");
    const gz = zlib.gzipSync(raw);
    const req = makeRequest(`${OFFICIAL}/inference/go/openai/v1/chat/completions`, {
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gz,
    });
    const out = redirectRequest(req, SESSION_ID, FAKE_TOKEN);
    assert.equal(out.headers.get("content-encoding"), "gzip");
    assert.deepEqual(await bodyBytes(out), gz);
  });

  it("replaces_authorization_and_strips_account_credentials_preserving_other_headers", () => {
    const req = makeRequest(`${OFFICIAL}/inference/go/openai/v1/chat/completions`, {
      headers: {
        "content-type": "application/json",
        authorization: "Bearer real-user-key",
        "x-api-key": "injected",
        "api-key": "injected",
        "x-goog-api-key": "injected",
        "x-opencode-org-id": "org-evil",
        cookie: "session=evil",
        "x-custom-keep": "keep-me",
      },
      body: JSON.stringify({ model: "m" }),
    });
    // Precondition: allowed strippable headers are present on the incoming request.
    assert.equal(req.headers.get("x-api-key"), "injected");
    assert.equal(req.headers.get("x-opencode-org-id"), "org-evil");
    const out = redirectRequest(req, SESSION_ID, FAKE_TOKEN);
    assert.equal(out.headers.get("authorization"), `Bearer ${FAKE_TOKEN}`);
    assert.equal(out.headers.get("x-api-key"), null);
    assert.equal(out.headers.get("api-key"), null);
    assert.equal(out.headers.get("x-goog-api-key"), null);
    assert.equal(out.headers.get("x-opencode-org-id"), null);
    assert.equal(out.headers.get("cookie"), null);
    // Untouched headers survive.
    assert.equal(out.headers.get("content-type"), "application/json");
    assert.equal(out.headers.get("x-custom-keep"), "keep-me");
  });

  it("preserves_existing_go_session_marker", () => {
    const req = makeRequest(`${OFFICIAL}/inference/go/anthropic/v1/messages`, {
      headers: {
        "content-type": "application/json",
        "x-opencode-session": "sess-existing-999",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    const out = redirectRequest(req, "different-session-id", FAKE_TOKEN);
    assert.equal(out.headers.get("x-opencode-session"), "sess-existing-999");
  });

  it("adds_go_session_marker_when_missing", () => {
    const req = makeRequest(`${OFFICIAL}/inference/go/openai/v1/chat/completions`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    const out = redirectRequest(req, SESSION_ID, FAKE_TOKEN);
    assert.equal(out.headers.get("x-opencode-session"), SESSION_ID);
  });

  it("preserves_abort_signal", () => {
    const controller = new AbortController();
    const req = makeRequest(`${OFFICIAL}/inference/go/openai/v1/chat/completions`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
      signal: controller.signal,
    });
    const out = redirectRequest(req, SESSION_ID, FAKE_TOKEN);
    controller.abort();
    assert.equal(out.signal.aborted, true);
  });

  it("does_not_redirect_other_origins", () => {
    const others = [
      "https://api.openai.com/v1/chat/completions",
      "https://opencode.ai.evil.example/inference/go/openai/v1/chat/completions",
      "http://opencode.ai/inference/go/openai/v1/chat/completions",
    ];
    for (const url of others) {
      const req = makeRequest(url, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m" }),
      });
      const out = redirectRequest(req, SESSION_ID, FAKE_TOKEN);
      assert.equal(out, req);
      assert.equal(out.url, req.url);
    }
  });

  it("does_not_redirect_non_go_paths_disallowed_suffixes_method_or_query", () => {
    const bad: Array<{ url: string; method?: string }> = [
      { url: `${OFFICIAL}/inference/other/openai/v1/chat/completions` },
      { url: `${OFFICIAL}/inference/go` },
      { url: `${OFFICIAL}/inference/go/` },
      { url: `${OFFICIAL}/inference/go/openai/v1/embeddings` },
      { url: `${OFFICIAL}/inference/go/anthropic/v1/complete` },
      { url: `${OFFICIAL}/inference/go/google/v1beta/models/x:embedContent` },
      { url: `${OFFICIAL}/inference/go/openai/v1/chat/completions`, method: "GET" },
      { url: `${OFFICIAL}/inference/go/openai/v1/chat/completions?foo=bar` },
      { url: `${OFFICIAL}/inference/go/openai/v1/chat/completions?alt=sse` },
      // NOTE: credentialed https URLs (user:pass@) cannot be constructed as a
      // Node Request (constructor throws), so the username/password guard in
      // redirectRequest is defense-in-depth verified by inspection, not here.
    ];
    for (const b of bad) {
      const method = b.method ?? "POST";
      const req =
        method === "GET"
          ? makeRequest(b.url, { method: "GET" })
          : makeRequest(b.url, {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ model: "m" }),
            });
      const out = redirectRequest(req, SESSION_ID, FAKE_TOKEN);
      assert.equal(out, req, `should not redirect ${b.url} ${method}`);
    }
  });

  it("rejects_arbitrary_non_loopback_gateway_configuration", () => {
    const req = (): Request =>
      makeRequest(`${OFFICIAL}/inference/go/openai/v1/chat/completions`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m" }),
      });
    const evil = [
      "http://evil.example/",
      "https://127.0.0.1:4790/",
      "http://localhost:4790/",
      "http://127.0.0.1:4790/evil",
      "http://127.0.0.1:4790/?x=1",
      "http://user:pass@127.0.0.1:4790/",
    ];
    for (const gatewayURL of evil) {
      // Fresh one-shot body per attempt; never reuse across asserts.
      assert.throws(() => redirectRequest(req(), SESSION_ID, FAKE_TOKEN, gatewayURL), /Gateway must be loopback HTTP/);
    }
  });

  it("allows_explicit_loopback_gateway_with_custom_port", () => {
    const req = makeRequest(`${OFFICIAL}/inference/go/openai/v1/chat/completions`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    const out = redirectRequest(req, SESSION_ID, FAKE_TOKEN, "http://127.0.0.1:9999");
    assert.equal(out.url, "http://127.0.0.1:9999/openai/v1/chat/completions");
  });

  it("rejects_invalid_local_token", () => {
    const req = (): Request =>
      makeRequest(`${OFFICIAL}/inference/go/openai/v1/chat/completions`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m" }),
      });
    for (const bad of ["", "short", "has space in token value 12345678901234567890", "x".repeat(16)]) {
      assert.throws(() => redirectRequest(req(), SESSION_ID, bad), /Invalid local token/);
    }
  });
});
