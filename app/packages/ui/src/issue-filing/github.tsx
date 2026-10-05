import { useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";
import type {
  GithubAssignee,
  GithubInstallationAccess,
  GithubLabel,
  GithubPermissionRequiredPayload,
  GithubRepoRef,
} from "@infrawrench/client-core";

import { MultiSelect, type MultiSelectStatus } from "../components/MultiSelect.js";

/**
 * GitHub pickers shared by the file-issue modal, the pull-request modal and
 * the GitHub issues settings section. Every identifier a user would otherwise
 * type (a repository, a label, a login) comes from the installation, never a
 * text box: a typo in any of them comes back from GitHub as a 422 that reads
 * like our bug.
 */

/** The one verb these pickers need; both the settings and filing transports have it. */
export interface GithubPickerApi {
  get<T>(path: string): Promise<T>;
}

export interface GithubRepoOption extends GithubRepoRef {
  defaultBranch: string;
  private: boolean;
}

export function repoKey(repo: GithubRepoRef | null | undefined): string {
  return repo ? `${repo.installationId}:${repo.fullName}` : "";
}

/** Repositories across the org's installations; null while loading. */
export function useGithubRepos(
  api: GithubPickerApi | null | undefined,
  orgId: string,
  enabled = true,
): GithubRepoOption[] | null {
  const [repos, setRepos] = useState<GithubRepoOption[] | null>(null);
  useEffect(() => {
    if (!api || !enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<{ repos: GithubRepoOption[] }>(`/api/org/${orgId}/github/repos`);
        if (!cancelled) setRepos(res.repos);
      } catch {
        if (!cancelled) setRepos([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId, enabled]);
  return repos;
}

const selectClass =
  "w-full px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60";

export function GithubRepoPicker({
  repos,
  value,
  onChange,
  disabled,
  allowNone,
  ariaLabel,
}: {
  repos: GithubRepoOption[] | null;
  value: GithubRepoRef | null;
  onChange: (repo: GithubRepoRef | null) => void;
  disabled?: boolean;
  allowNone?: boolean;
  ariaLabel?: string;
}) {
  const gt = useGT();
  const current = repoKey(value);
  const known = (repos ?? []).some((r) => repoKey(r) === current);
  return (
    <select
      value={current}
      aria-label={ariaLabel ?? gt("Repository")}
      disabled={disabled || repos === null}
      onChange={(e) => {
        const hit = (repos ?? []).find((r) => repoKey(r) === e.target.value);
        onChange(hit ? { installationId: hit.installationId, fullName: hit.fullName } : null);
      }}
      className={selectClass}
    >
      <option value="">
        {repos === null
          ? gt("Loading…")
          : allowNone
            ? gt("None")
            : repos.length === 0
              ? gt("No repositories: connect GitHub first")
              : gt("Select a repository")}
      </option>
      {/* A saved repo the installation no longer lists stays visible rather than vanishing. */}
      {value && !known && <option value={current}>{value.fullName}</option>}
      {(repos ?? []).map((r) => (
        <option key={repoKey(r)} value={repoKey(r)}>
          {r.fullName}
        </option>
      ))}
    </select>
  );
}

function usePickerList<T>(
  api: GithubPickerApi,
  orgId: string,
  repo: GithubRepoRef | null,
  what: "labels" | "assignees",
): { items: T[] | null; error: string | null; reload: () => void } {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!repo) {
      setItems([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setItems(null);
    setError(null);
    void (async () => {
      try {
        const rows = await api.get<T[]>(
          `/api/org/${orgId}/github-issues/${what}?installationId=${repo.installationId}&repo=${encodeURIComponent(repo.fullName)}`,
        );
        if (!cancelled) setItems(rows);
      } catch (e) {
        if (!cancelled) {
          setItems([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId, repo?.installationId, repo?.fullName, what, nonce]);
  return { items, error, reload: () => setNonce((n) => n + 1) };
}

function pickerStatus(
  items: unknown[] | null,
  error: string | null,
  reload: () => void,
  empty: string,
): MultiSelectStatus | undefined {
  if (items === null) return { kind: "loading" };
  if (error) return { kind: "error", message: error, onRetry: reload };
  if (items.length === 0) return { kind: "empty", message: empty };
  return undefined;
}

export function GithubLabelsPicker({
  api,
  orgId,
  repo,
  value,
  onChange,
}: {
  api: GithubPickerApi;
  orgId: string;
  repo: GithubRepoRef | null;
  value: string[];
  onChange: (labels: string[]) => void;
}) {
  const gt = useGT();
  const { items, error, reload } = usePickerList<GithubLabel>(api, orgId, repo, "labels");
  const options = (items ?? []).map((l) => ({ value: l.name, label: l.name }));
  // Keep selections the repository does not have (an org-wide default label)
  // visible: GitHub creates a missing label on the issue rather than failing.
  for (const v of value)
    if (!options.some((o) => o.value === v)) options.push({ value: v, label: v });
  return (
    <MultiSelect
      label={gt("Labels")}
      placeholder={gt("No labels")}
      options={options}
      value={value}
      onChange={onChange}
      status={
        options.length > 0
          ? undefined
          : pickerStatus(items, error, reload, gt("This repository has no labels"))
      }
    />
  );
}

export function GithubAssigneesPicker({
  api,
  orgId,
  repo,
  value,
  onChange,
}: {
  api: GithubPickerApi;
  orgId: string;
  repo: GithubRepoRef | null;
  value: string[];
  onChange: (logins: string[]) => void;
}) {
  const gt = useGT();
  const { items, error, reload } = usePickerList<GithubAssignee>(api, orgId, repo, "assignees");
  const options = (items ?? []).map((a) => ({ value: a.login, label: a.login }));
  for (const v of value)
    if (!options.some((o) => o.value === v)) options.push({ value: v, label: v });
  return (
    <MultiSelect
      label={gt("Assignees")}
      placeholder={gt("Unassigned")}
      options={options}
      value={value}
      onChange={onChange}
      status={
        options.length > 0
          ? undefined
          : pickerStatus(items, error, reload, gt("Nobody can be assigned in this repository"))
      }
    />
  );
}

/** Whether an installation can do what a feature needs. */
export function missingGithubPermissions(
  access: GithubInstallationAccess | undefined,
  need: "issues" | "pull-requests",
): string[] {
  if (!access || !access.checked) return [];
  const writable = (level: string) => level === "write" || level === "admin";
  const missing: string[] = [];
  if (!writable(access.issues)) missing.push("issues");
  if (need === "pull-requests") {
    if (!writable(access.contents)) missing.push("contents");
    if (!writable(access.pullRequests)) missing.push("pull_requests");
  }
  return missing;
}

/**
 * The "grant the permission" prompt. Shown instead of an error string when an
 * installation predates issue filing: GitHub applies a GitHub App's new
 * permissions only after an owner of the account approves them, and until then
 * every write answers 403.
 */
export function GithubPermissionPrompt({
  accountLogin,
  permissions,
  manageUrl,
  openExternal,
}: {
  accountLogin: string | null;
  permissions: string[];
  manageUrl: string | null;
  openExternal: (url: string) => void;
}) {
  const gt = useGT();
  const account = accountLogin ?? gt("this GitHub account");
  const list = permissions.join(", ");
  return (
    <div role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
      <T>
        <p className="text-on-surface">
          The Infrawrench GitHub App on{" "}
          <strong>
            <Var>{account}</Var>
          </strong>{" "}
          has not been granted{" "}
          <code>
            <Var>{list}</Var>
          </code>{" "}
          write access yet. An owner of that GitHub account needs to accept the app&apos;s updated
          permissions.
        </p>
      </T>
      {manageUrl && (
        <button
          type="button"
          onClick={() => openExternal(manageUrl)}
          className="mt-2 rounded-lg border border-border bg-surface-raised px-3 py-1 text-xs font-medium text-on-surface hover:border-border-strong"
        >
          {gt("Review permissions on GitHub")}
        </button>
      )}
    </div>
  );
}

/** A permission payload from either the API error or the status read. */
export function permissionPayloadFor(
  access: GithubInstallationAccess | undefined,
  missing: string[],
): Pick<GithubPermissionRequiredPayload, "accountLogin" | "permissions" | "manageUrl"> | null {
  if (!access || missing.length === 0) return null;
  return { accountLogin: access.accountLogin, permissions: missing, manageUrl: access.manageUrl };
}
