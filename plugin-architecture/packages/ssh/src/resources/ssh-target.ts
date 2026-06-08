import { f, o, rt } from "@infrawrench/plugin-base";

export const SshTargetResourceType = rt({
  name: "SSH Server",
  id: "ssh-target",
  description: "A remote server accessible via SSH.",
  fields: [
    f("host", "Host"),
    f("port", "Port", { required: false }),
    f("username", "Username", { required: false }),
  ],
  outputs: [
    o("host", "Host"),
    o("port", "Port"),
    o("username", "Username"),
    o("sshCommand", "SSH Command", {
      description: "OpenSSH command for connecting to this target.",
    }),
  ],
  supportsTerminal: true,
  supportsSftpBrowser: true,
});
