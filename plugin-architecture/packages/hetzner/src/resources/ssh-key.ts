import { f, o, rt } from "@infrawrench/plugin-base";

export const SshKeyResourceType = rt({
  name: "SSH Key",
  pinnable: false,
  id: "ssh-key",
  description: "A public SSH key available for new Hetzner Cloud servers",
  fields: [
    f("name", "Name"),
    f("fingerprint", "Fingerprint", { required: false, editable: false }),
    f("publicKey", "Public Key", { required: false, editable: false }),
  ],
  outputs: [o("sshKeyId", "SSH Key ID"), o("publicKey", "Public Key")],
  // Edit = `PUT` on the object itself (name, plus the fields left editable).
  supportsUpdate: true,
  iconKey: "key",
});
