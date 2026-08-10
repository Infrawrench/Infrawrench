// Package iw is the provider's HTTP client and the single source of truth for
// the wire shapes of Infrawrench's org-scoped configuration API.
//
// Nothing in internal/provider builds a request URL or a JSON body by hand:
// every call goes through Client, and every payload is one of the structs in
// wire.go. That is the whole point of the split — the Terraform schemas can
// drift from the API in exactly one file, and wire_spec_test.go checks that
// file against the checked-in OpenAPI document.
package iw

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// UserAgent identifies the provider to the server. The version is stamped by
// main.go at build time.
var UserAgent = "terraform-provider-infrawrench/dev"

// Client talks to one organization's slice of the Infrawrench API.
//
// Every path passed to the request helpers is relative to the org root, so
// callers write "/budgets" and never repeat the org id. That keeps the org out
// of every resource implementation and means a mis-scoped key fails in one
// place rather than eleven.
type Client struct {
	baseURL *url.URL
	token   string
	orgID   string
	http    *http.Client
}

// Config is what the provider block resolves to.
type Config struct {
	// BaseURL is the Infrawrench installation root, e.g.
	// "https://app.infrawrench.com" — not including /api.
	BaseURL string
	// Token is an Infrawrench API key ("iwk_…") or a WorkOS access token.
	Token string
	// OrgID is the WorkOS organization id ("org_…").
	OrgID string
	// HTTPClient is optional; tests inject one.
	HTTPClient *http.Client
}

// NewClient validates the configuration and returns a ready client.
func NewClient(cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.BaseURL) == "" {
		return nil, fmt.Errorf("base_url is required")
	}
	if strings.TrimSpace(cfg.Token) == "" {
		return nil, fmt.Errorf("api_key is required")
	}
	if strings.TrimSpace(cfg.OrgID) == "" {
		return nil, fmt.Errorf("organization_id is required")
	}
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/"))
	if err != nil {
		return nil, fmt.Errorf("base_url is not a valid URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("base_url must be http or https, got %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("base_url must include a host")
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	return &Client{
		baseURL: parsed,
		token:   strings.TrimSpace(cfg.Token),
		orgID:   strings.TrimSpace(cfg.OrgID),
		http:    httpClient,
	}, nil
}

// OrgID is the organization every request is scoped to.
func (c *Client) OrgID() string { return c.orgID }

// TokenIsAPIKey reports whether the configured token is an Infrawrench API key
// rather than a WorkOS access token. Used to attach the actionable hint on a
// 401 — see APIError.Hint.
func (c *Client) TokenIsAPIKey() bool { return strings.HasPrefix(c.token, "iwk_") }

// URLFor renders the absolute URL for an org-relative path, for diagnostics.
func (c *Client) URLFor(path string) string {
	return c.baseURL.String() + "/api/org/" + url.PathEscape(c.orgID) + path
}

// Get decodes GET path into out.
func (c *Client) Get(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodGet, path, nil, out)
}

// Post sends body as JSON and decodes the response into out. out may be nil.
func (c *Client) Post(ctx context.Context, path string, body, out any) error {
	return c.do(ctx, http.MethodPost, path, body, out)
}

// Put sends body as JSON and decodes the response into out. out may be nil.
//
// Every write in this API is a PUT full-replace; there is no PATCH anywhere on
// the configuration surface, which is why the wire structs below are explicit
// about which fields are omitted versus sent as null.
func (c *Client) Put(ctx context.Context, path string, body, out any) error {
	return c.do(ctx, http.MethodPut, path, body, out)
}

// Delete issues DELETE path. A 404 is returned as an APIError the caller can
// test with IsNotFound.
func (c *Client) Delete(ctx context.Context, path string) error {
	return c.do(ctx, http.MethodDelete, path, nil, nil)
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encoding request body: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.URLFor(path), reader)
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", UserAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("%s %s: reading response: %w", method, path, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return c.newAPIError(method, path, resp.StatusCode, payload)
	}

	if out == nil || len(bytes.TrimSpace(payload)) == 0 {
		return nil
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("%s %s: decoding response: %w", method, path, err)
	}
	return nil
}
