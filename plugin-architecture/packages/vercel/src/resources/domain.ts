import { f, o, rt } from "@infrawrench/plugin-base";

export const VercelDomainResourceType = rt({
  name: "Domain",
  id: "vercel-domain",
  description: "A domain registered or configured in Vercel",
  fields: [
    f("name", "Domain Name"),
    f("verified", "Verified", { required: false }),
    f("serviceType", "Service Type", { required: false }),
    f("nameservers", "Nameservers", { required: false }),
    f("intendedNameservers", "Intended Nameservers", { required: false }),
    f("renew", "Auto-Renew", { required: false }),
    f("expiresAt", "Expires At", { required: false }),
    f("boughtAt", "Bought At", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [o("domainName", "Domain Name"), o("nameservers", "Nameservers")],
  supportsCreate: true,
  iconKey: "domain",
  attachTargets: [
    {
      pluginId: "vercel",
      resourceTypeId: "vercel-project",
      verb: "Add to project",
    },
  ],
});
