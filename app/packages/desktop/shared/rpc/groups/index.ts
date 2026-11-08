/**
 * Every RPC group the desktop main process serves to the renderer, merged
 * into the one group the server and client are built from. One line per group.
 */
import { LocalDeployHistoryRpcs } from "./deploy-history";
import { LocalDnsRpcs } from "./local-dns";
import { LocalEnvironmentDiffRpcs } from "./local-environment-diff";
import { LocalExpiringRpcs } from "./local-expiring";
import { LocalExtendedSupportRpcs } from "./local-extended-support";
import { LocalOrphansRpcs } from "./local-orphans";
import { LocalPostureRpcs } from "./local-posture";
import { ShellCommandRpcs } from "./shell-command";
import { SshRpcs } from "./ssh";

export class DesktopRpcs extends ShellCommandRpcs.merge(
  LocalDeployHistoryRpcs,
  LocalDnsRpcs,
  LocalEnvironmentDiffRpcs,
  LocalExpiringRpcs,
  LocalExtendedSupportRpcs,
  LocalOrphansRpcs,
  LocalPostureRpcs,
  SshRpcs,
) {}
