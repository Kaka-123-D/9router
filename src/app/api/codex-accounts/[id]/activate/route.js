import { NextResponse } from "next/server";
import { getProviderConnectionById, updateSettings } from "@/lib/localDb";
import { writeCodexAuthFile } from "@/lib/codexAuthFile";

// POST /api/codex-accounts/[id]/activate
// Overwrite ~/.codex/auth.json with this account's credentials and record it as
// the single active account. Used to switch which account the native Codex CLI uses.
export async function POST(request, { params }) {
  try {
    const { id } = await params;

    const connection = await getProviderConnectionById(id);
    if (!connection || connection.provider !== "codex") {
      return NextResponse.json({ error: "Codex account not found" }, { status: 404 });
    }
    if (!connection.accessToken) {
      return NextResponse.json({ error: "Account has no access token to write" }, { status: 400 });
    }
    // Native Codex CLI requires a real refresh_token (its parser rejects missing
    // and OpenAI rejects empty). Session-imported accounts without rt_ cannot be
    // used with native CLI — route them through 9Router proxy instead.
    if (!connection.refreshToken) {
      return NextResponse.json(
        {
          error:
            "Session accounts (no refresh token) cannot be activated for native Codex CLI. " +
            "Use OAuth Login when adding the account to get a real refresh token, " +
            "or route Codex CLI through 9Router (CLI Tools tab) to use this account via proxy.",
        },
        { status: 400 }
      );
    }

    const { authPath } = await writeCodexAuthFile(connection);
    await updateSettings({ activeCodexConnectionId: id });

    return NextResponse.json({ success: true, authPath, activeCodexConnectionId: id });
  } catch (error) {
    console.log("Codex activate error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
