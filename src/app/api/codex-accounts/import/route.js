import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { parseCodexSessionJson } from "@/lib/codexAuthFile";

// POST /api/codex-accounts/import
// Import a Codex account from a pasted ChatGPT web-session JSON.
// Body: { sessionJson: string, refreshToken?: string, name?: string }
//
// Without a refresh token the account works until the access_token expires (~10 days).
// Supplying an "rt_..." refresh token lets 9Router auto-refresh it indefinitely.
export async function POST(request) {
  try {
    const { sessionJson, refreshToken, name } = await request.json();

    const info = parseCodexSessionJson(sessionJson);

    const rt = typeof refreshToken === "string" ? refreshToken.trim() : "";
    const hasRefresh = rt.length > 0;

    const providerSpecificData = {
      authMethod: hasRefresh ? "session_with_refresh" : "session",
      idToken: info.idToken,
    };
    if (info.accountId) providerSpecificData.chatgptAccountId = info.accountId;
    if (info.planType) providerSpecificData.chatgptPlanType = info.planType;
    if (info.jwtExp) providerSpecificData.jwtExp = info.jwtExp;

    const connection = await createProviderConnection({
      provider: "codex",
      authType: hasRefresh ? "oauth" : "access_token",
      accessToken: info.accessToken,
      refreshToken: hasRefresh ? rt : undefined,
      expiresAt: info.expiresAt || undefined,
      name: name || info.email || "Codex (session)",
      email: info.email,
      providerSpecificData,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        name: connection.name,
        email: connection.email,
        plan: providerSpecificData.chatgptPlanType || null,
        accountId: providerSpecificData.chatgptAccountId || null,
        hasRefreshToken: hasRefresh,
      },
    });
  } catch (error) {
    console.log("Codex session import error:", error);
    // parse/validation errors are client errors
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
