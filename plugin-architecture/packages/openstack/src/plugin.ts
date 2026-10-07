import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { OpenStackApi } from "./api.js";
import { OpenStackClient } from "./client.js";
import { openstackRemediationCommands } from "./remediation.js";
import { resourceTypes } from "./resources.js";
import { openstackTerraformExport } from "./terraform.js";

/** OpenStack mark from simple-icons (CC0), white on the brand red. */
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#ED1944"/>
    <g transform="translate(18,18) scale(2.6667)" fill="white">
      <path d="M18.575 9.29h5.418v5.42h-5.418zM0 9.29h5.419v5.42H0zm18.575 7.827a1.207 1.207 0 0 1-1.206 1.206H6.623a1.207 1.207 0 0 1-1.205-1.206v-.858H0v5.252a2.236 2.236 0 0 0 2.229 2.23h19.53A2.237 2.237 0 0 0 24 21.512V16.26h-5.425zM21.763.258H2.233a2.236 2.236 0 0 0-2.23 2.23V7.74h5.419v-.858a1.206 1.206 0 0 1 1.205-1.206h10.746a1.206 1.206 0 0 1 1.205 1.206v.858H24V2.487A2.237 2.237 0 0 0 21.763.258Z"/>
    </g>
  </svg>`;

const manifest: PluginManifest = {
  id: "openstack",
  version: "0.1.0",
  displayName: "OpenStack",
  description:
    "Any OpenStack cloud: Nova servers, Cinder volumes, Neutron networking, Octavia, Swift, Designate and Heat",
  logoSvg,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "authUrl",
      label: "Keystone URL",
      description:
        "The Identity (Keystone) v3 endpoint, shown as auth_url in your clouds.yaml or OS_AUTH_URL in the openrc file (Horizon: Project, API Access).",
      sensitive: false,
      placeholder: "https://keystone.example.com:5000/v3",
    },
    {
      key: "applicationCredentialId",
      label: "Application Credential ID",
      description:
        "Recommended. Create one in Horizon under Identity, Application Credentials (or openstack application credential create). It is already scoped to a project, so leave the user and project fields empty.",
      sensitive: false,
      optional: true,
      placeholder: "423f19a4ac1e4f48bbb4180756e6eb6c",
    },
    {
      key: "applicationCredentialSecret",
      label: "Application Credential Secret",
      description: "Shown once when the application credential is created.",
      sensitive: true,
      optional: true,
    },
    {
      key: "username",
      label: "Username",
      description: "For password auth instead of an application credential (OS_USERNAME).",
      sensitive: false,
      optional: true,
    },
    {
      key: "password",
      label: "Password",
      description: "OS_PASSWORD.",
      sensitive: true,
      optional: true,
    },
    {
      key: "userDomain",
      label: "User Domain",
      description: "OS_USER_DOMAIN_NAME, usually Default.",
      sensitive: false,
      optional: true,
      placeholder: "Default",
    },
    {
      key: "project",
      label: "Project",
      description:
        "The project to manage (name or ID). Listed from Keystone once the URL, username and password are entered.",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: ["authUrl", "username", "password"] },
    },
    {
      key: "projectDomain",
      label: "Project Domain",
      description: "OS_PROJECT_DOMAIN_NAME; defaults to the user domain.",
      sensitive: false,
      optional: true,
      placeholder: "Default",
    },
    {
      key: "region",
      label: "Region",
      description: "Region to use from the service catalog. Leave empty on single-region clouds.",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: ["authUrl"], emptyLabel: "First region in the catalog" },
    },
    {
      key: "interface",
      label: "Endpoint Interface",
      description: "Which catalog endpoints to call: public (default), internal or admin.",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "public",
    },
    {
      key: "caCert",
      label: "CA Certificate (optional)",
      description:
        "PEM CA bundle for clouds with a private CA (OS_CACERT / cacert in clouds.yaml). Leave blank for publicly trusted certificates.",
      sensitive: false,
      optional: true,
      advanced: true,
      multiline: true,
      placeholder: "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----",
    },
  ],
  rateLimit: { capacity: 20, refillPerSecond: 10 },
  quotas: { label: "Quotas", partial: true },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials, services) => new OpenStackClient(credentials, services),
  terraformExport: openstackTerraformExport,
  remediationCommands: openstackRemediationCommands,
  async listCredentialOptions(fieldKey, credentials, services) {
    const api = new OpenStackApi(
      {
        authUrl: credentials["authUrl"] ?? "",
        ...Object.fromEntries(
          [
            "applicationCredentialId",
            "applicationCredentialSecret",
            "username",
            "password",
            "userDomain",
            "project",
            "projectDomain",
            "caCert",
          ]
            .filter((k) => credentials[k])
            .map((k) => [k, credentials[k] as string]),
        ),
      },
      services?.http,
    );
    if (fieldKey === "project") {
      const projects = await api.listProjects();
      return projects.map((p) => ({ id: p.name, label: p.name, description: p.id }));
    }
    if (fieldKey === "region") {
      const token = await api.token();
      return OpenStackApi.catalogRegions(token.catalog).map((r) => ({ id: r, label: r }));
    }
    throw new Error(`OpenStack plugin: no options for "${fieldKey}"`);
  },
};
