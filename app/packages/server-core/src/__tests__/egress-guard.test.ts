import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLookup = vi.fn();
const mockResolveSrv = vi.fn();
vi.mock("node:dns", () => ({
  promises: {
    lookup: (...args: unknown[]) => mockLookup(...args),
    resolveSrv: (...args: unknown[]) => mockResolveSrv(...args),
  },
}));

const tunnels: Array<{ localPort: number; extras: { organizationId: string; accountId: string } }> =
  [];
vi.mock("@infrawrench/ssh-tunnel-core", () => ({
  findTunnel: (pred: (r: (typeof tunnels)[number]) => boolean) => tunnels.find(pred) ?? null,
}));

const guard = await import("../egress-guard");
const {
  classifyIp,
  isBlockedIp,
  resolveDialAddress,
  resolveSafeHost,
  assertDialTargetsAllowed,
  guardDriverConnection,
  resetEgressPolicyForTests,
  EgressBlockedError,
} = guard;

beforeEach(() => {
  vi.clearAllMocks();
  tunnels.length = 0;
  delete process.env.EGRESS_ALLOW_PRIVATE_NETWORKS;
  delete process.env.EGRESS_BLOCKED_CIDRS;
  resetEgressPolicyForTests();
});
afterEach(() => {
  delete process.env.EGRESS_ALLOW_PRIVATE_NETWORKS;
  delete process.env.EGRESS_BLOCKED_CIDRS;
  resetEgressPolicyForTests();
});

describe("classifyIp: IPv4", () => {
  it.each([
    "0.0.0.0",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "192.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "100.100.100.200",
  ])("%s is internal", (ip) => {
    expect(classifyIp(ip)).toBe("internal");
  });

  it.each(["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1"])(
    "%s is private",
    (ip) => {
      expect(classifyIp(ip)).toBe("private");
    },
  );

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "198.20.0.1"])(
    "%s is public",
    (ip) => {
      expect(classifyIp(ip)).toBe("public");
    },
  );
});

describe("classifyIp: IPv6 encodings", () => {
  it.each([
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback, uncompressed"],
    ["0000:0000:0000:0000:0000:0000:0000:0001", "loopback, zero-padded"],
    ["::", "unspecified"],
    ["::ffff:127.0.0.1", "v4-mapped loopback, dotted"],
    ["::ffff:7f00:1", "v4-mapped loopback, hex"],
    ["::ffff:a9fe:a9fe", "v4-mapped metadata, hex"],
    ["::ffff:169.254.169.254", "v4-mapped metadata, dotted"],
    ["0:0:0:0:0:ffff:a9fe:a9fe", "v4-mapped metadata, uncompressed"],
    ["::169.254.169.254", "v4-compatible metadata"],
    ["::7f00:1", "v4-compatible loopback"],
    ["::ffff:0:a9fe:a9fe", "SIIT metadata"],
    ["64:ff9b::a9fe:a9fe", "NAT64 metadata"],
    ["64:ff9b::127.0.0.1", "NAT64 loopback, dotted"],
    ["64:ff9b:1::1", "local-use NAT64"],
    ["2002:a9fe:a9fe::1", "6to4 metadata"],
    ["2002:7f00:1::", "6to4 loopback"],
    ["fe80::1", "link-local fe80"],
    ["fe80::1%eth0", "link-local with zone"],
    ["fe9a::1", "link-local fe9a"],
    ["febf:ffff::1", "link-local top of fe80::/10"],
    ["fec0::1", "site-local"],
    ["ff02::1", "multicast"],
    ["fd00:ec2::254", "AWS IMDS v6"],
    ["2001:db8::1", "documentation"],
    ["2001::1", "Teredo"],
  ])("%s (%s) is internal", (ip) => {
    expect(classifyIp(ip)).toBe("internal");
  });

  it.each(["fc00::1", "fd12:3456::1", "::ffff:10.0.0.1", "::ffff:c0a8:101", "64:ff9b::a00:1"])(
    "%s is private",
    (ip) => {
      expect(classifyIp(ip)).toBe("private");
    },
  );

  it.each(["2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])(
    "%s is public",
    (ip) => {
      expect(classifyIp(ip)).toBe("public");
    },
  );

  it("treats an unparseable string as internal", () => {
    expect(classifyIp("not-an-ip")).toBe("internal");
  });
});

describe("policy configuration", () => {
  it("blocks private ranges by default", () => {
    expect(isBlockedIp("10.1.2.3")).toBe(true);
    expect(isBlockedIp("fd00::1")).toBe(true);
  });

  it("allows private ranges when EGRESS_ALLOW_PRIVATE_NETWORKS is true", () => {
    process.env.EGRESS_ALLOW_PRIVATE_NETWORKS = "true";
    expect(isBlockedIp("10.1.2.3")).toBe(false);
    expect(isBlockedIp("::ffff:192.168.1.1")).toBe(false);
    // Internal space stays refused regardless.
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true);
  });

  it("always blocks EGRESS_BLOCKED_CIDRS, even with private networks allowed", () => {
    process.env.EGRESS_ALLOW_PRIVATE_NETWORKS = "true";
    process.env.EGRESS_BLOCKED_CIDRS = "10.4.0.0/14, 10.8.0.0/20,fd99::/16";
    expect(isBlockedIp("10.5.1.1")).toBe(true);
    expect(isBlockedIp("::ffff:10.8.0.10")).toBe(true);
    expect(isBlockedIp("fd99::1")).toBe(true);
    expect(isBlockedIp("10.9.0.1")).toBe(false);
  });

  it("fails closed on an invalid CIDR", () => {
    process.env.EGRESS_BLOCKED_CIDRS = "10.0.0.0/99";
    expect(() => isBlockedIp("8.8.8.8")).toThrow(/EGRESS_BLOCKED_CIDRS/);
  });
});

describe("resolveDialAddress", () => {
  it("returns a public literal without DNS", async () => {
    await expect(resolveDialAddress("8.8.8.8", 443)).resolves.toBe("8.8.8.8");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("accepts a bracketed IPv6 literal", async () => {
    await expect(resolveDialAddress("[2606:4700:4700::1111]", 443)).resolves.toBe(
      "2606:4700:4700::1111",
    );
  });

  it("refuses a hex-mapped metadata literal", async () => {
    await expect(resolveDialAddress("::ffff:a9fe:a9fe", 80)).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });

  it("names the bastion route when refusing a private address", async () => {
    await expect(resolveDialAddress("10.0.0.5", 5432)).rejects.toThrow(/bastion or an SSH tunnel/);
  });

  it("refuses a name if any answer is blocked", async () => {
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "::ffff:7f00:1", family: 6 },
    ]);
    await expect(resolveDialAddress("straddle.example", 443)).rejects.toThrow(/::ffff:7f00:1/);
  });

  it("returns the first cleared answer for a name", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(resolveDialAddress("example.com", 443)).resolves.toBe("93.184.216.34");
  });
});

describe("SSH tunnel loopback exception", () => {
  beforeEach(() => {
    tunnels.push({ localPort: 40001, extras: { organizationId: "org-a", accountId: "acc-a" } });
  });

  it("allows the owning account's tunnel port", async () => {
    await expect(
      resolveDialAddress("127.0.0.1", 40001, { scope: { accountId: "acc-a" } }),
    ).resolves.toBe("127.0.0.1");
  });

  it("allows the owning organization's tunnel port", async () => {
    await expect(
      resolveDialAddress("127.0.0.1", 40001, { scope: { organizationId: "org-a" } }),
    ).resolves.toBe("127.0.0.1");
  });

  it("refuses another organization's tunnel port", async () => {
    await expect(
      resolveDialAddress("127.0.0.1", 40001, {
        scope: { organizationId: "org-b", accountId: "acc-b" },
      }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("refuses a port that is not a tunnel, even for the owner", async () => {
    await expect(
      resolveDialAddress("127.0.0.1", 40002, { scope: { accountId: "acc-a" } }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("refuses the tunnel port without a scope", async () => {
    await expect(resolveDialAddress("127.0.0.1", 40001)).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("refuses other loopback spellings of the tunnel port", async () => {
    const scope = { accountId: "acc-a" };
    await expect(resolveDialAddress("::ffff:127.0.0.1", 40001, { scope })).rejects.toThrow();
    await expect(resolveDialAddress("127.0.0.2", 40001, { scope })).rejects.toThrow();
    mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(resolveDialAddress("localhost", 40001, { scope })).rejects.toThrow();
  });
});

describe("resolveSafeHost", () => {
  it("keeps the SSH wording the routes surface", async () => {
    await expect(resolveSafeHost("   ")).rejects.toThrow("SSH host is required");
    await expect(resolveSafeHost("127.0.0.1")).rejects.toThrow(
      "SSH host 127.0.0.1 resolves to a blocked address range",
    );
  });
});

describe("assertDialTargetsAllowed / guardDriverConnection", () => {
  it("refuses local targets (sockets, files)", async () => {
    await expect(
      assertDialTargetsAllowed([{ kind: "local", reason: "a unix socket path" }]),
    ).rejects.toThrow(/unix socket path/);
  });

  it("refuses an empty target list", async () => {
    await expect(assertDialTargetsAllowed([])).rejects.toThrow(/does not name a host/);
  });

  it("vets every SRV answer", async () => {
    mockResolveSrv.mockResolvedValue([
      { name: "8.8.8.8", port: 27017 },
      { name: "169.254.169.254", port: 27017 },
    ]);
    await expect(
      assertDialTargetsAllowed([{ kind: "srv", name: "_mongodb._tcp.x.example" }]),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it("refuses a driver that cannot report its targets", async () => {
    await expect(guardDriverConnection({ id: "mystery" }, "x://y")).rejects.toThrow(
      /does not declare where it connects/,
    );
  });

  it("passes a driver whose targets are public", async () => {
    const driver = {
      id: "d",
      dialTargets: () => [{ kind: "host" as const, host: "8.8.8.8", port: 5432 }],
    };
    await expect(guardDriverConnection(driver, "conn")).resolves.toBeUndefined();
  });
});

describe("HTTP egress through the global dispatcher", () => {
  it("refuses loopback inside a scope, allows the owner's tunnel, leaves unscoped fetch alone", async () => {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/`;
    try {
      guard.ensureEgressGuardInstalled();

      // A tenant pointing a plugin at loopback.
      await expect(
        guard.runInEgressScope({ organizationId: "org-b" }, () => fetch(url)),
      ).rejects.toThrow();

      // The same port, owned by org-a's SSH tunnel, as the tunnel resolver
      // would hand it to org-a.
      tunnels.push({ localPort: port, extras: { organizationId: "org-a", accountId: "acc-a" } });
      const own = await guard.runInEgressScope(
        { organizationId: "org-a", accountId: "acc-a" },
        () => fetch(url),
      );
      expect(await own.text()).toBe("ok");

      // org-b still cannot ride it, even with org-a's connection pooled.
      await expect(
        guard.runInEgressScope({ organizationId: "org-b" }, () => fetch(url)),
      ).rejects.toThrow();

      // The server's own calls (no scope) are not tenant-directed.
      const unscoped = await fetch(url);
      expect(await unscoped.text()).toBe("ok");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
