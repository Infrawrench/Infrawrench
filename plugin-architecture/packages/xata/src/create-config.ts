import type {
  CreateFieldConfig,
  CreateResourceConfig,
  RegionOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import type { XataContext, XImage, XInstanceType, XRegion } from "./api.js";
import { enc, xata } from "./api.js";
import type { XataClient } from "./client.js";
import { API_KEY_SCOPES } from "./resource-types.js";

const HOURS_PER_MONTH = 730;

async function orgPicker(client: XataClient, parent: string[]): Promise<CreateFieldConfig[]> {
  if (parent.length) return [];
  const orgs = await client.orgs();
  const options = orgs.map((o) => ({ id: o.id, label: o.name, description: o.id }));
  return [
    {
      key: "organizationId",
      label: "Organization",
      kind: "select",
      required: true,
      options,
      ...(options[0] ? { defaultValue: options[0].id } : {}),
    },
  ];
}

export async function getCreateConfig(
  ctx: XataContext,
  client: XataClient,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  const parent = parentResourceId ? parentResourceId.split(":").slice(2).join(":").split("/") : [];
  switch (typeId) {
    case "xata-project":
      return {
        fields: [
          ...(await orgPicker(client, parent)),
          { key: "name", label: "Project Name", kind: "text", required: true },
        ],
      };
    case "xata-branch": {
      const orgs = await client.orgs();
      const org = parent[0] ?? orgs[0]?.id ?? "";
      const projectFields: CreateFieldConfig[] = [];
      const branchOptions: Array<{ id: string; label: string; description?: string }> = [];
      if (parent.length >= 2) {
        for (const b of await client.branchSummaries(parent[0]!, parent[1]!)) {
          branchOptions.push({ id: b.id, label: b.name, description: b.region });
        }
      } else {
        const projectOptions: Array<{ id: string; label: string }> = [];
        for (const o of orgs) {
          for (const p of await client.projects(o.id)) {
            projectOptions.push({ id: `${o.id}/${p.id}`, label: `${o.name} / ${p.name}` });
            for (const b of await client.branchSummaries(o.id, p.id)) {
              branchOptions.push({
                id: b.id,
                label: `${p.name} / ${b.name}`,
                description: b.region,
              });
            }
          }
        }
        projectFields.push({
          key: "projectRef",
          label: "Project",
          kind: "select",
          required: true,
          options: projectOptions,
          ...(projectOptions[0] ? { defaultValue: projectOptions[0].id } : {}),
        });
      }
      const regions = org
        ? ((await xata<{ regions?: XRegion[] }>(ctx, "GET", `/organizations/${enc(org)}/regions`))
            ?.regions ?? [])
        : [];
      const regionOptions: RegionOption[] = regions.map((r) => ({
        id: r.id,
        label: r.id,
        location: `${r.provider.toUpperCase()}${r.backupsEnabled ? "" : " (no backups)"}${r.publicAccess ? "" : " (private)"}`,
      }));
      const firstRegion = regionOptions[0]?.id ?? "";
      const sizes: SizeOption[] = [];
      const images: Array<{ id: string; label: string }> = [];
      if (org && firstRegion) {
        const perRegion = await Promise.all(
          regions.map(async (r) => ({
            region: r.id,
            types:
              (
                await xata<{ instanceTypes?: XInstanceType[] }>(
                  ctx,
                  "GET",
                  `/organizations/${enc(org)}/instanceTypes`,
                  undefined,
                  {
                    region: r.id,
                  },
                ).catch(() => undefined)
              )?.instanceTypes ?? [],
          })),
        );
        const byName = new Map<string, SizeOption>();
        for (const { region, types } of perRegion) {
          for (const t of types) {
            const existing = byName.get(t.name);
            if (existing) existing.availableFor = [...(existing.availableFor ?? []), region];
            else
              byName.set(t.name, {
                id: t.name,
                label: t.name,
                vcpus: t.vcpus,
                memoryMb: t.ram * 1024,
                priceMonthly: Math.round(t.hourlyRate * HOURS_PER_MONTH * 100) / 100,
                availableFor: [region],
              });
          }
        }
        sizes.push(...byName.values());
        const imgs =
          (
            await xata<{ images?: XImage[] }>(
              ctx,
              "GET",
              `/organizations/${enc(org)}/images`,
            ).catch(() => undefined)
          )?.images ?? [];
        for (const i of imgs)
          images.push({ id: i.name, label: `Postgres ${i.fullVersion} (${i.name})` });
      }
      const custom = { fieldKey: "mode", fieldValue: "custom" };
      return {
        fields: [
          ...projectFields,
          { key: "name", label: "Branch Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "mode",
            label: "Start From",
            kind: "select",
            required: true,
            options: [
              { id: "custom", label: "A new, empty database" },
              { id: "inherit", label: "A copy of another branch (copy-on-write)" },
              { id: "restore", label: "The latest backup of another branch" },
            ],
            defaultValue: branchOptions.length ? "inherit" : "custom",
          },
          {
            key: "parentId",
            label: "Source Branch",
            kind: "select",
            required: false,
            options: branchOptions,
            ...(branchOptions[0] ? { defaultValue: branchOptions[0].id } : {}),
            showWhen: { fieldKey: "mode", fieldValues: ["inherit", "restore"] },
          },
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: false,
            regions: regionOptions,
            ...(firstRegion ? { defaultValue: firstRegion } : {}),
            showWhen: custom,
          },
          {
            key: "instanceType",
            label: "Instance Type",
            kind: "size-picker",
            required: false,
            sizes,
            filterByFieldKey: "region",
            ...(sizes[0] ? { defaultValue: sizes[0].id } : {}),
            showWhen: custom,
          },
          {
            key: "image",
            label: "Postgres Version",
            kind: "select",
            required: false,
            options: images,
            ...(images[0] ? { defaultValue: images[0].id } : {}),
            showWhen: custom,
          },
          {
            key: "replicas",
            label: "Replicas",
            kind: "number",
            required: false,
            minValue: 0,
            maxValue: 4,
            defaultValue: "0",
            showWhen: custom,
          },
          {
            key: "storageGb",
            label: "Storage (GiB)",
            kind: "number",
            required: false,
            minValue: 1,
            maxValue: 250,
            showWhen: custom,
          },
          {
            key: "scaleToZero",
            label: "Scale to Zero",
            kind: "select",
            required: false,
            options: [
              { id: "", label: "Project default" },
              { id: "true", label: "Hibernate when idle" },
              { id: "false", label: "Always on" },
            ],
            defaultValue: "",
          },
          {
            key: "inactivityMinutes",
            label: "Idle Minutes Before Hibernating",
            kind: "number",
            required: false,
            defaultValue: "30",
            showWhen: { fieldKey: "scaleToZero", fieldValue: "true" },
          },
        ],
      };
    }
    case "xata-api-key": {
      const org = parent[0] ?? (await client.orgs())[0]?.id ?? "";
      const projects = org ? await client.projects(org) : [];
      return {
        fields: [
          ...(await orgPicker(client, parent)),
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "scopes",
            label: "Scopes",
            kind: "policy-picker",
            required: false,
            description: "Leave empty for no restriction.",
            policies: API_KEY_SCOPES.map((s) => ({
              id: s,
              label: s,
              category: s.split(":")[0] ?? "",
            })),
          },
          {
            key: "projects",
            label: "Limit to Projects",
            kind: "policy-picker",
            required: false,
            description: "Leave empty for every project.",
            policies: projects.map((p) => ({ id: p.id, label: p.name })),
          },
          { key: "expiresAt", label: "Expires At", kind: "datetime", required: false },
        ],
      };
    }
    case "xata-invitation":
      return {
        fields: [
          ...(await orgPicker(client, parent)),
          { key: "email", label: "Email", kind: "text", required: true },
          {
            key: "role",
            label: "Role",
            kind: "select",
            required: true,
            options: [
              { id: "editor", label: "Editor" },
              { id: "admin", label: "Admin" },
            ],
            defaultValue: "editor",
          },
        ],
      };
    default:
      throw new Error(`Xata plugin: no create form for "${typeId}".`);
  }
}
