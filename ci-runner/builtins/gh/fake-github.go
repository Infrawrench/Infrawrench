// fake-github: a GitHub just big enough for builtins/test.sh's gh jobs,
// on the job's own loopback, so no test reaches the real one.
//
// It is an HTTPS proxy (`HTTPS_PROXY=http://127.0.0.1:8080`): gh and Git
// connect to it for github.com and api.github.com as they would through any
// proxy, and it answers as GitHub, with a certificate for the host they
// asked for from a CA it makes and writes to /tmp/fake-github-ca.pem
// (`SSL_CERT_FILE` for gh, `GIT_SSL_CAINFO` for Git). So the job runs gh
// and Git exactly as it would against GitHub: same host names, same token
// variables, same Git configuration, nothing pointed elsewhere.
//
// It serves one repository, acme/widgets:
//
//   - REST: the repository, releases (create, read by tag, upload an asset),
//     and whatever `gh api` is asked for under /repos/acme/widgets that the
//     fixture knows.
//   - GraphQL: the queries and mutations gh sends for `pr create/edit/list`
//     and `issue create/edit/close`, answered from a small in-memory store.
//   - Git over HTTPS (smart HTTP): a bare repository under /tmp/fake-github,
//     served by Git's own `upload-pack` and `receive-pack`.
//
// Every request must carry the token it was started with (GH_TOKEN, or
// `-token`): as `Authorization: token <t>` (or `Bearer`) for the API, or
// as Basic `x-access-token:<t>` for Git, the way an installation token is
// used. Anything else is a 401. Each request is logged to stdout as
// `<METHOD> <host><path>` (plus the GraphQL operation), which the jobs grep.
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	owner = "acme"
	name  = "widgets"
	full  = owner + "/" + name
)

var (
	token   string
	gitRoot = "/tmp/fake-github"
	mu      sync.Mutex
	store   = newStore()
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8080", "where to listen")
	flag.StringVar(&token, "token", os.Getenv("GH_TOKEN"), "the token every request must carry")
	caFile := flag.String("ca", "/tmp/fake-github-ca.pem", "where to write the CA certificate")
	flag.Parse()
	if token == "" {
		fmt.Fprintln(os.Stderr, "fake-github: no token (GH_TOKEN or -token)")
		os.Exit(2)
	}
	ca, err := newCA(*caFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake-github:", err)
		os.Exit(1)
	}
	if err := initRepo(); err != nil {
		fmt.Fprintln(os.Stderr, "fake-github: the repository:", err)
		os.Exit(1)
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake-github:", err)
		os.Exit(1)
	}
	fmt.Println("listening on", *listen)
	tunnels := &chanListener{conns: make(chan net.Conn), addr: ln.Addr()}
	inner := &http.Server{Handler: http.HandlerFunc(serve)}
	// One request per connection, closed by the server once answered.
	inner.SetKeepAlivesEnabled(false)
	go func() { _ = inner.Serve(tunnels) }()
	proxy := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "this is a proxy for HTTPS only", http.StatusMethodNotAllowed)
			return
		}
		host, _, _ := net.SplitHostPort(r.Host)
		if host != "github.com" && host != "api.github.com" && host != "uploads.github.com" {
			fmt.Println("REFUSED CONNECT", r.Host)
			http.Error(w, "not a GitHub host", http.StatusForbidden)
			return
		}
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		_, _ = conn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
		tlsConn := tls.Server(conn, &tls.Config{
			NextProtos: []string{"http/1.1"},
			GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
				return ca.leaf(host)
			},
		})
		tunnels.conns <- tlsConn
	})}
	_ = proxy.Serve(ln)
}

// chanListener hands the HTTP server the connections the proxy tunnelled.
type chanListener struct {
	conns chan net.Conn
	addr  net.Addr
}

func (l *chanListener) Accept() (net.Conn, error) { return <-l.conns, nil }
func (l *chanListener) Close() error              { return nil }
func (l *chanListener) Addr() net.Addr            { return l.addr }

// A CA, made fresh each start, and a certificate per host it is asked for.
type authority struct {
	cert  *x509.Certificate
	key   *ecdsa.PrivateKey
	mu    sync.Mutex
	leafs map[string]*tls.Certificate
}

func newCA(path string) (*authority, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "fake-github CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	cert, _ := x509.ParseCertificate(der)
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return nil, err
	}
	return &authority{cert: cert, key: key, leafs: map[string]*tls.Certificate{}}, nil
}

func (a *authority) leaf(host string) (*tls.Certificate, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if c, ok := a.leafs[host]; ok {
		return c, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(int64(len(a.leafs) + 2)),
		Subject:      pkix.Name{CommonName: host},
		DNSNames:     []string{host},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, a.cert, &key.PublicKey, a.key)
	if err != nil {
		return nil, err
	}
	c := &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	a.leafs[host] = c
	return c, nil
}

func initRepo() error {
	dir := filepath.Join(gitRoot, full+".git")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	out, err := runGit(nil, nil, "init", "--quiet", "--bare", "--initial-branch=main", dir)
	if err != nil {
		return fmt.Errorf("git init: %v: %s", err, out)
	}
	return nil
}

// runGit runs Git with stdin, stdout and stderr in files rather than pipes.
// A Go program for wasip1 runs every goroutine on one thread, and waiting
// for a child blocks that thread: with pipes, the goroutines that feed and
// drain them never run, and a child with more than a pipe's worth to read
// or write waits for ever. Files need no goroutine.
func runGit(env []string, stdin []byte, args ...string) ([]byte, error) {
	dir, err := os.MkdirTemp("", "fake-github-git")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	in := filepath.Join(dir, "in")
	if err := os.WriteFile(in, stdin, 0o600); err != nil {
		return nil, err
	}
	files := make([]*os.File, 3)
	for i, name := range []string{"in", "out", "err"} {
		flag := os.O_RDONLY
		if name != "in" {
			flag = os.O_CREATE | os.O_RDWR
		}
		if files[i], err = os.OpenFile(filepath.Join(dir, name), flag, 0o600); err != nil {
			return nil, err
		}
		defer files[i].Close()
	}
	cmd := exec.Command("git", args...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = files[0], files[1], files[2]
	runErr := cmd.Run()
	out, _ := os.ReadFile(filepath.Join(dir, "out"))
	if runErr != nil {
		errOut, _ := os.ReadFile(filepath.Join(dir, "err"))
		return out, fmt.Errorf("%v: %s", runErr, errOut)
	}
	return out, nil
}

// authorized: the token, as the API or Git sends it.
func authorized(r *http.Request) bool {
	h := r.Header.Get("Authorization")
	for _, scheme := range []string{"token ", "Bearer ", "bearer "} {
		if strings.HasPrefix(h, scheme) {
			return strings.TrimPrefix(h, scheme) == token
		}
	}
	if user, pass, ok := r.BasicAuth(); ok {
		return user == "x-access-token" && pass == token
	}
	return false
}

func serve(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	var body []byte
	if r.Body != nil {
		body, _ = io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
	}
	line := fmt.Sprintf("%s %s%s", r.Method, host, r.URL.Path)
	if r.URL.Path == "/graphql" {
		line += " " + operation(body)
	}
	if !authorized(r) {
		fmt.Println(line, "-> 401")
		if host == "github.com" {
			w.Header().Set("WWW-Authenticate", `Basic realm="GitHub"`)
		}
		writeJSON(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials", "documentation_url": "https://docs.github.com/rest"})
		return
	}
	fmt.Println(line)
	switch host {
	case "github.com":
		serveGit(w, r, body)
	case "uploads.github.com":
		serveUpload(w, r, body)
	default:
		w.Header().Set("X-Oauth-Scopes", "")
		w.Header().Set("X-GitHub-Media-Type", "github.v3; format=json")
		if r.URL.Path == "/graphql" {
			serveGraphQL(w, body)
		} else {
			serveREST(w, r, body)
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Git's smart HTTP, served by Git itself.
func serveGit(w http.ResponseWriter, r *http.Request, body []byte) {
	path := strings.TrimSuffix(r.URL.Path, "/")
	var repo, rest string
	if i := strings.Index(path, ".git/"); i >= 0 {
		repo, rest = path[1:i], path[i+5:]
	} else {
		http.NotFound(w, r)
		return
	}
	if repo != full {
		http.NotFound(w, r)
		return
	}
	dir := filepath.Join(gitRoot, full+".git")
	switch {
	case r.Method == http.MethodGet && rest == "info/refs":
		service := r.URL.Query().Get("service")
		if service != "git-upload-pack" && service != "git-receive-pack" {
			http.Error(w, "dumb HTTP is not served", http.StatusForbidden)
			return
		}
		out, err := runGit(gitEnv(r), nil, strings.TrimPrefix(service, "git-"), "--stateless-rpc", "--advertise-refs", dir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/x-"+service+"-advertisement")
		w.Header().Set("Cache-Control", "no-cache")
		// Protocol v2 starts with its own capability advertisement, without
		// the v0 service line (as git http-backend answers).
		if !strings.Contains(r.Header.Get("Git-Protocol"), "version=2") || service != "git-upload-pack" {
			pkt := fmt.Sprintf("# service=%s\n", service)
			fmt.Fprintf(w, "%04x%s0000", len(pkt)+4, pkt)
		}
		_, _ = w.Write(out)
	case r.Method == http.MethodPost && (rest == "git-upload-pack" || rest == "git-receive-pack"):
		// Git compresses a large request, as http-backend expects.
		if r.Header.Get("Content-Encoding") == "gzip" {
			zr, err := gzip.NewReader(bytes.NewReader(body))
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if body, err = io.ReadAll(zr); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}
		out, err := runGit(gitEnv(r), body, strings.TrimPrefix(rest, "git-"), "--stateless-rpc", dir)
		if err != nil {
			fmt.Println("  git", rest, "failed:", err)
		}
		w.Header().Set("Content-Type", "application/x-"+rest+"-result")
		_, _ = w.Write(out)
	default:
		http.NotFound(w, r)
	}
}

// gitEnv passes the protocol version the client asked for to Git, as
// git http-backend does.
func gitEnv(r *http.Request) []string {
	env := os.Environ()
	if v := r.Header.Get("Git-Protocol"); v != "" {
		env = append(env, "GIT_PROTOCOL="+v)
	}
	return env
}

// What the fixture repository holds besides its Git objects.
type issue struct {
	Number    int
	Title     string
	Body      string
	State     string
	Labels    []string
	IsPR      bool
	Head      string
	Base      string
	Draft     bool
	CreatedAt string
}

type release struct {
	ID     int
	Tag    string
	Name   string
	Body   string
	Target string
	Draft  bool
	Assets []string
}

type fixture struct {
	next     int
	issues   map[int]*issue
	releases []*release
}

func newStore() *fixture {
	s := &fixture{next: 1, issues: map[int]*issue{}}
	return s
}

func repoJSON() map[string]any {
	return map[string]any{
		"id": 1, "node_id": "R_widgets", "name": name, "full_name": full,
		"owner":          map[string]any{"login": owner, "id": 2, "type": "Organization"},
		"private":        false,
		"html_url":       "https://github.com/" + full,
		"default_branch": "main",
		"permissions":    map[string]any{"admin": false, "push": true, "pull": true},
	}
}

func releaseJSON(rel *release) map[string]any {
	assets := []map[string]any{}
	for i, a := range rel.Assets {
		assets = append(assets, map[string]any{
			"id": i + 1, "name": a, "state": "uploaded", "size": 1,
			"url":                  fmt.Sprintf("https://api.github.com/repos/%s/releases/assets/%d", full, i+1),
			"browser_download_url": fmt.Sprintf("https://github.com/%s/releases/download/%s/%s", full, rel.Tag, a),
		})
	}
	return map[string]any{
		"id": rel.ID, "tag_name": rel.Tag, "name": rel.Name, "body": rel.Body,
		"target_commitish": rel.Target, "draft": rel.Draft, "prerelease": false,
		"url":        fmt.Sprintf("https://api.github.com/repos/%s/releases/%d", full, rel.ID),
		"html_url":   fmt.Sprintf("https://github.com/%s/releases/tag/%s", full, rel.Tag),
		"upload_url": fmt.Sprintf("https://uploads.github.com/repos/%s/releases/%d/assets{?name,label}", full, rel.ID),
		"assets":     assets,
		"created_at": "2026-11-15T00:00:00Z",
	}
}

var (
	releaseByTag = regexp.MustCompile(`^/repos/` + full + `/releases/tags/(.+)$`)
	releaseByID  = regexp.MustCompile(`^/repos/` + full + `/releases/(\d+)$`)
)

func serveREST(w http.ResponseWriter, r *http.Request, body []byte) {
	mu.Lock()
	defer mu.Unlock()
	path := r.URL.Path
	switch {
	case path == "/user" || path == "/user/":
		// An installation token has no user, and GitHub says so.
		writeJSON(w, http.StatusForbidden, map[string]any{"message": "Resource not accessible by integration"})
	case path == "/repos/"+full && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, repoJSON())
	case path == "/repos/"+full+"/releases" && r.Method == http.MethodGet:
		out := []map[string]any{}
		for _, rel := range store.releases {
			out = append(out, releaseJSON(rel))
		}
		writeJSON(w, http.StatusOK, out)
	case path == "/repos/"+full+"/releases" && r.Method == http.MethodPost:
		var in struct {
			Tag    string `json:"tag_name"`
			Name   string `json:"name"`
			Body   string `json:"body"`
			Target string `json:"target_commitish"`
			Draft  bool   `json:"draft"`
		}
		_ = json.Unmarshal(body, &in)
		rel := &release{ID: len(store.releases) + 1, Tag: in.Tag, Name: in.Name, Body: in.Body, Target: in.Target, Draft: in.Draft}
		store.releases = append(store.releases, rel)
		fmt.Printf("  release %q created at %q (draft %v)\n", in.Tag, in.Target, in.Draft)
		writeJSON(w, http.StatusCreated, releaseJSON(rel))
	case releaseByTag.MatchString(path) && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		tag := releaseByTag.FindStringSubmatch(path)[1]
		for _, rel := range store.releases {
			if rel.Tag == tag {
				writeJSON(w, http.StatusOK, releaseJSON(rel))
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]any{"message": "Not Found"})
	case releaseByID.MatchString(path) && r.Method == http.MethodPatch:
		id, _ := strconv.Atoi(releaseByID.FindStringSubmatch(path)[1])
		if id < 1 || id > len(store.releases) {
			writeJSON(w, http.StatusNotFound, map[string]any{"message": "Not Found"})
			return
		}
		rel := store.releases[id-1]
		var in map[string]any
		_ = json.Unmarshal(body, &in)
		if d, ok := in["draft"].(bool); ok {
			rel.Draft = d
		}
		writeJSON(w, http.StatusOK, releaseJSON(rel))
	case strings.HasPrefix(path, "/repos/"+full+"/git/ref"):
		writeJSON(w, http.StatusNotFound, map[string]any{"message": "Not Found"})
	default:
		fmt.Println("  not in the fixture:", r.Method, path, string(body))
		writeJSON(w, http.StatusNotFound, map[string]any{"message": "Not Found"})
	}
}

func serveUpload(w http.ResponseWriter, r *http.Request, body []byte) {
	mu.Lock()
	defer mu.Unlock()
	m := regexp.MustCompile(`^/repos/` + full + `/releases/(\d+)/assets$`).FindStringSubmatch(r.URL.Path)
	if m == nil || r.Method != http.MethodPost {
		writeJSON(w, http.StatusNotFound, map[string]any{"message": "Not Found"})
		return
	}
	id, _ := strconv.Atoi(m[1])
	if id < 1 || id > len(store.releases) {
		writeJSON(w, http.StatusNotFound, map[string]any{"message": "Not Found"})
		return
	}
	rel := store.releases[id-1]
	asset := r.URL.Query().Get("name")
	rel.Assets = append(rel.Assets, asset)
	fmt.Printf("  asset %q (%d bytes) on %q\n", asset, len(body), rel.Tag)
	writeJSON(w, http.StatusCreated, map[string]any{"id": len(rel.Assets), "name": asset, "state": "uploaded", "size": len(body)})
}

// operation names a GraphQL request for the log: its operation name, or
// the first operation's.
func operation(body []byte) string {
	var req struct {
		Query         string `json:"query"`
		OperationName string `json:"operationName"`
	}
	_ = json.Unmarshal(body, &req)
	if req.OperationName != "" {
		return req.OperationName
	}
	if m := regexp.MustCompile(`\b(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)`).FindStringSubmatch(req.Query); m != nil {
		return m[2]
	}
	return "anonymous"
}

func serveGraphQL(w http.ResponseWriter, body []byte) {
	mu.Lock()
	defer mu.Unlock()
	var req struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	_ = json.Unmarshal(body, &req)
	data, err := execute(req.Query, req.Variables)
	if err != nil {
		fmt.Println("  graphql:", err, "in", strings.Join(strings.Fields(req.Query), " "))
		writeJSON(w, http.StatusOK, map[string]any{"data": nil, "errors": []map[string]any{{"message": err.Error()}}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": data})
}

// A GraphQL executor just big enough for gh: it parses the document and
// answers exactly the fields asked for (gh decodes some answers strictly,
// and an extra field fails it), from objects whose fields are values or
// functions of their arguments. A field the fixture does not have is null.

type selection struct {
	alias, name string
	args        map[string]any
	sub         []selection
	spread      string // `...name`
	on          string // `... on Type`
}

type parser struct {
	src  string
	pos  int
	vars map[string]any
}

func (p *parser) skip() {
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == '#' {
			for p.pos < len(p.src) && p.src[p.pos] != '\n' {
				p.pos++
			}
		} else if c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' {
			p.pos++
		} else {
			return
		}
	}
}

func (p *parser) peek() byte {
	p.skip()
	if p.pos >= len(p.src) {
		return 0
	}
	return p.src[p.pos]
}

func (p *parser) expect(c byte) error {
	if p.peek() != c {
		return fmt.Errorf("expected %q at %d", c, p.pos)
	}
	p.pos++
	return nil
}

func (p *parser) name() string {
	p.skip()
	start := p.pos
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			p.pos++
		} else {
			break
		}
	}
	return p.src[start:p.pos]
}

func (p *parser) value() (any, error) {
	switch c := p.peek(); {
	case c == '$':
		p.pos++
		return p.vars[p.name()], nil
	case c == '"':
		p.pos++
		var b strings.Builder
		for p.pos < len(p.src) && p.src[p.pos] != '"' {
			if p.src[p.pos] == '\\' && p.pos+1 < len(p.src) {
				p.pos++
			}
			b.WriteByte(p.src[p.pos])
			p.pos++
		}
		p.pos++
		return b.String(), nil
	case c == '[':
		p.pos++
		var out []any
		for p.peek() != ']' {
			v, err := p.value()
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		p.pos++
		return out, nil
	case c == '{':
		p.pos++
		out := map[string]any{}
		for p.peek() != '}' {
			k := p.name()
			if err := p.expect(':'); err != nil {
				return nil, err
			}
			v, err := p.value()
			if err != nil {
				return nil, err
			}
			out[k] = v
		}
		p.pos++
		return out, nil
	case c == '-' || c >= '0' && c <= '9':
		start := p.pos
		p.pos++
		for p.pos < len(p.src) && strings.IndexByte("0123456789.eE+-", p.src[p.pos]) >= 0 {
			p.pos++
		}
		n, _ := strconv.ParseFloat(p.src[start:p.pos], 64)
		return n, nil
	default:
		word := p.name()
		switch word {
		case "true":
			return true, nil
		case "false":
			return false, nil
		case "null":
			return nil, nil
		case "":
			return nil, fmt.Errorf("unexpected %q at %d", c, p.pos)
		}
		return word, nil // an enum
	}
}

func (p *parser) selections() ([]selection, error) {
	if err := p.expect('{'); err != nil {
		return nil, err
	}
	var out []selection
	for p.peek() != '}' {
		if p.peek() == 0 {
			return nil, fmt.Errorf("unterminated selection")
		}
		if strings.HasPrefix(p.src[p.pos:], "...") {
			p.pos += 3
			word := p.name()
			if word == "on" {
				typ := p.name()
				sub, err := p.selections()
				if err != nil {
					return nil, err
				}
				out = append(out, selection{on: typ, sub: sub})
			} else if word == "" {
				sub, err := p.selections()
				if err != nil {
					return nil, err
				}
				out = append(out, selection{sub: sub})
			} else {
				out = append(out, selection{spread: word})
			}
			continue
		}
		s := selection{name: p.name()}
		if s.name == "" {
			return nil, fmt.Errorf("expected a field at %d", p.pos)
		}
		if p.peek() == ':' {
			p.pos++
			s.alias, s.name = s.name, p.name()
		}
		if p.peek() == '(' {
			p.pos++
			s.args = map[string]any{}
			for p.peek() != ')' {
				k := p.name()
				if err := p.expect(':'); err != nil {
					return nil, err
				}
				v, err := p.value()
				if err != nil {
					return nil, err
				}
				s.args[k] = v
			}
			p.pos++
		}
		for p.peek() == '@' { // directives are ignored
			p.pos++
			p.name()
			if p.peek() == '(' {
				for p.pos < len(p.src) && p.src[p.pos] != ')' {
					p.pos++
				}
				p.pos++
			}
		}
		if p.peek() == '{' {
			sub, err := p.selections()
			if err != nil {
				return nil, err
			}
			s.sub = sub
		}
		out = append(out, s)
	}
	p.pos++
	return out, nil
}

// object: a GraphQL object of the fixture. A field is a value, an object,
// a list of objects, or a func(args) any.
type object map[string]any

type resolver func(args map[string]any) any

func execute(query string, vars map[string]any) (map[string]any, error) {
	p := &parser{src: query, vars: vars}
	fragments := map[string][]selection{}
	var op []selection
	opKind := ""
	for p.peek() != 0 {
		word := p.name()
		switch word {
		case "fragment":
			fname := p.name()
			p.name() // on
			p.name() // Type
			sub, err := p.selections()
			if err != nil {
				return nil, err
			}
			fragments[fname] = sub
		case "query", "mutation", "":
			if word == "" && p.peek() != '{' {
				return nil, fmt.Errorf("unexpected %q", p.peek())
			}
			if word == "" {
				word = "query"
			}
			opKind = word
			if p.peek() != '{' && p.peek() != '(' {
				p.name()
			}
			if p.peek() == '(' { // variable definitions
				depth := 0
				for p.pos < len(p.src) {
					c := p.src[p.pos]
					p.pos++
					if c == '(' {
						depth++
					} else if c == ')' {
						depth--
						if depth == 0 {
							break
						}
					}
				}
			}
			sub, err := p.selections()
			if err != nil {
				return nil, err
			}
			op = sub
		default:
			return nil, fmt.Errorf("unexpected %q", word)
		}
	}
	root := queryRoot()
	if opKind == "mutation" {
		root = mutationRoot()
	}
	out, err := resolveObject(root, op, fragments)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func resolveObject(obj object, sel []selection, fragments map[string][]selection) (map[string]any, error) {
	out := map[string]any{}
	var walk func([]selection) error
	walk = func(sel []selection) error {
		for _, s := range sel {
			switch {
			case s.spread != "":
				f, ok := fragments[s.spread]
				if !ok {
					return fmt.Errorf("no fragment %s", s.spread)
				}
				if err := walk(f); err != nil {
					return err
				}
				continue
			case s.name == "":
				if t, _ := obj["__typename"].(string); s.on == "" || t == "" || t == s.on {
					if err := walk(s.sub); err != nil {
						return err
					}
				}
				continue
			}
			key := s.name
			if s.alias != "" {
				key = s.alias
			}
			v := obj[s.name]
			if f, ok := v.(resolver); ok {
				v = f(s.args)
			}
			if e, ok := v.(error); ok {
				return e
			}
			r, err := shape(v, s.sub, fragments)
			if err != nil {
				return err
			}
			out[key] = r
		}
		return nil
	}
	return out, walk(sel)
}

func shape(v any, sub []selection, fragments map[string][]selection) (any, error) {
	switch x := v.(type) {
	case object:
		if sub == nil {
			return nil, nil
		}
		return resolveObject(x, sub, fragments)
	case []object:
		out := []any{}
		for _, o := range x {
			r, err := resolveObject(o, sub, fragments)
			if err != nil {
				return nil, err
			}
			out = append(out, r)
		}
		return out, nil
	default:
		return v, nil
	}
}

func connection(nodes []object) object {
	return object{
		"totalCount": len(nodes),
		"nodes":      nodes,
		"edges": func() []object {
			e := []object{}
			for _, n := range nodes {
				e = append(e, object{"node": n, "cursor": "c"})
			}
			return e
		}(),
		"pageInfo": object{"hasNextPage": false, "endCursor": "", "hasPreviousPage": false, "startCursor": ""},
	}
}

var empty = resolver(func(map[string]any) any { return connection(nil) })

func ownerObject() object {
	return object{"__typename": "Organization", "id": "O_acme", "login": owner, "name": "Acme"}
}

func repoObject() object {
	repo := object{
		"__typename": "Repository", "id": "R_widgets", "databaseId": 1, "name": name,
		"nameWithOwner": full, "owner": ownerObject(), "url": "https://github.com/" + full,
		"isPrivate": false, "isArchived": false, "isFork": false, "isInOrganization": true,
		"hasIssuesEnabled": true, "hasDiscussionsEnabled": false, "hasWikiEnabled": false,
		"viewerPermission": "WRITE", "parent": nil, "visibility": "PUBLIC",
		"defaultBranchRef":   object{"name": "main"},
		"mergeCommitAllowed": true, "squashMergeAllowed": true, "rebaseMergeAllowed": true,
		"viewerDefaultMergeMethod": "MERGE",
		"assignableUsers":          empty, "labels": resolver(func(map[string]any) any { return connection(labels()) }),
		"milestones": empty, "projects": empty, "projectsV2": empty, "mentionableUsers": empty,
		"suggestedActors": empty, "pullRequestTemplates": []object{}, "issueTemplates": []object{},
		"pullRequests": resolver(func(args map[string]any) any { return connection(pulls(args, true)) }),
		"issues":       resolver(func(args map[string]any) any { return connection(pulls(args, false)) }),
		"pullRequest":  resolver(func(args map[string]any) any { return byNumber(args, true) }),
		"issue":        resolver(func(args map[string]any) any { return byNumber(args, false) }),
		"issueOrPullRequest": resolver(func(args map[string]any) any {
			if o := byNumber(args, true); o != nil {
				return o
			}
			return byNumber(args, false)
		}),
	}
	return repo
}

func labels() []object {
	return []object{
		{"__typename": "Label", "id": "LA_bug", "name": "bug", "color": "d73a4a", "description": ""},
		{"__typename": "Label", "id": "LA_release", "name": "release", "color": "0e8a16", "description": ""},
	}
}

func labelNames(ids []string) []string {
	var out []string
	for _, id := range ids {
		out = append(out, strings.TrimPrefix(id, "LA_"))
	}
	return out
}

func issueObject(it *issue) object {
	kind, prefix, path := "Issue", "I_", "issues"
	if it.IsPR {
		kind, prefix, path = "PullRequest", "PR_", "pull"
	}
	var ls []object
	for _, l := range it.Labels {
		ls = append(ls, object{"__typename": "Label", "id": "LA_" + l, "name": l, "color": "ededed", "description": ""})
	}
	return object{
		"__typename": kind, "id": prefix + strconv.Itoa(it.Number), "number": it.Number,
		"title": it.Title, "body": it.Body, "state": it.State, "closed": it.State != "OPEN",
		"url":       fmt.Sprintf("https://github.com/%s/%s/%d", full, path, it.Number),
		"createdAt": it.CreatedAt, "updatedAt": it.CreatedAt,
		"author":      object{"__typename": "Bot", "login": "infrawrench-ci"},
		"headRefName": it.Head, "baseRefName": it.Base, "isDraft": it.Draft,
		"isCrossRepository": false, "headRepositoryOwner": ownerObject(),
		"headRepository": object{"id": "R_widgets", "name": name, "nameWithOwner": full},
		"repository":     object{"id": "R_widgets", "name": name, "nameWithOwner": full, "owner": ownerObject()},
		"labels":         connection(ls), "assignees": connection(nil), "projectCards": connection(nil),
		"projectItems": connection(nil), "milestone": nil, "comments": connection(nil),
		"reactionGroups": []object{}, "reviewRequests": connection(nil), "reviews": connection(nil),
		"stateReason": nil,
	}
}

func intArg(args map[string]any, k string) int {
	switch v := args[k].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		n, _ := strconv.Atoi(v)
		return n
	}
	return 0
}

func byNumber(args map[string]any, pr bool) any {
	if it, ok := store.issues[intArg(args, "number")]; ok && it.IsPR == pr {
		return issueObject(it)
	}
	return nil
}

func pulls(args map[string]any, pr bool) []object {
	states := map[string]bool{}
	if list, ok := args["states"].([]any); ok {
		for _, s := range list {
			states[fmt.Sprint(s)] = true
		}
	} else if s, ok := args["states"].(string); ok {
		states[s] = true
	}
	head, _ := args["headRefName"].(string)
	var out []object
	for n := store.next - 1; n >= 1; n-- {
		it := store.issues[n]
		if it == nil || it.IsPR != pr || (len(states) > 0 && !states[it.State]) || (head != "" && it.Head != head) {
			continue
		}
		out = append(out, issueObject(it))
	}
	return out
}

func queryRoot() object {
	return object{
		"repository": resolver(func(args map[string]any) any {
			if args["owner"] != owner || args["name"] != name {
				return fmt.Errorf("Could not resolve to a Repository with the name '%v/%v'.", args["owner"], args["name"])
			}
			return repoObject()
		}),
		"node":   resolver(func(args map[string]any) any { return nodeByID(fmt.Sprint(args["id"])) }),
		"viewer": object{"__typename": "Bot", "login": "infrawrench-ci[bot]"},
	}
}

func nodeByID(id string) any {
	for _, prefix := range []string{"PR_", "I_"} {
		if n, err := strconv.Atoi(strings.TrimPrefix(id, prefix)); err == nil && strings.HasPrefix(id, prefix) {
			if it, ok := store.issues[n]; ok {
				return issueObject(it)
			}
		}
	}
	if id == "R_widgets" {
		return repoObject()
	}
	return nil
}

func input(args map[string]any) map[string]any {
	in, _ := args["input"].(map[string]any)
	if in == nil {
		in = map[string]any{}
	}
	return in
}

func strs(v any) []string {
	var out []string
	if list, ok := v.([]any); ok {
		for _, x := range list {
			out = append(out, fmt.Sprint(x))
		}
	}
	return out
}

func target(in map[string]any, key string) (*issue, error) {
	id := fmt.Sprint(in[key])
	for _, prefix := range []string{"PR_", "I_"} {
		if strings.HasPrefix(id, prefix) {
			n, _ := strconv.Atoi(strings.TrimPrefix(id, prefix))
			if it, ok := store.issues[n]; ok {
				return it, nil
			}
		}
	}
	return nil, fmt.Errorf("Could not resolve to a node with the global id of '%s'", id)
}

func edit(it *issue, in map[string]any) {
	if t, ok := in["title"].(string); ok {
		it.Title = t
	}
	if b, ok := in["body"].(string); ok {
		it.Body = b
	}
	if b, ok := in["baseRefName"].(string); ok {
		it.Base = b
	}
	if _, ok := in["labelIds"]; ok {
		it.Labels = labelNames(strs(in["labelIds"]))
	}
}

func mutationRoot() object {
	create := func(pr bool) resolver {
		return func(args map[string]any) any {
			in := input(args)
			it := &issue{Number: store.next, State: "OPEN", IsPR: pr, CreatedAt: "2026-11-15T00:00:00Z"}
			store.next++
			if pr {
				it.Head, _ = in["headRefName"].(string)
				it.Base, _ = in["baseRefName"].(string)
				it.Draft, _ = in["draft"].(bool)
				if !branchExists(it.Head) {
					return fmt.Errorf("Head sha can't be blank, Base sha can't be blank, No commits between %s and %s, Head ref must be a branch", it.Base, it.Head)
				}
			}
			edit(it, in)
			store.issues[it.Number] = it
			fmt.Printf("  created #%d %q (pr %v, head %q, labels %v)\n", it.Number, it.Title, pr, it.Head, it.Labels)
			key := "issue"
			if pr {
				key = "pullRequest"
			}
			return object{key: issueObject(it), "clientMutationId": nil}
		}
	}
	update := func(key, field, state string) resolver {
		return func(args map[string]any) any {
			in := input(args)
			it, err := target(in, field)
			if err != nil {
				return err
			}
			edit(it, in)
			if s, ok := in["state"].(string); ok {
				it.State = s
			}
			if state != "" {
				it.State = state
			}
			fmt.Printf("  %s #%d: %q %s %v\n", key, it.Number, it.Title, it.State, it.Labels)
			return object{key: issueObject(it), "clientMutationId": nil}
		}
	}
	return object{
		"createPullRequest": create(true),
		"createIssue":       create(false),
		"updatePullRequest": update("pullRequest", "pullRequestId", ""),
		"updateIssue":       update("issue", "id", ""),
		"closeIssue":        update("issue", "issueId", "CLOSED"),
		"reopenIssue":       update("issue", "issueId", "OPEN"),
		"closePullRequest":  update("pullRequest", "pullRequestId", "CLOSED"),
		"addLabelsToLabelable": resolver(func(args map[string]any) any {
			in := input(args)
			it, err := target(in, "labelableId")
			if err != nil {
				return err
			}
			it.Labels = append(it.Labels, labelNames(strs(in["labelIds"]))...)
			fmt.Printf("  labels #%d: %v\n", it.Number, it.Labels)
			return object{"clientMutationId": nil, "labelable": issueObject(it)}
		}),
		"removeLabelsFromLabelable": resolver(func(args map[string]any) any {
			in := input(args)
			it, err := target(in, "labelableId")
			if err != nil {
				return err
			}
			drop := map[string]bool{}
			for _, l := range labelNames(strs(in["labelIds"])) {
				drop[l] = true
			}
			var keep []string
			for _, l := range it.Labels {
				if !drop[l] {
					keep = append(keep, l)
				}
			}
			it.Labels = keep
			return object{"clientMutationId": nil, "labelable": issueObject(it)}
		}),
	}
}

// branchExists: a pull request's head must have been pushed, as on GitHub.
func branchExists(branch string) bool {
	dir := filepath.Join(gitRoot, full+".git")
	_, err := runGit(nil, nil, "--git-dir", dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	return err == nil
}
