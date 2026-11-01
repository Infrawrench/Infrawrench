---
title: "Kubernetes Deployment rollout stuck: fix ProgressDeadlineExceeded"
description: "Fix a Kubernetes Deployment rollout that never finishes by reading the Progressing condition, finding why new pods are not available, and rolling back or resuming safely."
date: "2026-11-01"
kind: guide
---

A Deployment rollout that hangs at "Waiting for rollout to finish: 2 out of 3 new replicas have been updated" is not broken in one place. The Deployment controller has created a new ReplicaSet, and the new pods are not becoming available, so the rollout cannot move on. After a deadline, Kubernetes marks it ProgressDeadlineExceeded, but it does nothing else: the old pods keep serving, the new ones keep failing, and nobody is told unless someone is watching. This guide shows how to read the Deployment's conditions, find the new pods that are holding it back, decide between fixing forward and rolling back, and check for a paused rollout.

Prerequisites: kubectl installed, access to the cluster, and permission to read and update Deployments, ReplicaSets, pods and events. Everything here follows the official [Kubernetes documentation on Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, DEPLOYMENT_NAME, NEW_REPLICASET_NAME, HASH and REVISION. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## How a rolling update makes progress

With the default RollingUpdate strategy, a Deployment scales up a new ReplicaSet and scales down the old one in steps. Two settings limit each step:

- **maxUnavailable**: how many pods below the desired count may be unavailable during the update. The default is 25%, rounded down.
- **maxSurge**: how many pods above the desired count may exist during the update. The default is 25%, rounded up.

The two cannot both be 0. A new pod only counts as available once it is ready and has stayed ready for `minReadySeconds`, which defaults to 0.

That is why one bad pod can hold up the whole rollout. If new pods never become available, the controller cannot take down more old pods without breaking maxUnavailable, so it stops. The official docs note that the controller stops a bad rollout automatically and stops scaling up the new ReplicaSet. The old pods that are still running keep the application up, which is good for users and also why a stuck rollout goes unnoticed.

## Step 1: Confirm the rollout is stuck

Check you are pointed at the right cluster and namespace, then ask for the rollout status with a timeout so the command does not wait forever:

```
kubectl config current-context
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=60s
```

A finished rollout prints `successfully rolled out` and exits 0. A Deployment past its progress deadline prints `exceeded its progress deadline` and exits 1, which is the signal to use in a CI or deploy script.

Then read the Deployment's conditions:

```
kubectl --context CONTEXT_NAME get deployment DEPLOYMENT_NAME -n NAMESPACE -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.reason}{"\t"}{.message}{"\n"}{end}'
```

The Progressing condition says where the rollout is:

- **True with NewReplicaSetCreated, FoundNewReplicaSet or ReplicaSetUpdated**: the rollout is still in progress.
- **True with NewReplicaSetAvailable**: the rollout is complete.
- **False with ProgressDeadlineExceeded**: no progress was made within `progressDeadlineSeconds`, which defaults to 600 seconds.
- **False with ReplicaSetCreateError**: the condition can fail early for reasons like this one, before the deadline.

Look for a third condition too. **ReplicaFailure True with FailedCreate** means the ReplicaSet could not create pods at all, and the message says why. Step 3 covers that case.

Two things are easy to misread. Available can stay True during a stuck rollout, because the old pods still give the Deployment its minimum availability. And Kubernetes takes no action on a stalled Deployment beyond setting the condition. It does not roll back on its own. The controller keeps retrying.

## Step 2: Find the new pods and why they are not available

Describe the Deployment, then list the ReplicaSets in the namespace. The newest is usually the one with the most recent AGE and fewer ready pods than desired:

```
kubectl --context CONTEXT_NAME describe deployment DEPLOYMENT_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME get rs -n NAMESPACE -o wide
```

`describe deployment` shows OldReplicaSets and NewReplicaSet by name near the bottom, along with the scaling events. Each ReplicaSet name ends in a hash that matches the `pod-template-hash` label on its pods, so you can list only the new pods:

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -l pod-template-hash=HASH
```

The STATUS column of those pods tells you which guide applies:

- **ImagePullBackOff or ErrImagePull**: the new image tag or registry access is wrong. Follow the [ImagePullBackOff guide](/blog/kubernetes-imagepullbackoff).
- **CrashLoopBackOff**: the new version starts and exits. Follow the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff).
- **CreateContainerConfigError**: a ConfigMap, Secret or key the new template references is missing. Follow the [CreateContainerConfigError guide](/blog/kubernetes-createcontainerconfigerror).
- **Pending**: the scheduler cannot place the new pods. Follow the [Pending guide](/blog/kubernetes-pod-pending), and read the note on maxSurge in Step 4.
- **Running with READY 0/1**: the new pods fail their readiness probe. Follow the [readiness probe guide](/blog/kubernetes-readiness-probe-failed).

The official docs list the usual causes of a failed Deployment as insufficient quota, readiness probe failures, image pull errors, insufficient permissions, limit ranges and application runtime misconfiguration. Every one of them shows up in the new pods, in their events, or in the ReplicaFailure condition.

## Step 3: When no new pods exist at all

If the new ReplicaSet wants pods but has none, the problem is at creation, not in a running pod. Describe the new ReplicaSet and read its events:

```
kubectl --context CONTEXT_NAME describe rs NEW_REPLICASET_NAME -n NAMESPACE
```

A FailedCreate event, and the matching ReplicaFailure condition on the Deployment, carries the API server's refusal. The official example is a quota message such as `exceeded quota: object-counts, requested: pods=1, used: pods=3, limited: pods=2`. A LimitRange that rejects the new template's resource values, or an admission policy that refuses the pod, appear the same way.

For quota, the docs give three ways out: scale the Deployment down, scale down other workloads in the namespace, or raise the namespace quota. Note that maxSurge needs headroom: during a rolling update the Deployment can run more pods than `replicas`, so a quota sized exactly to the replica count can block the surge pod. Once the quota allows it, the controller completes the rollout and Progressing returns to True with NewReplicaSetAvailable.

## Step 4: Check the rollout settings

The strategy and timing settings change how a rollout behaves when the new pods are slow or short on room:

```
kubectl --context CONTEXT_NAME get deployment DEPLOYMENT_NAME -n NAMESPACE -o jsonpath='{.spec.strategy}{"\n"}{.spec.minReadySeconds}{"\n"}{.spec.progressDeadlineSeconds}{"\n"}{.spec.paused}{"\n"}'
```

- **progressDeadlineSeconds.** If the application genuinely takes a long time to become ready, the default 600 seconds may be too short and you will see ProgressDeadlineExceeded on a rollout that would have finished. It must be greater than `minReadySeconds`. Raise it only when slow startup is expected, not to hide pods that never become ready.
- **minReadySeconds.** A new pod must stay ready this long, with no container crashing, before it counts as available. A high value slows every rollout. A pod that flaps between ready and not ready never gets there.
- **maxSurge and capacity.** maxSurge lets the Deployment create new pods before removing old ones. In a full cluster, those extra pods may stay Pending because there is nowhere to schedule them. Setting maxSurge to 0 with a non-zero maxUnavailable makes the Deployment remove old pods first and reuse their room, at the cost of fewer pods serving during the update.
- **Recreate strategy.** With `type: Recreate`, all old pods are killed before new ones are created, so a bad new version is an outage rather than a stuck rollout.

## Step 5: Check for a paused rollout

A paused Deployment does not roll out changes to its pod template, so a change that was applied while it was paused appears to do nothing:

```
kubectl --context CONTEXT_NAME get deployment DEPLOYMENT_NAME -n NAMESPACE -o jsonpath='{.spec.paused}{"\n"}'
```

If this prints `true`, the existing pods keep running and new template changes wait. Kubernetes also does not check progress against the deadline while a Deployment is paused, so no ProgressDeadlineExceeded will appear. Resume it once the changes are ready:

```
kubectl --context CONTEXT_NAME rollout resume deployment/DEPLOYMENT_NAME -n NAMESPACE
```

You cannot roll back a paused Deployment until you resume it.

## Step 6: Roll back or fix forward

If users are fine on the old version and the fix is not obvious, roll back first and investigate after. Look at the history:

```
kubectl --context CONTEXT_NAME rollout history deployment/DEPLOYMENT_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME rollout history deployment/DEPLOYMENT_NAME -n NAMESPACE --revision=REVISION
```

Then return to the previous revision, or to a specific one:

```
kubectl --context CONTEXT_NAME rollout undo deployment/DEPLOYMENT_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME rollout undo deployment/DEPLOYMENT_NAME -n NAMESPACE --to-revision=REVISION
```

Three details from the docs matter here:

- **Only the pod template rolls back.** A revision is created only when `.spec.template` changes. Scaling does not create one, and an undo does not change the replica count.
- **History has a limit.** Revisions live in old ReplicaSets, and `revisionHistoryLimit` keeps 10 by default. With it set to 0 there is nothing to roll back to.
- **CHANGE-CAUSE is optional.** The history column is copied from the `kubernetes.io/change-cause` annotation. Set it on each deploy if you want the history to say what changed.

If you use GitOps or Helm, an undo is overwritten by the next sync. In that case fix forward instead: correct the image, config or probe in the source of truth and apply a new revision. All actions that work on a complete Deployment also work on a failed one, so a new rollout replaces the stuck ReplicaSet.

## Step 7: Verify the rollout completed

After a rollback or a fix, watch it through:

```
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=300s
kubectl --context CONTEXT_NAME get rs -n NAMESPACE
```

The status should print `successfully rolled out` and exit 0. Progressing should be True with NewReplicaSetAvailable, the new ReplicaSet should have its desired pods ready, and the old ReplicaSets should be scaled to 0. If a ReplicaFailure condition remains, read its message again.

Write down which condition you saw, what the new pods were doing and the change that fixed it. In a deploy pipeline, fail the job on a non-zero exit from `kubectl rollout status` so the next stuck rollout is caught by the pipeline, not by a user.

## Conclusion

A stuck rollout means the new ReplicaSet's pods are not becoming available, and the controller will not take down more old pods until they do. Read the Progressing and ReplicaFailure conditions, list the new pods by their `pod-template-hash`, and fix whatever is stopping them: an image, a crash, missing config, no room to schedule, a failing readiness probe or quota. Check that the rollout is not paused, and roll back when the old version is the safe place to be.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Deployment status: failed Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#failed-deployment)
- [Rolling back a Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#rolling-back-a-deployment)
- [Resource quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
