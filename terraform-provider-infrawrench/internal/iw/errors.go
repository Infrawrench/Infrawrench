package iw

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// APIError is a non-2xx response, decoded as far as the server's error
// envelope allows.
//
// The server answers errors as `{"error": "..."}`, sometimes with extra keys —
// `referents` on a 409 delete-while-referenced, `queryError` on a malformed
// cost query. Those extras are what make a diagnostic actionable, so they are
// carried through rather than flattened into the message.
type APIError struct {
	Method     string
	Path       string
	StatusCode int
	Message    string
	// Referents is populated on the 409 returned when deleting a saved filter
	// or scenario model that something still points at.
	Referents []Referent
	// QueryError is populated on a 400 from a malformed cost query string.
	QueryError *QueryError
	// Body is the raw response, for the cases the envelope did not cover.
	Body string
	// Hint is provider-side advice appended to the diagnostic, e.g. the
	// API-key auth caveat on a 401.
	Hint string
}

// Referent is one object blocking a delete.
type Referent struct {
	Kind          string `json:"kind"`
	ID            string `json:"id"`
	Name          string `json:"name"`
	DashboardID   string `json:"dashboardId,omitempty"`
	DashboardName string `json:"dashboardName,omitempty"`
}

// QueryError locates a syntax error in a cost query string.
type QueryError struct {
	Offset   int      `json:"offset"`
	Length   int      `json:"length"`
	Expected []string `json:"expected"`
}

func (e *APIError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s: HTTP %d", e.Method, e.Path, e.StatusCode)
	if e.Message != "" {
		fmt.Fprintf(&b, ": %s", e.Message)
	}
	if len(e.Referents) > 0 {
		names := make([]string, 0, len(e.Referents))
		for _, r := range e.Referents {
			names = append(names, fmt.Sprintf("%s %q", r.Kind, r.Name))
		}
		fmt.Fprintf(&b, " (still referenced by: %s)", strings.Join(names, ", "))
	}
	if e.QueryError != nil {
		fmt.Fprintf(&b, " (query offset %d", e.QueryError.Offset)
		if len(e.QueryError.Expected) > 0 {
			fmt.Fprintf(&b, ", expected %s", strings.Join(e.QueryError.Expected, " | "))
		}
		b.WriteString(")")
	}
	if e.Hint != "" {
		fmt.Fprintf(&b, "\n\n%s", e.Hint)
	}
	return b.String()
}

// IsNotFound reports whether err is a 404.
//
// Every Read in this provider funnels deletions-outside-Terraform through this
// so they land as "needs recreating" rather than as an error.
func IsNotFound(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == http.StatusNotFound
	}
	return false
}

// IsConflict reports whether err is a 409 — a name collision, or a delete
// refused because something still references the object.
func IsConflict(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == http.StatusConflict
	}
	return false
}

// AsAPIError unwraps err to an *APIError, if it is one.
func AsAPIError(err error) (*APIError, bool) {
	var apiErr *APIError
	ok := errors.As(err, &apiErr)
	return apiErr, ok
}

// apiKeyAuthHint explains the one failure mode a user cannot debug from the
// error text alone: Infrawrench API keys are rejected by the org-scoped API
// tree, which authenticates Bearer tokens as WorkOS access tokens only. A key
// that is valid everywhere else still 401s here.
const apiKeyAuthHint = "The configured api_key starts with \"iwk_\". The org-scoped " +
	"Infrawrench API (/api/org/{org_id}/…) currently authenticates Bearer tokens as WorkOS " +
	"access tokens, so an Infrawrench API key is rejected with 401 on these routes even when " +
	"the key is valid and correctly scoped. Until the server accepts API keys on this tree, " +
	"configure the provider with a WorkOS access token instead."

func (c *Client) newAPIError(method, path string, status int, payload []byte) error {
	apiErr := &APIError{
		Method:     method,
		Path:       path,
		StatusCode: status,
		Body:       strings.TrimSpace(string(payload)),
	}

	var envelope struct {
		Error      string      `json:"error"`
		Message    string      `json:"message"`
		Referents  []Referent  `json:"referents"`
		QueryError *QueryError `json:"queryError"`
	}
	if err := json.Unmarshal(payload, &envelope); err == nil {
		apiErr.Message = envelope.Error
		if apiErr.Message == "" {
			apiErr.Message = envelope.Message
		}
		apiErr.Referents = envelope.Referents
		apiErr.QueryError = envelope.QueryError
	}
	if apiErr.Message == "" {
		apiErr.Message = http.StatusText(status)
	}

	if status == http.StatusUnauthorized && c.TokenIsAPIKey() {
		apiErr.Hint = apiKeyAuthHint
	}

	return apiErr
}
