import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
  deleteProviderConnection,
  getSettings,
  updateSettings,
} from "@/lib/localDb";

// DELETE /api/codex-accounts/[id]
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const connection = await getProviderConnectionById(id);
    if (!connection || connection.provider !== "codex") {
      return NextResponse.json({ error: "Codex account not found" }, { status: 404 });
    }

    await deleteProviderConnection(id);

    // Clear the active pointer if it referenced the deleted account.
    const settings = await getSettings();
    if (settings.activeCodexConnectionId === id) {
      await updateSettings({ activeCodexConnectionId: null });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Codex account delete error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
