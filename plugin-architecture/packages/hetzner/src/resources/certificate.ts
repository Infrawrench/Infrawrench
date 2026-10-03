import { f, o, rt } from "@infrawrench/plugin-base";

export const CertificateResourceType = rt({
  name: "Certificate",
  id: "certificate",
  description:
    "A TLS certificate for Hetzner Load Balancers: uploaded, or managed (issued and renewed by Hetzner via Let's Encrypt)",
  fields: [
    f("name", "Name"),
    f("type", "Type", { kind: "enum", enumValues: ["uploaded", "managed"], editable: false }),
    f("domainNames", "Domains", {
      required: false,
      description: "Comma-separated domain names the certificate covers",
      editable: false,
    }),
    f("issuanceStatus", "Issuance", {
      kind: "enum",
      required: false,
      enumValues: ["pending", "completed", "failed"],
      description: "Managed certificates only",
      editable: false,
    }),
    f("renewalStatus", "Renewal", {
      kind: "enum",
      required: false,
      enumValues: ["scheduled", "pending", "failed", "unavailable"],
      description: "Managed certificates only",
      editable: false,
    }),
    f("statusError", "Error", { required: false, editable: false }),
    f("notValidBefore", "Valid From", { required: false, editable: false }),
    f("notValidAfter", "Valid Until", { required: false, editable: false }),
    f("fingerprint", "Fingerprint", { required: false, editable: false }),
    f("usedByLoadBalancerIds", "Used By", {
      required: false,
      description: "Comma-separated IDs of the load balancers serving this certificate",
      editable: false,
    }),
  ],
  outputs: [o("certificateId", "Certificate ID")],
  // `used_by[]` entries are `{id, type: "load_balancer"}`; a load balancer's
  // externalId is the same numeric id stringified.
  dependsOn: [
    { fieldKey: "usedByLoadBalancerIds", targetTypeId: "load-balancer", label: "served by" },
  ],
  expiryFields: [
    { fieldKey: "notValidAfter", from: "expiry", kind: "tls-cert", label: "Certificate expires" },
  ],
  // Unused certificates are free, so this is a tidiness hint, not a cost one.
  orphanRule: {
    conditions: [{ fieldKey: "usedByLoadBalancerIds", when: "empty" }],
    reason: "Certificate is not used by any load balancer",
  },
  supportsCreate: true,
  // Edit = rename (`PUT /certificates/{id}`); the certificate itself is immutable.
  supportsUpdate: true,
  iconKey: "certificate",
});
