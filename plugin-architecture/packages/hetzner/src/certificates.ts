import {
  pathEncode,
  type CreateResourceConfig,
  type ResourceInstance,
} from "@infrawrench/plugin-base";
import { trailingId, type CloudApi, type CloudResponse } from "./api.js";

/**
 * Load Balancer TLS certificates (`/certificates`). Two kinds: `uploaded`
 * (a PEM chain + key the user brings) and `managed` (Hetzner issues and
 * renews a Let's Encrypt certificate, which requires the domains to be on
 * Hetzner DNS).
 */

type HetznerCertificate = CloudResponse<"list_certificates">["certificates"][number];

export function mapCertificate(c: HetznerCertificate, accountId: string): ResourceInstance {
  const created = c.created ?? new Date().toISOString();
  return {
    id: `${accountId}:certificate:${c.id}`,
    pluginId: "hetzner",
    resourceTypeId: "certificate",
    accountId,
    displayName: c.name,
    fields: {
      name: c.name,
      type: c.type ?? "uploaded",
      domainNames: (c.domain_names ?? []).join(", "),
      issuanceStatus: c.status?.issuance ?? "",
      renewalStatus: c.status?.renewal ?? "",
      statusError: c.status?.error?.message ?? "",
      notValidBefore: c.not_valid_before ?? "",
      notValidAfter: c.not_valid_after ?? "",
      fingerprint: c.fingerprint ?? "",
      usedByLoadBalancerIds: (c.used_by ?? [])
        .filter((u) => u.type === "load_balancer")
        .map((u) => String(u.id))
        .join(", "),
    },
    resolvedOutputs: { certificateId: String(c.id) },
    secretStates: [],
    externalId: String(c.id),
    createdAt: created,
    updatedAt: created,
  };
}

export async function listCertificates(
  cloud: CloudApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const certs = await cloud.getAll("/certificates", "certificates");
  return certs.map((c) => mapCertificate(c, accountId));
}

export function certificateCreateConfig(): CreateResourceConfig {
  return {
    fields: [
      { key: "name", label: "Name", kind: "text", required: true },
      {
        key: "type",
        label: "Type",
        kind: "select",
        required: true,
        defaultValue: "managed",
        options: [
          { id: "managed", label: "Managed (Let's Encrypt, auto-renewed)" },
          { id: "uploaded", label: "Upload my own" },
        ],
      },
      {
        key: "domainNames",
        label: "Domains",
        kind: "string-list",
        required: false,
        description:
          "Domains to issue for, e.g. example.com and *.example.com. They must be hosted on Hetzner DNS",
        showWhen: { fieldKey: "type", fieldValue: "managed" },
      },
      {
        key: "certificate",
        label: "Certificate (PEM)",
        kind: "code",
        codeLanguage: "text",
        required: false,
        description: "The certificate chain in PEM format, leaf first (at most 5 certificates)",
        showWhen: { fieldKey: "type", fieldValue: "uploaded" },
      },
      {
        key: "privateKey",
        label: "Private Key (PEM)",
        kind: "code",
        codeLanguage: "text",
        required: false,
        description: "RSA 2048/3072/4096 or ECDSA P-256/P-384",
        showWhen: { fieldKey: "type", fieldValue: "uploaded" },
      },
    ],
  };
}

export async function createCertificate(
  cloud: CloudApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  if (fields["type"] === "uploaded") {
    if (!fields["certificate"] || !fields["privateKey"]) {
      throw new Error("Hetzner plugin: an uploaded certificate needs a certificate and a key");
    }
    const data = await cloud.post("/certificates", {
      body: {
        name: fields["name"],
        type: "uploaded",
        certificate: fields["certificate"],
        private_key: fields["privateKey"],
      },
    });
    return mapCertificate(data.certificate, accountId);
  }
  const domains = (fields["domainNames"] ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  if (domains.length === 0) {
    throw new Error("Hetzner plugin: a managed certificate needs at least one domain");
  }
  const data = await cloud.post("/certificates", {
    body: { name: fields["name"], type: "managed", domain_names: domains },
  });
  return mapCertificate(data.certificate, accountId);
}

export async function retryCertificate(cloud: CloudApi, resourceId: string): Promise<void> {
  await cloud.post(`/certificates/${pathEncode(trailingId(resourceId))}/actions/retry`);
}
