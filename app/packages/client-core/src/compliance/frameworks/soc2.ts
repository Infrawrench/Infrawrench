/**
 * SOC 2: the AICPA Trust Services Criteria (2017 edition; the 2022 revision
 * changed only the points of focus, not the criteria or their ids).
 *
 * Only the criteria Infrawrench collects evidence for are listed. Titles are
 * paraphrases; see `types.ts`.
 */
import type { ComplianceFrameworkDefinition } from "./types";

const CC4 = "CC4 Monitoring activities";
const CC6 = "CC6 Logical and physical access";
const CC7 = "CC7 System operations";
const CC8 = "CC8 Change management";
const CC9 = "CC9 Risk mitigation";
const A1 = "A1 Availability";

export const SOC2_FRAMEWORK: ComplianceFrameworkDefinition = {
  id: "soc2",
  name: "SOC 2",
  version: "Trust Services Criteria (2017, revised points of focus 2022)",
  description:
    "The Security common criteria plus the Availability criteria, for the controls an infrastructure platform can evidence.",
  scopeNote:
    "Covers the criteria Infrawrench holds evidence for. Control environment, risk assessment, communication and physical security criteria need evidence from outside this product.",
  controls: [
    {
      id: "CC4.1",
      title: "Ongoing evaluations confirm that controls are present and working",
      group: CC4,
      sources: ["posture", "access-review", "restore-drills", "scorecards"],
    },
    {
      id: "CC6.1",
      title: "Logical access security protects information assets",
      group: CC6,
      sources: ["access-review", "posture", "session-recordings", "leaked-credentials"],
    },
    {
      id: "CC6.2",
      title: "Users are registered and authorized before access is granted",
      group: CC6,
      sources: ["jit-access", "audit-log"],
    },
    {
      id: "CC6.3",
      title: "Access follows least privilege and is changed or removed when no longer needed",
      group: CC6,
      sources: ["access-review", "jit-access"],
    },
    {
      id: "CC6.6",
      title: "Systems are protected against threats from outside the system boundary",
      group: CC6,
      sources: ["posture"],
    },
    {
      id: "CC6.7",
      title: "Data in transit and at rest is restricted and protected",
      group: CC6,
      sources: ["posture"],
    },
    {
      id: "CC6.8",
      title: "Unauthorized or malicious software is prevented or detected",
      group: CC6,
      sources: ["vulnerabilities"],
    },
    {
      id: "CC7.1",
      title: "Configuration changes and newly discovered vulnerabilities are detected",
      group: CC7,
      sources: ["vulnerabilities", "posture", "change-timeline"],
    },
    {
      id: "CC7.2",
      title: "System components are monitored for anomalous activity",
      group: CC7,
      sources: ["audit-log", "session-recordings", "change-timeline", "scorecards"],
    },
    {
      id: "CC7.3",
      title: "Security events are evaluated to decide whether they are incidents",
      group: CC7,
      sources: ["incidents", "leaked-credentials"],
    },
    {
      id: "CC7.4",
      title: "Incidents are responded to through a defined process",
      group: CC7,
      sources: ["incidents", "change-freezes", "leaked-credentials"],
    },
    {
      id: "CC7.5",
      title: "Recovery from incidents is carried out and tested",
      group: CC7,
      sources: ["incidents", "restore-drills"],
    },
    {
      id: "CC8.1",
      title: "Changes are authorized, tracked, approved and implemented in a controlled way",
      group: CC8,
      sources: ["change-timeline", "change-freezes", "audit-log"],
    },
    {
      id: "CC9.1",
      title: "Risks from business disruption are identified and mitigated",
      group: CC9,
      sources: ["backup-coverage", "restore-drills"],
    },
    {
      id: "A1.2",
      title: "Backup and recovery infrastructure is in place and monitored",
      group: A1,
      sources: ["backup-coverage"],
    },
    {
      id: "A1.3",
      title: "Recovery procedures are tested",
      group: A1,
      sources: ["restore-drills"],
    },
  ],
};
