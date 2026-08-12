import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type {
  IacStateResourceEntry,
  IacStateSummary,
  ParsedTerraformState,
} from "@infrawrench/client-core";
import {
  IAC_LIMITS,
  IAC_STATE_LIMITS,
  TerraformStateParseError,
  parseTerraformStateDocument,
} from "@infrawrench/client-core";
import { db } from "../db/client.js";
import { accounts, iacManagedResources, iacStates, users } from "../db/schema.js";

/**
 * Persistence for **IaC reconciliation** — uploaded Terraform state documents
 * and the resource instances lifted out of them.
 *
 * The document itself is never stored. Parsing happens once, on upload, and
 * only the parsed projection lands in the database: an attribute bag with
 * every sensitive value already dropped by the parser, truncated to bounded
 * sizes. That is deliberate — a `.tfstate` is one of the most secret-dense
 * files an organization has, and the reconciliation only ever needs the
 * attributes it compares against.
 */

/** Domain error with the status the route should answer. */
export class IacInputError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "IacInputError";
    this.status = status;
  }
}

interface StateRow {
  id: string;
  label: string;
  accountId: string | null;
  accountName: string | null;
  format: "tfstate" | "show-json";
  formatVersion: string;
  terraformVersion: string | null;
  serial: number | null;
  lineage: string | null;
  resourceCount: number;
  dataSourceCount: number;
  redactedAttributeCount: number;
  parseWarnings: string[];
  uploadedByUserId: string | null;
  uploadedByName: string | null;
  createdAt: Date;
}

function toSummary(row: StateRow): IacStateSummary {
  return {
    id: row.id,
    label: row.label,
    accountId: row.accountId,
    accountName: row.accountName,
    format: row.format,
    formatVersion: row.formatVersion,
    terraformVersion: row.terraformVersion,
    serial: row.serial,
    lineage: row.lineage,
    resourceCount: row.resourceCount,
    dataSourceCount: row.dataSourceCount,
    redactedAttributeCount: row.redactedAttributeCount,
    parseWarnings: row.parseWarnings ?? [],
    uploadedByUserId: row.uploadedByUserId,
    uploadedByName: row.uploadedByName,
    createdAt: row.createdAt.toISOString(),
  };
}

function selectStates() {
  return db
    .select({
      id: iacStates.id,
      label: iacStates.label,
      accountId: iacStates.accountId,
      accountName: accounts.displayName,
      format: iacStates.format,
      formatVersion: iacStates.formatVersion,
      terraformVersion: iacStates.terraformVersion,
      serial: iacStates.serial,
      lineage: iacStates.lineage,
      resourceCount: iacStates.resourceCount,
      dataSourceCount: iacStates.dataSourceCount,
      redactedAttributeCount: iacStates.redactedAttributeCount,
      parseWarnings: iacStates.parseWarnings,
      uploadedByUserId: iacStates.uploadedByUserId,
      uploadedByName: users.displayName,
      createdAt: iacStates.createdAt,
    })
    .from(iacStates)
    .leftJoin(accounts, eq(accounts.id, iacStates.accountId))
    .leftJoin(users, eq(users.id, iacStates.uploadedByUserId));
}

export async function listIacStates(organizationId: string): Promise<IacStateSummary[]> {
  const rows = await selectStates()
    .where(eq(iacStates.organizationId, organizationId))
    .orderBy(desc(iacStates.createdAt));
  return rows.map(toSummary);
}

export async function getIacState(
  organizationId: string,
  stateId: string,
): Promise<IacStateSummary | null> {
  const rows = await selectStates()
    .where(and(eq(iacStates.organizationId, organizationId), eq(iacStates.id, stateId)))
    .limit(1);
  const row = rows[0];
  return row ? toSummary(row) : null;
}

/**
 * The newest state document for one **scope**.
 *
 * `accountId` is a string for an account-scoped document, or `null` for an
 * org-wide one (`account_id IS NULL`). There is deliberately no "any scope"
 * mode: the newest document in the org can belong to a *different* account,
 * and reconciling account A's resources against account B's state produces a
 * confidently wrong managed/unmanaged answer. A caller that wants a fallback
 * must ask for the org-wide scope explicitly — those documents really do
 * cover every account.
 */
export async function getLatestIacState(
  organizationId: string,
  accountId: string | null,
): Promise<IacStateSummary | null> {
  const rows = await selectStates()
    .where(
      and(
        eq(iacStates.organizationId, organizationId),
        accountId === null ? isNull(iacStates.accountId) : eq(iacStates.accountId, accountId),
      ),
    )
    .orderBy(desc(iacStates.createdAt))
    .limit(1);
  const row = rows[0];
  return row ? toSummary(row) : null;
}

/** The parsed resource instances belonging to one stored state. */
export async function loadIacStateResources(stateId: string): Promise<IacStateResourceEntry[]> {
  const rows = await db
    .select()
    .from(iacManagedResources)
    .where(eq(iacManagedResources.stateId, stateId))
    .orderBy(asc(iacManagedResources.address));
  return rows.map((row) => ({
    address: row.address,
    module: row.module,
    mode: row.mode,
    type: row.terraformType,
    name: row.terraformName,
    indexKey: row.indexKey,
    providerName: row.providerName,
    attributes: row.attributes ?? {},
    redactedAttributeKeys: row.redactedAttributeKeys ?? [],
    identifiers: row.identifiers ?? [],
  }));
}

export interface SaveIacStateArgs {
  organizationId: string;
  label: string;
  /** Null/undefined means the state covers the whole org. */
  accountId?: string | null;
  /** The raw state document text. */
  document: string;
  userId?: string | undefined;
}

export interface SaveIacStateResult {
  state: IacStateSummary;
  parsed: ParsedTerraformState;
}

/**
 * Parse and store one state document. Rejects rather than truncating a
 * document it cannot understand — a partially-read state would classify real
 * managed resources as ClickOps, which is exactly the wrong answer.
 */
export async function saveIacState(args: SaveIacStateArgs): Promise<SaveIacStateResult> {
  const label = args.label.trim();
  if (!label) throw new IacInputError("A label is required.");
  if (label.length > IAC_LIMITS.maxLabelChars) {
    throw new IacInputError(`Label is limited to ${IAC_LIMITS.maxLabelChars} characters.`);
  }

  // Total translation, not an allow-list of recognised error types.
  //
  // Parsing is the trust boundary: everything past this point is our data,
  // everything before it is a file a stranger uploaded. So *any* throw from the
  // parse stage is a statement about the document, and must reach the client as
  // a 400. Matching on specific error classes is what let a `RangeError` from a
  // deeply nested attribute escape as a 500 — and a 500 is not just the wrong
  // status, it is the wrong instruction: it tells a user holding an
  // unacceptable file that we broke, so they retry it unchanged.
  //
  // The parser is expected to classify its own rejections; anything it does not
  // is a gap worth seeing, so it is logged even though the caller still gets a
  // clean 400.
  let parsed: ParsedTerraformState;
  try {
    parsed = parseTerraformStateDocument(args.document);
  } catch (e) {
    if (e instanceof TerraformStateParseError) throw new IacInputError(e.message, 400);
    console.error("[iac] unclassified parse failure — the parser should have caught this:", e);
    const detail = e instanceof Error ? e.message : String(e);
    throw new IacInputError(
      `State document could not be parsed (${detail}). It must be a \`.tfstate\` (format version 4) or the output of \`terraform show -json\`.`,
      400,
    );
  }

  if (args.accountId) {
    const owned = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, args.accountId), eq(accounts.organizationId, args.organizationId)))
      .limit(1);
    if (owned.length === 0) throw new IacInputError("Unknown account.", 404);
  }

  const stateId = randomUUID();
  const now = new Date();
  const managedCount = parsed.resources.filter((r) => r.mode === "managed").length;

  await db.transaction(async (tx) => {
    await tx.insert(iacStates).values({
      id: stateId,
      organizationId: args.organizationId,
      accountId: args.accountId ?? null,
      label,
      format: parsed.format,
      formatVersion: parsed.formatVersion,
      terraformVersion: parsed.terraformVersion,
      serial: parsed.serial,
      lineage: parsed.lineage,
      resourceCount: managedCount,
      dataSourceCount: parsed.dataSourceCount,
      redactedAttributeCount: parsed.redactedAttributeCount,
      parseWarnings: parsed.warnings,
      uploadedByUserId: args.userId ?? null,
      createdAt: now,
    });

    const CHUNK = 500;
    const values = parsed.resources.map((entry) => ({
      id: randomUUID(),
      stateId,
      organizationId: args.organizationId,
      address: entry.address,
      module: entry.module,
      mode: entry.mode,
      terraformType: entry.type,
      terraformName: entry.name,
      indexKey: entry.indexKey === null ? null : String(entry.indexKey),
      providerName: entry.providerName,
      identifiers: entry.identifiers,
      attributes: entry.attributes,
      redactedAttributeKeys: entry.redactedAttributeKeys,
      createdAt: now,
    }));
    for (let i = 0; i < values.length; i += CHUNK) {
      await tx.insert(iacManagedResources).values(values.slice(i, i + CHUNK));
    }
  });

  await enforceIacStateCap(args.organizationId);

  const state = await getIacState(args.organizationId, stateId);
  if (!state) throw new IacInputError("State document could not be stored.", 409);
  return { state, parsed };
}

export async function deleteIacState(organizationId: string, stateId: string): Promise<boolean> {
  const deleted = await db
    .delete(iacStates)
    .where(and(eq(iacStates.organizationId, organizationId), eq(iacStates.id, stateId)))
    .returning({ id: iacStates.id });
  return deleted.length > 0;
}

/**
 * Keep at most {@link IAC_STATE_LIMITS.maxStatesPerOrg} documents per org.
 * A state upload is a snapshot people repeat on every apply, so the table
 * would otherwise grow without a ceiling; the newest are the ones anybody
 * looks at.
 */
async function enforceIacStateCap(organizationId: string): Promise<void> {
  const rows = await db
    .select({ id: iacStates.id })
    .from(iacStates)
    .where(eq(iacStates.organizationId, organizationId))
    .orderBy(desc(iacStates.createdAt));
  const excess = rows.slice(IAC_STATE_LIMITS.maxStatesPerOrg).map((r) => r.id);
  if (excess.length === 0) return;
  await db.delete(iacStates).where(inArray(iacStates.id, excess));
}

export interface IacRetentionResult {
  cutoff: Date;
  deleted: number;
}

/**
 * Retention: drop state documents past the window, **except** the newest one
 * per org+account scope. A quiet org that has not re-uploaded in months must
 * not silently lose its answer to "what does Terraform manage?" — the point of
 * retention here is superseded snapshots, not the current one.
 *
 * Rides the poller's hourly retention pass beside `pruneResourceChanges`;
 * idempotent, so replicas overlapping costs one index scan.
 */
export async function pruneIacStates(now = new Date()): Promise<IacRetentionResult> {
  const cutoff = new Date(now.getTime() - IAC_STATE_LIMITS.retentionDays * 24 * 60 * 60 * 1000);

  // The newest row per (org, account) scope — `account_id IS NULL` is its own
  // scope, which `IS NOT DISTINCT FROM` handles without a special case.
  const keep = await db.execute(sql`
    SELECT DISTINCT ON (organization_id, account_id) id
    FROM iac_states
    ORDER BY organization_id, account_id, created_at DESC
  `);
  const keepIds = Array.from(keep as Iterable<Record<string, unknown>>, (r) => String(r["id"]));

  const deleted = await db
    .delete(iacStates)
    .where(
      keepIds.length > 0
        ? and(lt(iacStates.createdAt, cutoff), sql`${iacStates.id} <> ALL(${keepIds})`)
        : lt(iacStates.createdAt, cutoff),
    )
    .returning({ id: iacStates.id });

  if (deleted.length > 0) {
    console.log(
      `[retention] iac_states: deleted ${deleted.length} superseded state document(s) older than ` +
        `${IAC_STATE_LIMITS.retentionDays} days`,
    );
  }
  return { cutoff, deleted: deleted.length };
}
