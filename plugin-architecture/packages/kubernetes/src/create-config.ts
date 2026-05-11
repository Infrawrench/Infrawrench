import type { CreateResourceConfig } from "@infrawrench/plugin-base";

import type { K8sList, K8sNamespace } from "./types.js";
import { SYSTEM_NAMESPACES } from "./resource-listers.js";
import type { K8sFetch } from "./shared.js";

/**
 * Build the create-resource form schema for a given k8s resource type. The
 * forms are kubernetes-flavored — namespaced resources prompt for a namespace
 * (skipped when creating under a Namespace parent), and image-bearing
 * workloads share common image/replica fields.
 */
export async function getCreateConfig(
  typeId: string,
  parentResourceId: string | undefined,
  k8sFetch: K8sFetch,
): Promise<CreateResourceConfig> {
  const parentTypeId = parentResourceId?.split(":")[1] ?? "";
  const parentIsNamespace = parentTypeId === "k8s-namespace";
  const namespaceField = async (): Promise<CreateResourceConfig["fields"][number]> => {
    let namespaceOptions: { id: string; label: string }[] = [{ id: "default", label: "default" }];
    try {
      const nsData = await k8sFetch<K8sList<K8sNamespace>>("/api/v1/namespaces");
      namespaceOptions = nsData.items
        .filter((ns) => !SYSTEM_NAMESPACES.has(ns.metadata.name))
        .map((ns) => ({ id: ns.metadata.name, label: ns.metadata.name }))
        .sort((a, b) => a.label.localeCompare(b.label));
    } catch {
      /* fall back to default */
    }
    return {
      key: "namespace",
      label: "Namespace",
      kind: "select",
      required: true,
      defaultValue: "default",
      options: namespaceOptions,
    };
  };

  if (typeId === "k8s-pod") {
    const fields: CreateResourceConfig["fields"] = [
      {
        key: "name",
        label: "Pod Name",
        kind: "text",
        required: true,
        defaultValue: `scratch-${Date.now().toString(36)}`,
        description: "A unique name for your scratch pod",
      },
    ];
    if (!parentIsNamespace) fields.push(await namespaceField());
    fields.push(
      {
        key: "image",
        label: "OS Image",
        kind: "select",
        required: true,
        defaultValue: "ubuntu:24.04",
        description: "Base OS for your scratch pod",
        options: [
          { id: "ubuntu:24.04", label: "Ubuntu 24.04 LTS" },
          { id: "ubuntu:22.04", label: "Ubuntu 22.04 LTS" },
          { id: "debian:12", label: "Debian 12 (Bookworm)" },
          { id: "debian:11", label: "Debian 11 (Bullseye)" },
          { id: "alpine:3.20", label: "Alpine 3.20" },
          { id: "fedora:40", label: "Fedora 40" },
          { id: "rockylinux:9", label: "Rocky Linux 9" },
          { id: "amazonlinux:2023", label: "Amazon Linux 2023" },
          { id: "archlinux:latest", label: "Arch Linux (latest)" },
          { id: "custom", label: "Custom image…" },
        ],
      },
      {
        key: "customImage",
        label: "Custom Image",
        kind: "text",
        required: true,
        description: "Full container image reference (e.g. myregistry.io/myimage:tag)",
        showWhen: { fieldKey: "image", fieldValue: "custom" },
      },
      {
        key: "ttl",
        label: "Time to Live",
        kind: "select",
        required: true,
        defaultValue: "3600",
        description: "Pod auto-terminates and is cleaned up after this duration",
        options: [
          { id: "900", label: "15 minutes" },
          { id: "1800", label: "30 minutes" },
          { id: "3600", label: "1 hour" },
          { id: "7200", label: "2 hours" },
          { id: "14400", label: "4 hours" },
          { id: "28800", label: "8 hours" },
          { id: "86400", label: "24 hours" },
        ],
      },
    );
    return { fields };
  }
  if (typeId === "k8s-configmap") {
    const fields: CreateResourceConfig["fields"] = [
      { key: "name", label: "Name", kind: "text", required: true },
    ];
    if (!parentIsNamespace) {
      fields.push({
        key: "namespace",
        label: "Namespace",
        kind: "text",
        required: true,
        defaultValue: "default",
      });
    }
    return { fields };
  }
  if (typeId === "k8s-namespace") {
    return {
      fields: [
        {
          key: "name",
          label: "Namespace Name",
          kind: "text",
          required: true,
          description: "Lowercase letters, numbers, and hyphens",
        },
      ],
    };
  }

  if (typeId === "k8s-secret") {
    const fields: CreateResourceConfig["fields"] = [
      { key: "name", label: "Secret Name", kind: "text", required: true },
    ];
    if (!parentIsNamespace) fields.push(await namespaceField());
    fields.push({
      key: "type",
      label: "Secret Type",
      kind: "select",
      required: true,
      defaultValue: "Opaque",
      options: [
        { id: "Opaque", label: "Opaque (generic)" },
        { id: "kubernetes.io/dockerconfigjson", label: "Docker Registry" },
        { id: "kubernetes.io/tls", label: "TLS Certificate" },
        { id: "kubernetes.io/basic-auth", label: "Basic Auth" },
      ],
    });
    return { fields };
  }

  if (typeId === "k8s-deployment") {
    const fields: CreateResourceConfig["fields"] = [
      { key: "name", label: "Deployment Name", kind: "text", required: true },
    ];
    if (!parentIsNamespace) fields.push(await namespaceField());
    fields.push(
      {
        key: "image",
        label: "Container Image",
        kind: "text",
        required: true,
        description: "e.g. nginx:latest or myregistry.io/myapp:v1",
      },
      {
        key: "replicas",
        label: "Replicas",
        kind: "number",
        required: true,
        defaultValue: "1",
        minValue: 1,
        maxValue: 100,
        stepValue: 1,
      },
      {
        key: "containerPort",
        label: "Container Port",
        kind: "number",
        required: false,
        description: "Port the container listens on",
        defaultValue: "80",
      },
    );
    return { fields };
  }

  if (typeId === "k8s-service") {
    const fields: CreateResourceConfig["fields"] = [
      { key: "name", label: "Service Name", kind: "text", required: true },
    ];
    if (!parentIsNamespace) fields.push(await namespaceField());
    fields.push(
      {
        key: "type",
        label: "Service Type",
        kind: "select",
        required: true,
        defaultValue: "ClusterIP",
        options: [
          { id: "ClusterIP", label: "ClusterIP" },
          { id: "NodePort", label: "NodePort" },
          { id: "LoadBalancer", label: "LoadBalancer" },
        ],
      },
      {
        key: "port",
        label: "Port",
        kind: "number",
        required: true,
        defaultValue: "80",
        description: "Port the service exposes",
      },
      {
        key: "targetPort",
        label: "Target Port",
        kind: "number",
        required: true,
        defaultValue: "80",
        description: "Port on the target pods",
      },
      {
        key: "selector",
        label: "Selector (app label)",
        kind: "text",
        required: true,
        description: "Value of the app label to select pods, e.g. my-app",
      },
    );
    return { fields };
  }

  if (typeId === "k8s-ingress") {
    const fields: CreateResourceConfig["fields"] = [
      { key: "name", label: "Ingress Name", kind: "text", required: true },
    ];
    if (!parentIsNamespace) fields.push(await namespaceField());
    fields.push(
      {
        key: "ingressClassName",
        label: "Ingress Class",
        kind: "text",
        required: false,
        description: "e.g. nginx, traefik",
      },
      {
        key: "host",
        label: "Host",
        kind: "text",
        required: true,
        description: "e.g. app.example.com",
      },
      {
        key: "serviceName",
        label: "Backend Service",
        kind: "text",
        required: true,
        description: "Name of the Service to route to",
      },
      {
        key: "servicePort",
        label: "Service Port",
        kind: "number",
        required: true,
        defaultValue: "80",
      },
    );
    return { fields };
  }

  if (typeId === "k8s-job") {
    const fields: CreateResourceConfig["fields"] = [
      { key: "name", label: "Job Name", kind: "text", required: true },
    ];
    if (!parentIsNamespace) fields.push(await namespaceField());
    fields.push(
      {
        key: "image",
        label: "Container Image",
        kind: "text",
        required: true,
        description: "e.g. busybox:latest",
      },
      {
        key: "command",
        label: "Command",
        kind: "text",
        required: false,
        description: "e.g. echo hello",
      },
      {
        key: "completions",
        label: "Completions",
        kind: "number",
        required: false,
        defaultValue: "1",
      },
    );
    return { fields };
  }

  if (typeId === "k8s-cronjob") {
    const fields: CreateResourceConfig["fields"] = [
      { key: "name", label: "CronJob Name", kind: "text", required: true },
    ];
    if (!parentIsNamespace) fields.push(await namespaceField());
    fields.push(
      {
        key: "schedule",
        label: "Schedule",
        kind: "text",
        required: true,
        description: "Cron expression, e.g. */5 * * * *",
      },
      {
        key: "image",
        label: "Container Image",
        kind: "text",
        required: true,
        description: "e.g. busybox:latest",
      },
      {
        key: "command",
        label: "Command",
        kind: "text",
        required: false,
        description: "e.g. echo hello",
      },
    );
    return { fields };
  }

  if (typeId === "k8s-statefulset") {
    const fields: CreateResourceConfig["fields"] = [
      { key: "name", label: "StatefulSet Name", kind: "text", required: true },
    ];
    if (!parentIsNamespace) fields.push(await namespaceField());
    fields.push(
      {
        key: "image",
        label: "Container Image",
        kind: "text",
        required: true,
        description: "e.g. postgres:16",
      },
      {
        key: "replicas",
        label: "Replicas",
        kind: "number",
        required: true,
        defaultValue: "1",
        minValue: 1,
        maxValue: 100,
      },
      {
        key: "serviceName",
        label: "Headless Service Name",
        kind: "text",
        required: true,
        description: "Name of the governing headless Service",
      },
      {
        key: "containerPort",
        label: "Container Port",
        kind: "number",
        required: false,
        defaultValue: "80",
      },
    );
    return { fields };
  }

  if (typeId === "k8s-daemonset") {
    const fields: CreateResourceConfig["fields"] = [
      { key: "name", label: "DaemonSet Name", kind: "text", required: true },
    ];
    if (!parentIsNamespace) fields.push(await namespaceField());
    fields.push(
      {
        key: "image",
        label: "Container Image",
        kind: "text",
        required: true,
        description: "e.g. fluentd:latest",
      },
      {
        key: "containerPort",
        label: "Container Port",
        kind: "number",
        required: false,
      },
    );
    return { fields };
  }

  throw new Error(`No create config for type "${typeId}"`);
}
