import type { RemediationCommand, RemediationFinding } from "@infrawrench/plugin-base";

/**
 * Remediation for Docker Hub savings findings (a never-pulled repository, an
 * inactive tag).
 *
 * Deliberately empty. Neither fix has a verifiable command: the Docker CLI has
 * no repository or tag delete, `hub-tool` (the experimental Hub CLI that had
 * `repo rm` / `tag rm`) is archived, and the published Docker Hub API reference
 * (https://docs.docker.com/reference/api/hub/latest/) documents no DELETE for a
 * repository or a tag. The routes this plugin's own delete calls are
 * undocumented, so they are not offered as paste-ready commands; the finding
 * keeps its in-app Delete action. Revisit when Docker documents them.
 */
export function dockerHubRemediationCommands(_finding: RemediationFinding): RemediationCommand[] {
  return [];
}
