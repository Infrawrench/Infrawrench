/**
 * Read/write side of `org_tag_key_settings`: the tag keys an org hides from
 * its pickers and the ones it pins to the top. A missing row reads as no
 * preferences, the `org_tag_policies` protocol.
 *
 * Validation lives at the API edge (`tagKeySettingsSchema` in
 * `@infrawrench/ui/cost/config` plus `tagKeySettingsError`); this module
 * normalizes as a last line of defence so a hand-written row still reads as a
 * well-formed document.
 */
import { eq } from "drizzle-orm";
import {
  DEFAULT_TAG_KEY_SETTINGS,
  normalizeTagKeySettings,
  type TagKeySettings,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgTagKeySettings } from "../db/schema";

export type { TagKeySettings };

/** The org's tag key settings; a missing row reads as no preferences. */
export async function getOrgTagKeySettings(organizationId: string): Promise<TagKeySettings> {
  const [row] = await db
    .select()
    .from(orgTagKeySettings)
    .where(eq(orgTagKeySettings.organizationId, organizationId));
  if (!row) return { hidden: [...DEFAULT_TAG_KEY_SETTINGS.hidden], preferred: [] };
  return normalizeTagKeySettings({ hidden: row.hiddenKeys, preferred: row.preferredKeys });
}

/** Save the org's tag key settings, creating the row on first use. */
export async function setOrgTagKeySettings(
  organizationId: string,
  settings: TagKeySettings,
  now = new Date(),
): Promise<TagKeySettings> {
  const safe = normalizeTagKeySettings(settings);
  const values = { hiddenKeys: safe.hidden, preferredKeys: safe.preferred };
  const [row] = await db
    .insert(orgTagKeySettings)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({
      target: orgTagKeySettings.organizationId,
      set: { ...values, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("Failed to save tag key settings");
  return normalizeTagKeySettings({ hidden: row.hiddenKeys, preferred: row.preferredKeys });
}
