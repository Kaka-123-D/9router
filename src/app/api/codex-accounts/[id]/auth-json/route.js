import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { buildCodexAuthJson } from "@/lib/codexAuthFile";

export const dynamic = "force-dynamic";

// GET /api/codex-accounts/[id]/auth-json
// Build the ~/.codex/auth.json payload from this connection and stream it back
// as a downloadable file. Lets the user move an account between machines or
// keep a backup. Refuses accounts without a real refresh_token (native Codex
// CLI rejects empty/missing rt_).
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection || connection.provider !== "codex") {
      return NextResponse.json({ error: "Codex account not found" }, { status: 404 });
    }
    if (!connection.accessToken || !connection.refreshToken) {
      return NextResponse.json(
        { error: "Account is missing access_token or refresh_token — auth.json would be unusable" },
        { status: 400 }
      );
    }

    const authData = buildCodexAuthJson(connection);
    const safeName = (connection.email || connection.name || id).replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `auth-${safeName}.json`;

    return new NextResponse(JSON.stringify(authData, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Codex auth.json download error:", error);
    return NextResponse.json({ error: "Failed to build auth.json" }, { status: 500 });
  }
}
