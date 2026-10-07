import {
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Supabase savings findings. The Supabase CLI has no pause or
 * restore (`supabase projects` is only api-keys, create, delete and list), so
 * a project's sleep schedule is `curl` against the Management API with a
 * personal access token, the same routes this plugin's own actions call.
 *
 * References (verified 2026-10):
 * https://supabase.com/docs/reference/cli/supabase-projects
 * https://supabase.com/docs/reference/api/v1-pause-a-project
 * https://supabase.com/docs/reference/api/v1-restore-a-project
 */
export function supabaseRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "sleep-schedule") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== "supabase-project") return [];
  const ref = remediationId(resource);
  if (!ref || ref.includes("/")) return [];
  const base = `https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}`;
  return [
    curl(
      `${base}/pause`,
      "Pause the project; its database and services stop until it is restored.",
    ),
    curl(`${base}/restore`, "Restore the paused project."),
  ];
}

const ACCESS_TOKEN: RemediationPlaceholder = {
  name: "SUPABASE_ACCESS_TOKEN",
  description: "A Supabase personal access token with access to this project",
};

/** A POST with no body. The ref is percent-encoded, so nothing in the URL is shell syntax. */
function curl(url: string, description: string): RemediationCommand {
  return {
    tool: "curl",
    command: `curl -sS -X POST ${shellQuote(url)} -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"`,
    description,
    destructive: false,
    placeholders: [ACCESS_TOKEN],
  };
}
