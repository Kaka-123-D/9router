"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, Button, Badge, OAuthModal, ConfirmModal, PageLoading } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import AddAccountModal from "./components/AddAccountModal";

const CODEX_INFO = AI_PROVIDERS.codex;

function formatExpiry(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return { label: "expired", expired: true };
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  return { label: days > 0 ? `${days}d ${hours}h left` : `${hours}h left`, expired: false };
}

// Codex usage returns quotas keyed by window; `remaining` is a percentage (total=100)
// and `windowSeconds` is the real window length. Label by duration, not the map key —
// free plans expose only a single 7d window (which arrives under the "session" key).
function formatWindowLabel(win, key) {
  const s = win?.windowSeconds;
  if (s) {
    const hours = s / 3600;
    return hours < 24 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
  }
  if (key.includes("weekly")) return "7d";
  if (key.includes("session")) return "5h";
  return key;
}

function QuotaInline({ quota }) {
  if (!quota || quota.loading) {
    return <span className="text-[11px] text-text-muted">· quota…</span>;
  }
  if (quota.error) return null;

  const q = quota.quotas || {};
  // Main windows only (skip code-review windows); order shortest → longest.
  const windows = Object.entries(q)
    .filter(([key]) => !key.startsWith("review"))
    .map(([key, win]) => ({
      key,
      win,
      label: formatWindowLabel(win, key),
      order: win?.windowSeconds || (key.includes("weekly") ? 604800 : 18000),
    }))
    .sort((a, b) => a.order - b.order);

  if (windows.length === 0) {
    return <span className="text-[11px] text-text-muted">· quota n/a</span>;
  }

  return (
    <>
      {windows.map(({ key, win, label }) => {
        const raw = win.remaining ?? (100 - (win.used || 0));
        const rem = Math.max(0, Math.min(100, Math.round(raw)));
        return (
          <span key={key} className="inline-flex items-center gap-1 text-[11px]" title={`${label} window — ${rem}% left`}>
            <span className="text-text-muted">{label}</span>
            <span className="h-1.5 w-10 rounded-full bg-surface-3 overflow-hidden">
              <span
                className={`block h-full ${rem <= 10 ? "bg-red-500" : "bg-brand-500"}`}
                style={{ width: `${rem}%` }}
              />
            </span>
            <span className={rem <= 10 ? "text-red-500" : "text-text-main"}>{rem}%</span>
          </span>
        );
      })}
    </>
  );
}

function AccountRow({ account, quota, onActivate, onDelete, activating }) {
  const expiry = formatExpiry(account.accessTokenExpiresAt);
  const isExpired = account.testStatus === "expired" || expiry?.expired;

  return (
    <div
      className={`flex items-center gap-3 p-4 rounded-[14px] border shadow-[var(--shadow-soft)] transition-colors ${
        account.isActiveFile
          ? "border-brand-500/50 bg-brand-500/5"
          : "border-border-subtle bg-surface hover:bg-surface-2"
      }`}
    >
      <label className="flex items-center cursor-pointer shrink-0" title="Write this account to ~/.codex/auth.json">
        <input
          type="radio"
          name="codex-active"
          checked={account.isActiveFile}
          onChange={() => onActivate(account)}
          disabled={activating}
          className="size-4 accent-brand-500 cursor-pointer"
        />
      </label>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-sm text-text-main truncate">
            {account.name || account.email || "Codex account"}
          </h3>
          {account.isActiveFile && <Badge variant="primary" size="sm">ACTIVE</Badge>}
          {account.hasRefreshToken ? (
            <Badge variant="success" size="sm">auto-refresh</Badge>
          ) : (
            <Badge variant="default" size="sm">session (~10d)</Badge>
          )}
          {isExpired && <Badge variant="error" size="sm">expired</Badge>}
          {account.plan && <Badge variant="default" size="sm">{account.plan}</Badge>}
        </div>
        <div className="text-xs text-text-muted mt-0.5 flex items-center gap-2 flex-wrap">
          {account.email && <span className="truncate">{account.email}</span>}
          {account.accountId && (
            <code className="text-[10px]">{account.accountId.slice(0, 8)}…</code>
          )}
          {expiry && !expiry.expired && <span>· {expiry.label}</span>}
          <QuotaInline quota={quota} />
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant={account.isActiveFile ? "secondary" : "outline"}
          size="sm"
          icon="switch_account"
          onClick={() => onActivate(account)}
          loading={activating}
        >
          {account.isActiveFile ? "Re-write" : "Switch"}
        </Button>
        <Button variant="ghost" size="sm" icon="delete" onClick={() => onDelete(account)} />
      </div>
    </div>
  );
}

export default function CodexAccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showOAuth, setShowOAuth] = useState(false);
  const [activatingId, setActivatingId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState(null);
  const [quotas, setQuotas] = useState({});
  const quotaFetchedRef = useRef(new Set());

  // Fetch remaining quota for one account via the shared usage endpoint.
  // Fetched at most once per id unless force=true (manual refresh).
  const loadQuota = useCallback(async (id, force = false) => {
    if (!force && quotaFetchedRef.current.has(id)) return;
    quotaFetchedRef.current.add(id);
    setQuotas((prev) => ({ ...prev, [id]: { loading: true } }));
    try {
      const res = await fetch(`/api/usage/${id}`);
      const data = await res.json();
      setQuotas((prev) => ({ ...prev, [id]: data }));
    } catch {
      setQuotas((prev) => ({ ...prev, [id]: { error: true } }));
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/codex-accounts");
      const data = await res.json();
      const list = data.accounts || [];
      setAccounts(list);
      // Fire-and-forget quota fetches (parallel, deduped by ref).
      list.forEach((a) => { if (a.hasAccessToken) loadQuota(a.id); });
    } catch {
      setToast({ type: "error", msg: "Failed to load accounts" });
    } finally {
      setLoading(false);
    }
  }, [loadQuota]);

  const refreshAllQuotas = useCallback(() => {
    accounts.forEach((a) => { if (a.hasAccessToken) loadQuota(a.id, true); });
  }, [accounts, loadQuota]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAccounts();
  }, [loadAccounts]);

  const handleActivate = async (account) => {
    setActivatingId(account.id);
    setToast(null);
    try {
      const res = await fetch(`/api/codex-accounts/${account.id}/activate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Activate failed");
      setToast({ type: "success", msg: `Wrote ${account.name || account.email} to ~/.codex/auth.json` });
      await loadAccounts();
    } catch (err) {
      setToast({ type: "error", msg: err.message });
    } finally {
      setActivatingId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/codex-accounts/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Delete failed");
      }
      setDeleteTarget(null);
      await loadAccounts();
    } catch (err) {
      setToast({ type: "error", msg: err.message });
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <PageLoading />;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-text-main">Codex Accounts</h1>
          <p className="text-xs text-text-muted mt-0.5">
            Manage multiple Codex accounts and switch which one the native Codex CLI uses.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {accounts.length > 0 && (
            <Button variant="outline" icon="refresh" onClick={refreshAllQuotas}>
              Refresh quota
            </Button>
          )}
          <Button variant="primary" icon="add" onClick={() => setShowAdd(true)}>
            Add account
          </Button>
        </div>
      </div>

      <Card padding="sm" className="border-amber-500/30 bg-amber-500/5">
        <div className="flex gap-2 text-xs text-text-muted">
          <span className="material-symbols-outlined text-[16px] text-amber-500 shrink-0">warning</span>
          <span>
            Switching writes the selected account into <code className="text-[11px]">~/.codex/auth.json</code>.
            Avoid using the same account through both 9Router proxy and the native Codex CLI at the
            same time — both rotate the same refresh token and OpenAI may revoke it (401).
          </span>
        </div>
      </Card>

      {toast && (
        <div
          className={`text-xs px-3 py-2 rounded-[10px] ${
            toast.type === "error"
              ? "bg-red-500/10 text-red-500"
              : "bg-green-500/10 text-green-600"
          }`}
        >
          {toast.msg}
        </div>
      )}

      {accounts.length === 0 ? (
        <Card padding="lg">
          <div className="text-center text-sm text-text-muted py-6">
            No Codex accounts yet. Click <b>Add account</b> to paste a session JSON or log in.
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              quota={quotas[account.id]}
              onActivate={handleActivate}
              onDelete={setDeleteTarget}
              activating={activatingId === account.id}
            />
          ))}
        </div>
      )}

      <AddAccountModal
        isOpen={showAdd}
        onClose={() => setShowAdd(false)}
        onImported={async () => {
          setShowAdd(false);
          setToast({ type: "success", msg: "Account added" });
          await loadAccounts();
        }}
        onStartOAuth={() => {
          setShowAdd(false);
          setShowOAuth(true);
        }}
      />

      <OAuthModal
        isOpen={showOAuth}
        provider="codex"
        providerInfo={CODEX_INFO}
        onSuccess={async () => {
          setShowOAuth(false);
          setToast({ type: "success", msg: "Account connected" });
          await loadAccounts();
        }}
        onClose={() => setShowOAuth(false)}
      />

      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        title="Delete Codex account"
        message={`Remove "${deleteTarget?.name || deleteTarget?.email || "this account"}" from 9Router? This does not touch ~/.codex/auth.json.`}
        confirmText="Delete"
        loading={deleting}
      />
    </div>
  );
}
