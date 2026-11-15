import { CI_OPENSSH_CLIENT, type CiToolDeclaration } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";

import { accessOfJob, toolsOfJob } from "../tools";

const kubectl: CiToolDeclaration = {
  command: "kubectl",
  downloads: { x86_64: { url: "https://dl.example.test/kubectl", sha256: "a".repeat(64) } },
};
const declared = (pluginId: string) =>
  pluginId === "kubernetes" ? [kubectl] : pluginId === "ssh" ? [CI_OPENSSH_CLIENT] : [];
const pluginsOf = (name: string) =>
  ({ Production: ["kubernetes"], "web-1": ["ssh"], Billing: ["stripe"] })[name] ?? [];

describe("accessOfJob", () => {
  const access = [
    { pipeline: "ci.yml", job: "deploy", connections: [{ name: "Production" }] },
    { pipeline: "ci.yml", job: "dep", sshKeys: ["deploy"] },
    { pipeline: "nightly.yml", job: "deploy", connections: [{ name: "web-1" }] },
  ];

  it("finds a job by its key, in its own pipeline", () => {
    expect(accessOfJob(access, { job: "deploy", pipeline: "ci.yml" })).toEqual([access[0]]);
    expect(accessOfJob(access, { job: "deploy", pipeline: "nightly.yml" })).toEqual([access[2]]);
  });

  it("finds a matrix job by its key's prefix, and never a key that only starts the same", () => {
    expect(accessOfJob(access, { job: "deploy[eu]", pipeline: "ci.yml" })).toEqual([access[0]]);
    expect(accessOfJob(access, { job: "dep", pipeline: "ci.yml" })).toEqual([access[1]]);
  });

  it("falls back to the key alone when the pipeline is named some other way", () => {
    expect(accessOfJob(access, { job: "dep", pipeline: "CI" })).toEqual([access[1]]);
    expect(accessOfJob(null, { job: "dep", pipeline: "ci.yml" })).toEqual([]);
  });
});

describe("toolsOfJob", () => {
  it("takes each lending plugin's tools, and ssh for a lent SSH key, each once", () => {
    const tools = toolsOfJob(
      [
        {
          pipeline: "ci.yml",
          job: "deploy",
          connections: [{ name: "Production" }, { name: "web-1" }, { name: "Billing" }],
          sshKeys: ["deploy"],
        },
      ],
      pluginsOf,
      declared,
    );
    expect(tools.map((t) => t.command)).toEqual(["kubectl", "ssh"]);
  });

  it("gives a job that is lent nothing no tools", () => {
    expect(toolsOfJob([{ pipeline: "ci.yml", job: "build" }], pluginsOf, declared)).toEqual([]);
    expect(
      toolsOfJob(
        [{ pipeline: "ci.yml", job: "build", envFrom: ["r2"], resources: { db: ["url"] } }],
        pluginsOf,
        declared,
      ),
    ).toEqual([]);
  });
});
