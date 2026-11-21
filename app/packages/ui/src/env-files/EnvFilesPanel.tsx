import { useCallback, useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  emptyInfraenvDocument,
  GithubPermissionRequiredClientError,
  INFRAENV_FILE_NAME,
  INFRAENV_LIMITS,
  parseInfraenv,
  serializeInfraenv,
  type GithubPermissionRequiredPayload,
  type InfraenvDescribeResponse,
  type InfraenvDocument,
  type InfraenvProblem,
} from "@infrawrench/client-core";
import { downloadBlob } from "../delivery/download.js";
import { GithubPermissionPrompt } from "../issue-filing/github.js";
import { CommitModal, type LoadedRepoFile } from "./CommitModal.js";
import { DownloadEnvModal } from "./DownloadEnvModal.js";
import {
  addEnvironment,
  documentProblemCount,
  fileNameOf,
  removeEnvironment,
  renameEnvironment,
  type EnvScope,
} from "./document.js";
import { EnvironmentNameModal, ImportModal } from "./SmallModals.js";
import { SubstitutionsEditor } from "./SubstitutionsEditor.js";
import { inputClass, labelClass, primaryButton, quietButton, secondaryButton } from "./styles.js";
import type { EnvFilesClient, EnvFilesRepoList, EnvFilesSecret } from "./types.js";
import { VariablesTable } from "./VariablesTable.js";

export interface EnvFilesPanelProps {
  client: EnvFilesClient;
  /** Keys the remembered repository and path. */
  orgId: string;
  openExternal: (url: string) => void;
  /** Open the GitHub settings, for the "connect GitHub" empty state. */
  onOpenGithubSettings?: (() => void) | undefined;
}

interface SourceForm {
  /** `installationId:owner/name`, or "" for none picked. */
  repoKey: string;
  /** "" for the repository's default branch. */
  branch: string;
  path: string;
}

const EMPTY_FORM: SourceForm = { repoKey: "", branch: "", path: INFRAENV_FILE_NAME };

function repoKeyOf(installationId: number, fullName: string): string {
  return `${installationId}:${fullName}`;
}

function storageKey(orgId: string): string {
  return `infrawrench-env-files:${orgId}`;
}

function rememberedForm(orgId: string): SourceForm {
  try {
    const raw = localStorage.getItem(storageKey(orgId));
    if (!raw) return EMPTY_FORM;
    const parsed = JSON.parse(raw) as Partial<SourceForm>;
    return {
      repoKey: typeof parsed.repoKey === "string" ? parsed.repoKey : "",
      branch: typeof parsed.branch === "string" ? parsed.branch : "",
      path:
        typeof parsed.path === "string" && parsed.path !== "" ? parsed.path : INFRAENV_FILE_NAME,
    };
  } catch {
    return EMPTY_FORM;
  }
}

function remember(orgId: string, form: SourceForm): void {
  try {
    localStorage.setItem(storageKey(orgId), JSON.stringify(form));
  } catch {
    // Storage is a convenience; a private window simply forgets.
  }
}

type View = "variables" | "file";

/**
 * Environment files: open a repository's `.infraenv`, edit which variables
 * each environment gets and where each value comes from, download the
 * resolved `.env`, and commit the file back. Shared between web and desktop;
 * the host supplies the transport.
 */
export function EnvFilesPanel({
  client,
  orgId,
  openExternal,
  onOpenGithubSettings,
}: EnvFilesPanelProps) {
  const gt = useGT();
  // A string, so the loading effect depends on its value rather than on `gt`.
  const reposFailed = gt("Failed to load repositories");

  // Repositories and the source form.
  const [repos, setRepos] = useState<EnvFilesRepoList | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [reposPermission, setReposPermission] = useState<GithubPermissionRequiredPayload | null>(
    null,
  );
  const [form, setForm] = useState<SourceForm>(() => rememberedForm(orgId));
  const [branches, setBranches] = useState<readonly string[] | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openPermission, setOpenPermission] = useState<GithubPermissionRequiredPayload | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  // The document.
  const [loaded, setLoaded] = useState<LoadedRepoFile | null>(null);
  const [doc, setDoc] = useState<InfraenvDocument>(() => emptyInfraenvDocument());
  const [baseline, setBaseline] = useState(() => serializeInfraenv(emptyInfraenvDocument()));
  const [view, setView] = useState<View>("variables");
  const [draft, setDraft] = useState("");
  const [scope, setScope] = useState<EnvScope>(null);

  // What the server says about it.
  const [described, setDescribed] = useState<InfraenvDescribeResponse | null>(null);
  const [secrets, setSecrets] = useState<readonly EnvFilesSecret[] | null>(null);

  // Dialogs.
  const [dialog, setDialog] = useState<
    | { kind: "commit" }
    | { kind: "download" }
    | { kind: "import" }
    | { kind: "add-environment" }
    | { kind: "rename-environment"; name: string }
    | null
  >(null);
  const [copied, setCopied] = useState(false);

  const draftParse = useMemo(() => (view === "file" ? parseInfraenv(draft) : null), [view, draft]);
  const text = view === "file" ? draft : serializeInfraenv(doc);
  const dirty = serializeInfraenv(doc) !== baseline || (draftParse?.problems.length ?? 0) > 0;
  const editorProblems = documentProblemCount(doc);
  const textProblems = draftParse?.problems ?? [];
  const blocked = editorProblems > 0 || textProblems.length > 0;
  const environments = doc.environments.map((e) => e.name);

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  const loadRepos = useCallback(() => {
    setReposError(null);
    setReposPermission(null);
    client
      .listRepos()
      .then(setRepos)
      .catch((e) => {
        setRepos({ appConfigured: true, repos: [] });
        if (e instanceof GithubPermissionRequiredClientError) setReposPermission(e.payload);
        else setReposError(e instanceof Error ? e.message : reposFailed);
      });
  }, [client, reposFailed]);

  const loadSecrets = useCallback(() => {
    client
      .listSecrets()
      .then(setSecrets)
      .catch(() => setSecrets(null));
  }, [client]);

  useEffect(() => {
    loadRepos();
    loadSecrets();
  }, [loadRepos, loadSecrets]);

  const selectedRepo = useMemo(
    () =>
      repos?.repos.find((r) => repoKeyOf(r.installationId, r.fullName) === form.repoKey) ?? null,
    [repos, form.repoKey],
  );

  useEffect(() => {
    setBranches(null);
    if (!selectedRepo || !client.listBranches) return;
    let cancelled = false;
    client
      .listBranches(selectedRepo.installationId, selectedRepo.fullName)
      .then((names) => !cancelled && setBranches(names))
      .catch(() => !cancelled && setBranches(null));
    return () => {
      cancelled = true;
    };
  }, [client, selectedRepo]);

  // Describe the file as it changes, debounced.
  useEffect(() => {
    if (text.length > INFRAENV_LIMITS.maxSourceLength) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      client
        .describe(text)
        .then((res) => !cancelled && setDescribed(res))
        .catch(() => {
          // A failed describe leaves the last answer up: it only decorates rows.
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, text]);

  const confirmDiscard = () =>
    !dirty || window.confirm(gt("Discard the changes you have not committed?"));

  /** Show a text: as variables when it parses cleanly, else in the text view with its problems. */
  const adopt = (source: string) => {
    const parsed = parseInfraenv(source);
    setDoc(parsed.document);
    setScope(null);
    if (parsed.problems.length > 0) {
      setDraft(source);
      setView("file");
    } else {
      setView("variables");
    }
    return parsed;
  };

  async function open(target?: LoadedRepoFile) {
    const repo = target
      ? { installationId: target.installationId, fullName: target.repo }
      : selectedRepo;
    const path = target?.path ?? form.path.trim();
    const branch = target?.branch ?? form.branch.trim();
    if (!repo || path === "") return;
    setOpening(true);
    setOpenError(null);
    setOpenPermission(null);
    setNotice(null);
    try {
      const file = await client.readFile({
        installationId: repo.installationId,
        repo: repo.fullName,
        path,
        ...(branch ? { branch } : {}),
      });
      setLoaded({
        installationId: repo.installationId,
        repo: repo.fullName,
        path: file.path,
        branch: file.branch,
        sha: file.sha,
      });
      if (file.content === null) {
        const fresh = emptyInfraenvDocument();
        setDoc(fresh);
        setBaseline(serializeInfraenv(fresh));
        setScope(null);
        setView("variables");
        setNotice(
          gt("{path} does not exist on {branch} yet.", { path: file.path, branch: file.branch }),
        );
      } else {
        const parsed = adopt(file.content);
        setBaseline(serializeInfraenv(parsed.document));
      }
      if (!target) remember(orgId, form);
    } catch (e) {
      if (e instanceof GithubPermissionRequiredClientError) setOpenPermission(e.payload);
      else setOpenError(e instanceof Error ? e.message : gt("Failed to open the file"));
    } finally {
      setOpening(false);
    }
  }

  function startNew() {
    if (!confirmDiscard()) return;
    const fresh = emptyInfraenvDocument();
    setLoaded(null);
    setDoc(fresh);
    setBaseline(serializeInfraenv(fresh));
    setScope(null);
    setView("variables");
    setNotice(null);
  }

  /** After a commit, read the file again so the next commit names the new sha. */
  async function refreshSha(target: LoadedRepoFile) {
    try {
      const file = await client.readFile({
        installationId: target.installationId,
        repo: target.repo,
        path: target.path,
        branch: target.branch,
      });
      setLoaded({ ...target, sha: file.sha });
      if (file.content !== null) {
        setBaseline(serializeInfraenv(parseInfraenv(file.content).document));
      }
    } catch {
      // The commit landed; a failed re-read only means the next commit is refused and reloads.
    }
  }

  // ---------------------------------------------------------------------------
  // Text view
  // ---------------------------------------------------------------------------

  function showView(next: View) {
    if (next === view) return;
    if (next === "file") {
      setDraft(serializeInfraenv(doc));
      setView("file");
      return;
    }
    if (
      textProblems.length > 0 &&
      !window.confirm(
        gt("The text has problems. Switch anyway and drop the lines that do not parse?"),
      )
    ) {
      return;
    }
    setView("variables");
  }

  function editDraft(next: string) {
    setDraft(next);
    const parsed = parseInfraenv(next);
    if (parsed.problems.length === 0) {
      setDoc(parsed.document);
      if (scope !== null && !parsed.document.environments.some((e) => e.name === scope)) {
        setScope(null);
      }
    }
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const noGithub = repos !== null && (!repos.appConfigured || repos.repos.length === 0);
  const fileName = loaded ? fileNameOf(loaded.path) : INFRAENV_FILE_NAME;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-on-surface">{gt("Environment files")}</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButton} onClick={startNew}>
            {gt("New file")}
          </button>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => confirmDiscard() && setDialog({ kind: "import" })}
          >
            {gt("Import")}
          </button>
          <button
            type="button"
            className={secondaryButton}
            disabled={blocked}
            onClick={() => setDialog({ kind: "download" })}
          >
            {gt("Download .env")}
          </button>
          {loaded && (
            <button
              type="button"
              className={primaryButton}
              disabled={blocked || !dirty}
              onClick={() => setDialog({ kind: "commit" })}
            >
              {gt("Commit")}
            </button>
          )}
        </div>
      </div>

      {/* Source */}
      <section className="rounded-xl border border-border bg-surface-raised p-4 space-y-3">
        {repos === null && (
          <p className="text-sm text-on-surface-faint">{gt("Loading repositories…")}</p>
        )}
        {reposPermission && (
          <GithubPermissionPrompt
            accountLogin={reposPermission.accountLogin}
            permissions={reposPermission.permissions}
            manageUrl={reposPermission.manageUrl}
            openExternal={openExternal}
          />
        )}
        {reposError && (
          <p role="alert" className="text-sm text-danger">
            {reposError}{" "}
            <button type="button" onClick={loadRepos} className="underline hover:text-danger">
              {gt("Retry")}
            </button>
          </p>
        )}
        {noGithub && !reposError && !reposPermission && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-on-surface-secondary">
              {repos.appConfigured
                ? gt("No GitHub repositories are connected to this organization.")
                : gt("This server has no GitHub App configured.")}
            </p>
            {repos.appConfigured && onOpenGithubSettings && (
              <button type="button" className={secondaryButton} onClick={onOpenGithubSettings}>
                {gt("Connect GitHub")}
              </button>
            )}
          </div>
        )}
        {repos !== null && repos.repos.length > 0 && (
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1.5fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmDiscard()) void open();
            }}
          >
            <div>
              <label className={labelClass} htmlFor="env-files-repo">
                {gt("Repository")}
              </label>
              <select
                id="env-files-repo"
                className={inputClass}
                value={form.repoKey}
                onChange={(e) => setForm({ ...form, repoKey: e.target.value, branch: "" })}
              >
                <option value="">{gt("Select a repository")}</option>
                {repos.repos.map((r) => (
                  <option
                    key={repoKeyOf(r.installationId, r.fullName)}
                    value={repoKeyOf(r.installationId, r.fullName)}
                  >
                    {r.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="env-files-branch">
                {gt("Branch")}
              </label>
              {branches !== null ? (
                <select
                  id="env-files-branch"
                  className={inputClass}
                  value={form.branch}
                  onChange={(e) => setForm({ ...form, branch: e.target.value })}
                >
                  <option value="">
                    {selectedRepo?.defaultBranch
                      ? gt("Default ({branch})", { branch: selectedRepo.defaultBranch })
                      : gt("Default branch")}
                  </option>
                  {form.branch !== "" && !branches.includes(form.branch) && (
                    <option value={form.branch}>{form.branch}</option>
                  )}
                  {branches
                    .filter((b) => b !== selectedRepo?.defaultBranch)
                    .map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                </select>
              ) : (
                <input
                  id="env-files-branch"
                  type="text"
                  className={inputClass}
                  value={form.branch}
                  spellCheck={false}
                  onChange={(e) => setForm({ ...form, branch: e.target.value })}
                  placeholder={selectedRepo?.defaultBranch ?? gt("Default branch")}
                />
              )}
            </div>
            <div>
              <label className={labelClass} htmlFor="env-files-path">
                {gt("Path")}
              </label>
              <input
                id="env-files-path"
                type="text"
                className={`${inputClass} font-mono`}
                value={form.path}
                maxLength={1024}
                spellCheck={false}
                onChange={(e) => setForm({ ...form, path: e.target.value })}
                placeholder=".infraenv"
              />
            </div>
            <button
              type="submit"
              className={primaryButton}
              disabled={opening || !selectedRepo || form.path.trim() === ""}
            >
              {opening ? gt("Opening…") : gt("Open")}
            </button>
          </form>
        )}
        {openPermission && (
          <GithubPermissionPrompt
            accountLogin={openPermission.accountLogin}
            permissions={openPermission.permissions}
            manageUrl={openPermission.manageUrl}
            openExternal={openExternal}
          />
        )}
        {openError && (
          <p role="alert" className="text-sm text-danger">
            {openError}
          </p>
        )}
        <p className="text-xs text-on-surface-faint break-all">
          {loaded
            ? gt("{repo} · {branch} · {path}", {
                repo: loaded.repo,
                branch: loaded.branch,
                path: loaded.path,
              })
            : gt("Not saved to a repository")}
          {dirty ? gt(" · unsaved changes") : ""}
          {notice ? ` · ${notice}` : ""}
        </p>
      </section>

      {/* View switch */}
      <div className="flex items-center gap-1 border-b border-border">
        {(
          [
            ["variables", gt("Variables")],
            ["file", gt("File")],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => showView(key)}
            aria-pressed={view === key}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              view === key
                ? "border-accent text-on-surface"
                : "border-transparent text-on-surface-secondary hover:text-on-surface"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "variables" ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <EnvironmentChip active={scope === null} onClick={() => setScope(null)}>
              {gt("Shared")}
            </EnvironmentChip>
            {environments.map((name) => (
              <EnvironmentChip key={name} active={scope === name} onClick={() => setScope(name)}>
                {name}
              </EnvironmentChip>
            ))}
            <button
              type="button"
              className={quietButton}
              onClick={() => setDialog({ kind: "add-environment" })}
            >
              {gt("Add environment")}
            </button>
            {scope !== null && (
              <>
                <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                <button
                  type="button"
                  className={quietButton}
                  onClick={() => setDialog({ kind: "rename-environment", name: scope })}
                >
                  {gt("Rename")}
                </button>
                <button
                  type="button"
                  className={`${quietButton} text-danger`}
                  onClick={() => {
                    if (!window.confirm(gt('Remove the "{name}" environment?', { name: scope }))) {
                      return;
                    }
                    setDoc(removeEnvironment(doc, scope));
                    setScope(null);
                  }}
                >
                  {gt("Remove")}
                </button>
              </>
            )}
          </div>

          <SubstitutionsEditor doc={doc} scope={scope} onChange={setDoc} />

          <VariablesTable
            client={client}
            doc={doc}
            scope={scope}
            described={described}
            secrets={secrets}
            onChange={setDoc}
            onSecretCreated={() => loadSecrets()}
          />
        </section>
      ) : (
        <section className="space-y-3">
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={secondaryButton} onClick={() => void copyText()}>
              {copied ? gt("Copied") : gt("Copy")}
            </button>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => downloadBlob(new Blob([text], { type: "text/plain" }), fileName)}
            >
              {gt("Download {name}", { name: fileName })}
            </button>
          </div>
          <textarea
            rows={Math.min(40, Math.max(12, draft.split("\n").length + 1))}
            spellCheck={false}
            className={`${inputClass} font-mono text-xs leading-5`}
            value={draft}
            onChange={(e) => editDraft(e.target.value)}
            aria-label={gt("File contents")}
          />
          <ProblemList
            problems={[
              ...textProblems,
              ...(textProblems.length ? [] : describedProblems(described)),
            ]}
          />
        </section>
      )}

      {dialog?.kind === "commit" && loaded && (
        <CommitModal
          client={client}
          target={loaded}
          content={text}
          openExternal={openExternal}
          onCommitted={() => void refreshSha(loaded)}
          onReload={() => {
            if (!window.confirm(gt("Discard your changes and read the file again?"))) return;
            setDialog(null);
            void open(loaded);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "download" && (
        <DownloadEnvModal
          client={client}
          source={text}
          sourceName={loaded?.path ?? INFRAENV_FILE_NAME}
          environments={environments}
          initialEnvironment={scope}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "import" && (
        <ImportModal
          onClose={() => setDialog(null)}
          onImport={(source) => {
            adopt(source);
            setNotice(null);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "add-environment" && (
        <EnvironmentNameModal
          doc={doc}
          onClose={() => setDialog(null)}
          onSave={(name) => {
            setDoc(addEnvironment(doc, name));
            setScope(name);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "rename-environment" && (
        <EnvironmentNameModal
          doc={doc}
          renaming={dialog.name}
          onClose={() => setDialog(null)}
          onSave={(name) => {
            setDoc(renameEnvironment(doc, dialog.name, name));
            setScope(name);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

/** Problems `/describe` found with references, for the text view. */
function describedProblems(described: InfraenvDescribeResponse | null): readonly InfraenvProblem[] {
  return described?.problems ?? [];
}

function ProblemList({ problems }: { problems: readonly InfraenvProblem[] }) {
  const gt = useGT();
  if (problems.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs">
      {problems.map((p, i) => (
        <li key={`${p.line}:${i}`} className="text-warning">
          {p.line > 0
            ? gt("Line {line}: {message}", { line: p.line, message: p.message })
            : p.message}
        </li>
      ))}
    </ul>
  );
}

function EnvironmentChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs ${
        active
          ? "border-accent bg-accent/10 text-on-surface"
          : "border-border text-on-surface-secondary hover:border-border-strong"
      }`}
    >
      {children}
    </button>
  );
}
