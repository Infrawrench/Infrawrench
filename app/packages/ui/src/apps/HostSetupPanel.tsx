import { useEffect, useMemo, useRef, useState } from "react";
import { T, useGT } from "gt-react";
import type { HostPreflight, InstallPlan, RequirementId } from "@infrawrench/appstream-core";

/**
 * "This host is missing what applications need" — and the button that fixes it.
 *
 * Shown in place of the launcher grid when the check comes back short. Three
 * things about the shape of it are deliberate:
 *
 * **It says what breaks, not what is absent.** "xkb-data is not installed" is
 * true and useless; "typing will do nothing" is what the user is deciding
 * about. The package names are still there, in the commands.
 *
 * **The commands are visible before the button is pressed.** This installs
 * packages as root on a machine that is not ours. The honest version of that
 * offer shows exactly what it will run, and can be copied and run by hand
 * instead — which is the only path available on a host that would prompt for a
 * sudo password.
 *
 * **The result comes from a second check, not from the install.** A package
 * manager exits zero having not fixed anything, so the panel re-renders from
 * the fresh preflight its caller hands back rather than from "the install
 * succeeded".
 *
 * Presentational, like `AppLauncherPanel`: it takes a preflight and three
 * callbacks so both platforms drive it from their own transport.
 */
export interface HostSetupPanelProps {
  preflight: HostPreflight;
  /** What would be installed. Null when nothing is missing that packages fix. */
  plan: InstallPlan | null;
  /** Install the named requirements. Resolves when the host has been re-checked. */
  onInstall: (requirements: RequirementId[]) => Promise<void>;
  /** Re-run the check without installing anything. */
  onRecheck: () => void;
  /**
   * Open the launcher anyway.
   *
   * Offered even when a required item is missing, because the check can be
   * wrong — an unusual host may have what it needs somewhere we did not look —
   * and being told "no" by software that will not let you try is worse than a
   * session that fails.
   */
  onContinueAnyway: () => void;
  /** Live output from the install, when the platform streams it. */
  log?: string[];
  installing?: boolean;
  /** An install that could not run at all, as opposed to one that fell short. */
  error?: string | null;
}

/**
 * The user-facing copy per requirement.
 *
 * A `switch` over literals rather than the `title`/`summary` on the preflight,
 * because gt's extractor needs literal arguments and a string that arrived from
 * a package is not one. `@infrawrench/appstream-host` carries the English copy
 * for the CLI; this carries the translated version for the two UIs.
 */
function RequirementCopy({ id }: { id: RequirementId }) {
  switch (id) {
    case "gzip":
      return (
        <T>Unpacks the app server after it is uploaded. Without it nothing can start at all.</T>
      );
    case "xkb":
      return <T>Keyboard layout data. Without it the keyboard does nothing and never says why.</T>;
    case "dbus":
      return (
        <T>
          A session message bus. GTK applications wait for one before showing a window, and do not
          report that they are waiting.
        </T>
      );
    case "fonts":
      return <T>Without a font installed, applications draw empty boxes or refuse to start.</T>;
    case "mesa":
      return (
        <T>
          Software OpenGL. Browsers and Electron applications need it; GTK and Qt are pushed onto
          software rendering instead.
        </T>
      );
    case "icons":
      return (
        <T>
          An icon theme. Without one the launcher shows initials instead of icons, and toolbar
          buttons come out blank.
        </T>
      );
  }
}

function RequirementTitle({ id }: { id: RequirementId }) {
  switch (id) {
    case "gzip":
      return <T>gzip</T>;
    case "xkb":
      return <T>Keyboard layout data</T>;
    case "dbus":
      return <T>Session message bus</T>;
    case "fonts":
      return <T>Fonts</T>;
    case "mesa":
      return <T>Software OpenGL</T>;
    case "icons":
      return <T>Icon theme</T>;
  }
}

export function HostSetupPanel({
  preflight,
  plan,
  onInstall,
  onRecheck,
  onContinueAnyway,
  log = [],
  installing = false,
  error = null,
}: HostSetupPanelProps) {
  const gt = useGT();
  const [copied, setCopied] = useState(false);
  const [includeRecommended, setIncludeRecommended] = useState(true);
  const logBox = useRef<HTMLDivElement>(null);

  const missing = useMemo(
    () => preflight.requirements.filter((requirement) => !requirement.ok),
    [preflight],
  );
  const missingRequired = missing.filter((requirement) => requirement.severity === "required");

  // Recommended items are installed alongside by default — a user who came here
  // to make applications work is not well served by a second round trip for
  // the browser's GL driver — but they are visible and can be dropped.
  const requirementsToInstall = useMemo(
    () =>
      missing
        .filter((requirement) => includeRecommended || requirement.severity === "required")
        .map((requirement) => requirement.id),
    [missing, includeRecommended],
  );

  const commands = plan?.commands ?? [];

  // Follow the output, the same way the chat panel follows a stream — but only
  // while the user is already at the bottom, so scrolling back to read the line
  // that mentioned an error is not undone by the next one arriving.
  useEffect(() => {
    const box = logBox.current;
    if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }, [log.length]);

  const copyCommands = () => {
    void navigator.clipboard?.writeText(commands.join("\n")).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {
        /* not permitted; the commands are on screen either way */
      },
    );
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-on-surface">
          {missingRequired.length > 0 ? (
            <T>This host is missing what applications need</T>
          ) : (
            <T>This host is ready, with one thing worth adding</T>
          )}
        </h2>
        <p className="text-sm text-on-surface-muted">
          <T>
            Infrawrench brings the display and uploads the app server itself. The host provides the
            few pieces the applications themselves rely on.
          </T>
        </p>
        <p className="text-xs text-on-surface-faint">
          {/* The host's own name for itself, so the user can tell they are
              looking at the box they think they are. */}
          {preflight.osName} · {preflight.arch}
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {preflight.requirements.map((requirement) => (
          <li
            key={requirement.id}
            className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3"
          >
            <span
              aria-hidden="true"
              className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs ${
                requirement.ok
                  ? "bg-success-surface text-success-on-surface"
                  : requirement.severity === "required"
                    ? "bg-danger-surface text-danger-on-surface"
                    : "bg-warning-surface text-warning-on-surface"
              }`}
            >
              {requirement.ok ? "✓" : "!"}
            </span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-on-surface">
                  <RequirementTitle id={requirement.id} />
                </span>
                <span className="sr-only">{requirement.ok ? gt("installed") : gt("missing")}</span>
                {!requirement.ok && requirement.severity === "recommended" && (
                  <span className="rounded border border-warning-border px-1 text-[10px] uppercase text-warning-on-surface">
                    <T>optional</T>
                  </span>
                )}
              </span>
              {!requirement.ok && (
                <span className="mt-0.5 block text-xs text-on-surface-muted">
                  <RequirementCopy id={requirement.id} />
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {!preflight.staging && (
        // No package fixes this, so it is said separately and without a button.
        <p className="rounded-lg border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface">
          <T>
            There is no directory on this host we can run the app server from — /tmp and /dev/shm
            are either unwritable or mounted noexec. Applications cannot run here until one of them
            allows execution.
          </T>
        </p>
      )}

      {commands.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-faint">
              <T>What will run on the host</T>
            </h3>
            <button
              type="button"
              onClick={copyCommands}
              className="rounded-md border border-border px-2 py-1 text-xs text-on-surface-secondary hover:text-on-surface"
            >
              {copied ? <T>Copied</T> : <T>Copy</T>}
            </button>
          </div>
          <pre className="overflow-x-auto rounded-md border border-border bg-surface-sunken p-3 font-mono text-xs text-on-surface-secondary">
            {commands.join("\n")}
          </pre>
        </section>
      )}

      {plan && !plan.canInstall && (
        <p className="text-sm text-warning-on-surface" role="status">
          {plan.blockedReason === undefined ? (
            <T>These packages have to be installed on the host by hand.</T>
          ) : (
            <T>
              Infrawrench cannot install these itself on this host — run the commands above over
              SSH, then check again.
            </T>
          )}
        </p>
      )}

      {error && (
        <p className="text-sm text-danger-on-surface" role="alert">
          {error}
        </p>
      )}

      {log.length > 0 && (
        <section className="flex min-h-0 flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-faint">
            <T>Output</T>
          </h3>
          <div
            ref={logBox}
            className="max-h-64 overflow-y-auto rounded-md border border-border bg-surface-sunken p-3"
          >
            <pre className="whitespace-pre-wrap font-mono text-xs text-on-surface-secondary">
              {log.join("\n")}
            </pre>
          </div>
        </section>
      )}

      <footer className="mt-auto flex flex-col gap-3 border-t border-border pt-4">
        {missing.some((requirement) => requirement.severity === "recommended") &&
          missingRequired.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-on-surface-muted">
              <input
                type="checkbox"
                checked={includeRecommended}
                onChange={(event) => setIncludeRecommended(event.target.checked)}
                className="size-3.5"
              />
              <T>Also install the optional pieces</T>
            </label>
          )}
        <div className="flex flex-wrap items-center gap-2">
          {plan?.canInstall && (
            <button
              type="button"
              disabled={installing || requirementsToInstall.length === 0}
              onClick={() => void onInstall(requirementsToInstall)}
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {installing ? <T>Installing…</T> : <T>Install what's missing</T>}
            </button>
          )}
          <button
            type="button"
            disabled={installing}
            onClick={onRecheck}
            className="rounded-md border border-border px-3 py-2 text-sm text-on-surface-secondary hover:text-on-surface disabled:opacity-50"
          >
            <T>Check again</T>
          </button>
          <button
            type="button"
            disabled={installing}
            onClick={onContinueAnyway}
            className="rounded-md px-3 py-2 text-sm text-on-surface-faint hover:text-on-surface disabled:opacity-50"
          >
            <T>Open anyway</T>
          </button>
        </div>
      </footer>
    </div>
  );
}
