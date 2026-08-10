import { describe, it, expect } from "vitest";
import {
  awsPreflight,
  buildAwsPolicyTemplate,
  parseSimulationResults,
  principalArnForSimulation,
} from "../preflight.js";
import { parseXml } from "../xml.js";

describe("awsPreflight declaration", () => {
  it("declares the three capabilities with provider-native permission ids", () => {
    expect(awsPreflight.capabilities.map((c) => c.id)).toEqual(["resources", "metrics", "costs"]);
    const costs = awsPreflight.capabilities.find((c) => c.id === "costs")!;
    expect(costs.requiredPermissions.map((p) => p.id)).toEqual(["ce:GetCostAndUsage"]);
    expect(awsPreflight.templateFormat).toEqual({
      label: "AWS IAM policy (JSON)",
      language: "json",
    });
  });
});

describe("buildAwsPolicyTemplate", () => {
  it("emits a valid 2012-10-17 policy with one statement per selected capability", () => {
    const tpl = buildAwsPolicyTemplate(["metrics", "costs"]);
    expect(tpl.language).toBe("json");
    const doc = JSON.parse(tpl.document) as {
      Version: string;
      Statement: Array<{ Sid: string; Effect: string; Action: string[]; Resource: string }>;
    };
    expect(doc.Version).toBe("2012-10-17");
    // metrics + costs + the always-on preflight statement
    expect(doc.Statement.map((s) => s.Sid)).toEqual([
      "InfrawrenchMetrics",
      "InfrawrenchCosts",
      "InfrawrenchPreflight",
    ]);
    expect(doc.Statement[1]!.Action).toEqual(["ce:GetCostAndUsage"]);
    expect(doc.Statement[2]!.Action).toEqual(["iam:SimulatePrincipalPolicy"]);
    for (const s of doc.Statement) {
      expect(s.Effect).toBe("Allow");
      expect(s.Resource).toBe("*");
    }
  });

  it("grants the broad read set for the resources capability", () => {
    const doc = JSON.parse(buildAwsPolicyTemplate(["resources"]).document) as {
      Statement: Array<{ Action: string[] }>;
    };
    const actions = doc.Statement[0]!.Action;
    expect(actions).toContain("ec2:Describe*");
    expect(actions).toContain("s3:ListAllMyBuckets");
    expect(actions).toContain("rds:Describe*");
    // costs must not leak into a resources-only template
    expect(actions).not.toContain("ce:GetCostAndUsage");
  });

  it("ignores unknown capability ids", () => {
    const doc = JSON.parse(buildAwsPolicyTemplate(["nope"]).document) as {
      Statement: Array<{ Sid: string }>;
    };
    expect(doc.Statement.map((s) => s.Sid)).toEqual(["InfrawrenchPreflight"]);
  });
});

describe("principalArnForSimulation", () => {
  it("passes user ARNs through", () => {
    expect(principalArnForSimulation("arn:aws:iam::123456789012:user/alice")).toBe(
      "arn:aws:iam::123456789012:user/alice",
    );
  });

  it("maps assumed-role session ARNs back to the role", () => {
    expect(
      principalArnForSimulation("arn:aws:sts::123456789012:assumed-role/my-role/session-1"),
    ).toBe("arn:aws:iam::123456789012:role/my-role");
  });

  it("returns null for the account root (nothing to simulate)", () => {
    expect(principalArnForSimulation("arn:aws:iam::123456789012:root")).toBeNull();
  });
});

describe("parseSimulationResults", () => {
  it("reads EvalDecision per action from the Query API XML", () => {
    const xml = parseXml(`<SimulatePrincipalPolicyResponse>
      <SimulatePrincipalPolicyResult>
        <IsTruncated>false</IsTruncated>
        <EvaluationResults>
          <member>
            <EvalActionName>ec2:DescribeInstances</EvalActionName>
            <EvalDecision>allowed</EvalDecision>
          </member>
          <member>
            <EvalActionName>ce:GetCostAndUsage</EvalActionName>
            <EvalDecision>implicitDeny</EvalDecision>
          </member>
        </EvaluationResults>
      </SimulatePrincipalPolicyResult>
    </SimulatePrincipalPolicyResponse>`);
    const verdicts = parseSimulationResults(xml);
    expect(verdicts.get("ec2:DescribeInstances")).toBe(true);
    expect(verdicts.get("ce:GetCostAndUsage")).toBe(false);
  });

  it("handles a single member (fast-xml-parser collapses one-element lists)", () => {
    const xml = parseXml(`<SimulatePrincipalPolicyResponse>
      <SimulatePrincipalPolicyResult>
        <EvaluationResults>
          <member>
            <EvalActionName>s3:ListAllMyBuckets</EvalActionName>
            <EvalDecision>explicitDeny</EvalDecision>
          </member>
        </EvaluationResults>
      </SimulatePrincipalPolicyResult>
    </SimulatePrincipalPolicyResponse>`);
    expect(parseSimulationResults(xml).get("s3:ListAllMyBuckets")).toBe(false);
  });
});
