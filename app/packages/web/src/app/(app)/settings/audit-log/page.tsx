"use client";

import { useState, useEffect } from "react";
import { listAuditLogs, type AuditLogEntry, type AuditLogFilters } from "@/actions/audit";

const ACTION_LABELS: Record<string, string> = {
  "account.create": "Created account",
  "account.delete": "Deleted account",
  "account.update": "Updated account",
  "resource.create": "Created resource",
  "resource.delete": "Deleted resource",
  "resource.sync": "Synced resources",
  "dashboard.create": "Created dashboard",
  "dashboard.delete": "Deleted dashboard",
  "dashboard.pin": "Pinned resource",
  "dashboard.unpin": "Unpinned resource",
  "api_key.create": "Created API key",
  "api_key.revoke": "Revoked API key",
  "api_key.rotate": "Rotated API key",
  "member.invite": "Invited member",
  "member.remove": "Removed member",
  "member.role_change": "Changed member role",
  "invitation.accept": "Accepted invitation",
  "subscription.create": "Created subscription",
  "subscription.cancel": "Canceled subscription",
  "subscription.seat_change": "Changed seat count",
  "auth.login": "Logged in",
  "auth.logout": "Logged out",
  "sync.push": "Pushed sync data",
  "sync.pull": "Pulled sync data",
};

const ENTITY_TYPES = ["account", "resource", "dashboard", "api_key", "member", "subscription"];

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<AuditLogFilters>({});
  const pageSize = 25;

  useEffect(() => {
    setLoading(true);
    listAuditLogs({ page, pageSize, filters }).then((result) => {
      setEntries(result.entries);
      setTotal(result.total);
      setLoading(false);
    });
  }, [page, filters]);

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">Audit Log</h1>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select
          value={filters.entityType ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            setFilters((f) => {
              const next = { ...f };
              if (val) next.entityType = val;
              else delete next.entityType;
              return next;
            });
            setPage(1);
          }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200"
        >
          <option value="">All types</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500">
              <th className="text-left px-4 py-2 font-medium">Time</th>
              <th className="text-left px-4 py-2 font-medium">User</th>
              <th className="text-left px-4 py-2 font-medium">Action</th>
              <th className="text-left px-4 py-2 font-medium">Entity</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-600">
                  Loading...
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-600">
                  No audit events found.
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <tr key={entry.id} className="border-b border-gray-800/50 hover:bg-gray-900/50">
                  <td className="px-4 py-2 text-xs text-gray-400 whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-300">
                    {entry.userName ?? entry.userEmail ?? (entry.apiKeyId ? `API Key` : "System")}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-200">
                    {ACTION_LABELS[entry.action] ?? entry.action}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500 font-mono">
                    {entry.entityType}:{entry.entityId.slice(0, 12)}...
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-gray-500">{total} events</p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1 text-sm border border-gray-700 rounded-lg text-gray-400 hover:text-gray-200 disabled:opacity-30"
            >
              Previous
            </button>
            <span className="px-3 py-1 text-sm text-gray-400">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1 text-sm border border-gray-700 rounded-lg text-gray-400 hover:text-gray-200 disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
