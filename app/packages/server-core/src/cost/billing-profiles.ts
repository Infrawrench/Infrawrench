/**
 * Billing profiles: CRUD for the reusable invoice settings customers are
 * assigned to. The rules about what a profile means (precedence against the
 * customer, numbering, tax lines, masking) live in
 * `client-core/billing-profiles.ts`; this file stores profiles and refuses the
 * writes that would leave an invoice unable to render.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  BILLING_PROFILE_LIMITS,
  normalizeBillingProfileInput,
  type BillingProfile,
  type BillingProfileFields,
  type BillingProfileInput,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { billingLogos, billingProfiles, managedAccounts } from "../db/schema";
import { PdfImageError, readImageDataUrl } from "../pdf/image";

export type { BillingProfile, BillingProfileInput };

/** A profile write the API should refuse with a 400 and this message. */
export class BillingProfileError extends Error {
  override readonly name = "BillingProfileError";
}

/** The name is taken: a 409. */
export class BillingProfileNameConflictError extends Error {
  override readonly name = "BillingProfileNameConflictError";

  constructor(name: string) {
    super(`A billing profile called "${name}" already exists.`);
  }
}

/** Still assigned to live customers: a 409 that names them. */
export class BillingProfileInUseError extends Error {
  override readonly name = "BillingProfileInUseError";

  constructor(readonly customers: string[]) {
    super(
      `This billing profile is assigned to ${customers.length === 1 ? "a customer" : `${customers.length} customers`} ` +
        `(${customers.slice(0, 5).join(", ")}${customers.length > 5 ? ", …" : ""}). ` +
        "Assign them another profile first; removing it out from under them would change the " +
        "address, tax and numbering of their next invoice.",
    );
  }
}

export type BillingProfileRow = typeof billingProfiles.$inferSelect;

function toWire(row: BillingProfileRow, managedAccountIds: string[]): BillingProfile {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legalName,
    address: row.address,
    taxId: row.taxId,
    poNumber: row.poNumber,
    toEmails: Array.isArray(row.toEmails) ? row.toEmails : [],
    ccEmails: Array.isArray(row.ccEmails) ? row.ccEmails : [],
    currency: row.currency,
    paymentTermsDays: row.paymentTermsDays,
    numberPrefix: row.numberPrefix,
    numberIncludesYear: row.numberIncludesYear,
    numberStart: row.numberStart,
    taxRates: Array.isArray(row.taxRates) ? row.taxRates : [],
    bank: row.bank ?? null,
    footer: row.footer,
    logo: row.logo,
    managedAccountIds,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The fields invoice resolution reads, from a stored row. */
export function billingProfileFields(row: BillingProfileRow): BillingProfileFields {
  const wire = toWire(row, []);
  return {
    id: wire.id,
    name: wire.name,
    legalName: wire.legalName,
    address: wire.address,
    taxId: wire.taxId,
    poNumber: wire.poNumber,
    toEmails: wire.toEmails,
    ccEmails: wire.ccEmails,
    currency: wire.currency,
    paymentTermsDays: wire.paymentTermsDays,
    numberPrefix: wire.numberPrefix,
    numberIncludesYear: wire.numberIncludesYear,
    taxRates: wire.taxRates,
    bank: wire.bank,
    footer: wire.footer,
  };
}

/** Live customers per profile, one query for the whole org. */
async function assignments(organizationId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ id: managedAccounts.id, profileId: managedAccounts.billingProfileId })
    .from(managedAccounts)
    .where(
      and(eq(managedAccounts.organizationId, organizationId), isNull(managedAccounts.deletedAt)),
    )
    .orderBy(asc(managedAccounts.name));
  const out = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.profileId) continue;
    const list = out.get(row.profileId) ?? [];
    list.push(row.id);
    out.set(row.profileId, list);
  }
  return out;
}

export async function listBillingProfiles(organizationId: string): Promise<BillingProfile[]> {
  const [rows, byProfile] = await Promise.all([
    db
      .select()
      .from(billingProfiles)
      .where(eq(billingProfiles.organizationId, organizationId))
      .orderBy(asc(billingProfiles.name)),
    assignments(organizationId),
  ]);
  return rows.map((row) => toWire(row, byProfile.get(row.id) ?? []));
}

/** The stored row, or null. Invoice computation reads this. */
export async function getBillingProfileRow(
  organizationId: string,
  id: string,
): Promise<BillingProfileRow | null> {
  const [row] = await db
    .select()
    .from(billingProfiles)
    .where(and(eq(billingProfiles.id, id), eq(billingProfiles.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

export async function getBillingProfile(
  organizationId: string,
  id: string,
): Promise<BillingProfile | null> {
  const row = await getBillingProfileRow(organizationId, id);
  if (!row) return null;
  return toWire(row, (await assignments(organizationId)).get(id) ?? []);
}

function normalize(input: BillingProfileInput) {
  const result = normalizeBillingProfileInput(input);
  if (result.error !== undefined) throw new BillingProfileError(result.error);
  const value = result.value;
  // Shape and size are checked in client-core; whether it actually decodes is
  // checked here, because this is the side that has to draw it. Refusing now
  // beats a PDF that silently drops the logo the day it is sent.
  if (value.logo) {
    try {
      readImageDataUrl(value.logo);
    } catch (e) {
      if (e instanceof PdfImageError) throw new BillingProfileError(`Logo: ${e.message}`);
      throw e;
    }
  }
  return value;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

export async function createBillingProfile(
  organizationId: string,
  input: BillingProfileInput,
  createdByUserId?: string | null,
): Promise<BillingProfile> {
  const data = normalize(input);
  const [{ count }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(billingProfiles)
    .where(eq(billingProfiles.organizationId, organizationId))) as [{ count: number }];
  if (Number(count) >= BILLING_PROFILE_LIMITS.maxPerOrg) {
    throw new BillingProfileError(
      `An organisation can have at most ${BILLING_PROFILE_LIMITS.maxPerOrg} billing profiles.`,
    );
  }
  try {
    const [row] = await db
      .insert(billingProfiles)
      .values({
        id: randomUUID(),
        organizationId,
        ...data,
        logo: data.logo ?? null,
        createdByUserId: createdByUserId ?? null,
      })
      .returning();
    if (!row) throw new Error("Failed to create billing profile");
    return toWire(row, []);
  } catch (e) {
    if (isUniqueViolation(e)) throw new BillingProfileNameConflictError(data.name);
    throw e;
  }
}

/**
 * Full replace, except the logo: absent leaves it, null removes it. Returns
 * both versions so the caller can audit what changed; null when not found.
 *
 * Only drafts follow a profile edit. Every approved invoice carries its own
 * resolved copy, so a new bank account or tax rate reaches the next invoice
 * and no issued one.
 */
export async function updateBillingProfile(
  organizationId: string,
  id: string,
  input: BillingProfileInput,
): Promise<{ before: BillingProfile; after: BillingProfile } | null> {
  const existing = await getBillingProfileRow(organizationId, id);
  if (!existing) return null;
  const data = normalize(input);
  const assigned = (await assignments(organizationId)).get(id) ?? [];
  try {
    const [row] = await db
      .update(billingProfiles)
      .set({
        ...data,
        logo: data.logo === undefined ? existing.logo : data.logo,
        updatedAt: new Date(),
      })
      .where(and(eq(billingProfiles.id, id), eq(billingProfiles.organizationId, organizationId)))
      .returning();
    if (!row) return null;
    return { before: toWire(existing, assigned), after: toWire(row, assigned) };
  } catch (e) {
    if (isUniqueViolation(e)) throw new BillingProfileNameConflictError(data.name);
    throw e;
  }
}

/** Delete. False when not found; refuses while live customers are assigned. */
export async function deleteBillingProfile(
  organizationId: string,
  id: string,
): Promise<BillingProfile | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(billingProfiles)
      .where(and(eq(billingProfiles.id, id), eq(billingProfiles.organizationId, organizationId)))
      .limit(1)
      .for("update");
    if (!row) return null;
    const customers = await tx
      .select({ name: managedAccounts.name })
      .from(managedAccounts)
      .where(
        and(
          eq(managedAccounts.organizationId, organizationId),
          eq(managedAccounts.billingProfileId, id),
          isNull(managedAccounts.deletedAt),
        ),
      )
      .orderBy(asc(managedAccounts.name));
    if (customers.length > 0) throw new BillingProfileInUseError(customers.map((c) => c.name));
    await tx.delete(billingProfiles).where(eq(billingProfiles.id, id));
    return toWire(row, []);
  });
}

/* ------------------------------------------------------------------ *
 * Logos
 * ------------------------------------------------------------------ */

/** The content address a logo is frozen under. */
export function billingLogoId(dataUrl: string): string {
  return createHash("sha256").update(dataUrl).digest("hex");
}

type Executor = Pick<typeof db, "insert" | "select">;

/**
 * Store a logo under its hash, once. Called inside the approval transaction so
 * an approved invoice can never name a logo that was not written.
 */
export async function storeBillingLogo(
  executor: Executor,
  organizationId: string,
  dataUrl: string,
): Promise<string> {
  const id = billingLogoId(dataUrl);
  await executor
    .insert(billingLogos)
    .values({ organizationId, id, dataUrl })
    .onConflictDoNothing({ target: [billingLogos.organizationId, billingLogos.id] });
  return id;
}

/** A frozen logo's data URL, or null when it is not (or no longer) stored. */
export async function getBillingLogo(organizationId: string, id: string): Promise<string | null> {
  const [row] = await db
    .select({ dataUrl: billingLogos.dataUrl })
    .from(billingLogos)
    .where(and(eq(billingLogos.organizationId, organizationId), eq(billingLogos.id, id)))
    .limit(1);
  return row?.dataUrl ?? null;
}
