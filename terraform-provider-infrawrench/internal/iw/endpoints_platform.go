package iw

import (
	"context"
	"net/http"
)

// Typed endpoint wrappers for the monitoring, governance, access and delivery
// surfaces. Same contract as endpoints.go: resources call these and never
// assemble a path, and a wrapper that reads by listing synthesises its own 404
// so an out-of-band delete still reaches the caller as IsNotFound.

/* --------------------------------- probes --------------------------------- */

// ListProbes unwraps the {"probes": […]} envelope.
func (c *Client) ListProbes(ctx context.Context) ([]SyntheticProbe, error) {
	var envelope struct {
		Probes []SyntheticProbe `json:"probes"`
	}
	if err := c.Get(ctx, "/probes", &envelope); err != nil {
		return nil, err
	}
	return envelope.Probes, nil
}

// GetProbe lists and filters — there is no single-GET route.
func (c *Client) GetProbe(ctx context.Context, id string) (*SyntheticProbe, error) {
	all, err := c.ListProbes(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/probes", id)
}

func (c *Client) CreateProbe(ctx context.Context, in SyntheticProbeCreate) (*SyntheticProbe, error) {
	var out SyntheticProbe
	if err := c.Post(ctx, "/probes", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateProbe(ctx context.Context, id string, in SyntheticProbeUpdate) (*SyntheticProbe, error) {
	var out SyntheticProbe
	if err := c.Put(ctx, "/probes/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteProbe(ctx context.Context, id string) error {
	return c.Delete(ctx, "/probes/"+seg(id))
}

/* ------------------------------ metric alerts ------------------------------ */

func (c *Client) ListMetricAlerts(ctx context.Context) ([]MetricAlertRule, error) {
	var out []MetricAlertRule
	err := c.Get(ctx, "/metric-alerts", &out)
	return out, err
}

func (c *Client) GetMetricAlert(ctx context.Context, id string) (*MetricAlertRule, error) {
	var out MetricAlertRule
	if err := c.Get(ctx, "/metric-alerts/"+seg(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateMetricAlert(ctx context.Context, in MetricAlertRuleInput) (*MetricAlertRule, error) {
	var out MetricAlertRule
	if err := c.Post(ctx, "/metric-alerts", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateMetricAlert(ctx context.Context, id string, in MetricAlertRuleInput) (*MetricAlertRule, error) {
	var out MetricAlertRule
	if err := c.Put(ctx, "/metric-alerts/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteMetricAlert(ctx context.Context, id string) error {
	return c.Delete(ctx, "/metric-alerts/"+seg(id))
}

/* ------------------------------- status pages ------------------------------ */

// ListStatusPages unwraps the {"pages": […]} envelope.
func (c *Client) ListStatusPages(ctx context.Context) ([]StatusPage, error) {
	var envelope struct {
		Pages []StatusPage `json:"pages"`
	}
	if err := c.Get(ctx, "/status-pages", &envelope); err != nil {
		return nil, err
	}
	return envelope.Pages, nil
}

// GetStatusPage lists and filters — there is no single-GET route on the
// org-scoped tree. (`/api/status/{slug}` is the public render, not this shape.)
func (c *Client) GetStatusPage(ctx context.Context, id string) (*StatusPage, error) {
	all, err := c.ListStatusPages(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/status-pages", id)
}

func (c *Client) CreateStatusPage(ctx context.Context, in StatusPageInput) (*StatusPage, error) {
	var out StatusPage
	if err := c.Post(ctx, "/status-pages", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateStatusPage(ctx context.Context, id string, in StatusPageInput) (*StatusPage, error) {
	var out StatusPage
	if err := c.Put(ctx, "/status-pages/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteStatusPage(ctx context.Context, id string) error {
	return c.Delete(ctx, "/status-pages/"+seg(id))
}

/* ----------------------------- sleep schedules ----------------------------- */

// ListSleepSchedules unwraps the {"schedules": […]} envelope.
func (c *Client) ListSleepSchedules(ctx context.Context) ([]SleepSchedule, error) {
	var envelope struct {
		Schedules []SleepSchedule `json:"schedules"`
	}
	if err := c.Get(ctx, "/schedules", &envelope); err != nil {
		return nil, err
	}
	return envelope.Schedules, nil
}

// GetSleepSchedule lists and filters — there is no single-GET route.
func (c *Client) GetSleepSchedule(ctx context.Context, id string) (*SleepSchedule, error) {
	all, err := c.ListSleepSchedules(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/schedules", id)
}

func (c *Client) CreateSleepSchedule(ctx context.Context, in SleepScheduleCreate) (*SleepSchedule, error) {
	var out SleepSchedule
	if err := c.Post(ctx, "/schedules", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateSleepSchedule(ctx context.Context, id string, in SleepScheduleUpdate) (*SleepSchedule, error) {
	var out SleepSchedule
	if err := c.Put(ctx, "/schedules/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteSleepSchedule(ctx context.Context, id string) error {
	return c.Delete(ctx, "/schedules/"+seg(id))
}

/* ------------------------------ change freezes ----------------------------- */

func (c *Client) ListChangeFreezes(ctx context.Context) ([]ChangeFreeze, error) {
	var out []ChangeFreeze
	err := c.Get(ctx, "/change-freezes", &out)
	return out, err
}

// GetChangeFreeze lists and filters — there is no single-GET route.
func (c *Client) GetChangeFreeze(ctx context.Context, id string) (*ChangeFreeze, error) {
	all, err := c.ListChangeFreezes(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/change-freezes", id)
}

func (c *Client) CreateChangeFreeze(ctx context.Context, in ChangeFreezeInput) (*ChangeFreeze, error) {
	var out ChangeFreeze
	if err := c.Post(ctx, "/change-freezes", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateChangeFreeze(ctx context.Context, id string, in ChangeFreezeInput) (*ChangeFreeze, error) {
	var out ChangeFreeze
	if err := c.Put(ctx, "/change-freezes/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteChangeFreeze(ctx context.Context, id string) error {
	return c.Delete(ctx, "/change-freezes/"+seg(id))
}

/* ------------------------------ custom graphs ------------------------------ */

func (c *Client) ListCustomGraphs(ctx context.Context) ([]CustomGraph, error) {
	var out []CustomGraph
	err := c.Get(ctx, "/custom-graphs", &out)
	return out, err
}

func (c *Client) GetCustomGraph(ctx context.Context, id string) (*CustomGraph, error) {
	var out CustomGraph
	if err := c.Get(ctx, "/custom-graphs/"+seg(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateCustomGraph(ctx context.Context, in CustomGraphInput) (*CustomGraph, error) {
	var out CustomGraph
	if err := c.Post(ctx, "/custom-graphs", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateCustomGraph(ctx context.Context, id string, in CustomGraphInput) (*CustomGraph, error) {
	var out CustomGraph
	if err := c.Put(ctx, "/custom-graphs/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteCustomGraph(ctx context.Context, id string) error {
	return c.Delete(ctx, "/custom-graphs/"+seg(id))
}

/* --------------------------- log workspace queries ------------------------- */

// ListLogQueries unwraps the {"queries": […]} envelope.
func (c *Client) ListLogQueries(ctx context.Context) ([]LogWorkspaceQuery, error) {
	var envelope struct {
		Queries []LogWorkspaceQuery `json:"queries"`
	}
	if err := c.Get(ctx, "/log-workspaces", &envelope); err != nil {
		return nil, err
	}
	return envelope.Queries, nil
}

// GetLogQuery lists and filters — there is no single-GET route.
func (c *Client) GetLogQuery(ctx context.Context, id string) (*LogWorkspaceQuery, error) {
	all, err := c.ListLogQueries(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/log-workspaces", id)
}

func (c *Client) CreateLogQuery(ctx context.Context, in LogWorkspaceQueryInput) (*LogWorkspaceQuery, error) {
	var out LogWorkspaceQuery
	if err := c.Post(ctx, "/log-workspaces", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateLogQuery(ctx context.Context, id string, in LogWorkspaceQueryInput) (*LogWorkspaceQuery, error) {
	var out LogWorkspaceQuery
	if err := c.Put(ctx, "/log-workspaces/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteLogQuery(ctx context.Context, id string) error {
	return c.Delete(ctx, "/log-workspaces/"+seg(id))
}

/* ---------------------------------- roles ---------------------------------- */

func (c *Client) ListRoles(ctx context.Context) ([]Role, error) {
	var out []Role
	err := c.Get(ctx, "/team/roles", &out)
	return out, err
}

// GetRole lists and filters — there is no single-GET route.
func (c *Client) GetRole(ctx context.Context, id string) (*Role, error) {
	all, err := c.ListRoles(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/team/roles", id)
}

func (c *Client) CreateRole(ctx context.Context, in RoleInput) (*Role, error) {
	var out Role
	if err := c.Post(ctx, "/team/roles", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateRole(ctx context.Context, id string, in RoleInput) (*Role, error) {
	var out Role
	if err := c.Patch(ctx, "/team/roles/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteRole(ctx context.Context, id string) error {
	return c.Delete(ctx, "/team/roles/"+seg(id))
}

// ListPermissions returns the catalogue of permission strings a role may grant.
func (c *Client) ListPermissions(ctx context.Context) ([]string, error) {
	var envelope struct {
		Permissions []string `json:"permissions"`
	}
	if err := c.Get(ctx, "/team/permissions", &envelope); err != nil {
		return nil, err
	}
	return envelope.Permissions, nil
}

func (c *Client) ListMembers(ctx context.Context) ([]OrgMember, error) {
	var out []OrgMember
	err := c.Get(ctx, "/team/members", &out)
	return out, err
}

/* --------------------------------- ssh keys -------------------------------- */

func (c *Client) ListSSHKeys(ctx context.Context) ([]SSHKey, error) {
	var out []SSHKey
	err := c.Get(ctx, "/ssh-keys", &out)
	return out, err
}

// GetSSHKey lists and filters — there is no single-GET route.
func (c *Client) GetSSHKey(ctx context.Context, id string) (*SSHKey, error) {
	all, err := c.ListSSHKeys(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/ssh-keys", id)
}

// GenerateSSHKey mints a key pair server-side. The private half comes back in
// this response and nowhere else, ever.
func (c *Client) GenerateSSHKey(ctx context.Context, in GenerateSSHKeyRequest) (*GeneratedSSHKey, error) {
	var out GeneratedSSHKey
	if err := c.Post(ctx, "/ssh-keys", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) ImportSSHKey(ctx context.Context, in ImportSSHKeyRequest) (*GeneratedSSHKey, error) {
	var out GeneratedSSHKey
	if err := c.Post(ctx, "/ssh-keys/import", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteSSHKey(ctx context.Context, id string) error {
	return c.Delete(ctx, "/ssh-keys/"+seg(id))
}

/* --------------------------------- bastions -------------------------------- */

func (c *Client) ListBastions(ctx context.Context) ([]Bastion, error) {
	var out []Bastion
	err := c.Get(ctx, "/bastions", &out)
	return out, err
}

// GetBastion lists and filters, and treats a revoked agent as gone: DELETE
// revokes rather than removing the row, so a bastion Terraform destroyed would
// otherwise keep reading back as present.
func (c *Client) GetBastion(ctx context.Context, id string) (*Bastion, error) {
	all, err := c.ListBastions(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			if all[i].RevokedAt != nil {
				return nil, notFound(http.MethodGet, "/bastions", id)
			}
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/bastions", id)
}

func (c *Client) CreateBastion(ctx context.Context, in CreateBastionRequest) (*CreatedBastion, error) {
	var out CreatedBastion
	if err := c.Post(ctx, "/bastions", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteBastion(ctx context.Context, id string) error {
	return c.Delete(ctx, "/bastions/"+seg(id))
}

/* --------------------------------- api keys -------------------------------- */

func (c *Client) ListAPIKeys(ctx context.Context) ([]APIKey, error) {
	var out []APIKey
	err := c.Get(ctx, "/api-keys", &out)
	return out, err
}

// GetAPIKey lists and filters, treating a revoked key as gone.
//
// The listing keeps returning revoked rows so an admin can audit them, but
// revocation is how this API deletes a key: without this check `terraform
// destroy` would appear to succeed and the next refresh would find the key
// still there.
func (c *Client) GetAPIKey(ctx context.Context, id string) (*APIKey, error) {
	all, err := c.ListAPIKeys(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			if all[i].RevokedAt != nil {
				return nil, notFound(http.MethodGet, "/api-keys", id)
			}
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/api-keys", id)
}

func (c *Client) CreateAPIKey(ctx context.Context, in CreateAPIKeyRequest) (*CreatedAPIKey, error) {
	var out CreatedAPIKey
	if err := c.Post(ctx, "/api-keys", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RevokeAPIKey is the delete verb for a key. There is no DELETE route.
func (c *Client) RevokeAPIKey(ctx context.Context, id string) error {
	return c.Post(ctx, "/api-keys/"+seg(id)+"/revoke", nil, nil)
}

/* ------------------------------- ssh snippets ------------------------------ */

func (c *Client) ListSSHSnippets(ctx context.Context) ([]SSHSnippet, error) {
	var out []SSHSnippet
	err := c.Get(ctx, "/ssh-fanout/snippets", &out)
	return out, err
}

// GetSSHSnippet lists and filters — there is no single-GET route.
func (c *Client) GetSSHSnippet(ctx context.Context, id string) (*SSHSnippet, error) {
	all, err := c.ListSSHSnippets(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/ssh-fanout/snippets", id)
}

func (c *Client) CreateSSHSnippet(ctx context.Context, in SSHSnippetInput) (*SSHSnippet, error) {
	var out SSHSnippet
	if err := c.Post(ctx, "/ssh-fanout/snippets", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateSSHSnippet(ctx context.Context, id string, in SSHSnippetInput) (*SSHSnippet, error) {
	var out SSHSnippet
	if err := c.Put(ctx, "/ssh-fanout/snippets/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteSSHSnippet(ctx context.Context, id string) error {
	return c.Delete(ctx, "/ssh-fanout/snippets/"+seg(id))
}

/* --------------------------------- accounts -------------------------------- */

// GetAccount lists and filters — the single-GET route is `/accounts/{id}/detail`,
// which joins in every synced resource and is far more than a read needs.
func (c *Client) GetAccount(ctx context.Context, id string) (*Account, error) {
	all, err := c.ListAccounts(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/accounts", id)
}

func (c *Client) CreateAccount(ctx context.Context, in CreateAccountRequest) (*CreatedAccount, error) {
	var out CreatedAccount
	if err := c.Post(ctx, "/accounts", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateAccount(ctx context.Context, id string, in UpdateAccountRequest) error {
	return c.Patch(ctx, "/accounts/"+seg(id), in, nil)
}

// PutAccountCredentials replaces the stored credential set. It is a separate
// route from the account's own PATCH because rotating a secret and renaming an
// account are gated on different permissions.
func (c *Client) PutAccountCredentials(ctx context.Context, id string, in AccountCredentialsInput) error {
	return c.Put(ctx, "/accounts/"+seg(id)+"/credentials", in, nil)
}

func (c *Client) DeleteAccount(ctx context.Context, id string) error {
	return c.Delete(ctx, "/accounts/"+seg(id))
}

/* ----------------------------- managed accounts ---------------------------- */

func (c *Client) ListManagedAccounts(ctx context.Context) ([]ManagedAccount, error) {
	var out []ManagedAccount
	err := c.Get(ctx, "/managed-accounts", &out)
	return out, err
}

func (c *Client) GetManagedAccount(ctx context.Context, id string) (*ManagedAccount, error) {
	var out ManagedAccount
	if err := c.Get(ctx, "/managed-accounts/"+seg(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateManagedAccount(ctx context.Context, in ManagedAccountInput) (*ManagedAccount, error) {
	var out ManagedAccount
	if err := c.Post(ctx, "/managed-accounts", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateManagedAccount(ctx context.Context, id string, in ManagedAccountInput) (*ManagedAccount, error) {
	var out ManagedAccount
	if err := c.Put(ctx, "/managed-accounts/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteManagedAccount(ctx context.Context, id string) error {
	return c.Delete(ctx, "/managed-accounts/"+seg(id))
}

/* ----------------------------- deploy triggers ----------------------------- */

func (c *Client) ListDeployTriggers(ctx context.Context) ([]DeployTrigger, error) {
	var out []DeployTrigger
	err := c.Get(ctx, "/deployments/triggers", &out)
	return out, err
}

// GetDeployTrigger lists and filters — there is no single-GET route.
func (c *Client) GetDeployTrigger(ctx context.Context, id string) (*DeployTrigger, error) {
	all, err := c.ListDeployTriggers(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/deployments/triggers", id)
}

func (c *Client) CreateDeployTrigger(ctx context.Context, in DeployTriggerInput) (*DeployTrigger, error) {
	var out DeployTrigger
	if err := c.Post(ctx, "/deployments/triggers", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetDeployTriggerEnabled is the trigger's whole mutable surface. Repo, branch
// and env are fixed at creation, so the Terraform resource replaces on a change
// to any of them.
func (c *Client) SetDeployTriggerEnabled(ctx context.Context, id string, enabled bool) (*DeployTrigger, error) {
	var out DeployTrigger
	if err := c.Patch(ctx, "/deployments/triggers/"+seg(id), DeployTriggerEnabled{Enabled: enabled}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteDeployTrigger(ctx context.Context, id string) error {
	return c.Delete(ctx, "/deployments/triggers/"+seg(id))
}

/* ------------------------------ slack / teams ------------------------------ */

// GetSlackStatus reads the whole Slack picture. There is no listing route for
// channels or for installations — this one response is where both live, which
// is why the channel resource and the installations data source share it.
func (c *Client) GetSlackStatus(ctx context.Context) (*SlackStatus, error) {
	var out SlackStatus
	if err := c.Get(ctx, "/slack/status", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetSlackChannel(ctx context.Context, id string) (*SlackChannel, error) {
	status, err := c.GetSlackStatus(ctx)
	if err != nil {
		return nil, err
	}
	for i := range status.Channels {
		if status.Channels[i].ID == id {
			return &status.Channels[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/slack/status", id)
}

func (c *Client) CreateSlackChannel(ctx context.Context, in SlackChannelCreate) (*SlackChannel, error) {
	var out SlackChannel
	if err := c.Post(ctx, "/slack/channels", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateSlackChannel(ctx context.Context, id string, in SlackChannelUpdate) (*SlackChannel, error) {
	var out SlackChannel
	if err := c.Patch(ctx, "/slack/channels/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteSlackChannel(ctx context.Context, id string) error {
	return c.Delete(ctx, "/slack/channels/"+seg(id))
}

// ListMSTeamsWebhooks reads the webhooks out of /msteams/status.
func (c *Client) ListMSTeamsWebhooks(ctx context.Context) ([]MSTeamsWebhook, error) {
	var envelope struct {
		Webhooks []MSTeamsWebhook `json:"webhooks"`
	}
	if err := c.Get(ctx, "/msteams/status", &envelope); err != nil {
		return nil, err
	}
	return envelope.Webhooks, nil
}

func (c *Client) GetMSTeamsWebhook(ctx context.Context, id string) (*MSTeamsWebhook, error) {
	all, err := c.ListMSTeamsWebhooks(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/msteams/status", id)
}

func (c *Client) CreateMSTeamsWebhook(ctx context.Context, in MSTeamsWebhookCreate) (*MSTeamsWebhook, error) {
	var out MSTeamsWebhook
	if err := c.Post(ctx, "/msteams/webhooks", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateMSTeamsWebhook(ctx context.Context, id string, in MSTeamsWebhookUpdate) (*MSTeamsWebhook, error) {
	var out MSTeamsWebhook
	if err := c.Patch(ctx, "/msteams/webhooks/"+seg(id), in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteMSTeamsWebhook(ctx context.Context, id string) error {
	return c.Delete(ctx, "/msteams/webhooks/"+seg(id))
}

/* ---------------------------- delivery settings ---------------------------- */

func (c *Client) GetDigestSettings(ctx context.Context) (*DigestSettings, error) {
	var out DigestSettings
	if err := c.Get(ctx, "/digest", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) PutDigestSettings(ctx context.Context, in DigestSettingsUpdate) (*DigestSettings, error) {
	var out DigestSettings
	if err := c.Put(ctx, "/digest", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListDigestRecipients unwraps the {"recipients": […]} envelope.
func (c *Client) ListDigestRecipients(ctx context.Context) ([]DigestRecipient, error) {
	var envelope struct {
		Recipients []DigestRecipient `json:"recipients"`
	}
	if err := c.Get(ctx, "/digest/recipients", &envelope); err != nil {
		return nil, err
	}
	return envelope.Recipients, nil
}

func (c *Client) GetDigestRecipient(ctx context.Context, id string) (*DigestRecipient, error) {
	all, err := c.ListDigestRecipients(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, notFound(http.MethodGet, "/digest/recipients", id)
}

func (c *Client) CreateDigestRecipient(ctx context.Context, in DigestRecipientInput) (*DigestRecipient, error) {
	var out DigestRecipient
	if err := c.Post(ctx, "/digest/recipients", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteDigestRecipient(ctx context.Context, id string) error {
	return c.Delete(ctx, "/digest/recipients/"+seg(id))
}

/* ------------------------------ alert routing ------------------------------ */

func (c *Client) GetAlertRules(ctx context.Context) (*AlertRulesResponse, error) {
	var out AlertRulesResponse
	if err := c.Get(ctx, "/alert-rules", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PutAlertRules replaces the whole ordered list. There is no per-rule route:
// order is the semantics (first match wins unless a rule tees), so a rule
// cannot be written without stating where it sits relative to the others.
func (c *Client) PutAlertRules(ctx context.Context, rules []AlertRuleInput) ([]AlertRule, error) {
	if rules == nil {
		rules = []AlertRuleInput{}
	}
	var out struct {
		Rules []AlertRule `json:"rules"`
	}
	body := struct {
		Rules []AlertRuleInput `json:"rules"`
	}{Rules: rules}
	if err := c.Put(ctx, "/alert-rules", body, &out); err != nil {
		return nil, err
	}
	return out.Rules, nil
}

// AdoptAlertRuleDefaults writes the synthesized default ruleset. It is what
// destroying the routing resource falls back to: an organization left with no
// rules at all would route nothing, which is a worse state than the default.
func (c *Client) AdoptAlertRuleDefaults(ctx context.Context) error {
	return c.Post(ctx, "/alert-rules/adopt-defaults", nil, nil)
}

/* ------------------------- resource alert settings ------------------------- */

func (c *Client) GetDriftAlertSettings(ctx context.Context) (*DriftAlertSettings, error) {
	var out DriftAlertSettings
	if err := c.Get(ctx, "/changes/alert-settings", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) PutDriftAlertSettings(ctx context.Context, in DriftAlertSettingsUpdate) (*DriftAlertSettings, error) {
	var out DriftAlertSettings
	if err := c.Put(ctx, "/changes/alert-settings", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetExpiryAlertSettings(ctx context.Context) (*ExpiryAlertSettings, error) {
	var out ExpiryAlertSettings
	if err := c.Get(ctx, "/expiring/settings", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) PutExpiryAlertSettings(ctx context.Context, in ExpiryAlertSettingsUpdate) (*ExpiryAlertSettings, error) {
	var out ExpiryAlertSettings
	if err := c.Put(ctx, "/expiring/settings", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetPostureAlertSettings(ctx context.Context) (*PostureAlertSettings, error) {
	var out PostureAlertSettings
	if err := c.Get(ctx, "/posture/settings", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) PutPostureAlertSettings(ctx context.Context, in PostureAlertSettingsUpdate) (*PostureAlertSettings, error) {
	var out PostureAlertSettings
	if err := c.Put(ctx, "/posture/settings", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetSessionRecordingSettings(ctx context.Context) (*SessionRecordingSettings, error) {
	var out SessionRecordingSettings
	if err := c.Get(ctx, "/session-recordings/settings", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) PutSessionRecordingSettings(ctx context.Context, in SessionRecordingSettingsUpdate) (*SessionRecordingSettings, error) {
	var out SessionRecordingSettings
	if err := c.Put(ctx, "/session-recordings/settings", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

/* ----------------------------- issue trackers ------------------------------ */

// GetJiraIntegration unwraps the {"integration": …} envelope. A disconnected
// org returns a null integration, which is a 404 as far as Terraform is
// concerned — there is nothing to refresh.
func (c *Client) GetJiraIntegration(ctx context.Context) (*JiraIntegration, error) {
	var envelope struct {
		Integration *JiraIntegration `json:"integration"`
	}
	if err := c.Get(ctx, "/jira", &envelope); err != nil {
		return nil, err
	}
	if envelope.Integration == nil {
		return nil, notFound(http.MethodGet, "/jira", "integration")
	}
	return envelope.Integration, nil
}

func (c *Client) PutJiraIntegration(ctx context.Context, in JiraIntegrationInput) (*JiraIntegration, error) {
	var out JiraIntegration
	if err := c.Put(ctx, "/jira", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteJiraIntegration(ctx context.Context) error {
	return c.Delete(ctx, "/jira")
}

func (c *Client) GetLinearIntegration(ctx context.Context) (*LinearIntegration, error) {
	var envelope struct {
		Integration *LinearIntegration `json:"integration"`
	}
	if err := c.Get(ctx, "/linear", &envelope); err != nil {
		return nil, err
	}
	if envelope.Integration == nil {
		return nil, notFound(http.MethodGet, "/linear", "integration")
	}
	return envelope.Integration, nil
}

func (c *Client) PutLinearIntegration(ctx context.Context, in LinearIntegrationInput) (*LinearIntegration, error) {
	var out LinearIntegration
	if err := c.Put(ctx, "/linear", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteLinearIntegration(ctx context.Context) error {
	return c.Delete(ctx, "/linear")
}

/* ---------------------------- workflow schedules --------------------------- */

// GetWorkflowSchedule unwraps the {"schedule": …} envelope. A null schedule
// means the workflow's trigger is not cron, which for Terraform is a 404.
func (c *Client) GetWorkflowSchedule(ctx context.Context, workflowID string) (*WorkflowSchedule, error) {
	var envelope struct {
		Schedule *WorkflowSchedule `json:"schedule"`
	}
	if err := c.Get(ctx, "/workflows/"+seg(workflowID)+"/schedule", &envelope); err != nil {
		return nil, err
	}
	if envelope.Schedule == nil {
		return nil, notFound(http.MethodGet, "/workflows/"+seg(workflowID)+"/schedule", workflowID)
	}
	return envelope.Schedule, nil
}

func (c *Client) PutWorkflowSchedule(ctx context.Context, workflowID string, in WorkflowScheduleInput) (*WorkflowSchedule, error) {
	var envelope struct {
		Schedule *WorkflowSchedule `json:"schedule"`
	}
	if err := c.Put(ctx, "/workflows/"+seg(workflowID)+"/schedule", in, &envelope); err != nil {
		return nil, err
	}
	if envelope.Schedule == nil {
		return nil, notFound(http.MethodPut, "/workflows/"+seg(workflowID)+"/schedule", workflowID)
	}
	return envelope.Schedule, nil
}

func (c *Client) DeleteWorkflowSchedule(ctx context.Context, workflowID string) error {
	return c.Delete(ctx, "/workflows/"+seg(workflowID)+"/schedule")
}

/* --------------------------- read-only reference --------------------------- */

// ListAccountResources lists the synced resources of one account.
func (c *Client) ListAccountResources(ctx context.Context, accountID string) ([]Resource, error) {
	var out []Resource
	err := c.Get(ctx, "/accounts/"+seg(accountID)+"/resources", &out)
	return out, err
}
