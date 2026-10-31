---
title: "Kubernetes DNS not working: debug name resolution in pods"
description: "Debug Kubernetes DNS failures step by step: test from a dnsutils pod, read resolv.conf, check CoreDNS pods, logs, Service and endpoints, then fix namespaces, ndots and dnsPolicy."
date: "2026-10-31"
kind: guide
---

When DNS breaks in a Kubernetes cluster, the symptoms look like everything else breaking: connection errors, timeouts, "could not resolve host" in application logs. Before you dig into the application, confirm whether names resolve at all. Cluster DNS is just another workload, usually CoreDNS, sitting behind a Service in `kube-system`, so it can fail in the same ways your own Services do. This guide shows how to test resolution from inside a pod, read the pod's resolver configuration, check CoreDNS from its pods through to its Service and endpoints, and fix the common causes.

Prerequisites: kubectl installed, access to the cluster, and permission to create a pod and read pods, Services, EndpointSlices and ConfigMaps in `kube-system`. Everything here follows the official [Kubernetes documentation](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/) and assumes the cluster uses CoreDNS. Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME and SERVICE_NAME. Replace them before running a command. If a single Service is unreachable but other names resolve, the [Service troubleshooting guide](/blog/kubernetes-service-no-endpoints) is the better starting point.

## How names resolve in a pod

Every pod gets an `/etc/resolv.conf` written by the kubelet. With the default DNS policy, it points at the cluster DNS Service and carries a search list built from the pod's namespace:

```
nameserver 10.32.0.10
search <namespace>.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

A Service gets a name of the form `SERVICE_NAME.NAMESPACE.svc.cluster.local`, where `cluster.local` is the default cluster domain and yours can differ. The search list is why a short name works: a pod asking for `SERVICE_NAME` has it expanded with its own namespace first. That also means a query without a namespace is limited to the pod's own namespace. A pod in the `test` namespace can resolve `data.prod` or `data.prod.svc.cluster.local`, but not plain `data` for a Service in `prod`.

## Step 1: Test from a dnsutils pod

Your application image may not include DNS tools, so start a test pod from the image the Kubernetes docs use:

```
kubectl --context CONTEXT_NAME apply -f https://k8s.io/examples/admin/dns/dnsutils.yaml
kubectl --context CONTEXT_NAME get pods dnsutils
```

The pod is created in the `default` namespace. Once it is Running, look up the API server's own Service, which exists in every cluster:

```
kubectl --context CONTEXT_NAME exec -i -t dnsutils -- nslookup kubernetes.default
```

If it returns an address, cluster DNS is working, and the problem is the name you are looking up or the pod making the query: go to Step 6. If it fails with `can't resolve 'kubernetes.default'`, the problem is with CoreDNS or its Service: keep going.

## Step 2: Read resolv.conf

Check what the pod is actually configured to use:

```
kubectl --context CONTEXT_NAME exec -ti dnsutils -- cat /etc/resolv.conf
```

You should see a `nameserver` line with the cluster DNS Service IP, a `search` line that starts with `default.svc.cluster.local svc.cluster.local cluster.local`, and `options ndots:5`. Cloud providers often add their own search domains at the end, which is normal.

Note the nameserver IP. In the next steps you will check that it matches the ClusterIP of the DNS Service. If the file looks nothing like this, for example it lists your node's or office DNS servers, the pod's DNS policy is not the default: see Step 7.

## Step 3: Are the CoreDNS pods running?

```
kubectl --context CONTEXT_NAME get pods --namespace=kube-system -l k8s-app=kube-dns
```

The label value is `kube-dns` even for CoreDNS, kept for backward compatibility. Every pod should be Running and ready. If there are none, or they are in [CrashLoopBackOff](/blog/kubernetes-crashloopbackoff), [Pending](/blog/kubernetes-pod-pending) or Failed, fix that first. If no CoreDNS pod exists at all, the DNS add-on may not be deployed in your environment, and you will have to deploy it.

## Step 4: Read the CoreDNS logs

```
kubectl --context CONTEXT_NAME logs --namespace=kube-system -l k8s-app=kube-dns
```

A healthy log shows CoreDNS starting on port 53 and loading its configuration. Look for anything unexpected: errors reaching upstream servers, errors talking to the Kubernetes API, or reload failures after a config change.

If the logs show SERVFAIL for names inside the cluster, check that CoreDNS has permission to read what it needs. It must be able to list and watch Services and EndpointSlices:

```
kubectl --context CONTEXT_NAME describe clusterrole system:coredns
```

The rules should include list and watch on `endpoints`, `namespaces`, `pods`, `services` and `endpointslices.discovery.k8s.io`. Add any that are missing.

## Step 5: Is the DNS Service up, with endpoints?

The pods can be healthy while the Service in front of them is broken. Check the Service, which is also called `kube-dns` for backward compatibility:

```
kubectl --context CONTEXT_NAME get svc --namespace=kube-system
```

Its CLUSTER-IP should match the `nameserver` line from Step 2, with port 53 on both UDP and TCP. Then check that it has endpoints:

```
kubectl --context CONTEXT_NAME get endpointslice -l kubernetes.io/service-name=kube-dns --namespace=kube-system
```

The ENDPOINTS column should list the CoreDNS pod IPs. If the Service is missing or has no endpoints, debug it like any other Service: the [Service troubleshooting guide](/blog/kubernetes-service-no-endpoints) walks through selectors, readiness and EndpointSlices.

To confirm queries actually reach CoreDNS, add the `log` plugin to its configuration. The Corefile lives in the `coredns` ConfigMap:

```
kubectl --context CONTEXT_NAME -n kube-system edit configmap coredns
```

Add a line with `log` inside the `.:53 { ... }` block, save, and wait a minute or two for the change to reach the CoreDNS pods. Then rerun the lookup from Step 1 and read the logs again. Each query shows up as a line with the name, the record type and the response code. If nothing appears, queries are not reaching CoreDNS, so look at the network path between the pod and the Service, including network policies. Remove the `log` line when you are done, because it logs every query.

## Step 6: The name itself

If `kubernetes.default` resolves but your Service does not, the problem is usually the name. Test it from the dnsutils pod, first short, then with the namespace:

```
kubectl --context CONTEXT_NAME exec -i -t dnsutils -- nslookup SERVICE_NAME
kubectl --context CONTEXT_NAME exec -i -t dnsutils -- nslookup SERVICE_NAME.NAMESPACE
```

Remember that dnsutils runs in `default`. If only the qualified name works, the client and the Service are in different namespaces, and the client must use `SERVICE_NAME.NAMESPACE`. If neither works, check the Service exists in that namespace with that exact name.

Two details explain stranger results:

- **ndots.** With `ndots:5`, a name with fewer than five dots is tried against each search domain before it is tried as written. That is what makes short names work, but it also means an external name like `api.example.com` is first tried as `api.example.com.NAMESPACE.svc.cluster.local` and so on. If you see slow or odd lookups for external names, this is usually why.
- **Headless Services.** A Service without a cluster IP resolves to the IPs of its ready pods, not a single address. If none of its pods are ready, there is nothing to return, unless the Service sets `publishNotReadyAddresses`.

## Step 7: Check the pod's DNS policy

A pod's `dnsPolicy` decides where its `/etc/resolv.conf` comes from:

- **ClusterFirst** is what you get when the field is not set. Names that are not in the cluster domain are forwarded to upstream servers.
- **Default** makes the pod inherit the node's resolver configuration, so cluster names do not resolve. Despite its name, it is not the default.
- **ClusterFirstWithHostNet** is required for pods with `hostNetwork: true` that need cluster DNS. Without it, those pods fall back to the Default behavior.
- **None** ignores cluster DNS settings and uses only what the pod's `dnsConfig` provides.

Check what a pod is using:

```
kubectl --context CONTEXT_NAME get pod POD_NAME -n NAMESPACE -o jsonpath='{.spec.dnsPolicy}{"\t"}{.spec.hostNetwork}{"\n"}{.spec.dnsConfig}{"\n"}'
```

A `hostNetwork` pod without `ClusterFirstWithHostNet` is a common reason one workload cannot resolve cluster names while everything else can. A `dnsConfig` can also add nameservers, search domains and options such as a lower `ndots` on top of any policy.

## Step 8: Known node and image issues

Some problems come from the node or the image rather than Kubernetes:

- **systemd-resolved.** On distributions such as Ubuntu, `/etc/resolv.conf` can be a stub pointing at a local resolver, which can cause a forwarding loop when CoreDNS forwards to it. Point the kubelet's `--resolv-conf` flag at `/run/systemd/resolve/resolv.conf`. kubeadm detects this and sets the flag for you.
- **Too many nameservers.** glibc uses at most three `nameserver` lines, and Kubernetes needs one. If the node already lists three, some are dropped.
- **Old Alpine images.** Alpine 3.17 and earlier lack TCP fallback in the resolver, so DNS responses larger than 512 bytes fail. Upgrade images to Alpine 3.18 or later.

## Step 9: Clean up and verify

Rerun the lookups from inside the affected workload, not just dnsutils, because DNS policy is per pod:

```
kubectl --context CONTEXT_NAME exec -i -t dnsutils -- nslookup kubernetes.default
kubectl --context CONTEXT_NAME exec -i -t dnsutils -- nslookup SERVICE_NAME.NAMESPACE
```

When both resolve and the application connects, delete the test pod and remove the `log` plugin if you added it:

```
kubectl --context CONTEXT_NAME delete pod dnsutils
```

## Conclusion

Start every DNS investigation with `nslookup kubernetes.default` from a test pod. If that fails, work through CoreDNS: pods, logs, permissions, the `kube-dns` Service and its endpoints. If it works, look at the name, the namespace, `ndots` and the pod's DNS policy. Most DNS outages turn out to be one of those, not the network.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Debugging DNS resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Customizing DNS service](https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Headless Services](https://kubernetes.io/docs/concepts/services-networking/service/#headless-services)
