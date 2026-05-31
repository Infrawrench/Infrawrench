import { describe, expect, it } from "vitest";
import {
  parsePolicy,
  serializePolicy,
  lintPolicy,
  normalizeStringList,
  summarizeStatement,
  templatesForVendor,
  blankStatement,
  principalToEditable,
  editableToPrincipal,
  S3_ACTION_CATALOG,
  type BucketPolicyDoc,
  type BucketPolicyStatement,
} from "../bucket-policy";

const BUCKET_ARN = "arn:aws:s3:::my-bucket";

describe("parsePolicy", () => {
  it("returns empty policy for blank input", () => {
    const { doc, parseError } = parsePolicy("   ");
    expect(parseError).toBeUndefined();
    expect(doc.Statement).toEqual([]);
  });

  it("parses a valid policy with array Statement", () => {
    const raw = JSON.stringify({
      Version: "2012-10-17",
      Id: "pid",
      Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: `${BUCKET_ARN}/*` }],
    });
    const { doc } = parsePolicy(raw);
    expect(doc.Version).toBe("2012-10-17");
    expect(doc.Id).toBe("pid");
    expect(doc.Statement).toHaveLength(1);
  });

  it("wraps a single object Statement into an array", () => {
    const raw = JSON.stringify({
      Statement: { Effect: "Allow", Action: "s3:GetObject", Resource: "*" },
    });
    const { doc } = parsePolicy(raw);
    expect(Array.isArray(doc.Statement)).toBe(true);
    expect(doc.Statement).toHaveLength(1);
  });

  it("defaults Version when missing", () => {
    const { doc } = parsePolicy(JSON.stringify({ Statement: [] }));
    expect(doc.Version).toBe("2012-10-17");
  });

  it("reports parse error for invalid JSON", () => {
    const { parseError, doc } = parsePolicy("{not json");
    expect(parseError).toBeTruthy();
    expect(doc.Statement).toEqual([]);
  });

  it("rejects non-object top-level JSON", () => {
    const { parseError } = parsePolicy("42");
    expect(parseError).toBe("Top-level must be an object.");
  });

  it("treats missing Statement as empty array", () => {
    const { doc } = parsePolicy(JSON.stringify({ Version: "2012-10-17" }));
    expect(doc.Statement).toEqual([]);
  });
});

describe("serializePolicy", () => {
  it("returns empty string for empty statements", () => {
    expect(serializePolicy({ Version: "2012-10-17", Statement: [] })).toBe("");
  });

  it("serializes a non-empty policy to pretty JSON", () => {
    const doc: BucketPolicyDoc = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }],
    };
    const out = serializePolicy(doc);
    expect(out).toContain('"Effect": "Allow"');
    expect(out).toContain("\n");
  });

  it("round-trips through parsePolicy", () => {
    const doc: BucketPolicyDoc = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Deny", Action: "s3:*", Resource: BUCKET_ARN }],
    };
    const parsed = parsePolicy(serializePolicy(doc));
    expect(parsed.doc.Statement[0]!.Effect).toBe("Deny");
  });
});

describe("normalizeStringList", () => {
  it("returns empty for undefined", () => {
    expect(normalizeStringList(undefined)).toEqual([]);
  });

  it("wraps a string", () => {
    expect(normalizeStringList("a")).toEqual(["a"]);
  });

  it("copies an array", () => {
    const input = ["a", "b"];
    const out = normalizeStringList(input);
    expect(out).toEqual(["a", "b"]);
    expect(out).not.toBe(input);
  });
});

describe("lintPolicy", () => {
  it("returns no findings for empty statements", () => {
    expect(lintPolicy({ Version: "2012-10-17", Statement: [] }, BUCKET_ARN)).toEqual([]);
  });

  it("flags invalid Effect", () => {
    const doc: BucketPolicyDoc = {
      Statement: [
        { Effect: "Maybe" as "Allow", Action: "s3:GetObject", Resource: `${BUCKET_ARN}/*` },
      ],
    };
    const findings = lintPolicy(doc, BUCKET_ARN);
    expect(findings.some((f) => f.severity === "error" && /Effect/.test(f.message))).toBe(true);
  });

  it("flags missing action and resource", () => {
    const doc: BucketPolicyDoc = { Statement: [{ Effect: "Allow" }] };
    const findings = lintPolicy(doc, BUCKET_ARN);
    expect(findings.some((f) => /Action or NotAction/.test(f.message))).toBe(true);
    expect(findings.some((f) => /Resource or NotResource/.test(f.message))).toBe(true);
  });

  it("warns on wildcard principal + wildcard action with no condition", () => {
    const doc: BucketPolicyDoc = {
      Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:*", Resource: BUCKET_ARN }],
    };
    const findings = lintPolicy(doc, BUCKET_ARN);
    expect(findings.some((f) => f.severity === "warning" && /every action/.test(f.message))).toBe(
      true,
    );
  });

  it("warns on public principal with narrower action", () => {
    const doc: BucketPolicyDoc = {
      Statement: [
        { Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `${BUCKET_ARN}/*` },
      ],
    };
    const findings = lintPolicy(doc, BUCKET_ARN);
    expect(findings.some((f) => /Public \(Principal/.test(f.message))).toBe(true);
  });

  it("warns when Resource is *", () => {
    const doc: BucketPolicyDoc = {
      Statement: [{ Effect: "Deny", Action: "s3:GetObject", Resource: "*" }],
    };
    const findings = lintPolicy(doc, BUCKET_ARN);
    expect(findings.some((f) => /Resource is `\*`/.test(f.message))).toBe(true);
  });

  it("warns when Resource does not match bucket ARN", () => {
    const doc: BucketPolicyDoc = {
      Statement: [
        { Effect: "Deny", Action: "s3:GetObject", Resource: "arn:aws:s3:::other-bucket/*" },
      ],
    };
    const findings = lintPolicy(doc, BUCKET_ARN);
    expect(findings.some((f) => /does not match this bucket/.test(f.message))).toBe(true);
  });

  it("gives an info nudge when object action lacks /* suffix", () => {
    const doc: BucketPolicyDoc = {
      Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: BUCKET_ARN }],
    };
    const findings = lintPolicy(doc, BUCKET_ARN);
    expect(findings.some((f) => f.severity === "info" && /acts on objects/.test(f.message))).toBe(
      true,
    );
  });

  it("gives an info nudge when bucket action has /* suffix", () => {
    const doc: BucketPolicyDoc = {
      Statement: [{ Effect: "Allow", Action: "s3:ListBucket", Resource: `${BUCKET_ARN}/*` }],
    };
    const findings = lintPolicy(doc, BUCKET_ARN);
    expect(
      findings.some((f) => f.severity === "info" && /acts on the bucket itself/.test(f.message)),
    ).toBe(true);
  });
});

describe("summarizeStatement", () => {
  it("describes a public read of all objects", () => {
    const stmt: BucketPolicyStatement = {
      Effect: "Allow",
      Principal: "*",
      Action: "s3:GetObject",
      Resource: `${BUCKET_ARN}/*`,
    };
    const summary = summarizeStatement(stmt, "my-bucket");
    expect(summary).toContain("Allow");
    expect(summary).toContain("anyone on the internet");
    expect(summary).toContain("every object in **my-bucket**");
  });

  it("describes deny + service principal + condition", () => {
    const stmt: BucketPolicyStatement = {
      Effect: "Deny",
      Principal: { Service: "cloudfront.amazonaws.com" },
      Action: "s3:*",
      Resource: BUCKET_ARN,
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    };
    const summary = summarizeStatement(stmt, "my-bucket");
    expect(summary).toContain("Deny");
    expect(summary).toContain("service cloudfront.amazonaws.com");
    expect(summary).toContain("perform any S3 action");
    expect(summary).toContain("non-HTTPS requests");
  });

  it("handles NotPrincipal / NotAction / NotResource", () => {
    const stmt: BucketPolicyStatement = {
      Effect: "Deny",
      NotPrincipal: "*",
      NotAction: "s3:GetObject",
      NotResource: BUCKET_ARN,
    };
    const summary = summarizeStatement(stmt, "my-bucket");
    expect(summary).toContain("everyone except");
    expect(summary).toContain("do anything except");
    expect(summary).toContain("every resource except");
  });

  it("summarizes the bucket itself when no principal", () => {
    const stmt: BucketPolicyStatement = {
      Effect: "Allow",
      Action: ["s3:Get", "s3:Put", "s3:Del", "s3:List"],
      Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
    };
    const summary = summarizeStatement(stmt, "my-bucket");
    expect(summary).toContain("the bucket itself");
    expect(summary).toContain("(+2 more)");
    expect(summary).toContain("2 resources");
  });

  it("describes prefix-scoped objects", () => {
    const stmt: BucketPolicyStatement = {
      Effect: "Allow",
      Principal: { AWS: "arn:aws:iam::123:root" },
      Action: "s3:GetObject",
      Resource: `${BUCKET_ARN}/logs/*`,
    };
    const summary = summarizeStatement(stmt, "my-bucket");
    expect(summary).toContain("objects matching `logs/`");
    expect(summary).toContain("AWS principal");
  });

  it("describes IP / VPCE / org conditions", () => {
    const stmt: BucketPolicyStatement = {
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Resource: BUCKET_ARN,
      Condition: {
        IpAddress: { "aws:SourceIp": "10.0.0.0/8" },
        StringEquals: {
          "aws:SourceVpce": "vpce-123",
          "aws:PrincipalOrgID": "o-1",
          "s3:prefix": "x",
        },
      },
    };
    const summary = summarizeStatement(stmt, "my-bucket");
    expect(summary).toContain("from IP 10.0.0.0/8");
    expect(summary).toContain("via VPC endpoint vpce-123");
    expect(summary).toContain("from Organization o-1");
    expect(summary).toContain("StringEquals(s3:prefix) = x");
  });
});

describe("templatesForVendor", () => {
  it("includes vendor-agnostic templates for do-spaces", () => {
    const templates = templatesForVendor("do-spaces");
    const ids = templates.map((t) => t.id);
    expect(ids).toContain("public-read-all-objects");
    expect(ids).toContain("force-tls");
    expect(ids).toContain("ip-allowlist");
    // aws-only templates excluded
    expect(ids).not.toContain("cross-account-read-write");
    expect(ids).not.toContain("cloudfront-oai");
  });

  it("includes aws-only templates for aws-s3", () => {
    const ids = templatesForVendor("aws-s3").map((t) => t.id);
    expect(ids).toContain("cross-account-read-write");
    expect(ids).toContain("cloudfront-oai");
    expect(ids).toContain("vpc-endpoint-only");
  });

  it("template build produces statements with bucket ARN", () => {
    const tmpl = templatesForVendor("aws-s3").find((t) => t.id === "public-read-all-objects")!;
    const stmts = tmpl.build({ bucketArn: BUCKET_ARN, bucketName: "my-bucket", vendor: "aws-s3" });
    expect(stmts[0]!.Resource).toBe(`${BUCKET_ARN}/*`);
  });

  it("buildWithInputs substitutes user input", () => {
    const tmpl = templatesForVendor("aws-s3").find((t) => t.id === "cross-account-read-write")!;
    const stmts = tmpl.buildWithInputs!(
      { bucketArn: BUCKET_ARN, bucketName: "my-bucket", vendor: "aws-s3" },
      { accountId: "999888777666" },
    );
    expect((stmts[0]!.Principal as { AWS: string }).AWS).toBe("arn:aws:iam::999888777666:root");
  });

  it("buildWithInputs falls back to placeholder when input blank", () => {
    const tmpl = templatesForVendor("aws-s3").find((t) => t.id === "vpc-endpoint-only")!;
    const stmts = tmpl.buildWithInputs!(
      { bucketArn: BUCKET_ARN, bucketName: "my-bucket", vendor: "aws-s3" },
      {},
    );
    expect(stmts[0]!.Condition!.StringNotEquals!["aws:SourceVpce"]).toBe("VPCE_ID");
  });
});

describe("blankStatement", () => {
  it("builds an allow read on objects", () => {
    const stmt = blankStatement(BUCKET_ARN);
    expect(stmt.Effect).toBe("Allow");
    expect(stmt.Principal).toBe("*");
    expect(stmt.Resource).toEqual([`${BUCKET_ARN}/*`]);
  });
});

describe("principalToEditable / editableToPrincipal", () => {
  it("maps everyone <-> *", () => {
    expect(principalToEditable("*")).toEqual({ mode: "everyone", values: "" });
    expect(principalToEditable(undefined)).toEqual({ mode: "everyone", values: "" });
    expect(editableToPrincipal("everyone", "ignored")).toBe("*");
  });

  it("maps AWS principals to newline-joined values", () => {
    const editable = principalToEditable({ AWS: ["a", "b"] });
    expect(editable).toEqual({ mode: "aws", values: "a\nb" });
  });

  it("maps each typed principal mode", () => {
    expect(principalToEditable({ Service: "svc" }).mode).toBe("service");
    expect(principalToEditable({ Federated: "fed" }).mode).toBe("federated");
    expect(principalToEditable({ CanonicalUser: "cu" }).mode).toBe("canonical");
  });

  it("editableToPrincipal returns single value or array", () => {
    expect(editableToPrincipal("aws", "one")).toEqual({ AWS: "one" });
    expect(editableToPrincipal("service", "a\nb")).toEqual({ Service: ["a", "b"] });
  });

  it("editableToPrincipal returns * when no values", () => {
    expect(editableToPrincipal("aws", "  \n  ")).toBe("*");
  });

  it("editableToPrincipal supports federated and canonical", () => {
    expect(editableToPrincipal("federated", "f")).toEqual({ Federated: "f" });
    expect(editableToPrincipal("canonical", "c")).toEqual({ CanonicalUser: "c" });
  });
});

describe("S3_ACTION_CATALOG", () => {
  it("classifies actions into object/bucket scope", () => {
    const getObject = S3_ACTION_CATALOG.find((a) => a.id === "s3:GetObject");
    const listBucket = S3_ACTION_CATALOG.find((a) => a.id === "s3:ListBucket");
    expect(getObject!.scope).toBe("object");
    expect(listBucket!.scope).toBe("bucket");
  });
});
