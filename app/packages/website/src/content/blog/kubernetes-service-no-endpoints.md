---
title: "Kubernetes Service not working: no endpoints, DNS and connection refused"
description: "Fix a Kubernetes Service that returns connection refused or has no endpoints by checking DNS, the Service spec, selectors, EndpointSlices, the pods and kube-proxy in order."
date: "2026-10-31"
kind: guide
---

When a Service does not answer, the pods behind it are often fine. The fault sits somewhere in the chain between a client and those pods: a DNS name, a port mapping, a label selector, a readiness check or the proxy on the node. This guide follows the official Kubernetes debugging order, one link at a time, so you find the broken link instead of restarting things until it works.

Prerequisites: kubectl installed, access to the cluster, and permission to read Services, EndpointSlices and pods, and to run a temporary pod. Everything here follows the official [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/) task. Placeholders used throughout: CONTEXT_NAME, NAMESPACE, SERVICE_NAME, SERVICE_IP, PORT, POD_IP, TARGET_PORT and KEY=VALUE for the Service's selector. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## How a request reaches a pod

A request to a Service passes through several pieces, and each can fail on its own:

1. **DNS** turns the Service name into the Service's cluster IP.
2. **The Service spec** maps the port the client uses to a `targetPort` on the pods.
3. **The selector** picks pods by label, and the EndpointSlice controller records the matching pods in EndpointSlices.
4. **Readiness** decides which of those pods count as ready to receive traffic.
5. **The pods** must actually answer on the target port.
6. **kube-proxy**, or whatever implements Services in your cluster, routes traffic from the Service IP to the pods.

Work through them in that order. Each step tells you whether the problem is before or after it.

## Step 1: Get a shell inside the cluster

Most checks need to run from where clients run, not from your laptop. The official guide uses a temporary busybox pod:

```
kubectl --context CONTEXT_NAME run -it --rm --restart=Never busybox --image=registry.k8s.io/busybox:1.27.2 -n NAMESPACE -- sh
```

Run it in the same namespace as the client that is failing. The pod is removed when you exit. If you would rather use an existing pod, `kubectl exec` into it instead.

## Step 2: Does the Service exist?

It sounds too simple, but a missing or misnamed Service is the first thing to rule out:

```
kubectl --context CONTEXT_NAME get svc SERVICE_NAME -n NAMESPACE
```

A NotFound error means the client is asking for a Service that is not there, perhaps under a different name or in a different namespace. Note the CLUSTER-IP and PORT(S) columns for the next steps.

## Step 3: Does the name resolve?

From the temporary pod, look the name up:

```
nslookup SERVICE_NAME
```

If the short name fails, the client and Service may be in different namespaces. Try the namespace-qualified name, then the fully qualified one:

```
nslookup SERVICE_NAME.NAMESPACE
nslookup SERVICE_NAME.NAMESPACE.svc.cluster.local
```

`cluster.local` is the default cluster domain, but yours can differ. If the qualified name works and the short one does not, the client is in another namespace: use the qualified name in the client, or move the two into the same namespace. If only the fully qualified name works, check the pod's `/etc/resolv.conf`: its `search` line needs the namespace suffixes, and `options ndots` must be high enough for search paths to apply. Kubernetes sets `ndots` to 5 by default.

If nothing resolves, test the API server's own Service with `nslookup kubernetes.default`. If that fails too, the problem is cluster DNS, not your Service: follow the [Kubernetes DNS troubleshooting guide](/blog/kubernetes-dns-troubleshooting).

## Step 4: Does the Service answer by IP?

Skip DNS and connect to the cluster IP directly from the temporary pod:

```
wget -qO- SERVICE_IP:PORT
```

If this works, DNS was the problem. If it fails, keep going: the Service itself, its endpoints or the pods are at fault.

## Step 5: Is the Service defined correctly?

Read the Service back and check the port mapping with care:

```
kubectl --context CONTEXT_NAME get service SERVICE_NAME -n NAMESPACE -o yaml
```

The official checklist:

- **Is the port the client uses listed** in `spec.ports`?
- **Is `targetPort` right for the pods?** The Service port and the pod port can differ. A Service on port 80 that forwards to a `targetPort` the app does not listen on produces connection refused.
- **Numbers versus names.** A numeric port must be a number, not the string `"9376"`. A named `targetPort` must match a port name the pods actually declare.
- **Is the protocol right** for the pods?

## Step 6: Does the Service have endpoints?

The Service's selector decides which pods it sends traffic to. The EndpointSlice controller evaluates that selector and saves the matching pods in EndpointSlices. List them:

```
kubectl --context CONTEXT_NAME get endpointslices -n NAMESPACE -l kubernetes.io/service-name=SERVICE_NAME
```

If the ENDPOINTS column reads `<none>`, no pod matches. Compare the Service's `spec.selector` with the labels on the pods you expect it to select:

```
kubectl --context CONTEXT_NAME get service SERVICE_NAME -n NAMESPACE -o jsonpath='{.spec.selector}{"\n"}'
kubectl --context CONTEXT_NAME get pods -n NAMESPACE -l KEY=VALUE
```

If the second command returns nothing, the selector and the pod labels disagree. A typo, or a label the Deployment's pod template never sets, is the classic cause. Fix the selector or the pod template so they match.

If pods match but traffic still does not reach them, check whether they are ready. Each endpoint carries conditions, and for pods the `serving` condition maps to the pod's Ready condition. Service proxies normally send traffic only to endpoints that are ready:

```
kubectl --context CONTEXT_NAME get endpointslices -n NAMESPACE -l kubernetes.io/service-name=SERVICE_NAME -o yaml
```

Look at each endpoint's `conditions`. If `ready` is false, the pod exists but is failing its readiness checks, and the [readiness probe guide](/blog/kubernetes-readiness-probe-failed) covers that. Check the pods' RESTARTS too: frequent restarts cause intermittent connection failures, and the [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff) covers why they happen.

One exception: a Service created without a selector does not get EndpointSlices automatically. Someone has to create them, so empty endpoints on a selectorless Service mean those manual EndpointSlices are missing.

## Step 7: Do the pods answer directly?

Bypass the Service and connect to each endpoint's pod IP on the target port, not the Service port:

```
wget -qO- POD_IP:TARGET_PORT
```

If a pod does not answer here, the problem is in the application: wrong listen port, listening only on localhost, or not started. Look at that pod's logs. If the pods answer directly but the Service IP does not, the problem is the proxy layer.

## Step 8: Network policy and kube-proxy

**Network policy.** If NetworkPolicy ingress rules select the target pods, they may block the client. Review which policies apply to those pods and whether they allow traffic from the client's namespace and labels.

**kube-proxy.** On most clusters, kube-proxy runs on every node and programs the rules that route Service IPs to pods. If your cluster uses a different Service implementation, check that instead. For kube-proxy, the official checks are:

- Confirm kube-proxy is running on the nodes and its logs show no errors contacting the API server.
- In iptables mode, `iptables-save | grep SERVICE_NAME` on a node should show rules for the Service and for each endpoint.
- In IPVS mode, `ipvsadm -ln` should list the Service IP with each endpoint as a real server.

These checks need node access. On managed clusters you may not have it, in which case the provider's own diagnostics for the networking add-on are the route.

**A pod that cannot reach its own Service.** If every client works except a pod that is also one of the Service's endpoints, the node's network may not handle hairpin traffic. The official guide traces this to the kubelet's `hairpin-mode` setting, which must be `hairpin-veth` or `promiscuous-bridge`.

## Step 9: Fix and verify

Apply the fix where it belongs: the Service manifest for ports and selectors, the pod template for labels and probes, the application for its listen address, or the NetworkPolicy for blocked traffic. Then repeat the chain from the temporary pod:

```
nslookup SERVICE_NAME
wget -qO- SERVICE_NAME:PORT
kubectl --context CONTEXT_NAME get endpointslices -n NAMESPACE -l kubernetes.io/service-name=SERVICE_NAME
```

The name should resolve, the request should succeed by name, and the EndpointSlices should list every pod you expect.

Write down which link was broken and what fixed it. The same symptom on another Service will take a minute to place.

If the Service works from inside the cluster but requests through an Ingress still fail, the problem is in front of the Service: follow the [Kubernetes Ingress troubleshooting guide](/blog/kubernetes-ingress-502-503).

## Conclusion

A Service that does not answer is a chain with one broken link. Check, in order: the Service exists, the name resolves, the cluster IP answers, the ports map correctly, the selector matches pods that are ready, the pods answer directly, and the proxy layer routes traffic. Stop at the first check that fails and fix that.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/)
- [Network policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Debug pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
