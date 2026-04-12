import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { NetlifyClient } from "./client.js";
import { NetlifySiteResourceType } from "./resources/site.js";
import { NetlifyDeployResourceType } from "./resources/deploy.js";
import { NetlifyFormResourceType } from "./resources/form.js";
import { NetlifyDnsZoneResourceType } from "./resources/dns-zone.js";
import { NetlifyDnsRecordResourceType } from "./resources/dns-record.js";
import { NetlifyBuildHookResourceType } from "./resources/build-hook.js";
import { NetlifyEnvVarResourceType } from "./resources/env-var.js";

const manifest: PluginManifest = {
  id: "netlify",
  version: "0.1.0",
  displayName: "Netlify",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#0E1E25"/>
    <g transform="translate(15,15) scale(0.7)">
      <path d="M64.802 47.325l-7.946-7.946c-.282-.282-.564-.458-.846-.564l.705-.705 8.087 8.087v1.128zm-10.338-9.71a2.26 2.26 0 00-1.34.423l-5.196-5.196c.07-.282.07-.564.07-.846 0-.494-.141-.917-.423-1.34l7.453-7.453h.635l8.51 8.509-9.709 5.903zm-2.398.776a1.632 1.632 0 01-.494 1.198 1.632 1.632 0 01-1.199.494c-.846 0-1.551-.705-1.551-1.551 0-.847.705-1.552 1.551-1.552.212 0 .423.07.635.141l.917-.917c-.494-.352-1.058-.564-1.552-.564a2.84 2.84 0 00-2.82 2.82 2.84 2.84 0 002.82 2.821c.776 0 1.481-.282 2.045-.846a2.728 2.728 0 00.846-2.044v-.141l-.917.917c-.07.07-.14.14-.281.224zm3.102 2.891l-1.27-1.27c-.423.282-.917.494-1.41.564l1.41 1.41c.352-.282.776-.494 1.27-.704zm1.622.987a1.55 1.55 0 011.551 1.552c0 .846-.705 1.551-1.551 1.551-.847 0-1.552-.705-1.552-1.551 0-.847.705-1.552 1.552-1.552zm13.863 7.17l-8.51 8.509h-.634L52.48 47.92l5.337-5.338c.353.212.776.353 1.27.353.494 0 .917-.141 1.34-.424l7.382 7.383c-.07.282-.07.494-.07.776 0 .564.142.988.424 1.41l-4.773 4.773v-.635l7.806-7.735.987.987zM50.434 48.06l-1.622 1.621L34.997 63.496l-1.27-1.27 14.31-14.31a2.26 2.26 0 001.34.423c.353 0 .706-.07 1.058-.282zm18.073-13.3l-8.51-8.51v-.634l8.51-8.51h.634l8.51 8.51v.635l-8.51 8.51h-.634zm-3.737-9.004L50.999 11.984l12.812-5.057 8.863 8.863-7.904 10.966zm-15.46-11.955l14.803 14.803-6.678 4.068h-.212l-8.51-8.51v-.634l4.35-4.35L50.505 9.06l-1.195 4.74zm16.729 35.578L53.96 37.3l4.844-4.844c.423.282.846.423 1.34.423s.918-.141 1.34-.423l7.524 7.524c-.282.423-.423.846-.423 1.34s.141.918.423 1.341l-3.768 3.768v.846zm-13.229-7.24l-.846.847-14.31 14.31-1.692-1.693 14.31-14.31.846-.846c.353.282.706.423 1.128.494l-.282 1.904c-.494-.14-.846-.423-1.154-.706zm-10.48 18.894L28.516 47.22l1.763-1.764 13.864 13.864-1.763 1.763-.07-.07zm15.108-18.047l-14.31 14.31-1.27-1.27 14.31-14.31c.212.494.564.917 1.058 1.128l-.635 1.2c-.494-.494-.847-.776-1.153-1.058zm-14.803 15.79l-1.622-1.621 14.31-14.31.846-.847c.282.282.635.494 1.058.564l-.423 2.82c-.353-.07-.635-.282-.917-.564l-.846.846-12.406 13.113zm22.091 2.609l-4.21 4.21v-.635l3.738-3.737c.141.07.282.141.473.162zm3.667-.917l-8.51 8.51h-.635l-2.327-2.327a2.26 2.26 0 001.34-.423l5.268 5.268-.424-3.808 5.288-5.268v-.635l-1.27-1.27.988-.987 1.41 1.41-.635.635-1.504-1.504v.424z" fill="#32E6E2"/>
      <path d="M50.434 48.06c-.352-.212-.705-.282-1.058-.282-.494 0-.988.141-1.34.423L33.727 62.226l1.27 1.27L49.953 48.68l-.565.423.211-.211c.494-.212.705-.494.835-.832z" fill="#4DC8C4"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "accessToken",
      label: "Personal Access Token",
      description:
        "A Netlify personal access token. Generate one at app.netlify.com → User Settings → Applications → Personal access tokens.",
      sensitive: true,
      placeholder: "nfp_...",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  NetlifySiteResourceType,
  NetlifyDeployResourceType,
  NetlifyFormResourceType,
  NetlifyDnsZoneResourceType,
  NetlifyDnsRecordResourceType,
  NetlifyBuildHookResourceType,
  NetlifyEnvVarResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new NetlifyClient(credentials),
};
