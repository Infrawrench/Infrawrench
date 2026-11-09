import { useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import { CI_VALUE_NAME, type CiAccount, type CiValues } from "@infrawrench/client-core";
import type { CiClient } from "./types.js";

type Kind = "secrets" | "variables";

/**
 * Secrets and variables for the accounts that run CI, per account or per
 * repository. A secret's value is write-only: it can be replaced or removed,
 * never shown.
 */
export function CiValuesCard({ client, accounts }: { client: CiClient; accounts: CiAccount[] }) {
  const gt = useGT();
  // A string, not `gt`, in the effect's deps: `gt` is not referentially
  // stable, and depending on it refetched on every render.
  const loadFailed = gt("Failed to load secrets and variables");
  const enabled = useMemo(() => accounts.filter((a) => a.ciEnabled), [accounts]);
  const [installationId, setInstallationId] = useState<number | null>(
    enabled[0]?.installationId ?? null,
  );
  const [repo, setRepo] = useState<string>("");
  const [repos, setRepos] = useState<string[]>([]);
  const [values, setValues] = useState<CiValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [kind, setKind] = useState<Kind>("secrets");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  // Keep the chosen account valid as accounts are switched on and off.
  useEffect(() => {
    if (installationId === null || !enabled.some((a) => a.installationId === installationId)) {
      setInstallationId(enabled[0]?.installationId ?? null);
      setRepo("");
    }
  }, [enabled, installationId]);

  useEffect(() => {
    setRepos([]);
    if (installationId === null) return;
    let cancelled = false;
    client
      .listRepos(installationId)
      .then((r) => !cancelled && setRepos(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, installationId]);

  useEffect(() => {
    setValues(null);
    setError(null);
    if (installationId === null) return;
    let cancelled = false;
    client
      .listValues(installationId, repo || null)
      .then((v) => !cancelled && setValues(v))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : loadFailed));
    return () => {
      cancelled = true;
    };
  }, [client, installationId, repo, nonce, loadFailed]);

  if (enabled.length === 0 || installationId === null) return null;

  const nameOk = CI_VALUE_NAME.test(name);
  const save = async () => {
    if (!nameOk) return;
    setBusy(true);
    setError(null);
    try {
      await client.setValue(installationId, repo || null, kind, name, value);
      setName("");
      setValue("");
      setNonce((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not save"));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (k: Kind, n: string) => {
    setBusy(true);
    setError(null);
    try {
      await client.deleteValue(installationId, repo || null, k, n);
      setNonce((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not remove it"));
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "rounded border border-border bg-surface px-2 py-1 text-xs text-on-surface placeholder:text-on-surface-faint";

  return (
    <section
      className="rounded border border-border bg-surface-raised p-4 space-y-3"
      aria-labelledby="ci-values"
    >
      <div>
        <h3 id="ci-values" className="text-sm font-semibold text-on-surface">
          {gt("Secrets and variables")}
        </h3>
        <p className="text-xs text-on-surface-faint">
          {gt(
            "Pipelines read these as {secretSyntax} in an env: value and {variableSyntax} anywhere. A repository's own values override the account's. Pull requests from forks get variables but never secrets.",
            // Pipeline syntax, the same in every language.
            { secretSyntax: "${{ secrets.NAME }}", variableSyntax: "${{ vars.NAME }}" },
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-muted">
        <label className="flex items-center gap-1.5">
          {gt("Account")}
          <select
            value={installationId}
            onChange={(e) => {
              setInstallationId(Number(e.target.value));
              setRepo("");
            }}
            className={inputClass}
          >
            {enabled.map((a) => (
              <option key={a.installationId} value={a.installationId}>
                {a.accountLogin}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          {gt("Scope")}
          <select value={repo} onChange={(e) => setRepo(e.target.value)} className={inputClass}>
            <option value="">{gt("Every repository")}</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>

      {values === null && !error ? (
        <p role="status" className="text-xs text-on-surface-faint">
          {gt("Loading…")}
        </p>
      ) : null}
      {values ? (
        values.secrets.length + values.variables.length === 0 ? (
          <p className="text-xs text-on-surface-muted">{gt("Nothing set in this scope yet.")}</p>
        ) : (
          <table className="w-full text-xs">
            <caption className="sr-only">{gt("Secrets and variables")}</caption>
            <thead>
              <tr className="text-left text-on-surface-faint">
                <th scope="col" className="py-1">
                  {gt("Name")}
                </th>
                <th scope="col">{gt("Kind")}</th>
                <th scope="col">{gt("Value")}</th>
                <th scope="col">{gt("Updated")}</th>
                <th scope="col">
                  <span className="sr-only">{gt("Actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {values.secrets.map((s) => (
                <tr key={`s:${s.name}`} className="border-t border-border">
                  <td className="py-1 font-mono text-on-surface">{s.name}</td>
                  <td>{gt("Secret")}</td>
                  <td className="text-on-surface-faint">{gt("Hidden")}</td>
                  <td className="text-on-surface-muted">
                    {new Date(s.updatedAt).toLocaleString()}
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove("secrets", s.name)}
                      className="text-danger hover:underline disabled:opacity-50"
                    >
                      {gt("Remove")}
                    </button>
                  </td>
                </tr>
              ))}
              {values.variables.map((v) => (
                <tr key={`v:${v.name}`} className="border-t border-border">
                  <td className="py-1 font-mono text-on-surface">{v.name}</td>
                  <td>{gt("Variable")}</td>
                  <td className="max-w-xs truncate font-mono text-on-surface-muted">{v.value}</td>
                  <td className="text-on-surface-muted">
                    {new Date(v.updatedAt).toLocaleString()}
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setKind("variables");
                        setName(v.name);
                        setValue(v.value);
                      }}
                      className="mr-3 text-accent hover:underline"
                    >
                      {gt("Edit")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove("variables", v.name)}
                      className="text-danger hover:underline disabled:opacity-50"
                    >
                      {gt("Remove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}

      <form
        className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="flex flex-col gap-1 text-[11px] text-on-surface-faint">
          {gt("Kind")}
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            className={inputClass}
          >
            <option value="secrets">{gt("Secret")}</option>
            <option value="variables">{gt("Variable")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-on-surface-faint">
          {gt("Name")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="NPM_TOKEN"
            className={`${inputClass} font-mono`}
            aria-invalid={name !== "" && !nameOk}
            autoComplete="off"
          />
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-[11px] text-on-surface-faint">
          {gt("Value")}
          {kind === "secrets" ? (
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className={inputClass}
              autoComplete="new-password"
            />
          ) : (
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className={inputClass}
              autoComplete="off"
            />
          )}
        </label>
        <button
          type="submit"
          disabled={busy || !nameOk}
          className="rounded bg-accent px-3 py-1 text-xs text-on-accent disabled:opacity-50"
        >
          {gt("Save")}
        </button>
        {name !== "" && !nameOk ? (
          <p className="w-full text-[11px] text-danger">
            {gt("Names are letters, digits and _, not starting with a digit.")}
          </p>
        ) : null}
      </form>

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
