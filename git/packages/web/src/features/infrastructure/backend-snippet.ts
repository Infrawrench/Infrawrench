/**
 * The `backend "http"` block for someone running Terraform on their own
 * machine. The same text as `backendConfiguration` in
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
  const base = last.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "default";
  if (!taken.includes(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
