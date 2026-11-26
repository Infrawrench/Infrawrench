import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  GIT_NAME_MAX_LENGTH,
  formatGitForgeBytes,
  gitNamespaceSlugProblem,
  type CiLiveJobStatus,
  type GitForgeNamespace,
  type GitForgeOverview,
  type GitForgeRepository,
  type GitForgeRepositoryList,
  type GitForgeVisibility,
  type GitNameProblem,
} from "@infrawrench/client-core";
import { CiStatusIcon } from "../ci/CiStatusIcon.js";
import { useStableGT } from "../i18n/stable-gt.js";
import { notifyGitForgeNamespaceChanged } from "../git/forge-link.js";
import { useSettingsHost } from "./host.js";
import { CARD, INPUT, LABEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./styles.js";

/** lucide: external-link, beside every link that leaves for the forge. */
function ExternalGlyph() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

/** A run status as the glyph the CI tab draws for a job in that state. */
function ciGlyphStatus(status: string): CiLiveJobStatus {
  switch (status) {
    case "passed":
    case "failed":
    case "error":
    case "running":
    case "cancelled":
      return status;
    case "rejected":
      return "cancelled";
    default:
      return "pending";
  }
}

function useNameProblemText(): (problem: GitNameProblem) => string {
  const gt = useGT();
  return (problem) => {
    switch (problem) {
      case "empty":
        return gt("A name is required");
      case "too_long":
        return gt("Names are at most {max} characters", { max: GIT_NAME_MAX_LENGTH });
      case "characters":
        return gt(
          "Names use letters, digits, dots, dashes and underscores, and start with a letter, digit or underscore",
        );
      case "git_suffix":
        return gt("Names cannot end in .git or .wiki");
      case "dots":
        return gt("Names cannot end in a dot or contain two dots in a row");
      case "reserved":
        return gt("That name is reserved");
    }
  };
}

function useCiStatusText(): (status: string) => string {
  const gt = useGT();
  return (status) => {
    switch (status) {
      case "passed":
        return gt("Passed");
      case "failed":
        return gt("Failed");
      case "error":
        return gt("Error");
      case "running":
        return gt("Running");
      case "queued":
      case "pending":
        return gt("Queued");
      case "awaiting_approval":
        return gt("Awaiting approval");
      case "cancelled":
        return gt("Cancelled");
      case "rejected":
        return gt("Rejected");
      default:
        // A status a newer server added: shown as sent rather than hidden.
        return status;
    }
  };
}

/**
 * Settings > Git: the organisation's side of git.infrawrench.com. The forge
 * is its own site, so this page holds only what belongs to the organisation
 * (its namespace, what a new repository starts as, what the plan allows) and
 * links out for everything else.
 */
export function GitSection() {
  const gt = useGT();
  // For the fetch below: its identity must not change with a render, or the
  // effect keyed on `load` would ask again on its own `setState`.
  const lazyGt = useStableGT();
  const { orgId, api, has, openExternal, openSection } = useSettingsHost();
  const canAdmin = has("git:admin");
  const [overview, setOverview] = useState<GitForgeOverview | null>(null);
  const [repositories, setRepositories] = useState<GitForgeRepository[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextOverview, list] = await Promise.all([
        api.get<GitForgeOverview>(`/api/org/${orgId}/git`),
        api.get<GitForgeRepositoryList>(`/api/org/${orgId}/git/repositories`),
      ]);
      setOverview(nextOverview);
      setRepositories(list.repositories);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : lazyGt("Failed to load Git settings"));
    }
  }, [api, orgId, lazyGt]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!overview) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-xl font-semibold mb-6">{gt("Git")}</h1>
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : (
          <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
        )}
      </div>
    );
  }

  const { namespace } = overview;
  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{gt("Git")}</h1>
        {namespace && (
          <button
            type="button"
            onClick={() => openExternal(namespace.url)}
            className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
          >
            {gt("Open {name}", { name: namespace.slug })}
            <ExternalGlyph />
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <NamespaceCard
          overview={overview}
          canAdmin={canAdmin}
          onSaved={(saved) => {
            setOverview({ ...overview, namespace: saved });
            // The sidebar's Git entry opens this page.
            notifyGitForgeNamespaceChanged(saved.url);
            // Every repository's URL carries the namespace.
            void load();
          }}
        />
        {namespace && (
          <DefaultVisibilityCard
            namespace={namespace}
            canAdmin={canAdmin}
            onSaved={(saved) => setOverview({ ...overview, namespace: saved })}
          />
        )}
        <UsageCard overview={overview} onUpgrade={() => openSection("billing")} />
        {namespace && (
          <RepositoriesCard repositories={repositories ?? []} openExternal={openExternal} />
        )}
      </div>
    </div>
  );
}

function NamespaceCard({
  overview,
  canAdmin,
  onSaved,
}: {
  overview: GitForgeOverview;
  canAdmin: boolean;
  onSaved: (namespace: GitForgeNamespace) => void;
}) {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const problemText = useNameProblemText();
  const current = overview.namespace?.slug ?? "";
  const [slug, setSlug] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSlug(current);
  }, [current]);

  // The forge's own rules, checked as it is typed; the server checks again
  // and is the only one that knows whether the name is taken.
  const checked = slug === "" ? null : gitNamespaceSlugProblem(slug);
  // A platform admin may take a reserved name; the shape rules still hold.
  const problem = checked === "reserved" && overview.reservedNamesAllowed === true ? null : checked;
  const host = overview.forgeUrl.replace(/^https?:\/\//, "");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.put<GitForgeNamespace>(`/api/org/${orgId}/git/namespace`, { slug }));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save the namespace"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-on-surface-secondary mb-3">{gt("Namespace")}</h2>
      {canAdmin ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (slug !== "" && problem === null && slug !== current) void save();
          }}
        >
          <label htmlFor="git-namespace" className={LABEL}>
            {gt("Name")}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center">
              <span className="rounded-l-lg border border-r-0 border-border-strong bg-surface-sunken px-3 py-2 text-sm text-on-surface-muted">
                {host}/
              </span>
              <input
                id="git-namespace"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                maxLength={GIT_NAME_MAX_LENGTH}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={problem !== null}
                className={`${INPUT} rounded-l-none font-mono`}
              />
            </div>
            <button
              type="submit"
              disabled={saving || slug === "" || problem !== null || slug === current}
              className={PRIMARY_BUTTON}
            >
              {overview.namespace ? gt("Rename") : gt("Claim")}
            </button>
          </div>
          {problem !== null && <p className="mt-2 text-xs text-danger">{problemText(problem)}</p>}
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
          {overview.namespace && slug !== current && problem === null && (
            <p className="mt-2 text-xs text-warning">
              {gt("Renaming changes every repository's URL. The old ones stop working.")}
            </p>
          )}
        </form>
      ) : overview.namespace ? (
        <p className="font-mono text-sm text-on-surface-secondary">
          {host}/{overview.namespace.slug}
        </p>
      ) : (
        <p className="text-sm text-on-surface-muted">
          {gt("Not claimed. Someone with the git:admin permission can claim one.")}
        </p>
      )}
    </section>
  );
}

function DefaultVisibilityCard({
  namespace,
  canAdmin,
  onSaved,
}: {
  namespace: GitForgeNamespace;
  canAdmin: boolean;
  onSaved: (namespace: GitForgeNamespace) => void;
}) {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(defaultVisibility: GitForgeVisibility) {
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await api.put<GitForgeNamespace>(`/api/org/${orgId}/git/settings`, { defaultVisibility }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save Git settings"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-on-surface-secondary mb-3">
        {gt("New repositories")}
      </h2>
      <label htmlFor="git-default-visibility" className={LABEL}>
        {gt("Default visibility")}
      </label>
      <select
        id="git-default-visibility"
        value={namespace.defaultVisibility}
        disabled={!canAdmin || saving}
        onChange={(e) => void save(e.target.value === "public" ? "public" : "private")}
        className={`${INPUT} max-w-xs disabled:opacity-60`}
      >
        <option value="private">{gt("Private")}</option>
        <option value="public">{gt("Public")}</option>
      </select>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}

function Meter({ used, limit, label }: { used: number; limit: number; label: string }) {
  const fraction = limit > 0 ? Math.min(1, used / limit) : 0;
  const tone = fraction >= 1 ? "bg-danger" : fraction >= 0.8 ? "bg-warning" : "bg-accent";
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={Math.min(used, limit)}
      className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-overlay"
    >
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${fraction * 100}%` }} />
    </div>
  );
}

function UsageCard({ overview, onUpgrade }: { overview: GitForgeOverview; onUpgrade: () => void }) {
  const gt = useGT();
  const { usage, limits, plan } = overview;
  const metered = limits.includedStorageBytes < limits.privateStorageBytes;
  return (
    <section className={CARD}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-on-surface-secondary">{gt("Usage")}</h2>
        {plan === "free" && (
          <button type="button" onClick={onUpgrade} className={SECONDARY_BUTTON}>
            {gt("Upgrade")}
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <div>
          <div className={LABEL}>{gt("Public repositories")}</div>
          <div className="text-sm text-on-surface-secondary">{usage.publicRepositories}</div>
          <div className="mt-1 text-xs text-on-surface-muted">{gt("Free on every plan")}</div>
        </div>
        <div>
          <div className={LABEL}>{gt("Private repositories")}</div>
          <div className="text-sm text-on-surface-secondary">
            {limits.privateRepositories === null
              ? usage.privateRepositories
              : gt("{used} of {limit}", {
                  used: usage.privateRepositories,
                  limit: limits.privateRepositories,
                })}
          </div>
          {limits.privateRepositories === null ? (
            <div className="mt-1 text-xs text-on-surface-muted">{gt("No limit")}</div>
          ) : (
            <Meter
              used={usage.privateRepositories}
              limit={limits.privateRepositories}
              label={gt("Private repositories")}
            />
          )}
        </div>
        <div>
          <div className={LABEL}>{gt("Private storage")}</div>
          <div className="text-sm text-on-surface-secondary">
            {gt("{used} of {limit}", {
              used: formatGitForgeBytes(usage.privateStorageBytes),
              limit: formatGitForgeBytes(limits.privateStorageBytes),
            })}
          </div>
          <Meter
            used={usage.privateStorageBytes}
            limit={limits.privateStorageBytes}
            label={gt("Private storage")}
          />
          {metered && (
            <div className="mt-1 text-xs text-on-surface-muted">
              {gt("{included} included, then metered", {
                included: formatGitForgeBytes(limits.includedStorageBytes),
              })}
            </div>
          )}
        </div>
      </div>
      {usage.storageBytes > usage.privateStorageBytes && (
        <p className="mt-4 text-xs text-on-surface-muted">
          {gt("{total} stored in all, public repositories included.", {
            total: formatGitForgeBytes(usage.storageBytes),
          })}
        </p>
      )}
    </section>
  );
}

function RepositoriesCard({
  repositories,
  openExternal,
}: {
  repositories: GitForgeRepository[];
  openExternal: (url: string) => void;
}) {
  const gt = useGT();
  const ciText = useCiStatusText();
  return (
    <section>
      <h2 className="text-sm font-semibold text-on-surface-secondary mb-3">{gt("Repositories")}</h2>
      {repositories.length === 0 ? (
        <div className={CARD}>
          <p className="text-sm text-on-surface-muted">{gt("No repositories yet.")}</p>
        </div>
      ) : (
        <div className="border border-border rounded-xl overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-xs text-on-surface-muted">
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Name")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Visibility")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("CI")}
                </th>
                <th scope="col" className="text-right px-4 py-2 font-medium">
                  {gt("Open pull requests")}
                </th>
                <th scope="col" className="text-left px-4 py-2 font-medium">
                  {gt("Last push")}
                </th>
                <th scope="col" className="text-right px-4 py-2 font-medium">
                  {gt("Size")}
                </th>
              </tr>
            </thead>
            <tbody>
              {repositories.map((repository) => (
                <tr
                  key={repository.id}
                  className="border-b border-border/50 last:border-b-0 hover:bg-surface-raised/50"
                >
                  <td className="px-4 py-2 text-sm">
                    <button
                      type="button"
                      onClick={() => openExternal(repository.url)}
                      className="inline-flex items-center gap-1.5 font-mono text-on-surface-secondary hover:text-on-surface hover:underline"
                    >
                      {repository.name}
                      <ExternalGlyph />
                    </button>
                    {repository.archived && (
                      <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[10px] text-on-surface-muted">
                        {gt("Archived")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary">
                    {repository.visibility === "public" ? gt("Public") : gt("Private")}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary">
                    {repository.ci ? (
                      <span className="inline-flex items-center gap-1.5">
                        <CiStatusIcon status={ciGlyphStatus(repository.ci.status)} />
                        {ciText(repository.ci.status)}
                      </span>
                    ) : (
                      <span className="text-on-surface-faint">{gt("None")}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-xs tabular-nums text-on-surface-tertiary">
                    {repository.openPullRequests}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-muted">
                    {repository.pushedAt
                      ? new Date(repository.pushedAt).toLocaleString()
                      : gt("Never")}
                  </td>
                  <td className="px-4 py-2 text-right text-xs tabular-nums text-on-surface-muted">
                    {formatGitForgeBytes(repository.sizeBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
