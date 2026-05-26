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

    const { authPath } = await writeCodexAuthFile(connection);
    await updateSettings({ activeCodexConnectionId: id });

    return NextResponse.json({ success: true, authPath, activeCodexConnectionId: id });
  } catch (error) {
    console.log("Codex activate error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
