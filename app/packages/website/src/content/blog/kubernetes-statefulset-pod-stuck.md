---
title: "Kubernetes StatefulSet pod stuck: fix ordered startup, storage and stuck rollouts"
description: "Fix a StatefulSet that will not start or finish a rollout: OrderedReady waiting on an unready pod, PVCs from volumeClaimTemplates, the headless Service, and deleting pods after a bad template."
date: "2026-11-01"
kind: guide
---

A StatefulSet that stops making progress usually looks like this: one pod is stuck, and every pod after it never appears. That is not a bug. A StatefulSet creates, updates and removes its pods in order, so a single unhealthy pod holds up the rest. This guide shows how to find the pod that is blocking, then check its storage, its headless Service and the update settings, and how to recover a rollout that a bad template has wedged.

Prerequisites: kubectl installed, access to the cluster, and permission to read and update StatefulSets, pods, PersistentVolumeClaims, Services and events. Everything here follows the official [Kubernetes documentation on StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, STATEFULSET_NAME, SERVICE_NAME, POD_NAME and PVC_NAME. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## How a StatefulSet orders its pods

Each pod in a StatefulSet gets an ordinal, by default from 0 up to the number of replicas minus one, and a stable name built from it: STATEFULSET_NAME-0, STATEFULSET_NAME-1 and so on. With the default pod management policy, `OrderedReady`:

- Pods are created one at a time, in order from 0 upwards.
- Before a pod is created or scaled, all of its predecessors must be Running and Ready. If `.spec.minReadySeconds` is set, they must have been Ready for at least that long.
- Pods are removed in reverse order, from the highest ordinal down.
- A rolling update replaces pods from the highest ordinal down, and waits for each updated pod to be Running and Ready before moving to the next one.

So if pod 1 never becomes Ready, pod 2 is never created, and a rollout that reaches a pod that never becomes Ready stops there. Your first job is to find which pod is holding things up.

## Step 1: Find the pod that is blocking

Check you are pointed at the right cluster, then compare desired and ready replicas:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get statefulset STATEFULSET_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -l app=STATEFULSET_NAME -o wide
```

Use whatever label your StatefulSet's selector uses in place of `app=STATEFULSET_NAME`. Look for the lowest ordinal that is not Running with all containers ready. That is the pod to investigate; the missing pods after it are waiting for it. Describe it and read the events at the bottom:

```
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
```

What the pod is stuck on decides where to go next:

- **Pending**: the scheduler cannot place it, very often because its PersistentVolumeClaim is not bound. Go to Step 2, and see the [Pending pod guide](/blog/kubernetes-pod-pending).
- **CrashLoopBackOff**: the container starts and exits. Follow the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff).
- **Running with READY 0/1**: it fails its readiness probe, which blocks the next ordinal just as surely as a crash. Follow the [readiness probe guide](/blog/kubernetes-readiness-probe-failed).
- **ImagePullBackOff or CreateContainerConfigError**: follow the [ImagePullBackOff guide](/blog/kubernetes-imagepullbackoff) or the [CreateContainerConfigError guide](/blog/kubernetes-createcontainerconfigerror).
- **Terminating for a long time**: see Step 6 before you force anything.

If no pods exist at all, describe the StatefulSet itself and read its events:

```
kubectl --context CONTEXT_NAME describe statefulset STATEFULSET_NAME -n NAMESPACE
```

Events there show when the controller cannot create a pod or its claims, for example because of a quota or an admission policy.

## Step 2: Check the claims from volumeClaimTemplates

For each entry in `.spec.volumeClaimTemplates`, every pod gets its own PersistentVolumeClaim, named after the template and the pod, such as `data-STATEFULSET_NAME-0`. If the template names no StorageClass, the cluster's default class is used. List the claims:

```
kubectl --context CONTEXT_NAME get pvc -n NAMESPACE
```

A claim in Pending keeps its pod in Pending, and with `OrderedReady` that stops every pod after it. The storage for each pod must either be provisioned by a provisioner for the requested StorageClass or created in advance by an administrator. Describe the claim and follow the [PVC Pending guide](/blog/kubernetes-pvc-pending) to find out why it will not bind.

Two StatefulSet specific points:

- **Claims outlive their pods.** Deleting or scaling down a StatefulSet does not delete its volumes by default. When you scale back up, pod 2 reattaches to the old `data-STATEFULSET_NAME-2` claim, with its old data and its old zone. That is the point of a StatefulSet, but it also means a broken or misplaced old claim is reused rather than replaced. The optional `.spec.persistentVolumeClaimRetentionPolicy` controls whether claims are deleted when the StatefulSet is deleted or scaled down.
- **Claims are created from the template once.** Editing `volumeClaimTemplates` does not resize or change claims that already exist, and the API server rejects most edits to a StatefulSet spec outside the pod template, replicas and update strategy. Change existing claims directly, or plan a migration.

## Step 3: Check the headless Service

StatefulSets require a headless Service to give the pods their network identity, and you are responsible for creating it. The StatefulSet's `serviceName` must name it:

```
kubectl --context CONTEXT_NAME get statefulset STATEFULSET_NAME -n NAMESPACE -o jsonpath='{.spec.serviceName}{"\n"}'
kubectl --context CONTEXT_NAME get service SERVICE_NAME -n NAMESPACE -o jsonpath='{.spec.clusterIP}{"\n"}'
```

The Service should exist in the same namespace, and its clusterIP should be `None`. Each pod then gets a DNS name of the form `POD_NAME.SERVICE_NAME.NAMESPACE.svc.cluster.local`, assuming the default cluster domain.

A missing or misnamed Service does not stop the pods from being created, but it breaks the stable names your application uses to find its peers. A database replica that waits for `STATEFULSET_NAME-0` to resolve before it reports ready will then sit at READY 0/1 forever, and block the next ordinal. Check that the Service selector matches the pod labels, and use the [Service with no endpoints guide](/blog/kubernetes-service-no-endpoints) and the [DNS troubleshooting guide](/blog/kubernetes-dns-troubleshooting) if names still do not resolve.

DNS also caches failed lookups. If a peer looked up a pod's name before that pod existed, it can keep getting no answer for a short while after the pod appears. The Kubernetes docs suggest querying the API directly rather than relying on DNS lookups, or lowering the negative cache time in your cluster DNS.

## Step 4: Recover a rollout stuck on a bad template

This is the case that catches most people. With the default `OrderedReady` policy and the `RollingUpdate` strategy, if you update the pod template to something that never becomes Running and Ready, such as a bad image or a configuration error, the StatefulSet stops the rollout and waits.

Reverting the template is not enough on its own. Because of a known issue, the StatefulSet keeps waiting for the broken pod to become Ready, which never happens, before it will move it back to the working template. Check where the rollout is:

```
kubectl --context CONTEXT_NAME rollout status statefulset/STATEFULSET_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME get statefulset STATEFULSET_NAME -n NAMESPACE -o jsonpath='{.status.currentRevision}{"\t"}{.status.updateRevision}{"\n"}'
```

To recover, first revert the template, either by applying your last good manifest or with:

```
kubectl --context CONTEXT_NAME rollout undo statefulset/STATEFULSET_NAME -n NAMESPACE
```

Then delete every pod that the StatefulSet already tried to run with the bad configuration. These are the highest ordinals, the ones that were replaced before the rollout stopped:

```
kubectl --context CONTEXT_NAME delete pod POD_NAME -n NAMESPACE
```

The StatefulSet recreates them from the reverted template. Their claims are kept, so their data survives the delete.

## Step 5: Check the update and management settings

Read the settings that control how the StatefulSet moves:

```
kubectl --context CONTEXT_NAME get statefulset STATEFULSET_NAME -n NAMESPACE -o jsonpath='{.spec.podManagementPolicy}{"\t"}{.spec.updateStrategy}{"\t"}{.spec.minReadySeconds}{"\n"}'
```

- **`updateStrategy.type: OnDelete`**: the controller does not replace pods when the template changes. Pods pick up the new template only when you delete them. If a rollout seems to do nothing, check this first.
- **`rollingUpdate.partition`**: only pods with an ordinal greater than or equal to the partition are updated. Pods below it stay on the old version, even if you delete them. A partition left over from a staged rollout looks exactly like a rollout that stopped halfway. If the partition is greater than the number of replicas, no pods are updated at all.
- **`minReadySeconds`**: each pod must stay Ready this long before it counts as available, which slows ordered startup and updates on purpose.
- **`podManagementPolicy: Parallel`**: pods are launched and terminated all at once, without waiting for each other to become Running and Ready. That removes the ordering block for scaling, which suits applications that do not need ordered startup. It does not help an application that genuinely needs pod 0 up before pod 1. The policy is set when you create the StatefulSet; changing it on an existing one is rejected by the API server, so plan it in from the start.

## Step 6: Do not force delete without thinking

A StatefulSet guarantees at most one pod per identity. If a pod is stuck Terminating, for example on a node that is unreachable, the StatefulSet will not create its replacement until the old pod is gone. That protects your data: two pods writing to the same volume can corrupt it.

Force deleting the pod skips that protection. Only do it once you have confirmed the old pod is really not running, for example because the node is shut down or removed. The Kubernetes docs have a full procedure for [force deleting StatefulSet pods](https://kubernetes.io/docs/tasks/run-application/force-delete-stateful-set-pod/). The [pod stuck Terminating guide](/blog/kubernetes-pod-stuck-terminating) and the [node NotReady guide](/blog/kubernetes-node-not-ready) cover the node side. The docs also warn against setting a termination grace period of 0 on StatefulSet pods, for the same reason.

## Step 7: Verify

Watch the pods come up in order:

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -l app=STATEFULSET_NAME -w
kubectl --context CONTEXT_NAME rollout status statefulset/STATEFULSET_NAME -n NAMESPACE
```

Each ordinal should reach Running with all containers ready before the next one starts. When the rollout finishes, `currentRevision` and `updateRevision` should match, and READY on the StatefulSet should equal the replica count.

## Conclusion

A stuck StatefulSet is almost always one pod holding up the rest. Find the lowest ordinal that is not Running and Ready, then check its claim, the headless Service and the update settings. After a bad template, revert it and delete the pods that ran the broken version, because reverting alone will not move them.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
- [StatefulSets: deployment and scaling guarantees](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/#deployment-and-scaling-guarantees)
- [StatefulSets: forced rollback](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/#forced-rollback)
- [StatefulSets: partitioned rolling updates](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/#partitions)
- [Headless Services](https://kubernetes.io/docs/concepts/services-networking/service/#headless-services)
- [Force delete StatefulSet pods](https://kubernetes.io/docs/tasks/run-application/force-delete-stateful-set-pod/)
- [Persistent volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
