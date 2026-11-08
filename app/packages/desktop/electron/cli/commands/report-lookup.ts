// A saved cost report by name or id, for every command that takes one:
// `reports <name|id>`, `costs forecast <report>`, `export --format focus
// <report>`. Its own module so those commands share one lookup and one set of
// sentences without importing each other.
import { Effect, Schema } from "effect";
import type { CostReport } from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import { decodePaired, type Paired, wire } from "../effect/wire";
import { matchCostReport } from "../format";

export const REPORTS_PATH = "/cost-reports";

/** What a lookup reads; a command that renders more decodes `raw` with its own schema. */
const ReportRefs = wire<CostReport[]>()(
  Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
);

export type ReportRef = Paired<(typeof ReportRefs.Type)[number]>;

const noMatch = (query: string, candidates: ReadonlyArray<{ name: string }>) =>
  new CliFailure({
    message:
      candidates.length === 0
        ? `No cost report matches "${query}". Run \`infrawrench reports\` to see the saved ones.`
        : `"${query}" matches ${candidates.length} reports: ${candidates
            .map((r) => r.name)
            .join(", ")}. Use the full name or the id.`,
  });

/**
 * A name/id query to exactly one report, beside the element the server sent
 * (which `--json` prints, and a command that reads more decodes): an id, then
 * an exact name, then a unique part of a name. Nothing, or several, is a
 * failure naming them.
 */
export const resolveReport = Effect.fnUntraced(function* (orgId: string, query: string) {
  const api = yield* CloudApi;
  const reports = yield* decodePaired(
    ReportRefs,
    REPORTS_PATH,
  )(yield* api.json(orgId, REPORTS_PATH));
  const found = matchCostReport(
    reports.map((r) => ({ id: r.row.id, name: r.row.name, paired: r })),
    query,
  );
  if (found.match) return found.match.paired;
  return yield* noMatch(query, found.candidates);
});
