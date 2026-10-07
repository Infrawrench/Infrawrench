import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { B2Api } from "./api.js";
import { reportsBucketName } from "./usage.js";

/**
 * Preflight reads the capability list `b2_authorize_account` returns for the
 * key, so it costs one call and never guesses.
 */

const P = (id: string, label: string) => ({ id, label });

const CAPABILITIES: PreflightCapability[] = [
  {
    id: "resources",
    label: "Buckets and keys",
    description: "List buckets with their rules, and the account's application keys.",
    essential: true,
    requiredPermissions: [
      P("listBuckets", "List buckets"),
      P("readBuckets", "Read bucket settings"),
      P("listKeys", "List application keys"),
      P("readBucketNotifications", "Read event notifications"),
      P("readBucketEncryption", "Read bucket encryption"),
      P("readBucketRetentions", "Read Object Lock settings"),
    ],
  },
  {
    id: "manage",
    label: "Manage buckets and rules",
    description:
      "Create, change and delete buckets and their lifecycle, CORS, replication and notification rules.",
    requiredPermissions: [
      P("writeBuckets", "Create and change buckets"),
      P("deleteBuckets", "Delete buckets"),
      P("writeBucketEncryption", "Change bucket encryption"),
      P("writeBucketRetentions", "Change Object Lock settings"),
      P("writeBucketNotifications", "Change event notifications"),
    ],
  },
  {
    id: "keys",
    label: "Create application keys",
    description:
      "Mint bucket-scoped keys from Get credentials, set up replication, and create or delete keys.",
    requiredPermissions: [
      P("writeKeys", "Create application keys"),
      P("deleteKeys", "Delete application keys"),
    ],
  },
  {
    id: "storage",
    label: "File browser",
    description: "List, upload and delete files.",
    requiredPermissions: [
      P("listFiles", "List files"),
      P("readFiles", "Download files"),
      P("writeFiles", "Upload files"),
      P("deleteFiles", "Delete files"),
    ],
  },
  {
    id: "costs",
    label: "Usage and costs",
    description:
      "Read the daily usage reports Backblaze writes to the b2-reports-<account id> bucket (Backblaze support enables them).",
    requiredPermissions: [P("listFiles", "List files"), P("readFiles", "Download files")],
  },
];

export const B2_PREFLIGHT: PreflightDeclaration = {
  capabilities: CAPABILITIES,
  templateFormat: { label: "B2 application key capabilities", language: "text" },
};

export async function verifyB2Credentials(api: B2Api): Promise<PreflightResult> {
  let session;
  try {
    session = await api.getSession();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      checks: CAPABILITIES.map((c) => ({ capabilityId: c.id, status: "unknown", message })),
    };
  }
  const have = new Set(session.capabilities);
  const checks: PreflightCapabilityCheck[] = CAPABILITIES.map((c) => {
    const missing = c.requiredPermissions.filter((p) => !have.has(p.id));
    if (missing.length === 0) {
      if (c.id === "costs" && session.allowedBuckets) {
        const reports = reportsBucketName(session.accountId);
        if (!session.allowedBuckets.some((b) => b.name === reports)) {
          return {
            capabilityId: c.id,
            status: "missing",
            missingPermissions: [],
            message: `This key is limited to specific buckets and does not include ${reports}.`,
            helpLink: {
              label: "Application keys",
              url: "https://secure.backblaze.com/app_keys.htm",
            },
          };
        }
      }
      return { capabilityId: c.id, status: "ok" };
    }
    return {
      capabilityId: c.id,
      status: "missing",
      missingPermissions: missing,
      helpLink: { label: "Application keys", url: "https://secure.backblaze.com/app_keys.htm" },
    };
  });
  return { checks, identity: `Account ${session.accountId}` };
}

export function b2PolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const wanted = CAPABILITIES.filter((c) => capabilityIds.includes(c.id));
  const caps = [...new Set(wanted.flatMap((c) => c.requiredPermissions.map((p) => p.id)))];
  return {
    formatLabel: "B2 application key capabilities",
    language: "text",
    document: [
      `b2 key create infrawrench ${caps.join(",")}`,
      "",
      `Capabilities: ${caps.join(", ")}`,
    ].join("\n"),
    instructions:
      'The web console only creates all-access or single-bucket keys with fixed capability sets. For exactly these capabilities, run the B2 command-line tool line above with a master key, or pick "Read and Write" access to all buckets in the console.',
    helpLink: { label: "Application keys", url: "https://secure.backblaze.com/app_keys.htm" },
  };
}
