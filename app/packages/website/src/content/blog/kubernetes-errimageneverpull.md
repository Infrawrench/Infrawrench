---
title: "Kubernetes ErrImageNeverPull: fix local images the node cannot find"
description: "Fix a Kubernetes pod stuck in ErrImageNeverPull by checking which node it landed on, whether that node's container runtime has the exact image and tag, and whether imagePullPolicy Never is the right setting at all."
date: "2026-11-13"
kind: guide
---

A pod in ErrImageNeverPull has a container whose `imagePullPolicy` is `Never`, and the image it asks for is not on the node the pod was scheduled to. With that policy the kubelet will not try a registry, so it gives up straight away and keeps reporting the same error. This almost always happens with images built locally for a development cluster such as kind, minikube or k3d, or on a node where someone expected an image to be preloaded. The fix is either to get the exact image onto the right node or to let the kubelet pull it. This guide shows how to tell which one you need.

Prerequisites: kubectl installed, access to the cluster, and permission to read pods, events and nodes. The node checks need either shell access to the node (for local clusters, through Docker or the cluster tool) or permission to create debug pods on nodes. Everything here follows the official Kubernetes documentation on [images and pull policy](https://kubernetes.io/docs/concepts/containers/images/) and [debugging pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, CONTAINER_NAME, NODE_NAME, IMAGE, TAG, CLUSTER_NAME and DEPLOYMENT_NAME. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## ErrImageNeverPull or ImagePullBackOff?

Both mean the container has no image to start from, but the kubelet gets there differently:

- **ErrImageNeverPull** means the pull policy is `Never`. The kubelet only looks on the node, never at a registry. Nothing about credentials, registry names or network access matters here.
- **ErrImagePull and ImagePullBackOff** mean the kubelet did try a registry and the pull failed. The [image pull errors guide](/blog/kubernetes-imagepullbackoff) covers that case.

If you load a local image into a cluster and see ImagePullBackOff instead of ErrImageNeverPull, check the tag. When you leave `imagePullPolicy` out and the tag is `:latest` or missing, Kubernetes sets the policy to `Always`, so the kubelet goes to a registry even though the image is already on the node.

## Step 1: Confirm the state, the policy and the node

Check you are pointed at the right cluster, then print each container's image, its pull policy and its waiting reason:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o wide
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.image}{"\tpolicy="}{.imagePullPolicy}{"\n"}{end}'
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\twaiting="}{.state.waiting.reason}{"\n"}{.state.waiting.message}{"\n"}{end}'
```

Init containers can fail the same way and hold up the whole pod. Swap `containers` for `initContainers` and `containerStatuses` for `initContainerStatuses` to check them. Write down the NODE column from the `-o wide` output, since the image has to be on that node, not just somewhere in the cluster.

Then read the events:

```
kubectl --context CONTEXT_NAME describe pod POD_NAME -n NAMESPACE
```

Look for a Warning with the reason ErrImageNeverPull. The message names the exact image the kubelet looked for, typically in the form `Container image "IMAGE:TAG" is not present with pull policy of Never`. Copy that string; every check below compares against it.

## Step 2: List the images the node actually has

The kubelet asks the node's container runtime, not your local Docker. An image that shows up in `docker images` on your laptop is not on the node until it has been loaded into the runtime the node uses, usually containerd.

For a **kind** cluster, each node is a Docker container, so you can list its images directly:

```
docker exec -it CLUSTER_NAME-control-plane crictl images
kind get nodes --name CLUSTER_NAME
```

Use the second command to find the other node names in a multi-node cluster, and check the node from Step 1.

For **minikube**:

```
minikube image ls
```

For any other node you can reach with a debug pod, use the host's own tools. This needs permission to create pods on the node, and `crictl` has to be installed on the host:

```
kubectl --context CONTEXT_NAME debug node/NODE_NAME -n NAMESPACE -it --image=busybox
chroot /host crictl images
```

Exit the shell when you are done and delete the debug pod that `kubectl debug` created (its name starts with `node-debugger-`):

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE | grep node-debugger
kubectl --context CONTEXT_NAME delete pod NODE_DEBUGGER_POD -n NAMESPACE
```

Compare the list with the string from Step 1. You are looking for the same repository and the same tag.

## Step 3: Match the name and tag exactly

A near miss counts as missing. Common mismatches:

- **Different tag.** You loaded `myapp:dev` and the pod asks for `myapp:latest`, or the tag in the manifest was bumped after the last load.
- **No tag in the manifest.** An image without a tag means `:latest`. If you loaded `myapp:1.4`, the node does not have `myapp:latest`.
- **Registry prefix.** Runtimes store short names with their full reference, so `myapp:dev` is listed as `docker.io/library/myapp:dev`. That is the same image. But `registry.example.com/myapp:dev` and `myapp:dev` are two different names, and loading one does not satisfy the other.
- **Digest.** If the manifest pins `IMAGE@sha256:...`, the node needs an image with exactly that digest. A rebuild with the same tag has a new digest.

Fix whichever side is wrong: retag and load the image under the name the manifest uses, or change the image in the workload's pod template to the name you loaded.

## Step 4: Load the image onto the node

If the image is simply not there, load it into the cluster's runtime. Each local cluster tool has its own command.

kind copies an image from your local Docker into every node by default:

```
kind load docker-image IMAGE:TAG --name CLUSTER_NAME
```

minikube can load an image from your local Docker, or you can build it straight into the cluster:

```
minikube image load IMAGE:TAG
minikube image build -t IMAGE:TAG .
```

k3d imports an image into the cluster's nodes:

```
k3d image import IMAGE:TAG -c CLUSTER_NAME
```

On other nodes, you can import an image saved as a tar file with the runtime's own tools, for example `ctr -n k8s.io images import image.tar` for containerd. The `-n k8s.io` part matters: containerd keeps images in namespaces, and the kubelet only sees the `k8s.io` namespace. An image imported without it is on the node and still invisible to Kubernetes.

Two more things to check after loading:

- **Every node that could run the pod.** If you loaded the image onto one node and the scheduler picked another, the error stays. Load it onto every node, or pin the workload to the node that has it with a node selector.
- **Node replacements.** A node that is recreated, or a cluster that is deleted and created again, starts without your local images. Load them again afterwards.

## Step 5: Or stop using Never

`imagePullPolicy: Never` only makes sense when something outside Kubernetes puts images on the nodes. Outside a local development cluster it is usually a leftover from one. If the image is in a registry the cluster can reach, change the policy in the workload's pod template:

```
imagePullPolicy: IfNotPresent
```

`IfNotPresent` uses an image already on the node and pulls it only when it is missing, which keeps local loading working while letting other nodes pull from the registry. With a pull policy that reaches a registry, a failure becomes ErrImagePull or ImagePullBackOff, and the [image pull errors guide](/blog/kubernetes-imagepullbackoff) takes over from there.

## Step 6: Roll out the fix

A running pod's image and pull policy are set by the workload that owns it, so change the Deployment, StatefulSet, DaemonSet or Job rather than the pod. If you only loaded the image and changed nothing in the spec, the kubelet notices on its next attempt. You can also replace the pod straight away:

```
kubectl --context CONTEXT_NAME rollout restart deployment/DEPLOYMENT_NAME -n NAMESPACE
```

If you changed the pod template, applying it starts a new rollout on its own.

## Step 7: Verify

Watch the pod leave the error state:

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -w
kubectl --context CONTEXT_NAME rollout status deployment/DEPLOYMENT_NAME -n NAMESPACE --timeout=180s
```

STATUS should move through ContainerCreating to Running. If the container now starts and then restarts, the image problem is fixed and the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff) is the next stop. If it fails to start with an `exec format error`, the image you loaded was built for a different CPU architecture than the node, which the [RunContainerError guide](/blog/kubernetes-runcontainererror) covers.

## Conclusion

ErrImageNeverPull means the pull policy is `Never` and the node the pod landed on does not have the exact image it asks for. Read the image string in the event, list what that node's runtime really has, and match the name, tag and registry prefix exactly. Load the image into every node that might run the pod, with your cluster tool or into containerd's `k8s.io` namespace, or switch to `IfNotPresent` when the image lives in a registry. Then let the workload roll out again.

If moving between local clusters, cloud consoles and node terminals is part of chasing problems like this, Infrawrench puts them in one platform: the Infrastructure app gives you Kubernetes exec and logs, SSH and SQL across your connected cloud accounts. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Images: image pull policy](https://kubernetes.io/docs/concepts/containers/images/#image-pull-policy)
- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
- [Debugging Kubernetes nodes with kubectl](https://kubernetes.io/docs/tasks/debug/debug-cluster/kubectl-node-debug/)
- [Debugging Kubernetes nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [kind: loading an image into your cluster](https://kind.sigs.k8s.io/docs/user/quick-start/#loading-an-image-into-your-cluster)
- [minikube: pushing images](https://minikube.sigs.k8s.io/docs/handbook/pushing/)
