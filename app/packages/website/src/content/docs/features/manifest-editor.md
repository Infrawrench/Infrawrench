---
title: Manifest editor
description: Edit raw provider manifests (Kubernetes, Cloudflare) in a Monaco editor.
sidebar_order: 8
---

Some resources are best edited as a document: Kubernetes manifests, Cloudflare zone and worker settings. For those, the resource detail page gives you the full document in a Monaco editor so you can change it and apply it in place.

![Manifest editor showing a Kubernetes Deployment YAML with the Apply button](https://agent-assets.infrawrench.com/docs-screenshots/features/manifest-editor/k8s-deployment-yaml.png)

## Where you can use it

- **Kubernetes:** every resource type (Pod, Deployment, StatefulSet, Service, Ingress, ConfigMap, Secret, DaemonSet, Job, CronJob, Namespace and more) has an editable manifest.
- **Cloudflare:** zone settings and worker scripts.
- **AWS and Azure:** a read-only manifest view for other resource types. Use it to inspect, not to edit.

S3-compatible buckets (AWS S3, DigitalOcean Spaces, Scaleway Object Storage) have their own **Bucket Policy** tab instead. See [Bucket policy editor](./bucket-policy-editor.md).

## Edit a manifest

1. Open the resource and go to its manifest.
2. Make your changes. You get JSON and YAML highlighting, word wrap, bracket-pair colouring, undo and redo, and find and replace. The usual Monaco shortcuts work.
3. Press **Apply ⌘S**. The button stays disabled until you've changed something. While you have unsaved work the toolbar says **Unsaved changes**, and after a successful apply it shows **Applied** for a few seconds.

To throw away your edits and load the live document again, click **Reload**.

## What happens when you apply

- **Kubernetes:** the manifest is applied to the cluster. If there's a conflict you'll see an error. Click **Reload** to pick up the latest version and try again.
- **Cloudflare:** settings are saved one field at a time, and any field that fails is reported on its own.
- **Read-only providers:** you'll see a **Read-only** chip and no Apply button. Copy the manifest into your IaC tool instead.

## Tips

- Paste complete, valid YAML or JSON. Half-formed documents are rejected.
- Use the editor for quick patches. For anything you want versioned, change it in git and let your CI apply it.
