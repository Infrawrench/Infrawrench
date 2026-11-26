/**
 * The `backend "http"` block for someone running Terraform on their own
 * machine: an administrator of the repository, with a personal access token
 * that has `repo:write`. The same text as `backendConfiguration` in
 * `@infrawrench/git-terraform` (`pipeline/generate.ts`), which this package
 * does not depend on: change the two together.
 */
export function backendConfiguration(stateUrl: string, username: string): string {
  const q = (value: string) => JSON.stringify(value);
  return [
    "terraform {",
    '  backend "http" {',
    `    address        = ${q(stateUrl)}`,
    `    lock_address   = ${q(`${stateUrl}/lock`)}`,
    `    unlock_address = ${q(`${stateUrl}/lock`)}`,
    '    lock_method    = "POST"',
    '    unlock_method  = "DELETE"',
    `    username       = ${q(username)}`,
    "    # password: a personal access token, in TF_HTTP_PASSWORD",
    "  }",
    "}",
    "",
  ].join("\n");
}

/** `acme/infra` + `environments/staging` suggests `staging`; the root itself suggests `default`. */
export function suggestWorkspaceName(rootPath: string, taken: ReadonlyArray<string>): string {
  const last = rootPath.split("/").filter(Boolean).pop() ?? "default";
  const base =
    last
      .slice(0, 252)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 63) || "default";
  if (!taken.includes(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** The contract's rule for a workspace's name. */
export const WORKSPACE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const WORKSPACE_NAME_RULE =
  "Lowercase letters, digits, dashes and underscores, starting with a letter or digit";
