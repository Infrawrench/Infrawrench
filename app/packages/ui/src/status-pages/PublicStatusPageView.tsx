import {
  formatUptime,
  groupStatusComponents,
  statusComponentLabel,
  type PublicStatusComponent,
  type PublicStatusPage,
  type StatusComponentState,
  type StatusHistoryDay,
  type StatusPageState,
} from "@infrawrench/client-core";

export interface PublicStatusPageViewProps {
  page: PublicStatusPage;
}

/**
 * Colour for a component state. Deliberately paired with a text label
 * everywhere it appears — a status page read by a colour-blind visitor, or
 * screenshotted in greyscale into a ticket, must still say what it means.
 */
function stateColor(state: StatusComponentState): string {
  switch (state) {
    case "operational":
      return "bg-emerald-500";
    case "degraded":
      return "bg-amber-500";
    case "down":
      return "bg-red-500";
    case "unknown":
      return "bg-neutral-400";
  }
}

function pageAccent(state: StatusPageState): { bar: string; text: string } {
  switch (state) {
    case "operational":
      return { bar: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" };
    case "degraded":
      return { bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" };
    case "major_outage":
      return { bar: "bg-red-500", text: "text-red-600 dark:text-red-400" };
    case "unknown":
      return { bar: "bg-neutral-400", text: "text-neutral-500" };
  }
}

/**
 * One day's uptime bar.
 *
 * A `null` day is grey, not green: the page has no evidence for it, and a
 * status page that renders "no data" as "fine" is worse than one that renders
 * nothing. The thresholds below are the usual reading — a day with any
 * meaningful downtime is not a green day.
 */
function dayColor(day: StatusHistoryDay): string {
  if (day.uptime === null) return "bg-neutral-200 dark:bg-neutral-700";
  if (day.uptime >= 0.999) return "bg-emerald-500";
  if (day.uptime >= 0.99) return "bg-amber-500";
  return "bg-red-500";
}

function dayTitle(day: StatusHistoryDay): string {
  if (day.uptime === null) return `${day.day} — no data`;
  return `${day.day} — ${formatUptime(day.uptime)} uptime`;
}

function ComponentRow({
  component,
  showUptime,
}: {
  component: PublicStatusComponent;
  showUptime: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-on-surface">{component.name}</span>
        <span className="flex items-center gap-2 text-xs">
          {showUptime && component.uptime24h !== null && (
            <span className="text-on-surface-faint">{formatUptime(component.uptime24h)} 24h</span>
          )}
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${stateColor(component.state)}`}
          />
          <span className="text-on-surface-secondary">{statusComponentLabel(component.state)}</span>
        </span>
      </div>
      {component.history.length > 0 && (
        <>
          {/* The bars are decoration over a fact already stated in text above,
              so they are hidden from assistive tech rather than read out as 90
              unlabelled cells. */}
          <div aria-hidden="true" className="flex gap-[2px]">
            {component.history.map((day) => (
              <span
                key={day.day}
                title={dayTitle(day)}
                className={`h-6 flex-1 rounded-[1px] ${dayColor(day)}`}
              />
            ))}
          </div>
          <div
            aria-hidden="true"
            className="flex justify-between text-[10px] text-on-surface-faint"
          >
            <span>{component.history.length} days ago</span>
            <span>Today</span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The public status page, as visitors see it.
 *
 * It lives in `@infrawrench/ui` rather than in the web app so the editor can
 * render a true preview from the same component — a preview drawn by different
 * code is a preview that eventually lies.
 *
 * Everything rendered here comes from the public payload, which carries no org
 * identifiers, probe URLs or error detail (see `status-pages/store.ts`). The
 * component cannot leak what it is never given.
 */
export function PublicStatusPageView({ page }: PublicStatusPageViewProps) {
  const accent = pageAccent(page.state);
  const groups = groupStatusComponents(page.components);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold text-on-surface">{page.title}</h1>
        {page.description && (
          <p className="text-sm text-on-surface-secondary">{page.description}</p>
        )}
      </header>

      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised px-4 py-3">
        <span aria-hidden="true" className={`h-3 w-3 rounded-full ${accent.bar}`} />
        <span className={`text-sm font-medium ${accent.text}`}>{page.summary}</span>
      </div>

      {page.components.length === 0 ? (
        <p className="text-sm text-on-surface-faint">
          No components are being published on this page yet.
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.groupName ?? "__ungrouped"} className="flex flex-col gap-2">
            {group.groupName && (
              <h2 className="text-xs font-semibold uppercase tracking-wide text-on-surface-tertiary">
                {group.groupName}
              </h2>
            )}
            <div className="overflow-hidden rounded-xl border border-border">
              {group.components.map((component) => (
                <ComponentRow
                  key={component.id}
                  component={component}
                  showUptime={page.showUptime}
                />
              ))}
            </div>
          </section>
        ))
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 text-xs text-on-surface-faint">
        <span>
          Updated{" "}
          <time dateTime={page.generatedAt}>{new Date(page.generatedAt).toLocaleString()}</time>
        </span>
        {page.supportUrl && (
          <a
            href={page.supportUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline hover:text-on-surface"
          >
            Contact support
          </a>
        )}
      </footer>
    </div>
  );
}
