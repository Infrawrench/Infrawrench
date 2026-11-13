import { useId, useMemo } from "react";
import { useGT } from "gt-react";
import { ciBranchGlobs } from "@infrawrench/client-core";
import { CloudIcon } from "../components/icons/ChromeIcons.js";
import { INPUT, LABEL } from "../settings/styles.js";

/** The pieces the CI access card and its connections dialog share. */

export function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/**
 * A provider's logo from its manifest in a small tile; `fallback` (a generic
 * cloud by default) while there is none.
 */
export function PluginLogo({
  svg,
  size = "md",
  fallback,
}: {
  svg: string | undefined;
  size?: "sm" | "md";
  fallback?: React.ReactNode;
}) {
  const box = size === "sm" ? "size-6" : "size-8";
  const inner = size === "sm" ? "size-4" : "size-5";
  return (
    <span
      aria-hidden="true"
      className={`${box} flex flex-shrink-0 items-center justify-center rounded-md border border-border bg-surface text-on-surface-faint`}
    >
      {svg ? (
        <span
          className={`${inner} [&>svg]:h-full [&>svg]:w-full`}
          // Bundled provider metadata from trusted plugin manifests, never user input.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        (fallback ?? <CloudIcon size={size === "sm" ? 13 : 15} />)
      )}
    </span>
  );
}

/** An on/off switch, the same one the settings sections use. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The accessible name: the switch has no visible text of its own. */
  label: string;
  disabled?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-accent" : "border border-border-strong bg-surface-sunken"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${
          checked ? "translate-x-4 bg-on-accent" : "translate-x-1 bg-on-surface-muted"
        }`}
      />
    </button>
  );
}

/** A small rounded label: what a connection does, or where a permission holds. */
export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: "on" | "neutral" | "warning";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "on"
      ? "border-success/30 bg-success/10 text-success"
      : tone === "warning"
        ? "border-warning/30 bg-warning/10 text-warning"
        : "border-border bg-surface text-on-surface-muted";
  return (
    <span
      className={`inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] leading-4 ${toneClass}`}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * Where a permission holds, in a few words: the repositories, then the
 * branches ("All repositories · main, release/*").
 */
export function scopeSummary(
  gt: ReturnType<typeof useGT>,
  repos: string[] | null,
  branchPattern: string | null,
): string {
  const where =
    repos === null
      ? gt("All repositories")
      : repos.length === 0
        ? gt("No repository")
        : repos.length <= 2
          ? repos.join(", ")
          : gt("{first} and {count} more", { first: repos[0]!, count: String(repos.length - 1) });
  const branches = branchPattern === null ? gt("All branches") : branchPattern;
  return `${where} · ${branches}`;
}

/**
 * Which repositories and branches a permission holds for: every repository,
 * or the ones ticked, and an optional branch pattern.
 */
export function ScopeFields({
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
  const noGlobs = branchPattern !== null && ciBranchGlobs(branchPattern).length === 0;
  const option = (selected: boolean) =>
    `flex cursor-pointer items-center rounded-md px-2.5 py-1 transition-colors has-[:disabled]:cursor-default ${
      selected
        ? "bg-surface-overlay text-on-surface shadow-sm"
        : "text-on-surface-muted hover:text-on-surface"
    }`;
  return (
    <div className="space-y-4">
      <div role="group" aria-labelledby={`${id}-repos`}>
        <span id={`${id}-repos`} className={LABEL}>
          {gt("Repositories")}
        </span>
        <div className="inline-flex rounded-lg border border-border-strong p-0.5 text-xs">
          <label className={option(repos === null)}>
            <input
              type="radio"
              name={`${id}-scope`}
              className="sr-only"
              checked={repos === null}
              onChange={() => onChange(null, branchPattern)}
            />
            {gt("Every repository")}
          </label>
          <label className={option(repos !== null)}>
            <input
              type="radio"
              name={`${id}-scope`}
              className="sr-only"
              checked={repos !== null}
              onChange={() => onChange(repos ?? [], branchPattern)}
            />
            {gt("Chosen repositories")}
          </label>
        </div>
        {repos !== null ? (
          <div className="mt-2 grid max-h-40 gap-x-4 gap-y-1.5 overflow-y-auto rounded-lg border border-border p-2.5 sm:grid-cols-2">
            {known.map((r) => (
              <label
                key={r}
                className="flex min-w-0 items-center gap-2 font-mono text-xs text-on-surface"
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
                <span className="truncate">{r}</span>
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
      <div>
        <label htmlFor={`${id}-branches`} className={LABEL}>
          {gt("Branches")}
        </label>
        <input
          id={`${id}-branches`}
          value={branchPattern ?? ""}
          onChange={(e) => onChange(repos, e.target.value.trim() === "" ? null : e.target.value)}
          // i18n-ignore: branch glob syntax
          placeholder="main, release/*"
          className={`${INPUT} font-mono`}
          aria-invalid={noGlobs}
          aria-describedby={`${id}-branches-help`}
          autoComplete="off"
        />
        <p
          id={`${id}-branches-help`}
          className={`mt-1 text-[11px] ${noGlobs ? "text-danger" : "text-on-surface-faint"}`}
        >
          {noGlobs
            ? gt("No branch: name at least one, or clear the field for every branch")
            : gt("Patterns separated by commas. Leave empty for every branch.")}
        </p>
      </div>
    </div>
  );
}
