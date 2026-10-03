import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A DigitalOcean VPC NAT gateway (`/v2/vpc_nat_gateways`): gives Droplets in
 * a VPC outbound internet access through one public egress IP without public
 * interfaces of their own.
 *
 * Shape verified against digitalocean/openapi
 * (`specification/resources/vpc_nat_gateways/models/vpc_nat_gateway_get.yml`).
 * `size` is the scaling unit: each unit is 2 Gbps symmetric bandwidth and
 * includes 100 GiB of outbound transfer a month.
 */
export const VpcNatGatewayResourceType = rt({
  name: "NAT Gateway",
  id: "vpc-nat-gateway",
  description: "A DigitalOcean VPC NAT gateway providing outbound internet access to a VPC.",
  fields: [
    f("name", "Name"),
    f("region", "Region", { editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("size", "Size", {
      kind: "number",
      required: false,
      description: "Scaling units (1-5). Each adds 2 Gbps of bandwidth and is billed separately.",
    }),
    f("vpcUuids", "VPCs", {
      required: false,
      editable: false,
      description: "Comma-separated UUIDs of the VPCs routed through this gateway.",
    }),
    f("egressIp", "Egress IP", { required: false, editable: false }),
    f("udpTimeoutSeconds", "UDP Timeout (s)", { kind: "number", required: false }),
    f("tcpTimeoutSeconds", "TCP Timeout (s)", { kind: "number", required: false }),
    f("icmpTimeoutSeconds", "ICMP Timeout (s)", { kind: "number", required: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [o("egressIp", "Egress IP")],
  dependsOn: [{ fieldKey: "vpcUuids", targetTypeId: "vpc", label: "routes" }],
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "network",
});
