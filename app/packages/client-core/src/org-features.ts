/**
 * Features a platform admin turns on per organization (`/admin`), for work
 * that is being rolled out to chosen organizations before everyone. The
 * server refuses a gated feature's routes for an organization without it,
 * and both apps hide its entry points.
 */
export const ORG_FEATURES = ["ci"] as const;

export type OrgFeature = (typeof ORG_FEATURES)[number];

export function isOrgFeature(value: string): value is OrgFeature {
  return (ORG_FEATURES as readonly string[]).includes(value);
}
