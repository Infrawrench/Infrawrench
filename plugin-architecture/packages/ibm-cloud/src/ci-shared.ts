/**
 * What the IBM Cloud CI executors share: how they reach IBM (the plugin's
 * own `IbmApi`, so tests fake only the HTTP service), the tags, and the VPC
 * network a `vm` job starts on.
 *
 * **Wire shapes verified against the VPC (`latest.json`, version
 * 2026-09-24) and Global Tagging (`tagging.json` 1.2.0) OpenAPI documents
 * and the VPC docs, November 2026** (the paths are typed by plugingen):
 * - `POST /vpcs` (`name`; names are unique in a region, a second answers
 *   409), `POST /public_gateways` (`vpc`, `zone`, `name`; one per zone per
 *   VPC), `POST /subnets` (`vpc`, `zone`, `total_ipv4_address_count`,
 *   `public_gateway`, `name`), `POST /security_groups` (`vpc`, `name`,
 *   `rules[]`; a group with no inbound rule lets nothing in). From version
 *   2025-12-09 a rule for every protocol is `protocol: any`. `status`
 *   pending, available, deleting, failed. A VPC's default security group
 *   lets its own members reach each other, so jobs get a group of their own.
 * - Global Tagging `POST /v3/tags/attach?tag_type=user` (`resources[].
 *   resource_id` = CRN, `tag_names`) and `GET /v3/tags?attached_to=<crn>&
 *   tag_type=user` (`items[].name`). User tags are lowercased and take
 *   `A-Z`, `0-9`, space, `_`, `-`, `.` and `:` only, up to 128 characters,
 *   so a job's tags are written with an escape (`ibmTag`) that reads back
 *   exactly what was sent: the host compares the organization's tag as
 *   sent, case and all.
 *
 * The CI network is made the first time a region needs it and kept: a VPC
 * named `infrawrench-ci`, a public gateway in its first zone (the jobs' way
 * out to the internet; IBM bills a public gateway's address like a floating
 * IP, by the month), one subnet behind it, and a security group with no
 * inbound rule and every outbound one. Nothing reaches a job, jobs do not
 * reach each other, and none of the account's own networks is touched.
 */
import { pathEncode, type CiMissingPermission } from "@infrawrench/plugin-base";

import { IbmApiError, type IbmApi } from "./api.js";
import { VPC_QUERY } from "./regions.js";

export interface IbmCiContext {
  api: IbmApi;
  homeRegion: string;
  /** Waits between polls; a test passes one that does not. */
  sleep?(ms: number): Promise<void>;
}

export function sleepOf(ctx: IbmCiContext): (ms: number) => Promise<void> {
  return ctx.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

export function statusOf(err: unknown): number | undefined {
  return err instanceof IbmApiError ? err.status : undefined;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const NETWORK_NAME = "infrawrench-ci";

// ---------------------------------------------------------------------------
// Tags

/**
 * One character of a tag as IBM keeps it. Lowercase letters, digits, space,
 * `-`, `.` and `:` stand for themselves; `_` starts an escape: `__` is `_`,
 * `_` and a letter is that letter in uppercase, and `_.` and two hex digits
 * is one byte of anything else (UTF-8).
 */
function escapeTagText(text: string): string {
  let out = "";
  for (const ch of text) {
    if (/[a-z0-9 .:-]/.test(ch)) out += ch;
    else if (ch === "_") out += "__";
    else if (/[A-Z]/.test(ch)) out += `_${ch.toLowerCase()}`;
    else {
      for (const byte of new TextEncoder().encode(ch)) {
        out += `_.${byte.toString(16).padStart(2, "0")}`;
      }
    }
  }
  return out;
}

function unescapeTagText(text: string): string {
  const bytes: number[] = [];
  const push = (s: string) => bytes.push(...new TextEncoder().encode(s));
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== "_") {
      push(ch);
      continue;
    }
    const next = text[i + 1] ?? "";
    if (next === "_") {
      push("_");
      i++;
    } else if (next === ".") {
      bytes.push(parseInt(text.slice(i + 2, i + 4), 16) || 0);
      i += 3;
    } else {
      push(next.toUpperCase());
      i++;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** A job's tag as an IBM user tag, `key:value`, that `fromIbmTags` reads back as sent. */
export function ibmTag(key: string, value: string): string {
  return `${escapeTagText(key)}:${escapeTagText(value)}`.slice(0, 128);
}

export function ibmTags(tags: Readonly<Record<string, string>>): string[] {
  return Object.entries(tags).map(([key, value]) => ibmTag(key, value));
}

/** The job's tags back from IBM user tags. Tags without a `:` are not a job's. */
export function fromIbmTags(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const colon = name.indexOf(":");
    if (colon <= 0) continue;
    out[unescapeTagText(name.slice(0, colon))] = unescapeTagText(name.slice(colon + 1));
  }
  return out;
}

/** Attach user tags to a resource by CRN. */
export async function attachTags(ctx: IbmCiContext, crn: string, tags: string[]): Promise<void> {
  await ctx.api.tagging.post("/v3/tags/attach", {
    query: { tag_type: "user" },
    body: { resources: [{ resource_id: crn }], tag_names: tags },
  });
}

/** The user tags on a resource, by CRN. */
export async function tagsOn(ctx: IbmCiContext, crn: string): Promise<string[]> {
  const res = await ctx.api.tagging.get("/v3/tags", {
    query: { attached_to: crn, tag_type: "user", limit: 1000 },
  });
  return (res.items ?? []).flatMap((t) => (t.name ? [t.name] : []));
}

// ---------------------------------------------------------------------------
// The CI network

export const VPC_ROLE: CiMissingPermission = {
  permission: "Editor (platform role) on VPC Infrastructure Services",
  label: "Make the CI network once per region, and start, follow and delete the job's instance",
};

export const TAG_ROLE: CiMissingPermission = {
  permission: "Editor (platform role) on VPC Infrastructure Services, for tagging",
  label: "Tag the job's instance (global-search-tagging.tag.attach-user-tag)",
};

export interface CiNetwork {
  vpcId: string;
  zone: string;
  subnetId: string;
  securityGroupId: string;
}

interface Named {
  id: string;
  name?: string;
  status?: string;
  lifecycle_state?: string;
}

async function waitAvailable<T extends Named>(
  ctx: IbmCiContext,
  first: T,
  read: () => Promise<T>,
  what: string,
): Promise<T> {
  let current = first;
  for (let i = 0; current.status === "pending" && i < 60; i++) {
    await sleepOf(ctx)(3000);
    current = await read();
  }
  if (current.status && current.status !== "available") {
    throw new Error(`The CI network's ${what} is ${current.status}, not available.`);
  }
  return current;
}

/** The CI VPC in `region`, when there is one. */
export async function findCiVpc(ctx: IbmCiContext, region: string): Promise<Named | null> {
  const vpc = ctx.api.vpc(region);
  let page = await vpc.get("/vpcs", { query: { ...VPC_QUERY, limit: 100 } });
  for (;;) {
    const hit = (page.vpcs ?? []).find((v) => v.name === NETWORK_NAME);
    if (hit) return hit;
    if (!page.next?.href) return null;
    page = await ctx.api.followLink<typeof page>(page.next.href);
  }
}

/**
 * The CI network in `region`, made (or finished, when an earlier start
 * stopped half way) on first use. Every step looks before it makes, and a
 * name taken by a start running at the same time is looked up again.
 */
export async function ensureNetwork(ctx: IbmCiContext, region: string): Promise<CiNetwork> {
  const vpc = ctx.api.vpc(region);
  const q = { query: VPC_QUERY };
  let ciVpc = await findCiVpc(ctx, region);
  if (!ciVpc) {
    try {
      ciVpc = await vpc.post("/vpcs", { ...q, body: { name: NETWORK_NAME } });
    } catch (err) {
      if (statusOf(err) !== 409) throw err;
      ciVpc = await findCiVpc(ctx, region);
      if (!ciVpc) throw err;
    }
  }
  const vpcId = ciVpc.id;
  ciVpc = await waitAvailable(ctx, ciVpc, () => vpc.get(`/vpcs/${pathEncode(vpcId)}`, q), "VPC");

  const zones = await vpc.get(`/regions/${pathEncode(region)}/zones`, q);
  const zone =
    (zones.zones ?? [])
      .filter((z) => !z.status || z.status === "available")
      .map((z) => z.name)
      .sort()[0] ?? `${region}-1`;

  const subnets = await vpc.get("/subnets", { query: { ...VPC_QUERY, "vpc.id": vpcId } });
  let subnet: Named | undefined = (subnets.subnets ?? []).find((s) => s.name === NETWORK_NAME);
  if (!subnet) {
    const gateways = await vpc.get("/public_gateways", { query: { ...VPC_QUERY, limit: 100 } });
    let gateway: Named | undefined = (gateways.public_gateways ?? []).find(
      (g) => g.vpc?.id === vpcId && g.zone?.name === zone,
    );
    if (!gateway) {
      gateway = await vpc.post("/public_gateways", {
        ...q,
        body: { vpc: { id: vpcId }, zone: { name: zone }, name: NETWORK_NAME },
      });
    }
    const gatewayId = gateway.id;
    await waitAvailable(
      ctx,
      gateway,
      () => vpc.get(`/public_gateways/${pathEncode(gatewayId)}`, q),
      "public gateway",
    );
    try {
      subnet = await vpc.post("/subnets", {
        ...q,
        body: {
          vpc: { id: vpcId },
          zone: { name: zone },
          total_ipv4_address_count: 256,
          public_gateway: { id: gatewayId },
          name: NETWORK_NAME,
        },
      });
    } catch (err) {
      if (statusOf(err) !== 409) throw err;
      const again = await vpc.get("/subnets", { query: { ...VPC_QUERY, "vpc.id": vpcId } });
      subnet = (again.subnets ?? []).find((s) => s.name === NETWORK_NAME);
      if (!subnet) throw err;
    }
  }
  const subnetId = subnet.id;
  subnet = await waitAvailable(
    ctx,
    subnet,
    () => vpc.get(`/subnets/${pathEncode(subnetId)}`, q),
    "subnet",
  );

  const groups = await vpc.get("/security_groups", { query: { ...VPC_QUERY, "vpc.id": vpcId } });
  let group = (groups.security_groups ?? []).find((g) => g.name === NETWORK_NAME);
  if (!group) {
    try {
      group = await vpc.post("/security_groups", {
        ...q,
        body: {
          vpc: { id: vpcId },
          name: NETWORK_NAME,
          // Everything out, nothing in.
          rules: [{ direction: "outbound", protocol: "any", remote: { cidr_block: "0.0.0.0/0" } }],
        },
      });
    } catch (err) {
      if (statusOf(err) !== 409) throw err;
      const again = await vpc.get("/security_groups", {
        query: { ...VPC_QUERY, "vpc.id": vpcId },
      });
      group = (again.security_groups ?? []).find((g) => g.name === NETWORK_NAME);
      if (!group) throw err;
    }
  }
  return { vpcId, zone, subnetId: subnet.id, securityGroupId: group.id };
}
