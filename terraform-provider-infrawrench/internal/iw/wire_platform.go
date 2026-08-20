package iw

import (
	"encoding/json"
	"fmt"
)

// Wire shapes for the configuration surfaces outside cost management:
// monitoring, lifecycle governance, access control and alert delivery.
//
// The two conventions from wire.go hold here unchanged — an omitempty pointer
// means "omitted clears it", a pointer without omitempty marshals nil as an
// explicit null because the server distinguishes the two. What is new in this
// file is a third shape the cost surface never had: several of these routes are
// genuine PATCHes rather than full replaces, and a few accept a *different*
// body on create than on update. Where that is true there are two structs, not
// one with optional fields, so it is impossible to send a create-only key to an
// update route that rejects unknown properties.

/* --------------------------------- probes --------------------------------- */

// SyntheticProbeCreate is the POST body.
//
// ResourceID and OutputKey exist only here: they record which resource output
// suggested the URL, and the update route rejects them outright, which is why
// probes have two input structs rather than one.
type SyntheticProbeCreate struct {
	Name             string  `json:"name"`
	URL              string  `json:"url"`
	Method           *string `json:"method,omitempty"`
	IntervalSeconds  *int64  `json:"intervalSeconds,omitempty"`
	TimeoutMs        *int64  `json:"timeoutMs,omitempty"`
	FailureThreshold *int64  `json:"failureThreshold,omitempty"`
	Enabled          *bool   `json:"enabled,omitempty"`
	ResourceID       *string `json:"resourceId,omitempty"`
	OutputKey        *string `json:"outputKey,omitempty"`
}

// SyntheticProbeUpdate is the PUT body. Everything is optional and omission
// leaves the stored value alone, so the provider always sends the full set.
type SyntheticProbeUpdate struct {
	Name             *string `json:"name,omitempty"`
	URL              *string `json:"url,omitempty"`
	Method           *string `json:"method,omitempty"`
	IntervalSeconds  *int64  `json:"intervalSeconds,omitempty"`
	TimeoutMs        *int64  `json:"timeoutMs,omitempty"`
	FailureThreshold *int64  `json:"failureThreshold,omitempty"`
	Enabled          *bool   `json:"enabled,omitempty"`
}

// SyntheticProbe is an HTTP check run from the edge. Everything from Status
// down is the probe's live state rather than its configuration.
type SyntheticProbe struct {
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	URL              string  `json:"url"`
	Method           string  `json:"method"`
	IntervalSeconds  int64   `json:"intervalSeconds"`
	TimeoutMs        int64   `json:"timeoutMs"`
	FailureThreshold int64   `json:"failureThreshold"`
	Enabled          bool    `json:"enabled"`
	AccountID        *string `json:"accountId"`
	ResourceID       *string `json:"resourceId"`
	PluginID         *string `json:"pluginId"`
	ResourceTypeID   *string `json:"resourceTypeId"`
	OutputKey        *string `json:"outputKey"`

	Status              string   `json:"status"`
	ConsecutiveFailures int64    `json:"consecutiveFailures"`
	LastProbeAt         *string  `json:"lastProbeAt"`
	LastStatusCode      *int64   `json:"lastStatusCode"`
	LastLatencyMs       *int64   `json:"lastLatencyMs"`
	LastError           *string  `json:"lastError"`
	LastStateChangeAt   *string  `json:"lastStateChangeAt"`
	Uptime24h           *float64 `json:"uptime24h"`
	CreatedAt           string   `json:"createdAt"`
	UpdatedAt           string   `json:"updatedAt"`
}

/* ------------------------------ metric alerts ------------------------------ */

// MetricAlertRuleInput is the POST/PUT body.
//
// The five selector fields are explicit nulls rather than omissions: every one
// of them is required by the schema, and null is what "match anything" means.
// A rule selects resources by query and never by id, so it covers resources
// created after it.
type MetricAlertRuleInput struct {
	Name            string  `json:"name"`
	PluginID        *string `json:"pluginId"`
	ResourceTypeID  *string `json:"resourceTypeId"`
	TagKey          *string `json:"tagKey"`
	TagValue        *string `json:"tagValue"`
	MetricKey       string  `json:"metricKey"`
	Comparator      string  `json:"comparator"`
	Threshold       float64 `json:"threshold"`
	ForMinutes      int64   `json:"forMinutes"`
	CooldownMinutes int64   `json:"cooldownMinutes"`
	Enabled         bool    `json:"enabled"`
}

// MetricAlertRule is a stored threshold rule. FiringCount and
// MatchingResourceCount are present on the list route only.
type MetricAlertRule struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	PluginID        *string `json:"pluginId"`
	ResourceTypeID  *string `json:"resourceTypeId"`
	TagKey          *string `json:"tagKey"`
	TagValue        *string `json:"tagValue"`
	MetricKey       string  `json:"metricKey"`
	Comparator      string  `json:"comparator"`
	Threshold       float64 `json:"threshold"`
	ForMinutes      int64   `json:"forMinutes"`
	CooldownMinutes int64   `json:"cooldownMinutes"`
	Enabled         bool    `json:"enabled"`
	LastEvalAt      *string `json:"lastEvalAt"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`

	FiringCount           *int64 `json:"firingCount,omitempty"`
	MatchingResourceCount *int64 `json:"matchingResourceCount,omitempty"`
}

/* ------------------------------- status pages ------------------------------ */

// StatusPageComponentInput is one probe placed on a public page. Order in the
// list is the public render order, which is why the provider sends the whole
// set on every write.
type StatusPageComponentInput struct {
	ProbeID   string  `json:"probeId"`
	Label     *string `json:"label"`
	GroupName *string `json:"groupName"`
}

// StatusPageComponent is a placed probe as read back, with the probe's own
// name and live status joined in.
type StatusPageComponent struct {
	ID           string  `json:"id"`
	ProbeID      string  `json:"probeId"`
	Label        *string `json:"label"`
	GroupName    *string `json:"groupName"`
	Position     int64   `json:"position"`
	ProbeName    string  `json:"probeName"`
	ProbeStatus  string  `json:"probeStatus"`
	ProbeEnabled bool    `json:"probeEnabled"`
}

// StatusPageInput is both the POST body and the PUT body. The PUT is a patch —
// an absent key is left alone, and an absent components list leaves the whole
// set alone — so the provider always sends every field.
type StatusPageInput struct {
	Title       string                     `json:"title"`
	Description *string                    `json:"description"`
	Published   bool                       `json:"published"`
	ShowHistory bool                       `json:"showHistory"`
	ShowUptime  bool                       `json:"showUptime"`
	SupportURL  *string                    `json:"supportUrl"`
	Components  []StatusPageComponentInput `json:"components"`
}

// StatusPage is a public uptime page.
//
// Slug is server-minted with real entropy rather than derived from the title,
// and it is the page's only access credential — anyone holding the URL can read
// it. Rotating it is an explicit action on the API, deliberately not something
// a Terraform plan can do by accident.
type StatusPage struct {
	ID          string                `json:"id"`
	Slug        string                `json:"slug"`
	Title       string                `json:"title"`
	Description *string               `json:"description"`
	Published   bool                  `json:"published"`
	ShowHistory bool                  `json:"showHistory"`
	ShowUptime  bool                  `json:"showUptime"`
	SupportURL  *string               `json:"supportUrl"`
	Components  []StatusPageComponent `json:"components"`
	CreatedAt   string                `json:"createdAt"`
	UpdatedAt   string                `json:"updatedAt"`
}

/* ----------------------------- sleep schedules ----------------------------- */

// SleepScheduleCreate is the POST body. The resource and account are fixed at
// creation — the update route does not carry them — so changing either one
// replaces the schedule.
type SleepScheduleCreate struct {
	ResourceID string  `json:"resourceId"`
	AccountID  string  `json:"accountId"`
	DaysOfWeek []int64 `json:"daysOfWeek"`
	StopTime   string  `json:"stopTime"`
	StartTime  string  `json:"startTime"`
	Timezone   string  `json:"timezone"`
}

// SleepScheduleUpdate is the PUT body.
type SleepScheduleUpdate struct {
	DaysOfWeek []int64 `json:"daysOfWeek,omitempty"`
	StopTime   *string `json:"stopTime,omitempty"`
	StartTime  *string `json:"startTime,omitempty"`
	Timezone   *string `json:"timezone,omitempty"`
	Paused     *bool   `json:"paused,omitempty"`
}

// SleepSchedule powers one resource off outside working hours and back on
// inside them. DaysOfWeek names the days it is *worked on*, so the resource is
// stopped at StopTime on those days and started at StartTime.
type SleepSchedule struct {
	ID             string  `json:"id"`
	ResourceID     string  `json:"resourceId"`
	AccountID      string  `json:"accountId"`
	PluginID       string  `json:"pluginId"`
	ResourceTypeID string  `json:"resourceTypeId"`
	ResourceName   string  `json:"resourceName"`
	AccountName    string  `json:"accountName"`
	DaysOfWeek     []int64 `json:"daysOfWeek"`
	StopTime       string  `json:"stopTime"`
	StartTime      string  `json:"startTime"`
	Timezone       string  `json:"timezone"`
	Paused         bool    `json:"paused"`

	NextTransitionAt       *string  `json:"nextTransitionAt"`
	NextTransitionAction   *string  `json:"nextTransitionAction"`
	LastRunAt              *string  `json:"lastRunAt"`
	LastRunAction          *string  `json:"lastRunAction"`
	LastRunStatus          *string  `json:"lastRunStatus"`
	LastRunError           *string  `json:"lastRunError"`
	ProjectedMonthlySaving *float64 `json:"projectedMonthlySaving"`
	Currency               *string  `json:"currency"`
	CreatedAt              string   `json:"createdAt"`
	UpdatedAt              string   `json:"updatedAt"`
}

/* ------------------------------ change freezes ----------------------------- */

// ChangeFreezeInput is the POST/PUT body.
//
// StartsAt is an omitempty pointer with an asymmetric server rule worth knowing:
// on create an absent start means "now", and on *update* an absent start leaves
// the stored one alone — while an absent Reason or EndsAt clears them. That is
// why the Terraform attribute is Optional and Computed rather than merely
// Optional.
type ChangeFreezeInput struct {
	Name     string  `json:"name"`
	Reason   *string `json:"reason,omitempty"`
	StartsAt *string `json:"startsAt,omitempty"`
	EndsAt   *string `json:"endsAt,omitempty"`
}

// ChangeFreeze is a window during which writes to cloud resources are refused.
// Active is state rather than configuration: ending a freeze early is an action
// on the API, not an edit.
type ChangeFreeze struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Reason          *string `json:"reason"`
	StartsAt        string  `json:"startsAt"`
	EndsAt          *string `json:"endsAt"`
	Active          bool    `json:"active"`
	CreatedByUserID *string `json:"createdByUserId"`
	EndedByUserID   *string `json:"endedByUserId"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

/* ------------------------------ custom graphs ------------------------------ */

// CustomGraphInput is the POST/PUT body. Source is the graph's TypeScript,
// which is what makes this resource worth having: the code lives in the repo
// beside the Terraform that registers it, and `file()` keeps it there.
type CustomGraphInput struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Source      *string `json:"source,omitempty"`
}

// CustomGraph is a stored code-defined graph.
type CustomGraph struct {
	ID                 string  `json:"id"`
	OrganizationID     string  `json:"organizationId"`
	Name               string  `json:"name"`
	Description        *string `json:"description"`
	Source             string  `json:"source"`
	CreatedByUserID    *string `json:"createdByUserId"`
	SourceAuthorUserID *string `json:"sourceAuthorUserId"`
	DeletedAt          *string `json:"deletedAt"`
	CreatedAt          string  `json:"createdAt"`
	UpdatedAt          string  `json:"updatedAt"`
}

/* --------------------------- log workspace queries ------------------------- */

// LogStreamSelector names one stream a saved query tails.
type LogStreamSelector struct {
	ResourceID       string  `json:"resourceId"`
	AccountID        string  `json:"accountId"`
	PluginID         string  `json:"pluginId"`
	ResourceTypeID   string  `json:"resourceTypeId"`
	ParentResourceID *string `json:"parentResourceId,omitempty"`
	Container        *string `json:"container,omitempty"`
}

// LogWorkspaceQueryInput is the POST/PUT body.
type LogWorkspaceQueryInput struct {
	Name         string              `json:"name"`
	Resources    []LogStreamSelector `json:"resources"`
	Search       string              `json:"search"`
	AlertEnabled *bool               `json:"alertEnabled,omitempty"`
}

// LogWorkspaceQuery is a saved multi-resource tail, optionally evaluated by the
// poller so a matching line raises an alert.
type LogWorkspaceQuery struct {
	ID              string              `json:"id"`
	Name            string              `json:"name"`
	Resources       []LogStreamSelector `json:"resources"`
	Search          string              `json:"search"`
	AlertEnabled    bool                `json:"alertEnabled"`
	LastEvalAt      *string             `json:"lastEvalAt"`
	LastMatchAt     *string             `json:"lastMatchAt"`
	LastAlertedAt   *string             `json:"lastAlertedAt"`
	LastEvalError   *string             `json:"lastEvalError"`
	LastMatchSample *string             `json:"lastMatchSample"`
	CreatedAt       string              `json:"createdAt"`
	UpdatedAt       string              `json:"updatedAt"`
}

/* ---------------------------------- roles ---------------------------------- */

// RoleInput is the POST body and, because every field is optional on PATCH and
// the provider always sends all three, the PATCH body too.
type RoleInput struct {
	Name        string   `json:"name"`
	Description *string  `json:"description"`
	Permissions []string `json:"permissions"`
}

// Role is a custom permission set members can be assigned.
//
// IsSystem marks the built-in roles. They are readable but not editable, and
// the provider refuses to adopt one rather than planning an update the API will
// reject.
type Role struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description *string  `json:"description"`
	IsSystem    bool     `json:"isSystem"`
	SystemKey   *string  `json:"systemKey"`
	Permissions []string `json:"permissions"`
}

/* --------------------------------- ssh keys -------------------------------- */

// GenerateSSHKeyRequest asks the server to mint a key pair.
type GenerateSSHKeyRequest struct {
	Name string `json:"name"`
}

// ImportSSHKeyRequest registers a public key the caller already holds.
type ImportSSHKeyRequest struct {
	Name      string `json:"name"`
	PublicKey string `json:"publicKey"`
}

// GeneratedSSHKey is the create response. PrivateKey is returned exactly once
// and never stored in plaintext, so it exists nowhere but the Terraform state
// file after an apply.
type GeneratedSSHKey struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	KeyType     string  `json:"keyType"`
	Fingerprint string  `json:"fingerprint"`
	PublicKey   string  `json:"publicKey"`
	PrivateKey  *string `json:"privateKey,omitempty"`
	IsImported  *bool   `json:"isImported,omitempty"`
}

// SSHKey is a registered key as the listing returns it.
type SSHKey struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	KeyType     string  `json:"keyType"`
	IsImported  bool    `json:"isImported"`
	Fingerprint *string `json:"fingerprint"`
	PublicKey   string  `json:"publicKey"`
	UserID      string  `json:"userId"`
	OwnerEmail  string  `json:"ownerEmail"`
	OwnerName   string  `json:"ownerName"`
	CreatedAt   string  `json:"createdAt"`
}

/* --------------------------------- bastions -------------------------------- */

// CreateBastionRequest is the POST body.
type CreateBastionRequest struct {
	Name string `json:"name"`
}

// CreatedBastion carries the enrollment token, which is returned once and is
// not recoverable afterwards.
type CreatedBastion struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	TokenPrefix string `json:"tokenPrefix"`
	Token       string `json:"token"`
}

// Bastion is an enrolled agent that proxies cloud API traffic from inside a
// private network.
type Bastion struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	TokenPrefix     string  `json:"tokenPrefix"`
	AgentVersion    *string `json:"agentVersion"`
	LastSeenAt      *string `json:"lastSeenAt"`
	Status          string  `json:"status"`
	RevokedAt       *string `json:"revokedAt"`
	CreatedAt       string  `json:"createdAt"`
	CreatedByUserID string  `json:"createdByUserId"`
	Connected       bool    `json:"connected"`
	AccountCount    int64   `json:"accountCount"`
}

/* --------------------------------- api keys -------------------------------- */

// CreateAPIKeyRequest is the POST body.
type CreateAPIKeyRequest struct {
	Name      string   `json:"name"`
	Scopes    []string `json:"scopes"`
	ExpiresAt *string  `json:"expiresAt,omitempty"`
}

// CreatedAPIKey carries the plaintext key, returned exactly once.
type CreatedAPIKey struct {
	ID  string `json:"id"`
	Key string `json:"key"`
}

// APIKey is a key row.
//
// RevokedAt is the field that matters to the provider: revoking is how a key is
// deleted, and the listing keeps returning revoked rows. A revoked key is gone
// as far as Terraform is concerned, and the endpoint wrapper treats it as a 404.
type APIKey struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Prefix             string   `json:"prefix"`
	Scopes             []string `json:"scopes"`
	LastUsedAt         *string  `json:"lastUsedAt"`
	ExpiresAt          *string  `json:"expiresAt"`
	RevokedAt          *string  `json:"revokedAt"`
	LegacyHashSunsetAt *string  `json:"legacyHashSunsetAt"`
	NeedsRotation      bool     `json:"needsRotation"`
	CreatedAt          string   `json:"createdAt"`
}

/* ------------------------------- ssh snippets ------------------------------ */

// SSHSnippetInput is the POST/PUT body.
type SSHSnippetInput struct {
	Name        string  `json:"name"`
	Command     string  `json:"command"`
	Description *string `json:"description,omitempty"`
}

// SSHSnippet is a saved command the fan-out runner offers across hosts.
type SSHSnippet struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Command     string  `json:"command"`
	Description *string `json:"description"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

/* --------------------------------- accounts -------------------------------- */

// CreateAccountRequest is the POST body. Credentials are write-only: no route
// returns them, so the provider cannot detect drift on their values.
type CreateAccountRequest struct {
	PluginID    string            `json:"pluginId"`
	DisplayName string            `json:"displayName"`
	Credentials map[string]string `json:"credentials"`
	BastionID   *string           `json:"bastionId,omitempty"`
}

// CreatedAccount is the POST response. SyncError is advisory: the account was
// created either way, and a first sync that failed is a warning rather than a
// reason to have no account row.
type CreatedAccount struct {
	ID        string `json:"id"`
	SyncError *struct {
		Message string `json:"message"`
	} `json:"syncError,omitempty"`
}

// UpdateAccountRequest is the PATCH body.
//
// BastionID has no omitempty and is deliberately tri-state on the wire: the
// server reads an absent key as "leave the binding alone" and an explicit null
// as "unbind". Terraform always sends the whole configuration, so a null
// attribute has to reach the server as a null.
type UpdateAccountRequest struct {
	DisplayName *string `json:"displayName,omitempty"`
	BastionID   *string `json:"bastionId"`
}

// AccountCredentialsInput is the PUT body for rotating stored credentials.
type AccountCredentialsInput struct {
	Credentials map[string]string `json:"credentials"`
}

/* ----------------------------- managed accounts ---------------------------- */

// ManagedAccountInput is the POST/PUT body for a customer an MSP bills.
type ManagedAccountInput struct {
	Name              string   `json:"name"`
	ContactName       *string  `json:"contactName"`
	ContactEmail      *string  `json:"contactEmail"`
	BillingAddress    *string  `json:"billingAddress"`
	BillingCurrency   string   `json:"billingCurrency"`
	CostBasis         *string  `json:"costBasis,omitempty"`
	ApplyBillingRules *bool    `json:"applyBillingRules,omitempty"`
	Notes             *string  `json:"notes"`
	CostCentreIDs     []string `json:"costCentreIds"`
	AccountIDs        []string `json:"accountIds"`
}

// ManagedAccount is a billed customer. A cost centre or cloud account belongs
// to at most one of them; claiming one twice is a 409 naming the other customer.
type ManagedAccount struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	ContactName       *string  `json:"contactName"`
	ContactEmail      *string  `json:"contactEmail"`
	BillingAddress    *string  `json:"billingAddress"`
	BillingCurrency   string   `json:"billingCurrency"`
	CostBasis         string   `json:"costBasis"`
	ApplyBillingRules bool     `json:"applyBillingRules"`
	Notes             *string  `json:"notes"`
	CostCentreIDs     []string `json:"costCentreIds"`
	AccountIDs        []string `json:"accountIds"`
	InvoiceCount      int64    `json:"invoiceCount"`
	CreatedByUserID   *string  `json:"createdByUserId"`
	CreatedAt         string   `json:"createdAt"`
	UpdatedAt         string   `json:"updatedAt"`
}

/* ----------------------------- deploy triggers ----------------------------- */

// DeployTriggerInput is the POST body. Answers are the deploy questionnaire's
// stored responses, keyed by question id.
type DeployTriggerInput struct {
	Repo    string            `json:"repo"`
	Branch  string            `json:"branch"`
	Env     string            `json:"env"`
	Answers map[string]string `json:"answers,omitempty"`
}

// DeployTrigger redeploys a repo when its branch moves. The only mutable field
// is Enabled — repo, branch and env are fixed at creation.
type DeployTrigger struct {
	ID        string  `json:"id"`
	Repo      string  `json:"repo"`
	Branch    string  `json:"branch"`
	Env       string  `json:"env"`
	Enabled   bool    `json:"enabled"`
	LastSha   *string `json:"lastSha"`
	LastRunAt *string `json:"lastRunAt"`
}

// DeployTriggerEnabled is the PATCH body — the whole mutable surface.
type DeployTriggerEnabled struct {
	Enabled bool `json:"enabled"`
}

/* ------------------------------ slack / teams ------------------------------ */

// SlackChannelCreate is the POST body.
type SlackChannelCreate struct {
	InstallationID string `json:"installationId"`
	ChannelID      string `json:"channelId"`
	ChannelName    string `json:"channelName"`
	IsPrivate      *bool  `json:"isPrivate,omitempty"`
}

// SlackChannelUpdate is the PATCH body — the display name is the only thing an
// edit can change; rebinding to another channel replaces the row.
type SlackChannelUpdate struct {
	ChannelName string `json:"channelName"`
}

// SlackChannel is a registered delivery target.
type SlackChannel struct {
	ID             string `json:"id"`
	InstallationID string `json:"installationId"`
	ChannelID      string `json:"channelId"`
	ChannelName    string `json:"channelName"`
	IsPrivate      bool   `json:"isPrivate"`
}

// SlackInstallation is one connected Slack workspace. Installations are created
// by the OAuth flow, never by this provider — a channel references one by id.
type SlackInstallation struct {
	ID       string  `json:"id"`
	TeamID   string  `json:"teamId"`
	TeamName *string `json:"teamName"`
}

// SlackStatus is the whole Slack picture in one response. There is no separate
// listing route for channels or installations, so both come from here.
type SlackStatus struct {
	Configured    bool                `json:"configured"`
	Installations []SlackInstallation `json:"installations"`
	Channels      []SlackChannel      `json:"channels"`
}

// MSTeamsWebhookCreate is the POST body. URL is write-only.
type MSTeamsWebhookCreate struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

// MSTeamsWebhookUpdate is the PATCH body.
type MSTeamsWebhookUpdate struct {
	Label string `json:"label"`
}

// MSTeamsWebhook is a registered Teams delivery target. URLHint is the server's
// redacted echo of the stored URL; the URL itself is never returned, so the
// provider cannot detect drift on it.
type MSTeamsWebhook struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	URLHint string `json:"urlHint"`
}

/* ---------------------------- delivery settings ---------------------------- */

// DigestSettingsUpdate is the PUT body for the weekly digest schedule.
type DigestSettingsUpdate struct {
	Enabled          *bool   `json:"enabled,omitempty"`
	Timezone         *string `json:"timezone,omitempty"`
	SendDay          *int64  `json:"sendDay,omitempty"`
	SendHour         *int64  `json:"sendHour,omitempty"`
	NarrativeEnabled *bool   `json:"narrativeEnabled,omitempty"`
}

// DigestSettings is the org singleton. Where the digest goes is not configured
// here: the destinations are whichever Slack channels and Teams webhooks have
// the weeklyDigest trigger routed to them, plus the email recipients below.
type DigestSettings struct {
	Enabled            bool    `json:"enabled"`
	Timezone           string  `json:"timezone"`
	SendDay            int64   `json:"sendDay"`
	SendHour           int64   `json:"sendHour"`
	NarrativeEnabled   bool    `json:"narrativeEnabled"`
	NarrativeAvailable bool    `json:"narrativeAvailable"`
	EmailAvailable     bool    `json:"emailAvailable"`
	LastSentWeekStart  *string `json:"lastSentWeekStart"`
	LastSentAt         *string `json:"lastSentAt"`
	AttemptCount       int64   `json:"attemptCount"`
	LastAttemptAt      *string `json:"lastAttemptAt"`
	LastStatus         *string `json:"lastStatus"`
	LastError          *string `json:"lastError"`
	NextAttemptAt      *string `json:"nextAttemptAt"`
}

// DigestRecipientInput is the POST body.
type DigestRecipientInput struct {
	Email string `json:"email"`
}

// DigestRecipient is one email address the digest is sent to.
type DigestRecipient struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

/* ------------------------------ alert routing ------------------------------ */

// AlertDestination is a tagged union over the four delivery targets. It
// marshals to exactly the branch its Kind names, because the server's schema is
// a strict oneOf and a push destination carrying a stray channelId is rejected.
type AlertDestination struct {
	Kind      string  `json:"kind"`
	ChannelID *string `json:"channelId,omitempty"`
	WebhookID *string `json:"webhookId,omitempty"`
	// ScheduleID names an on-call rotation rather than a person: who it reaches
	// is decided when the alert fires, not when the rule is written.
	ScheduleID *string `json:"scheduleId,omitempty"`
}

// MarshalJSON emits only the keys belonging to the named branch.
func (d AlertDestination) MarshalJSON() ([]byte, error) {
	switch d.Kind {
	case "push":
		return json.Marshal(struct {
			Kind string `json:"kind"`
		}{Kind: "push"})
	case "slack":
		id := ""
		if d.ChannelID != nil {
			id = *d.ChannelID
		}
		return json.Marshal(struct {
			Kind      string `json:"kind"`
			ChannelID string `json:"channelId"`
		}{Kind: "slack", ChannelID: id})
	case "msteams":
		id := ""
		if d.WebhookID != nil {
			id = *d.WebhookID
		}
		return json.Marshal(struct {
			Kind      string `json:"kind"`
			WebhookID string `json:"webhookId"`
		}{Kind: "msteams", WebhookID: id})
	case "on-call":
		id := ""
		if d.ScheduleID != nil {
			id = *d.ScheduleID
		}
		return json.Marshal(struct {
			Kind       string `json:"kind"`
			ScheduleID string `json:"scheduleId"`
		}{Kind: "on-call", ScheduleID: id})
	default:
		return nil, fmt.Errorf("unknown alert destination kind %q (want \"push\", \"slack\", \"msteams\" or \"on-call\")", d.Kind)
	}
}

// AlertCondition is a tagged union keyed on Field, flattened into one struct.
//
// Flattening is what lets Terraform express it as a single repeatable block
// with a `field`, an `op` and whichever value attribute that field takes. The
// custom marshaller is what keeps the strict oneOf on the server satisfied:
// each branch emits exactly its own keys, so a severity clause never carries an
// empty `values` array.
type AlertCondition struct {
	Field    string   `json:"field"`
	Op       string   `json:"op"`
	Values   []string `json:"values,omitempty"`
	Severity *string  `json:"severity,omitempty"`
	Cents    *int64   `json:"cents,omitempty"`
	Value    *string  `json:"value,omitempty"`
}

// MarshalJSON emits only the keys belonging to the named branch.
func (c AlertCondition) MarshalJSON() ([]byte, error) {
	switch c.Field {
	case "trigger", "accountId", "pluginId", "resourceTypeId":
		values := c.Values
		if values == nil {
			values = []string{}
		}
		return json.Marshal(struct {
			Field  string   `json:"field"`
			Op     string   `json:"op"`
			Values []string `json:"values"`
		}{Field: c.Field, Op: c.Op, Values: values})
	case "severity":
		severity := ""
		if c.Severity != nil {
			severity = *c.Severity
		}
		return json.Marshal(struct {
			Field    string `json:"field"`
			Op       string `json:"op"`
			Severity string `json:"severity"`
		}{Field: "severity", Op: c.Op, Severity: severity})
	case "amountCents":
		var cents int64
		if c.Cents != nil {
			cents = *c.Cents
		}
		return json.Marshal(struct {
			Field string `json:"field"`
			Op    string `json:"op"`
			Cents int64  `json:"cents"`
		}{Field: "amountCents", Op: c.Op, Cents: cents})
	case "key", "text":
		value := ""
		if c.Value != nil {
			value = *c.Value
		}
		return json.Marshal(struct {
			Field string `json:"field"`
			Op    string `json:"op"`
			Value string `json:"value"`
		}{Field: c.Field, Op: c.Op, Value: value})
	default:
		return nil, fmt.Errorf("unknown alert condition field %q", c.Field)
	}
}

// QuietHours is a recurring local-time window during which a rule holds its
// alerts. Held, not dropped: a held alert is delivered when the window closes.
type QuietHours struct {
	Timezone       string  `json:"timezone"`
	StartMinute    int64   `json:"startMinute"`
	EndMinute      int64   `json:"endMinute"`
	Days           []int64 `json:"days"`
	UrgentOverride *string `json:"urgentOverride"`
}

// EscalationPolicy notifies a second set of destinations when nobody
// acknowledges in time. Acknowledgement comes from the button on the Slack
// message, so a rule routed only to Teams or push always escalates.
type EscalationPolicy struct {
	AfterMinutes int64              `json:"afterMinutes"`
	Destinations []AlertDestination `json:"destinations"`
}

// AlertRuleInput is one rule in the ordered list.
//
// ID is sent back deliberately: preserving it keeps in-flight held and
// escalating deliveries pointing at their rule across a rewrite of the list.
type AlertRuleInput struct {
	ID              *string            `json:"id,omitempty"`
	Name            string             `json:"name"`
	Enabled         *bool              `json:"enabled,omitempty"`
	Conditions      []AlertCondition   `json:"conditions"`
	Destinations    []AlertDestination `json:"destinations"`
	ContinueOnMatch *bool              `json:"continueOnMatch,omitempty"`
	QuietHours      *QuietHours        `json:"quietHours,omitempty"`
	Escalation      *EscalationPolicy  `json:"escalation,omitempty"`
}

// AlertRule is a stored routing rule. Position is the evaluation order, which
// the list's own order defines — the server assigns it, so it is read-only.
type AlertRule struct {
	ID              string             `json:"id"`
	Name            string             `json:"name"`
	Enabled         bool               `json:"enabled"`
	Position        int64              `json:"position"`
	Conditions      []AlertCondition   `json:"conditions"`
	Destinations    []AlertDestination `json:"destinations"`
	ContinueOnMatch bool               `json:"continueOnMatch"`
	QuietHours      *QuietHours        `json:"quietHours"`
	Escalation      *EscalationPolicy  `json:"escalation"`
}

// AlertRulesResponse is what GET /alert-rules returns.
//
// UsingDefaults is the field that shapes the resource: an organization that has
// saved nothing still gets a full synthesized rule list back, so "read returned
// rules" does not mean "rules exist". Destroy restores that state rather than
// leaving the org unrouted.
type AlertRulesResponse struct {
	Rules         []AlertRule `json:"rules"`
	UsingDefaults bool        `json:"usingDefaults"`

	// Reference data the editor uses. Decoded so the drift check can see the
	// route is fully covered, but not surfaced as Terraform attributes — the
	// dedicated data sources exist for that.
	SlackChannels   []json.RawMessage `json:"slackChannels,omitempty"`
	MSTeamsWebhooks []json.RawMessage `json:"msTeamsWebhooks,omitempty"`
	Accounts        []json.RawMessage `json:"accounts,omitempty"`
	OnCallSchedules []json.RawMessage `json:"onCallSchedules,omitempty"`
}

/* ------------------------- resource alert settings ------------------------- */

// DriftAlertSettingsUpdate is the PUT body for the change-feed digest.
type DriftAlertSettingsUpdate struct {
	NotifyCreated   *bool    `json:"notifyCreated,omitempty"`
	NotifyUpdated   *bool    `json:"notifyUpdated,omitempty"`
	NotifyDeleted   *bool    `json:"notifyDeleted,omitempty"`
	CooldownMinutes *int64   `json:"cooldownMinutes,omitempty"`
	MinChanges      *int64   `json:"minChanges,omitempty"`
	AccountIDs      []string `json:"accountIds,omitempty"`
}

// DriftAlertSettings is the org singleton controlling drift notifications.
type DriftAlertSettings struct {
	NotifyCreated   bool     `json:"notifyCreated"`
	NotifyUpdated   bool     `json:"notifyUpdated"`
	NotifyDeleted   bool     `json:"notifyDeleted"`
	CooldownMinutes int64    `json:"cooldownMinutes"`
	MinChanges      int64    `json:"minChanges"`
	AccountIDs      []string `json:"accountIds"`
	LastNotifiedAt  *string  `json:"lastNotifiedAt"`
}

// ExpiryAlertSettingsUpdate is the PUT body for the expiry radar.
type ExpiryAlertSettingsUpdate struct {
	Enabled  *bool  `json:"enabled,omitempty"`
	LeadDays *int64 `json:"leadDays,omitempty"`
}

// ExpiryAlertSettings is the org singleton for certificate and commitment
// deadline warnings. LastNotifiedAt is owned by the poller's cooldown claim and
// is not writable.
type ExpiryAlertSettings struct {
	Enabled        bool    `json:"enabled"`
	LeadDays       int64   `json:"leadDays"`
	LastNotifiedAt *string `json:"lastNotifiedAt"`
}

// PostureAlertSettingsUpdate is the PUT body for posture-check notifications.
type PostureAlertSettingsUpdate struct {
	Enabled *bool `json:"enabled,omitempty"`
}

// PostureAlertSettings is the org singleton for posture-check notifications.
type PostureAlertSettings struct {
	Enabled        bool    `json:"enabled"`
	LastNotifiedAt *string `json:"lastNotifiedAt"`
}

// SessionRecordingSettingsUpdate is the PUT body.
type SessionRecordingSettingsUpdate struct {
	Enabled       *bool  `json:"enabled,omitempty"`
	CaptureInput  *bool  `json:"captureInput,omitempty"`
	RetentionDays *int64 `json:"retentionDays,omitempty"`
}

// SessionRecordingUsage is what the recordings currently cost in storage.
type SessionRecordingUsage struct {
	RecordingCount  int64   `json:"recordingCount"`
	StoredBytes     int64   `json:"storedBytes"`
	CapturedBytes   int64   `json:"capturedBytes"`
	OldestStartedAt *string `json:"oldestStartedAt"`
}

// SessionRecordingSettings is the org singleton for SSH session recording.
//
// CaptureInput is separate from Enabled because it is a materially different
// promise to the people being recorded: it captures keystrokes at prompts the
// remote host chose not to echo, which includes a sudo password.
type SessionRecordingSettings struct {
	Enabled       bool                   `json:"enabled"`
	CaptureInput  bool                   `json:"captureInput"`
	RetentionDays int64                  `json:"retentionDays"`
	Usage         *SessionRecordingUsage `json:"usage,omitempty"`
}

/* ------------------------------ network flows ------------------------------ */

// NetworkFlowSettings is the org singleton authorising priced source→
// destination flow collection.
//
// Both fields are required on PUT, so neither is a pointer. The route reads an
// omitted InitialLookbackDays as "keep the stored one", but the provider always
// sends both — a Terraform attribute with a value is a value.
type NetworkFlowSettings struct {
	Enabled             bool  `json:"enabled"`
	InitialLookbackDays int64 `json:"initialLookbackDays"`
}

/* ----------------------------- issue trackers ------------------------------ */

// JiraIntegrationInput is the PUT body.
//
// APIToken is write-only and omitempty: omitting it keeps the stored token,
// which is what lets a practitioner change the default project without having
// the credential to hand.
type JiraIntegrationInput struct {
	SiteURL            string  `json:"siteUrl"`
	AccountEmail       string  `json:"accountEmail"`
	APIToken           *string `json:"apiToken,omitempty"`
	DefaultProjectKey  *string `json:"defaultProjectKey"`
	DefaultIssueTypeID *string `json:"defaultIssueTypeId"`
}

// JiraIntegration is the stored connection. TokenHint is the redacted echo of
// the API token; the token itself is never returned.
type JiraIntegration struct {
	SiteURL            string  `json:"siteUrl"`
	AccountEmail       string  `json:"accountEmail"`
	TokenHint          string  `json:"tokenHint"`
	DefaultProjectKey  *string `json:"defaultProjectKey"`
	DefaultIssueTypeID *string `json:"defaultIssueTypeId"`
	UpdatedAt          string  `json:"updatedAt"`
}

// LinearIntegrationInput is the PUT body. Same write-only rule as Jira's token.
type LinearIntegrationInput struct {
	APIKey        *string `json:"apiKey,omitempty"`
	DefaultTeamID *string `json:"defaultTeamId"`
}

// LinearIntegration is the stored connection.
type LinearIntegration struct {
	KeyHint       string  `json:"keyHint"`
	DefaultTeamID *string `json:"defaultTeamId"`
	UpdatedAt     string  `json:"updatedAt"`
}

/* ---------------------------- workflow schedules --------------------------- */

// WorkflowScheduleInput is the PUT body.
type WorkflowScheduleInput struct {
	Expression string  `json:"expression"`
	Timezone   *string `json:"timezone"`
	Enabled    *bool   `json:"enabled,omitempty"`
}

// WorkflowSchedule is the cron attached to an existing workflow.
//
// The workflow itself is not managed by this provider — its definition lives in
// the workflow editor or in a git-backed repository, neither of which this API
// surface writes. Enabled mirrors the workflow's own flag.
type WorkflowSchedule struct {
	Expression string   `json:"expression"`
	Timezone   *string  `json:"timezone"`
	Enabled    bool     `json:"enabled"`
	LastRunAt  *string  `json:"lastRunAt"`
	NextRunAt  *string  `json:"nextRunAt"`
	NextRuns   []string `json:"nextRuns"`
}

/* --------------------------- read-only reference --------------------------- */

// Resource is a synced cloud resource, as an account's listing returns it.
//
// The provider never writes these — ejecting them to HCL is what
// `Plugin.terraformExport` is for, and creating them is the cloud's own
// provider's job. Reading them matters because a probe, a sleep schedule and a
// log query all address a resource by id, and hard-coding one in HCL is exactly
// the thing this data source exists to avoid. FieldsJson and OutputsJson are
// deliberately dropped: they are unbounded provider-shaped blobs and would put
// a resource's entire configuration into every state file that lists it.
type Resource struct {
	ID               string  `json:"id"`
	PluginID         string  `json:"pluginId"`
	ResourceTypeID   string  `json:"resourceTypeId"`
	AccountID        string  `json:"accountId"`
	DisplayName      string  `json:"displayName"`
	ExternalID       *string `json:"externalId"`
	ParentResourceID *string `json:"parentResourceId"`
}

// OrgMember is one person in the organization and the role they hold. Read
// only: membership is granted by invitation, which is not a Terraform shape.
type OrgMember struct {
	ID            string  `json:"id"`
	Email         string  `json:"email"`
	DisplayName   *string `json:"displayName"`
	Role          string  `json:"role"`
	RoleID        *string `json:"roleId"`
	RoleName      *string `json:"roleName"`
	RoleSystemKey *string `json:"roleSystemKey"`
	CreatedAt     string  `json:"createdAt"`
}

/* ---------------------------- on-call rotations ---------------------------- */

// OnCallParticipant is one person in the rotation order. Name and email are the
// server's, resolved from the org's membership; the provider carries them so the
// drift check sees the shape covered, and writes only the ids into state.
type OnCallParticipant struct {
	UserID string  `json:"userId"`
	Name   *string `json:"name"`
	Email  *string `json:"email"`
}

// OnCallSchedule is a rotation: an ordered list of people, a shift length, and
// the instant the first shift began. Every later handover is derived from those
// three, which is why StartDate re-anchors the whole rotation rather than
// affecting only the next shift.
type OnCallSchedule struct {
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	Timezone     string              `json:"timezone"`
	RotationDays int64               `json:"rotationDays"`
	HandoffTime  string              `json:"handoffTime"`
	StartDate    string              `json:"startDate"`
	Participants []OnCallParticipant `json:"participants"`
	Enabled      bool                `json:"enabled"`
	CreatedAt    string              `json:"createdAt"`
	UpdatedAt    string              `json:"updatedAt"`
}

// OnCallScheduleCreate is the POST body. Enabled is a pointer because the server
// defaults it to true, and a false the caller meant must survive the difference.
type OnCallScheduleCreate struct {
	Name               string   `json:"name"`
	Timezone           string   `json:"timezone"`
	RotationDays       int64    `json:"rotationDays"`
	HandoffTime        string   `json:"handoffTime"`
	StartDate          string   `json:"startDate"`
	ParticipantUserIDs []string `json:"participantUserIds"`
	Enabled            *bool    `json:"enabled,omitempty"`
}

// OnCallScheduleUpdate is the PATCH body: every field optional, absent meaning
// unchanged.
type OnCallScheduleUpdate struct {
	Name               *string  `json:"name,omitempty"`
	Timezone           *string  `json:"timezone,omitempty"`
	RotationDays       *int64   `json:"rotationDays,omitempty"`
	HandoffTime        *string  `json:"handoffTime,omitempty"`
	StartDate          *string  `json:"startDate,omitempty"`
	ParticipantUserIDs []string `json:"participantUserIds,omitempty"`
	Enabled            *bool    `json:"enabled,omitempty"`
}
