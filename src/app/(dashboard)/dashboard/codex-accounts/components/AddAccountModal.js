"use client";

import { useState } from "react";
import { Modal, Button, Input, SegmentedControl } from "@/shared/components";

const TABS = [
  { value: "session", label: "Paste Session", icon: "content_paste" },
  { value: "oauth", label: "OAuth Login", icon: "login" },
];

const SESSION_PLACEHOLDER = `Paste the JSON from https://chatgpt.com/api/auth/session
{"user":{...},"accessToken":"eyJ...","account":{"id":"..."},...}`;

// Modal for adding a Codex account by either pasting a ChatGPT session JSON
// or starting the OAuth login flow (handled by the parent via onStartOAuth).
export default function AddAccountModal({ isOpen, onClose, onImported, onStartOAuth }) {
  const [tab, setTab] = useState("session");
  const [sessionJson, setSessionJson] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setSessionJson("");
    setRefreshToken("");
    setName("");
    setError(null);
    setSubmitting(false);
    setTab("session");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleImport = async () => {
    setError(null);
    if (!sessionJson.trim()) {
      setError("Please paste the session JSON");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/codex-accounts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionJson,
          refreshToken: refreshToken.trim() || undefined,
          name: name.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      reset();
      onImported?.(data.connection);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Add Codex Account"
      size="lg"
      footer={
        tab === "session" ? (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={handleClose} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleImport} loading={submitting}>
              Import
            </Button>
          </div>
        ) : null
      }
    >
      <div className="space-y-4">
        <SegmentedControl options={TABS} value={tab} onChange={setTab} size="sm" />

        {tab === "session" ? (
          <div className="space-y-3">
            <p className="text-xs text-text-muted">
              Paste the full JSON from{" "}
              <code className="text-[11px]">chatgpt.com/api/auth/session</code>. 9Router converts
              it into the Codex <code className="text-[11px]">auth.json</code> format. Without a
              refresh token the account works until the access token expires (~10 days).
            </p>

            <textarea
              value={sessionJson}
              onChange={(e) => setSessionJson(e.target.value)}
              placeholder={SESSION_PLACEHOLDER}
              rows={8}
              spellCheck={false}
              className="w-full rounded-[10px] border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] text-text-main outline-none focus:border-brand-500/50 resize-y"
            />

            <Input
              label="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Defaults to the account email"
            />

            <Input
              label="Refresh token (optional)"
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              placeholder="rt_... — paste to enable auto-refresh (lives indefinitely)"
              hint="From an existing ~/.codex/auth.json (tokens.refresh_token). Leave empty for a 10-day session token."
            />

            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-text-muted">
              Log in with ChatGPT through the standard OAuth flow. This obtains a real refresh
              token (<code className="text-[11px]">rt_...</code>), so 9Router keeps the account
              alive indefinitely.
            </p>
            <Button
              variant="primary"
              icon="login"
              onClick={() => {
                reset();
                onStartOAuth?.();
              }}
            >
              Start ChatGPT Login
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
