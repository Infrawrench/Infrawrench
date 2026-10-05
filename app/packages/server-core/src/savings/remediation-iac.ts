import {
  terraformRemediationHint,
  type FindingRemediation,
  type RemediationFinding,
} from "@infrawrench/plugin-base";
import { lookupIacManagedAddresses, terraformCapabilityFor } from "../iac/service.js";

/** One finding whose remediation may gain a Terraform hint. */
export interface IacHintTarget {
  resourceId: string;
  pluginId: string;
  accountId: string;
  finding: Exclude<RemediationFinding, { kind: "idle-commitment" }>;
  remediation: FindingRemediation;
}

/**
 * Attach the Terraform hint to findings whose resource IaC reconciliation says
 * is managed: one batched reconciliation for the whole list, against the same
 * per-account (else org-wide) state the resource detail badge uses.
 *
 * Best-effort like the cost and owner annotations: an org with no uploaded
 * state, or a failure anywhere in here, leaves `iac: null`, which surfaces
 * read as "not known to be managed". The CLI commands are still right for a
 * resource Terraform does not manage, and still shown when it does, below the
 * hint.
 */
export async function attachIacHints(
  organizationId: string,
  targets: readonly IacHintTarget[],
): Promise<void> {
  if (targets.length === 0) return;
  let addresses: Awaited<ReturnType<typeof lookupIacManagedAddresses>>;
  try {
    addresses = await lookupIacManagedAddresses(
      organizationId,
      targets.map((t) => t.resourceId),
    );
  } catch (err) {
    console.error("[remediation] IaC lookup failed:", err);
    return;
  }
  if (addresses.size === 0) return;
  for (const target of targets) {
    const managed = addresses.get(target.resourceId);
    if (!managed) continue;
    try {
      target.remediation.iac = terraformRemediationHint({
        capability: await terraformCapabilityFor(target.pluginId),
        resource: {
          ...target.finding.resource,
          id: target.resourceId,
          pluginId: target.pluginId,
          accountId: target.accountId,
        },
        finding: target.finding,
        address: managed.address,
        stateLabel: managed.stateLabel,
      });
    } catch (err) {
      console.error("[remediation] Terraform hint failed:", err);
    }
  }
}
