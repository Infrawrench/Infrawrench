import { T, Var, useGT } from "gt-react";
import {
  blastRadiusReferenceLabel,
  dependencyEdgeLabel,
  formatFlowBytes,
  type BlastRadiusDependant,
  type BlastRadiusFlowPeer,
  type BlastRadiusReference,
  type BlastRadiusReport,
} from "@infrawrench/client-core";
import { useBlastRadius } from "./useBlastRadius.js";
import type { BlastRadiusClient, OpenBlastRadiusResource } from "./types.js";

interface BlastRadiusPanelProps {
  client: BlastRadiusClient;
  resourceId: string;
  /** Open a dependant's resource page, when the host can navigate to one. */
  onOpenResource?: OpenBlastRadiusResource;
}

/**
 * The full impact report — the "Blast radius" tab on resource detail.
 *
 * The same report the delete dialog shows, at length: every dependant listed
 * and linked, every soft reference named, measured traffic itemized, and the
 * gaps spelled out at the bottom rather than tucked behind a tooltip. Somebody
 * reads this *before* they open the delete dialog, which is the point — the
 * dialog is where you find out, this is where you plan.
 */
export function BlastRadiusPanel({ client, resourceId, onOpenResource }: BlastRadiusPanelProps) {
  const gt = useGT();
  const { report, loading, error } = useBlastRadius(client, resourceId);

  if (loading) {
    return (
      <p className="p-6 text-sm text-on-surface-muted">{gt("Working out what depends on this…")}</p>
    );
  }
  if (error || !report) {
    return (
      <div className="p-6">
        <T>
          <p className="text-sm text-on-surface-secondary">
            Couldn&apos;t work out this resource&apos;s blast radius.
          </p>
        </T>
        <p className="mt-1 text-xs text-on-surface-faint">
          {error ?? gt("The impact report is unavailable.")}
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <section aria-label={gt("Summary")}>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
          {gt("If this is deleted")}
        </h3>
        <p className="mt-1 text-sm text-on-surface">{report.headline}</p>
        <T>
          <p className="mt-0.5 text-xs text-on-surface-faint">
            <Var>{report.directCount}</Var> direct, <Var>{report.transitiveCount}</Var> further down
            the chain, <Var>{report.references.length}</Var> other reference
            <Var>{report.references.length === 1 ? "" : "s"}</Var>.
          </p>
        </T>
      </section>

      <DependantList
        dependants={report.dependants}
        {...(onOpenResource ? { onOpenResource } : {})}
      />
      <ReferenceList references={report.references} />
      <FlowList report={report} />
      <GapList report={report} />
    </div>
  );
}

function DependantList({
  dependants,
  onOpenResource,
}: {
  dependants: BlastRadiusDependant[];
  onOpenResource?: OpenBlastRadiusResource;
}) {
  const gt = useGT();
  return (
    <section aria-label={gt("Dependants")}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
        {gt("Resources that depend on this")}
      </h3>
      {dependants.length === 0 ? (
        <T>
          <p className="mt-2 text-sm text-on-surface-muted">
            No other resource in this organization points at it.
          </p>
        </T>
      ) : (
        <ul className="mt-3 space-y-2">
          {dependants.map((d) => {
            const row = (
              <>
                <span
                  className="size-5 flex-shrink-0"
                  dangerouslySetInnerHTML={{ __html: d.node.pluginLogoSvg }}
                  aria-hidden
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-on-surface truncate">
                    {d.node.displayName}
                  </span>
                  <span className="block text-xs text-on-surface-muted truncate">
                    {d.node.resourceTypeLabel} · {d.node.accountName}
                  </span>
                </span>
                <span className="flex-shrink-0 flex items-center gap-2">
                  {d.via && (
                    <span className="text-xs text-on-surface-faint font-mono">
                      {dependencyEdgeLabel({
                        consumerFieldKey: d.via.fieldKey,
                        providerOutputKey: d.via.outputKey,
                        ...(d.via.kind ? { kind: d.via.kind } : {}),
                        ...(d.via.label ? { label: d.via.label } : {}),
                      })}
                    </span>
                  )}
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${
                      d.depth === 1
                        ? "bg-red-500/15 text-danger"
                        : "bg-surface-overlay text-on-surface-faint"
                    }`}
                  >
                    {d.depth === 1 ? gt("direct") : gt("{depth} hops", { depth: d.depth })}
                  </span>
                </span>
              </>
            );
            const className =
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-surface-raised text-left";
            return (
              <li key={d.node.id}>
                {onOpenResource ? (
                  <button
                    type="button"
                    onClick={() => onOpenResource(d.node)}
                    className={`${className} hover:border-border-strong transition-colors`}
                  >
                    {row}
                  </button>
                ) : (
                  <div className={className}>{row}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ReferenceList({ references }: { references: BlastRadiusReference[] }) {
  const gt = useGT();
  return (
    <section aria-label={gt("References")}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
        {gt("Things that point at it")}
      </h3>
      <T>
        <p className="text-xs text-on-surface-faint mt-0.5">
          These don&apos;t break — they quietly stop having anything to show.
        </p>
      </T>
      {references.length === 0 ? (
        <T>
          <p className="mt-2 text-sm text-on-surface-muted">
            Nothing charts, watches, schedules or claims this resource.
          </p>
        </T>
      ) : (
        <ul className="mt-3 space-y-2">
          {references.map((ref) => (
            <li
              key={`${ref.kind}:${ref.id}`}
              className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-surface-raised"
            >
              <span className="text-xs px-1.5 py-0.5 rounded bg-surface-overlay text-on-surface-muted flex-shrink-0">
                {blastRadiusReferenceLabel(ref.kind)}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-on-surface truncate">{ref.name}</span>
                {ref.detail && (
                  <span className="block text-xs text-on-surface-muted truncate">{ref.detail}</span>
                )}
              </span>
              {ref.userFacing && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/15 text-danger flex-shrink-0">
                  {gt("customer-visible")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FlowList({ report }: { report: BlastRadiusReport }) {
  const gt = useGT();
  return (
    <section aria-label={gt("Network traffic")}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
        {gt("What talks to it")}
      </h3>
      {report.flowTotals === null ? (
        <T>
          <p className="mt-2 text-sm text-on-surface-muted">
            Traffic wasn&apos;t measured — see what wasn&apos;t checked below.
          </p>
        </T>
      ) : report.flowPeers.length === 0 ? (
        <T>
          <p className="mt-2 text-sm text-on-surface-muted">
            No attributed traffic in the last 14 days.
          </p>
        </T>
      ) : (
        <>
          <T>
            <p className="text-xs text-on-surface-faint mt-0.5">
              <Var>{formatFlowBytes(report.flowTotals.bytes)}</Var> over the last 14 days. Volumes
              are estimates.
            </p>
          </T>
          <ul className="mt-3 space-y-2">
            {report.flowPeers.map((peer) => (
              <FlowRow key={`${peer.direction}:${peer.scope}:${peer.ref}`} peer={peer} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function FlowRow({ peer }: { peer: BlastRadiusFlowPeer }) {
  const gt = useGT();
  return (
    <li className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-surface-raised">
      <span className="text-xs px-1.5 py-0.5 rounded bg-surface-overlay text-on-surface-muted flex-shrink-0">
        {peer.direction === "egress" ? gt("to") : gt("from")}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-on-surface truncate">{peer.label}</span>
        <T>
          <span className="block text-xs text-on-surface-muted truncate">
            <Var>{peer.scope}</Var> · <Var>{peer.days}</Var> day
            <Var>{peer.days === 1 ? "" : "s"}</Var>
          </span>
        </T>
      </span>
      <span className="text-xs text-on-surface-faint font-mono flex-shrink-0">
        {formatFlowBytes(peer.bytes)}
      </span>
    </li>
  );
}

/**
 * The honesty section. Rendered even when the report found plenty, because a
 * long dependant list can still be missing the half nobody looked at.
 */
function GapList({ report }: { report: BlastRadiusReport }) {
  const gt = useGT();
  if (report.unchecked.length === 0) {
    return (
      <section aria-label={gt("Coverage")}>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
          {gt("What wasn't checked")}
        </h3>
        <p className="mt-2 text-sm text-on-surface-muted">
          {gt("Everything this report can look at was checked.")}
        </p>
      </section>
    );
  }
  return (
    <section aria-label={gt("Coverage")}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
        {gt("What wasn't checked")}
      </h3>
      <ul className="mt-2 space-y-1.5">
        {report.unchecked.map((gap, i) => (
          <li key={`${gap.kind}:${i}`} className="text-sm text-on-surface-muted">
            {gap.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}
