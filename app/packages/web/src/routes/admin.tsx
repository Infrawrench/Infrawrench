import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { apiGet, apiPut } from "@/lib/api";

interface AdminOrg {
  id: string;
  displayName: string;
  complimentary: boolean;
  createdAt: string;
  memberCount: number;
  subscriptionStatus: string | null;
}

export const Route = createFileRoute("/admin")({
  component: AdminPage,
});

function AdminPage() {
  const [orgs, setOrgs] = useState<AdminOrg[] | undefined>(undefined);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);

  useEffect(() => {
    apiGet<AdminOrg[]>("/api/admin/organizations")
      .then(setOrgs)
      .catch((e) => {
        if (e instanceof Error && e.message === "Forbidden") setForbidden(true);
        else setError(e instanceof Error ? e.message : "Failed to load organizations");
      });
  }, []);

  async function toggleComplimentary(org: AdminOrg) {
    setBusyOrgId(org.id);
    setError(null);
    try {
      const updated = await apiPut<{ id: string; complimentary: boolean }>(
        `/api/admin/organizations/${encodeURIComponent(org.id)}/complimentary`,
        { complimentary: !org.complimentary },
      );
      setOrgs((prev) =>
        prev?.map((o) =>
          o.id === updated.id ? { ...o, complimentary: updated.complimentary } : o,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update organization");
    } finally {
      setBusyOrgId(null);
    }
  }

  if (forbidden) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface">
        <div className="text-center">
          <h1 className="text-lg font-semibold mb-2">Platform admin</h1>
          <p className="text-sm text-on-surface-tertiary mb-4">
            Your account is not on the platform admin allowlist.
          </p>
          <a href="/" className="text-sm text-info hover:underline">
            Back to the app
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface text-on-surface px-8 py-10">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-xl font-semibold">Platform admin</h1>
          <a href="/" className="text-sm text-info hover:underline">
            Back to the app
          </a>
        </div>
        <p className="text-sm text-on-surface-tertiary mb-6">
          Complimentary organizations get every paid feature, uncapped AI chat, and are never
          billed.
        </p>

        {error && <p className="text-sm text-danger mb-3">{error}</p>}

        {orgs === undefined ? (
          <p className="text-sm text-on-surface-faint">Loading…</p>
        ) : orgs.length === 0 ? (
          <p className="text-sm text-on-surface-faint">No organizations yet.</p>
        ) : (
          <div className="border border-border rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Organizations</caption>
              <thead>
                <tr className="text-left text-xs text-on-surface-muted border-b border-border">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Organization
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Members
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Subscription
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Created
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">
                    Complimentary
                  </th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => (
                  <tr key={org.id} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{org.displayName}</div>
                      <div className="text-xs text-on-surface-muted">{org.id}</div>
                    </td>
                    <td className="px-4 py-3 text-on-surface-secondary">{org.memberCount}</td>
                    <td className="px-4 py-3">
                      {org.complimentary ? (
                        <span className="text-xs font-medium px-2 py-1 rounded-full bg-purple-500/10 text-notice">
                          Complimentary
                        </span>
                      ) : (
                        <span className="text-xs text-on-surface-tertiary">
                          {org.subscriptionStatus ?? "free"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-on-surface-tertiary">
                      {new Date(org.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => void toggleComplimentary(org)}
                        disabled={busyOrgId === org.id}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 ${
                          org.complimentary
                            ? "border border-border-strong text-on-surface-secondary hover:text-on-surface"
                            : "bg-purple-600 hover:bg-purple-500 text-white"
                        }`}
                      >
                        {busyOrgId === org.id ? "Saving…" : org.complimentary ? "Revoke" : "Grant"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
