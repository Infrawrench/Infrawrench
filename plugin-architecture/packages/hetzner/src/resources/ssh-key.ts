import { f, o, rt } from "@infrawrench/plugin-base";

export const SshKeyResourceType = rt({
  name: "SSH Key",
  pinnable: false,
  id: "ssh-key",
  description: "A public SSH key available for new Hetzner Cloud servers",
  fields: [
    f("name", "Name"),
    f("fingerprint", "Fingerprint", { required: false }),
    f("publicKey", "Public Key", { required: false }),
  ],
  outputs: [o("sshKeyId", "SSH Key ID"), o("publicKey", "Public Key")],
  iconKey: "key",
});
