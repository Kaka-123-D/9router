/**
 * Policy test: 9Router does NOT refresh Codex (OpenAI) tokens.
 *
 * The native Codex CLI owns the rotating refresh_token family in
 * ~/.codex/auth.json. A second writer here races the CLI and triggers an
 * Auth0 family revoke. This file pins the no-refresh policy so regressions
 * (e.g. re-adding a case "codex" branch) fail loudly in CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

describe("Codex no-refresh policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("does NOT export refreshCodexToken", async () => {
    const mod = await import("../../open-sse/services/tokenRefresh.js");
    expect(mod.refreshCodexToken).toBeUndefined();
  });

  it("getRefreshLeadMs('codex') falls back to TOKEN_EXPIRY_BUFFER_MS (no codex entry)", async () => {
    const { getRefreshLeadMs, TOKEN_EXPIRY_BUFFER_MS } = await import("../../open-sse/services/tokenRefresh.js");
    expect(getRefreshLeadMs("codex")).toBe(TOKEN_EXPIRY_BUFFER_MS);
  });

  it("getAccessToken('codex', ...) returns null without calling fetch", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("fetch must not be called for codex"));
    global.fetch = fetchSpy;

    const { getAccessToken } = await import("../../open-sse/services/tokenRefresh.js");
    const result = await getAccessToken("codex", {
      connectionId: "test-conn-id",
      refreshToken: "rt_should_never_be_used",
    });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshTokenByProvider('codex', ...) returns null without calling fetch", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("fetch must not be called for codex"));
    global.fetch = fetchSpy;

    const { refreshTokenByProvider } = await import("../../open-sse/services/tokenRefresh.js");
    const result = await refreshTokenByProvider("codex", {
      refreshToken: "rt_should_never_be_used",
    });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
