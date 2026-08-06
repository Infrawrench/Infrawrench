import type { ReactNode } from "react";
import { GeneralSection } from "./GeneralSection.js";
import { TeamSection } from "./TeamSection.js";
import { RolesSection } from "./RolesSection.js";
import { SshKeysSection } from "./SshKeysSection.js";
import { SshHostKeysSection } from "./SshHostKeysSection.js";
import { BastionsSection } from "./BastionsSection.js";
import { ApiKeysSection } from "./ApiKeysSection.js";
import { FreezesSection } from "./FreezesSection.js";
import { TagPolicySection } from "./TagPolicySection.js";
import { ApprovalsSection } from "./ApprovalsSection.js";
import { NotificationsSection } from "./NotificationsSection.js";
import { BillingSection } from "./BillingSection.js";
import { AuditLogSection } from "./AuditLogSection.js";

/**
 * Section key (the URL segment / workspace-tab `section`) → section component.
 * The desktop settings panel switches on this; web's routes render the same
 * components one per route file, so both stay in lockstep with
 * `SETTINGS_SECTIONS`.
 */
export function SettingsSectionBody({ section }: { section: string }): ReactNode {
  switch (section) {
    case "":
      return <GeneralSection />;
    case "team":
      return <TeamSection />;
    case "roles":
      return <RolesSection />;
    case "ssh-keys":
      return <SshKeysSection />;
    case "ssh-host-keys":
      return <SshHostKeysSection />;
    case "bastions":
      return <BastionsSection />;
    case "api-keys":
      return <ApiKeysSection />;
    case "freezes":
      return <FreezesSection />;
    case "tag-policy":
      return <TagPolicySection />;
    case "approvals":
      return <ApprovalsSection />;
    case "paging":
      return <NotificationsSection />;
    case "billing":
      return <BillingSection />;
    case "audit-log":
      return <AuditLogSection />;
    default:
      return <GeneralSection />;
  }
}
