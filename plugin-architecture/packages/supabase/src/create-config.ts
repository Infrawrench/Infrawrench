import type {
  CreateFieldConfig,
  CreateResourceConfig,
  RegionOption,
  SelectOption,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { SupabaseContext } from "./api.js";
import { sbFetch } from "./api.js";
import { fetchOrganizations, fetchProjects, isRunning } from "./listers.js";
import { COMPUTE_SIZES } from "./resource-types.js";
import type { SbRegion, SbRegionsResponse } from "./types.js";

/** Fallback region names, used only when `available-regions` cannot be read. */
const REGION_NAMES: Record<string, string> = {
  "us-east-1": "East US (North Virginia)",
  "us-east-2": "East US (Ohio)",
  "us-west-1": "West US (North California)",
  "us-west-2": "West US (Oregon)",
  "ca-central-1": "Canada (Central)",
  "sa-east-1": "South America (São Paulo)",
  "eu-west-1": "West EU (Ireland)",
  "eu-west-2": "West Europe (London)",
  "eu-west-3": "West EU (Paris)",
  "eu-central-1": "Central EU (Frankfurt)",
  "eu-central-2": "Central Europe (Zurich)",
  "eu-north-1": "North EU (Stockholm)",
  "ap-south-1": "South Asia (Mumbai)",
  "ap-southeast-1": "Southeast Asia (Singapore)",
  "ap-southeast-2": "Oceania (Sydney)",
  "ap-northeast-1": "Northeast Asia (Tokyo)",
  "ap-northeast-2": "Northeast Asia (Seoul)",
  "ap-east-1": "East Asia (Hong Kong)",
};

const FLAGS: Record<string, string> = {
  us: "\u{1F1FA}\u{1F1F8}",
  ca: "\u{1F1E8}\u{1F1E6}",
  sa: "\u{1F1E7}\u{1F1F7}",
  eu: "\u{1F1EA}\u{1F1FA}",
  ap: "\u{1F30F}",
};

function regionOption(code: string, name: string, recommended = false): RegionOption {
  return {
    id: code,
    label: code,
    location: `${name}${recommended ? " (recommended)" : ""}`,
    flag: FLAGS[code.slice(0, 2)] ?? "",
  };
}

/** Regions a new project in `orgSlug` can use, recommended first. */
export async function regionOptions(
  ctx: SupabaseContext,
  orgSlug: string | undefined,
): Promise<RegionOption[]> {
  if (orgSlug) {
    try {
      const data = await sbFetch<SbRegionsResponse>(
        ctx,
        "GET",
        "/v1/projects/available-regions",
        undefined,
        { organization_slug: orgSlug },
      );
      const recommended = new Set((data?.recommendations?.specific ?? []).map((r) => r.code));
      const all: SbRegion[] = data?.all?.specific ?? [];
      if (all.length > 0) {
        return [...all]
          .sort((a, b) => Number(recommended.has(b.code)) - Number(recommended.has(a.code)))
          .map((r) => regionOption(r.code, r.name, recommended.has(r.code)));
      }
    } catch {
      /* fall back to the static list below */
    }
  }
  return Object.entries(REGION_NAMES).map(([code, name]) => regionOption(code, name));
}

export function computeSizeOptions(includeDefault: boolean): SelectOption[] {
  return [
    ...(includeDefault ? [{ id: "", label: "Smallest available" }] : []),
    ...COMPUTE_SIZES.map((s) => ({ id: s, label: s.replace(/_/g, " ") })),
  ];
}

/** Project picker for child types created outside a project's detail page. */
async function projectPicker(
  ctx: SupabaseContext,
  parentResourceId: string | undefined,
  opts: { runningOnly?: boolean } = {},
): Promise<CreateFieldConfig[]> {
  if (parentResourceId) return [];
  const projects = (await fetchProjects(ctx)).filter((p) => !opts.runningOnly || isRunning(p));
  const options = projects.map((p) => ({
    id: p.ref,
    label: p.name,
    description: `${p.ref} · ${p.region}`,
  }));
  return [
    {
      key: "projectRef",
      label: "Project",
      kind: "select",
      required: true,
      options,
      ...(options[0] ? { defaultValue: options[0].id } : {}),
    },
  ];
}

/** The project a child create targets: the parent page's project, or the picker. */
export function targetProjectRef(
  fields: Record<string, string>,
  parentResourceId: string | undefined,
): string {
  const ref = parentResourceId
    ? externalIdOf(parentResourceId).split("/")[0]
    : fields["projectRef"];
  if (!ref) throw new Error("Supabase plugin: pick a project.");
  return ref;
}

export async function getCreateConfig(
  ctx: SupabaseContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  switch (typeId) {
    case "supabase-project": {
      const orgs = await fetchOrganizations(ctx);
      const regions = await regionOptions(ctx, orgs[0]?.slug);
      return {
        fields: [
          { key: "name", label: "Project Name", kind: "text", required: true },
          {
            key: "organizationSlug",
            label: "Organization",
            kind: "select",
            required: true,
            options: orgs.map((o) => ({ id: o.slug, label: o.name, description: o.slug })),
            ...(orgs[0] ? { defaultValue: orgs[0].slug } : {}),
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions,
            ...(regions[0] ? { defaultValue: regions[0].id } : {}),
          },
          {
            key: "dbPassword",
            label: "Database Password",
            kind: "password",
            required: false,
            description:
              "Password for the postgres role. Leave blank to generate one; Infrawrench stores it encrypted so it can build connection strings.",
          },
          {
            key: "computeSize",
            label: "Compute Size",
            kind: "select",
            required: false,
            options: computeSizeOptions(true),
            defaultValue: "",
            description:
              "Paid organizations only. Free organizations always get the smallest size.",
          },
        ],
      };
    }
    case "supabase-branch": {
      return {
        fields: [
          ...(await projectPicker(ctx, parentResourceId)),
          { key: "name", label: "Branch Name", kind: "text", required: true },
          {
            key: "gitBranch",
            label: "Git Branch",
            kind: "text",
            required: false,
            description:
              "Git branch to sync migrations from, when the project is linked to GitHub.",
          },
          {
            key: "persistent",
            label: "Persistent",
            kind: "select",
            required: false,
            options: [
              { id: "false", label: "No, a preview branch" },
              { id: "true", label: "Yes, keep it (staging)" },
            ],
            defaultValue: "false",
          },
          {
            key: "withData",
            label: "Data",
            kind: "select",
            required: false,
            options: [
              { id: "false", label: "Schema only" },
              { id: "true", label: "Copy data from the parent" },
            ],
            defaultValue: "false",
          },
          {
            key: "computeSize",
            label: "Compute Size",
            kind: "select",
            required: false,
            options: computeSizeOptions(true),
            defaultValue: "",
          },
        ],
      };
    }
    case "supabase-function":
      return {
        fields: [
          ...(await projectPicker(ctx, parentResourceId, { runningOnly: true })),
          {
            key: "slug",
            label: "Slug",
            kind: "text",
            required: true,
            placeholder: "hello-world",
            description:
              "Letters, digits, - and _; the function is served at /functions/v1/{slug}.",
          },
          { key: "name", label: "Display Name", kind: "text", required: false },
          {
            key: "code",
            label: "Code (index.ts)",
            kind: "code",
            codeLanguage: "typescript",
            required: true,
            defaultValue: DEFAULT_FUNCTION_CODE,
          },
          verifyJwtField(),
        ],
      };
    case "supabase-secret":
      return {
        fields: [
          ...(await projectPicker(ctx, parentResourceId, { runningOnly: true })),
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "STRIPE_SECRET_KEY",
            description: "Cannot start with SUPABASE_ (reserved for platform secrets).",
          },
          { key: "value", label: "Value", kind: "password", required: true },
        ],
      };
    case "supabase-api-key":
      return {
        fields: [
          ...(await projectPicker(ctx, parentResourceId, { runningOnly: true })),
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            options: [
              { id: "secret", label: "Secret (server-side, bypasses RLS)" },
              { id: "publishable", label: "Publishable (browsers and apps)" },
            ],
            defaultValue: "secret",
          },
          { key: "name", label: "Name", kind: "text", required: true, placeholder: "backend" },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    case "supabase-bucket":
      return {
        fields: [
          ...(await projectPicker(ctx, parentResourceId, { runningOnly: true })),
          { key: "name", label: "Bucket Name", kind: "text", required: true },
          {
            key: "public",
            label: "Access",
            kind: "select",
            required: true,
            options: [
              { id: "false", label: "Private (signed URLs and RLS)" },
              { id: "true", label: "Public (anyone with the URL)" },
            ],
            defaultValue: "false",
          },
          {
            key: "fileSizeLimit",
            label: "File Size Limit (bytes)",
            kind: "number",
            required: false,
            description: "Leave empty for the project's upload limit.",
          },
          {
            key: "allowedMimeTypes",
            label: "Allowed MIME Types",
            kind: "string-list",
            required: false,
            addLabel: "Add MIME type",
          },
        ],
      };
    case "supabase-read-replica": {
      const projects = parentResourceId ? [] : await fetchProjects(ctx);
      const regions = await regionOptions(
        ctx,
        projects[0]?.organization_slug ?? (await fetchOrganizations(ctx))[0]?.slug,
      );
      return {
        fields: [
          ...(await projectPicker(ctx, parentResourceId, { runningOnly: true })),
          {
            key: "region",
            label: "Replica Region",
            kind: "region-picker",
            required: true,
            regions,
            ...(regions[0] ? { defaultValue: regions[0].id } : {}),
            description: "Pro plan or above, and the project must run on Small compute or larger.",
          },
        ],
      };
    }
    case "supabase-sso-provider":
      return {
        fields: [
          ...(await projectPicker(ctx, parentResourceId, { runningOnly: true })),
          {
            key: "metadataUrl",
            label: "IdP Metadata URL",
            kind: "text",
            required: false,
            placeholder: "https://idp.example.com/saml/metadata",
            description: "Either this or the metadata XML below.",
          },
          {
            key: "metadataXml",
            label: "IdP Metadata XML",
            kind: "code",
            codeLanguage: "xml",
            required: false,
          },
          {
            key: "domains",
            label: "Email Domains",
            kind: "string-list",
            required: false,
            addLabel: "Add domain",
          },
          {
            key: "nameIdFormat",
            label: "NameID Format",
            kind: "select",
            required: false,
            options: [
              { id: "", label: "IdP default" },
              {
                id: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
                label: "Email address",
              },
              { id: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", label: "Persistent" },
              { id: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient", label: "Transient" },
              {
                id: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
                label: "Unspecified",
              },
            ],
            defaultValue: "",
          },
        ],
      };
    case "supabase-third-party-auth":
      return {
        fields: [
          ...(await projectPicker(ctx, parentResourceId, { runningOnly: true })),
          {
            key: "source",
            label: "Trust",
            kind: "select",
            required: true,
            options: [
              { id: "oidc", label: "An OIDC issuer (Clerk, Auth0, Firebase, Cognito, WorkOS…)" },
              { id: "jwks", label: "A JWKS URL" },
            ],
            defaultValue: "oidc",
          },
          {
            key: "url",
            label: "Issuer or JWKS URL",
            kind: "text",
            required: true,
            placeholder: "https://clerk.example.com",
          },
        ],
      };
    case "supabase-signing-key":
      return {
        fields: [
          ...(await projectPicker(ctx, parentResourceId, { runningOnly: true })),
          {
            key: "algorithm",
            label: "Algorithm",
            kind: "select",
            required: true,
            options: [
              { id: "ES256", label: "ES256 (ECC P-256, recommended)" },
              { id: "RS256", label: "RS256 (RSA 2048)" },
              { id: "EdDSA", label: "EdDSA (Ed25519)" },
              { id: "HS256", label: "HS256 (shared secret)" },
            ],
            defaultValue: "ES256",
          },
          {
            key: "status",
            label: "Start As",
            kind: "select",
            required: true,
            options: [
              { id: "standby", label: "Standby (publish now, sign later)" },
              { id: "in_use", label: "In use (start signing immediately)" },
            ],
            defaultValue: "standby",
          },
        ],
      };
    default:
      throw new Error(`Supabase plugin: no create form for "${typeId}".`);
  }
}

function verifyJwtField(): CreateFieldConfig {
  return {
    key: "verifyJwt",
    label: "Verify JWT",
    kind: "select",
    required: false,
    options: [
      { id: "true", label: "Yes, require a valid Supabase JWT" },
      { id: "false", label: "No, public (webhooks and the like)" },
    ],
    defaultValue: "true",
  };
}

export const DEFAULT_FUNCTION_CODE = `Deno.serve(async (req) => {
  const { name } = await req.json().catch(() => ({ name: "world" }));
  return new Response(JSON.stringify({ message: \`Hello \${name}!\` }), {
    headers: { "Content-Type": "application/json" },
  });
});
`;
