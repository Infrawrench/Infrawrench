/**
 * Bucket-policy helpers shared by the interactive editor.
 *
 * AWS S3, DigitalOcean Spaces, and Scaleway Object Storage all use the same
 * AWS-flavoured JSON policy schema, so this module is vendor-agnostic except
 * where called out.
 */

export type BucketPolicyVendor = "aws-s3" | "do-spaces" | "scaleway-os";

export interface BucketPolicyDoc {
  Version?: string;
  Id?: string;
  Statement: BucketPolicyStatement[];
}

export interface BucketPolicyStatement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Principal?: PolicyPrincipal;
  NotPrincipal?: PolicyPrincipal;
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  NotResource?: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

/**
 * Policy principal — either the string `"*"` (everyone), or a typed bag of
 * `{AWS: ...}` / `{Service: ...}` / `{Federated: ...}` / `{CanonicalUser: ...}`
 * each of which can carry a single ARN or an array of ARNs.
 */
export type PolicyPrincipal =
  | "*"
  | {
      AWS?: string | string[];
      Service?: string | string[];
      Federated?: string | string[];
      CanonicalUser?: string | string[];
    };

export interface LintFinding {
  /** Index into the statement list this finding applies to (-1 for doc-level). */
  statementIndex: number;
  severity: "error" | "warning" | "info";
  message: string;
}

/* -------------------------------------------------------------------------- */
/* Parse / serialize                                                          */
/* -------------------------------------------------------------------------- */

interface ParsedPolicy {
  doc: BucketPolicyDoc;
  /** Set when JSON is unparseable; doc is `EMPTY_POLICY`. */
  parseError?: string;
}

const EMPTY_POLICY: BucketPolicyDoc = { Version: "2012-10-17", Statement: [] };

export function parsePolicy(raw: string): ParsedPolicy {
  const trimmed = raw.trim();
  if (!trimmed) return { doc: { ...EMPTY_POLICY, Statement: [] } };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {
        doc: { ...EMPTY_POLICY, Statement: [] },
        parseError: "Top-level must be an object.",
      };
    }
    const obj = parsed as Record<string, unknown>;
    const statements = Array.isArray(obj["Statement"])
      ? (obj["Statement"] as BucketPolicyStatement[])
      : obj["Statement"]
        ? [obj["Statement"] as BucketPolicyStatement]
        : [];
    const doc: BucketPolicyDoc = {
      ...(typeof obj["Version"] === "string" ? { Version: obj["Version"] as string } : {}),
      ...(typeof obj["Id"] === "string" ? { Id: obj["Id"] as string } : {}),
      Statement: statements,
    };
    if (!doc.Version) doc.Version = "2012-10-17";
    return { doc };
  } catch (e) {
    return {
      doc: { ...EMPTY_POLICY, Statement: [] },
      parseError: e instanceof Error ? e.message : String(e),
    };
  }
}

export function serializePolicy(doc: BucketPolicyDoc): string {
  // Drop empty Statement arrays — an empty policy round-trips to "" and the
  // host treats that as DeleteBucketPolicy, which is usually what users want.
  if (!doc.Statement || doc.Statement.length === 0) return "";
  return JSON.stringify(doc, null, 2);
}

/* -------------------------------------------------------------------------- */
/* Lint                                                                       */
/* -------------------------------------------------------------------------- */

const S3_OBJECT_ACTIONS = new Set([
  "s3:GetObject",
  "s3:PutObject",
  "s3:DeleteObject",
  "s3:GetObjectAcl",
  "s3:PutObjectAcl",
  "s3:GetObjectVersion",
  "s3:DeleteObjectVersion",
  "s3:GetObjectTagging",
  "s3:PutObjectTagging",
  "s3:RestoreObject",
  "s3:AbortMultipartUpload",
  "s3:ListMultipartUploadParts",
]);

const S3_BUCKET_ACTIONS = new Set([
  "s3:ListBucket",
  "s3:GetBucketLocation",
  "s3:GetBucketVersioning",
  "s3:PutBucketVersioning",
  "s3:GetBucketAcl",
  "s3:PutBucketAcl",
  "s3:GetBucketPolicy",
  "s3:PutBucketPolicy",
  "s3:DeleteBucketPolicy",
  "s3:GetBucketCORS",
  "s3:PutBucketCORS",
  "s3:GetBucketTagging",
  "s3:PutBucketTagging",
  "s3:GetBucketWebsite",
  "s3:PutBucketWebsite",
  "s3:GetLifecycleConfiguration",
  "s3:PutLifecycleConfiguration",
]);

export function lintPolicy(doc: BucketPolicyDoc, bucketArn: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const objectArn = `${bucketArn}/*`;

  if (!doc.Statement || doc.Statement.length === 0) {
    return findings;
  }

  doc.Statement.forEach((stmt, i) => {
    // Effect required.
    if (stmt.Effect !== "Allow" && stmt.Effect !== "Deny") {
      findings.push({
        statementIndex: i,
        severity: "error",
        message: `Effect must be "Allow" or "Deny".`,
      });
    }

    // Either Action or NotAction is required.
    if (!stmt.Action && !stmt.NotAction) {
      findings.push({
        statementIndex: i,
        severity: "error",
        message: "Statement needs either Action or NotAction.",
      });
    }

    // Either Resource or NotResource is required.
    if (!stmt.Resource && !stmt.NotResource) {
      findings.push({
        statementIndex: i,
        severity: "error",
        message: "Statement needs either Resource or NotResource.",
      });
    }

    // Allow + Principal:* + Action:* with no Condition is dangerous.
    const isWildcardPrincipal = stmt.Principal === "*";
    const actions = normalizeStringList(stmt.Action);
    const hasWildcardAction = actions.some((a) => a === "*" || a === "s3:*");
    if (stmt.Effect === "Allow" && isWildcardPrincipal && hasWildcardAction && !stmt.Condition) {
      findings.push({
        statementIndex: i,
        severity: "warning",
        message: "Grants every action on the bucket to everyone — almost never what you want.",
      });
    }

    // Allow + Principal:* without Condition warns even on narrower actions.
    if (stmt.Effect === "Allow" && isWildcardPrincipal && !hasWildcardAction && !stmt.Condition) {
      findings.push({
        statementIndex: i,
        severity: "warning",
        message: "Public (Principal: *) — anyone on the internet can call these actions.",
      });
    }

    // Resource ARN should reference this bucket.
    const resources = normalizeStringList(stmt.Resource);
    for (const r of resources) {
      if (r === "*") {
        findings.push({
          statementIndex: i,
          severity: "warning",
          message: "Resource is `*` — bucket policies only affect this bucket and its objects.",
        });
      } else if (!r.startsWith(bucketArn)) {
        findings.push({
          statementIndex: i,
          severity: "warning",
          message: `Resource "${r}" does not match this bucket's ARN (${bucketArn}).`,
        });
      }
    }

    // Heuristic: object-level actions need /* suffix; bucket-level shouldn't.
    for (const action of actions) {
      if (S3_OBJECT_ACTIONS.has(action)) {
        const allObjectScoped = resources.length > 0 && resources.every((r) => r.endsWith("/*"));
        if (!allObjectScoped) {
          findings.push({
            statementIndex: i,
            severity: "info",
            message: `Action ${action} acts on objects — Resource usually ends in "/*" (e.g. ${objectArn}).`,
          });
          break; // one nudge per statement is plenty
        }
      } else if (S3_BUCKET_ACTIONS.has(action)) {
        const allBucketScoped =
          resources.length > 0 && resources.every((r) => r === bucketArn || !r.endsWith("/*"));
        if (!allBucketScoped) {
          findings.push({
            statementIndex: i,
            severity: "info",
            message: `Action ${action} acts on the bucket itself — Resource is usually ${bucketArn} (no trailing /*).`,
          });
          break;
        }
      }
    }
  });

  return findings;
}

export function normalizeStringList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.slice() : [value];
}

/* -------------------------------------------------------------------------- */
/* Plain-English summary                                                      */
/* -------------------------------------------------------------------------- */

export function summarizeStatement(stmt: BucketPolicyStatement, bucketName: string): string {
  const verb = stmt.Effect === "Deny" ? "Deny" : "Allow";
  const who = describePrincipal(stmt.Principal, stmt.NotPrincipal);
  const what = describeActions(stmt.Action, stmt.NotAction);
  const where = describeResources(stmt.Resource, stmt.NotResource, bucketName);
  const cond = stmt.Condition ? ` ${describeCondition(stmt.Condition)}` : "";
  return `${verb} ${who} to ${what} on ${where}${cond ? ` —${cond}` : ""}.`;
}

function describePrincipal(p?: PolicyPrincipal, notP?: PolicyPrincipal): string {
  if (notP) return `everyone except ${describePrincipal(notP)}`;
  if (!p) return "the bucket itself";
  if (p === "*") return "anyone on the internet";
  if (typeof p === "object") {
    const parts: string[] = [];
    if (p.AWS) parts.push(`AWS principal${arrayLen(p.AWS) > 1 ? "s" : ""} ${joinArns(p.AWS)}`);
    if (p.Service) parts.push(`service ${joinArns(p.Service)}`);
    if (p.Federated) parts.push(`federated identity ${joinArns(p.Federated)}`);
    if (p.CanonicalUser) parts.push(`canonical user ${joinArns(p.CanonicalUser)}`);
    return parts.length ? parts.join(" + ") : "(unknown principal)";
  }
  return "(unknown principal)";
}

function describeActions(a?: string | string[], notA?: string | string[]): string {
  if (notA) return `do anything except ${describeActions(notA)}`;
  if (!a) return "(no action)";
  const arr = normalizeStringList(a);
  if (arr.length === 0) return "(no action)";
  if (arr.includes("*") || arr.includes("s3:*")) return "perform any S3 action";
  if (arr.length === 1) return arr[0]!;
  if (arr.length <= 3) return arr.join(", ");
  return `${arr.slice(0, 2).join(", ")} (+${arr.length - 2} more)`;
}

function describeResources(
  r?: string | string[],
  notR?: string | string[],
  bucketName?: string,
): string {
  if (notR) return `every resource except ${describeResources(notR)}`;
  const arr = normalizeStringList(r);
  if (arr.length === 0) return "(no resource)";
  const objectShorthand = bucketName ? `arn:aws:s3:::${bucketName}/*` : "";
  const bucketShorthand = bucketName ? `arn:aws:s3:::${bucketName}` : "";
  if (arr.length === 1) {
    const only = arr[0]!;
    if (only === bucketShorthand) return `bucket **${bucketName}**`;
    if (only === objectShorthand) return `every object in **${bucketName}**`;
    if (only.endsWith("/*") && bucketName && only.startsWith(bucketShorthand + "/")) {
      const prefix = only.slice((bucketShorthand + "/").length, -1);
      return `objects matching \`${prefix}\` in **${bucketName}**`;
    }
    return only;
  }
  return `${arr.length} resources`;
}

function describeCondition(cond: Record<string, Record<string, string | string[]>>): string {
  // Surface the well-known security-significant conditions in friendly form.
  const parts: string[] = [];
  for (const [op, kvs] of Object.entries(cond)) {
    for (const [k, v] of Object.entries(kvs)) {
      const vs = Array.isArray(v) ? v.join(", ") : v;
      if (k === "aws:SecureTransport") {
        parts.push(
          `${op === "Bool" || op === "BoolEquals" ? "" : op + " "}${
            String(vs) === "false" ? "non-HTTPS requests" : "HTTPS requests"
          }`,
        );
        continue;
      }
      if (k === "aws:SourceIp") {
        parts.push(`from IP ${vs}`);
        continue;
      }
      if (k === "aws:SourceVpce") {
        parts.push(`via VPC endpoint ${vs}`);
        continue;
      }
      if (k === "aws:PrincipalOrgID") {
        parts.push(`from Organization ${vs}`);
        continue;
      }
      parts.push(`${op}(${k}) = ${vs}`);
    }
  }
  return parts.length ? `when ${parts.join(" and ")}` : "with conditions";
}

function joinArns(v: string | string[]): string {
  const arr = normalizeStringList(v);
  if (arr.length === 1) return arr[0]!;
  if (arr.length <= 2) return arr.join(", ");
  return `${arr.slice(0, 2).join(", ")} (+${arr.length - 2} more)`;
}

function arrayLen(v: string | string[]): number {
  return Array.isArray(v) ? v.length : 1;
}

/* -------------------------------------------------------------------------- */
/* S3 action catalog (autocomplete)                                           */
/* -------------------------------------------------------------------------- */

export const S3_ACTION_CATALOG: Array<{
  id: string;
  description: string;
  scope: "object" | "bucket";
}> = [
  { id: "s3:*", description: "All S3 actions", scope: "bucket" },
  // Object actions
  { id: "s3:GetObject", description: "Read object data", scope: "object" },
  { id: "s3:PutObject", description: "Upload / overwrite an object", scope: "object" },
  { id: "s3:DeleteObject", description: "Delete an object", scope: "object" },
  { id: "s3:GetObjectAcl", description: "Read an object's ACL", scope: "object" },
  { id: "s3:PutObjectAcl", description: "Set an object's ACL", scope: "object" },
  { id: "s3:GetObjectTagging", description: "Read object tags", scope: "object" },
  { id: "s3:PutObjectTagging", description: "Set object tags", scope: "object" },
  { id: "s3:GetObjectVersion", description: "Read a specific object version", scope: "object" },
  {
    id: "s3:DeleteObjectVersion",
    description: "Delete a specific object version",
    scope: "object",
  },
  { id: "s3:RestoreObject", description: "Restore from Glacier", scope: "object" },
  { id: "s3:AbortMultipartUpload", description: "Cancel a multipart upload", scope: "object" },
  // Bucket actions
  { id: "s3:ListBucket", description: "List objects in the bucket", scope: "bucket" },
  { id: "s3:GetBucketLocation", description: "Read bucket region", scope: "bucket" },
  { id: "s3:GetBucketAcl", description: "Read bucket ACL", scope: "bucket" },
  { id: "s3:PutBucketAcl", description: "Set bucket ACL", scope: "bucket" },
  { id: "s3:GetBucketPolicy", description: "Read this bucket policy", scope: "bucket" },
  { id: "s3:PutBucketPolicy", description: "Replace this bucket policy", scope: "bucket" },
  { id: "s3:DeleteBucketPolicy", description: "Remove this bucket policy", scope: "bucket" },
  { id: "s3:GetBucketCORS", description: "Read CORS config", scope: "bucket" },
  { id: "s3:PutBucketCORS", description: "Set CORS config", scope: "bucket" },
  { id: "s3:GetBucketVersioning", description: "Read versioning state", scope: "bucket" },
  { id: "s3:PutBucketVersioning", description: "Set versioning state", scope: "bucket" },
  { id: "s3:GetLifecycleConfiguration", description: "Read lifecycle rules", scope: "bucket" },
  { id: "s3:PutLifecycleConfiguration", description: "Set lifecycle rules", scope: "bucket" },
];

/* -------------------------------------------------------------------------- */
/* Templates                                                                  */
/* -------------------------------------------------------------------------- */

export interface PolicyTemplate {
  id: string;
  label: string;
  description: string;
  /** Builder fed `{bucketArn, bucketName, vendor}`; returns one or more statements. */
  build: (ctx: {
    bucketArn: string;
    bucketName: string;
    vendor: BucketPolicyVendor;
  }) => BucketPolicyStatement[];
  /** Vendor subsets this template applies to. Omit = all S3-compatible vendors. */
  vendors?: BucketPolicyVendor[];
  /** Fields the user fills in before the template is dropped in (rendered as a small form). */
  inputs?: Array<{ key: string; label: string; placeholder?: string }>;
  /**
   * Convert the template into a statement using the user's filled-in input
   * values. Called instead of `build` when `inputs` is non-empty.
   */
  buildWithInputs?: (
    ctx: { bucketArn: string; bucketName: string; vendor: BucketPolicyVendor },
    inputs: Record<string, string>,
  ) => BucketPolicyStatement[];
}

const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    id: "public-read-all-objects",
    label: "Public read of all objects",
    description:
      "Anyone on the internet can GET any object in the bucket. Useful for static websites; double-check the bucket isn't holding anything private first.",
    build: ({ bucketArn }) => [
      {
        Sid: "PublicReadGetObject",
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `${bucketArn}/*`,
      },
    ],
  },
  {
    id: "force-tls",
    label: "Deny non-HTTPS requests",
    description:
      "Reject any request that isn't over TLS. Standard hardening baseline — pair it with a more specific Allow.",
    build: ({ bucketArn }) => [
      {
        Sid: "DenyInsecureTransport",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [bucketArn, `${bucketArn}/*`],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  },
  {
    id: "cross-account-read-write",
    label: "Cross-account read/write",
    description: "Grant another AWS account read + write access to all objects.",
    vendors: ["aws-s3"],
    inputs: [
      {
        key: "accountId",
        label: "AWS account ID",
        placeholder: "123456789012",
      },
    ],
    build: ({ bucketArn }) => [
      {
        Sid: "CrossAccountReadWrite",
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::ACCOUNT_ID:root" },
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
        Resource: [bucketArn, `${bucketArn}/*`],
      },
    ],
    buildWithInputs: ({ bucketArn }, inputs) => {
      const acct = inputs["accountId"]?.trim() || "ACCOUNT_ID";
      return [
        {
          Sid: "CrossAccountReadWrite",
          Effect: "Allow",
          Principal: { AWS: `arn:aws:iam::${acct}:root` },
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
          Resource: [bucketArn, `${bucketArn}/*`],
        },
      ];
    },
  },
  {
    id: "cloudfront-oai",
    label: "CloudFront OAI read-only",
    description:
      "Restrict object reads to a specific CloudFront Origin Access Identity. Pair with a CloudFront distribution that uses this OAI.",
    vendors: ["aws-s3"],
    inputs: [
      {
        key: "oaiId",
        label: "CloudFront OAI ID",
        placeholder: "E1ABCDEFGH1234",
      },
    ],
    build: ({ bucketArn }) => [
      {
        Sid: "AllowCloudFrontOAI",
        Effect: "Allow",
        Principal: {
          AWS: "arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity OAI_ID",
        },
        Action: "s3:GetObject",
        Resource: `${bucketArn}/*`,
      },
    ],
    buildWithInputs: ({ bucketArn }, inputs) => {
      const oai = inputs["oaiId"]?.trim() || "OAI_ID";
      return [
        {
          Sid: "AllowCloudFrontOAI",
          Effect: "Allow",
          Principal: {
            AWS: `arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity ${oai}`,
          },
          Action: "s3:GetObject",
          Resource: `${bucketArn}/*`,
        },
      ];
    },
  },
  {
    id: "vpc-endpoint-only",
    label: "Allow only from a VPC endpoint",
    description:
      "Deny every request that doesn't come through a specific VPC endpoint. Use to keep an internal bucket off the public internet.",
    vendors: ["aws-s3"],
    inputs: [
      {
        key: "vpceId",
        label: "VPC endpoint ID",
        placeholder: "vpce-0123456789abcdef0",
      },
    ],
    build: ({ bucketArn }) => [
      {
        Sid: "DenyOutsideVPCE",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [bucketArn, `${bucketArn}/*`],
        Condition: { StringNotEquals: { "aws:SourceVpce": "VPCE_ID" } },
      },
    ],
    buildWithInputs: ({ bucketArn }, inputs) => {
      const vpce = inputs["vpceId"]?.trim() || "VPCE_ID";
      return [
        {
          Sid: "DenyOutsideVPCE",
          Effect: "Deny",
          Principal: "*",
          Action: "s3:*",
          Resource: [bucketArn, `${bucketArn}/*`],
          Condition: { StringNotEquals: { "aws:SourceVpce": vpce } },
        },
      ];
    },
  },
  {
    id: "ip-allowlist",
    label: "Restrict to IP allowlist",
    description: "Deny requests from outside a configured CIDR range.",
    inputs: [
      {
        key: "cidr",
        label: "Allowed CIDR",
        placeholder: "203.0.113.0/24",
      },
    ],
    build: ({ bucketArn }) => [
      {
        Sid: "RestrictToCIDR",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [bucketArn, `${bucketArn}/*`],
        Condition: { NotIpAddress: { "aws:SourceIp": "0.0.0.0/0" } },
      },
    ],
    buildWithInputs: ({ bucketArn }, inputs) => {
      const cidr = inputs["cidr"]?.trim() || "0.0.0.0/0";
      return [
        {
          Sid: "RestrictToCIDR",
          Effect: "Deny",
          Principal: "*",
          Action: "s3:*",
          Resource: [bucketArn, `${bucketArn}/*`],
          Condition: { NotIpAddress: { "aws:SourceIp": cidr } },
        },
      ];
    },
  },
];

export function templatesForVendor(vendor: BucketPolicyVendor): PolicyTemplate[] {
  return POLICY_TEMPLATES.filter((t) => !t.vendors || t.vendors.includes(vendor));
}

/* -------------------------------------------------------------------------- */
/* Helpers used by the form UI                                                */
/* -------------------------------------------------------------------------- */

export function blankStatement(bucketArn: string): BucketPolicyStatement {
  return {
    Effect: "Allow",
    Principal: "*",
    Action: ["s3:GetObject"],
    Resource: [`${bucketArn}/*`],
  };
}

/** Coerce a `Principal` value into a stable {AWS:string[]} form for editing. */
export function principalToEditable(p?: PolicyPrincipal): {
  mode: "everyone" | "aws" | "service" | "federated" | "canonical";
  values: string;
} {
  if (!p || p === "*") return { mode: "everyone", values: "" };
  if (typeof p === "object") {
    if (p.AWS) return { mode: "aws", values: normalizeStringList(p.AWS).join("\n") };
    if (p.Service) return { mode: "service", values: normalizeStringList(p.Service).join("\n") };
    if (p.Federated)
      return { mode: "federated", values: normalizeStringList(p.Federated).join("\n") };
    if (p.CanonicalUser)
      return { mode: "canonical", values: normalizeStringList(p.CanonicalUser).join("\n") };
  }
  return { mode: "everyone", values: "" };
}

export function editableToPrincipal(
  mode: "everyone" | "aws" | "service" | "federated" | "canonical",
  values: string,
): PolicyPrincipal {
  if (mode === "everyone") return "*";
  const list = values.split(/\r?\n/).flatMap((s) => {
    const trimmed = s.trim();
    return trimmed ? [trimmed] : [];
  });
  if (list.length === 0) return "*";
  const value: string | string[] = list.length === 1 ? list[0]! : list;
  switch (mode) {
    case "aws":
      return { AWS: value };
    case "service":
      return { Service: value };
    case "federated":
      return { Federated: value };
    case "canonical":
      return { CanonicalUser: value };
  }
}
