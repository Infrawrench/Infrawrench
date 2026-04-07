import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SshTargetResourceType: ResourceTypeDefinition = {
  id: "ssh-target",
  displayName: "SSH Server",
  pluralDisplayName: "SSH Servers",
  description: "A remote server accessible via SSH.",
  fields: [
    { key: "host", label: "Host", kind: "string", required: true },
    { key: "port", label: "Port", kind: "string", required: false },
    { key: "username", label: "Username", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsTerminal: true,
  supportsSftpBrowser: true,
};
