import {
  remediationDateStamp,
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Algolia savings findings, written for the official Algolia
 * CLI (`algolia`), which reads its credentials from the environment.
 *
 * - An empty primary index with no replicas (orphan): save its settings, then
 *   delete it.
 * - A crawler on a sleep schedule: pause it, run (resume) it again.
 *
 * References:
 * https://www.algolia.com/doc/tools/cli/commands/indices/delete
 * https://www.algolia.com/doc/tools/cli/commands/settings/get
 * https://www.algolia.com/doc/tools/cli/commands/crawler/pause
 * https://www.algolia.com/doc/tools/cli/commands/crawler/run
 * https://www.algolia.com/doc/tools/cli/automation (environment variables)
 */
export function algoliaRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "orphan" && finding.resource.resourceTypeId === "index") {
    const name = finding.resource.externalId?.trim() || remediationField(finding.resource, "name");
    if (!name) return [];
    const backup = `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}-settings-${remediationDateStamp()}.json`;
    return [
      {
        tool: "algolia",
        command: `algolia settings get ${shellQuote(name)} > ${shellQuote(backup)}`,
        description: "Save the index settings to a file so the index can be recreated.",
        destructive: false,
        placeholders: SEARCH,
      },
      {
        tool: "algolia",
        command: `algolia indices delete ${shellQuote(name)} --confirm`,
        description: "Delete the empty index and its settings.",
        destructive: true,
        placeholders: SEARCH,
      },
    ];
  }

  if (finding.kind === "sleep-schedule" && finding.resource.resourceTypeId === "crawler") {
    const id =
      remediationField(finding.resource, "crawlerId") || (finding.resource.externalId ?? "").trim();
    if (!id) return [];
    return [
      {
        tool: "algolia",
        command: `algolia crawler pause ${shellQuote(id)}`,
        description: "Pause the crawler.",
        destructive: false,
        placeholders: CRAWLER,
      },
      {
        tool: "algolia",
        command: `algolia crawler run ${shellQuote(id)}`,
        description: "Resume the crawler.",
        destructive: false,
        placeholders: CRAWLER,
      },
    ];
  }

  return [];
}

const SEARCH: RemediationPlaceholder[] = [
  { name: "ALGOLIA_APPLICATION_ID", description: "The Algolia application id" },
  { name: "ALGOLIA_API_KEY", description: "An Algolia API key with deleteIndex and settings ACLs" },
];

const CRAWLER: RemediationPlaceholder[] = [
  { name: "ALGOLIA_CRAWLER_USER_ID", description: "The Algolia Crawler user id" },
  { name: "ALGOLIA_CRAWLER_API_KEY", description: "The Algolia Crawler API key" },
];
