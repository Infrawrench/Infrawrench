import { f, o, rt } from "@infrawrench/plugin-base";

// Leaf module: both plugin.ts (the registry entry) and client.ts (the detail
// view labels its fields from this definition) import it, so it must not
// import either of them back.
export const deviceType = rt({
  id: "device",
  name: "Device",
  description: "A device connected to your Tailscale network.",
  fields: [
    f("name", "DNS name", { editable: true }),
    f("hostname", "Hostname", { editable: false }),
    f("os", "Operating system", { editable: false }),
    f("user", "Owner", { editable: false }),
    f("addresses", "Addresses", { editable: false }),
    f("tags", "Tags", { editable: false }),
    f("authorized", "Approved", { editable: false }),
    f("connected", "Connected", { editable: false }),
    f("clientVersion", "Client version", { editable: false }),
    f("lastSeen", "Last seen", { editable: false }),
    f("expires", "Key expires", { editable: false }),
    f("keyExpiryDisabled", "Key expiry disabled", { editable: false }),
  ],
  outputs: [o("ip", "Tailscale IP"), o("dnsName", "DNS name")],
  supportsUpdate: true,
  sshEndpoint: { hostOutputKey: "ip", defaultUsername: "root" },
});
