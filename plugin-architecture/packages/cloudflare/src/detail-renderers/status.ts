import type { ResourceStatus } from "@infrawrench/plugin-base";

export function tunnelStatus(status: string): ResourceStatus {
  switch (status) {
    case "healthy":
      return "healthy";
    case "active":
      return "healthy";
    case "degraded":
      return "degraded";
    case "inactive":
      return "error";
    case "down":
      return "error";
    default:
      return "info";
  }
}

export function deploymentStatus(status: string): ResourceStatus {
  switch (status) {
    case "success":
      return "healthy";
    case "active":
      return "healthy";
    case "failure":
      return "error";
    case "idle":
      return "info";
    default:
      return "provisioning";
  }
}

export function sslStatus(status: string): ResourceStatus {
  switch (status) {
    case "active":
      return "healthy";
    case "pending_validation":
      return "provisioning";
    case "pending_issuance":
      return "provisioning";
    case "pending_deployment":
      return "provisioning";
    case "expired":
      return "error";
    case "deleted":
      return "error";
    default:
      return "info";
  }
}
