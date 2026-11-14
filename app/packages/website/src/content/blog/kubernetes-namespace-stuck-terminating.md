---
title: "Kubernetes namespace stuck in Terminating: find what is holding it"
description: "Fix a Kubernetes namespace stuck in Terminating by reading its status conditions, finding unavailable API services and leftover resources with finalizers, and clearing each blocker safely instead of force-finalizing."
date: "2026-11-14"
kind: guide
---

A namespace stuck in Terminating has been deleted, but the namespace controller cannot finish emptying it. Before a namespace goes away, Kubernetes deletes every object inside it and then removes the `kubernetes` finalizer from the namespace. If the controller cannot list one of the cluster's APIs, or an object inside refuses to go because its own finalizer is never removed, the namespace waits forever. The namespace itself tells you which of these it is waiting on, so read that first rather than reaching for a force delete.

Prerequisites: kubectl installed, access to the cluster, permission to read the namespace and list resources in it, and permission to patch objects if you need to remove a finalizer. Everything here follows the official Kubernetes documentation on [namespaces](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/) and [finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, KIND, NAME and APISERVICE_NAME. Replace them before running a command. If a single pod is stuck rather than the whole namespace, the [pod stuck in Terminating guide](/blog/kubernetes-pod-stuck-terminating) is the one you want.

## Step 1: Read the namespace's conditions

Check you are pointed at the right cluster, then print the namespace's phase and conditions:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get namespace NAMESPACE
kubectl --context CONTEXT_NAME get namespace NAMESPACE -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.message}{"\n"}{end}'
```

The namespace controller writes a condition for each kind of problem it hits. The ones set to True are your blockers:

- **NamespaceDeletionDiscoveryFailure**: the controller could not discover all the APIs in the cluster, usually because an aggregated API is down. Go to Step 2.
- **NamespaceDeletionGroupVersionParsingFailure**: an API group version could not be parsed. Treat it like a discovery problem and go to Step 2.
- **NamespaceDeletionContentFailure**: deleting some objects failed. The message names them. Go to Step 3.
- **NamespaceContentRemaining**: objects are still in the namespace. The message lists the kinds and counts. Go to Step 3.
- **NamespaceFinalizersRemaining**: objects are waiting on finalizers. The message names the finalizers. Go to Step 4.

If there are no conditions at all, give it a minute. Deleting a namespace with many objects takes time, and the conditions appear once the controller has had a pass at it.

## Step 2: Fix unavailable API services

To delete everything in a namespace, the controller has to list every namespaced resource type the cluster serves. Some types are served by an extension API server behind an APIService, such as metrics-server. If that server is down, discovery fails and the controller cannot be sure the namespace is empty, so it stops.

List the API services that are not available:

```
kubectl --context CONTEXT_NAME get apiservice | grep False
kubectl --context CONTEXT_NAME describe apiservice APISERVICE_NAME
```

The AVAILABLE column says why, for example `MissingEndpoints` or `FailedDiscoveryCheck`. You have two ways out:

- **Bring the service back.** If the extension is still meant to run, fix the Deployment and Service behind it (the describe output names the Service). Once it reports Available, the namespace controller retries and carries on.
- **Remove a leftover registration.** If you uninstalled the extension but its APIService is still registered, delete the registration so discovery stops failing:

```
kubectl --context CONTEXT_NAME delete apiservice APISERVICE_NAME
```

Only delete an APIService you are sure is no longer used. Anything in the cluster that relies on that API stops working when you remove it.

## Step 3: Find what is still in the namespace

`kubectl get all` only shows a handful of common types, so it often looks empty while objects remain. List every namespaced resource type the cluster serves and check each one:

```
kubectl --context CONTEXT_NAME api-resources --verbs=list --namespaced -o name \
  | xargs -n 1 kubectl --context CONTEXT_NAME get --show-kind --ignore-not-found -n NAMESPACE
```

What is left is usually custom resources from an operator, PersistentVolumeClaims, or objects with a deletion timestamp that are waiting on a finalizer. For each one, check its finalizers and whether it has been marked for deletion:

```
kubectl --context CONTEXT_NAME get KIND NAME -n NAMESPACE -o jsonpath='{.metadata.deletionTimestamp}{"\n"}{.metadata.finalizers}{"\n"}'
```

An object with a deletion timestamp and a finalizer is waiting for a controller to finish its cleanup and remove that finalizer. Step 4 covers why that does not happen.

If an object has no deletion timestamp and the condition reported a content failure, try deleting it yourself and read the error. A webhook that rejects the request or a missing permission shows up there.

## Step 4: Clear finalizers the right way

A finalizer is a promise that a controller will clean something up before the object goes, such as releasing a cloud load balancer, a volume or an external record. The object stays until that controller removes the finalizer. Namespaces get stuck when the controller is gone or failing:

- **The operator was uninstalled first.** Removing an operator before the custom resources it manages leaves those resources with finalizers nobody will remove. The cleaner fix is to reinstall the operator, let it finish deleting the resources, then uninstall it again.
- **The controller is running but failing.** Read its logs. The cleanup it needs to do (for example deleting a cloud resource) is failing, and fixing that lets it remove the finalizer itself.
- **A PersistentVolumeClaim is still in use.** The `kubernetes.io/pvc-protection` finalizer keeps a claim while a pod uses it. Delete the pods using it first.

If the controller is truly gone and you accept that its cleanup will not happen, remove the finalizer from that one object:

```
kubectl --context CONTEXT_NAME patch KIND NAME -n NAMESPACE --type=merge -p '{"metadata":{"finalizers":null}}'
```

Do this per object, after checking what the finalizer was guarding. Anything the controller would have cleaned up outside the cluster, such as a load balancer, a disk or a DNS record, is left behind and has to be removed by hand from the provider.

## Step 5: Avoid force-finalizing the namespace

A common answer online is to empty the namespace's own finalizer list through the `finalize` subresource. This makes the namespace disappear, but it does not delete the objects that were blocking it. Those objects stay in the cluster's storage with nothing pointing at them, and if you create a namespace with the same name later, they can reappear inside it. External resources their finalizers were guarding are left behind too.

Treat it as a last resort for a cluster you are about to throw away. In every other case, the conditions from Step 1 tell you which API service or object to fix, and the namespace finishes deleting on its own once that is done.

## Step 6: Verify

Watch the namespace until it is gone:

```
kubectl --context CONTEXT_NAME get namespace NAMESPACE -w
```

Once the blocker is cleared, the controller picks the namespace up again on its next pass and it disappears. If it is still there after a few minutes, run Step 1 again: clearing one blocker often reveals the next, for example a second custom resource type after the first one is gone. Also run `kubectl get apiservice` once more to confirm nothing is left unavailable, since a broken API service affects more than this one namespace.

## Conclusion

A namespace stuck in Terminating is waiting on something it can name. Read its conditions, fix or remove any unavailable APIService, list every namespaced resource that is left, and clear finalizers by getting their controller to finish its cleanup, or by removing them per object once you know what they guarded. Skip force-finalizing the namespace itself unless the cluster is going away anyway.

If finding leftover resources across clusters and cloud accounts is part of jobs like this, Infrawrench puts them in one platform: the Infrastructure app gives you Kubernetes exec and logs, SSH and SQL across your connected cloud accounts. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Namespaces](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/)
- [Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
- [Namespace API reference](https://kubernetes.io/docs/reference/kubernetes-api/cluster-resources/namespace-v1/)
- [Using finalizers to control deletion](https://kubernetes.io/blog/2021/05/14/using-finalizers-to-control-deletion/)
- [Configure the aggregation layer](https://kubernetes.io/docs/tasks/extend-kubernetes/configure-aggregation-layer/)
- [Persistent volumes: storage object in use protection](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#storage-object-in-use-protection)
