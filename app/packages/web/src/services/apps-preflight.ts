/**
 * "Can this host run applications, and can we make it able to?" — server side.
 *
 * Both halves are one SSH connection each, opened and closed here rather than
 * borrowed from the session: the point of the check is to answer on a host
 * where a session would fail, and the install has to happen before one is
 * started.
 *
 * The install is deliberately narrow. The caller names which *requirements* to
 * satisfy, never a command — the commands come from `planInstall` in
 * `@infrawrench/appstream-host`, from a probe this server just ran. There is no
 * shape of request that turns this into "run something as root over there".
 */

import {
  checkHost,
  installRequirements,
  planInstall,
  probeHost,
  type HostRequirementsCheck,
  type InstallOutcome,
  type RequirementId,
} from "@infrawrench/appstream-host";

import { logAudit } from "@/services/audit";
import { connectAppsHost, type AppsHostTarget } from "@/services/apps-host";

/** Look at the host and say what it is missing. Changes nothing. */
export async function checkAppsHost(target: AppsHostTarget): Promise<HostRequirementsCheck> {
  const client = await connectAppsHost(target);
  try {
    return await checkHost(client);
  } finally {
    client.end();
  }
}

export interface AppsInstallParams extends AppsHostTarget {
  userId?: string;
  accountId: string;
  resourceId: string;
  /** Which requirements to satisfy. Omitted means every missing required one. */
  include?: RequirementId[];
  /** Each line of the package manager's output, as it arrives. */
  onOutput?: (line: string) => void;
}

/**
 * Install what is missing, then look again and report what the host now is.
 *
 * Audited whether or not it succeeds: this changes the state of a machine the
 * customer owns, which is exactly the kind of thing someone comes looking for
 * in the audit log six months later. The entry names the packages rather than
 * the requirement ids, because "why is dbus installed on this box" is the
 * question it has to answer.
 */
export async function installAppsHostRequirements(
  params: AppsInstallParams,
): Promise<InstallOutcome> {
  const client = await connectAppsHost(params);
  try {
    const preflight = await probeHost(client);
    const plan = planInstall(preflight, params.include ? { include: params.include } : {});
    if (!plan) return { log: [], failed: [], preflight };

    for (const command of plan.commands) params.onOutput?.(`$ ${command}`);
    const outcome = await installRequirements(client, plan, {
      ...(params.onOutput ? { onOutput: params.onOutput } : {}),
    });

    await logAudit({
      organizationId: params.organizationId,
      ...(params.userId ? { userId: params.userId } : {}),
      action: "linux_app.host_setup",
      entityType: "resource",
      entityId: params.resourceId,
      metadata: {
        accountId: params.accountId,
        host: params.host,
        packageManager: plan.packageManager,
        packages: plan.packages,
        failed: outcome.failed,
        ready: outcome.preflight.ready,
      },
    });

    return outcome;
  } finally {
    client.end();
  }
}
