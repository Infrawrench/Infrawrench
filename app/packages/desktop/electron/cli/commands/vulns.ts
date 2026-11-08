// `infrawrench vulns`; known vulnerabilities (CVEs and other advisories) the
// connected providers' scanners report, joined to the synced resources that
// run the affected image, function or host right now, worst first.
//
// Cloud only. The findings are collected by the cloud poller from each
// provider's scanner and joined server-side (`GET /vulnerabilities`, the same
// endpoint the web + desktop Vulnerabilities screens render); this machine's
// workspace never collects them, so `--local` refuses rather than printing an
// empty list that reads as "no vulnerabilities".
//
// `vulns dismiss` / `vulns restore` accept and un-accept an advisory for one
// artifact (its `artifact.key`), or for every artifact (`*`).
//
// Each finding names the services its running resources belong to; the table
// prints them in a `service` column (when any finding has one) and
// `--service <id|slug|name>` narrows to one, resolved against `/services`;
// `--resource <id>` narrows to findings running on one resource.
//
// The response schemas are checked against `@infrawrench/client-core` by
// `wire`. The shared filter and the "3 Pods and 1 Lambda Function" phrasing
// are client-core's, reached through a dynamic `import()` (the CLI is CJS,
// client-core ESM) and handed a projection of each decoded row: an enum value
// this build does not know is replaced there by one the function reads the
// same way, and the rows it keeps are mapped back to what was decoded.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  ServiceListResponse,
  VulnerabilityFilter,
  VulnerabilityFindingRow,
  VulnerabilityListResponse,
  VulnerabilityRunningRef,
  VulnerabilitySeverity,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { limit, resource } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { reason } from "../effect/triage-flags";
import { knownOr, Unrecognized, wire } from "../effect/wire";
import {
  formatAgo,
  formatKevFreshness,
  formatVulnAdvisory,
  formatVulnArtifact,
  formatVulnCvss,
  formatVulnPackage,
  formatVulnServices,
  matchService,
  matchVulnAccount,
  parseVulnSeverityFlag,
  VULN_SEVERITIES,
} from "../format";
import { c, safe, type Column } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });
const loadCore = Effect.promise((): Promise<Core> => import("@infrawrench/client-core"));

const PATH = "/vulnerabilities";

/** Rows the text table shows without `--limit`; JSON is uncapped unless asked. */
const DEFAULT_TEXT_LIMIT = 50;

const Severity = knownOr(["critical", "high", "medium", "low", "unknown"]);

const RunningRef = Schema.Struct({
  resourceId: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String,
  resourceTypePluralName: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
  displayName: Schema.String,
  matchedBy: knownOr(["digest", "resource", "tag"]),
});
type RunningRef = typeof RunningRef.Type;

const findingFields = {
  key: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
  pluginId: Schema.String,
  pluginName: Schema.String,
  scanner: Schema.String,
  findingId: Schema.String,
  advisoryId: Schema.String,
  aliases: Schema.Array(Schema.String),
  title: Schema.NullOr(Schema.String),
  severity: Severity,
  cvssScore: Schema.NullOr(Schema.Finite),
  cvssVector: Schema.NullOr(Schema.String),
  packageName: Schema.NullOr(Schema.String),
  packageEcosystem: Schema.NullOr(Schema.String),
  installedVersion: Schema.NullOr(Schema.String),
  fixedVersion: Schema.NullOr(Schema.String),
  fixAvailable: Schema.NullOr(Schema.Boolean),
  exploitAvailable: Schema.NullOr(Schema.Boolean),
  kev: Schema.NullOr(
    Schema.Struct({
      dateAdded: Schema.String,
      dueDate: Schema.NullOr(Schema.String),
      knownRansomware: Schema.Boolean,
    }),
  ),
  artifact: Schema.Struct({
    kind: knownOr(["image", "function", "host", "repository", "package"]),
    name: Schema.String,
    digest: Schema.NullOr(Schema.String),
    tags: Schema.Array(Schema.String),
    resourceExternalId: Schema.NullOr(Schema.String),
    url: Schema.NullOr(Schema.String),
    key: Schema.String,
  }),
  firstSeenAt: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  collectedAt: Schema.String,
  running: Schema.Array(RunningRef),
  // Absent from older servers.
  services: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        slug: Schema.String,
        tier: Schema.NullOr(Schema.Finite),
      }),
    ),
  ),
};

const Finding = Schema.Struct(findingFields);
type Finding = typeof Finding.Type;

const Dismissed = Schema.Struct({
  ...findingFields,
  dismissal: Schema.Struct({
    advisoryId: Schema.String,
    artifactKey: Schema.String,
    dismissedAt: Schema.String,
    dismissedBy: Schema.NullOr(Schema.String),
    reason: Schema.NullOr(Schema.String),
  }),
});
type Dismissed = typeof Dismissed.Type;

const Source = Schema.Struct({
  accountId: Schema.String,
  accountName: Schema.String,
  pluginName: Schema.String,
  scanner: Schema.String,
  consoleUrl: Schema.NullOr(Schema.String),
  partial: Schema.Boolean,
  lastCollectedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  helpLabel: Schema.NullOr(Schema.String),
  helpUrl: Schema.NullOr(Schema.String),
  findingCount: Schema.Finite,
});
type Source = typeof Source.Type;

const Listing = wire<VulnerabilityListResponse>()(
  Schema.Struct({
    findings: Schema.Array(Finding),
    totalCount: Schema.Finite,
    counts: Schema.Record(Schema.String, Schema.Finite),
    runningCounts: Schema.Record(Schema.String, Schema.Finite),
    dismissed: Schema.Array(Dismissed),
    dismissedCount: Schema.Finite,
    sources: Schema.Array(Source),
    kevUpdatedAt: Schema.NullOr(Schema.String),
  }),
);
type Listing = typeof Listing.Type;

/** The listing's two arrays as the server sent them, paired with the decoded rows by index. */
const RawRows = Schema.Struct({
  findings: Schema.Array(Schema.Unknown),
  dismissed: Schema.Array(Schema.Unknown),
});

const SourcesEnvelope = Schema.Struct({ sources: Schema.Unknown, kevUpdatedAt: Schema.Unknown });

const Services = wire<ServiceListResponse>()(
  Schema.Struct({
    services: Schema.Array(
      Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
    ),
  }),
);

const SEVERITY_COLOR: Partial<Record<string, (s: string) => string>> = {
  critical: c.red,
  high: c.yellow,
  medium: (s) => s,
  low: c.dim,
  unknown: c.dim,
} satisfies Record<VulnerabilitySeverity, (s: string) => string>;

const SEVERITY_WORD: Partial<Record<string, string>> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  unknown: "unscored",
} satisfies Record<VulnerabilitySeverity, string>;

function colorSeverity(severity: Finding["severity"]): string {
  // A bucket this build does not know renders uncoloured, as its own word.
  if (severity instanceof Unrecognized) return safe(severity.raw);
  return (SEVERITY_COLOR[severity] ?? ((s: string) => s))(SEVERITY_WORD[severity] ?? severity);
}

/**
 * A decoded running reference as client-core's type. `matchedBy` is not read
 * by the phrasing it is handed to, so a kind this build does not know
 * stands in as `resource`.
 */
const toCoreRunning = (r: RunningRef): VulnerabilityRunningRef => ({
  ...r,
  matchedBy: r.matchedBy instanceof Unrecognized ? "resource" : r.matchedBy,
});

/**
 * A decoded row as client-core's type, for its filter. A severity this build
 * does not know filters as `unknown` (unscored: this build cannot rank it); an
 * artifact kind and a service tier are not read by the filter, so an unknown
 * kind stands in as `package` and an unknown tier as none.
 */
function toCoreRow(core: Core, r: Finding): VulnerabilityFindingRow {
  const { services, ...rest } = r;
  return {
    ...rest,
    aliases: [...r.aliases],
    severity: r.severity instanceof Unrecognized ? "unknown" : r.severity,
    artifact: {
      ...r.artifact,
      kind: r.artifact.kind instanceof Unrecognized ? "package" : r.artifact.kind,
      tags: [...r.artifact.tags],
    },
    running: r.running.map(toCoreRunning),
    ...(services === undefined
      ? {}
      : {
          services: services.map((s) => ({
            ...s,
            tier: core.isServiceTier(s.tier) ? s.tier : null,
          })),
        }),
  };
}

/**
 * `rows` filtered by client-core's `filterVulnerabilityFindings`, each kept
 * row beside the element the server sent (what `--json` prints).
 */
function filterRows<R extends Finding>(
  core: Core,
  rows: ReadonlyArray<R>,
  raw: ReadonlyArray<unknown>,
  filter: VulnerabilityFilter,
): Array<{ row: R; raw: unknown }> {
  const projected = rows.map((r) => toCoreRow(core, r));
  const index = new Map(projected.map((p, i) => [p, i]));
  return core.filterVulnerabilityFindings(projected, filter).flatMap((p) => {
    const i = index.get(p);
    const row = i === undefined ? undefined : rows[i];
    return i === undefined || row === undefined ? [] : [{ row, raw: raw[i] }];
  });
}

const refuseLocal = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliUsageError({
      message:
        "`vulns` is cloud-only: vulnerability findings are collected from each provider's scanner by the Infrawrench Cloud poller, not by this machine. Drop --local, or pass --org <id|name>.",
    });
  }
});

/** "2 critical (1 running) · 5 high (5 running)": the whole feed, every severity present. */
function countsSummary(response: Listing): string {
  const parts: string[] = [];
  for (const sev of VULN_SEVERITIES) {
    const total = response.counts[sev] ?? 0;
    if (total === 0) continue;
    const running = response.runningCounts[sev] ?? 0;
    parts.push(
      `${(SEVERITY_COLOR[sev] ?? ((s: string) => s))(`${total} ${SEVERITY_WORD[sev]}`)} ${c.dim(
        `(${running} running)`,
      )}`,
    );
  }
  return parts.join(c.dim(" · "));
}

interface ListFlags {
  readonly severity: Option.Option<string>;
  readonly running: boolean;
  readonly notRunning: boolean;
  readonly fixAvailable: boolean;
  readonly kev: boolean;
  readonly plugin: Option.Option<string>;
  readonly search: Option.Option<string>;
  readonly includeDismissed: boolean;
  readonly service: Option.Option<string>;
  readonly limit: Option.Option<number>;
  readonly resource: Option.Option<string>;
}

/** Validate the flags into the shared filter; `--account` resolves against the feed's sources. */
const buildFilter = Effect.fnUntraced(function* (flags: ListFlags, response: Listing) {
  const session = yield* CliSession;
  const filter: VulnerabilityFilter = {
    running: flags.running ? true : flags.notRunning ? false : undefined,
    fixAvailable: flags.fixAvailable || undefined,
    kev: flags.kev || undefined,
    pluginId: Option.getOrUndefined(flags.plugin),
    search: Option.getOrUndefined(flags.search),
  };
  if (Option.isSome(flags.severity)) {
    const { severities, invalid } = parseVulnSeverityFlag(flags.severity.value);
    const known = severities.flatMap((s) => {
      const match = VULN_SEVERITIES.find((v) => v === s);
      return match === undefined ? [] : [match];
    });
    if (invalid.length > 0 || known.length === 0) {
      return yield* new CliUsageError({
        message: `--severity takes a comma-separated list of ${VULN_SEVERITIES.join(", ")}${
          invalid.length > 0 ? ` (got "${invalid.join('", "')}")` : ""
        }.`,
      });
    }
    filter.severities = known;
  }
  if (session.account) {
    const accountId = matchVulnAccount(response.sources, session.account);
    if (!accountId) {
      const names = response.sources.map((s) => `  ${s.accountId}  ${safe(s.accountName)}`);
      return yield* new CliUsageError({
        message:
          `No vulnerability-reporting account matches "${session.account}".` +
          (names.length > 0 ? `\nAccounts with a scanner:\n${names.join("\n")}` : ""),
      });
    }
    filter.accountId = accountId;
  }
  return filter;
});

function isFiltered(filter: VulnerabilityFilter): boolean {
  return Object.values(filter).some((v) => v !== undefined);
}

/** Resolve `--service` against the org's services (not the feed's, so a clean service reads as clean). */
const resolveServiceFilter = Effect.fnUntraced(function* (orgId: string, query: string) {
  const api = yield* CloudApi;
  const { services } = yield* api.decode(Services, orgId, "/services");
  const found = matchService(services, query);
  if (found.match) return found.match.id;
  return yield* new CliUsageError({
    message:
      found.candidates.length > 1
        ? `"${query}" matches ${found.candidates.length} services: ${found.candidates
            .map((s) => safe(s.slug))
            .join(", ")}. Use the slug.`
        : `No service matches "${query}". Run \`infrawrench services\` to list.`,
  });
});

const listFlags = {
  severity: Flag.String("severity").pipe(
    Flag.withMetavar("list"),
    Flag.withDescription("Comma-separated: critical, high, medium, low, unscored"),
    Flag.optional,
  ),
  running: Flag.Boolean("running").pipe(
    Flag.withDescription("Only findings whose artifact is running"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  notRunning: Flag.Boolean("not-running").pipe(
    Flag.withDescription("Only findings whose artifact is not running"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  fixAvailable: Flag.Boolean("fix-available").pipe(
    Flag.withDescription("Only findings the scanner names a fixed version for"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  kev: Flag.Boolean("kev").pipe(
    Flag.withDescription("Only advisories in the CISA Known Exploited Vulnerabilities catalog"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  plugin: Flag.String("plugin").pipe(
    Flag.withMetavar("id"),
    Flag.withDescription("Only findings this plugin reported"),
    Flag.optional,
  ),
  search: Flag.String("search").pipe(
    Flag.withMetavar("text"),
    Flag.withDescription("Substring over advisory, aliases, package, artifact and title"),
    Flag.optional,
  ),
  includeDismissed: Flag.Boolean("include-dismissed").pipe(
    Flag.withDescription("Also list the findings dismissed as accepted risks"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  service: Flag.String("service").pipe(
    Flag.withMetavar("id|slug|name"),
    Flag.withDescription("Only findings running on a resource of this service"),
    Flag.optional,
  ),
  limit: limit.pipe(Flag.withDescription("Rows to list (text default 50; --json uncapped)")),
  resource: resource.pipe(Flag.withDescription("Only findings running on this resource")),
};

/** Scanner accounts whose last collection failed: a silent gap reads as "clean". */
const printSourceErrors = Effect.fnUntraced(function* (sources: ReadonlyArray<Source>) {
  const failing = sources.filter((s) => s.error);
  if (failing.length === 0) return;
  yield* Print.line();
  yield* Print.line(
    c.yellow(
      `${failing.length} scanner${failing.length === 1 ? "" : "s"} failed on the last collection; their findings may be stale or missing:`,
    ),
  );
  for (const s of failing) {
    yield* Print.line(
      `  ${safe(s.accountName)} ${c.dim(`(${safe(s.pluginName)} · ${safe(s.scanner)})`)}: ${c.red(
        safe(s.error),
      )}`,
    );
    if (s.helpUrl) {
      yield* Print.line(`    ${c.dim(`${safe(s.helpLabel) || "Help"}: ${safe(s.helpUrl)}`)}`);
    }
  }
});

/**
 * The accepted risks, listed rather than hidden: a silenced finding nobody can
 * see is worse than a noisy one. Never colored by severity: these are
 * decisions, not alarms.
 */
const printDismissed = Effect.fnUntraced(function* (dismissed: ReadonlyArray<Dismissed>) {
  yield* Print.line();
  yield* Print.line(
    `${c.bold("Dismissed")} ${c.dim(
      `· ${dismissed.length} accepted risk${dismissed.length === 1 ? "" : "s"}`,
    )}`,
  );
  yield* Print.line();
  yield* Print.table(dismissed, [
    { header: "advisory", value: (r) => c.dim(safe(r.advisoryId)) },
    { header: "artifact", value: (r) => c.dim(formatVulnArtifact(r.artifact)) },
    {
      header: "scope",
      value: (r) => c.dim(r.dismissal.artifactKey === "*" ? "everywhere" : "this artifact"),
    },
    {
      header: "accepted",
      value: (r) =>
        c.dim(
          [r.dismissal.dismissedAt.slice(0, 10), r.dismissal.dismissedBy, r.dismissal.reason]
            .filter(Boolean)
            .map((s) => safe(s))
            .join(" · "),
        ),
    },
  ]);
  yield* Print.line();
  yield* Print.line(c.dim("Undo with `infrawrench vulns restore <advisoryId> <artifactKey|*>`."));
});

/** `infrawrench vulns [list]`. */
const listVulns = Effect.fn("vulns.list")(function* (flags: ListFlags) {
  if (flags.running && flags.notRunning) {
    return yield* new CliUsageError({
      message: "--running and --not-running are mutually exclusive",
    });
  }
  yield* refuseLocal;
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, PATH);
  const response = yield* decodeBody(Listing, PATH)(body);
  const filter = yield* buildFilter(flags, response);
  if (Option.isSome(flags.service)) {
    filter.serviceId = yield* resolveServiceFilter(org.id, flags.service.value);
  }
  if (Option.isSome(flags.resource) && flags.resource.value) {
    filter.resourceIds = [flags.resource.value];
  }
  const core = yield* loadCore;
  const raw = yield* decodeBody(RawRows, PATH)(body);

  const matched = filterRows(core, response.findings, raw.findings, filter);
  const dismissed = flags.includeDismissed
    ? filterRows(core, response.dismissed, raw.dismissed, filter)
    : [];

  if (session.output === "json") {
    const cap = Option.getOrUndefined(flags.limit);
    // The response object, filtered: counts, runningCounts, dismissedCount and
    // sources still describe the whole feed so a script can tell a quiet
    // filter from a clean org. `matchedCount` is the filtered length.
    const object = yield* decodeBody(Schema.Record(Schema.String, Schema.Unknown), PATH)(body);
    return yield* Print.json({
      org: org.id,
      ...object,
      findings: (cap ? matched.slice(0, cap) : matched).map((m) => m.raw),
      matchedCount: matched.length,
      dismissed: (cap ? dismissed.slice(0, cap) : dismissed).map((m) => m.raw),
    });
  }

  const cap = Option.getOrElse(flags.limit, () => DEFAULT_TEXT_LIMIT);

  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim(
      `· ${response.totalCount} open finding${response.totalCount === 1 ? "" : "s"}`,
    )}  ${countsSummary(response)}`,
  );
  yield* Print.line(formatKevFreshness(response.kevUpdatedAt));
  yield* Print.line();

  if (response.sources.length === 0) {
    return yield* Print.line(
      c.dim(
        "No connected account reports vulnerabilities yet. Findings appear when a provider with a scanner (container registry scanning, a cloud security center, Dependabot, an artifact scanner) is connected and enabled.",
      ),
    );
  }

  if (matched.length === 0) {
    yield* Print.line(
      c.dim(
        isFiltered(filter)
          ? "No findings match those filters."
          : response.dismissedCount > 0
            ? "No open findings. Everything currently reported has been dismissed as an accepted risk."
            : "No open findings. The connected scanners report nothing.",
      ),
    );
  } else {
    if (isFiltered(filter)) {
      yield* Print.line(c.dim(`${matched.length} of ${response.totalCount} match the filters.`));
      yield* Print.line();
    }
    // The contract serves findings worst first (severity, running, KEV, CVSS);
    // the table keeps that order.
    const shown = matched.slice(0, cap).map((m) => m.row);
    const columns: Column<Finding>[] = [
      { header: "severity", value: (r) => colorSeverity(r.severity) },
      { header: "advisory", value: (r) => formatVulnAdvisory(r) },
      { header: "cvss", value: (r) => formatVulnCvss(r.cvssScore), align: "right" },
      { header: "package", value: (r) => formatVulnPackage(r) },
      { header: "artifact", value: (r) => c.dim(formatVulnArtifact(r.artifact)) },
      {
        header: "running",
        value: (r) =>
          r.running.length > 0
            ? core.describeRunning(r.running.map(toCoreRunning))
            : c.dim("not running"),
      },
    ];
    // Only when something is in a service: a column of dashes says nothing.
    if (shown.some((r) => (r.services ?? []).length > 0)) {
      columns.push({ header: "service", value: (r) => formatVulnServices(r.services) });
    }
    yield* Print.table(shown, columns);
    if (matched.length > shown.length) {
      yield* Print.line();
      yield* Print.line(
        c.dim(
          `${matched.length - shown.length} more not shown. Raise --limit, narrow with --severity / --running / --kev / --service, or use --json.`,
        ),
      );
    }
  }

  if (flags.includeDismissed && dismissed.length > 0) {
    yield* printDismissed(dismissed.slice(0, cap).map((m) => m.row));
  } else if (response.dismissedCount > 0 && !flags.includeDismissed) {
    yield* Print.line();
    yield* Print.line(
      c.dim(
        `${response.dismissedCount} dismissed as accepted risk${
          response.dismissedCount === 1 ? "" : "s"
        }; list them with --include-dismissed.`,
      ),
    );
  }

  yield* printSourceErrors(response.sources);

  yield* Print.line();
  yield* Print.line(
    c.dim(
      "Collected from each provider's scanner by the cloud poller and joined to synced resources. `infrawrench vulns sources` lists the scanners; dismiss with `vulns dismiss <advisoryId> <artifactKey|*>`.",
    ),
  );
});

const list = Command.make("list", listFlags, listVulns).pipe(
  Command.withDescription("Known vulnerabilities on what is running, worst first"),
);

const target = {
  advisoryId: Argument.String("advisoryId").pipe(
    Argument.withDescription("The advisory, e.g. CVE-2024-3094"),
    Argument.optional,
  ),
  artifactKey: Argument.String("artifactKey|*").pipe(
    Argument.withDescription(
      "The artifact (each finding's `artifact.key` in --json), or * for everywhere (quote it)",
    ),
    Argument.optional,
  ),
};

/** The advisory + artifact a dismiss/restore names. */
const requireTarget = (
  verb: string,
  input: {
    readonly advisoryId: Option.Option<string>;
    readonly artifactKey: Option.Option<string>;
  },
) => {
  const advisoryId = Option.getOrElse(input.advisoryId, () => "").trim();
  const artifactKey = Option.getOrElse(input.artifactKey, () => "").trim();
  if (!advisoryId || !artifactKey) {
    return Effect.fail(
      new CliUsageError({
        message:
          `Usage: infrawrench vulns ${verb} <advisoryId> <artifactKey|"*">${
            verb === "dismiss" ? " [--reason <text>]" : ""
          }\n` +
          "The artifact key is each finding's `artifact.key` in `infrawrench vulns --json`; quote `*` " +
          "(the advisory everywhere in the organization) so the shell does not expand it.",
      }),
    );
  }
  return Effect.succeed({ advisoryId, artifactKey });
};

const Dismissal = Schema.Struct({ advisoryId: Schema.String, artifactKey: Schema.String });

/** `infrawrench vulns dismiss <advisoryId> <artifactKey|*> [--reason ...]`. */
const dismiss = Command.make(
  "dismiss",
  { ...target, reason: reason({ description: "Why the advisory is an accepted risk" }) },
  Effect.fn("vulns.dismiss")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const { advisoryId, artifactKey } = yield* requireTarget("dismiss", input);
    const org = yield* currentOrg;
    const path = "/vulnerabilities/dismissals";
    const body = yield* api.json(org.id, path, {
      method: "POST",
      body: JSON.stringify({ advisoryId, artifactKey, reason: Option.getOrNull(input.reason) }),
    });
    if (session.output === "json") return yield* Print.json({ org: org.id, dismissed: body });
    const dismissal = yield* decodeBody(Dismissal, path)(body);
    yield* Print.line(
      `${c.bold("Dismissed")} ${safe(dismissal.advisoryId)} ${c.dim(
        `· ${dismissal.artifactKey === "*" ? "everywhere" : safe(dismissal.artifactKey)}`,
      )}`,
    );
    yield* Print.line(
      c.dim(
        `Accepted for ${safe(org.displayName)}. It leaves the vulnerability list and the alerts until \`vulns restore\`.`,
      ),
    );
  }),
).pipe(Command.withDescription("Accept an advisory for one artifact, or everywhere (*)"));

/** `infrawrench vulns restore <advisoryId> <artifactKey|*>`. */
const restore = Command.make(
  "restore",
  target,
  Effect.fn("vulns.restore")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const { advisoryId, artifactKey } = yield* requireTarget("restore", input);
    const org = yield* currentOrg;
    const query = new URLSearchParams({ advisoryId, artifactKey });
    yield* api.json(org.id, `/vulnerabilities/dismissals?${query.toString()}`, {
      method: "DELETE",
    });
    if (session.output === "json") {
      return yield* Print.json({
        org: org.id,
        restored: { advisoryId: advisoryId.toUpperCase(), artifactKey },
      });
    }
    yield* Print.line(
      `${c.bold("Restored")} ${safe(advisoryId.toUpperCase())} ${c.dim(
        `· ${artifactKey === "*" ? "everywhere" : safe(artifactKey)}`,
      )}`,
    );
    yield* Print.line(c.dim("Back on the vulnerability list and in the alerts."));
  }),
).pipe(Command.withDescription("Put a dismissed advisory back on the list"));

/** `infrawrench vulns sources`: which accounts report findings, and whether collection works. */
const sources = Command.make(
  "sources",
  {},
  Effect.fn("vulns.sources")(function* () {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);
    if (session.output === "json") {
      const raw = yield* decodeBody(SourcesEnvelope, PATH)(body);
      return yield* Print.json({
        org: org.id,
        sources: raw.sources,
        kevUpdatedAt: raw.kevUpdatedAt,
      });
    }
    const response = yield* decodeBody(Listing, PATH)(body);
    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(
        `· ${response.sources.length} scanner account${response.sources.length === 1 ? "" : "s"}`,
      )}`,
    );
    yield* Print.line(formatKevFreshness(response.kevUpdatedAt));
    yield* Print.line();
    if (response.sources.length === 0) {
      return yield* Print.line(
        c.dim(
          "No connected account reports vulnerabilities yet. Connect a provider whose scanner Infrawrench reads (container registry scanning, a cloud security center, Dependabot, an artifact scanner).",
        ),
      );
    }
    yield* Print.table(response.sources, [
      { header: "account", value: (s) => safe(s.accountName) },
      { header: "provider", value: (s) => c.dim(safe(s.pluginName)) },
      { header: "scanner", value: (s) => safe(s.scanner) },
      { header: "findings", value: (s) => String(s.findingCount), align: "right" },
      {
        header: "collected",
        value: (s) => (s.lastCollectedAt ? c.dim(formatAgo(s.lastCollectedAt)) : c.dim("never")),
      },
      {
        header: "status",
        value: (s) =>
          s.error
            ? c.red("error")
            : s.lastCollectedAt
              ? s.partial
                ? c.yellow("ok (partial)")
                : c.green("ok")
              : c.dim("pending"),
      },
    ]);

    const detailed = response.sources.filter((s) => s.error || s.helpUrl || s.consoleUrl);
    if (detailed.length > 0) {
      yield* Print.line();
      for (const s of detailed) {
        yield* Print.line(`${c.bold(safe(s.accountName))} ${c.dim(`· ${safe(s.scanner)}`)}`);
        if (s.error) yield* Print.line(`  ${c.red(safe(s.error))}`);
        if (s.helpUrl) {
          yield* Print.line(`  ${c.dim(`${safe(s.helpLabel) || "Help"}:`)} ${safe(s.helpUrl)}`);
        }
        if (s.consoleUrl) yield* Print.line(`  ${c.dim("Console:")} ${safe(s.consoleUrl)}`);
      }
    }
    if (response.sources.some((s) => s.partial)) {
      yield* Print.line();
      yield* Print.line(
        c.dim("Partial: the provider's API returns a bounded subset of its findings."),
      );
    }
  }),
).pipe(Command.withDescription("Which accounts report findings, and whether collection works"));

export const vulns = Command.make("vulns", listFlags, listVulns).pipe(
  Command.withAlias("vulnerabilities"),
  Command.withDescription(
    "Known vulnerabilities joined to what is running: severity, CVSS, KEV, package, artifact",
  ),
  Command.withSubcommands([list, dismiss, restore, sources]),
);
