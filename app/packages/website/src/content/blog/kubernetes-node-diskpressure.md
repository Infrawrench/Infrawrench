---
title: "Kubernetes node DiskPressure: find what is filling the disk and stop the evictions"
description: "Fix Kubernetes DiskPressure by finding which node filesystem crossed its eviction threshold, what is using it, and setting ephemeral-storage requests, limits and emptyDir size limits so it does not happen again."
date: "2026-11-01"
kind: guide
---

When a node reports DiskPressure, the kubelet has seen free disk space or free inodes on one of the node's filesystems fall below an eviction threshold. New pods stop landing on the node, the kubelet starts deleting dead containers and unused images, and if that is not enough it evicts running pods. This guide shows how to confirm the condition, work out which filesystem is short and what is filling it, and set ephemeral storage requests and limits so a single workload cannot fill a node again.

Prerequisites: kubectl installed, access to the cluster, and permission to read nodes, pods and events. Checking the node's disks directly needs SSH or console access to the node. Everything here follows the official Kubernetes documentation on [node-pressure eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/) and [local ephemeral storage](https://kubernetes.io/docs/concepts/storage/ephemeral-storage/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME and NODE_NAME. Replace them before running a command. If you already have evicted pods to clean up, the [evicted pods guide](/blog/kubernetes-evicted-pods) covers that side.

## What DiskPressure means

The kubelet watches up to three filesystems on each node:

- **nodefs**: the node's main filesystem. It holds `/var/lib/kubelet`, local volumes, `emptyDir` volumes that are not backed by memory, logs and other ephemeral storage.
- **imagefs**: an optional filesystem the container runtime uses for container images. If there is no separate containerfs, it also holds the writable layers of running containers.
- **containerfs**: an optional filesystem for container writable layers only. It needs the `KubeletSeparateDiskGC` feature gate and, per the docs, is currently supported only by CRI-O.

These are names for what the kubelet observes, not necessarily separate disks. On many nodes all three are the same filesystem. Others keep the container runtime's storage on a dedicated disk, in which case imagefs and containerfs are the same and nodefs is separate.

For each filesystem the kubelet tracks free space (`available`) and free inodes (`inodesFree`). When either crosses an eviction threshold, the kubelet sets the node's DiskPressure condition to True. The default hard thresholds are:

- `nodefs.available<10%`
- `imagefs.available<15%`
- `nodefs.inodesFree<5%` on Linux nodes
- `imagefs.inodesFree<5%` on Linux nodes

A hard threshold has no grace period: pods the kubelet evicts to meet it are killed without graceful termination. Clusters can also set soft thresholds with grace periods, so read your kubelet configuration if the numbers you see do not match these.

## Step 1: Confirm the condition and the taint

Check you are pointed at the right cluster, then look for nodes with DiskPressure:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get nodes
kubectl --context CONTEXT_NAME describe node NODE_NAME
```

In the `describe` output, find the Conditions table. DiskPressure with status True confirms it. Also check the Taints line. When DiskPressure is active the control plane adds the `node.kubernetes.io/disk-pressure` taint with a `NoSchedule` effect, so the scheduler stops placing new pods on the node. DaemonSet pods tolerate that taint automatically, so they can still land there.

The events at the bottom of the output show what the kubelet has already done, such as freeing disk space by deleting images or evicting pods.

If the condition keeps switching between True and False, that is expected for a short time. The kubelet waits for the `eviction-pressure-transition-period`, 5 minutes by default, before it moves the condition back to False, to stop it flapping.

## Step 2: Work out whether it is space or inodes, and which filesystem

The fix depends on which signal tripped. Running out of inodes looks the same in the condition, but the cause is a very large number of small files rather than a few large ones.

If you have shell access to the node, check both space and inodes on the filesystems that hold the kubelet's directory and the container runtime's storage:

```
df -h
df -i
```

Look at the mounts that hold `/var/lib/kubelet`, which is on nodefs, and your container runtime's storage directory, which is on imagefs if the runtime uses a separate disk. Compare free space with the 10% and 15% defaults and free inodes with 5%.

Which filesystem is full tells you where to look next:

- **nodefs full**: container logs, `emptyDir` volumes and other pod data written under the kubelet's directory, or files outside Kubernetes on the same disk.
- **imagefs full**: container images, and container writable layers when there is no separate containerfs.

## Step 3: Understand what the kubelet reclaims first

Before it evicts anything, the kubelet tries to free space at node level:

- With a single filesystem, it garbage collects dead pods and containers, then deletes unused images.
- With a separate imagefs, it garbage collects dead pods and containers when nodefs is short, and deletes all unused images when imagefs is short.

Image garbage collection also runs on its own, independently of eviction. When disk usage goes above the kubelet's `HighThresholdPercent`, it deletes images starting with the least recently used and stops when usage reaches `LowThresholdPercent`. A node can also remove images that have not been used for longer than `imageMaximumGCAge`, if that is set in the kubelet configuration.

The docs advise against external garbage collection tools on nodes, because they can break kubelet behaviour and remove containers that should exist. Let the kubelet manage images and containers. If imagefs keeps filling up even after garbage collection, the node is pulling more or larger images than its disk can hold: give the runtime's disk more room or reduce the number of different images that run on that node.

## Step 4: Find the pods using the most disk

If reclaiming is not enough, the kubelet evicts pods. Which pods go first depends on the layout:

- With one filesystem, pods are ranked by total disk use: local volumes, logs and the writable layers of all their containers.
- With a separate imagefs, nodefs pressure ranks pods by local volumes and logs, and imagefs pressure ranks them by their containers' writable layers.

Within that, pods using more ephemeral storage than they request are evicted before pods using less, then by priority. The docs point out that QoS class does not apply to ephemeral storage, so a Guaranteed pod is not protected from a DiskPressure eviction the way it is for memory.

List the pods on the node to see which are still running and which were evicted:

```
kubectl --context CONTEXT_NAME get pods --all-namespaces --field-selector spec.nodeName=NODE_NAME -o wide
```

An evicted pod has status Failed with reason Evicted, and its `describe` output usually names the resource and the containers using the most. Typical culprits are applications that log heavily to standard output, workloads that write caches or temporary files into their writable layer or an `emptyDir` volume, and images that are unusually large.

## Step 5: Set ephemeral-storage requests and limits

Requests and limits for `ephemeral-storage` stop one workload from filling the node and let the scheduler account for disk use. Each container can set either or both:

```yaml
resources:
  requests:
    ephemeral-storage: "2Gi"
  limits:
    ephemeral-storage: "4Gi"
```

Watch the units. `400Mi` is 400 mebibytes. `400m` is 0.4 bytes, which is almost certainly not what you meant.

When the kubelet is measuring local ephemeral storage, it enforces limits like this:

- **Container level.** If a container's writable layer and logs use more than its limit, the kubelet marks the pod for eviction.
- **Pod level.** The kubelet adds up the containers' limits. If the containers plus the pod's `emptyDir` volumes use more than that total, it marks the pod for eviction.

That turns a node-wide incident into the eviction of the one pod that went over, which is far easier to diagnose. The scheduler also uses requests to place pods only on nodes with enough allocatable ephemeral storage.

For `emptyDir` volumes, set a `sizeLimit`:

```yaml
volumes:
  - name: scratch
    emptyDir:
      sizeLimit: 500Mi
```

Memory-backed `emptyDir` volumes, with `medium: Memory`, count against memory rather than ephemeral storage, so they do not add to disk pressure.

Note one subtlety from the docs. With periodic scanning, the kubelet does not see space used by a file that was deleted while still open. A process that keeps writing to a deleted log file can fill the disk without it showing up in the pod's measured usage. The space is released when the file is closed, for example when the process restarts.

## Step 6: Move data that does not belong on the node

Ephemeral storage is for scratch space, caches and logs. Data that is large or needs to outlive the pod belongs on a PersistentVolume, not in an `emptyDir` or the container's writable layer. If a workload's PersistentVolumeClaim will not bind, the [PVC Pending guide](/blog/kubernetes-pvc-pending) covers that.

Container logs are another common source. Logging less, or rotating and shipping logs off the node, keeps nodefs from filling with output nobody reads.

## Step 7: Verify

Once space is freed, check the node again:

```
kubectl --context CONTEXT_NAME describe node NODE_NAME
```

DiskPressure should return to False after the transition period, and the `node.kubernetes.io/disk-pressure` taint should be removed so new pods can be scheduled there. Check that evicted workloads have replacements running, and that any pods waiting to be scheduled are not stuck in [Pending](/blog/kubernetes-pod-pending) for lack of room elsewhere.

## Conclusion

DiskPressure means one of the node's filesystems crossed a threshold for free space or free inodes. Confirm the condition and taint, find out whether nodefs or imagefs is short and whether it is space or inodes, then find the pods and images using it. Let the kubelet garbage collect images, and stop it happening again with ephemeral-storage requests and limits, `emptyDir` size limits and PersistentVolumes for data that should not live on the node.

If you look after nodes across several clusters and clouds, Infrawrench brings SSH terminals, Kubernetes exec and logs and your cloud resources into one workspace, so checking a node's disks and its pods happens in one place. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Node-pressure eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)
- [Local ephemeral storage](https://kubernetes.io/docs/concepts/storage/ephemeral-storage/)
- [Garbage collection: container image lifecycle](https://kubernetes.io/docs/concepts/architecture/garbage-collection/#container-image-lifecycle)
- [Taints and tolerations: taint nodes by condition](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/#taint-nodes-by-condition)
- [Resource management for pods and containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
