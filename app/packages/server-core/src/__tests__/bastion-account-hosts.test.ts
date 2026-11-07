import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountEgressHosts, providerHostsOf } from "../bastion/account-hosts";
import { hostMatches } from "../bastion/protocol";
import { isPublicAddress } from "../bastion/public-address";
import { classifyIp } from "../egress-guard";

function field(key: string, over: { sensitive?: boolean; providerHost?: boolean } = {}) {
  return { key, label: key, sensitive: false, providerHost: true, ...over };
}

describe("isPublicAddress", () => {
  const addresses = [
    // Public
    ["93.184.216.34", true],
    ["8.8.8.8", true],
    ["2606:4700:4700::1111", true],
    ["2a00:1450:4001:81b::200e", true],
    // 6to4 and NAT64 around a public address
    ["2002:5db8:d822::", true],
    ["64:ff9b::5db8:d822", true],
    ["::ffff:93.184.216.34", true],
    // Link-local, cloud metadata
    ["169.254.169.254", false],
    ["fe80::1", false],
    ["fd00:ec2::254", false],
    ["100.100.100.200", false],
    // Every spelling of the metadata address
    ["::ffff:169.254.169.254", false],
    ["::ffff:a9fe:a9fe", false],
    ["64:ff9b::a9fe:a9fe", false],
    ["2002:a9fe:a9fe::", false],
    ["::169.254.169.254", false],
    ["::ffff:0:a9fe:a9fe", false],
    // Private
    ["10.0.0.1", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    ["100.64.0.1", false],
    ["fc00::1", false],
    ["fd12:3456:789a::1", false],
    // Loopback and unspecified
    ["127.0.0.1", false],
    ["127.255.255.254", false],
    ["0.0.0.0", false],
    ["::1", false],
    ["::", false],
    // Everything else that is not routable
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["240.0.0.1", false],
    ["192.0.2.1", false],
    ["198.51.100.1", false],
    ["203.0.113.1", false],
    ["198.18.0.1", false],
    ["ff02::1", false],
    ["fec0::1", false],
    ["2001:db8::1", false],
    ["2001::1", false],
    ["64:ff9b:1::1", false],
  ] as const;

  it.each(addresses)("%s is public: %s", (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it.each(addresses)("agrees with the egress guard on %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(classifyIp(ip) === "public");
  });

  it.each([
    "",
    "not-an-ip",
    "example.com",
    "1.2.3",
    "1.2.3.4.5",
    "256.1.1.1",
    "010.0.0.1",
    "0x7f.0.0.1",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    "12345::1",
    "fe80::1%eth0",
    "[::1]",
  ])("fails closed on %j", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe("the agent's copy of the address rules", () => {
  it("is the same file, because the agent's image cannot import this package", () => {
    const here = new URL("../bastion/public-address.ts", import.meta.url);
    const agent = new URL("../../../bastion-agent/src/public-address.ts", import.meta.url);
    expect(readFileSync(agent, "utf8")).toBe(readFileSync(here, "utf8"));
  });
});

describe("providerHostsOf", () => {
  const hostsOf = (value: string) => providerHostsOf([field("url")], { url: value });

  it.each([
    ["https://prometheus.acme.example:9090/prometheus", "prometheus.acme.example"],
    ["http://vault.acme.example", "vault.acme.example"],
    ["vault.acme.example", "vault.acme.example"],
    ["vault.acme.example:8200", "vault.acme.example"],
    ["  HTTPS://Vault.Acme.Example/  ", "vault.acme.example"],
    ["https://user:password@vault.acme.example", "vault.acme.example"],
    ["nats://nats.acme.example:4222", "nats.acme.example"],
    ["93.184.216.34", "93.184.216.34"],
    ["https://93.184.216.34:8443", "93.184.216.34"],
    ["https://[2606:4700:4700::1111]:9000", "2606:4700:4700::1111"],
  ])("reads the host of %j", (value, host) => {
    expect(hostsOf(value)).toEqual([host]);
  });

  it("reads every host of a list", () => {
    expect(hostsOf("https://a.acme.example, b.acme.example:1234")).toEqual([
      "a.acme.example",
      "b.acme.example",
    ]);
  });

  it.each([
    ["the metadata address", "http://169.254.169.254/latest"],
    ["a decimal spelling of it", "http://2852039166"],
    ["a hex spelling of it", "http://0xa9.0xfe.0xa9.0xfe"],
    ["its IPv4-mapped spelling", "http://[::ffff:169.254.169.254]"],
    ["a private address", "http://10.0.0.5:9090"],
    ["CGNAT", "100.64.0.1"],
    ["loopback", "http://127.0.0.1:9090"],
    ["IPv6 loopback", "http://[::1]:9090"],
    ["a unique local address", "http://[fd12::1]"],
    ["localhost", "http://localhost:9090"],
    ["a name with no dot, which only a private resolver answers", "prometheus"],
    ["an account name another plugin builds a host from", "acme"],
    ["a wildcard", "https://*.acme.example"],
    ["a hostname that would read as an allowlist entry", "public:acme.example"],
    ["nothing", "   "],
    ["no host", "https://"],
    ["garbage", "not a url at all"],
    ["a socket", "unix:///var/run/docker.sock"],
  ])("leaves out %s", (_label, value) => {
    expect(hostsOf(value)).toEqual([]);
  });

  it("reads only the fields the plugin marked", () => {
    const fields = [field("url"), field("token", { providerHost: false })];
    expect(providerHostsOf(fields, { url: "a.acme.example", token: "b.acme.example" })).toEqual([
      "a.acme.example",
    ]);
  });

  it("never reads a sensitive field, even one marked by mistake", () => {
    const fields = [field("url", { sensitive: true })];
    expect(providerHostsOf(fields, { url: "secret.acme.example" })).toEqual([]);
  });

  it("copes with an account that has no value for the field", () => {
    expect(providerHostsOf([field("url")], {})).toEqual([]);
  });
});

describe("accountEgressHosts", () => {
  const manifest = {
    egressHosts: ["api.example.test", "*.example.test"],
    credentialFields: [field("url")],
  };

  it("is the plugin's hosts and the account's own", () => {
    const hosts = accountEgressHosts(manifest, { url: "https://self.acme.example" });
    expect(hostMatches("api.example.test", hosts)).toBe(true);
    expect(hostMatches("eu.example.test", hosts)).toBe(true);
    expect(hostMatches("self.acme.example", hosts)).toBe(true);
    expect(hostMatches("other.acme.example", hosts)).toBe(false);
  });

  it("does not let an account's own host work as a wildcard", () => {
    const hosts = accountEgressHosts(manifest, { url: "https://self.acme.example" });
    expect(hostMatches("sub.self.acme.example", hosts)).toBe(false);
  });
});
