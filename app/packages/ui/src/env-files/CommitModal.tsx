import { useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  GithubPermissionRequiredClientError,
  type GithubPermissionRequiredPayload,
  type InfraenvCommitMode,
  type InfraenvCommitResult,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { GithubPermissionPrompt } from "../issue-filing/github.js";
import { dialogClass, inputClass, labelClass, primaryButton, secondaryButton } from "./styles.js";
import type { EnvFilesClient } from "./types.js";

export interface LoadedRepoFile {
  installationId: number;
  repo: string;
  path: string;
  branch: string;
  /** Null for a file that does not exist on the branch yet. */
  sha: string | null;
}

export interface CommitModalProps {
  client: EnvFilesClient;
  target: LoadedRepoFile;
  content: string;
  openExternal: (url: string) => void;
  /** After a successful commit, with the result; the panel re-reads the file. */
  onCommitted: (result: InfraenvCommitResult) => void;
  /** Discard local edits and read the file again (after a "changed since read"). */
  onReload: () => void;
  onClose: () => void;
}

const DEFAULT_MESSAGE = "Update .infraenv";

/**
 * Commit the file to its branch, or to a new branch with a pull request. The
 * sha read with the file goes along, so a file someone else changed since is
 * refused rather than overwritten.
 */
export function CommitModal({
  client,
  target,
  content,
  openExternal,
  onCommitted,
  onReload,
  onClose,
}: CommitModalProps) {
  const gt = useGT();
  const [mode, setMode] = useState<InfraenvCommitMode>("pull-request");
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<GithubPermissionRequiredPayload | null>(null);
  const [result, setResult] = useState<InfraenvCommitResult | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setPermission(null);
    try {
      const res = await client.commit({
        installationId: target.installationId,
        repo: target.repo,
        path: target.path,
        branch: target.branch,
        content,
        sha: target.sha,
        mode,
        ...(message.trim() ? { message: message.trim() } : {}),
      });
      setResult(res);
      onCommitted(res);
    } catch (e) {
      if (e instanceof GithubPermissionRequiredClientError) setPermission(e.payload);
      else setError(e instanceof Error ? e.message : gt("Failed to commit the file"));
    } finally {
      setBusy(false);
    }
  }

  const heading = gt("Commit {path}", { path: target.path });
  return (
    <Modal onClose={() => !busy && onClose()} ariaLabel={heading}>
      <div className={dialogClass}>
        <h2 className="text-sm font-semibold text-on-surface break-all">{heading}</h2>
        <p className="mt-1 text-xs text-on-surface-faint break-all">
          {target.repo} · {target.branch}
        </p>

        {result ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-on-surface">
              {result.pullRequest ? (
                <T>
                  Opened pull request #<Var>{result.pullRequest.number}</Var> from{" "}
                  <code>
                    <Var>{result.branch}</Var>
                  </code>
                  .
                </T>
              ) : (
                <T>
                  Committed to{" "}
                  <code>
                    <Var>{result.branch}</Var>
                  </code>
                  .
                </T>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={secondaryButton}
                onClick={() => openExternal(result.commitUrl)}
              >
                {gt("View commit")}
              </button>
              {result.pullRequest && (
                <button
                  type="button"
                  className={primaryButton}
                  onClick={() => openExternal(result.pullRequest!.url)}
                >
                  {gt("View pull request")}
                </button>
              )}
              <button type="button" className={secondaryButton} onClick={onClose}>
                {gt("Done")}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <fieldset>
              <legend className={labelClass}>{gt("How")}</legend>
              <div className="flex flex-col gap-1.5 text-sm text-on-surface">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="env-files-commit-mode"
                    checked={mode === "pull-request"}
                    onChange={() => setMode("pull-request")}
                  />
                  {gt("Open a pull request")}
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="env-files-commit-mode"
                    checked={mode === "commit"}
                    onChange={() => setMode("commit")}
                  />
                  {gt("Commit to {branch}", { branch: target.branch })}
                </label>
              </div>
            </fieldset>
            <div>
              <label className={labelClass} htmlFor="env-files-commit-message">
                {gt("Message")}
              </label>
              <input
                id="env-files-commit-message"
                type="text"
                maxLength={500}
                className={inputClass}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>

            {permission && (
              <GithubPermissionPrompt
                accountLogin={permission.accountLogin}
                permissions={permission.permissions}
                manageUrl={permission.manageUrl}
                openExternal={openExternal}
              />
            )}
            {error && (
              <div role="alert" className="text-sm text-danger">
                <p>{error}</p>
                <button
                  type="button"
                  onClick={onReload}
                  className="mt-1 text-xs underline hover:text-danger"
                >
                  {gt("Reload the file from GitHub")}
                </button>
              </div>
            )}

            <div className="mt-1 flex justify-end gap-2">
              <button type="button" className={secondaryButton} onClick={onClose} disabled={busy}>
                {gt("Cancel")}
              </button>
              <button
                type="button"
                className={primaryButton}
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy
                  ? gt("Committing…")
                  : mode === "pull-request"
                    ? gt("Open pull request")
                    : gt("Commit")}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
