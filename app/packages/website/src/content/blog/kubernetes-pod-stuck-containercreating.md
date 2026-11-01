---
title: "Kubernetes pod stuck in ContainerCreating: fix volume mounts, sandbox and image pulls"
description: "Fix a Kubernetes pod stuck in ContainerCreating: read its events and conditions, then check volumes that will not attach or mount, missing ConfigMap and Secret volumes, the network plugin and slow image pulls."
date: "2026-11-01"
kind: guide
---

A pod in ContainerCreating has been scheduled to a node, but its containers have not started yet. The scheduler's work is done, so this is not a [pod stuck in Pending](/blog/kubernetes-pod-pending) problem. The kubelet on that node is still setting the pod up: creating the pod sandbox, configuring its network, mounting its volumes and pulling its images. Something in that list is not finishing. This guide shows how to find which step is stuck, then fix volumes that will not attach or mount, missing ConfigMap and Secret volumes, network plugin problems and image pulls that take too long.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods, events, nodes, PersistentVolumeClaims, ConfigMaps and Secrets. Everything here follows the official [Kubernetes documentation](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, NODE_NAME and PVC_NAME. Replace them before running a command.

## What ContainerCreating means

ContainerCreating is a reason shown for a container in the Waiting state. Kubernetes documents Waiting as a container that is still running the operations it needs to start up, for example pulling the container image from a registry or applying Secret data. The pod's phase is still Pending, which covers both time spent waiting to be scheduled and time spent downloading images.

The pod's conditions tell you how far setup got. The kubelet sets `PodReadyToStartContainers` to True once the pod sandbox has been created, networking configured, storage volumes mounted and any dynamic resources allocated. Image pulling and container creation happen after that point. So:

- **`PodReadyToStartContainers` is False.** The kubelet is stuck on the sandbox, the network or the volumes.
- **`PodReadyToStartContainers` is True.** Setup is done, and the container is waiting on its image or on being created.

## Step 1: Read the pod's events and conditions

Check you are pointed at the right cluster, then find the pod and the node it landed on:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -o wide
```

Describe the pod:

```
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
```

Read the Conditions block and the Events at the bottom. Then print the conditions on their own to see exactly which are False:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.message}{"\n"}{end}'
```

Events are kept for a limited time, so if the pod has been stuck for a while, list recent events for the namespace sorted by time:

```
kubectl --context CONTEXT_NAME get events -n NAMESPACE --sort-by=.lastTimestamp
```

The events usually name the step that is failing: a volume that cannot be attached or mounted, a ConfigMap or Secret that was not found, a sandbox or network setup error, or an image that is still being pulled. The exact wording depends on your Kubernetes version, container runtime, network plugin and storage driver, so read the whole message rather than matching a phrase. Then go to the step below that matches.

## Step 2: A PersistentVolume that will not attach or mount

If the events point at a volume, start with the claim. A pod only reaches a node after its claims are bound, but binding is not the same as being usable on that node:

```
kubectl --context CONTEXT_NAME get pvc PVC_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME describe pvc PVC_NAME -n NAMESPACE
```

If the claim is not Bound, follow the [PVC Pending guide](/blog/kubernetes-pvc-pending). If it is Bound, the problem is attaching the volume to the node or mounting it into the pod.

**The volume is still in use on another node.** A ReadWriteOnce volume can be mounted read-write by a single node. Several pods on the same node can share it, but a pod on a different node cannot use it until it is released. This often happens when a Deployment rolls out a new pod on a new node while the old pod, or the old node, still holds the disk. Find who else uses the claim:

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -o wide
kubectl --context CONTEXT_NAME describe pvc PVC_NAME -n NAMESPACE
```

The claim's description lists the pods using it. If the old pod is stuck shutting down, follow the [pod stuck in Terminating guide](/blog/kubernetes-pod-stuck-terminating). If the old node is down, follow the [node NotReady guide](/blog/kubernetes-node-not-ready). For a workload that must only ever run one pod against a disk, a Deployment with the Recreate strategy avoids two pods wanting it at once. If more than one pod must use it at the same time from different nodes, you need storage that supports ReadWriteMany.

**The storage driver is not working on that node.** Most volumes today are provisioned and attached by a CSI driver, which runs as pods in the cluster, usually a controller plus one node pod per node. If the driver's node pod on NODE_NAME is not Running, volumes cannot be mounted there. Find the driver's pods, often in `kube-system` or a namespace named after the driver, check the one on the pod's node and read its logs:

```
kubectl --context CONTEXT_NAME get pods -A -o wide --field-selector spec.nodeName=NODE_NAME
```

Errors from the cloud provider, such as missing permissions, a disk in a different zone from the node, or a limit on how many disks one node can attach, show up here and in the pod's events.

**A hostPath volume whose path does not exist.** A `hostPath` volume with `type: Directory`, `File` or another type that requires the path to exist will not mount if the path is missing on that node. Either create the path on every node the pod can land on, use a type such as `DirectoryOrCreate`, or move the data to a PersistentVolume.

## Step 3: A ConfigMap or Secret volume that does not exist

You must create a ConfigMap or Secret before a pod can use it. When a pod mounts one as a volume and it is missing, the pod sits in ContainerCreating: the kubelet keeps retrying and records an event with the details of the problem. By default these references are required, and none of the pod's containers will start until every non-optional Secret is available.

List the ConfigMap, Secret and projected volumes the pod mounts:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.volumes[*]}{.name}{"\t"}{.configMap.name}{"\t"}{.secret.secretName}{"\t"}{.projected}{"\n"}{end}'
```

Then check each name exists in the pod's namespace:

```
kubectl --context CONTEXT_NAME get configmap -n NAMESPACE
kubectl --context CONTEXT_NAME get secret -n NAMESPACE
```

ConfigMaps and Secrets are namespaced, so one with the right name in another namespace does not count. Fix it by creating the missing object, fixing the name in the pod template, or, only if the application really works without it, marking the reference `optional: true`. With an optional ConfigMap that does not exist, the mounted volume is empty. If the same references are used as environment variables instead of volumes, the container usually shows CreateContainerConfigError rather than ContainerCreating; the [CreateContainerConfigError guide](/blog/kubernetes-createcontainerconfigerror) covers that case.

## Step 4: The pod sandbox or network will not come up

If `PodReadyToStartContainers` is False and the events point at creating the sandbox or setting up the pod's network, the problem is on the node, between the container runtime and the network plugin. Kubernetes relies on a CNI network plugin, loaded by the container runtime, to implement pod networking, and the network plugin is configured to assign IP addresses to pods.

Check whether the problem is one node or all of them. If every new pod on NODE_NAME is stuck and pods on other nodes start, look at that node:

```
kubectl --context CONTEXT_NAME get pods -A -o wide --field-selector spec.nodeName=NODE_NAME
kubectl --context CONTEXT_NAME describe node NODE_NAME
```

Common causes:

- **The network plugin's pods are not running on the node.** Most plugins run as a DaemonSet, often in `kube-system`. If its pod on NODE_NAME is crashing or missing, new pods there cannot get a network. Read that pod's logs.
- **The network plugin cannot assign the pod an IP address.** Pod addresses come from the network plugin, so an exhausted or misconfigured pod address range shows up as a network setup failure. The fix is in the network plugin's or the cluster's configuration.
- **A new or upgraded node is not set up yet.** If the plugin was never installed, or its configuration is missing on the node, the node usually reports NotReady as well. Follow the [node NotReady guide](/blog/kubernetes-node-not-ready).

Because these problems sit below Kubernetes, the full error is often only in the container runtime's and the kubelet's logs on the node. Fixing the node, then deleting the stuck pod so its controller creates a new one, is usually quicker than waiting for retries.

## Step 5: The image is still pulling

If `PodReadyToStartContainers` is True and the events show the image being pulled, the pod may simply be waiting on a large image or a slow registry. Kubernetes counts time spent downloading images as part of the Pending phase. Watch the events:

```
kubectl --context CONTEXT_NAME get events -n NAMESPACE --field-selector involvedObject.name=POD_NAME -w
```

If the pull eventually fails, the container moves to ErrImagePull or ImagePullBackOff, and the [ImagePullBackOff guide](/blog/kubernetes-imagepullbackoff) takes over. If it is just slow, a smaller image helps, and so does the pull policy: with `imagePullPolicy: IfNotPresent`, a node that already has the image does not download it again. Pinning images by tag or digest rather than `latest` keeps that cache useful.

## Step 6: Verify

Once you have fixed the cause, watch the pod:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -w
```

STATUS should move from ContainerCreating to Running, and READY should show every container ready. If the pod was created by a Deployment, StatefulSet or Job, you can delete the stuck pod and let the controller replace it rather than waiting for the kubelet's next retry. If the container starts and then restarts, follow the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff). If it runs but never becomes ready, follow the [readiness probe guide](/blog/kubernetes-readiness-probe-failed).

## Conclusion

ContainerCreating means the pod has a node and the kubelet is still setting it up. Read the events and the `PodReadyToStartContainers` condition to see whether it is stuck before or after setup, then check volumes that will not attach or mount, ConfigMaps and Secrets that do not exist, the network plugin on that node and images that are still pulling.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
- [Pod lifecycle: container state Waiting](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#container-state-waiting)
- [Pod lifecycle: pod readiness to start containers](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-ready-to-start-containers)
- [Volumes](https://kubernetes.io/docs/concepts/storage/volumes/)
- [Persistent volumes: access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes)
- [Configure a pod to use a ConfigMap: optional ConfigMaps](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/#optional-configmaps)
- [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Cluster networking](https://kubernetes.io/docs/concepts/cluster-administration/networking/)
- [Network plugins](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/)
- [Images: image pull policy](https://kubernetes.io/docs/concepts/containers/images/#image-pull-policy)
