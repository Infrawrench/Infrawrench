import { useCallback, useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import { useSettingsHost, type SettingsApi } from "./host.js";

interface ChangeFreeze {
  id: string;
  name: string;
  reason: string | null;
  startsAt: string;
  endsAt: string | null;
  active: boolean;
  createdAt: string;
}

function isInEffect(freeze: ChangeFreeze, now: number): boolean {
  if (!freeze.active) return false;
  if (new Date(freeze.startsAt).getTime() > now) return false;
  return freeze.endsAt === null || new Date(freeze.endsAt).getTime() > now;
}

function isScheduled(freeze: ChangeFreeze, now: number): boolean {
  return freeze.active && new Date(freeze.startsAt).getTime() > now;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function FreezesSection() {
  const gt = useGT();
  const { orgId, api, has, onChangeFreezesChanged } = useSettingsHost();
  const canWrite = has("freezes:write");
  const notifyChanged = () => onChangeFreezesChanged?.();

  const [freezes, setFreezes] = useState<ChangeFreeze[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFreezes(await api.get<ChangeFreeze[]>(`/api/org/${orgId}/change-freezes`));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load freeze windows"));
    } finally {
      setLoading(false);
    }
  }, [api, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function endFreeze(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/api/org/${orgId}/change-freezes/${id}/end`);
      notifyChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to end freeze"));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteFreeze(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.delete(`/api/org/${orgId}/change-freezes/${id}`);
      notifyChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to delete freeze"));
    } finally {
      setBusyId(null);
    }
  }

  const now = Date.now();

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{gt("Change Freezes")}</h1>
          <T>
            <p className="text-sm text-on-surface-muted mt-1">
              While a freeze is in effect, destructive actions — deleting resources, destructive
              plugin actions, destroying secret versions, rolling back deployments — are blocked for
              everyone. Admins can override individual actions; blocks and overrides are recorded in
              the audit log.
            </p>
          </T>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors whitespace-nowrap"
          >
            {showCreate ? gt("Cancel") : gt("Declare freeze")}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      {showCreate && canWrite && (
        <CreateFreezeForm
          api={api}
          orgId={orgId}
          onCreated={() => {
            setShowCreate(false);
            notifyChanged();
            void load();
          }}
        />
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : freezes.length === 0 ? (
        <T>
          <p className="text-sm text-on-surface-muted">
            No freeze windows yet. Declare one before a holiday weekend, a big launch, or an
            incident review to keep destructive changes out of production.
          </p>
        </T>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-xs text-on-surface-muted">
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Name")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Status")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Starts")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Ends")}
                </th>
                {canWrite && (
                  <th scope="col" className="text-right px-4 py-2 font-medium">
                    {gt("Actions")}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {freezes.map((freeze) => {
                const inEffect = isInEffect(freeze, now);
                const scheduled = isScheduled(freeze, now);
                return (
                  <tr
                    key={freeze.id}
                    className="border-b border-border/50 hover:bg-surface-raised/50"
                  >
                    <td className="px-4 py-2 text-sm text-on-surface-secondary">
                      <div>{freeze.name}</div>
                      {freeze.reason && (
                        <div className="text-xs text-on-surface-muted mt-0.5">{freeze.reason}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {inEffect ? (
                        <span className="inline-block px-2 py-0.5 rounded-full bg-amber-500/15 text-warning font-medium">
                          {gt("In effect")}
                        </span>
                      ) : scheduled ? (
                        <span className="inline-block px-2 py-0.5 rounded-full bg-blue-500/15 text-info font-medium">
                          {gt("Scheduled")}
                        </span>
                      ) : (
                        <span className="inline-block px-2 py-0.5 rounded-full bg-surface-overlay text-on-surface-muted">
                          {gt("Ended")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-on-surface-tertiary">
                      {formatDateTime(freeze.startsAt)}
                    </td>
                    <td className="px-4 py-2 text-xs text-on-surface-tertiary">
                      {freeze.endsAt ? formatDateTime(freeze.endsAt) : gt("Open-ended")}
                    </td>
                    {canWrite && (
                      <td className="px-4 py-2 text-right">
                        <div className="flex gap-3 justify-end">
                          {(inEffect || scheduled) && (
                            <button
                              type="button"
                              onClick={() => void endFreeze(freeze.id)}
                              disabled={busyId === freeze.id}
                              className="text-xs text-warning hover:opacity-80 disabled:opacity-50"
                            >
                              {busyId === freeze.id ? gt("Ending…") : gt("End now")}
                            </button>
                          )}
                          {!inEffect && !scheduled && (
                            <button
                              type="button"
                              onClick={() => void deleteFreeze(freeze.id)}
                              disabled={busyId === freeze.id}
                              className="text-xs text-danger hover:text-danger-strong disabled:opacity-50"
                            >
                              {gt("Delete")}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CreateFreezeForm({
  api,
  orgId,
  onCreated,
}: {
  api: SettingsApi;
  orgId: string;
  onCreated: () => void;
}) {
  const gt = useGT();
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) {
      setError(gt("Name is required"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/org/${orgId}/change-freezes`, {
        name: name.trim(),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(startsAt ? { startsAt: new Date(startsAt).toISOString() } : {}),
        ...(endsAt ? { endsAt: new Date(endsAt).toISOString() } : {}),
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to declare freeze"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mb-6 border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-on-surface-muted">{gt("Name")}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={gt("Holiday freeze")}
            className="mt-1 w-full px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong"
          />
        </label>
        <label className="block">
          <span className="text-xs text-on-surface-muted">{gt("Reason (optional)")}</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={gt("No production changes over the holidays.")}
            className="mt-1 w-full px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong"
          />
        </label>
        <label className="block">
          <span className="text-xs text-on-surface-muted">
            {gt("Starts (optional — defaults to now)")}
          </span>
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="mt-1 w-full px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong"
          />
        </label>
        <label className="block">
          <span className="text-xs text-on-surface-muted">
            {gt("Ends (optional — open-ended)")}
          </span>
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className="mt-1 w-full px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong"
          />
        </label>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          {submitting ? gt("Declaring…") : gt("Declare freeze")}
        </button>
      </div>
    </div>
  );
}
