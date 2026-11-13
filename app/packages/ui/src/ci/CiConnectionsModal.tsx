import { useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import type {
  CiConnectionAccess,
  CiConnectionAccessSettings,
  CiExecutorKindId,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { ArrowIcon, ChevronIcon, CloseIcon, SearchIcon } from "../components/icons/ChromeIcons.js";
import { useDataString } from "../i18n/data-strings.js";
import { INPUT, LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../settings/styles.js";
import { PluginLogo, ScopeFields, Switch, errorText } from "./ci-access-parts.js";
import type { CiClient } from "./types.js";

type Settings = CiConnectionAccessSettings;

const same = (a: Settings, b: Settings) => JSON.stringify(a) === JSON.stringify(b);
const isOn = (s: Settings) => s.jobsEnabled || s.lendEnabled;

/** A kind's last permission check, and the button that runs it again. */
function KindCheck({
  connection,
  kind,
  label,
  checking,
  onCheck,
}: {
  connection: CiConnectionAccess;
  kind: CiExecutorKindId;
  label: string;
  checking: boolean;
  onCheck: () => void;
}) {
  const gt = useGT();
  const record = connection.preflight[kind];
  return (
    <div className="flex flex-shrink-0 items-center gap-2 pl-6 text-xs sm:pl-0">
      {record ? (
        <span
          role="status"
          className={`whitespace-nowrap ${record.ok ? "text-success" : "text-danger"}`}
        >
          {record.ok ? gt("Ready") : gt("Not ready")}
          {record.region ? (
            <span className="ml-1 font-mono text-on-surface-faint">{record.region}</span>
          ) : null}
        </span>
      ) : null}
      <button
        type="button"
        disabled={checking}
        onClick={onCheck}
        aria-label={checking ? undefined : gt("Check permissions for {kind}", { kind: label })}
        className="whitespace-nowrap rounded-md border border-border px-2 py-0.5 text-[11px] text-on-surface-secondary transition-colors hover:bg-surface-overlay disabled:opacity-50"
      >
        {checking ? gt("Checking…") : gt("Check permissions")}
      </button>
    </div>
  );
}

/** What a failed check found: the permissions the credential lacks, and where to grant them. */
function KindProblems({ connection, kind }: { connection: CiConnectionAccess; kind: string }) {
  const gt = useGT();
  const data = useDataString();
  const record = connection.preflight[kind];
  if (!record || record.ok) return null;
  const helpLink = connection.executor?.helpLink ?? null;
  return (
    <div className="mt-2 ml-6 space-y-1.5 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-on-surface-muted">
      {record.missing.length > 0 ? (
        <>
          <p>{gt("The connection's credential lacks:")}</p>
          <ul className="space-y-0.5">
            {record.missing.map((m) => (
              <li key={m.permission}>
                <span className="font-mono text-on-surface">{m.permission}</span> {m.label}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {record.problems.map((p) => (
        <p key={p}>{p}</p>
      ))}
      {helpLink ? (
        <a
          href={helpLink.url}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-accent underline-offset-2 hover:underline"
        >
          {data(helpLink.label)}
        </a>
      ) : null}
    </div>
  );
}

/** One capability of a connection: a title with its switch, and its settings while it is on. */
function Capability({
  title,
  description,
  on,
  onToggle,
  children,
}: {
  title: string;
  description?: string | undefined;
  on: boolean;
  onToggle: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface-raised">
      <div className="flex items-start justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-on-surface">{title}</h4>
          {description ? (
            <p className="mt-0.5 text-xs text-on-surface-muted">{description}</p>
          ) : null}
        </div>
        <div className="pt-0.5">
          <Switch checked={on} onChange={onToggle} label={title} />
        </div>
      </div>
      {on ? <div className="space-y-5 border-t border-border px-4 py-4">{children}</div> : null}
    </section>
  );
}

function ConnectionDetail({
  connection,
  draft,
  logo,
  allRepos,
  canWrite,
  client,
  onDraft,
  onSaved,
  onBack,
}: {
  connection: CiConnectionAccess;
  draft: Settings;
  logo: string | undefined;
  allRepos: string[];
  canWrite: boolean;
  client: CiClient;
  onDraft: (next: Settings) => void;
  onSaved: (c: CiConnectionAccess) => void;
  onBack: () => void;
}) {
  const gt = useGT();
  const data = useDataString();
  const id = useId();
  const [checking, setChecking] = useState<CiExecutorKindId | null>(null);
  // A check that could not run, shown under its kind, where the reader looks.
  const [checkErrors, setCheckErrors] = useState<Partial<Record<CiExecutorKindId, string>>>({});
  const set = (patch: Partial<Settings>) => onDraft({ ...draft, ...patch });

  const check = async (kind: CiExecutorKindId) => {
    setChecking(kind);
    setCheckErrors(({ [kind]: _, ...rest }) => rest);
    try {
      onSaved(await client.preflightConnection(connection.accountId, kind));
    } catch (e) {
      setCheckErrors((m) => ({ ...m, [kind]: errorText(e, gt("Could not check the connection")) }));
    } finally {
      setChecking(null);
    }
  };

  const kinds = connection.executor?.kinds ?? [];
  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={gt("All connections")}
          className="-ml-1 rounded-md p-1 text-on-surface-muted hover:bg-surface-overlay hover:text-on-surface md:hidden"
        >
          <ArrowIcon direction="left" size={16} />
        </button>
        <PluginLogo svg={logo} />
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-on-surface">
            {connection.accountName}
          </h3>
          <p className="truncate text-xs text-on-surface-faint">{connection.pluginName}</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {!canWrite ? (
          <p className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-on-surface-muted">
            {gt("Read only. Changing what CI may use takes {permission}.", {
              permission: "ci-access:write",
            })}
          </p>
        ) : null}
        <fieldset disabled={!canWrite} className="min-w-0 space-y-4">
          {connection.executor ? (
            <Capability
              title={gt("Run jobs on it")}
              on={draft.jobsEnabled}
              onToggle={(jobsEnabled) => set({ jobsEnabled })}
            >
              <div role="group" aria-labelledby={`${id}-kinds`}>
                <span id={`${id}-kinds`} className={LABEL}>
                  {gt("Kinds")}
                </span>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {kinds.map((k) => {
                    const ready = connection.preflight[k.kind]?.ok === true;
                    return (
                      <li key={k.kind} className="px-3 py-2.5">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                          <label className="flex min-w-0 flex-1 items-start gap-2.5">
                            <input
                              type="checkbox"
                              className="mt-1"
                              disabled={!ready}
                              title={ready ? undefined : gt("Check its permissions first")}
                              checked={draft.jobKinds.includes(k.kind)}
                              onChange={(e) =>
                                set({
                                  jobKinds: e.target.checked
                                    ? [...draft.jobKinds, k.kind]
                                    : draft.jobKinds.filter((x) => x !== k.kind),
                                })
                              }
                            />
                            <span className="min-w-0">
                              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <span className="text-sm text-on-surface">{data(k.label)}</span>
                                <span className="rounded bg-surface-sunken px-1.5 py-px font-mono text-[10px] text-on-surface-muted">
                                  {k.kind}
                                </span>
                              </span>
                              {k.defaults.machine || k.regionLabel ? (
                                <span className="mt-0.5 block text-xs text-on-surface-faint">
                                  {k.defaults.machine
                                    ? gt("default {machine}", { machine: k.defaults.machine })
                                    : null}
                                  {k.defaults.machine && k.regionLabel ? " · " : null}
                                  {k.regionLabel ? (
                                    <>
                                      {data(k.regionLabel)}:{" "}
                                      <span className="font-mono">
                                        {/* i18n-ignore: pipeline key */}
                                        cloud.region
                                      </span>
                                    </>
                                  ) : null}
                                </span>
                              ) : null}
                            </span>
                          </label>
                          <KindCheck
                            connection={connection}
                            kind={k.kind}
                            label={data(k.label)}
                            checking={checking === k.kind}
                            onCheck={() => void check(k.kind)}
                          />
                        </div>
                        {checkErrors[k.kind] ? (
                          <p role="alert" className="mt-1 pl-6 text-xs text-danger">
                            {checkErrors[k.kind]}
                          </p>
                        ) : null}
                        <KindProblems connection={connection} kind={k.kind} />
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor={`${id}-concurrent`} className={LABEL}>
                    {gt("Jobs at once")}
                  </label>
                  <input
                    id={`${id}-concurrent`}
                    type="number"
                    min={1}
                    max={50}
                    value={draft.maxConcurrentJobs}
                    onChange={(e) => set({ maxConcurrentJobs: Number(e.target.value) })}
                    className={INPUT}
                  />
                </div>
                <div>
                  <label htmlFor={`${id}-minutes`} className={LABEL}>
                    {gt("Minutes per job")}
                  </label>
                  <input
                    id={`${id}-minutes`}
                    type="number"
                    min={1}
                    max={1440}
                    value={draft.maxJobMinutes}
                    onChange={(e) => set({ maxJobMinutes: Number(e.target.value) })}
                    className={INPUT}
                  />
                </div>
              </div>
              <ScopeFields
                repos={draft.jobRepos}
                allRepos={allRepos}
                branchPattern={draft.jobBranchPattern}
                onChange={(jobRepos, jobBranchPattern) => set({ jobRepos, jobBranchPattern })}
              />
            </Capability>
          ) : null}
          {connection.credential ? (
            <Capability
              title={gt("Lend its credentials to jobs")}
              description={data(connection.credential.description)}
              on={draft.lendEnabled}
              onToggle={(lendEnabled) => set({ lendEnabled })}
            >
              <ScopeFields
                repos={draft.lendRepos}
                allRepos={allRepos}
                branchPattern={draft.lendBranchPattern}
                onChange={(lendRepos, lendBranchPattern) => set({ lendRepos, lendBranchPattern })}
              />
            </Capability>
          ) : null}
        </fieldset>
      </div>
    </>
  );
}

/**
 * Every connection that can run CI jobs or lend its credentials, and the
 * chosen one's settings. Two panes side by side; on a narrow screen, the list
 * and then the connection, with a way back.
 */
export function CiConnectionsModal({
  connections,
  allRepos,
  logos,
  canWrite,
  client,
  initialAccountId,
  onSaved,
  onClose,
}: {
  connections: CiConnectionAccess[];
  allRepos: string[];
  logos: Record<string, string>;
  canWrite: boolean;
  client: CiClient;
  /** The connection to open on; the first one when null. */
  initialAccountId: string | null;
  onSaved: (c: CiConnectionAccess) => void;
  onClose: () => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    initialAccountId ?? connections[0]?.accountId ?? null,
  );
  // Which pane a narrow screen shows; both show from `md` up.
  const [pane, setPane] = useState<"list" | "detail">(initialAccountId ? "detail" : "list");
  // Unsaved changes by connection, so moving between them loses nothing.
  const [drafts, setDrafts] = useState<Record<string, Settings>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);

  const selected = connections.find((c) => c.accountId === selectedId) ?? null;
  const draftOf = (c: CiConnectionAccess) => drafts[c.accountId] ?? c.settings;
  const isDirty = (c: CiConnectionAccess) => {
    const d = drafts[c.accountId];
    return d !== undefined && !same(d, c.settings);
  };
  const anyDirty = connections.some(isDirty);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return connections;
    return connections.filter(
      (c) => c.accountName.toLowerCase().includes(q) || c.pluginName.toLowerCase().includes(q),
    );
  }, [connections, query]);

  const requestClose = () => {
    if (busy) return;
    if (anyDirty) setConfirmingClose(true);
    else onClose();
  };
  const select = (accountId: string) => {
    setSelectedId(accountId);
    setPane("detail");
    setError(null);
    setSavedId(null);
  };
  const save = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setSavedId(null);
    try {
      const saved = await client.setConnectionAccess(selected.accountId, draftOf(selected));
      onSaved(saved);
      setDrafts(({ [selected.accountId]: _, ...rest }) => rest);
      setSavedId(selected.accountId);
    } catch (e) {
      setError(errorText(e, gt("Could not save")));
    } finally {
      setBusy(false);
    }
  };

  const dirty = selected ? isDirty(selected) : false;

  return (
    <Modal onClose={requestClose} ariaLabel={gt("Manage connections")}>
      <div className="flex h-[min(680px,88vh)] w-[960px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-raised shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold text-on-surface">{gt("Manage connections")}</h2>
          <button
            type="button"
            onClick={requestClose}
            aria-label={gt("Close")}
            className="rounded-md p-1 text-on-surface-muted hover:bg-surface-overlay hover:text-on-surface"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div
            className={`${pane === "detail" ? "hidden md:flex" : "flex"} w-full min-w-0 flex-col border-border bg-surface md:w-72 md:flex-shrink-0 md:border-r`}
          >
            <div className="p-3">
              <div className="relative">
                <SearchIcon
                  size={14}
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-on-surface-faint"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={gt("Search connections")}
                  aria-label={gt("Search connections")}
                  className="w-full rounded-lg border border-border-strong bg-surface-raised py-1.5 pr-2.5 pl-8 text-sm text-on-surface placeholder:text-on-surface-faint [&::-webkit-search-cancel-button]:appearance-none"
                  autoComplete="off"
                />
              </div>
            </div>
            <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
              {shown.map((c) => {
                const on = isOn(c.settings);
                const current = c.accountId === selectedId;
                return (
                  <li key={c.accountId}>
                    <button
                      type="button"
                      onClick={() => select(c.accountId)}
                      aria-current={current ? "true" : undefined}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        current ? "bg-surface-overlay" : "hover:bg-surface-overlay/60"
                      }`}
                    >
                      <PluginLogo svg={logos[c.pluginId]} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-on-surface">
                          {c.accountName}
                        </span>
                        <span className="block truncate text-[11px] text-on-surface-faint">
                          {c.pluginName}
                        </span>
                      </span>
                      {isDirty(c) ? (
                        <span className="text-[10px] text-warning">{gt("Unsaved")}</span>
                      ) : null}
                      <span
                        className={`size-2 flex-shrink-0 rounded-full ${
                          on ? "bg-success" : "border border-border-strong"
                        }`}
                        aria-hidden="true"
                      />
                      <span className="sr-only">{on ? gt("On") : gt("Off")}</span>
                      <ChevronIcon
                        direction="right"
                        size={14}
                        className="flex-shrink-0 text-on-surface-faint md:hidden"
                      />
                    </button>
                  </li>
                );
              })}
              {shown.length === 0 ? (
                <li className="px-2.5 py-6 text-center text-xs text-on-surface-muted">
                  {gt("No connection matches.")}
                </li>
              ) : null}
            </ul>
          </div>

          <div className={`${pane === "list" ? "hidden md:flex" : "flex"} min-w-0 flex-1 flex-col`}>
            {selected ? (
              <ConnectionDetail
                key={selected.accountId}
                connection={selected}
                draft={draftOf(selected)}
                logo={logos[selected.pluginId]}
                allRepos={allRepos}
                canWrite={canWrite}
                client={client}
                onDraft={(next) => {
                  setSavedId(null);
                  setDrafts((d) => ({ ...d, [selected.accountId]: next }));
                }}
                onSaved={onSaved}
                onBack={() => setPane("list")}
              />
            ) : (
              <p className="m-auto text-xs text-on-surface-muted">{gt("Choose a connection.")}</p>
            )}
          </div>
        </div>

        {confirmingClose ? (
          <div
            role="alertdialog"
            aria-label={gt("Discard unsaved changes?")}
            className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3"
          >
            <p className="mr-auto text-sm text-on-surface">{gt("Discard unsaved changes?")}</p>
            <button
              type="button"
              onClick={() => setConfirmingClose(false)}
              className={SECONDARY_BUTTON}
            >
              {gt("Keep editing")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500"
            >
              {gt("Discard")}
            </button>
          </div>
        ) : canWrite && selected ? (
          <div
            className={`${pane === "list" ? "hidden md:flex" : "flex"} flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3`}
          >
            <p className="mr-auto min-w-0 text-xs">
              {error ? (
                <span role="alert" className="text-danger">
                  {error}
                </span>
              ) : savedId === selected.accountId ? (
                <span role="status" className="text-success">
                  {gt("Saved")}
                </span>
              ) : dirty ? (
                <span className="text-on-surface-faint">{gt("Unsaved changes")}</span>
              ) : null}
            </p>
            <button type="button" onClick={onClose} disabled={busy} className={SECONDARY_BUTTON}>
              {gt("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !dirty}
              className={PRIMARY_BUTTON}
            >
              {busy ? gt("Saving…") : gt("Save")}
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
