import type { CredentialExport, ResourceInstance } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { jsonCall, jsonGetCall } from "./client-transport.js";

interface ResolveOutputContext {
  /** Home/default creds — used only for global services. */
  creds: AwsCredentials;
  /** Build creds scoped to a specific region — use this for regional services. */
  credsFor(region: string): AwsCredentials;
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
  exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport>;
}

export async function resolveOutput(
  ctx: ResolveOutputContext,
  typeId: string,
  resourceId: string,
  outputKey: string,
  accountId: string,
): Promise<string> {
  if (
    typeId === "acm-certificate" &&
    (outputKey === "dnsRecords" || outputKey === "domainValidationStatus")
  ) {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const externalId = resource.externalId;
    if (!externalId) return "";
    const region = String(resource.fields["region"] ?? ctx.creds.region);
    const creds = ctx.credsFor(region);
    try {
      const detail = await jsonCall<{ Certificate?: Record<string, unknown> }>(
        creds,
        "acm",
        "CertificateManager.DescribeCertificate",
        {
          CertificateArn: externalId,
        },
      );
      const cert = detail.Certificate;
      if (!cert) return "";
      if (outputKey === "dnsRecords") {
        const domainValidationOptions = cert["DomainValidationOptions"] as
          | Record<string, unknown>[]
          | undefined;
        if (!domainValidationOptions) return "";
        const records = domainValidationOptions
          .map((dvo) => {
            const resourceRecord = dvo["ResourceRecord"] as Record<string, unknown> | undefined;
            if (!resourceRecord) return null;
            const name = resourceRecord["Name"] ?? "";
            const recordType = resourceRecord["Type"] ?? "CNAME";
            const value = resourceRecord["Value"] ?? "";
            if (!name) return null;
            return `${recordType} ${name} -> ${value}`;
          })
          .filter(Boolean);
        return records.join("\n");
      }
      if (outputKey === "domainValidationStatus") {
        const domainValidationOptions = cert["DomainValidationOptions"] as
          | Record<string, unknown>[]
          | undefined;
        if (!domainValidationOptions) return "";
        return domainValidationOptions
          .map((dvo) => {
            const domain = dvo["DomainName"] ?? "";
            const status = dvo["ValidationStatus"] ?? "";
            const method = dvo["ValidationMethod"] ?? "";
            return `${domain} (${method}): ${status}`;
          })
          .join("\n");
      }
    } catch {
      return "";
    }
  }
  if (typeId === "iam-user" && outputKey === "accessKey") {
    const exp = await ctx.exportCredential(typeId, resourceId, accountId, "access-key");
    return exp.content;
  }
  if (typeId === "msk-cluster" && outputKey === "bootstrapBrokers") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const arn = String(resource.resolvedOutputs["clusterArn"] ?? "");
    if (!arn) return "";
    const region = String(resource.fields["region"] ?? ctx.creds.region);
    const creds = ctx.credsFor(region);
    try {
      const detail = await jsonGetCall<{
        BootstrapBrokerString?: string;
        BootstrapBrokerStringTls?: string;
        BootstrapBrokerStringSaslScram?: string;
        BootstrapBrokerStringSaslIam?: string;
        BootstrapBrokerStringPublicSaslScram?: string;
        BootstrapBrokerStringPublicSaslIam?: string;
      }>(creds, "kafka", `/v1/clusters/${encodeURIComponent(arn)}/bootstrap-brokers`);
      // Prefer SCRAM (kafkajs can speak it) → TLS-only → public variants → IAM (informational).
      return (
        detail.BootstrapBrokerStringSaslScram ??
        detail.BootstrapBrokerStringPublicSaslScram ??
        detail.BootstrapBrokerStringTls ??
        detail.BootstrapBrokerString ??
        detail.BootstrapBrokerStringSaslIam ??
        detail.BootstrapBrokerStringPublicSaslIam ??
        ""
      );
    } catch {
      return "";
    }
  }
  const resource = await ctx.getResource(typeId, resourceId, accountId);
  const value = resource.resolvedOutputs[outputKey];
  if (value === undefined) {
    throw new Error(`AWS plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }
  return String(value);
}
