import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_INCIDENT_SEVERITY,
  INCIDENT_LIMITS,
  INCIDENT_SEVERITIES,
  defaultIncidentActions,
  type Incident,
  type IncidentSeverity,
  type StatusPage,
} from "@infrawrench/client-core";
import type { IncidentSeed, IncidentsClient } from "./types.js";

export interface DeclareIncidentModalProps {
  client: IncidentsClient;
  /** Pre-fill from the surface the operator was looking at when they clicked. */
  seed?: IncidentSeed | undefined;
  onDeclared: (incident: Incident) => void;
  onClose: () => void;
}

/**
 * The declare form.
 *
 * The design goal is that at 03:14 this is a *confirmation*, not a data-entry
 * exercise: a title (pre-filled when the operator came from a probe or an
 * alert), a severity, and four tick boxes for the errands. Everything else has
 * a defensible default, which is why the primary button is reachable without
 * scrolling past anything.
 *
 * The two errands with blast radius beyond the incident — freezing changes and
 * telling the public — are off by default and have to be ticked. The two that
 * only help — pinning the moment and telling your own org — are on.
 */
export function DeclareIncidentModal({
  client,
  seed,
  onDeclared,
  onClose,
}: DeclareIncidentModalProps) {
  const defaults = useMemo(() => defaultIncidentActions(), []);
  const [title, setTitle] = useState(seed?.title ?? "");
  const [severity, setSeverity] = useState<IncidentSeverity>(
    seed?.severity ?? DEFAULT_INCIDENT_SEVERITY,
  );
  const [summary, setSummary] = useState(seed?.summary ?? "");
  const [openFreeze, setOpenFreeze] = useState(defaults.openFreeze);
  const [pinMoment, setPinMoment] = useState(defaults.pinMoment);
  const [postSlack, setPostSlack] = useState(defaults.postSlack);
  const [statusPageId, setStatusPageId] = useState<string>("");
  const [pages, setPages] = useState<StatusPage[] | null>(null);
  const [componentIds, setComponentIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client.listStatusPages) {
      setPages([]);
      return;
    }
    client
      .listStatusPages()
      .then(setPages)
      // A status-page list that fails costs the picker, never the declaration.
      .catch(() => setPages([]));
  }, [client]);

  const selectedPage = pages?.find((page) => page.id === statusPageId) ?? null;

  const submit = async () => {
    if (!client.declareIncident) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setError("An incident needs a title.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const incident = await client.declareIncident({
        title: trimmed,
        severity,
        summary: summary.trim() || null,
        ...(seed?.startedAt ? { startedAt: seed.startedAt } : {}),
        ...(seed?.resourceIds?.length ? { affectedResourceIds: seed.resourceIds } : {}),
        actions: {
          openFreeze,
          pinMoment,
          postSlack,
          statusPageId: statusPageId || null,
          ...(componentIds.length > 0 ? { statusPageComponentIds: componentIds } : {}),
        },
      });
      onDeclared(incident);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to declare the incident");
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Declare an incident"
    >
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface-raised p-5 shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-on-surface">Declare an incident</h2>
        <p className="mt-1 text-xs text-on-surface-faint">
          Records the incident first, then does whatever you tick below. If one of those fails, the
          incident still stands and the failure is shown against it.
        </p>

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-on-surface-secondary">
              What is happening?
            </span>
            <input
              type="text"
              value={title}
              maxLength={INCIDENT_LIMITS.maxTitleLength}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Checkout is returning 500s"
              className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-on-surface"
              // Autofocus is right here specifically: this modal is opened by
              // somebody who already knows what they are typing.
              autoFocus
            />
          </label>

          <fieldset>
            <legend className="text-xs font-medium text-on-surface-secondary">Severity</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {INCIDENT_SEVERITIES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setSeverity(option.id)}
                  title={option.description}
                  aria-pressed={severity === option.id}
                  className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                    severity === option.id
                      ? "bg-blue-600 text-white"
                      : "bg-surface-sunken text-on-surface-secondary hover:bg-surface"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="block">
            <span className="text-xs font-medium text-on-surface-secondary">
              Summary <span className="text-on-surface-faint">(optional)</span>
            </span>
            <textarea
              value={summary}
              rows={2}
              maxLength={INCIDENT_LIMITS.maxSummaryLength}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What you know so far. Goes to Slack and, if you publish, to the status page."
              className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-on-surface"
            />
          </label>

          <fieldset className="rounded-xl border border-border p-3">
            <legend className="px-1 text-xs font-medium text-on-surface-secondary">
              And do this
            </legend>
            <label className="flex items-start gap-2 py-1">
              <input
                type="checkbox"
                checked={postSlack}
                onChange={(e) => setPostSlack(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm text-on-surface">
                Announce it
                <span className="block text-xs text-on-surface-faint">
                  Through your alert routing rules, so it lands wherever your alerts already do.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 py-1">
              <input
                type="checkbox"
                checked={pinMoment}
                onChange={(e) => setPinMoment(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm text-on-surface">
                Pin the moment
                <span className="block text-xs text-on-surface-faint">
                  Remembers when this started so "what changed around then" stays one click away.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 py-1">
              <input
                type="checkbox"
                checked={openFreeze}
                onChange={(e) => setOpenFreeze(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm text-on-surface">
                Freeze changes
                <span className="block text-xs text-on-surface-faint">
                  Blocks destructive actions org-wide until this incident resolves. Needs the
                  change-freeze permission.
                </span>
              </span>
            </label>

            {pages !== null && pages.length > 0 && (
              <div className="pt-2">
                <label className="block">
                  <span className="text-xs font-medium text-on-surface-secondary">
                    Tell the public
                  </span>
                  <select
                    value={statusPageId}
                    onChange={(e) => {
                      setStatusPageId(e.target.value);
                      setComponentIds([]);
                    }}
                    className="mt-1 w-full rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-on-surface"
                  >
                    <option value="">Don't post publicly</option>
                    {pages.map((page) => (
                      <option key={page.id} value={page.id}>
                        {page.title}
                        {page.published ? "" : " (unpublished)"}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedPage && selectedPage.components.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs text-on-surface-faint">
                      Affected components — leave all unticked to report the whole page.
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {selectedPage.components.map((component) => {
                        const checked = componentIds.includes(component.id);
                        return (
                          <button
                            key={component.id}
                            type="button"
                            aria-pressed={checked}
                            onClick={() =>
                              setComponentIds((prev) =>
                                checked
                                  ? prev.filter((id) => id !== component.id)
                                  : [...prev, component.id],
                              )
                            }
                            className={`px-2 py-1 rounded-lg text-xs transition-colors ${
                              checked
                                ? "bg-blue-600 text-white"
                                : "bg-surface-sunken text-on-surface-secondary hover:bg-surface"
                            }`}
                          >
                            {component.label ?? component.probeName ?? "Component"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </fieldset>

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-sm text-on-surface-secondary hover:bg-surface-sunken transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || !title.trim()}
            className="px-3 py-1.5 rounded-lg text-sm bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white transition-colors"
          >
            {saving ? "Declaring…" : "Declare"}
          </button>
        </div>
      </div>
    </div>
  );
}
