import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { huggingfaceRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "thing", externalId, fields };
}

const sleep = (resource: RemediationResource): RemediationFinding => ({
  kind: "sleep-schedule",
  resource,
});

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return huggingfaceRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("huggingfaceRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(huggingfaceRemediationCommands);
  });

  it("pauses and resumes an Inference Endpoint in its namespace", () => {
    expect(
      lines(
        sleep(
          res("hf-inference-endpoint", "llama-prod", { name: "llama-prod", namespace: "acme" }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "- hf endpoints pause --namespace acme llama-prod",
        "- hf endpoints resume --namespace acme llama-prod",
      ]
    `);
  });

  it("omits --namespace when none was stored", () => {
    expect(lines(sleep(res("hf-inference-endpoint", "ep")))).toEqual([
      "- hf endpoints pause ep",
      "- hf endpoints resume ep",
    ]);
  });

  it("pauses and restarts a Space", () => {
    expect(lines(sleep(res("hf-space", "acme/demo", { repoId: "acme/demo" }))))
      .toMatchInlineSnapshot(`
      [
        "- hf spaces pause acme/demo",
        "- hf spaces restart acme/demo",
      ]
    `);
  });

  it("suspends and resumes a scheduled Job", () => {
    expect(
      lines(
        sleep(
          res("hf-scheduled-job", "68b1c0ffee", {
            scheduledJobId: "68b1c0ffee",
            namespace: "acme",
          }),
        ),
      ),
    ).toMatchInlineSnapshot(`
      [
        "- hf jobs scheduled suspend --namespace acme 68b1c0ffee",
        "- hf jobs scheduled resume --namespace acme 68b1c0ffee",
      ]
    `);
  });

  it("quotes hostile values", () => {
    const [pause] = huggingfaceRemediationCommands(
      sleep(res("hf-inference-endpoint", null, { name: "x; rm -rf ~", namespace: "a b" })),
    );
    expect(pause?.command).toBe("hf endpoints pause --namespace 'a b' 'x; rm -rf ~'");
  });

  it("returns nothing without an id, for other kinds and for other types", () => {
    expect(huggingfaceRemediationCommands(sleep(res("hf-space", null)))).toEqual([]);
    expect(huggingfaceRemediationCommands(sleep(res("hf-scheduled-job", "  ")))).toEqual([]);
    expect(huggingfaceRemediationCommands(sleep(res("hf-model", "acme/m")))).toEqual([]);
    expect(
      huggingfaceRemediationCommands({
        kind: "orphan",
        reason: "unused",
        resource: res("hf-inference-endpoint", "ep"),
      }),
    ).toEqual([]);
  });
});
