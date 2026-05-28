// Re-export from open-sse with local logger
import * as log from "../utils/logger.js";
import {
  updateProviderConnection,
  getProviderConnectionById,
  getSettings,
} from "../../lib/localDb.js";
import { readCodexAuthFile, writeCodexAuthFile } from "../../lib/codexAuthFile.js";
import {
  getProjectIdForConnection,
  invalidateProjectId,
  removeConnection,
} from "open-sse/services/projectId.js";
import {
  TOKEN_EXPIRY_BUFFER_MS as BUFFER_MS,
  refreshAccessToken as _refreshAccessToken,
  refreshClaudeOAuthToken as _refreshClaudeOAuthToken,
  refreshGoogleToken as _refreshGoogleToken,
  refreshQwenToken as _refreshQwenToken,
  refreshCodexToken as _refreshCodexToken,
  refreshIflowToken as _refreshIflowToken,
  refreshGitHubToken as _refreshGitHubToken,
  refreshCopilotToken as _refreshCopilotToken,
  getAccessToken as _getAccessToken,
  refreshTokenByProvider as _refreshTokenByProvider,
  formatProviderCredentials as _formatProviderCredentials,
  getAllAccessTokens as _getAllAccessTokens,
  refreshKiroToken as _refreshKiroToken,
  getRefreshLeadMs as _getRefreshLeadMs,
  isUnrecoverableRefreshError,
} from "open-sse/services/tokenRefresh.js";

export const TOKEN_EXPIRY_BUFFER_MS = BUFFER_MS;

// ─── Re-exports wrapped with local logger ─────────────────────────────────────

export const refreshAccessToken = (provider, refreshToken, credentials) =>
  _refreshAccessToken(provider, refreshToken, credentials, log);

export const refreshClaudeOAuthToken = (refreshToken) =>
  _refreshClaudeOAuthToken(refreshToken, log);

export const refreshGoogleToken = (refreshToken, clientId, clientSecret) =>
  _refreshGoogleToken(refreshToken, clientId, clientSecret, log);

export const refreshQwenToken = (refreshToken) =>
  _refreshQwenToken(refreshToken, log);

export const refreshCodexToken = (refreshToken) =>
  _refreshCodexToken(refreshToken, log);

export const refreshIflowToken = (refreshToken) =>
  _refreshIflowToken(refreshToken, log);

export const refreshGitHubToken = (refreshToken) =>
  _refreshGitHubToken(refreshToken, log);

export const refreshCopilotToken = (githubAccessToken) =>
  _refreshCopilotToken(githubAccessToken, log);

export const refreshKiroToken = (refreshToken, providerSpecificData) =>
  _refreshKiroToken(refreshToken, providerSpecificData, log);

export const getAccessToken = (provider, credentials) =>
  _getAccessToken(provider, credentials, log);

export const refreshTokenByProvider = (provider, credentials) =>
  _refreshTokenByProvider(provider, credentials, log);

export const formatProviderCredentials = (provider, credentials) =>
  _formatProviderCredentials(provider, credentials, log);

export const getAllAccessTokens = (userInfo) =>
  _getAllAccessTokens(userInfo, log);

// ─── Lifecycle hook ───────────────────────────────────────────────────────────

/**
 * Call this when a connection is fully closed / removed.
 * Aborts any in-flight projectId fetch and evicts its cache entry,
 * preventing the module-level Maps from accumulating stale entries.
 *
 * @param {string} connectionId
 */
export function releaseConnection(connectionId) {
  if (!connectionId) return;
  removeConnection(connectionId);
  log.debug("TOKEN_REFRESH", "Released connection resources", { connectionId });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute an ISO expiry timestamp from a relative expiresIn (seconds).
 * @param {number} expiresIn
 * @returns {string}
 */
function toExpiresAt(expiresIn) {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Providers that carry a real Google project ID.
 * @param {string} provider
 * @returns {boolean}
 */
function needsProjectId(provider) {
  return provider === "antigravity" || provider === "gemini-cli";
}

/**
 * Non-blocking: fetch the project ID for a connection after a token refresh and
 * persist it to localDb.  Invalidates the stale cached value first so the fetch
 * always retrieves a fresh one.
 *
 * @param {string} provider
 * @param {string} connectionId
 * @param {string} accessToken
 */
function _refreshProjectId(provider, connectionId, accessToken) {
  if (!needsProjectId(provider) || !connectionId || !accessToken) return;

  // Evict the stale cached entry so getProjectIdForConnection does a real fetch
  invalidateProjectId(connectionId);

  getProjectIdForConnection(connectionId, accessToken)
    .then((projectId) => {
      if (!projectId) return;
      updateProviderCredentials(connectionId, { projectId }).catch((err) => {
        log.debug("TOKEN_REFRESH", "Failed to persist refreshed projectId", {
          connectionId,
          error: err?.message ?? err,
        });
      });
    })
    .catch((err) => {
      log.debug("TOKEN_REFRESH", "Failed to fetch projectId after token refresh", {
        connectionId,
        error: err?.message ?? err,
      });
    });
}

// ─── Codex active-account sync helpers ──────────────────────────────────────
//
// When a codex connection is the currently-active one (its tokens were written to
// ~/.codex/auth.json via the "Switch" button), both 9Router and the native Codex
// CLI may try to refresh the same rotating refresh_token. Whichever side refreshes
// first invalidates the other's stored rt_; the stale side's next refresh attempt
// is detected by Auth0 as token reuse and the entire token family is revoked,
// producing "refresh token was revoked" errors.
//
// We bridge the two stores so the active account stays in sync:
//   • Before any refresh, pull the freshest rt_ from auth.json into DB.
//   • After any refresh, push the freshest rt_ from DB into auth.json.

async function isActiveCodexConnection(connectionId, providerHint = null) {
  if (!connectionId) return false;
  try {
    const settings = await getSettings();
    if (settings.activeCodexConnectionId !== connectionId) return false;
    if (providerHint === "codex") return true;
    const conn = await getProviderConnectionById(connectionId);
    return conn?.provider === "codex";
  } catch {
    return false;
  }
}

/**
 * If the active Codex CLI account has been refreshed by the CLI since we last
 * persisted, pull the fresher rt_/access_token from auth.json into DB and into
 * the in-memory creds object so the upcoming refresh uses the latest tokens.
 *
 * @param {object} creds  may be mutated; caller should use returned value
 * @param {string} provider
 * @returns {Promise<object>} possibly-updated creds (always returned)
 */
async function syncCodexFromAuthFile(creds, provider) {
  if (provider !== "codex" || !creds?.connectionId) return creds;
  if (!(await isActiveCodexConnection(creds.connectionId, provider))) return creds;

  const auth = await readCodexAuthFile();
  const fileRt = auth?.tokens?.refresh_token;
  const fileAt = auth?.tokens?.access_token;
  if (!fileRt || fileRt === creds.refreshToken) return creds;

  log.info("TOKEN_REFRESH", "auth.json has newer rt_, syncing CLI → DB before refresh", {
    connectionId: creds.connectionId,
  });

  const updates = { refreshToken: fileRt };
  if (fileAt) updates.accessToken = fileAt;
  await updateProviderConnection(creds.connectionId, updates).catch((e) =>
    log.warn("TOKEN_REFRESH", `CLI→DB sync failed: ${e?.message || e}`)
  );

  return {
    ...creds,
    refreshToken: fileRt,
    accessToken: fileAt || creds.accessToken,
  };
}

/**
 * After a fresh refresh is persisted to DB, mirror the new tokens into
 * ~/.codex/auth.json so the native CLI doesn't try to refresh with a stale rt_.
 */
async function syncCodexToAuthFile(connectionId) {
  if (!(await isActiveCodexConnection(connectionId, "codex"))) return;
  try {
    const conn = await getProviderConnectionById(connectionId);
    if (!conn || conn.provider !== "codex" || !conn.accessToken) return;
    await writeCodexAuthFile(conn);
    log.info("TOKEN_REFRESH", "Synced fresh codex tokens DB → ~/.codex/auth.json", { connectionId });
  } catch (e) {
    log.warn("TOKEN_REFRESH", `DB→auth.json sync failed: ${e?.message || e}`);
  }
}

// ─── Local-specific: persist credentials to localDb ──────────────────────────

/**
 * Persist updated credentials for a connection to localDb.
 * Only fields that are present in `newCredentials` are written.
 *
 * @param {string} connectionId
 * @param {object} newCredentials
 * @returns {Promise<boolean>}
 */
export async function updateProviderCredentials(connectionId, newCredentials) {
  try {
    const updates = {};

    if (newCredentials.accessToken)         updates.accessToken  = newCredentials.accessToken;
    if (newCredentials.refreshToken)        updates.refreshToken = newCredentials.refreshToken;
    if (newCredentials.expiresIn) {
      updates.expiresAt = toExpiresAt(newCredentials.expiresIn);
      updates.expiresIn = newCredentials.expiresIn;
    } else if (newCredentials.expiresAt) {
      const expiresAt = normalizeExpiresAt(newCredentials.expiresAt);
      if (expiresAt) {
        updates.expiresAt = expiresAt;
        updates.expiresIn = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      }
    }
    if (newCredentials.providerSpecificData) {
      updates.providerSpecificData = {
        ...(newCredentials.existingProviderSpecificData || {}),
        ...newCredentials.providerSpecificData,
      };
    }
    if (newCredentials.projectId)            updates.projectId = newCredentials.projectId;

    const result = await updateProviderConnection(connectionId, updates);
    log.info("TOKEN_REFRESH", "Credentials updated in localDb", {
      connectionId,
      success: !!result
    });
    // Mirror the new tokens to ~/.codex/auth.json when this is the active CLI
    // account, so the native Codex CLI uses fresh tokens instead of stale rt_.
    if (result) syncCodexToAuthFile(connectionId).catch(() => {});
    return !!result;
  } catch (error) {
    log.error("TOKEN_REFRESH", "Error updating credentials in localDb", {
      connectionId,
      error: error.message,
    });
    return false;
  }
}

// ─── Local-specific: proactive token refresh ─────────────────────────────────

/**
 * Check whether the provider token (and, for GitHub, the Copilot token) is
 * about to expire and refresh it proactively.
 *
 * @param {string} provider
 * @param {object} credentials
 * @returns {Promise<object>} updated credentials object
 */
export async function checkAndRefreshToken(provider, credentials) {
  let creds = { ...credentials };

  // ── 0. For the active Codex CLI account, pick up any rt_ the CLI has rotated
  //       since our last persist. Prevents stale-rt_ reuse → Auth0 family revoke.
  creds = await syncCodexFromAuthFile(creds, provider);

  // ── 1. Regular access-token expiry ────────────────────────────────────────
  if (creds.expiresAt) {
    const expiresAt = new Date(creds.expiresAt).getTime();
    const now       = Date.now();
    const remaining = expiresAt - now;

    const refreshLead = _getRefreshLeadMs(provider);
    if (remaining < refreshLead) {
      log.info("TOKEN_REFRESH", "Token expiring soon, refreshing proactively", {
        provider,
        expiresIn: Math.round(remaining / 1000),
        refreshLeadMs: refreshLead,
      });

      const newCreds = await getAccessToken(provider, creds);

      // Refresh token consumed/invalid (e.g. Auth0 revoked the family) — stop retrying,
      // mark the connection so the dashboard surfaces it for re-auth.
      if (isUnrecoverableRefreshError(newCreds)) {
        log.warn("TOKEN_REFRESH", "Unrecoverable refresh error, marking connection expired", {
          provider,
          connectionId: creds.connectionId,
          code: newCreds.code,
        });
        if (creds.connectionId) {
          await updateProviderConnection(creds.connectionId, {
            testStatus: "expired",
            lastError: "Refresh token expired or revoked — re-authentication required",
            lastErrorAt: new Date().toISOString(),
          }).catch(() => {});
        }
        return creds;
      }

      if (newCreds?.accessToken) {
        const mergedCreds = {
          ...newCreds,
          existingProviderSpecificData: creds.providerSpecificData,
        };

        // Persist to DB (non-blocking path continues below)
        await updateProviderCredentials(creds.connectionId, mergedCreds);

        creds = {
          ...creds,
          accessToken:  newCreds.accessToken,
          refreshToken: newCreds.refreshToken ?? creds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData
            ? { ...creds.providerSpecificData, ...newCreds.providerSpecificData }
            : creds.providerSpecificData,
          expiresAt:    newCreds.expiresIn
            ? toExpiresAt(newCreds.expiresIn)
            : normalizeExpiresAt(newCreds.expiresAt) || creds.expiresAt,
        };

        // Non-blocking: refresh projectId with the new access token
        _refreshProjectId(provider, creds.connectionId, creds.accessToken);
      }
    }
  }

  // ── 2. GitHub Copilot token expiry ────────────────────────────────────────
  if (provider === "github" && creds.providerSpecificData?.copilotTokenExpiresAt) {
    const copilotExpiresAt = creds.providerSpecificData.copilotTokenExpiresAt * 1000;
    const now              = Date.now();
    const remaining        = copilotExpiresAt - now;

    if (remaining < TOKEN_EXPIRY_BUFFER_MS) {
      log.info("TOKEN_REFRESH", "Copilot token expiring soon, refreshing proactively", {
        provider,
        expiresIn: Math.round(remaining / 1000),
      });

      const copilotToken = await refreshCopilotToken(creds.accessToken);
      if (copilotToken) {
        const updatedSpecific = {
          ...creds.providerSpecificData,
          copilotToken:          copilotToken.token,
          copilotTokenExpiresAt: copilotToken.expiresAt,
        };

        await updateProviderCredentials(creds.connectionId, {
          providerSpecificData: updatedSpecific,
        });

        creds.providerSpecificData = updatedSpecific;
        creds.copilotToken = copilotToken.token;
      }
    }
  }

  return creds;
}

// ─── Local-specific: combined GitHub + Copilot refresh ───────────────────────

/**
 * Refresh the GitHub OAuth token and immediately exchange it for a fresh
 * Copilot token.
 *
 * @param {object} credentials  – must contain `refreshToken`
 * @returns {Promise<object|null>} merged credentials or the raw GitHub credentials on Copilot failure
 */
export async function refreshGitHubAndCopilotTokens(credentials) {
  const newGitHubCreds = await refreshGitHubToken(credentials.refreshToken);
  if (!newGitHubCreds?.accessToken) return newGitHubCreds;

  const copilotToken = await refreshCopilotToken(newGitHubCreds.accessToken);
  if (!copilotToken) return newGitHubCreds;

  return {
    ...newGitHubCreds,
    providerSpecificData: {
      copilotToken:          copilotToken.token,
      copilotTokenExpiresAt: copilotToken.expiresAt,
    },
  };
}
