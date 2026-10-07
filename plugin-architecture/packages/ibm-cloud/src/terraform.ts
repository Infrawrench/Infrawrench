import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for the official `IBM-Cloud/ibm` provider (v2.6 at the
 * time of writing). Argument names and import ids follow the provider's docs
 * (github.com/IBM-Cloud/terraform-provider-ibm, website/docs/r/*): VPC
 * resources import by their bare id, Code Engine apps by
 * `{project_id}/{name}`. The provider's region must match the resource's, so
 * a regional resource carries a comment saying which region it lives in.
 */

function bareId(resource: ResourceInstance): string {
  const ext = resource.externalId ?? "";
  return ext.slice(ext.lastIndexOf("/") + 1);
}

export const ibmTerraformExport: TerraformExportCapability = {
  provider: { name: "ibm", source: "IBM-Cloud/ibm", version: "~> 2.6" },
  providerConfig: {
    ibmcloud_api_key: tf.ref("var.ibmcloud_api_key"),
    region: tf.ref("var.ibmcloud_region"),
  },
  variables: [
    { name: "ibmcloud_api_key", description: "IBM Cloud API key", sensitive: true },
    { name: "ibmcloud_region", description: "Region for the provider, e.g. us-south" },
  ],
  supportedResourceTypeIds: [
    "resource-group",
    "instance",
    "volume",
    "vpc",
    "subnet",
    "security-group",
    "floating-ip",
    "load-balancer",
    "code-engine-project",
    "code-engine-app",
  ],
  mapResource(resource: ResourceInstance): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    const region = fieldString(resource, "region");
    const rg = fieldString(resource, "resourceGroupId");
    const comments = region
      ? [`Lives in ${region}: use a provider alias for that region if it differs.`]
      : [];
    const block = (
      type: string,
      attributes: Record<string, TerraformValue>,
      importId = bareId(resource),
      extra: string[] = [],
    ): TerraformExportResult => {
      if (rg && type === "ibm_code_engine_project") attributes["resource_group_id"] = tf.str(rg);
      else if (rg && type !== "ibm_resource_group" && type !== "ibm_code_engine_app") {
        attributes["resource_group"] = tf.str(rg);
      }
      return {
        resource: {
          type,
          name: name || importId,
          attributes,
          importId,
          ...(comments.length || extra.length ? { comments: [...comments, ...extra] } : {}),
        },
      };
    };
    switch (resource.resourceTypeId) {
      case "resource-group":
        return block("ibm_resource_group", { name: tf.str(name) }, resource.externalId ?? "");
      case "instance": {
        const image = fieldString(resource, "imageId");
        const profile = fieldString(resource, "profile");
        const vpc = fieldString(resource, "vpcId");
        const zone = fieldString(resource, "zone");
        const subnet = fieldString(resource, "subnetId");
        if (!image || !profile || !vpc || !zone || !subnet) return null;
        return block(
          "ibm_is_instance",
          {
            name: tf.str(name),
            image: tf.str(image),
            profile: tf.str(profile),
            vpc: tf.str(vpc),
            zone: tf.str(zone),
            primary_network_interface: tf.block({ subnet: tf.str(subnet) }),
            keys: tf.list([]),
          },
          bareId(resource),
          [
            "Fill `keys` with the SSH key ids the server was created with; changing `image` forces replacement.",
          ],
        );
      }
      case "volume": {
        const zone = fieldString(resource, "zone");
        if (!zone) return null;
        const attrs: Record<string, TerraformValue> = {
          name: tf.str(name),
          zone: tf.str(zone),
          profile: tf.str(fieldString(resource, "profile") || "general-purpose"),
        };
        const capacity = fieldNumber(resource, "capacityGb");
        if (capacity !== undefined) attrs["capacity"] = tf.num(capacity);
        return block("ibm_is_volume", attrs);
      }
      case "vpc":
        return block("ibm_is_vpc", { name: tf.str(name) });
      case "subnet": {
        const vpc = fieldString(resource, "vpcId");
        const zone = fieldString(resource, "zone");
        const cidr = fieldString(resource, "cidrBlock");
        if (!vpc || !zone) return null;
        const attrs: Record<string, TerraformValue> = {
          name: tf.str(name),
          vpc: tf.str(vpc),
          zone: tf.str(zone),
        };
        if (cidr) attrs["ipv4_cidr_block"] = tf.str(cidr);
        return block("ibm_is_subnet", attrs);
      }
      case "security-group": {
        const vpc = fieldString(resource, "vpcId");
        if (!vpc) return null;
        return block(
          "ibm_is_security_group",
          { name: tf.str(name), vpc: tf.str(vpc) },
          bareId(resource),
          ["Rules are separate ibm_is_security_group_rule resources."],
        );
      }
      case "floating-ip": {
        const zone = fieldString(resource, "zone");
        const attrs: Record<string, TerraformValue> = { name: tf.str(name) };
        if (zone) attrs["zone"] = tf.str(zone);
        return block("ibm_is_floating_ip", attrs);
      }
      case "load-balancer": {
        const subnets = (fieldString(resource, "subnetIds") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!subnets.length) return null;
        return block(
          "ibm_is_lb",
          {
            name: tf.str(name),
            subnets: tf.list(subnets.map((s) => tf.str(s))),
            type: tf.str(resource.fields["isPublic"] === false ? "private" : "public"),
          },
          bareId(resource),
          ["Listeners and pools are separate ibm_is_lb_listener and ibm_is_lb_pool resources."],
        );
      }
      case "code-engine-project":
        return block("ibm_code_engine_project", { name: tf.str(name) });
      case "code-engine-app": {
        const project = fieldString(resource, "projectId");
        const image = fieldString(resource, "image");
        if (!project || !image) return null;
        const attrs: Record<string, TerraformValue> = {
          project_id: tf.str(project),
          name: tf.str(name),
          image_reference: tf.str(image),
        };
        const port = fieldNumber(resource, "port");
        if (port !== undefined) attrs["image_port"] = tf.num(port);
        const min = fieldNumber(resource, "minInstances");
        if (min !== undefined) attrs["scale_min_instances"] = tf.num(min);
        const max = fieldNumber(resource, "maxInstances");
        if (max !== undefined) attrs["scale_max_instances"] = tf.num(max);
        const cpu = fieldString(resource, "cpu");
        if (cpu) attrs["scale_cpu_limit"] = tf.str(cpu);
        const memory = fieldString(resource, "memory");
        if (memory) attrs["scale_memory_limit"] = tf.str(memory);
        return block("ibm_code_engine_app", attrs, `${project}/${name}`);
      }
      default:
        return null;
    }
  },
};
