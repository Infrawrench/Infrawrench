import { f, o, rt } from "@infrawrench/plugin-base";

export const VercelDomainResourceType = rt({
  name: "Domain",
  id: "vercel-domain",
  description: "A domain registered or configured in Vercel",
  fields: [
    f("name", "Domain Name", { editable: false }),
    f("verified", "Verified", { required: false, editable: false }),
    f("serviceType", "Service Type", { required: false, editable: false }),
    f("nameservers", "Nameservers", { required: false, editable: false }),
    f("intendedNameservers", "Intended Nameservers", { required: false, editable: false }),
    f("renew", "Auto-Renew", {
      kind: "enum",
      enumValues: ["true", "false"],
      required: false,
      description:
        "Renew automatically before expiry. Only applies to domains bought through Vercel.",
    }),
    f("expiresAt", "Expires At", { required: false, editable: false }),
    f("boughtAt", "Bought At", { required: false, editable: false }),
    f("teamId", "Team", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [o("domainName", "Domain Name"), o("nameservers", "Nameservers")],
  // `GET /v5/domains` reports the owning team but no project link: a
  // domain↔project association lives on `/v9/projects/{id}/domains`, which the
  // lister doesn't fetch.
  dependsOn: [{ fieldKey: "teamId", targetTypeId: "vercel-team", label: "owned by" }],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "domain", label: "Registration expires" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "domain",
  // Records are their own type (`vercel-dns-record`), linked by `domain`.
  dnsRole: { role: "zone", domainKey: "name" },
  attachTargets: [
    {
      pluginId: "vercel",
      resourceTypeId: "vercel-project",
      verb: "Add to project",
    },
  ],
});
