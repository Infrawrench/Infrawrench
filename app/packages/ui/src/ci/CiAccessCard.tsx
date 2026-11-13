import { useEffect, useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  CI_GRANT_NAME,
  ciBranchGlobs,
  ciGrantNameFor,
  type CiAccessOverview,
  type CiConnectionAccess,
  type CiConnectionAccessSettings,
  type CiExecutorKindId,
  type CiResourceGrant,
  type CiResourceOutputs,
  type SearchResult,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";
import type { CiClient, CiGrantInput } from "./types.js";

const inputClass =
  "rounded border border-border bg-surface px-2 py-1 text-xs text-on-surface placeholder:text-on-surface-faint";
const labelClass = "flex flex-col gap-1 text-[11px] text-on-surface-faint";

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/**
 * Which repositories and branches a permission holds for: every repository,
 * or the ones ticked, and an optional branch pattern.
 */
function Scope({
  repos,
  allRepos,
  branchPattern,
  onChange,
}: {
  repos: string[] | null;
  allRepos: string[];
  branchPattern: string | null;
  onChange: (repos: string[] | null, branchPattern: string | null) => void;
}) {
  const gt = useGT();
  const id = useId();
  const known = useMemo(
    () => [...new Set([...allRepos, ...(repos ?? [])])].sort((a, b) => a.localeCompare(b)),
    [allRepos, repos],
  );
  return (
    <div className="space-y-1.5">
      <div role="group" aria-labelledby={`${id}-repos`} className="space-y-1">
        <span id={`${id}-repos`} className="text-[11px] text-on-surface-faint">
          {gt("Repositories")}
        </span>
        <label className="flex items-center gap-1.5 text-xs text-on-surface">
          <input
            type="checkbox"
            checked={repos === null}
            onChange={(e) => onChange(e.target.checked ? null : [], branchPattern)}
          />
          {gt("Every repository CI runs for")}
        </label>
        {repos !== null ? (
          <div className="flex max-h-32 flex-wrap gap-x-3 gap-y-1 overflow-y-auto">
            {known.map((r) => (
              <label
                key={r}
                className="flex items-center gap-1.5 font-mono text-xs text-on-surface"
              >
                <input
                  type="checkbox"
                  checked={repos.includes(r)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked ? [...repos, r] : repos.filter((x) => x !== r),
                      branchPattern,
                    )
                  }
                />
                {r}
              </label>
            ))}
            {known.length === 0 ? (
              <span className="text-xs text-on-surface-muted">
                {gt("No repositories run CI yet.")}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <label className={labelClass}>
        {gt("Branches")}
        <input
          value={branchPattern ?? ""}
          onChange={(e) => onChange(repos, e.target.value.trim() === "" ? null : e.target.value)}
          // i18n-ignore: branch glob syntax
          placeholder="main, release/*"
          className={`${inputClass} font-mono`}
          autoComplete="off"
        />
      </label>
      <p className="text-[11px] text-on-surface-faint">
        {branchPattern === null
          ? gt("Every branch")
          : ciBranchGlobs(branchPattern).length === 0
            ? gt("No branch: name at least one, or clear the field for every branch")
            : gt("Only branches matching this pattern")}
      </p>
    </div>
  );
}

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
  const data = useDataString();
  const record = connection.preflight[kind];
  const helpLink = connection.executor?.helpLink ?? null;
  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={checking}
          onClick={onCheck}
          className="rounded border border-border px-2 py-0.5 text-on-surface hover:bg-surface-sunken disabled:opacity-50"
        >
          {checking ? gt("Checking…") : gt("Check permissions for {kind}", { kind: label })}
        </button>
        {record ? (
          <span role="status" className={record.ok ? "text-success" : "text-danger"}>
            {record.ok ? gt("Ready") : gt("Not ready")}
            {record.region ? (
              <span className="ml-1 font-mono text-on-surface-faint">{record.region}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      {record && !record.ok ? (
        <div className="space-y-1 text-on-surface-muted">
          {record.missing.length > 0 ? (
            <>
              <p>{gt("The connection's credential lacks:")}</p>
              <ul className="list-disc pl-5">
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
              className="text-accent hover:underline"
            >
              {data(helpLink.label)}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionRow({
  connection,
  allRepos,
  canWrite,
  client,
  onSaved,
}: {
  connection: CiConnectionAccess;
  allRepos: string[];
  canWrite: boolean;
  client: CiClient;
  onSaved: (c: CiConnectionAccess) => void;
}) {
  const gt = useGT();
  const data = useDataString();
  const [draft, setDraft] = useState<CiConnectionAccessSettings>(connection.settings);
  const [checking, setChecking] = useState<CiExecutorKindId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(connection.settings), [connection.settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(connection.settings);
  const set = (patch: Partial<CiConnectionAccessSettings>) => setDraft((d) => ({ ...d, ...patch }));

  const check = async (kind: CiExecutorKindId) => {
    setChecking(kind);
    setError(null);
    try {
      onSaved(await client.preflightConnection(connection.accountId, kind));
    } catch (e) {
      setError(errorText(e, gt("Could not check the connection")));
    } finally {
      setChecking(null);
    }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await client.setConnectionAccess(connection.accountId, draft));
    } catch (e) {
      setError(errorText(e, gt("Could not save")));
    } finally {
      setBusy(false);
    }
  };

  const kinds = connection.executor?.kinds ?? [];
  return (
    <li className="space-y-3 border-t border-border py-3">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-on-surface">{connection.accountName}</span>
        <span className="text-xs text-on-surface-faint">{connection.pluginName}</span>
      </div>
      <fieldset disabled={!canWrite} className="grid gap-4 md:grid-cols-2">
        {connection.executor ? (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs font-medium text-on-surface">
              <input
                type="checkbox"
                checked={draft.jobsEnabled}
                onChange={(e) => set({ jobsEnabled: e.target.checked })}
              />
              {gt("Run jobs on it")}
            </label>
            {kinds.map((k) => {
              const ready = connection.preflight[k.kind]?.ok === true;
              return (
                <div key={k.kind} className="space-y-1 pl-5">
                  <label className="flex items-center gap-1.5 text-xs text-on-surface">
                    <input
                      type="checkbox"
                      disabled={!ready}
                      checked={draft.jobKinds.includes(k.kind)}
                      onChange={(e) =>
                        set({
                          jobKinds: e.target.checked
                            ? [...draft.jobKinds, k.kind]
                            : draft.jobKinds.filter((x) => x !== k.kind),
                        })
                      }
                    />
                    {data(k.label)}{" "}
                    <span className="font-mono text-on-surface-faint">{k.kind}</span>
                    {k.defaults.machine ? (
                      <span className="text-on-surface-faint">
                        {gt("default {machine}", { machine: k.defaults.machine })}
                      </span>
                    ) : null}
                    {k.regionLabel ? (
                      <span className="text-on-surface-faint">
                        {/* i18n-ignore: pipeline key */}
                        {data(k.regionLabel)}: <span className="font-mono">cloud.region</span>
                      </span>
                    ) : null}
                  </label>
                  <KindCheck
                    connection={connection}
                    kind={k.kind}
                    label={data(k.label)}
                    checking={checking === k.kind}
                    onCheck={() => void check(k.kind)}
                  />
                </div>
              );
            })}
            <div className="flex flex-wrap gap-3 pl-5">
              <label className={labelClass}>
                {gt("Jobs at once")}
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={draft.maxConcurrentJobs}
                  onChange={(e) => set({ maxConcurrentJobs: Number(e.target.value) })}
                  className={`${inputClass} w-20`}
                />
              </label>
              <label className={labelClass}>
                {gt("Minutes per job")}
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={draft.maxJobMinutes}
                  onChange={(e) => set({ maxJobMinutes: Number(e.target.value) })}
                  className={`${inputClass} w-24`}
                />
              </label>
            </div>
            <div className="pl-5">
              <Scope
                repos={draft.jobRepos}
                allRepos={allRepos}
                branchPattern={draft.jobBranchPattern}
                onChange={(jobRepos, jobBranchPattern) => set({ jobRepos, jobBranchPattern })}
              />
            </div>
          </div>
        ) : null}
        {connection.credential ? (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs font-medium text-on-surface">
              <input
                type="checkbox"
                checked={draft.lendEnabled}
                onChange={(e) => set({ lendEnabled: e.target.checked })}
              />
              {gt("Lend its credentials to jobs")}
            </label>
            <p className="pl-5 text-xs text-on-surface-muted">
              {data(connection.credential.description)}
            </p>
            <div className="pl-5">
              <Scope
                repos={draft.lendRepos}
                allRepos={allRepos}
                branchPattern={draft.lendBranchPattern}
                onChange={(lendRepos, lendBranchPattern) => set({ lendRepos, lendBranchPattern })}
              />
            </div>
          </div>
        ) : null}
      </fieldset>
      {canWrite ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busy || !dirty}
            onClick={() => void save()}
            className="rounded bg-accent px-3 py-1 text-xs text-on-accent disabled:opacity-50"
          >
            {gt("Save")}
          </button>
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function GrantForm({
  client,
  allRepos,
  editing,
  onDone,
}: {
  client: CiClient;
  allRepos: string[];
  /** The grant being changed; null for a new one. */
  editing: CiResourceGrant | null;
  onDone: (changed: boolean) => void;
}) {
  const gt = useGT();
  const data = useDataString();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchResult[]>([]);
  const [resource, setResource] = useState<{ id: string; name: string } | null>(
    editing ? { id: editing.resourceId, name: editing.resourceName } : null,
  );
  const [outputs, setOutputs] = useState<CiResourceOutputs | null>(null);
  const [input, setInput] = useState<CiGrantInput>(
    editing
      ? {
          resourceId: editing.resourceId,
          ciName: editing.ciName,
          outputs: editing.outputs,
          secretVersion: editing.secretVersion,
          repos: editing.repos,
          branchPattern: editing.branchPattern,
        }
      : {
          resourceId: "",
          ciName: "",
          outputs: [],
          secretVersion: null,
          repos: null,
          branchPattern: null,
        },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchFailed = gt("Could not search resources");
  const outputsFailed = gt("Could not read the resource's outputs");

  useEffect(() => {
    if (resource || query.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      client
        .searchResources(query.trim())
        .then((h) => !cancelled && setHits(h.filter((r) => r.accountId !== "").slice(0, 20)))
        .catch((e) => !cancelled && setError(errorText(e, searchFailed)));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [client, query, resource, searchFailed]);

  useEffect(() => {
    setOutputs(null);
    if (!resource) return;
    let cancelled = false;
    client
      .resourceOutputs(resource.id)
      .then((o) => {
        if (cancelled) return;
        setOutputs(o);
        // A new grant starts with the outputs that are not sensitive ticked.
        if (!editing) {
          setInput((i) => ({
            ...i,
            outputs: o.outputs.filter((x) => !x.sensitive).map((x) => x.key),
          }));
        }
      })
      .catch((e) => !cancelled && setError(errorText(e, outputsFailed)));
    return () => {
      cancelled = true;
    };
  }, [client, resource, editing, outputsFailed]);

  const pick = (hit: SearchResult) => {
    setResource({ id: hit.id, name: hit.displayName });
    setInput((i) => ({
      ...i,
      resourceId: hit.id,
      ciName: i.ciName || ciGrantNameFor(hit.displayName),
    }));
  };
  const nameOk = CI_GRANT_NAME.test(input.ciName);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing) await client.updateGrant(editing.id, input);
      else await client.createGrant(input);
      onDone(true);
    } catch (e) {
      setError(errorText(e, gt("Could not save")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3 rounded border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {resource ? (
        <div className="flex items-center gap-2 text-xs text-on-surface">
          <span className="font-medium">{resource.name}</span>
          {!editing ? (
            <button
              type="button"
              onClick={() => {
                setResource(null);
                setInput((i) => ({ ...i, resourceId: "", outputs: [], secretVersion: null }));
              }}
              className="text-accent hover:underline"
            >
              {gt("Choose another")}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-1">
          <label className={labelClass}>
            {gt("Resource")}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={gt("Search by name")}
              className={inputClass}
              autoComplete="off"
            />
          </label>
          {hits.length > 0 ? (
            <ul className="max-h-48 overflow-y-auto rounded border border-border">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => pick(h)}
                    className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-surface-sunken"
                  >
                    <span className="text-on-surface">{h.displayName}</span>
                    <span className="text-on-surface-faint">
                      {h.resourceTypeLabel} · {h.accountName}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {resource && outputs ? (
        <>
          <div role="group" aria-label={gt("Outputs")} className="space-y-1">
            <span className="text-[11px] text-on-surface-faint">{gt("Outputs jobs may read")}</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {outputs.outputs.map((o) => (
                <label key={o.key} className="flex items-center gap-1.5 text-xs text-on-surface">
                  <input
                    type="checkbox"
                    checked={input.outputs.includes(o.key)}
                    onChange={(e) =>
                      setInput((i) => ({
                        ...i,
                        outputs: e.target.checked
                          ? [...i.outputs, o.key]
                          : i.outputs.filter((x) => x !== o.key),
                      }))
                    }
                  />
                  {data(o.label)} <span className="font-mono text-on-surface-faint">{o.key}</span>
                  {o.sensitive ? <span className="text-warning">{gt("sensitive")}</span> : null}
                </label>
              ))}
            </div>
          </div>
          {outputs.secretVersions !== null ? (
            <label className={labelClass}>
              {gt("Secret value (read as the output value)")}
              <select
                value={input.secretVersion ?? ""}
                onChange={(e) =>
                  setInput((i) => ({
                    ...i,
                    secretVersion: e.target.value === "" ? null : e.target.value,
                  }))
                }
                className={inputClass}
              >
                <option value="">{gt("Not granted")}</option>
                <option value="latest">{gt("The latest enabled version")}</option>
                {outputs.secretVersions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {gt("Version {id} ({state})", { id: v.id, state: v.state })}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className={labelClass}>
            {gt("Name in pipelines")}
            <input
              value={input.ciName}
              onChange={(e) => setInput((i) => ({ ...i, ciName: e.target.value }))}
              className={`${inputClass} font-mono`}
              aria-invalid={input.ciName !== "" && !nameOk}
              autoComplete="off"
            />
          </label>
          {nameOk ? (
            <p className="font-mono text-[11px] text-on-surface-faint">
              {`\${{ resources.${input.ciName}.<output> }}`}
            </p>
          ) : null}
          <Scope
            repos={input.repos}
            allRepos={allRepos}
            branchPattern={input.branchPattern}
            onChange={(repos, branchPattern) => setInput((i) => ({ ...i, repos, branchPattern }))}
          />
        </>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={
            busy || !resource || !nameOk || (input.outputs.length === 0 && !input.secretVersion)
          }
          className="rounded bg-accent px-3 py-1 text-xs text-on-accent disabled:opacity-50"
        >
          {editing ? gt("Save") : gt("Grant")}
        </button>
        <button
          type="button"
          onClick={() => onDone(false)}
          className="text-xs text-on-surface-muted hover:underline"
        >
          {gt("Cancel")}
        </button>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function scopeText(
  gt: ReturnType<typeof useGT>,
  repos: string[] | null,
  branchPattern: string | null,
): string {
  const where = repos === null ? gt("every repository") : repos.join(", ") || gt("no repository");
  return branchPattern
    ? gt("{where}, branches {branches}", { where, branches: branchPattern })
    : where;
}

/**
 * What CI jobs may use: per connection, running jobs on it and lending its
 * credentials; resources granted one by one; SSH keys their owners lend.
 */
export function CiAccessCard({
  client,
  canManage,
  canNarrow,
}: {
  client: CiClient;
  /** `ci-access:write`: lend connections, grant resources, run cloud jobs. */
  canManage: boolean;
  /** `ci:write`: remove a grant or revoke a lent SSH key (only ever narrows). */
  canNarrow: boolean;
}) {
  const gt = useGT();
  const loadFailed = gt("Failed to load CI access");
  const [overview, setOverview] = useState<CiAccessOverview | null>(null);
  const [allRepos, setAllRepos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState<CiResourceGrant | "new" | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .access()
      .then((o) => !cancelled && setOverview(o))
      .catch((e) => !cancelled && setError(errorText(e, loadFailed)));
    client
      .listAllRepos()
      .then((r) => !cancelled && setAllRepos(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, nonce, loadFailed]);

  const replace = (c: CiConnectionAccess) =>
    setOverview((o) =>
      o
        ? { ...o, connections: o.connections.map((x) => (x.accountId === c.accountId ? c : x)) }
        : o,
    );
  const removeGrant = async (g: CiResourceGrant) => {
    try {
      await client.deleteGrant(g.id);
      setNonce((n) => n + 1);
    } catch (e) {
      setError(errorText(e, gt("Could not remove it")));
    }
  };
  const revoke = async (sshKeyId: string) => {
    try {
      await client.revokeSshKeyLending(sshKeyId);
      setNonce((n) => n + 1);
    } catch (e) {
      setError(errorText(e, gt("Could not revoke it")));
    }
  };

  return (
    <section
      className="space-y-3 rounded border border-border bg-surface-raised p-4"
      aria-labelledby="ci-access"
    >
      <h3 id="ci-access" className="text-sm font-semibold text-on-surface">
        {gt("CI access")}
      </h3>
      {overview === null && !error ? (
        <p role="status" className="text-xs text-on-surface-faint">
          {gt("Loading…")}
        </p>
      ) : null}
      {overview ? (
        <>
          <div>
            <h4 className="text-xs font-semibold text-on-surface-muted">{gt("Connections")}</h4>
            {overview.connections.length === 0 ? (
              <p className="text-xs text-on-surface-muted">
                {gt("No connection's provider can run CI jobs or lend credentials yet.")}
              </p>
            ) : (
              <ul>
                {overview.connections.map((c) => (
                  <ConnectionRow
                    key={c.accountId}
                    connection={c}
                    allRepos={allRepos}
                    canWrite={canManage}
                    client={client}
                    onSaved={replace}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-on-surface-muted">
                {gt("Resources jobs may read")}
              </h4>
              {canManage && editing === null ? (
                <button
                  type="button"
                  onClick={() => setEditing("new")}
                  className="text-xs text-accent hover:underline"
                >
                  {gt("Grant a resource")}
                </button>
              ) : null}
            </div>
            {editing !== null ? (
              <GrantForm
                key={editing === "new" ? "new" : editing.id}
                client={client}
                allRepos={allRepos}
                editing={editing === "new" ? null : editing}
                onDone={(changed) => {
                  setEditing(null);
                  if (changed) setNonce((n) => n + 1);
                }}
              />
            ) : null}
            {overview.grants.length === 0 ? (
              <p className="text-xs text-on-surface-muted">{gt("No resource is granted.")}</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-on-surface-faint">
                    <th scope="col" className="py-1">
                      {gt("Name")}
                    </th>
                    <th scope="col">{gt("Resource")}</th>
                    <th scope="col">{gt("Outputs")}</th>
                    <th scope="col">{gt("For")}</th>
                    <th scope="col">
                      <span className="sr-only">{gt("Actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.grants.map((g) => (
                    <tr key={g.id} className="border-t border-border">
                      <td className="py-1 font-mono text-on-surface">{g.ciName}</td>
                      <td className="text-on-surface-muted">
                        {g.resourceName} · {g.accountName}
                      </td>
                      <td className="font-mono text-on-surface-muted">{g.outputs.join(", ")}</td>
                      <td className="text-on-surface-muted">
                        {scopeText(gt, g.repos, g.branchPattern)}
                      </td>
                      <td className="text-right">
                        {canManage ? (
                          <button
                            type="button"
                            onClick={() => setEditing(g)}
                            className="mr-3 text-accent hover:underline"
                          >
                            {gt("Edit")}
                          </button>
                        ) : null}
                        {canManage || canNarrow ? (
                          <button
                            type="button"
                            onClick={() => void removeGrant(g)}
                            className="text-danger hover:underline"
                          >
                            {gt("Remove")}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <h4 className="text-xs font-semibold text-on-surface-muted">
              {gt("SSH keys lent to CI")}
            </h4>
            {overview.sshKeys.length === 0 ? (
              <p className="text-xs text-on-surface-muted">
                {gt("No SSH key is lent. A key's owner lends it from Settings, SSH keys.")}
              </p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-on-surface-faint">
                    <th scope="col" className="py-1">
                      {gt("Name")}
                    </th>
                    <th scope="col">{gt("Key")}</th>
                    <th scope="col">{gt("Owner")}</th>
                    <th scope="col">{gt("For")}</th>
                    <th scope="col">
                      <span className="sr-only">{gt("Actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.sshKeys.map((k) => (
                    <tr key={k.sshKeyId} className="border-t border-border">
                      <td className="py-1 font-mono text-on-surface">{k.ciName}</td>
                      <td className="text-on-surface-muted">{k.keyName}</td>
                      <td className="text-on-surface-muted">{k.ownerName ?? ""}</td>
                      <td className="text-on-surface-muted">
                        {scopeText(gt, k.repos, k.branchPattern)}
                      </td>
                      <td className="text-right">
                        {canNarrow || canManage ? (
                          <button
                            type="button"
                            onClick={() => void revoke(k.sshKeyId)}
                            className="text-danger hover:underline"
                          >
                            {gt("Revoke")}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
