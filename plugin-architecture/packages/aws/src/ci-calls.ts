/**
 * What the CI executors call AWS through, so each can be tested against a
 * fake with no network. `AWSClient` binds them to the connection's keys.
 */
import type { CiMissingPermission } from "@infrawrench/plugin-base";

import type { Ec2Call } from "./ci-executor.js";

/** One AWS JSON 1.1 call (`X-Amz-Target`) to `service` in `region`. */
export type AwsJsonCall = <T>(
  region: string,
  service: string,
  target: string,
  body: object,
) => Promise<T>;

/** One Query API call to a global service (IAM). */
export type AwsQueryCall = <T>(
  service: string,
  action: string,
  version: string,
  params?: Record<string, string>,
) => Promise<T>;

export interface AwsCiCalls {
  ec2: Ec2Call;
  json: AwsJsonCall;
  query: AwsQueryCall;
  /**
   * Whether the credential may call each action, from IAM's policy
   * simulator, or null when it may not run the simulator.
   */
  simulate(
    actions: readonly string[],
    resource?: (account: string) => string,
  ): Promise<Map<string, boolean> | null>;
  /** Waits between retries; a test passes one that does not. */
  sleep?(ms: number): Promise<void>;
}

/** The simulator's permission, named when it is what stops a check. */
export const SIMULATE_PERMISSION = {
  permission: "iam:SimulatePrincipalPolicy",
  label: "Check the other permissions (this kind's writes have no dry run)",
} as const satisfies CiMissingPermission;

/**
 * Which of `needed` the credential lacks, by the policy simulator. ECS,
 * CodeBuild and IAM writes have no dry run, so without the simulator the
 * check cannot vouch for them: it names the simulator's own permission.
 */
export async function awsCiPermissionCheck(
  calls: AwsCiCalls,
  needed: readonly CiMissingPermission[],
  resource?: (account: string) => string,
): Promise<{ missing: CiMissingPermission[]; problems: string[] }> {
  let verdicts: Map<string, boolean> | null;
  try {
    verdicts = await calls.simulate(
      needed.map((p) => p.permission),
      resource,
    );
  } catch (err) {
    return {
      missing: [],
      problems: [
        `AWS did not answer a permission check: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  if (!verdicts) return { missing: [SIMULATE_PERMISSION], problems: [] };
  return { missing: needed.filter((p) => verdicts.get(p.permission) !== true), problems: [] };
}
