/**
 * Everything about AWS VPC Flow Logs that can be decided without a network
 * call: which record format a flow log uses, whether that format is usable,
 * what CloudWatch Logs Insights query reads it, and which billing boundary a
 * grouped result crossed.
 *
 * It is split out from `network-flows.ts` because all of it is a pure function
 * of provider metadata, and the interesting failure modes here — a flow log in
 * the default format, a `traffic-path` we misread, a `parse` pattern that
 * silently shifts every field by one — are exactly the ones that are cheap to
 * test and expensive to discover in production.
 *
 * Reference: VPC Flow Logs record fields, versions 2–11.
 * https://docs.aws.amazon.com/vpc/latest/userguide/flow-log-records.html
 */

/**
 * The fields a flow log must carry for its records to be attributable at all.
 *
 * `srcaddr`/`dstaddr` are the only identity in a record; `bytes` is the
 * quantity; `flow-direction` is what makes a record's local side knowable, and
 * without it the same bytes cannot be told from their mirror image at the other
 * end of the conversation.
 *
 * **The default record format has none of the optional fields and no
 * `flow-direction`** — it is version 2, and `flow-direction` arrived in version
 * 5. So a flow log created without an explicit custom format cannot be used
 * here, and the honest thing to do about that is say so with the fix rather
 * than quietly produce a screen of zeroes.
 */
export const REQUIRED_FLOW_FIELDS = ["srcaddr", "dstaddr", "bytes", "flow-direction"] as const;

/**
 * Fields we read when present. Everything here improves the answer and nothing
 * here is required — a flow log carrying only the required four still produces
 * pairs, just with more of them landing in `unknown`.
 */
export const OPTIONAL_FLOW_FIELDS = [
  "packets",
  "az-id",
  "next-hop-az-id",
  "traffic-path",
  "pkt-src-aws-service",
  "pkt-dst-aws-service",
  "interface-type",
  "instance-id",
  "interface-id",
  "log-status",
  "region",
  "vpc-id",
  "subnet-id",
] as const;

const DOCS_URL = "https://docs.aws.amazon.com/vpc/latest/userguide/flow-log-records.html";

/**
 * The field names in a flow log's record format, in record order.
 *
 * `DescribeFlowLogs` returns `LogFormat` as the literal template string the log
 * was created with — `"${version} ${account-id} ${interface-id} …"` — or an
 * empty string for a log using the default format. An empty/absent format is
 * reported as the version-2 default, which is what it is, so the caller can
 * explain precisely which fields are missing.
 */
export function parseLogFormat(logFormat: string | undefined): string[] {
  const trimmed = (logFormat ?? "").trim();
  if (!trimmed) return [...DEFAULT_FORMAT_FIELDS];
  const fields: string[] = [];
  const re = /\$\{([a-z0-9-]+)\}/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(trimmed)) !== null) fields.push(match[1]!.toLowerCase());
  return fields.length > 0 ? fields : [...DEFAULT_FORMAT_FIELDS];
}

/** The version-2 default format, in order. */
export const DEFAULT_FORMAT_FIELDS = [
  "version",
  "account-id",
  "interface-id",
  "srcaddr",
  "dstaddr",
  "srcport",
  "dstport",
  "protocol",
  "packets",
  "bytes",
  "start",
  "end",
  "action",
  "log-status",
] as const;

/** Which required fields a format is missing. Empty means usable. */
export function missingRequiredFields(fields: string[]): string[] {
  const present = new Set(fields);
  return REQUIRED_FLOW_FIELDS.filter((f) => !present.has(f));
}

/** The user-facing explanation and fix for an unusable flow log. */
export function unusableReason(flowLogId: string, missing: string[]): string {
  return (
    `Flow log ${flowLogId} does not record ${missing.join(", ")}. ` +
    `The default record format is version 2 and has no direction or zone fields, so its ` +
    `records cannot be attributed to a pair. Recreate the flow log with a custom format ` +
    `including at least ${REQUIRED_FLOW_FIELDS.join(", ")} — and ideally az-id, ` +
    `instance-id, traffic-path, interface-type and pkt-dst-aws-service, which is what ` +
    `turns "an address" into "a resource".`
  );
}

export const FLOW_FORMAT_HELP_URL = DOCS_URL;

/**
 * A CloudWatch Logs Insights identifier for a flow-log field.
 *
 * Insights field names cannot contain `-`, and a hyphenated name in a `parse …
 * as` list is a syntax error rather than a runtime one, so this is the only
 * place the mapping should exist.
 */
export function insightsAlias(field: string): string {
  return field.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/-/g, "");
}

/**
 * The `parse` clause that turns a raw flow-log line into named fields.
 *
 * Every field in the format gets a `*` and a name, including the ones we do not
 * read: the glob is positional, so skipping a field would shift every field
 * after it by one and produce a query that runs, returns numbers, and is
 * entirely wrong. That failure is silent, which is why this is generated from
 * the provider's own `LogFormat` rather than assumed.
 */
export function buildParseClause(fields: string[]): string {
  const pattern = fields.map(() => "*").join(" ");
  const names = fields.map(insightsAlias).join(", ");
  return `parse @message "${pattern}" as ${names}`;
}

/** Fields we group by, restricted to the ones this format actually carries. */
function groupFields(fields: string[]): string[] {
  const present = new Set(fields);
  return [
    "az-id",
    "next-hop-az-id",
    "traffic-path",
    "pkt-src-aws-service",
    "pkt-dst-aws-service",
    "interface-type",
  ]
    .filter((f) => present.has(f))
    .map(insightsAlias);
}

/** `filter` clauses shared by both queries. */
function filterClauses(fields: string[]): string[] {
  const present = new Set(fields);
  const clauses: string[] = [];
  // NODATA rows carry no bytes and SKIPDATA rows are AWS telling us records
  // were lost; including either inflates the group count without adding bytes.
  if (present.has("log-status")) clauses.push(`filter ${insightsAlias("log-status")} = "OK"`);
  // A rejected packet was dropped at the security group or NACL. It never
  // crossed a billing boundary, so counting it would put money on traffic that
  // did not happen.
  if (present.has("action")) clauses.push(`filter ${insightsAlias("action")} = "ACCEPT"`);
  clauses.push(`filter ${insightsAlias("bytes")} > 0`);
  return clauses;
}

/**
 * The pair query: top pairs for one day, aggregated **inside CloudWatch**.
 *
 * Addresses appear in the grouping here and nowhere afterwards. They are the
 * only join key a flow record offers, so the group must be keyed on them — but
 * they are also unbounded cardinality and churn daily, so the caller resolves
 * them to resource references before anything is stored. That resolution is the
 * line between a table that stays small and one that grows with the DHCP lease
 * time.
 */
export function buildPairQuery(fields: string[], limit: number): string {
  const src = insightsAlias("srcaddr");
  const dst = insightsAlias("dstaddr");
  const bytes = insightsAlias("bytes");
  const direction = insightsAlias("flow-direction");
  const present = new Set(fields);
  const packets = present.has("packets") ? `, sum(${insightsAlias("packets")}) as flowPackets` : "";
  const by = [src, dst, direction, ...groupFields(fields)].join(", ");
  return [
    buildParseClause(fields),
    ...filterClauses(fields),
    `stats sum(${bytes}) as flowBytes${packets} by ${by}`,
    "sort flowBytes desc",
    `limit ${Math.max(1, Math.floor(limit))}`,
  ].join(" | ");
}

/**
 * The totals query: exact bytes per boundary for the day, with the addresses
 * left out so the group count is a handful of rows rather than a cross product.
 *
 * This is a second scan of the same log group, and therefore a second charge to
 * the customer. It buys the one thing the pair query structurally cannot give:
 * a denominator. Without it, a top-N list is an undercount of unknown size, and
 * a cost surface that cannot say how much of the bill it accounts for is a
 * surface people will reconcile by hand and then stop using.
 */
export function buildTotalsQuery(fields: string[]): string {
  const bytes = insightsAlias("bytes");
  const direction = insightsAlias("flow-direction");
  const by = [direction, ...groupFields(fields)].join(", ");
  return [
    buildParseClause(fields),
    ...filterClauses(fields),
    `stats sum(${bytes}) as flowBytes by ${by}`,
  ].join(" | ");
}

/** The provider-neutral boundary a grouped row crossed. */
export type FlowScope =
  | "intra_zone"
  | "cross_zone"
  | "cross_region"
  | "internet_egress"
  | "internet_ingress"
  | "provider_service"
  | "nat_gateway"
  | "private_interconnect"
  | "unknown";

export interface FlowClassifierInput {
  direction: "egress" | "ingress";
  /** `traffic-path`, as the raw string from the record. */
  trafficPath?: string | undefined;
  /** `pkt-src-aws-service` / `pkt-dst-aws-service` on the peer's side. */
  peerService?: string | undefined;
  /** `interface-type` of the capturing interface. */
  interfaceType?: string | undefined;
  /** `az-id` of the capturing interface. */
  localZone?: string | undefined;
  /**
   * The peer's zone. Comes from `next-hop-az-id` when the format carries it,
   * otherwise from resolving the peer address against the account's network
   * interfaces — see `network-flows.ts`.
   */
  peerZone?: string | undefined;
  /** True when the peer address resolved to something in this account. */
  peerIsLocal: boolean;
}

/**
 * Which boundary a flow crossed, and therefore what it costs.
 *
 * The order of these tests is the whole classifier and none of it is
 * interchangeable:
 *
 * 1. **NAT first.** A NAT gateway charges for processing regardless of where
 *    the bytes were going, and the onward hop is billed separately — so a flow
 *    captured at a NAT interface is a NAT charge, and letting a later test
 *    reclassify it as internet egress would price the same bytes at the wrong
 *    rate and lose the single most actionable line on a network bill.
 * 2. **`traffic-path` next**, because it is AWS's own statement of where egress
 *    went and outranks anything inferred. Note `2` and `8` are both "through an
 *    internet gateway" — `2` is the older, broader value that also covers
 *    gateway VPC endpoints, so it is only internet egress when no AWS service
 *    was named on the peer.
 * 3. **A named AWS service** means a first-party endpoint in-region, which is
 *    free over a gateway endpoint and is emphatically *not* internet egress.
 * 4. **Zones last**, because they only decide anything for traffic that stayed
 *    inside the VPC, and two zones can only be compared when both are known.
 *
 * `unknown` is returned rather than a guess whenever the inputs do not decide.
 * It prices at zero and is labelled as unclassified, which is a visible gap; a
 * guess would be an invisible one.
 */
export function classifyScope(input: FlowClassifierInput): FlowScope {
  const iface = (input.interfaceType ?? "").toLowerCase();
  if (iface === "nat_gateway" || iface === "regional_nat_gateway") return "nat_gateway";

  const path = (input.trafficPath ?? "").trim();
  const namedService = !!input.peerService && input.peerService !== "-";
  switch (path) {
    case "5":
      return "cross_region";
    case "4":
      // Intra-region VPC peering is billed at the cross-AZ rate in each
      // direction, which is the same money as `cross_zone` — reporting it under
      // its own name would need a rate entry that is a duplicate by definition.
      return "cross_zone";
    case "3":
      return "private_interconnect";
    case "7":
      return "provider_service";
    case "8":
      return "internet_egress";
    case "2":
      return namedService ? "provider_service" : "internet_egress";
    default:
      break;
  }

  if (namedService) return "provider_service";

  if (input.peerIsLocal && input.localZone && input.peerZone) {
    return input.localZone === input.peerZone ? "intra_zone" : "cross_zone";
  }
  if (!input.peerIsLocal && input.direction === "ingress" && !path) {
    // Nothing local on the far side, no egress path recorded, arriving: it came
    // from outside. Free on AWS, but counted — an ingress spike is how a lot of
    // egress bills start being explained.
    return "internet_ingress";
  }
  return "unknown";
}

/**
 * True when a scope's byte total can be computed by the totals query alone.
 *
 * `intra_zone` and `cross_zone` cannot, unless the format carries
 * `next-hop-az-id`: telling them apart needs the peer's zone, which for older
 * formats comes from resolving an address, and the totals query deliberately
 * has no addresses in it. Those bytes are reported under `unknown` instead of
 * being split by a guess — so the residual for zone-crossing traffic is
 * honestly labelled unclassified rather than dishonestly labelled cross-zone.
 *
 * `internet_ingress` is gated on the same field, for the same reason. AWS does
 * not populate `traffic-path` for ingress at all, so on an inbound record the
 * peer's zone is the *only* signal separating a local peer from the internet.
 * Without it, "no next hop" is standing in for "the peer is not local" — which
 * is exactly the guess this function exists to refuse. Egress keeps its `true`
 * because `traffic-path` does carry a verdict there.
 *
 * @see https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs-limitations.html
 */
export function totalsAreExactFor(scope: FlowScope, fields: string[]): boolean {
  if (scope !== "intra_zone" && scope !== "cross_zone" && scope !== "internet_ingress") return true;
  return fields.includes("next-hop-az-id");
}
