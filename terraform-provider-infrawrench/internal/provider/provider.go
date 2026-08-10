// Package provider implements the Infrawrench Terraform provider.
//
// It manages Infrawrench's *own* configuration — budgets, cost centres,
// allocation rules, tag policy, saved filters, cost reports and folders, cost
// alerts, scenario models, billing rules and cost exports — by talking to the
// org-scoped REST routes directly. See the README for why it does not wrap the
// existing config-as-code plan/apply surface.
package provider

import (
	"context"
	"fmt"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

// Environment variables the provider falls back to when the corresponding
// argument is not set in the provider block. Keeping credentials out of .tf
// files is the normal way to run this in CI.
const (
	envBaseURL = "INFRAWRENCH_BASE_URL"
	envAPIKey  = "INFRAWRENCH_API_KEY"
	envOrgID   = "INFRAWRENCH_ORG_ID"
)

// defaultBaseURL is the hosted installation, used when neither the argument nor
// the environment names one.
const defaultBaseURL = "https://app.infrawrench.com"

var (
	_ provider.Provider = (*infrawrenchProvider)(nil)
)

type infrawrenchProvider struct {
	version string
}

// New returns the provider constructor Terraform calls.
func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &infrawrenchProvider{version: version}
	}
}

type providerModel struct {
	BaseURL        types.String `tfsdk:"base_url"`
	APIKey         types.String `tfsdk:"api_key"`
	OrganizationID types.String `tfsdk:"organization_id"`
}

func (p *infrawrenchProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "infrawrench"
	resp.Version = p.version
}

func (p *infrawrenchProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manages Infrawrench's own FinOps configuration: budgets, cost centres, " +
			"allocation rules, tag policy, saved filters, cost reports and folders, cost alerts, " +
			"scenario models, billing rules and cost exports.",
		Attributes: map[string]schema.Attribute{
			"base_url": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Root URL of the Infrawrench installation, without a trailing " +
					"`/api`. Defaults to `" + envBaseURL + "` if set, otherwise `" + defaultBaseURL + "`.",
			},
			"api_key": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				MarkdownDescription: "Infrawrench API key (`iwk_…`) or WorkOS access token. Defaults to " +
					"`" + envAPIKey + "`. Prefer the environment variable so the credential never " +
					"reaches a `.tf` file or a plan file.",
			},
			"organization_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "WorkOS organization id (`org_…`) every resource is scoped to. " +
					"Defaults to `" + envOrgID + "`.",
			},
		},
	}
}

func (p *infrawrenchProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var config providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// An unknown here means the value comes from another resource's output and
	// is not computed yet. Failing with a clear message beats constructing a
	// client around a placeholder.
	if config.BaseURL.IsUnknown() {
		resp.Diagnostics.AddAttributeError(path.Root("base_url"),
			"Unknown Infrawrench base URL",
			"base_url cannot be determined at configure time. Set it to a literal, or set "+envBaseURL+".")
	}
	if config.APIKey.IsUnknown() {
		resp.Diagnostics.AddAttributeError(path.Root("api_key"),
			"Unknown Infrawrench API key",
			"api_key cannot be determined at configure time. Set "+envAPIKey+" instead.")
	}
	if config.OrganizationID.IsUnknown() {
		resp.Diagnostics.AddAttributeError(path.Root("organization_id"),
			"Unknown Infrawrench organization id",
			"organization_id cannot be determined at configure time. Set it to a literal, or set "+envOrgID+".")
	}
	if resp.Diagnostics.HasError() {
		return
	}

	baseURL := firstNonEmpty(config.BaseURL.ValueString(), os.Getenv(envBaseURL), defaultBaseURL)
	apiKey := firstNonEmpty(config.APIKey.ValueString(), os.Getenv(envAPIKey))
	orgID := firstNonEmpty(config.OrganizationID.ValueString(), os.Getenv(envOrgID))

	if apiKey == "" {
		resp.Diagnostics.AddAttributeError(path.Root("api_key"),
			"Missing Infrawrench API key",
			"Set the provider's api_key argument or the "+envAPIKey+" environment variable.")
	}
	if orgID == "" {
		resp.Diagnostics.AddAttributeError(path.Root("organization_id"),
			"Missing Infrawrench organization id",
			"Set the provider's organization_id argument or the "+envOrgID+" environment variable. "+
				"It is the WorkOS organization id, which looks like org_01HXYZ….")
	}
	if resp.Diagnostics.HasError() {
		return
	}

	iw.UserAgent = "terraform-provider-infrawrench/" + p.version

	client, err := iw.NewClient(iw.Config{BaseURL: baseURL, Token: apiKey, OrgID: orgID})
	if err != nil {
		resp.Diagnostics.AddError("Invalid Infrawrench provider configuration", err.Error())
		return
	}

	resp.ResourceData = client
	resp.DataSourceData = client
}

func (p *infrawrenchProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewBudgetResource,
		NewCostCentreResource,
		NewAllocationRuleResource,
		NewTagPolicyResource,
		NewSavedFilterResource,
		NewCostReportResource,
		NewCostReportFolderResource,
		NewCostAlertResource,
		NewScenarioModelResource,
		NewBillingRuleResource,
		NewCostExportResource,
	}
}

func (p *infrawrenchProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		NewAccountsDataSource,
		NewPluginsDataSource,
		NewCostCentresDataSource,
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

/* ------------------------- configure plumbing ------------------------------ */

// clientFromResourceConfigure is the standard ProviderData assertion. It
// returns nil when Terraform is validating offline and has not configured the
// provider yet, which is not an error.
func clientFromResourceConfigure(req resource.ConfigureRequest, resp *resource.ConfigureResponse) *iw.Client {
	if req.ProviderData == nil {
		return nil
	}
	client, ok := req.ProviderData.(*iw.Client)
	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected Resource Configure Type",
			fmt.Sprintf("Expected *iw.Client, got: %T. Please report this issue to the provider developers.", req.ProviderData),
		)
		return nil
	}
	return client
}

// clientFromDataSourceConfigure is the data source counterpart.
func clientFromDataSourceConfigure(req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) *iw.Client {
	if req.ProviderData == nil {
		return nil
	}
	client, ok := req.ProviderData.(*iw.Client)
	if !ok {
		resp.Diagnostics.AddError(
			"Unexpected Data Source Configure Type",
			fmt.Sprintf("Expected *iw.Client, got: %T. Please report this issue to the provider developers.", req.ProviderData),
		)
		return nil
	}
	return client
}
