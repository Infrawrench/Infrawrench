import { describe, expect, it } from "vitest";
import { isT3ConnectAddress, isT3ConnectHost, t3ConnectOrigin } from "../t3-connect";

const HOST = "prod-0123456789abcdef.tunnels.example.net";

describe("a T3 Connect address", () => {
  it("is the production stage and a 16 hex digest under a zone", () => {
    expect(isT3ConnectHost(HOST)).toBe(true);
    expect(isT3ConnectHost(HOST.toUpperCase())).toBe(true);
    for (const host of [
      "prod-0123456789abcde.tunnels.example.net", // 15
      "prod-0123456789abcdef0.tunnels.example.net", // 17
      "prod-0123456789abcdeg.tunnels.example.net", // not hex
      "dev-julius-0123456789abcdef.tunnels.example.net", // somebody's own stage
      "0123456789abcdef.tunnels.example.net",
      "x.prod-0123456789abcdef.tunnels.example.net", // the label is the first one
      "prod-0123456789abcdef", // no zone
      "prod-0123456789abcdef.net", // a zone is a registered name
      "prod-0123456789abcdef.-bad.example.net",
      "prod-0123456789abcdef..example.net",
      "relay.t3.codes", // hands the address out; not an environment
      "app.t3.codes",
      "localhost",
      "127.0.0.1",
    ]) {
      expect(isT3ConnectHost(host), host).toBe(false);
    }
  });

  it("is held to the zone once the zone is named", () => {
    const zones = ["tunnels.example.net"];
    expect(isT3ConnectHost(HOST, zones)).toBe(true);
    expect(isT3ConnectHost("prod-0123456789abcdef.tunnels.example.org", zones)).toBe(false);
    // Under the zone, not merely ending like it.
    expect(isT3ConnectHost("prod-0123456789abcdef.eviltunnels.example.net", zones)).toBe(false);
    expect(isT3ConnectHost("prod-0123456789abcdef.a.tunnels.example.net", zones)).toBe(false);
  });

  it("is read from the MCP URL T3 Code copies, the address, or the host", () => {
    for (const pasted of [
      `https://${HOST}/mcp`,
      `https://${HOST}/`,
      `  ${HOST}  `,
      `${HOST}/mcp`,
      `HTTPS://${HOST.toUpperCase()}/mcp?x=1#y`,
    ]) {
      expect(t3ConnectOrigin(pasted), pasted).toEqual({ origin: `https://${HOST}` });
    }
  });

  it("says what is wrong with anything else", () => {
    expect(t3ConnectOrigin("")).toEqual({ problem: "empty" });
    expect(t3ConnectOrigin("   ")).toEqual({ problem: "empty" });
    expect(t3ConnectOrigin(`http://${HOST}/mcp`)).toEqual({ problem: "not-https" });
    for (const pasted of [
      `https://${HOST}:8443/mcp`, // a tunnel answers on 443 only
      `https://user:secret@${HOST}/mcp`,
      `wss://${HOST}/ws`,
      "https://t3.example.net/mcp",
      "https://localhost:3773/mcp",
      "https://10.0.0.5/mcp",
      "https://relay.t3.codes",
    ]) {
      expect(t3ConnectOrigin(pasted), pasted).toEqual({ problem: "not-t3-connect" });
    }
  });

  it("knows a stored address that is one", () => {
    expect(isT3ConnectAddress(`https://${HOST}`)).toBe(true);
    expect(isT3ConnectAddress("https://t3.example.net")).toBe(false);
    expect(isT3ConnectAddress("https://build.example.net:8443")).toBe(false);
  });
});
