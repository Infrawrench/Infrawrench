import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { CiCacheCleared, CiCaches } from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { formatBytes } from "./format.js";
import type { CiClient } from "./types.js";

interface Target {
  installationId: number;
  accountLogin: string;
  repo: string;
  bytes: number;
  entries: number;
}

function ConfirmClear({
  target,
  client,
  onCleared,
  onClose,
}: {
  target: Target;
  client: CiClient;
  onCleared: (cleared: CiCacheCleared) => void;
  onClose: () => void;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = `${target.accountLogin}/${target.repo}`;

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      onCleared(await client.clearCache(target.installationId, target.repo));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Could not clear the cache"));
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={() => {
        // Not while it clears: the result would land on a closed dialog.
        if (!busy) onClose();
      }}
      ariaLabel={gt("Clear the cache of {repo}", { repo: name })}
    >
      <div className="w-[440px] max-w-full space-y-3 rounded-xl border border-border-strong bg-surface-raised p-6 shadow-2xl">
        <h2 className="text-sm font-semibold text-on-surface">
          {gt("Clear the cache of {repo}?", { repo: name })}
        </h2>
        <p className="text-xs text-on-surface-muted">
          {gt(
            "This deletes {entries} cache entries ({size}) across every branch and pull request, the task cache's results included. The next run of each job starts cold and saves them again.",
            { entries: String(target.entries), size: formatBytes(target.bytes) },
          )}
        </p>
        <p className="text-xs text-on-surface-faint">
          {gt("Other repositories keep their caches. This cannot be undone.")}
        </p>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-on-surface-tertiary transition-colors hover:text-on-surface-secondary"
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void clear()}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-red-500 disabled:opacity-40"
          >
            {busy ? gt("Clearing…") : gt("Clear cache")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The caches CI keeps per repository (`cache:` entries and the task cache's
 * results), with a way to clear one repository's under `ci:write`.
 */
export function CiCachesCard({ client, canWrite }: { client: CiClient; canWrite: boolean }) {
  const gt = useGT();
  // A string, not `gt`, in the effect's deps: `gt` is not referentially
  // stable, and depending on it refetched on every render.
  const loadFailed = gt("Failed to load the caches");
  const [caches, setCaches] = useState<CiCaches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [confirming, setConfirming] = useState<Target | null>(null);
  const [cleared, setCleared] = useState<(CiCacheCleared & { accountLogin: string }) | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listCaches()
      .then((c) => {
        if (cancelled) return;
        setCaches(c);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : loadFailed));
    return () => {
      cancelled = true;
    };
  }, [client, nonce, loadFailed]);

  const repoCount = caches?.accounts.reduce((n, a) => n + a.repos.length, 0) ?? 0;

  return (
    <section
      className="space-y-3 rounded border border-border bg-surface-raised p-4"
      aria-labelledby="ci-caches"
    >
      <div>
        <h3 id="ci-caches" className="text-sm font-semibold text-on-surface">
          {gt("Caches")}
        </h3>
        <p className="text-xs text-on-surface-faint">
          {gt(
            "Each repository's saved caches and task cache results, across every branch and pull request.",
          )}
        </p>
      </div>
      {cleared ? (
        <div
          role="status"
          className="flex items-start justify-between gap-2 rounded border border-success/40 bg-success/10 px-3 py-2 text-xs text-on-surface"
        >
          <span>
            {gt("Cleared {entries} cache entries ({size}) from {repo}.", {
              entries: String(cleared.deletedEntries),
              size: formatBytes(cleared.deletedBytes),
              repo: `${cleared.accountLogin}/${cleared.repo}`,
            })}
          </span>
          <button
            type="button"
            onClick={() => setCleared(null)}
            className="shrink-0 text-on-surface-faint hover:text-on-surface"
          >
            {gt("Dismiss")}
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : caches === null ? (
        <p role="status" className="text-xs text-on-surface-faint">
          {gt("Loading…")}
        </p>
      ) : repoCount === 0 && caches.accounts.every((a) => a.error === null) ? (
        <p className="text-xs text-on-surface-muted">
          {gt("No repository has saved a cache yet.")}
        </p>
      ) : (
        <div className="space-y-3">
          {caches.accounts.map((account) => (
            <div key={account.installationId}>
              <p className="text-xs font-medium text-on-surface-secondary">
                {account.quotaBytes === null
                  ? gt("{account}: {used}", {
                      account: account.accountLogin,
                      used: formatBytes(account.usedBytes),
                    })
                  : gt("{account}: {used} of {quota}", {
                      account: account.accountLogin,
                      used: formatBytes(account.usedBytes),
                      quota: formatBytes(account.quotaBytes),
                    })}
              </p>
              {account.error ? (
                <p role="alert" className="text-xs text-danger">
                  {gt("The runners could not say: {error}", { error: account.error })}
                </p>
              ) : account.repos.length === 0 ? (
                <p className="text-xs text-on-surface-faint">{gt("No caches saved.")}</p>
              ) : (
                <table className="mt-1 w-full text-xs">
                  <caption className="sr-only">
                    {gt("Caches of {account}'s repositories", { account: account.accountLogin })}
                  </caption>
                  <thead>
                    <tr className="text-left text-on-surface-faint">
                      <th scope="col" className="py-1">
                        {gt("Repository")}
                      </th>
                      <th scope="col">{gt("Entries")}</th>
                      <th scope="col">{gt("Size")}</th>
                      <th scope="col">
                        <span className="sr-only">{gt("Actions")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.repos.map((repo) => (
                      <tr key={repo.repo} className="border-t border-border">
                        <td className="py-1.5 text-on-surface">{repo.repo}</td>
                        <td className="py-1.5 tabular-nums text-on-surface-muted">
                          {repo.entries}
                        </td>
                        <td className="py-1.5 tabular-nums text-on-surface-muted">
                          {formatBytes(repo.bytes)}
                        </td>
                        <td className="py-1.5 text-right">
                          {canWrite ? (
                            <button
                              type="button"
                              onClick={() => {
                                setCleared(null);
                                setConfirming({
                                  installationId: account.installationId,
                                  accountLogin: account.accountLogin,
                                  repo: repo.repo,
                                  bytes: repo.bytes,
                                  entries: repo.entries,
                                });
                              }}
                              aria-label={gt("Clear the cache of {repo}", {
                                repo: `${account.accountLogin}/${repo.repo}`,
                              })}
                              className="rounded border border-border px-2 py-0.5 text-xs text-on-surface hover:bg-surface-sunken"
                            >
                              {gt("Clear cache")}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
      {confirming ? (
        <ConfirmClear
          target={confirming}
          client={client}
          onClose={() => setConfirming(null)}
          onCleared={(result) => {
            setCleared({ ...result, accountLogin: confirming.accountLogin });
            setConfirming(null);
            setNonce((n) => n + 1);
          }}
        />
      ) : null}
    </section>
  );
}
