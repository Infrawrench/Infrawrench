---
title: "Kubernetes exceeded quota: pods forbidden by a ResourceQuota or LimitRange"
description: "Fix Kubernetes pods that are forbidden by an exceeded quota or a LimitRange: find the FailedCreate message, compare used and hard limits, add missing requests and limits, and free or raise capacity in the namespace."
date: "2026-11-15"
kind: guide
---

When a namespace has a ResourceQuota or a LimitRange, the API server checks every new pod against it before the pod exists. A pod that would break a rule is refused with a 403 Forbidden and a message naming the rule. Nothing is scheduled, nothing goes Pending and nothing crashes. A Deployment simply ends up with fewer pods than it asked for, a Job never starts its pods, or `kubectl apply` prints an error that is easy to miss in a pipeline. This guide shows how to find that message, read it, and fix the namespace or the pod spec so the pods get created.

Prerequisites: kubectl installed, access to the cluster, and permission to read ResourceQuotas, LimitRanges, pods, ReplicaSets and events in the namespace. Raising a quota or changing a LimitRange needs permission to edit those objects, which on a shared cluster usually belongs to a cluster admin. Everything here follows the official Kubernetes documentation on [resource quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/) and [limit ranges](https://kubernetes.io/docs/concepts/policy/limit-range/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, DEPLOYMENT_NAME, REPLICASET_NAME, QUOTA_NAME and LIMITRANGE_NAME. Replace them before running a command.

## Why there is no pod to look at

Quota and LimitRange are enforced at admission, the moment a pod is created. That makes this different from most pod problems:

- **A rejected pod never exists.** You cannot describe it or read its logs. The error lives on whatever tried to create it: your `kubectl` output, or the events of the ReplicaSet, StatefulSet, DaemonSet or Job that owns it.
- **Existing pods are not touched.** The docs are explicit that changes to a quota or LimitRange do not affect resources that were already created. A new rule only bites on the next pod, which is why a namespace can run fine for weeks and then fail on the next rollout or scale-up.
- **It is not Pending.** A pod that was admitted but cannot fit on a node is a scheduling problem, covered in the [pod stuck in Pending guide](/blog/kubernetes-pod-pending). If the pods exist and are Pending, you are in the wrong guide.

## Step 1: Find the refusal message

Check you are pointed at the right cluster, then look at the controller that should own the pods. For a Deployment, the ReplicaSet does the creating:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get deployment DEPLOYMENT_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME get replicaset -n NAMESPACE -l app=DEPLOYMENT_NAME
kubectl --context CONTEXT_NAME describe replicaset REPLICASET_NAME -n NAMESPACE
```

Adjust the label selector to whatever your Deployment uses. At the bottom of the describe output, a FailedCreate event carries the API server's refusal. The Deployment shows the same text in a ReplicaFailure condition. To see every FailedCreate in the namespace at once:

```
kubectl --context CONTEXT_NAME get events -n NAMESPACE --field-selector reason=FailedCreate
```

If you applied a bare pod yourself, the message was printed by `kubectl apply` or `kubectl create` and there is no event to find. Run the command again and read the error.

## Step 2: Sort the message

The message names the rule, and the wording tells you which kind it is. The exact text depends on your Kubernetes version, so read the whole message rather than matching a phrase.

- **exceeded quota.** The namespace has used up something a ResourceQuota counts. The official example is `exceeded quota: object-counts, requested: pods=1, used: pods=3, limited: pods=2`. It names the quota, what this pod would add, what is already used and the hard limit. Go to Step 3.
- **failed quota ... must specify.** A ResourceQuota limits CPU or memory, and this pod does not set the requests or limits it counts. Go to Step 4.
- **A minimum, maximum or ratio per Container or Pod.** A LimitRange refused the values in the pod spec. Go to Step 5.
- **must be less than or equal to cpu limit** (or memory). Often a LimitRange applied a default limit that is lower than the request you set. Go to Step 5.

## Step 3: Read the quota and free up room

List the quotas in the namespace and compare what is used with the hard limits:

```
kubectl --context CONTEXT_NAME get resourcequota -n NAMESPACE
kubectl --context CONTEXT_NAME describe resourcequota QUOTA_NAME -n NAMESPACE
```

The describe output has a Used and a Hard column for every resource the quota tracks: compute such as `requests.cpu` and `limits.memory`, storage such as `requests.storage` and `persistentvolumeclaims`, and object counts such as `pods` or `services`. The line from the error message is the one at or near its limit.

Compute quotas add up requests and limits across all pods in a non-terminal state, so pods that have finished do not hold capacity. Find what is using the rest:

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -o custom-columns=NAME:.metadata.name,CPU_REQ:.spec.containers[*].resources.requests.cpu,MEM_REQ:.spec.containers[*].resources.requests.memory,CPU_LIM:.spec.containers[*].resources.limits.cpu,MEM_LIM:.spec.containers[*].resources.limits.memory
```

Then pick one of the ways out the docs give for a failed Deployment:

- **Scale this workload down** so it asks for fewer pods.
- **Scale down or remove other workloads** in the namespace: old Deployments nobody uses, preview environments, forgotten test pods.
- **Lower the requests in the pod spec** if they are larger than the app needs. Check measured usage first, since cutting a memory request below real use trades a quota error for an eviction or an OOM kill.
- **Raise the quota.** Edit the ResourceQuota, or ask whoever owns it. On a shared cluster the quota is usually there on purpose, so this is a conversation, not a patch.

Watch for rolling updates. A Deployment can run more pods than `replicas` during a rollout because of maxSurge, so a quota sized exactly to the replica count blocks the surge pod and the rollout stalls. Leave headroom, or lower maxSurge. The [stuck rollouts guide](/blog/kubernetes-deployment-rollout-stuck) covers that side.

Quotas can also have scopes, such as only counting best-effort pods, terminating pods or pods of a given PriorityClass. If the numbers in Used do not match the pods you see, check the quota's `scopes` and `scopeSelector`: it may count only some of them.

## Step 4: Add the requests and limits the quota needs

When a ResourceQuota covers CPU or memory, the docs say every new pod in the namespace must set requests or limits for that resource, or the control plane may reject it. This catches pods copied from another cluster, Helm charts that leave resources empty, and sidecars or init containers someone forgot.

Fix it in the pod template. Every container, init containers included, needs the values the quota counts:

```
resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

The numbers above are placeholders. Set them from what the app actually uses. If many teams deploy into the namespace and you would rather not chase every chart, a LimitRange can fill in defaults for containers that set nothing, which the docs recommend for exactly this. Step 5 covers how those defaults behave.

## Step 5: Fix pods refused by a LimitRange

A LimitRange does two things when a pod is created: it applies default requests and limits to containers that do not set them, and it checks the final values against any minimum, maximum and request-to-limit ratio. Read what is in force:

```
kubectl --context CONTEXT_NAME get limitrange -n NAMESPACE
kubectl --context CONTEXT_NAME describe limitrange LIMITRANGE_NAME -n NAMESPACE
```

Then compare with the pod spec:

- **Above the maximum or below the minimum.** Change the container's values to fit inside the range, or change the range if it is wrong for this workload. A ratio rule (maxLimitRequestRatio) refuses a limit that is too many times the request.
- **Default limit below your request.** The docs call this out directly: a LimitRange does not check that its defaults are consistent with what you set. If you set a CPU request of 700m and no limit, and the default limit is 500m, the pod ends up with a request above its limit and is refused. Set the limit yourself alongside the request and the pod is accepted.
- **More than one LimitRange.** If two LimitRanges in the namespace set defaults, the docs say it is not deterministic which one applies. Keep one per namespace.

## Step 6: Verify

Once there is room, or the spec is fixed, the controller retries on its own. Watch the pods appear:

```
kubectl --context CONTEXT_NAME get deployment DEPLOYMENT_NAME -n NAMESPACE -w
kubectl --context CONTEXT_NAME describe resourcequota QUOTA_NAME -n NAMESPACE
```

READY should climb to the desired count and the quota's Used column should rise with it. If you changed the pod template, a new rollout starts. If you only freed capacity, the existing ReplicaSet creates the missing pods. If FailedCreate events keep coming, read the newest one: fixing one limit often reveals the next, for example memory after CPU.

If the pods are now created but sit in Pending, admission is passing and the problem has moved to scheduling. Continue with the [pod stuck in Pending guide](/blog/kubernetes-pod-pending).

## Conclusion

A pod forbidden by quota never existed, so look for the refusal on its owner: the FailedCreate event or the ReplicaFailure condition. An exceeded quota means comparing Used with Hard and freeing or raising capacity, leaving room for rollout surge. A "must specify" failure means adding requests and limits to every container. A LimitRange refusal means fitting the spec inside its range, and setting limits yourself when a default would land below your request.

If you look after quotas and workloads across several clusters and cloud accounts, Infrawrench puts them in one platform: the Infrastructure app gives you Kubernetes exec and logs, SSH and SQL across your connected cloud accounts. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Resource quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [Limit ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Configure memory and CPU quotas for a namespace](https://kubernetes.io/docs/tasks/administer-cluster/manage-resources/quota-memory-cpu-namespace/)
- [Configure default memory requests and limits for a namespace](https://kubernetes.io/docs/tasks/administer-cluster/manage-resources/memory-default-namespace/)
- [Deployments: failed Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#failed-deployment)
- [Resource management for pods and containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
