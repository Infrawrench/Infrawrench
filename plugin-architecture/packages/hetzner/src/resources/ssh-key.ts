import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SshKeyResourceType: ResourceTypeDefinition = {
  id: "ssh-key",
  displayName: "SSH Key",
  pluralDisplayName: "SSH Keys",
  description: "A public SSH key available for new Hetzner Cloud servers",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "fingerprint", label: "Fingerprint", kind: "string", required: false },
    { key: "publicKey", label: "Public Key", kind: "string", required: false },
  ],
  outputs: [
    { key: "sshKeyId", label: "SSH Key ID", sensitive: false },
    { key: "publicKey", label: "Public Key", sensitive: false },
  ],
  dashboardPinnable: false,
  iconKey: "key",
};
