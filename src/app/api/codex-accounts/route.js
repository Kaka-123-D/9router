import { NextResponse } from "next/server";
import { getProviderConnections, getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/codex-accounts
// List all Codex provider connections with UI-friendly, token-free metadata.
export async function GET() {
  try {
    const [connections, settings] = await Promise.all([
      getProviderConnections({ provider: "codex" }),
      getSettings(),
    ]);

    const activeId = settings.activeCodexConnectionId || null;

    const accounts = connections.map((c) => {
      const psd = c.providerSpecificData || {};
      return {
        id: c.id,
        name: c.name,
        email: c.email,
        authType: c.authType,
        plan: psd.chatgptPlanType || null,
        accountId: psd.chatgptAccountId || null,
        hasRefreshToken: !!c.refreshToken,
        hasAccessToken: !!c.accessToken,
        accessTokenExpiresAt: c.expiresAt || null,
        testStatus: c.testStatus || null,
        isEnabled: c.isActive !== false,
        isActiveFile: c.id === activeId,
        priority: c.priority,
        createdAt: c.createdAt,
      };
    });

    return NextResponse.json({ accounts, activeCodexConnectionId: activeId });
  } catch (error) {
    console.log("Codex accounts list error:", error);
    return NextResponse.json({ error: "Failed to list Codex accounts" }, { status: 500 });
  }
}
