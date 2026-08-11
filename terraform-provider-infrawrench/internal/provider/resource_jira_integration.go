package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*jiraIntegrationResource)(nil)
	_ resource.ResourceWithConfigure   = (*jiraIntegrationResource)(nil)
	_ resource.ResourceWithImportState = (*jiraIntegrationResource)(nil)
)

// NewJiraIntegrationResource constructs the infrawrench_jira_integration
// resource.
func NewJiraIntegrationResource() resource.Resource { return &jiraIntegrationResource{} }

type jiraIntegrationResource struct{ client *iw.Client }

type jiraIntegrationResourceModel struct {
	ID                 types.String `tfsdk:"id"`
	SiteURL            types.String `tfsdk:"site_url"`
	AccountEmail       types.String `tfsdk:"account_email"`
	APIToken           types.String `tfsdk:"api_token"`
	DefaultProjectKey  types.String `tfsdk:"default_project_key"`
	DefaultIssueTypeID types.String `tfsdk:"default_issue_type_id"`
	TokenHint          types.String `tfsdk:"token_hint"`
}

func (r *jiraIntegrationResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_jira_integration"
}

func (r *jiraIntegrationResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The organization's Jira Cloud connection, used to file issues from findings and " +
			"alerts.\n\n" +
			"An organization **singleton** — one connection per organization. `terraform destroy` " +
			"disconnects it, which drops the stored token; existing issue links survive.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("The Jira connection"),
			"site_url": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Jira Cloud site address, e.g. `https://acme.atlassian.net`. Must resolve to " +
					"an `.atlassian.net` (or legacy `.jira.com`) host; a bare hostname and a pasted board or " +
					"issue URL are both accepted and normalized — which can produce a one-time diff after the " +
					"first apply if you wrote something other than the canonical form.",
			},
			"account_email": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Atlassian account email — the username half of the basic-auth pair.",
			},
			"api_token": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				MarkdownDescription: "API token from id.atlassian.com. **Required on first connect**; omit it " +
					"afterwards to keep the stored token, which is what lets you change the default project " +
					"without having the credential to hand.\n\n" +
					"Write-only: no route returns it, so the provider cannot detect drift on its value. " +
					"Compare `token_hint` if you need to check which token is stored.",
			},
			"default_project_key": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Project the file-issue window preselects, e.g. `OPS`.",
			},
			"default_issue_type_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Issue type the file-issue window preselects. A numeric Jira issue-type id, " +
					"not a name.",
			},

			"token_hint": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Redacted marker for the stored token, e.g. `…a7f2`.",
			},
		},
	}
}

func (r *jiraIntegrationResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *jiraIntegrationResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan jiraIntegrationResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Read refreshes the connection. A disconnected organization returns a null
// integration, which iw.Client.GetJiraIntegration turns into a 404 — so
// disconnecting in the app makes the next plan a create rather than an update.
func (r *jiraIntegrationResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state jiraIntegrationResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetJiraIntegration(ctx)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read the Jira integration", err.Error())
		return
	}

	refreshed := jiraStateFrom(r.client.OrgID(), remote, state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *jiraIntegrationResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan jiraIntegrationResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *jiraIntegrationResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if err := r.client.DeleteJiraIntegration(ctx); err != nil && !iw.IsNotFound(err) {
		resp.Diagnostics.AddError("Unable to disconnect Jira", err.Error())
	}
}

// ImportState adopts an existing connection. The token is not recoverable, so
// supply `api_token` in configuration afterwards — or leave it out, since an
// omitted token keeps whatever is stored.
func (r *jiraIntegrationResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *jiraIntegrationResource) write(ctx context.Context, plan jiraIntegrationResourceModel, diags *diagnostics, state *tfState) {
	saved, err := r.client.PutJiraIntegration(ctx, iw.JiraIntegrationInput{
		SiteURL:            plan.SiteURL.ValueString(),
		AccountEmail:       plan.AccountEmail.ValueString(),
		APIToken:           stringPtr(plan.APIToken),
		DefaultProjectKey:  stringPtr(plan.DefaultProjectKey),
		DefaultIssueTypeID: stringPtr(plan.DefaultIssueTypeID),
	})
	if err != nil {
		diags.AddError("Unable to write the Jira integration", err.Error())
		return
	}
	next := jiraStateFrom(r.client.OrgID(), saved, plan)
	diags.Append(state.Set(ctx, &next)...)
}

// jiraStateFrom carries the token forward from the prior model: it is
// write-only, and refreshing must not drop it out of state.
func jiraStateFrom(orgID string, remote *iw.JiraIntegration, prior jiraIntegrationResourceModel) jiraIntegrationResourceModel {
	return jiraIntegrationResourceModel{
		ID:                 types.StringValue(orgID),
		SiteURL:            types.StringValue(remote.SiteURL),
		AccountEmail:       types.StringValue(remote.AccountEmail),
		APIToken:           prior.APIToken,
		DefaultProjectKey:  stringValue(remote.DefaultProjectKey),
		DefaultIssueTypeID: stringValue(remote.DefaultIssueTypeID),
		TokenHint:          types.StringValue(remote.TokenHint),
	}
}
