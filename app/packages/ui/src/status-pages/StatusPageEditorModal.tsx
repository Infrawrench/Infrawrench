import { useId, useState } from "react";
import {
  STATUS_PAGE_LIMITS,
  validateStatusPageInput,
  type StatusPage,
  type StatusPageComponentInput,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";

export interface StatusPageEditorModalProps {
  /** The page being edited, or null to create a new one. */
  page: StatusPage | null;
  /** Probes available to publish. */
  probes: { id: string; name: string }[];
  onCancel: () => void;
  onSave: (input: {
    title: string;
    description: string | null;
    supportUrl: string | null;
    showHistory: boolean;
    showUptime: boolean;
    components: StatusPageComponentInput[];
  }) => Promise<void>;
}

interface DraftComponent extends StatusPageComponentInput {
  /** The probe's internal name, for the row's fallback hint. */
  probeName: string;
}

/**
 * Create/edit a status page: its wording, what it publishes, and what each
 * published probe is called in public.
 *
 * Publishing is deliberately **not** in this modal. Making a page reachable by
 * anyone with the link is a different kind of decision from renaming a
 * component, and burying it among six other fields is how it gets flipped by
 * accident — the panel exposes it as its own explicit toggle instead.
 */
export function StatusPageEditorModal({
  page,
  probes,
  onCancel,
  onSave,
}: StatusPageEditorModalProps) {
  const [title, setTitle] = useState(page?.title ?? "");
  const [description, setDescription] = useState(page?.description ?? "");
  const [supportUrl, setSupportUrl] = useState(page?.supportUrl ?? "");
  const [showHistory, setShowHistory] = useState(page?.showHistory ?? true);
  const [showUptime, setShowUptime] = useState(page?.showUptime ?? true);
  const [components, setComponents] = useState<DraftComponent[]>(
    () =>
      page?.components.map((c) => ({
        probeId: c.probeId,
        label: c.label,
        groupName: c.groupName,
        probeName: c.probeName,
      })) ?? [],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uid = useId();

  const chosen = new Set(components.map((c) => c.probeId));
  const available = probes.filter((p) => !chosen.has(p.id));

  const addProbe = (probeId: string) => {
    const probe = probes.find((p) => p.id === probeId);
    if (!probe) return;
    setComponents((current) => [
      ...current,
      { probeId: probe.id, label: null, groupName: null, probeName: probe.name },
    ]);
    setProblem(null);
  };

  const updateComponent = (index: number, patch: Partial<DraftComponent>) => {
    setComponents((current) => current.map((c, i) => (i === index ? { ...c, ...patch } : c)));
    setProblem(null);
  };

  const removeComponent = (index: number) => {
    setComponents((current) => current.filter((_, i) => i !== index));
  };

  /** Move a component one slot; order here is the public render order. */
  const move = (index: number, delta: number) => {
    setComponents((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  };

  const submit = async () => {
    const input = {
      title: title.trim(),
      description: description.trim() || null,
      supportUrl: supportUrl.trim() || null,
      showHistory,
      showUptime,
      components: components.map((c) => ({
        probeId: c.probeId,
        label: c.label?.trim() || null,
        groupName: c.groupName?.trim() || null,
      })),
    };
    const invalid = validateStatusPageInput(input);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onSave(input);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onCancel} ariaLabel={page ? "Edit status page" : "New status page"}>
      <div className="flex max-h-[85vh] w-[42rem] max-w-[90vw] flex-col gap-4 overflow-auto rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-on-surface">
          {page ? "Edit status page" : "New status page"}
        </h2>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-on-surface-secondary">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={STATUS_PAGE_LIMITS.maxTitleLength}
            placeholder="Acme API status"
            className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-on-surface"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-on-surface-secondary">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={STATUS_PAGE_LIMITS.maxDescriptionLength}
            placeholder="Live status of the Acme public API and dashboard."
            className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-on-surface"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-on-surface-secondary">Support link</span>
          <input
            type="url"
            value={supportUrl}
            onChange={(e) => setSupportUrl(e.target.value)}
            placeholder="https://acme.com/support"
            className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-on-surface"
          />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-on-surface-secondary">What to show</legend>
          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={showUptime}
              onChange={(e) => setShowUptime(e.target.checked)}
            />
            Show 24-hour uptime percentages
          </label>
          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={showHistory}
              onChange={(e) => setShowHistory(e.target.checked)}
            />
            Show {STATUS_PAGE_LIMITS.historyDays}-day uptime history
          </label>
        </fieldset>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-on-surface-secondary">Components</span>
            <select
              value=""
              aria-label="Add a probe"
              onChange={(e) => {
                if (e.target.value) addProbe(e.target.value);
              }}
              disabled={available.length === 0}
              className="rounded-lg border border-border bg-surface-raised px-2 py-1 text-xs text-on-surface disabled:opacity-50"
            >
              <option value="">
                {available.length === 0 ? "All probes added" : "Add a probe…"}
              </option>
              {available.map((probe) => (
                <option key={probe.id} value={probe.id}>
                  {probe.name}
                </option>
              ))}
            </select>
          </div>

          {components.length === 0 ? (
            <p className="text-xs text-on-surface-faint">
              A page with no components publishes nothing. Add the probes whose state you want
              visitors to see.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {components.map((component, index) => (
                <li
                  key={component.probeId}
                  className="flex flex-col gap-2 rounded-xl border border-border p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-on-surface-tertiary">{component.probeName}</span>
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => move(index, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${component.probeName} up`}
                        className="rounded px-2 py-0.5 text-xs text-on-surface-secondary hover:text-on-surface disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => move(index, 1)}
                        disabled={index === components.length - 1}
                        aria-label={`Move ${component.probeName} down`}
                        className="rounded px-2 py-0.5 text-xs text-on-surface-secondary hover:text-on-surface disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => removeComponent(index)}
                        aria-label={`Remove ${component.probeName}`}
                        className="rounded px-2 py-0.5 text-xs text-on-surface-tertiary hover:text-danger"
                      >
                        Remove
                      </button>
                    </span>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <label htmlFor={`${uid}-label-${component.probeId}`} className="flex-1">
                      <span className="mb-1 block text-xs text-on-surface-tertiary">
                        Public name
                      </span>
                      <input
                        id={`${uid}-label-${component.probeId}`}
                        type="text"
                        value={component.label ?? ""}
                        onChange={(e) => updateComponent(index, { label: e.target.value })}
                        maxLength={STATUS_PAGE_LIMITS.maxLabelLength}
                        placeholder={`Public name (default: ${component.probeName})`}
                        className="w-full rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface"
                      />
                    </label>
                    <label htmlFor={`${uid}-group-${component.probeId}`} className="flex-1">
                      <span className="mb-1 block text-xs text-on-surface-tertiary">Group</span>
                      <input
                        id={`${uid}-group-${component.probeId}`}
                        type="text"
                        value={component.groupName ?? ""}
                        onChange={(e) => updateComponent(index, { groupName: e.target.value })}
                        maxLength={STATUS_PAGE_LIMITS.maxGroupNameLength}
                        placeholder="Group (optional)"
                        className="w-full rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface"
                      />
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-on-surface-faint">
            Visitors see the public name and the current state. Probe URLs, accounts and error
            detail are never published.
          </p>
        </div>

        {problem !== null && (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary hover:text-on-surface"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
          >
            {busy ? "Saving…" : page ? "Save changes" : "Create page"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
