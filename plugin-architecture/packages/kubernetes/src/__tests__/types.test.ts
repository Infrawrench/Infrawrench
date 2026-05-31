import { describe, expect, it } from "vitest";
import { parseKubeconfig, mapPeerStatus, mapJobStatus } from "../types.js";

describe("parseKubeconfig", () => {
  it("extracts server, token, and CA from a bearer-token kubeconfig", () => {
    const raw = `apiVersion: v1
clusters:
  - name: c1
    cluster:
      server: https://cluster.example/
      certificate-authority-data: CA==
users:
  - name: u1
    user:
      token: my-token
`;
    expect(parseKubeconfig(raw)).toEqual({
      server: "https://cluster.example",
      caCertData: "CA==",
      token: "my-token",
    });
  });

  it("extracts client cert/key auth", () => {
    const raw = `apiVersion: v1
clusters:
  - cluster:
      server: https://c
users:
  - user:
      client-certificate-data: CERT
      client-key-data: KEY
`;
    expect(parseKubeconfig(raw)).toEqual({
      server: "https://c",
      clientCertData: "CERT",
      clientKeyData: "KEY",
    });
  });

  it("defaults to an empty server when none present", () => {
    expect(parseKubeconfig("apiVersion: v1\nclusters: []\nusers: []\n")).toEqual({ server: "" });
  });

  it("throws on empty or unparseable YAML", () => {
    expect(() => parseKubeconfig("")).toThrow(/empty or unparseable/);
    expect(() => parseKubeconfig("null")).toThrow(/empty or unparseable/);
  });
});

describe("mapPeerStatus", () => {
  it("maps healthy states", () => {
    for (const s of ["Running", "ready", "ACTIVE", "Succeeded"])
      expect(mapPeerStatus(s)).toBe("healthy");
  });
  it("maps provisioning states", () => {
    for (const s of ["Pending", "Creating", "ContainerCreating"])
      expect(mapPeerStatus(s)).toBe("provisioning");
  });
  it("maps degraded states", () => {
    for (const s of ["CrashLoopBackOff", "Terminating", "Evicted"])
      expect(mapPeerStatus(s)).toBe("degraded");
  });
  it("maps error states", () => {
    for (const s of ["Failed", "Error", "ImagePullBackOff", "ErrImagePull", "OOMKilled"])
      expect(mapPeerStatus(s)).toBe("error");
  });
  it("falls back to info", () => {
    expect(mapPeerStatus("anything-else")).toBe("info");
  });
});

describe("mapJobStatus", () => {
  it("maps complete/succeeded to healthy", () => {
    expect(mapJobStatus("Complete")).toBe("healthy");
    expect(mapJobStatus("succeeded")).toBe("healthy");
  });
  it("maps running/active to provisioning", () => {
    expect(mapJobStatus("Running")).toBe("provisioning");
    expect(mapJobStatus("active")).toBe("provisioning");
  });
  it("maps failed to error and others to info", () => {
    expect(mapJobStatus("Failed")).toBe("error");
    expect(mapJobStatus("Pending")).toBe("info");
  });
});
