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
	// explanation for a 403 on a route closed to API keys.
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

// apiKeyDeniedHint explains a 403 that is about the *kind* of credential rather
// than its scopes, which is the one authorization failure the server's message
// alone does not let you act on.
//
// The org tree accepts `iwk_` API keys, but a short deny-list closes a few
// paths to them whatever scopes they hold — minting credentials and granting
// authority to other principals are acts a person performs, and a key that can
// mint a longer-lived key outlives its own revocation. Two of this provider's
// resources sit behind that list, so a practitioner running Terraform with an
// API key meets it as a 403 on a resource that works perfectly well for a
// signed-in user.
const apiKeyDeniedHint = "The configured api_key starts with \"iwk_\", and this route is " +
	"closed to API keys whatever scopes they hold. infrawrench_api_key is closed entirely " +
	"(a key that can mint keys can outlive its own revocation) and infrawrench_role is " +
	"closed to writes (a key should not manufacture authority for other principals); both " +
	"remain readable. Manage those two from the web UI, or run the provider with a WorkOS " +
	"access token."

// apiKeyUnauthorizedHint covers the 401 case. An API key reaching this is a
// key problem — revoked, expired, past its hash sunset, or aimed at an org its
// owner has left — rather than the categorical rejection it used to be.
const apiKeyUnauthorizedHint = "The configured api_key starts with \"iwk_\". The org-scoped " +
	"API does accept API keys, so a 401 here means the key itself was refused: revoked, " +
	"expired, past its legacy-hash sunset, or owned by somebody who is no longer a member of " +
	"this organization. Check it on Settings → API keys."

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

	if c.TokenIsAPIKey() {
		switch status {
		case http.StatusUnauthorized:
			apiErr.Hint = apiKeyUnauthorizedHint
		case http.StatusForbidden:
			// Only when the server said this is about the credential's kind. A
			// plain scope failure is already self-explanatory, and pasting the
			// deny-list under it would send somebody looking for the wrong
			// cause.
			if strings.Contains(apiErr.Message, "API key") {
				apiErr.Hint = apiKeyDeniedHint
			}
		}
	}

	return apiErr
}
