/**
 * Every RPC group the desktop main process serves to the renderer, merged
 * into the one group the server and client are built from. One line per group.
 */
import { AppShellRpcs } from "./app-shell";
import { K8sLocalRpcs } from "./k8s-local";
import { LocalCredentialRpcs } from "./local-credentials";
import { LocalDatabaseRpcs } from "./local-database";
import { LocalSecretRpcs } from "./local-secrets";
import { LocalDeployHistoryRpcs } from "./deploy-history";
import { LocalDnsRpcs } from "./local-dns";
import { LocalEnvironmentDiffRpcs } from "./local-environment-diff";
import { LocalExpiringRpcs } from "./local-expiring";
import { LocalExtendedSupportRpcs } from "./local-extended-support";
import { LocalOrphansRpcs } from "./local-orphans";
import { LocalPostureRpcs } from "./local-posture";
import { ShellCommandRpcs } from "./shell-command";
import { SshRpcs } from "./ssh";
import { CloudAuthRpcs } from "./cloud-auth";
import { CloudChatRpcs } from "./cloud-chat";
import { CloudHttpRpcs } from "./cloud-http";
import { CloudSshKeyRpcs } from "./cloud-ssh-keys";
import { CloudSshRpcs } from "./cloud-ssh";
import { DeepLinkRpcs } from "./deep-links";
import { InstancePricingRpcs } from "./instance-pricing";
import { K8sPfCloudRpcs } from "./k8s-pf-cloud";
import { LinuxAppsRpcs } from "./linux-apps";
import { PluginDriverRpcs } from "./plugin-drivers";
import { ProviderOAuthRpcs } from "./provider-oauth";
import { WorkflowRpcs } from "./workflows";

export class DesktopRpcs extends ShellCommandRpcs.merge(
  AppShellRpcs,
  K8sLocalRpcs,
  LocalCredentialRpcs,
  LocalDatabaseRpcs,
  LocalSecretRpcs,
  LocalDeployHistoryRpcs,
  LocalDnsRpcs,
  LocalEnvironmentDiffRpcs,
  LocalExpiringRpcs,
  LocalExtendedSupportRpcs,
  LocalOrphansRpcs,
  LocalPostureRpcs,
  SshRpcs,
  CloudAuthRpcs,
  CloudChatRpcs,
  CloudHttpRpcs,
  CloudSshKeyRpcs,
  CloudSshRpcs,
  DeepLinkRpcs,
  InstancePricingRpcs,
  K8sPfCloudRpcs,
  LinuxAppsRpcs,
  PluginDriverRpcs,
  ProviderOAuthRpcs,
  WorkflowRpcs,
) {}
