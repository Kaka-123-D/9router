import fs from "fs/promises";
import path from "path";
import os from "os";

// Codex CLI stores credentials at ~/.codex/auth.json with this shape:
//   { auth_mode, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }
// access_token is a ~10-day JWT; refresh_token ("rt_...") is an opaque rotating OAuth token.

export const getCodexDir = () => path.join(os.homedir(), ".codex");
export const getCodexAuthPath = () => path.join(getCodexDir(), "auth.json");

// Decode a JWT payload without verifying the signature (we only read claims).
function decodeJwtPayload(jwt) {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function looksLikeJwt(token) {
  return typeof token === "string" && token.split(".").length === 3;
}

/**
 * Parse a ChatGPT web-session JSON (from chatgpt.com/api/auth/session) into the
 * fields needed to create a Codex provider connection. Pure — no IO.
 *
 * @param {string} jsonString raw JSON pasted by the user
 * @returns {{accessToken, idToken, email, accountId, planType, expiresAt, jwtExp}}
 * @throws {Error} when the input is not valid JSON or lacks an accessToken
 */
export function parseCodexSessionJson(jsonString) {
  if (typeof jsonString !== "string" || jsonString.trim() === "") {
    throw new Error("Session JSON is empty");
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error("Invalid JSON — paste the full session response");
  }

  const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : "";
  if (!looksLikeJwt(accessToken)) {
    throw new Error("Missing or malformed 'accessToken' (expected a JWT)");
  }

  const payload = decodeJwtPayload(accessToken) || {};
  const auth = payload["https://api.openai.com/auth"] || {};
  const profile = payload["https://api.openai.com/profile"] || {};

  const email =
    parsed.user?.email || profile.email || payload.email || payload.preferred_username || null;

  const accountId =
    parsed.account?.id || auth.chatgpt_account_id || payload.account_id || null;

  const planType =
    parsed.account?.planType || auth.chatgpt_plan_type || payload.plan_type || null;

  const jwtExp = typeof payload.exp === "number" ? payload.exp : null;
  const expiresAt = jwtExp ? new Date(jwtExp * 1000).toISOString() : null;

  return {
    accessToken,
    // Session JSON has no separate id_token; reuse the access token as a fallback.
    idToken: accessToken,
    email,
    accountId,
    planType,
    expiresAt,
    jwtExp,
  };
}

/**
 * Build the ~/.codex/auth.json object from a stored provider connection. Pure.
 * refresh_token is "" when the connection has none (session-imported accounts).
 *
 * @param {object} connection providerConnection row (provider=codex)
 * @returns {object}
 */
export function buildCodexAuthJson(connection) {
  const psd = connection?.providerSpecificData || {};
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: psd.idToken || connection?.accessToken || "",
      access_token: connection?.accessToken || "",
      refresh_token: connection?.refreshToken || "",
      account_id: psd.chatgptAccountId || "",
    },
    last_refresh: new Date().toISOString(),
  };
}

/**
 * Overwrite ~/.codex/auth.json with the given connection's credentials.
 * Creates ~/.codex if absent.
 *
 * @param {object} connection providerConnection row (provider=codex)
 * @returns {Promise<{authPath: string, authData: object}>}
 */
export async function writeCodexAuthFile(connection) {
  const authData = buildCodexAuthJson(connection);
  const dir = getCodexDir();
  const authPath = getCodexAuthPath();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(authPath, JSON.stringify(authData, null, 2));
  return { authPath, authData };
}
