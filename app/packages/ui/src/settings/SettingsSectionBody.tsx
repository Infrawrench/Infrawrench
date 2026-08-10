import type { ReactNode } from "react";
import { GeneralSection } from "./GeneralSection.js";
import { TeamSection } from "./TeamSection.js";
import { RolesSection } from "./RolesSection.js";
import { AccessRequestsSection } from "./AccessRequestsSection.js";
import { SshKeysSection } from "./SshKeysSection.js";
import { SshHostKeysSection } from "./SshHostKeysSection.js";
import { SessionRecordingsSection } from "./SessionRecordingsSection.js";
import { BastionsSection } from "./BastionsSection.js";
import { ApiKeysSection } from "./ApiKeysSection.js";
import { CredentialHygieneSection } from "./CredentialHygieneSection.js";
import { FreezesSection } from "./FreezesSection.js";
import { TagPolicySection } from "./TagPolicySection.js";
import { ConfigAsCodeSection } from "./ConfigAsCodeSection.js";
import { CurrencySection } from "./CurrencySection.js";
import { CostExportsSection } from "./CostExportsSection.js";
import { ApprovalsSection } from "./ApprovalsSection.js";
import { NotificationsSection } from "./NotificationsSection.js";
import { JiraSection } from "./JiraSection.js";
import { LinearSection } from "./LinearSection.js";
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
    case "access-requests":
      return <AccessRequestsSection />;
    case "ssh-keys":
      return <SshKeysSection />;
    case "ssh-host-keys":
      return <SshHostKeysSection />;
    case "session-recordings":
      return <SessionRecordingsSection />;
    case "bastions":
      return <BastionsSection />;
    case "api-keys":
      return <ApiKeysSection />;
    case "credential-hygiene":
      return <CredentialHygieneSection />;
    case "freezes":
      return <FreezesSection />;
    case "tag-policy":
      return <TagPolicySection />;
    case "config":
      return <ConfigAsCodeSection />;
    case "currency":
      return <CurrencySection />;
    case "cost-exports":
      return <CostExportsSection />;
    case "approvals":
      return <ApprovalsSection />;
    case "paging":
      return <NotificationsSection />;
    case "jira":
      return <JiraSection />;
    case "linear":
      return <LinearSection />;
    case "billing":
      return <BillingSection />;
    case "audit-log":
      return <AuditLogSection />;
    default:
      return <GeneralSection />;
  }
}
