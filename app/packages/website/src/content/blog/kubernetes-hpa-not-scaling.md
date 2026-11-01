---
title: "Kubernetes HPA not scaling: fix unknown targets and stuck replicas"
description: "Fix a Kubernetes HorizontalPodAutoscaler that shows unknown targets or will not scale by checking the metrics API, resource requests, HPA conditions, replica limits and scaling behavior."
date: "2026-11-01"
kind: guide
---

A HorizontalPodAutoscaler (HPA) that does not scale fails quietly. Nothing crashes, no pod restarts, and the first sign is usually a workload that stays at the same replica count while load climbs, or a TARGETS column that reads `<unknown>`. This guide shows how to read what the HPA itself reports, confirm the metrics API is serving data, check the resource requests the HPA measures against, and tell a broken autoscaler apart from one that is working as designed: capped by its limits, holding a stabilization window, or ignoring pods that are still starting.

Prerequisites: kubectl installed, access to the cluster, and permission to read HorizontalPodAutoscalers, Deployments, pods, events and APIServices. Everything here follows the official [Kubernetes documentation on horizontal pod autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, HPA_NAME, DEPLOYMENT_NAME and POD_NAME. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## How the HPA decides

The HPA is a control loop in the kube-controller-manager. By default it runs every 15 seconds. On each pass it finds the workload named in `scaleTargetRef`, selects that workload's pods by its label selector, fetches their metrics and computes:

```
desiredReplicas = ceil(currentReplicas × currentMetricValue / desiredMetricValue)
```

If the ratio is within the tolerance of 1.0 (10% by default), it does nothing. For CPU or memory with a `Utilization` target, the current value is a percentage of each pod's resource request, averaged across the pods. Resource metrics come from the `metrics.k8s.io` API, usually served by the Metrics Server add-on, which has to be installed separately. Custom and external metrics come from `custom.metrics.k8s.io` and `external.metrics.k8s.io`, served by an adapter for your metrics system.

So an HPA that will not scale is stuck at one of four points: it cannot get metrics, it cannot turn them into a number, the number is capped, or the change is being held back on purpose. The steps below check each in turn.

## Step 1: Read the HPA's status

Check you are pointed at the right cluster and namespace, then list the autoscaler:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get hpa HPA_NAME -n NAMESPACE
```

TARGETS shows the current value against the target, such as `305%/50%`. MINPODS, MAXPODS and REPLICAS show the limits and where it is now. If TARGETS shows `<unknown>`, the HPA has no usable metric, and Steps 2 and 3 apply. If it shows a real value above the target and REPLICAS is not moving, go to Step 4.

Then describe it:

```
kubectl --context CONTEXT_NAME describe hpa HPA_NAME -n NAMESPACE
```

With the `autoscaling/v2` API, the Conditions section tells you which part is stuck:

- **AbleToScale**: whether the HPA can fetch and update the workload's scale, and whether any backoff is preventing scaling.
- **ScalingActive**: whether the HPA is enabled and able to calculate a desired scale. When it is False, the cause is usually fetching metrics. It is also False when the target workload has been set to zero replicas while the HPA's minimum is above zero.
- **ScalingLimited**: whether the desired scale was capped by the HPA's minimum or maximum replica count.

Read the Reason and Message for each, then the Events section below them. Warning events there carry the error the controller hit, such as failing to get a metric for a resource.

## Step 2: Confirm the metrics API is serving

For CPU and memory targets, the HPA reads the `metrics.k8s.io` API. Check that it is registered and available:

```
kubectl --context CONTEXT_NAME get apiservice v1beta1.metrics.k8s.io
```

AVAILABLE should be True. If the APIService is missing, nothing in the cluster is serving resource metrics, and you need to install Metrics Server or another provider of that API. If it exists but is not available, read the reason in that output, then check the pods that back it.

The HPA uses the `v1beta1` version of the resource metrics API. Then confirm it returns data for the workload's pods:

```
kubectl --context CONTEXT_NAME top pods -n NAMESPACE
```

If `kubectl top` returns usage for the pods, metrics are flowing. If it errors or omits the pods you care about, the HPA cannot see them either. For custom or external metrics, check the matching APIService (`custom.metrics.k8s.io` or `external.metrics.k8s.io`) in the same way, and confirm with your adapter that the metric name in the HPA spec is one it actually serves.

## Step 3: Check the resource requests

A `Utilization` target is a percentage of the request, so the HPA cannot compute it without one. The official docs are specific: if some of a pod's containers do not set the relevant resource request, CPU utilization for that pod is not defined and the autoscaler will not take any action for that metric. This is the most common cause of `<unknown>` on a cluster where `kubectl top` works.

List the requests per container:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.resources.requests}{"\n"}{end}'
```

Every container in the pod needs a request for the resource the HPA targets, including sidecars. Add them in the workload's pod template, not on running pods.

Two related effects are worth knowing. First, pod utilization sums every container's usage, so a busy application container next to an idle sidecar can stay under the target and never trigger a scale-up. A `ContainerResource` metric lets the HPA measure only the container that matters. Second, a request set far above real usage makes utilization look low, so the HPA sees no reason to add pods. If requests are too large for pods to fit at all, the new replicas will sit in [Pending](/blog/kubernetes-pod-pending) instead.

## Step 4: Check the replica limits and the workload

If TARGETS shows a real value over the target and REPLICAS still does not move, check ScalingLimited first. True means the desired count hit `maxReplicas` (or `minReplicas` when scaling down). The HPA is working, and the fix is to raise the limit in the HPA spec if the workload genuinely needs more pods.

Then check the target itself:

```
kubectl --context CONTEXT_NAME get deployment DEPLOYMENT_NAME -n NAMESPACE
```

- **Replicas set to zero.** If the Deployment was scaled to 0 and the HPA's minimum is above 0, the HPA stops adjusting it and sets ScalingActive to False. Scale the Deployment back up, or change the HPA's minimum, to reactivate it.
- **Replicas in the manifest.** If the Deployment manifest still sets `spec.replicas`, every `kubectl apply` of that manifest resets the replica count to that number, fighting the HPA. The official recommendation is to remove `spec.replicas` from the manifest once an HPA manages the workload. Removing it naively can drop the Deployment to its default of 1 replica on the next apply; the official docs describe using `kubectl apply edit-last-applied` first, or transferring field ownership with Server-Side Apply, to avoid that.
- **Objects that cannot scale.** The HPA only works on workloads with a scale subresource, such as Deployments and StatefulSets. A DaemonSet cannot be autoscaled horizontally.

## Step 5: Check stabilization and scaling behavior

An HPA that scales up but takes a long time to scale down is usually doing what it was configured to do. By default:

- **Scale down** uses a 300 second stabilization window. The HPA looks at every recommendation from the last five minutes and uses the highest, so replicas fall only after load has stayed low for that long.
- **Scale up** has no stabilization window, and may add up to 4 pods or 100% of the current replicas every 15 seconds, whichever is larger.

Look at `spec.behavior` to see whether anyone changed these:

```
kubectl --context CONTEXT_NAME get hpa HPA_NAME -n NAMESPACE -o jsonpath='{.spec.behavior}{"\n"}'
```

Things that hold scaling back on purpose:

- A long `stabilizationWindowSeconds` under `scaleUp` delays scale-ups for that long.
- Narrow `policies` (for example 1 pod per 60 seconds) cap how fast replicas change.
- `selectPolicy: Min` picks the policy that allows the smallest change.
- `selectPolicy: Disabled` turns off scaling in that direction entirely.
- A larger `tolerance` ignores bigger swings around the target.

If replicas swing up and down every few minutes, the opposite is true: the window is too short for metrics that fluctuate. Lengthening the scale-down stabilization window is the documented fix for this flapping.

With several metrics, the HPA computes a replica count for each and uses the largest. If one metric cannot be fetched and the ones that can suggest scaling down, it skips scaling altogether. A broken custom metric can therefore block scale-down while scale-up still works.

## Step 6: Check pods that are starting or not ready

When scaling on CPU, the HPA sets aside pods that are not yet ready and, during the CPU initialization period after a pod starts (5 minutes by default), ignores CPU samples that were not taken entirely while the pod was Ready. Pods that switch rapidly between Ready and not Ready are ignored until they are stably Ready. When it does scale up with not yet ready pods present, it assumes those pods use 0% of the target, which dampens the scale-up. Pods with missing metrics are treated conservatively in the same way.

Two problems follow:

- **Pods that never become Ready** never contribute metrics. If most of the workload is failing its readiness probe, the HPA scales on a fraction of the pods, or not at all. Fix the probe first with the [readiness probe guide](/blog/kubernetes-readiness-probe-failed).
- **Startup spikes.** Applications that burn CPU while warming up can trigger scale-ups that are not real load. The official good practice is a `startupProbe` that does not pass until the spike has passed, or a readiness probe that reports Ready only after it subsides.

The initialization period and readiness delay are kube-controller-manager options, set cluster-wide. On a managed cluster you may not be able to change them, so tune the probes instead.

## Step 7: Fix through the spec and verify

Apply the change where it is defined: requests in the workload's pod template, limits and `behavior` in the HPA manifest, and `spec.replicas` removed from the Deployment manifest. Metrics Server or a metrics adapter is a cluster add-on, usually managed alongside other cluster components.

Then watch it react:

```
kubectl --context CONTEXT_NAME get hpa HPA_NAME -n NAMESPACE --watch
```

TARGETS should show a real value, and under load REPLICAS should rise toward what the formula gives, within `maxReplicas`. In `kubectl describe hpa`, ScalingActive should be True with a reason showing a valid metric was found. If replicas rise but pods are killed for memory, see the [OOMKilled guide](/blog/kubernetes-oomkilled). If new pods never leave Pending, the cluster is out of room and needs more nodes, which is a job for node autoscaling rather than the HPA.

Write down which condition was False and what fixed it. The next `<unknown>` target will take a minute to resolve.

## Conclusion

An HPA that will not scale is either missing metrics, missing requests, capped by its limits, or held back by its behavior settings. Read TARGETS and the Conditions first, confirm the metrics API serves the pods, make sure every container has a request for the targeted resource, then check `maxReplicas`, `spec.replicas` in the manifest, the stabilization window and pods that are not Ready.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Horizontal Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/)
- [HorizontalPodAutoscaler walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/)
- [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [Resource management for pods and containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [HorizontalPodAutoscaler API reference](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/horizontal-pod-autoscaler-v2/)
