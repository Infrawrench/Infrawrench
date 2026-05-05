---
title: Manifest editor
description: Edit raw provider manifests (Kubernetes, Cloudflare) in a Monaco editor.
sidebar_order: 8
---

For resources where the provider’s canonical shape is a document (Kubernetes manifests, Cloudflare zone/worker settings), infrawrench exposes the full document in a Monaco editor on the resource detail page.

<insert [Manifest editor showing a Kubernetes Deployment YAML with a Save button] here>

## Where you get it

- **Kubernetes** — every resource type (Pod, Deployment, StatefulSet, Service, Ingress, ConfigMap, Secret, DaemonSet, Job, CronJob, Namespace, and more) has an editable manifest.
- **Cloudflare** — zone settings and worker scripts.
- **AWS / Azure** — read-only manifest view. Use it to inspect, not to edit.

## Editor features

- Syntax highlighting and validation (JSON / YAML).
- Schema-aware autocomplete for Kubernetes.
- Diff view against the live manifest before save.
- Undo / redo, find / replace.

## Save semantics

- **Kubernetes** — the manifest is applied via the API server. Conflicts surface as an error; resolve them by refreshing.
- **Cloudflare** — settings are pushed field-by-field. Partial failures are reported per field.
- **Read-only providers** — save is disabled; clone the manifest into your IaC tool instead.

## Tips

- Paste real YAML / JSON — infrawrench does not accept half-formed documents.
- Use this for quick patches; for anything you want versioned, do it in git and let your CI apply it.
