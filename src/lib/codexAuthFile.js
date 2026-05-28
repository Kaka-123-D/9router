import fs from "fs/promises";
import path from "path";
import os from "os";

// Codex CLI stores credentials at ~/.codex/auth.json with this shape:
//   { auth_mode, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }
// access_token is a ~10-day JWT; refresh_token ("rt_...") is an opaque rotating OAuth token.

export const getCodexDir = () => path.join(os.homedir(), ".codex");
export const getCodexAuthPath = () => path.join(getCodexDir(), "auth.json");

/**
 * Build the ~/.codex/auth.json object from a stored provider connection. Pure.
 * Callers must ensure the connection has a non-empty refreshToken — native
 * Codex CLI rejects both missing and empty `refresh_token`.
 *
 * @param {object} connection providerConnection row (provider=codex)
 * @returns {object}
 */
export function buildCodexAuthJson(connection) {
  const psd = connection?.providerSpecificData || {};
  // Native Codex CLI requires every field in tokens to be a non-empty string
  // (serde rejects missing fields, OpenAI rejects empty refresh_token).
  // Callers must guard against connections without a real refresh_token.
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
 * Read ~/.codex/auth.json if present. Returns null when missing or invalid —
 * never throws — so callers can probe state without try/catch noise.
 *
 * @returns {Promise<object|null>}
 */
export async function readCodexAuthFile() {
  try {
    const content = await fs.readFile(getCodexAuthPath(), "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
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
