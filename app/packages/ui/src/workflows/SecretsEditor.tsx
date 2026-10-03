import { useId, useMemo, useState } from "react";
import { useGT } from "gt-react";

import type { WorkflowSecretSummary } from "./types.js";
import { messageOf } from "./errors.js";
import { SECRET_PATH_RE } from "./workflow-typings.js";

export function SecretsEditor({
  secrets,
  assignedIds,
  loading,
  onAssignedIdsChange,
  onUpsert,
  onDelete,
  onError,
}: {
  secrets: WorkflowSecretSummary[];
  assignedIds: string[];
  loading: boolean;
  onAssignedIdsChange: (ids: string[]) => void;
  onUpsert: (input: { id?: string; name: string; value: string }) => Promise<WorkflowSecretSummary>;
  onDelete: (id: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const gt = useGT();
  const nameId = useId();
  const valueId = useId();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotationValue, setRotationValue] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const assigned = useMemo(() => new Set(assignedIds), [assignedIds]);

  const create = async () => {
    const trimmedName = name.trim();
    if (!SECRET_PATH_RE.test(trimmedName)) {
      setValidationError(
        gt(
          "Secret names must be JavaScript identifiers, optionally separated by dots (for example API_TOKEN or stripe.apiKey).",
        ),
      );
      return;
    }
    if (!value) {
      setValidationError(gt("Enter an initial secret value."));
      return;
    }
    setValidationError(null);
    setBusyId("new");
    try {
      const saved = await onUpsert({ name: trimmedName, value });
      onAssignedIdsChange([...new Set([...assignedIds, saved.id])]);
      setName("");
      setValue("");
    } catch (e) {
      onError(messageOf(e));
    } finally {
      setBusyId(null);
    }
  };

  const rotate = async (secret: WorkflowSecretSummary) => {
    if (!rotationValue) {
      setValidationError(gt("Enter a replacement value."));
      return;
    }
    setValidationError(null);
    setBusyId(secret.id);
    try {
      await onUpsert({ id: secret.id, name: secret.name, value: rotationValue });
      setRotationValue("");
      setRotatingId(null);
    } catch (e) {
      onError(messageOf(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="px-3 py-2 border-b border-white/10 text-xs">
      <div className="mb-2">
        <span className="opacity-60">{gt("Secrets")}</span>
        <span className="ml-2 opacity-50">
          {gt("Assigned values are available as readonly infra.secrets properties.")}
        </span>
      </div>

      <div className="flex items-end gap-2 flex-wrap">
        <label className="flex flex-col gap-1" htmlFor={nameId}>
          <span className="opacity-60">{gt("Name")}</span>
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="DATABASE_TOKEN"
            autoComplete="off"
            spellCheck={false}
            className="bg-transparent border border-white/15 rounded px-2 py-1 w-40 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1" htmlFor={valueId}>
          <span className="opacity-60">{gt("Initial value")}</span>
          <input
            id={valueId}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            className="bg-surface-overlay border border-white/15 rounded px-2 py-1 w-52 font-mono"
          />
        </label>
        <button
          type="button"
          onClick={() => void create()}
          disabled={busyId !== null}
          className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50"
        >
          {gt("Add and assign")}
        </button>
      </div>

      {validationError && (
        <div role="alert" className="mt-1 text-danger">
          {validationError}
        </div>
      )}

      <div className="mt-2 space-y-1">
        {loading ? (
          <div className="opacity-50">{gt("Loading secrets…")}</div>
        ) : secrets.length === 0 ? (
          <div className="opacity-50">{gt("No reusable secrets yet.")}</div>
        ) : (
          secrets.map((secret) => {
            const rotationId = `workflow-secret-rotation-${secret.id}`;
            return (
              <div key={secret.id} className="flex items-center gap-2 flex-wrap">
                <label className="flex items-center gap-1.5 min-w-44">
                  <input
                    type="checkbox"
                    checked={assigned.has(secret.id)}
                    onChange={(e) =>
                      onAssignedIdsChange(
                        e.target.checked
                          ? [...new Set([...assignedIds, secret.id])]
                          : assignedIds.filter((id) => id !== secret.id),
                      )
                    }
                  />
                  <code>{secret.name}</code>
                </label>
                <span className={secret.hasValue ? "text-success/80" : "text-warning"}>
                  {secret.hasValue ? gt("Value set") : gt("No value")}
                </span>
                {rotatingId === secret.id ? (
                  <>
                    <label htmlFor={rotationId} className="sr-only">
                      {gt("Replacement value for {name}", { name: secret.name })}
                    </label>
                    <input
                      id={rotationId}
                      type="password"
                      value={rotationValue}
                      onChange={(e) => setRotationValue(e.target.value)}
                      placeholder={gt("Replacement value")}
                      autoComplete="new-password"
                      spellCheck={false}
                      className="bg-surface-overlay border border-white/15 rounded px-2 py-1 w-44 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => void rotate(secret)}
                      disabled={busyId !== null}
                      className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50"
                    >
                      {gt("Save value")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRotatingId(null);
                        setRotationValue("");
                      }}
                      className="px-2 py-0.5 opacity-60 hover:opacity-100"
                    >
                      {gt("Cancel")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setRotatingId(secret.id);
                      setRotationValue("");
                    }}
                    className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20"
                  >
                    {secret.hasValue ? gt("Rotate value") : gt("Set value")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (
                      !window.confirm(
                        gt(
                          'Delete workflow secret "{name}"? It will be unassigned from workflows.',
                          {
                            name: secret.name,
                          },
                        ),
                      )
                    )
                      return;
                    setBusyId(secret.id);
                    void onDelete(secret.id)
                      .catch((e) => onError(messageOf(e)))
                      .finally(() => setBusyId(null));
                  }}
                  disabled={busyId !== null}
                  aria-label={gt("Delete workflow secret {name}", { name: secret.name })}
                  className="px-2 py-0.5 text-danger opacity-80 hover:opacity-100 disabled:opacity-50"
                >
                  {gt("Delete")}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
