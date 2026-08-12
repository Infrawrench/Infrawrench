import { useState } from "react";
import { applyChosenParameters, type CaptureDraft } from "@infrawrench/client-core";
import type { EnvironmentAccount, EnvironmentsClient, EnvironmentTemplate } from "./types.js";

export interface CaptureTemplateModalProps {
  client: EnvironmentsClient;
  accounts: EnvironmentAccount[];
  onClose(): void;
  onCreated(template: EnvironmentTemplate): void;
}

/**
 * Capture a template in two steps, because the second one needs the first
 * one's answer: pick what to look at, then — over the draft the server built
 * from each plugin's own create-field metadata — choose which fields the
 * template should let you vary.
 *
 * The preview is deliberately a separate round-trip that persists nothing. It
 * is the only honest way to show what a capture actually caught: which fields
 * are reproducible, which references survived, and which resources had to be
 * skipped because their plugin cannot create them.
 */
export function CaptureTemplateModal({
  client,
  accounts,
  onClose,
  onCreated,
}: CaptureTemplateModalProps) {
  // Only an explicit choice is state; the effective account falls back to the
  // first one during render, so accounts arriving after mount need no
  // catch-up effect (and no frame where the select shows nothing).
  const [chosenAccountId, setChosenAccountId] = useState<string | null>(null);
  const accountId = chosenAccountId ?? accounts[0]?.id ?? "";
  const [tagKey, setTagKey] = useState("");
  const [tagValue, setTagValue] = useState("");
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await client.captureDraft({
        ...(accountId ? { accountId } : {}),
        ...(tagKey.trim() ? { tagKey: tagKey.trim() } : {}),
        ...(tagValue.trim() ? { tagValue: tagValue.trim() } : {}),
      });
      setDraft(next);
      setChosen(new Set(next.suggestedParameters.map((p) => p.key)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Capture failed");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft || !client.createTemplate) return;
    setBusy(true);
    setError(null);
    try {
      const applied = applyChosenParameters(draft, [...chosen]);
      const created = await client.createTemplate({
        name: name.trim(),
        description: description.trim() || null,
        parameters: applied.parameters,
        members: applied.members,
      });
      if (created) onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the template");
    } finally {
      setBusy(false);
    }
  };

  const referenceCount =
    draft?.members.reduce(
      (total, member) =>
        total +
        Object.values(member.fields).filter(
          (value) => value.kind === "output" || value.kind === "member-id",
        ).length,
      0,
    ) ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-surface-raised p-5">
        <h3 className="text-base font-semibold text-on-surface">Capture an environment template</h3>
        <p className="mt-1 text-xs text-on-surface-faint">
          Point this at the environment you already have. Every field comes from the plugin&apos;s
          own create form, so anything it can&apos;t create is reported rather than guessed at.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-on-surface-secondary sm:col-span-3">
            Account
            <select
              value={accountId}
              onChange={(e) => setChosenAccountId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName} ({account.pluginId})
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-on-surface-secondary">
            Tag key (optional)
            <input
              value={tagKey}
              onChange={(e) => setTagKey(e.target.value)}
              placeholder="env"
              className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
            />
          </label>
          <label className="text-xs text-on-surface-secondary">
            Tag value (optional)
            <input
              value={tagValue}
              onChange={(e) => setTagValue(e.target.value)}
              placeholder="staging"
              className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => void preview()}
              disabled={busy || accountId === ""}
              className="w-full rounded-lg bg-surface-sunken px-3 py-1.5 text-sm text-on-surface transition-colors hover:bg-surface disabled:opacity-50"
            >
              {busy && !draft ? "Reading…" : "Preview capture"}
            </button>
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        {draft && (
          <div className="mt-5 space-y-4">
            <div>
              <h4 className="text-sm font-medium text-on-surface">
                {draft.members.length} resource{draft.members.length === 1 ? "" : "s"} captured
                {referenceCount > 0 &&
                  ` · ${referenceCount} reference${referenceCount === 1 ? "" : "s"} preserved`}
              </h4>
              <ul className="mt-2 space-y-1">
                {draft.members.map((member) => (
                  <li
                    key={member.key}
                    className="rounded-lg border border-border bg-surface px-3 py-2 text-xs"
                  >
                    <span className="text-on-surface">{member.sourceName}</span>{" "}
                    <span className="text-on-surface-faint">
                      · {member.pluginId}/{member.resourceTypeId} ·{" "}
                      {Object.keys(member.fields).length} fields
                    </span>
                    {member.parentMember && (
                      <span className="text-on-surface-faint"> · inside {member.parentMember}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            {draft.skipped.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-amber-400">
                  {draft.skipped.length} skipped
                </h4>
                <ul className="mt-1 space-y-1">
                  {draft.skipped.map((item) => (
                    <li key={item.resourceId} className="text-xs text-on-surface-faint">
                      {item.displayName} — {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <h4 className="text-sm font-medium text-on-surface">What should vary?</h4>
              <p className="text-xs text-on-surface-faint">
                Checked fields become parameters you set at instantiation. Everything else is
                captured as-is.
              </p>
              {draft.suggestedParameters.length === 0 ? (
                <p className="mt-2 text-xs text-on-surface-faint">
                  Nothing here looks like a knob — these resources will be reproduced exactly.
                </p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {draft.suggestedParameters.map((parameter) => (
                    <li key={parameter.key}>
                      <label className="flex items-center gap-2 text-xs text-on-surface">
                        <input
                          type="checkbox"
                          checked={chosen.has(parameter.key)}
                          onChange={(e) =>
                            setChosen((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(parameter.key);
                              else next.delete(parameter.key);
                              return next;
                            })
                          }
                        />
                        {parameter.label}
                        <span className="text-on-surface-faint">
                          (currently {parameter.defaultValue})
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-on-surface-secondary">
                Template name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Staging stack"
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
                />
              </label>
              <label className="text-xs text-on-surface-secondary">
                Description (optional)
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
                />
              </label>
            </div>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary transition-colors hover:bg-surface-sunken"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !draft || draft.members.length === 0 || name.trim() === ""}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            Save template
          </button>
        </div>
      </div>
    </div>
  );
}
