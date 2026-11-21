import { useState } from "react";
import { useGT } from "gt-react";
import { Modal } from "../components/Modal.js";
import { dialogClass, inputClass, labelClass, primaryButton, secondaryButton } from "./styles.js";
import type { EnvFilesClient, EnvFilesSecret } from "./types.js";

/** The organization secret store's name rule (`WorkflowSecretName` in the API contract). */
const SECRET_NAME = /^[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*$/;

export interface NewSecretModalProps {
  createSecret: NonNullable<EnvFilesClient["createSecret"]>;
  /** Prefill for the name: the variable the secret is for. */
  defaultName: string;
  /** Names already in use, refused before the request. */
  taken: readonly string[];
  onCreated: (secret: EnvFilesSecret) => void;
  onClose: () => void;
}

/** Create an organization secret with its value. The value is write-only. */
export function NewSecretModal({
  createSecret,
  defaultName,
  taken,
  onCreated,
  onClose,
}: NewSecretModalProps) {
  const gt = useGT();
  const [name, setName] = useState(defaultName);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameProblem =
    name === ""
      ? null
      : name.length > 128 || !SECRET_NAME.test(name)
        ? gt("Use letters, digits and _, not starting with a digit")
        : taken.includes(name)
          ? gt("A secret with this name already exists")
          : null;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      onCreated(await createSecret(name, value));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to create the secret"));
    } finally {
      setSaving(false);
    }
  }

  const heading = gt("New secret");
  return (
    <Modal onClose={() => !saving && onClose()} ariaLabel={heading}>
      <div className={dialogClass}>
        <h2 className="text-sm font-semibold text-on-surface">{heading}</h2>
        <div className="mt-4 flex flex-col gap-3">
          <div>
            <label className={labelClass} htmlFor="env-files-secret-name">
              {gt("Name")}
            </label>
            <input
              id="env-files-secret-name"
              type="text"
              autoFocus
              maxLength={128}
              className={`${inputClass} font-mono`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {nameProblem && <p className="mt-1 text-xs text-danger">{nameProblem}</p>}
          </div>
          <div>
            <label className={labelClass} htmlFor="env-files-secret-value">
              {gt("Value")}
            </label>
            <input
              id="env-files-secret-value"
              type="password"
              autoComplete="off"
              className={`${inputClass} font-mono`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={onClose} disabled={saving}>
              {gt("Cancel")}
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={saving || name === "" || value === "" || nameProblem !== null}
              onClick={() => void save()}
            >
              {saving ? gt("Saving…") : gt("Create secret")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
