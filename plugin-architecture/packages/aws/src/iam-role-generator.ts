/**
 * Generic helper for minting a fresh IAM role from inside a create form. The
 * caller declares only the trust-policy principal (e.g. "lambda.amazonaws.com")
 * and the managed-policy ARNs to attach — everything else (a unique name,
 * waiting for IAM eventual-consistency, error handling) lives here so every
 * resource type that needs an execution / service role can share it.
 */

import type { AwsCredentials } from "./auth.js";
import { queryPostCall } from "./client-transport.js";

export interface GenerateServiceRoleRequest {
  /** Principal AWS service that's allowed to assume the role, e.g. `lambda.amazonaws.com`. */
  principalService: string | string[];
  /** Managed-policy ARNs to attach (AWS-managed or customer-managed). */
  managedPolicyArns: string[];
  /** Stable prefix used to build the role name. A timestamp suffix is appended. */
  namePrefix: string;
  /** Optional human description set on the role. */
  description?: string;
}

export interface GenerateServiceRoleResult {
  roleName: string;
  roleArn: string;
}

function trustPolicy(principalService: string | string[]): string {
  const services = Array.isArray(principalService) ? principalService : [principalService];
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: services.length === 1 ? services[0] : services },
        Action: "sts:AssumeRole",
      },
    ],
  });
}

/**
 * Build a deterministic-ish role name: `<prefix><6 random chars>`. IAM role
 * names cap at 64 chars; we keep prefixes short so callers don't have to.
 */
function generateRoleName(namePrefix: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `${namePrefix}${suffix}`;
  return name.slice(0, 64);
}

/**
 * IAM is eventually consistent — a freshly-created role often returns
 * `iam:PassRole` denial errors for several seconds when used by another
 * service. Sleep briefly so the caller can immediately use the new role in
 * a downstream create call.
 */
async function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateServiceRole(
  creds: AwsCredentials,
  request: GenerateServiceRoleRequest,
): Promise<GenerateServiceRoleResult> {
  const roleName = generateRoleName(request.namePrefix);

  const createParams: Record<string, string> = {
    RoleName: roleName,
    AssumeRolePolicyDocument: trustPolicy(request.principalService),
  };
  if (request.description) createParams["Description"] = request.description;

  const data = await queryPostCall<Record<string, unknown>>(
    creds,
    "iam",
    "CreateRole",
    "2010-05-08",
    createParams,
  );
  const createResult = data["CreateRoleResult"] as Record<string, unknown> | undefined;
  const role = (createResult?.["Role"] as Record<string, unknown>) ?? {};
  const roleArn = String(role["Arn"] ?? "");
  if (!roleArn) {
    throw new Error("IAM CreateRole did not return an Arn");
  }

  if (request.managedPolicyArns.length > 0) {
    await Promise.all(
      request.managedPolicyArns.map((arn) =>
        queryPostCall<Record<string, unknown>>(creds, "iam", "AttachRolePolicy", "2010-05-08", {
          RoleName: roleName,
          PolicyArn: arn,
        }),
      ),
    );
  }

  // Let IAM replicate so the caller's PassRole succeeds.
  await settle(8000);

  return { roleName, roleArn };
}
