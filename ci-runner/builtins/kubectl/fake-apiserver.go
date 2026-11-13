// A Kubernetes API server just big enough for builtins/test.sh's kubectl
// jobs: discovery, the version, namespaces (list, get, create) and a
// deployment, on the job's own loopback, over TLS with a certificate it
// makes when it starts and writes to $FAKE_API_CA (default
// /tmp/fake-api-ca.pem) for kubectl to trust. TLS because client-go sends
// no bearer token over plain HTTP. It wants `Authorization: Bearer
// fixture-token` and answers 401 otherwise, as a real API server does.
// Built for wasip1 by build.sh with the same toolchain as kubectl.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// selfSigned makes a certificate for 127.0.0.1 and localhost and writes it,
// as PEM, to caPath.
func selfSigned(caPath string) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "fake-apiserver"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:              []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	pemCert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(caPath, pemCert, 0o644); err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

func main() {
	addr := "127.0.0.1:6443"
	if len(os.Args) > 1 {
		addr = os.Args[1]
	}
	var mu sync.Mutex
	namespaces := []string{"default", "kube-system"}
	restarts := 0
	write := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	ns := func(name string) map[string]any {
		return map[string]any{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": name, "uid": "uid-" + name, "resourceVersion": "1"}, "status": map[string]any{"phase": "Active"}}
	}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-token" {
			write(w, 401, map[string]any{"kind": "Status", "apiVersion": "v1", "status": "Failure", "message": "Unauthorized", "reason": "Unauthorized", "code": 401})
			return
		}
		mu.Lock()
		defer mu.Unlock()
		path := r.URL.Path
		// The job reads this log to see what kubectl asked for.
		fmt.Println(r.Method, path, r.Header.Get("Content-Type"))
		switch {
		case path == "/version":
			write(w, 200, map[string]any{"major": "1", "minor": "37", "gitVersion": "v1.37.2-fixture", "platform": "wasip1/wasm"})
		case path == "/api":
			write(w, 200, map[string]any{"kind": "APIVersions", "versions": []string{"v1"}, "serverAddressByClientCIDRs": []any{}})
		case path == "/apis":
			write(w, 200, map[string]any{"kind": "APIGroupList", "apiVersion": "v1", "groups": []any{map[string]any{"name": "apps", "versions": []any{map[string]any{"groupVersion": "apps/v1", "version": "v1"}}, "preferredVersion": map[string]any{"groupVersion": "apps/v1", "version": "v1"}}}})
		case path == "/api/v1":
			write(w, 200, map[string]any{"kind": "APIResourceList", "groupVersion": "v1", "resources": []any{map[string]any{"name": "namespaces", "singularName": "namespace", "namespaced": false, "kind": "Namespace", "verbs": []string{"create", "get", "list"}, "shortNames": []string{"ns"}}}})
		case path == "/apis/apps/v1":
			write(w, 200, map[string]any{"kind": "APIResourceList", "groupVersion": "apps/v1", "resources": []any{map[string]any{"name": "deployments", "singularName": "deployment", "namespaced": true, "kind": "Deployment", "verbs": []string{"get", "list", "patch"}, "shortNames": []string{"deploy"}}}})
		case path == "/api/v1/namespaces" && r.Method == "GET":
			items := []any{}
			for _, n := range namespaces {
				items = append(items, ns(n))
			}
			write(w, 200, map[string]any{"kind": "NamespaceList", "apiVersion": "v1", "metadata": map[string]any{"resourceVersion": "1"}, "items": items})
		case path == "/api/v1/namespaces" && r.Method == "POST":
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				// As a server without the format: client-go falls back to JSON.
				write(w, 415, map[string]any{"kind": "Status", "apiVersion": "v1", "status": "Failure", "message": "unsupported media type " + r.Header.Get("Content-Type"), "reason": "UnsupportedMediaType", "code": 415})
				return
			}
			body, _ := io.ReadAll(r.Body)
			var obj struct {
				Metadata struct{ Name string } `json:"metadata"`
			}
			_ = json.Unmarshal(body, &obj)
			namespaces = append(namespaces, obj.Metadata.Name)
			write(w, 201, ns(obj.Metadata.Name))
		case strings.HasPrefix(path, "/api/v1/namespaces/") && r.Method == "GET":
			name := strings.TrimPrefix(path, "/api/v1/namespaces/")
			for _, n := range namespaces {
				if n == name {
					write(w, 200, ns(n))
					return
				}
			}
			write(w, 404, map[string]any{"kind": "Status", "apiVersion": "v1", "status": "Failure", "message": fmt.Sprintf("namespaces %q not found", name), "reason": "NotFound", "code": 404})
		case path == "/apis/apps/v1/namespaces/default/deployments/web":
			if r.Method == "PATCH" {
				restarts++
			}
			write(w, 200, map[string]any{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]any{"name": "web", "namespace": "default", "resourceVersion": fmt.Sprint(restarts + 1)}, "spec": map[string]any{"replicas": 1, "selector": map[string]any{"matchLabels": map[string]any{"app": "web"}}, "template": map[string]any{"metadata": map[string]any{"labels": map[string]any{"app": "web"}}, "spec": map[string]any{"containers": []any{map[string]any{"name": "web", "image": "web:1"}}}}}})
		default:
			write(w, 404, map[string]any{"kind": "Status", "apiVersion": "v1", "status": "Failure", "message": "the server could not find the requested resource", "reason": "NotFound", "code": 404})
		}
	})
	caPath := os.Getenv("FAKE_API_CA")
	if caPath == "" {
		caPath = "/tmp/fake-api-ca.pem"
	}
	cert, err := selfSigned(caPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake-apiserver:", err)
		os.Exit(1)
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake-apiserver:", err)
		os.Exit(1)
	}
	fmt.Println("fake-apiserver: listening on", addr)
	server := &http.Server{TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}}}
	if err := server.ServeTLS(listener, "", ""); err != nil {
		fmt.Fprintln(os.Stderr, "fake-apiserver:", err)
		os.Exit(1)
	}
}
