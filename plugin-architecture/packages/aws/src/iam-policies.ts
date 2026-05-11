import type { PolicyOption } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { ensureArray } from "./auth.js";
import { ec2QueryCall } from "./client-transport.js";

/**
 * Paginate IAM ListPolicies for a given scope ("AWS" | "Local" | "All").
 * Returns a flat list of policy objects (Arn, PolicyName, Description, Path).
 */
export async function listAllIAMPolicies(
  creds: AwsCredentials,
  scope: "AWS" | "Local" | "All",
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  let marker: string | undefined;
  for (let i = 0; i < 20; i++) {
    const params: Record<string, string> = { Scope: scope, MaxItems: "1000" };
    if (marker) params["Marker"] = marker;
    const data = await ec2QueryCall<Record<string, unknown>>(
      creds,
      "iam",
      "ListPolicies",
      "2010-05-08",
      params,
    );
    const result = data["ListPoliciesResult"] as Record<string, unknown> | undefined;
    const policies = ensureArray(
      (result?.["Policies"] as Record<string, unknown> | undefined)?.["member"],
    ) as Array<Record<string, unknown>>;
    all.push(...policies);
    const truncated = String(result?.["IsTruncated"] ?? "false") === "true";
    if (!truncated) break;
    marker = result?.["Marker"] ? String(result["Marker"]) : undefined;
    if (!marker) break;
  }
  return all;
}

/** Convert IAM ListPolicies output into PolicyOption[] sorted by label. */
export function policiesToOptions(
  raw: Array<Record<string, unknown>>,
  category: string,
): PolicyOption[] {
  const options: PolicyOption[] = raw
    .map((p) => {
      const arn = String(p["Arn"] ?? "");
      const name = String(p["PolicyName"] ?? arn);
      const option: PolicyOption = { id: arn, label: name, category };
      if (p["Description"]) option.description = String(p["Description"]);
      return option;
    })
    .filter((o) => o.id.length > 0);
  options.sort((a, b) => a.label.localeCompare(b.label));
  return options;
}
