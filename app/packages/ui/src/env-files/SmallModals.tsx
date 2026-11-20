import { useState } from "react";
import { useGT } from "gt-react";
import type { InfraenvDocument } from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { environmentNameProblem } from "./document.js";
import { dialogClass, inputClass, labelClass, primaryButton, secondaryButton } from "./styles.js";

export interface EnvironmentNameModalProps {
  doc: InfraenvDocument;
  /** The environment being renamed; absent when adding one. */
  renaming?: string | undefined;
  onSave: (name: string) => void;
  onClose: () => void;
}

/** Name a new environment, or rename one. */
export function EnvironmentNameModal({
  doc,
  renaming,
  onSave,
  onClose,
}: EnvironmentNameModalProps) {
  const gt = useGT();
  const [name, setName] = useState(renaming ?? "");
  const problem = name === "" ? null : environmentNameProblem(doc, name, renaming);
  const message =
    problem === "invalid"
      ? gt("Use letters, digits, - and _, starting with a letter or digit")
      : problem === "taken"
        ? gt("There is already an environment with this name")
        : problem === "too-many"
          ? gt("A file holds at most 50 environments")
          : null;
  const heading = renaming ? gt("Rename environment") : gt("Add environment");
  return (
    <Modal onClose={onClose} ariaLabel={heading}>
      <form
        className={dialogClass}
        onSubmit={(e) => {
          e.preventDefault();
          if (name !== "" && problem === null) onSave(name);
        }}
      >
        <h2 className="text-sm font-semibold text-on-surface">{heading}</h2>
        <div className="mt-4 flex flex-col gap-3">
          <div>
            <label className={labelClass} htmlFor="env-files-environment-name">
              {gt("Name")}
            </label>
            <input
              id="env-files-environment-name"
              type="text"
              autoFocus
              maxLength={64}
              className={`${inputClass} font-mono`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="production"
            />
            {message && <p className="mt-1 text-xs text-danger">{message}</p>}
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={onClose}>
              {gt("Cancel")}
            </button>
            <button
              type="submit"
              className={primaryButton}
              disabled={name === "" || problem !== null}
            >
              {renaming ? gt("Rename") : gt("Add")}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export interface ImportModalProps {
  onImport: (text: string) => void;
  onClose: () => void;
}

/** Paste `.infraenv` (or plain dotenv) text to start from. */
export function ImportModal({ onImport, onClose }: ImportModalProps) {
  const gt = useGT();
  const [text, setText] = useState("");
  const heading = gt("Import");
  return (
    <Modal onClose={onClose} ariaLabel={heading}>
      <div className={dialogClass}>
        <h2 className="text-sm font-semibold text-on-surface">{heading}</h2>
        <div className="mt-4 flex flex-col gap-3">
          <textarea
            autoFocus
            rows={14}
            spellCheck={false}
            className={`${inputClass} font-mono text-xs`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={gt("File contents")}
            placeholder={
              '[env]\nNODE_ENV = development\nDATABASE_URL = resource("…", "connectionString")'
            }
          />
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={onClose}>
              {gt("Cancel")}
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={text.trim() === ""}
              onClick={() => onImport(text)}
            >
              {gt("Import")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
