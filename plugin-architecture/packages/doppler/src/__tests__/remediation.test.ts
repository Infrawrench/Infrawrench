import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { dopplerRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

function config(fields: RemediationResource["fields"]): RemediationResource {
  return {
    resourceTypeId: "doppler-config",
    displayName: "dev_x",
    externalId: "backend.dev_x",
    fields,
  };
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "never fetched",
  resource,
});

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return dopplerRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("dopplerRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(dopplerRemediationCommands);
  });

  it("downloads the secrets, then deletes the never-fetched branch config", () => {
    expect(lines(orphan(config({ project: "backend", name: "dev_feature", root: false }))))
      .toMatchInlineSnapshot(`
      [
        "- doppler secrets download --project backend --config dev_feature --no-file --format json > backend-dev_feature-20261004.json",
        "! doppler configs delete --project backend --config dev_feature --yes",
      ]
    `);
  });

  it("quotes hostile names", () => {
    expect(lines(orphan(config({ project: "a b", name: "x;y" })))[1]).toBe(
      "! doppler configs delete --project 'a b' --config 'x;y' --yes",
    );
  });

  it("never deletes a root config, and needs both project and name", () => {
    expect(
      dopplerRemediationCommands(orphan(config({ project: "p", name: "dev", root: true }))),
    ).toEqual([]);
    expect(dopplerRemediationCommands(orphan(config({ project: "p" })))).toEqual([]);
    expect(dopplerRemediationCommands(orphan(config({ name: "dev_x" })))).toEqual([]);
  });

  it("ignores other kinds and types", () => {
    expect(
      dopplerRemediationCommands({
        kind: "sleep-schedule",
        resource: config({ project: "p", name: "c" }),
      }),
    ).toEqual([]);
    expect(
      dopplerRemediationCommands(
        orphan({
          resourceTypeId: "doppler-project",
          displayName: "p",
          externalId: "p",
          fields: {},
        }),
      ),
    ).toEqual([]);
  });
});
