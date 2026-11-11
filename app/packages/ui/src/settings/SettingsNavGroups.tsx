import { useGT, useMessages } from "gt-react";
import type { ProductId } from "@infrawrench/client-core";
import { ProductGlyph } from "../products/ProductIcon.js";
import { useProductCopy } from "../products/copy.js";
import { groupSettingsSections, type SettingsSectionDef } from "./sections.js";

interface SettingsNavGroupsProps {
  /** The caller's permission check. */
  has: (permission: string) => boolean;
  /** Apps the organization turned off: their settings are hidden with them. */
  disabledProducts?: readonly ProductId[] | undefined;
  /** Draws one section's link or button; navigation is the host's. */
  renderItem: (section: SettingsSectionDef, label: string) => React.ReactNode;
}

/**
 * The settings navigation: the organization's sections, then one headed group
 * per app. Shared so web's links and desktop's buttons cannot drift apart on
 * which section sits where.
 */
export function SettingsNavGroups({ has, disabledProducts, renderItem }: SettingsNavGroupsProps) {
  const gt = useGT();
  // Section labels are msg()-encoded in the registry; m() decodes + translates.
  const m = useMessages();
  const copy = useProductCopy();
  const groups = groupSettingsSections(has, disabledProducts);

  return (
    <>
      {groups.map((group) => (
        <div key={group.id} className="mb-4 last:mb-0">
          <h3 className="mb-1 flex items-center gap-1.5 px-3 text-[11px] font-medium uppercase tracking-wide text-on-surface-muted">
            {group.id !== "org" && <ProductGlyph product={group.id} size={12} />}
            {group.id === "org" ? gt("Organization") : copy[group.id].name}
          </h3>
          <ul className="space-y-1">
            {group.sections.map((section) => (
              <li key={section.key}>{renderItem(section, m(section.label))}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
