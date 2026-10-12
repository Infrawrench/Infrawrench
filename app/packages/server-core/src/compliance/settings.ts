/**
 * Per-control decisions (`compliance_control_settings`): applicability with
 * a justification, an owner, notes. Validation is the client-core rule
 * (`validateComplianceControlSetting`) so editors grey out exactly what the
 * server rejects.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  getComplianceFramework,
  validateComplianceControlSetting,
  type ComplianceControlSetting,
  type ComplianceControlSettingInput,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { complianceControlSettings, organizationMembers, users } from "../db/schema";

export class ComplianceInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "ComplianceInputError";
  }
}

type Row = typeof complianceControlSettings.$inferSelect;

function toWire(row: Row): ComplianceControlSetting {
  return {
    frameworkId: row.frameworkId,
    controlId: row.controlId,
    applicable: row.applicable,
    justification: row.justification,
    ownerUserId: row.ownerUserId,
    ownerLabel: row.ownerLabel,
    notes: row.notes,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Throws a 404-shaped error unless the framework and control exist in the registry. */
export function requireControl(frameworkId: string, controlId: string): void {
  const framework = getComplianceFramework(frameworkId);
  if (!framework) throw new ComplianceInputError(`Unknown framework: ${frameworkId}`, 404);
  if (!framework.controls.some((c) => c.id === controlId)) {
    throw new ComplianceInputError(`Unknown control ${controlId} in ${framework.name}`, 404);
  }
}

export async function listComplianceControlSettings(
  organizationId: string,
  frameworkId?: string,
): Promise<ComplianceControlSetting[]> {
  const rows = await db
    .select()
    .from(complianceControlSettings)
    .where(
      frameworkId
        ? and(
            eq(complianceControlSettings.organizationId, organizationId),
            eq(complianceControlSettings.frameworkId, frameworkId),
          )
        : eq(complianceControlSettings.organizationId, organizationId),
    );
  return rows.map(toWire);
}

export async function getComplianceControlSetting(
  organizationId: string,
  frameworkId: string,
  controlId: string,
): Promise<ComplianceControlSetting | null> {
  requireControl(frameworkId, controlId);
  const [row] = await db
    .select()
    .from(complianceControlSettings)
    .where(
      and(
        eq(complianceControlSettings.organizationId, organizationId),
        eq(complianceControlSettings.frameworkId, frameworkId),
        eq(complianceControlSettings.controlId, controlId),
      ),
    )
    .limit(1);
  return row ? toWire(row) : null;
}

const trimOrNull = (v: string | null | undefined): string | null => {
  const t = v?.trim() ?? "";
  return t === "" ? null : t;
};

/** Upsert one control's decision. A full replace. */
export async function putComplianceControlSetting(
  organizationId: string,
  frameworkId: string,
  controlId: string,
  input: ComplianceControlSettingInput,
  updatedByUserId: string | null,
): Promise<ComplianceControlSetting> {
  requireControl(frameworkId, controlId);
  if (typeof input.applicable !== "boolean") {
    throw new ComplianceInputError("applicable must be a boolean");
  }
  const problem = validateComplianceControlSetting(input);
  if (problem) throw new ComplianceInputError(problem);

  const ownerUserId = trimOrNull(input.ownerUserId);
  if (ownerUserId) {
    // An owner must be a member now; once saved, leaving the org shows as
    // "Former member" rather than quietly unowning the control.
    const [member] = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, ownerUserId),
        ),
      )
      .limit(1);
    if (!member) throw new ComplianceInputError("The owner must be a member of this organization");
  }

  const now = new Date();
  const values = {
    applicable: input.applicable,
    justification: trimOrNull(input.justification),
    ownerUserId,
    ownerLabel: trimOrNull(input.ownerLabel),
    notes: trimOrNull(input.notes),
    updatedByUserId,
    updatedAt: now,
  };
  const [row] = await db
    .insert(complianceControlSettings)
    .values({ organizationId, frameworkId, controlId, ...values })
    .onConflictDoUpdate({
      target: [
        complianceControlSettings.organizationId,
        complianceControlSettings.frameworkId,
        complianceControlSettings.controlId,
      ],
      set: values,
    })
    .returning();
  return toWire(row!);
}

/** Back to the default (applicable, unowned). Returns false when nothing was stored. */
export async function deleteComplianceControlSetting(
  organizationId: string,
  frameworkId: string,
  controlId: string,
): Promise<boolean> {
  requireControl(frameworkId, controlId);
  const deleted = await db
    .delete(complianceControlSettings)
    .where(
      and(
        eq(complianceControlSettings.organizationId, organizationId),
        eq(complianceControlSettings.frameworkId, frameworkId),
        eq(complianceControlSettings.controlId, controlId),
      ),
    )
    .returning({ controlId: complianceControlSettings.controlId });
  return deleted.length > 0;
}

/** Display names for the members who own controls. */
export async function loadOwnerNames(
  organizationId: string,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, users.id),
        eq(organizationMembers.organizationId, organizationId),
      ),
    )
    .where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.displayName ?? r.email]));
}
