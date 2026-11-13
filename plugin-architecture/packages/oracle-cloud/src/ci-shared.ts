/**
 * What the OCI CI executors share: how they reach OCI (the plugin's own
 * signed `OciApi`, so tests fake only the HTTP service), the CI network both
 * kinds start on, and the permission check.
 *
 * **Wire shapes verified against the OCI API reference and the request and
 * model definitions in oracle/oci-typescript-sdk, November 2026:**
 * - Core Services `/20160918`: `vcns` (`cidrBlocks`, `displayName`,
 *   `freeformTags`; answers `defaultRouteTableId`, `defaultSecurityListId`,
 *   `lifecycleState` PROVISIONING, AVAILABLE, ...), `internetGateways`
 *   (`vcnId`, `isEnabled`), `routeTables/{id}` PUT (`routeRules[].{
 *   destination, destinationType: CIDR_BLOCK, networkEntityId}`),
 *   `securityLists/{id}` PUT (`ingressSecurityRules`,
 *   `egressSecurityRules[].{destination, protocol: all, isStateless}`),
 *   `subnets` (a regional subnet: no `availabilityDomain`, `cidrBlock`,
 *   `prohibitPublicIpOnVnic`). A new VCN's default security list lets in
 *   SSH from anywhere and some ICMP, so the CI network replaces its rules.
 * - Every create takes an `opc-retry-token` header, honoured for 24 hours,
 *   which is what makes a start that is retried after a lost answer find
 *   what the first one made instead of making a second.
 * - Identity `/20160918`: `policies?compartmentId=` (`statements[]`),
 *   `userGroupMemberships?compartmentId=&userId=`, `groups?compartmentId=`.
 *   OCI has no call that answers "may this user do that" without doing it,
 *   so the check reads the tenancy's own policies (see `missingPolicies`).
 *
 * Everything a job starts goes in the tenancy's root compartment, on a
 * network made for CI the first time a region needs it: a VCN named
 * `infrawrench-ci` with an internet gateway, a route to it, a security list
 * that lets nothing in and everything out, and one public regional subnet.
 * A job's machine reaches the internet and nothing of the tenancy's own
 * networks, and nothing reaches it. The network is kept (it costs nothing)
 * and is not tagged `infrawrench-ci`, so the reaper never takes it for a
 * job's leftovers.
 */
import { ciComputeKey, type CiMissingPermission } from "@infrawrench/plugin-base";

import { OciApiError, isAuthorizationGap, type OciApi } from "./api.js";
import type { OciInventory } from "./inventory.js";

export interface OciCiContext {
  api: OciApi;
  inventory: OciInventory;
  /** Waits between polls; a test passes one that does not. */
  sleep?(ms: number): Promise<void>;
}

export function sleepOf(ctx: OciCiContext): (ms: number) => Promise<void> {
  return ctx.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether OCI answered that the thing is not there (or not visible, which OCI words the same). */
export function isNotFound(err: unknown): boolean {
  return err instanceof OciApiError && err.status === 404;
}

/** The compartment every CI job runs in: the tenancy's root. */
export function ciCompartment(ctx: OciCiContext): string {
  return ctx.api.tenancyOcid;
}

/** The name of the network CI jobs start on, and of each part of it. */
export const NETWORK_NAME = "infrawrench-ci";
/** The CI network's tag. Not `infrawrench-ci`: the network is no job's. */
export const NETWORK_TAG = "infrawrench-ci-network";
const VCN_CIDR = "10.231.0.0/16";
const SUBNET_CIDR = "10.231.0.0/20";

/**
 * Free-form tags for a job's tags. OCI keeps keys and values as sent, so
 * they come back unchanged: at most 10 tags, keys up to 100 printable ASCII
 * characters without periods or spaces, values up to 256.
 */
export function freeformTags(tags: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags).slice(0, 10)) {
    out[key.replace(/[.\s]/g, "-").slice(0, 100)] = value.slice(0, 256);
  }
  return out;
}

/** A retry token for one create: the same for every attempt at the same thing, at most 64 characters. */
export function retryToken(...parts: string[]): string {
  return `iwci-${ciComputeKey({ tags: {}, name: parts.join("\u0000") })}`;
}

interface Vcn {
  id: string;
  lifecycleState?: string;
  defaultRouteTableId?: string;
  defaultSecurityListId?: string;
}

interface Subnet {
  id: string;
  lifecycleState?: string;
}

async function waitAvailable<T extends { lifecycleState?: string }>(
  ctx: OciCiContext,
  first: T,
  read: () => Promise<T>,
  what: string,
): Promise<T> {
  let current = first;
  for (let i = 0; current.lifecycleState === "PROVISIONING" && i < 30; i++) {
    await sleepOf(ctx)(2000);
    current = await read();
  }
  if (current.lifecycleState && current.lifecycleState !== "AVAILABLE") {
    throw new Error(`The CI network's ${what} is ${current.lifecycleState}, not AVAILABLE.`);
  }
  return current;
}

/** The CI network's subnet in `region`, when it is there and finished. */
export async function findNetwork(
  ctx: OciCiContext,
  region: string,
): Promise<{ vcn?: Vcn; subnetId?: string }> {
  const compartmentId = ciCompartment(ctx);
  const vcns = await ctx.api.listAll<Vcn>({
    service: "iaas",
    region,
    path: "/20160918/vcns",
    query: { compartmentId, displayName: NETWORK_NAME, lifecycleState: "AVAILABLE", limit: 50 },
  });
  const vcn = vcns[0];
  if (!vcn) return {};
  const subnets = await ctx.api.listAll<Subnet>({
    service: "iaas",
    region,
    path: "/20160918/subnets",
    query: { compartmentId, vcnId: vcn.id, displayName: NETWORK_NAME, limit: 50 },
  });
  const subnet = subnets.find((s) => s.lifecycleState === "AVAILABLE");
  return subnet ? { vcn, subnetId: subnet.id } : { vcn };
}

/**
 * The CI network's subnet in `region`, made (or finished, when an earlier
 * start stopped half way) on first use. Every step is safe to repeat.
 */
export async function ensureNetwork(ctx: OciCiContext, region: string): Promise<string> {
  const found = await findNetwork(ctx, region);
  if (found.subnetId) return found.subnetId;
  const compartmentId = ciCompartment(ctx);
  const tags = { [NETWORK_TAG]: "true" };
  const post = async <T>(path: string, body: unknown, token: string): Promise<T> =>
    (
      await ctx.api.request<T>({
        service: "iaas",
        region,
        method: "POST",
        path,
        body,
        headers: { "opc-retry-token": token },
      })
    ).data;
  const getVcn = (id: string) => ctx.api.get<Vcn>("iaas", region, `/20160918/vcns/${id}`);

  let vcn = found.vcn;
  if (!vcn) {
    // One token per tenancy, region and day: two jobs starting at once in a
    // new region make one network between them.
    const day = new Date().toISOString().slice(0, 10);
    const made = await post<Vcn>(
      "/20160918/vcns",
      { compartmentId, displayName: NETWORK_NAME, cidrBlocks: [VCN_CIDR], freeformTags: tags },
      retryToken("vcn", compartmentId, region, day),
    );
    vcn = await waitAvailable(ctx, made, () => getVcn(made.id), "VCN");
  }
  if (!vcn.defaultRouteTableId || !vcn.defaultSecurityListId) vcn = await getVcn(vcn.id);
  const routeTableId = vcn.defaultRouteTableId;
  const securityListId = vcn.defaultSecurityListId;
  if (!routeTableId || !securityListId) {
    throw new Error("OCI gave the CI network's VCN no default route table or security list.");
  }

  const gateways = await ctx.api.listAll<{ id: string; lifecycleState?: string }>({
    service: "iaas",
    region,
    path: "/20160918/internetGateways",
    query: { compartmentId, vcnId: vcn.id, limit: 50 },
  });
  const gatewayId =
    gateways.find((g) => g.lifecycleState === "AVAILABLE" || g.lifecycleState === "PROVISIONING")
      ?.id ??
    (
      await post<{ id: string }>(
        "/20160918/internetGateways",
        {
          compartmentId,
          vcnId: vcn.id,
          displayName: NETWORK_NAME,
          isEnabled: true,
          freeformTags: tags,
        },
        retryToken("igw", vcn.id),
      )
    ).id;

  // Nothing in, everything out, before anything can start on it.
  await ctx.api.request({
    service: "iaas",
    region,
    method: "PUT",
    path: `/20160918/securityLists/${securityListId}`,
    body: {
      ingressSecurityRules: [],
      egressSecurityRules: [
        {
          destination: "0.0.0.0/0",
          destinationType: "CIDR_BLOCK",
          protocol: "all",
          isStateless: false,
        },
      ],
    },
  });
  await ctx.api.request({
    service: "iaas",
    region,
    method: "PUT",
    path: `/20160918/routeTables/${routeTableId}`,
    body: {
      routeRules: [
        { destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: gatewayId },
      ],
    },
  });
  const subnet = await post<Subnet>(
    "/20160918/subnets",
    {
      compartmentId,
      vcnId: vcn.id,
      displayName: NETWORK_NAME,
      cidrBlock: SUBNET_CIDR,
      prohibitPublicIpOnVnic: false,
      routeTableId,
      securityListIds: [securityListId],
      freeformTags: tags,
    },
    retryToken("subnet", vcn.id),
  );
  const ready = await waitAvailable(
    ctx,
    subnet,
    () => ctx.api.get<Subnet>("iaas", region, `/20160918/subnets/${subnet.id}`),
    "subnet",
  );
  return ready.id;
}

/** The first availability domain in `region`, and the rest to fall back on. */
export async function availabilityDomains(ctx: OciCiContext, region: string): Promise<string[]> {
  const ads = await ctx.inventory.availabilityDomains(region);
  if (ads.length === 0) throw new Error(`OCI lists no availability domains in ${region}.`);
  return ads;
}

/** Whether a launch failed for want of capacity in that availability domain. */
export function isOutOfCapacity(err: unknown): boolean {
  return err instanceof OciApiError && /out of (host )?capacity/i.test(err.serviceMessage);
}

// ---------------------------------------------------------------------------
// Permissions

/**
 * One grant a CI kind needs, as a policy statement for the root
 * compartment. `resources` lists what satisfies it: the family, or
 * `all-resources`.
 */
export interface OciGrant {
  verb: "inspect" | "read" | "use" | "manage";
  resource: string;
  label: string;
}

const VERB_RANK: Record<string, number> = { inspect: 0, read: 1, use: 2, manage: 3 };

/** The policy statement a grant is, for the group the user is in. */
export function grantStatement(grant: OciGrant): string {
  return `Allow group <group> to ${grant.verb} ${grant.resource} in tenancy`;
}

export function missingOf(grant: OciGrant): CiMissingPermission {
  return { permission: grantStatement(grant), label: grant.label };
}

interface Statement {
  subjects: { anyUser: boolean; groupNames: string[]; groupIds: string[] };
  verb: number;
  resource: string;
  tenancy: boolean;
}

/**
 * Read one policy statement: `Allow <subject> to <verb> <resource> in
 * tenancy [where ...]`. Null for anything else (`Endorse`, `Define`,
 * `Admit`, a statement for a compartment, a permission list `{...}`).
 * A `where` clause is read as granting: the check names what is surely
 * missing, never what a condition might refuse.
 */
export function parseStatement(text: string): Statement | null {
  const m =
    /^\s*allow\s+(.+?)\s+to\s+(inspect|read|use|manage)\s+([a-z0-9-]+)\s+in\s+(tenancy|compartment\b.*?)(?:\s+where\b.*)?\s*$/is.exec(
      text,
    );
  if (!m) return null;
  const subject = m[1]!.trim();
  const groupNames: string[] = [];
  const groupIds: string[] = [];
  let anyUser = /^any-user$/i.test(subject);
  if (!anyUser) {
    for (const part of subject.split(",")) {
      const p = part.trim();
      const byId = /^group\s+id\s+(\S+)$/i.exec(p);
      if (byId) {
        groupIds.push(byId[1]!);
        continue;
      }
      const byName = /^group\s+(.+)$/i.exec(p);
      if (byName) {
        // `'Domain'/'Name'`, `Domain/Name`, `'Name'` or `Name`: the group's own name is last.
        const name = byName[1]!.split("/").pop()!.trim().replace(/^'|'$/g, "");
        groupNames.push(name.toLowerCase());
      } else if (/^any-user$/i.test(p)) {
        anyUser = true;
      }
    }
  }
  return {
    subjects: { anyUser, groupNames, groupIds },
    verb: VERB_RANK[m[2]!.toLowerCase()] ?? -1,
    resource: m[3]!.toLowerCase(),
    tenancy: /^tenancy$/i.test(m[4]!.trim()),
  };
}

/** Whether `statement` gives `grant` to a user in `groups` (id to lowercase name). */
export function statementGrants(
  statement: Statement,
  grant: OciGrant,
  groups: ReadonlyMap<string, string>,
): boolean {
  if (!statement.tenancy) return false;
  if (statement.verb < VERB_RANK[grant.verb]!) return false;
  if (statement.resource !== "all-resources" && statement.resource !== grant.resource) return false;
  const { anyUser, groupNames, groupIds } = statement.subjects;
  if (anyUser) return true;
  const names = new Set(groups.values());
  return groupIds.some((id) => groups.has(id)) || groupNames.some((n) => names.has(n));
}

/**
 * Which of `needed` no policy in the root compartment gives the key's user,
 * or null when the policies or the user's groups cannot be read (then a job
 * that lacks a grant fails at start, naming what OCI refused). Policies in
 * other compartments cannot grant anything in the root, so the root's are
 * all there is to read.
 */
export async function missingPolicies(
  ctx: OciCiContext,
  needed: readonly OciGrant[],
): Promise<OciGrant[] | null> {
  const home = ctx.inventory.homeRegion;
  const tenancy = ctx.api.tenancyOcid;
  try {
    const [memberships, groups, policies] = await Promise.all([
      ctx.api.listAll<{ groupId: string; lifecycleState?: string }>({
        service: "identity",
        region: home,
        path: "/20160918/userGroupMemberships",
        query: { compartmentId: tenancy, userId: ctx.api.userOcid, limit: 1000 },
      }),
      ctx.api.listAll<{ id: string; name: string }>({
        service: "identity",
        region: home,
        path: "/20160918/groups",
        query: { compartmentId: tenancy, limit: 1000 },
      }),
      ctx.api.listAll<{ statements?: string[]; lifecycleState?: string }>({
        service: "identity",
        region: home,
        path: "/20160918/policies",
        query: { compartmentId: tenancy, limit: 1000 },
      }),
    ]);
    const nameOf = new Map(groups.map((g) => [g.id, g.name.toLowerCase()]));
    const mine = new Map<string, string>();
    for (const m of memberships) {
      if (m.lifecycleState && m.lifecycleState !== "ACTIVE") continue;
      mine.set(m.groupId, nameOf.get(m.groupId) ?? "");
    }
    const statements = policies
      .filter((p) => !p.lifecycleState || p.lifecycleState === "ACTIVE")
      .flatMap((p) => p.statements ?? [])
      .map(parseStatement)
      .filter((s): s is Statement => s !== null);
    return needed.filter((grant) => !statements.some((s) => statementGrants(s, grant, mine)));
  } catch (err) {
    if (isAuthorizationGap(err)) return null;
    throw err;
  }
}

/** A list call that answers whether the key may read there at all. */
export async function canList(ctx: OciCiContext, probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch (err) {
    if (isAuthorizationGap(err)) return false;
    throw err;
  }
}
