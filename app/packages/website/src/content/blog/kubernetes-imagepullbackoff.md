---
title: "Kubernetes ImagePullBackOff and ErrImagePull: find the cause and fix it"
description: "Fix a Kubernetes pod stuck in ImagePullBackOff or ErrImagePull by reading the pull events, then checking the image reference, registry credentials and pull policy."
date: "2026-10-31"
kind: guide
---

A pod in ImagePullBackOff has been placed on a node, but its container cannot start because the node cannot get the image. Like a [pod stuck in Pending](/blog/kubernetes-pod-pending), there are no container logs to read, because no container has run. The evidence is in the pod's events, written by the kubelet each time a pull fails. This guide shows how to read those events, check the image reference character by character, fix private registry credentials, and roll out the fix through the spec.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods, events, Secrets and ServiceAccounts in the namespace. Everything here follows the official [Kubernetes documentation on images](https://kubernetes.io/docs/concepts/containers/images/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, SECRET_NAME, SERVICE_ACCOUNT_NAME and DEPLOYMENT_NAME. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## What ImagePullBackOff actually means

When the kubelet starts creating a pod's containers, a container that cannot get its image stays in the Waiting state. Waiting always comes with a reason, and for pull failures you will see one of two:

- **ErrImagePull**: a pull attempt has just failed.
- **ImagePullBackOff**: Kubernetes is waiting before it tries again.

The official definition is short: the container could not start because Kubernetes could not pull its image, for reasons such as an invalid image name or a private registry without an imagePullSecret. The BackOff part means Kubernetes keeps retrying with an increasing delay, up to a compiled-in limit of 300 seconds (5 minutes). So a pod that flips between the two reasons is retrying, and it will keep failing until the cause changes.

Because the pod has a node, this is a node-side problem, not a scheduling one. The phase still reads Pending, since Kubernetes counts time spent downloading images as part of Pending, but the STATUS column shows the pull reason instead.

## Step 1: Confirm it is a pull failure

Check you are pointed at the right cluster and namespace, then list the pod:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o wide
```

STATUS reads ErrImagePull or ImagePullBackOff, and the NODE column has a node name. If NODE reads `<none>`, the pod has not been scheduled yet, and the [Pending guide](/blog/kubernetes-pod-pending) applies instead.

A pod can have several containers, including init containers, and only one of them may be failing. Print the waiting reason for each:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .status.initContainerStatuses[*]}init:{.name}{"\t"}{.image}{"\t"}{.state.waiting.reason}{"\n"}{end}{range .status.containerStatuses[*]}{.name}{"\t"}{.image}{"\t"}{.state.waiting.reason}{"\n"}{end}'
```

Note which container fails and which image it asks for. The rest of the guide is about that one image.

## Step 2: Read the pull events

Describe the pod and read the Events section at the bottom:

```
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
```

Or pull only the events for this pod, oldest first:

```
kubectl --context CONTEXT_NAME get events -n NAMESPACE --field-selector involvedObject.name=POD_NAME --sort-by=.lastTimestamp
```

Look for the Failed event that follows a Pulling event. Its message carries the error the container runtime got back from the registry. The exact wording depends on the runtime and the registry, so read it for its meaning rather than matching a string:

- **Not found, manifest unknown, or the repository does not exist**: the reference is wrong, or the image was never pushed (Step 3).
- **Unauthorized, authentication required, or access denied**: credentials are missing or wrong (Step 4).
- **Too many requests**: the registry is limiting pulls from this node (Step 6).
- **Timeouts, DNS failures or connection refused**: the node cannot reach the registry at all (Step 6).
- **No matching manifest for the node's platform**: the image does not include the node's architecture (Step 6).

Also look for an event with the reason **FailedToRetrieveImagePullSecret**. It means the pod references an image pull Secret that Kubernetes cannot find, so the pull goes ahead without it and usually fails. That one goes straight to Step 4.

## Step 3: Check the image reference

Most pull failures are a reference that does not exist. Print exactly what the pod asks for:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.image}{"\n"}{end}'
```

Read it the way Kubernetes does. An image reference is an optional registry host, a repository path, then an optional tag or digest:

- `busybox` has no registry and no tag, so Kubernetes uses the Docker public registry and the latest tag. It is equivalent to `docker.io/library/busybox:latest`.
- `busybox:1.32.0` is the same registry with a specific tag.
- `registry.k8s.io/pause:3.5` names its own registry.
- `registry.k8s.io/pause@sha256:...` pulls by digest.
- With both a tag and a digest, only the digest is used for pulling.

Common mistakes follow from those rules:

- **A missing registry host.** An image from your private registry written without its host is looked up on the Docker public registry, where it does not exist.
- **A tag that was never pushed**, or a CI pipeline that tagged the image differently from the manifest.
- **An implicit latest.** With no tag, Kubernetes asks for `:latest`. If your registry only has versioned tags, the pull fails.
- **A typo** in the repository path, often a missing organization or project segment.

The official advice is to check the name is correct, check the image was pushed to the registry, and try pulling it manually from a machine with the same access. If you can pull it from your laptop but not from the node, the reference is fine and the problem is credentials or network.

## Step 4: Fix private registry credentials

A private registry needs credentials, and Kubernetes supports several ways to provide them: image pull Secrets on the pod or its ServiceAccount, node-level configuration, kubelet credential provider plugins, or pre-pulled images. The official recommendation for most cases is `imagePullSecrets` on the pod. Check what the pod actually uses:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{.spec.imagePullSecrets}{"\n"}{.spec.serviceAccountName}{"\n"}'
kubectl --context CONTEXT_NAME get serviceaccount SERVICE_ACCOUNT_NAME -n NAMESPACE -o jsonpath='{.imagePullSecrets}{"\n"}'
```

Then check the rules the Secret has to meet:

- **It exists in the same namespace as the pod.** Pods can only reference image pull Secrets in their own namespace, so a Secret created in `default` does nothing for a pod in another namespace. Create it once per namespace.
- **Its name matches exactly.** A FailedToRetrieveImagePullSecret event means the name in the pod spec does not match any Secret in the namespace.
- **Its type is `kubernetes.io/dockerconfigjson` or `kubernetes.io/dockercfg`.**
- **It holds credentials for this registry host.** A Secret made with `kubectl create secret docker-registry` covers one registry. Use one Secret per registry when you pull from several.

List the Secret and its type:

```
kubectl --context CONTEXT_NAME get secret SECRET_NAME -n NAMESPACE -o jsonpath='{.type}{"\n"}'
```

The official docs show how to decode the Secret to confirm which registry it covers. That output contains the registry password, so decide where it will be displayed before you run it, and do not paste it into a ticket or a chat.

If the Secret is missing or wrong, create it in the pod's namespace with your registry details:

```
kubectl --context CONTEXT_NAME create secret docker-registry SECRET_NAME -n NAMESPACE \
  --docker-server=REGISTRY_SERVER \
  --docker-username=REGISTRY_USERNAME \
  --docker-password=REGISTRY_PASSWORD
```

Typing a password on the command line can leave it in your shell history, so prefer importing an existing credentials file, as the official guide on pulling from a private registry describes. Then reference the Secret under `imagePullSecrets` in the workload's pod template, or add it to the ServiceAccount the pod runs as so every pod using that account gets it. If credentials expired or were rotated, update the Secret's contents. The pod picks them up on its next pull attempt.

## Step 5: Check the pull policy

`imagePullPolicy` decides when the kubelet pulls, and it can make a failure appear or disappear depending on what is cached on a node:

- **IfNotPresent**: pull only if the image is not already on the node.
- **Always**: ask the container runtime to resolve the tag with the registry every time a container starts. Layers already cached are not downloaded again, but the registry must be reachable.
- **Never**: never pull. If the image is not already on the node, the container fails to start.

If you leave the field out, Kubernetes fills it in when the object is first created: `Always` for an image tagged `:latest` or with no tag, and `IfNotPresent` for any other tag or a digest. The value is not updated later if you change the tag, so a Deployment created with a versioned tag keeps `IfNotPresent` even after you switch it to `:latest`.

This explains a common puzzle: the same pod runs on one node and fails on another. With `IfNotPresent` or `Never`, a node that already had the image starts the container without contacting the registry, and a fresh node has to pull it and fails. The broken reference or credentials were there all along. Fix the cause rather than relying on what happens to be cached, because nodes are replaced.

## Step 6: Rate limits, network and architecture

**Rate limits.** Some registries limit how many pulls they accept, and each sets its own rules. A "too many requests" error means the registry refused the pull, not that the reference is wrong. Check the registry's documentation for how it counts pulls and whether authenticated pulls get a higher allowance, or mirror the images you depend on into a registry you control.

**Network.** If the event shows a timeout, a DNS failure or a refused connection, the node cannot reach the registry. Check egress rules, proxies and private endpoints between the node pool and the registry. Running the same image elsewhere does not prove the node can reach it.

**Architecture.** A registry can serve an image index that points to builds for several architectures, so each node fetches the one for its own platform. If the image was built for only one architecture and the pod lands on a node of another, for example an amd64 image on an arm64 node, there is nothing for that node to pull. Build a multi-architecture image, or keep the workload on matching nodes with a nodeSelector on `kubernetes.io/arch`.

## Step 7: Fix through the spec and verify

Apply the fix where the workload is defined, usually the Deployment manifest or its Helm values: the corrected image reference, the `imagePullSecrets` entry, or the pull policy. Changing the pod template rolls out new pods. If the fix was outside the spec, such as creating a missing Secret or pushing the missing tag, the existing pod picks it up on its next retry, which can take up to five minutes at the back-off limit. Deleting the pod makes the controller create a replacement that tries again straight away. It does not fix anything the replacement will also hit.

Then confirm it actually moved:

```
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=180s
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -o wide
```

Check that STATUS reaches Running and READY shows every container ready. If the container now starts and then restarts, the image is fine and you have an application problem: follow the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff).

Write down the event message and the change that fixed it. The next pull failure with the same message will take a minute to resolve.

## Conclusion

An ImagePullBackOff pod has no logs, but its events say what the registry answered. Confirm the pod has a node, read the failed pull event, check the image reference against what is in the registry, then check the pull Secret, the pull policy, and the network path from the node. Fix it in the spec and let the next pull prove it.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Images](https://kubernetes.io/docs/concepts/containers/images/)
- [Pull an image from a private registry](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/)
- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
- [Pod lifecycle: container states](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#container-state-waiting)
- [Configure service accounts: add image pull secrets](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#add-imagepullsecrets-to-a-service-account)
