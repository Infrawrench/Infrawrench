---
title: "Kubernetes PVC stuck in Pending: find why the claim will not bind"
description: "Fix a PersistentVolumeClaim stuck in Pending: read its events, check the StorageClass, default class and provisioner, WaitForFirstConsumer, and size, access mode and selector matching."
date: "2026-10-31"
kind: guide
---

A PersistentVolumeClaim in Pending has not been bound to a volume. Any pod that mounts it cannot start, so the problem often shows up first as a [pod stuck in Pending](/blog/kubernetes-pod-pending) with a message about unbound PersistentVolumeClaims. Kubernetes will not give up on the claim: it stays unbound indefinitely until a matching volume exists or one is provisioned. This guide shows how to read why the claim is waiting, then check the StorageClass, the provisioner, the binding mode and the matching rules between claims and volumes.

Prerequisites: kubectl installed, access to the cluster, and permission to read PersistentVolumeClaims, PersistentVolumes, StorageClasses and events. Everything here follows the official [Kubernetes documentation](https://kubernetes.io/docs/concepts/storage/persistent-volumes/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, PVC_NAME, PV_NAME and STORAGECLASS_NAME. Replace them before running a command.

## How a claim gets a volume

A claim asks for a size, one or more access modes and, usually, a StorageClass. There are two ways it can be satisfied:

- **Dynamic provisioning.** The claim names a StorageClass, and that class's provisioner creates a new volume for it. This is how most cloud clusters work.
- **Static binding.** An administrator created PersistentVolumes in advance, and a control loop binds the claim to one that matches.

Either way, the binding is one to one. A claim in Pending means neither route has produced a volume yet. Your job is to find out which route the claim is on and what is blocking it.

## Step 1: Read the claim and its events

Check you are pointed at the right cluster, then list the claims:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pvc -n NAMESPACE
```

The STATUS column shows Pending, and STORAGECLASS shows which class the claim asked for. Describe the claim to see its events:

```
kubectl --context CONTEXT_NAME describe pvc PVC_NAME -n NAMESPACE
```

The events at the bottom usually say what the claim is waiting for. The most common messages point at a missing StorageClass, a claim waiting for a pod to use it, a provisioner that has not created the volume yet or failed to, or no PersistentVolume matching the claim. The wording depends on your Kubernetes version and storage driver, so read the whole message rather than matching a phrase.

## Step 2: Check the StorageClass

Print the class the claim asks for:

```
kubectl --context CONTEXT_NAME get pvc PVC_NAME -n NAMESPACE -o jsonpath='{.spec.storageClassName}{"\n"}'
kubectl --context CONTEXT_NAME get storageclass
```

There are three cases to tell apart.

**The claim names a class that does not exist.** A typo, or a manifest copied from another cluster with different class names. Only volumes of the requested class can bind to the claim, and only that class's provisioner will create one, so nothing happens. Fix `storageClassName` in the manifest to a class that exists, then delete and recreate the claim.

**The claim has no `storageClassName` at all.** It gets the cluster's default StorageClass, the one marked with the annotation `storageclass.kubernetes.io/is-default-class: "true"`. In `kubectl get storageclass` it shows `(default)` next to its name. If no class is marked default, the claim is created with no class and stays that way until a default appears. When one does, the control plane fills it in for existing claims without a class. If more than one class is marked default, Kubernetes uses the most recently created one, which can surprise you.

**The claim sets `storageClassName: ""`.** An empty string is not the same as leaving the field out. It means "a volume with no class", which disables dynamic provisioning for that claim. It can only bind to a PersistentVolume that also has no class. If you expected a disk to be created for you, remove the empty string or set a real class.

## Step 3: Check the provisioner

If the class exists and the claim is waiting for a volume to be created, look at the class's provisioner:

```
kubectl --context CONTEXT_NAME get storageclass STORAGECLASS_NAME -o jsonpath='{.provisioner}{"\t"}{.volumeBindingMode}{"\n"}{.parameters}{"\n"}'
```

Every StorageClass names a provisioner, the volume plugin that creates the actual storage. For most clusters today that is a CSI driver, which runs as pods in the cluster. If the driver's pods are not running, or they cannot reach the storage backend, the claim waits. Find the driver's pods, often in `kube-system` or a namespace named after the driver, and check that they are Running and ready. Their logs, and the claim's events, are where provisioning errors show up: quota exhausted at the cloud provider, a parameter the backend does not accept, or missing permissions.

The class's `parameters` are passed straight to the provisioner, and which ones are valid depends on the provisioner. A class copied from documentation for a different driver can look correct and still fail.

## Step 4: WaitForFirstConsumer is waiting, not broken

The class's `volumeBindingMode` decides when binding and provisioning happen:

- **Immediate**, the default when the field is not set, binds or provisions a volume as soon as the claim is created.
- **WaitForFirstConsumer** waits until a pod that uses the claim is created, then provisions or binds a volume that fits the pod's scheduling constraints, such as its zone, node selector, affinity and tolerations.

With WaitForFirstConsumer, a claim that no pod uses yet stays Pending, and that is correct. Create the pod, or the Deployment or StatefulSet that owns it, and the claim binds once the pod is scheduled. If a pod does exist and both stay Pending, the pod cannot be scheduled for some other reason, so read the pod's FailedScheduling event using the [Pending pod guide](/blog/kubernetes-pod-pending).

One spec mistake breaks this mode: setting `nodeName` on the pod. It bypasses the scheduler, so the claim never learns where the pod is going and stays Pending. Use a nodeSelector on `kubernetes.io/hostname` instead.

The reverse problem happens with Immediate on storage that is not reachable from every node, such as zonal cloud disks. The volume is provisioned before Kubernetes knows where the pod will run, and the pod may then be unable to schedule near it. For that kind of storage, WaitForFirstConsumer is the better choice.

## Step 5: Static volumes that do not match

If the claim should bind to a PersistentVolume that already exists, compare the two. List volumes and look for ones that are Available:

```
kubectl --context CONTEXT_NAME get pv
kubectl --context CONTEXT_NAME describe pv PV_NAME
```

A claim only binds to a volume when all of these match:

- **Storage class.** The volume's `storageClassName` must equal the claim's. A claim with `""` only binds to a volume with no class.
- **Size.** The volume must be at least as large as the claim requests. A cluster full of 50Gi volumes will not satisfy a claim for 100Gi. A larger volume can bind to a smaller claim, and the claim gets the whole volume.
- **Access modes.** The volume must support the mode the claim asks for. Modes are ReadWriteOnce (RWO), ReadOnlyMany (ROX), ReadWriteMany (RWX) and ReadWriteOncePod (RWOP), and storage backends support different sets. A claim for ReadWriteMany will never bind to a disk that only supports ReadWriteOnce.
- **Selector.** If the claim has a `selector`, the volume's labels must satisfy all of it. A claim with a non-empty selector also cannot have a volume dynamically provisioned for it.
- **Volume mode.** A claim for a raw block device (`volumeMode: Block`) only binds to a Block volume, and a Filesystem claim only to a Filesystem volume.

Check the volume's phase too. Only Available volumes can bind. A Released volume was bound to a claim that has since been deleted, and it is not reused automatically.

To bind a claim to one specific volume, set `volumeName` in the claim and, so no other claim takes it first, set `claimRef` in the volume:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: PVC_NAME
  namespace: NAMESPACE
spec:
  storageClassName: ""
  volumeName: PV_NAME
  # accessModes and resources as before
```

Set `storageClassName: ""` explicitly here, otherwise the default class is applied and the claim will not match a volume with no class. The control plane still checks that the class, access modes and size are valid before binding.

## Step 6: Verify

Watch the claim until it binds:

```
kubectl --context CONTEXT_NAME get pvc PVC_NAME -n NAMESPACE -w
```

STATUS should change to Bound and VOLUME should show the volume's name. Then check that the pod using it has scheduled and started:

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -o wide
```

If the claim is bound but the pod is stuck in ContainerCreating, the problem has moved to attaching or mounting the volume on the node: describe the pod and read its events. If it starts and then restarts, follow the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff).

## Conclusion

A Pending claim is waiting for something specific. Read its events, then check that its StorageClass exists and is the one you meant, that the provisioner is running, whether WaitForFirstConsumer is simply waiting for a pod, and for static volumes, that class, size, access mode, selector and volume mode all match.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Persistent volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [Storage classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- [Storage classes: volume binding mode](https://kubernetes.io/docs/concepts/storage/storage-classes/#volume-binding-mode)
- [Dynamic volume provisioning](https://kubernetes.io/docs/concepts/storage/dynamic-provisioning/)
- [Persistent volumes: access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes)
- [Persistent volumes: reserving a PersistentVolume](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#reserving-a-persistentvolume)
