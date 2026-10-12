/**
 * ISO/IEC 27001:2022 Annex A (93 controls in four themes: 5 organizational,
 * 6 people, 7 physical, 8 technological).
 *
 * Only the controls Infrawrench collects evidence for are listed. Titles are
 * paraphrases; see `types.ts`.
 */
import type { ComplianceFrameworkDefinition } from "./types";

const ORG = "5 Organizational controls";
const TECH = "8 Technological controls";

export const ISO27001_FRAMEWORK: ComplianceFrameworkDefinition = {
  id: "iso27001",
  name: "ISO/IEC 27001",
  version: "2022, Annex A",
  description:
    "Annex A organizational and technological controls that an infrastructure platform can evidence, for a statement of applicability.",
  scopeNote:
    "Covers the Annex A controls Infrawrench holds evidence for. People and physical controls, and the management-system clauses, need evidence from outside this product.",
  controls: [
    {
      id: "5.15",
      title: "Access to information and systems is governed by rules",
      group: ORG,
      sources: ["access-review", "posture"],
    },
    {
      id: "5.16",
      title: "Identities are managed across their lifecycle",
      group: ORG,
      sources: ["access-review"],
    },
    {
      id: "5.17",
      title: "Authentication secrets are allocated and rotated under control",
      group: ORG,
      sources: ["access-review", "posture", "leaked-credentials"],
    },
    {
      id: "5.18",
      title: "Access rights are granted, reviewed and removed",
      group: ORG,
      sources: ["access-review", "jit-access"],
    },
    {
      id: "5.24",
      title: "Incident management is planned and prepared",
      group: ORG,
      sources: ["incidents"],
    },
    {
      id: "5.25",
      title: "Security events are assessed and classified",
      group: ORG,
      sources: ["incidents", "leaked-credentials"],
    },
    {
      id: "5.26",
      title: "Incidents are responded to",
      group: ORG,
      sources: ["incidents", "change-freezes", "leaked-credentials"],
    },
    {
      id: "5.27",
      title: "Lessons are drawn from incidents",
      group: ORG,
      sources: ["incidents"],
    },
    {
      id: "5.28",
      title: "Evidence of events is collected and preserved",
      group: ORG,
      sources: ["audit-log", "session-recordings"],
    },
    {
      id: "5.30",
      title: "Systems are ready to support business continuity",
      group: ORG,
      sources: ["backup-coverage", "restore-drills"],
    },
    {
      id: "5.37",
      title: "Operating procedures are documented and available",
      group: ORG,
      sources: ["scorecards"],
    },
    {
      id: "8.2",
      title: "Privileged access is restricted and managed",
      group: TECH,
      sources: ["access-review", "jit-access", "session-recordings"],
    },
    {
      id: "8.5",
      title: "Authentication is secure",
      group: TECH,
      sources: ["access-review"],
    },
    {
      id: "8.8",
      title: "Technical vulnerabilities are identified and remediated",
      group: TECH,
      sources: ["vulnerabilities"],
    },
    {
      id: "8.9",
      title: "Configurations are established, monitored and reviewed",
      group: TECH,
      sources: ["posture", "change-timeline"],
    },
    {
      id: "8.12",
      title: "Leakage of sensitive information is prevented and detected",
      group: TECH,
      sources: ["leaked-credentials", "posture"],
    },
    {
      id: "8.13",
      title: "Backups are kept and restores are tested",
      group: TECH,
      sources: ["backup-coverage", "restore-drills"],
    },
    {
      id: "8.15",
      title: "Activity is logged and logs are protected",
      group: TECH,
      sources: ["audit-log", "session-recordings"],
    },
    {
      id: "8.16",
      title: "Systems are monitored for anomalous behaviour",
      group: TECH,
      sources: ["change-timeline", "audit-log", "scorecards"],
    },
    {
      id: "8.20",
      title: "Networks are secured and controlled",
      group: TECH,
      sources: ["posture"],
    },
    {
      id: "8.24",
      title: "Cryptography is used to protect information",
      group: TECH,
      sources: ["posture"],
    },
    {
      id: "8.32",
      title: "Changes are subject to change management",
      group: TECH,
      sources: ["change-timeline", "change-freezes", "audit-log"],
    },
  ],
};
