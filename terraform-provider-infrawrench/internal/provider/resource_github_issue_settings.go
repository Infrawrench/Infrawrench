package provider

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/defaults"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                   = (*githubIssueSettingsResource)(nil)
	_ resource.ResourceWithConfigure      = (*githubIssueSettingsResource)(nil)
	_ resource.ResourceWithImportState    = (*githubIssueSettingsResource)(nil)
	_ resource.ResourceWithValidateConfig = (*githubIssueSettingsResource)(nil)
)

// NewGithubIssueSettingsResource constructs the
// infrawrench_github_issue_settings resource.
func NewGithubIssueSettingsResource() resource.Resource { return &githubIssueSettingsResource{} }

type githubIssueSettingsResource struct{ client *iw.Client }

// githubIssueSettingsResourceModel is the whole settings document.
//
// One resource for the document rather than one per route, for the same reason
// infrawrench_alert_routing is one resource: the routes are first-match-wins,
// so order is the semantics, and the route is a whole-document replace anyway.
//
// Repositories are flattened into an installation id plus an `owner/name`
// string rather than nested blocks: it is two scalars, and flat attributes keep
// "both or neither" expressible as an ordinary validator.
type githubIssueSettingsResourceModel struct {
	ID                    types.String `tfsdk:"id"`
	Enabled               types.Bool   `tfsdk:"enabled"`
	DefaultInstallationID types.Int64  `tfsdk:"default_installation_id"`
	DefaultRepository     types.String `tfsdk:"default_repository"`
	Labels                types.List   `tfsdk:"labels"`
	Assignees             types.List   `tfsdk:"assignees"`
	ResolveAction         types.String `tfsdk:"resolve_action"`
	PullRequestsEnabled   types.Bool   `tfsdk:"pull_requests_enabled"`
	UpdatedAt             types.String `tfsdk:"updated_at"`
	Route                 types.List   `tfsdk:"route"`
	IacSource             types.List   `tfsdk:"iac_source"`
}

type githubIssueRouteModel struct {
	ID             types.String `tfsdk:"id"`
	MatchKind      types.String `tfsdk:"match_kind"`
	CostCentreID   types.String `tfsdk:"cost_centre_id"`
	TagKey         types.String `tfsdk:"tag_key"`
	TagValue       types.String `tfsdk:"tag_value"`
	InstallationID types.Int64  `tfsdk:"installation_id"`
	Repository     types.String `tfsdk:"repository"`
	Labels         types.List   `tfsdk:"labels"`
	Assignees      types.List   `tfsdk:"assignees"`
}

type githubIacSourceModel struct {
	ID             types.String `tfsdk:"id"`
	IacAccountID   types.String `tfsdk:"iac_account_id"`
	InstallationID types.Int64  `tfsdk:"installation_id"`
	Repository     types.String `tfsdk:"repository"`
	BaseBranch     types.String `tfsdk:"base_branch"`
	Directory      types.String `tfsdk:"directory"`
}

var githubIssueRouteAttrTypes = map[string]attr.Type{
	"id":              types.StringType,
	"match_kind":      types.StringType,
	"cost_centre_id":  types.StringType,
	"tag_key":         types.StringType,
	"tag_value":       types.StringType,
	"installation_id": types.Int64Type,
	"repository":      types.StringType,
	"labels":          types.ListType{ElemType: types.StringType},
	"assignees":       types.ListType{ElemType: types.StringType},
}

var githubIacSourceAttrTypes = map[string]attr.Type{
	"id":              types.StringType,
	"iac_account_id":  types.StringType,
	"installation_id": types.Int64Type,
	"repository":      types.StringType,
	"base_branch":     types.StringType,
	"directory":       types.StringType,
}

var (
	githubIssueRouteObjectType = types.ObjectType{AttrTypes: githubIssueRouteAttrTypes}
	githubIacSourceObjectType  = types.ObjectType{AttrTypes: githubIacSourceAttrTypes}
)

var (
	githubRouteMatchKinds    = []string{"cost_centre", "tag"}
	githubResolveActions     = []string{"close", "comment", "none"}
	githubRepoFullNameRegexp = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
)

// GitHub issue settings limits, mirrored from GITHUB_ISSUE_LIMITS in
// client-core and the route's zod schema.
const (
	githubMaxRoutes          = 50
	githubMaxIacSources      = 20
	githubMaxLabels          = 20
	githubMaxAssignees       = 10
	githubMaxLabelLength     = 50
	githubMaxLoginLength     = 39
	githubMaxDirectoryLength = 512
)

func githubRepositoryValidators() []validatorString {
	return []validatorString{
		stringvalidator.LengthBetween(3, 201),
		stringvalidator.RegexMatches(githubRepoFullNameRegexp, "must be `owner/name`"),
	}
}

func githubLabelValidators() []validatorList {
	return []validatorList{sizeAtMost(githubMaxLabels), elementsLengthBetween(1, githubMaxLabelLength)}
}

func githubAssigneeValidators() []validatorList {
	return []validatorList{sizeAtMost(githubMaxAssignees), elementsLengthBetween(1, githubMaxLoginLength)}
}

func emptyStringListDefault() defaults.List {
	return listdefault.StaticValue(types.ListValueMust(types.StringType, []attr.Value{}))
}

func (r *githubIssueSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_github_issue_settings"
}

func (r *githubIssueSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "How savings findings are filed as GitHub issues, and which Terraform repositories " +
			"pull requests may edit.\n\n" +
			"Issues are created by the organization's GitHub App, as the app, so there is no token here. Every " +
			"repository is named by the `installation_id` of a GitHub App installation connected to the " +
			"organization plus its `owner/name`; both come from the organization's `/github/repos` listing " +
			"(the repository pickers under **Settings, GitHub Issues** in the app read the same list). An " +
			"installation must have approved the app's **Issues: read and write** permission before anything " +
			"can be filed into it, and **Contents** and **Pull requests** (read and write) as well before " +
			"pull requests can be opened against it. An installation made before issue filing existed keeps " +
			"working for workflows but cannot file until an owner of that GitHub account approves the updated " +
			"permissions; the settings page shows which are missing.\n\n" +
			"Reading needs `github-issues:read`; changing anything needs `org:settings:write`.\n\n" +
			"Filing automatically is not configured here: it is an `infrawrench_alert_routing` rule with a " +
			"`github-issues` destination, which files into whichever repository this document routes the " +
			"finding to.\n\n" +
			"An organization **singleton**. The write is a whole-document replace, so anything this resource " +
			"does not set is reset to its default rather than left alone. There is no DELETE on the route: " +
			"`terraform destroy` writes the shipped defaults back, which turns filing and pull requests off, " +
			"clears the default repository, routes and Terraform sources, and restores the single " +
			"`infrawrench` label.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("GitHub issue filing"),
			"enabled": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Master switch for filing, by hand and through alert routing alike. " +
					"Turning it on requires `default_repository`; the API rejects an enabled document " +
					"without one, and this provider refuses it at plan time.",
			},
			"default_installation_id": schema.Int64Attribute{
				Optional: true,
				MarkdownDescription: "The GitHub App installation that reaches `default_repository`, as " +
					"listed by `/github/repos`. Set both or neither.",
				Validators: []validatorInt64{
					atLeast(1),
					int64validator.AlsoRequires(path.MatchRoot("default_repository")),
				},
			},
			"default_repository": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Where a finding goes when no `route` matches it, as `owner/name`. " +
					"Omit it (and `default_installation_id`) for no default, which is only legal while " +
					"`enabled` is false.",
				Validators: append(githubRepositoryValidators(),
					stringvalidator.AlsoRequires(path.MatchRoot("default_installation_id"))),
			},
			"labels": schema.ListAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				Default: listdefault.StaticValue(types.ListValueMust(types.StringType, []attr.Value{
					types.StringValue("infrawrench"),
				})),
				MarkdownDescription: "Labels every filed issue gets, up to 20, each 1-50 characters. Defaults " +
					"to `[\"infrawrench\"]`, which is what an organization starts with. A label the " +
					"repository does not have yet is created by GitHub on first use.",
				Validators: githubLabelValidators(),
			},
			"assignees": schema.ListAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				Default:     emptyStringListDefault(),
				MarkdownDescription: "GitHub logins every filed issue is assigned to, up to 10, each " +
					"1-39 characters. A route with assignees of its own replaces these.",
				Validators: githubAssigneeValidators(),
			},
			"resolve_action": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("comment"),
				MarkdownDescription: "What happens to an open issue when its finding goes away: `close` " +
					"closes it with a comment, `comment` (the default) only comments, `none` leaves it alone.",
				Validators: []validatorString{oneOfValidator(githubResolveActions...)},
			},
			"pull_requests_enabled": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(false),
				MarkdownDescription: "Lets holders of `github-issues:write` open pull requests that edit " +
					"Terraform for IaC-managed findings, against the repositories mapped by `iac_source`. " +
					"Pull requests are never merged automatically.",
			},
			"updated_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "When the document was last saved, or null if it never has been.",
			},
		},
		Blocks: map[string]schema.Block{
			"route": schema.ListNestedBlock{
				MarkdownDescription: "Sends matching findings to a repository other than the default. Up to " +
					"50, evaluated in order: the first match wins, and a finding no route matches goes to " +
					"`default_repository`.",
				Validators: []validatorList{sizeAtMost(githubMaxRoutes)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							Computed: true,
							MarkdownDescription: "Server-assigned route id, sent back on every write. Ids " +
								"follow position in the list, so inserting a route in the middle shifts the " +
								"ids below it; nothing outside this document refers to them.",
							PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
						},
						"match_kind": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "`cost_centre` matches the cost centre the organization's " +
								"allocation rules place the finding's resource in (rules matching on `service` " +
								"cannot be judged from a resource and never match), and takes " +
								"`cost_centre_id`. `tag` matches a tag on the resource, and takes `tag_key` " +
								"and optionally `tag_value`.",
							Validators: []validatorString{oneOfValidator(githubRouteMatchKinds...)},
						},
						"cost_centre_id": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "For `match_kind = \"cost_centre\"`: the `id` of an " +
								"`infrawrench_cost_centre`, 1-64 characters.",
							Validators: []validatorString{stringvalidator.LengthBetween(1, 64)},
						},
						"tag_key": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "For `match_kind = \"tag\"`: the tag key, 1-128 characters.",
							Validators:          []validatorString{stringvalidator.LengthBetween(1, 128)},
						},
						"tag_value": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "For `match_kind = \"tag\"`: the value the tag must have, " +
								"up to 256 characters. Omit it to match any value of `tag_key`.",
							Validators: []validatorString{stringvalidator.LengthAtMost(256)},
						},
						"installation_id": schema.Int64Attribute{
							Required: true,
							MarkdownDescription: "The GitHub App installation that reaches `repository`, as " +
								"listed by `/github/repos`.",
							Validators: []validatorInt64{atLeast(1)},
						},
						"repository": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "The repository matching findings are filed into, as `owner/name`.",
							Validators:          githubRepositoryValidators(),
						},
						"labels": schema.ListAttribute{
							Optional:    true,
							Computed:    true,
							ElementType: types.StringType,
							Default:     emptyStringListDefault(),
							MarkdownDescription: "Labels added on top of the organization-wide `labels`, up " +
								"to 20, each 1-50 characters.",
							Validators: githubLabelValidators(),
						},
						"assignees": schema.ListAttribute{
							Optional:    true,
							Computed:    true,
							ElementType: types.StringType,
							Default:     emptyStringListDefault(),
							MarkdownDescription: "GitHub logins that replace the organization-wide " +
								"`assignees` when non-empty, up to 10, each 1-39 characters.",
							Validators: githubAssigneeValidators(),
						},
					},
				},
			},
			"iac_source": schema.ListNestedBlock{
				MarkdownDescription: "Maps an IaC state (the states uploaded on the IaC page) to the " +
					"repository and directory holding its Terraform, so a pull request knows which file to " +
					"edit. Up to 20, and at most one per state scope. Only used while " +
					"`pull_requests_enabled` is true.",
				Validators: []validatorList{sizeAtMost(githubMaxIacSources)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							Computed: true,
							MarkdownDescription: "Server-assigned source id, sent back on every write. Like a " +
								"route's, it follows position in the list.",
							PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
						},
						"iac_account_id": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "The account an uploaded state document covers, up to 64 " +
								"characters. Omit it for the organization-wide state.",
							Validators: []validatorString{stringvalidator.LengthAtMost(64)},
						},
						"installation_id": schema.Int64Attribute{
							Required: true,
							MarkdownDescription: "The GitHub App installation that reaches `repository`, as " +
								"listed by `/github/repos`. It needs the Contents and Pull requests " +
								"permissions approved.",
							Validators: []validatorInt64{atLeast(1)},
						},
						"repository": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "The repository holding the Terraform, as `owner/name`.",
							Validators:          githubRepositoryValidators(),
						},
						"base_branch": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "The branch pull requests target, 1-255 characters. " +
								"Omit it for the repository's default branch.",
							Validators: []validatorString{stringvalidator.LengthBetween(1, 255)},
						},
						"directory": schema.StringAttribute{
							Optional: true,
							Computed: true,
							Default:  stringdefault.StaticString(""),
							MarkdownDescription: "The directory holding the root module's `.tf` files, " +
								"for example `infra/prod`, up to 512 characters and with no `..` segment. " +
								"Empty (the default) is the repository root.",
							Validators: []validatorString{stringvalidator.LengthAtMost(githubMaxDirectoryLength)},
						},
					},
				},
			},
		},
	}
}

func (r *githubIssueSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// ValidateConfig catches the document-level rules the server would otherwise
// reject with a 400 mid-apply: enabling without a default repository, a route
// whose match fields do not fit its kind, two Terraform sources for the same
// state scope, and a `..` in a source directory.
//
// Unknown values are skipped throughout: a value computed from another
// resource is not available at validate time, and refusing it would reject a
// configuration that may well be legal.
func (r *githubIssueSettingsResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config githubIssueSettingsResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if config.Enabled.ValueBool() && config.DefaultRepository.IsNull() {
		resp.Diagnostics.AddAttributeError(path.Root("default_repository"),
			"GitHub issue filing needs a default repository",
			"Set default_repository and default_installation_id, or leave enabled false. The API "+
				"rejects an enabled document without a default repository.")
	}

	if !config.Route.IsNull() && !config.Route.IsUnknown() {
		var routes []githubIssueRouteModel
		resp.Diagnostics.Append(config.Route.ElementsAs(ctx, &routes, false)...)
		for i, route := range routes {
			at := path.Root("route").AtListIndex(i)
			switch route.MatchKind.ValueString() {
			case "cost_centre":
				if route.CostCentreID.IsNull() {
					resp.Diagnostics.AddAttributeError(at.AtName("cost_centre_id"), "Route needs a cost centre",
						"A route with match_kind \"cost_centre\" needs cost_centre_id.")
				}
				if !route.TagKey.IsNull() || !route.TagValue.IsNull() {
					resp.Diagnostics.AddAttributeError(at.AtName("tag_key"), "Tag fields on a cost centre route",
						"tag_key and tag_value only apply when match_kind is \"tag\".")
				}
			case "tag":
				if route.TagKey.IsNull() {
					resp.Diagnostics.AddAttributeError(at.AtName("tag_key"), "Route needs a tag key",
						"A route with match_kind \"tag\" needs tag_key.")
				}
				if !route.CostCentreID.IsNull() {
					resp.Diagnostics.AddAttributeError(at.AtName("cost_centre_id"), "Cost centre on a tag route",
						"cost_centre_id only applies when match_kind is \"cost_centre\".")
				}
			}
		}
	}

	if !config.IacSource.IsNull() && !config.IacSource.IsUnknown() {
		var sources []githubIacSourceModel
		resp.Diagnostics.Append(config.IacSource.ElementsAs(ctx, &sources, false)...)
		seen := map[string]bool{}
		for i, source := range sources {
			at := path.Root("iac_source").AtListIndex(i)
			if !source.IacAccountID.IsUnknown() {
				scope := source.IacAccountID.ValueString()
				if seen[scope] {
					label := "the organization-wide state"
					if scope != "" {
						label = fmt.Sprintf("iac_account_id %q", scope)
					}
					resp.Diagnostics.AddAttributeError(at.AtName("iac_account_id"), "Duplicate Terraform source",
						fmt.Sprintf("More than one iac_source maps %s. Each state scope can map to one repository.", label))
				}
				seen[scope] = true
			}
			if !source.Directory.IsUnknown() {
				for _, segment := range strings.Split(source.Directory.ValueString(), "/") {
					if segment == ".." {
						resp.Diagnostics.AddAttributeError(at.AtName("directory"), "Directory escapes the repository",
							"directory cannot contain a \"..\" segment.")
						break
					}
				}
			}
		}
	}
}

func (r *githubIssueSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan githubIssueSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *githubIssueSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state githubIssueSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetGithubIssueSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read GitHub issue settings", err.Error())
		return
	}

	refreshed, diags := githubIssueSettingsStateFrom(ctx, r.client.OrgID(), remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *githubIssueSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan githubIssueSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete writes the shipped defaults back; the route has no DELETE. Filing and
// pull requests end up off, which is what removing the resource should mean.
func (r *githubIssueSettingsResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if _, err := r.client.PutGithubIssueSettings(ctx, iw.DefaultGithubIssueSettings()); err != nil {
		resp.Diagnostics.AddError("Unable to reset GitHub issue settings", err.Error())
	}
}

func (r *githubIssueSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *githubIssueSettingsResource) write(ctx context.Context, plan githubIssueSettingsResourceModel, diags *diagnostics, state *tfState) {
	input, d := githubIssueSettingsInputFrom(ctx, plan)
	diags.Append(d...)
	if diags.HasError() {
		return
	}

	saved, err := r.client.PutGithubIssueSettings(ctx, input)
	if err != nil {
		diags.AddError("Unable to write GitHub issue settings", err.Error())
		return
	}

	next, d := githubIssueSettingsStateFrom(ctx, r.client.OrgID(), saved)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	diags.Append(state.Set(ctx, &next)...)
}

/* -------------------------------- mapping --------------------------------- */

// githubIssueSettingsInputFrom maps the configuration onto the PUT body.
//
// Every field is sent, because the PUT replaces the whole document: a field
// left out would not be "unchanged", it would be a 400 or a reset.
func githubIssueSettingsInputFrom(ctx context.Context, m githubIssueSettingsResourceModel) (iw.GithubIssueSettingsInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	input := iw.GithubIssueSettingsInput{
		Enabled:             m.Enabled.ValueBool(),
		ResolveAction:       m.ResolveAction.ValueString(),
		PullRequestsEnabled: m.PullRequestsEnabled.ValueBool(),
		Routes:              []iw.GithubIssueRoute{},
		IacSources:          []iw.GithubIacSource{},
	}
	if input.ResolveAction == "" {
		input.ResolveAction = "comment"
	}
	if !m.DefaultRepository.IsNull() && !m.DefaultRepository.IsUnknown() {
		input.DefaultRepo = &iw.GithubRepoRef{
			InstallationID: m.DefaultInstallationID.ValueInt64(),
			FullName:       m.DefaultRepository.ValueString(),
		}
	}

	labels, d := stringSlice(ctx, m.Labels)
	diags.Append(d...)
	assignees, d := stringSlice(ctx, m.Assignees)
	diags.Append(d...)
	input.Labels, input.Assignees = labels, assignees

	if !m.Route.IsNull() && !m.Route.IsUnknown() {
		var routes []githubIssueRouteModel
		diags.Append(m.Route.ElementsAs(ctx, &routes, false)...)
		for _, route := range routes {
			routeLabels, d := stringSlice(ctx, route.Labels)
			diags.Append(d...)
			routeAssignees, d := stringSlice(ctx, route.Assignees)
			diags.Append(d...)
			input.Routes = append(input.Routes, iw.GithubIssueRoute{
				ID: stringPtr(route.ID),
				Match: iw.GithubIssueRouteMatch{
					Kind:         route.MatchKind.ValueString(),
					CostCentreID: stringPtr(route.CostCentreID),
					TagKey:       stringPtr(route.TagKey),
					TagValue:     stringPtr(route.TagValue),
				},
				Repo: iw.GithubRepoRef{
					InstallationID: route.InstallationID.ValueInt64(),
					FullName:       route.Repository.ValueString(),
				},
				Labels:    routeLabels,
				Assignees: routeAssignees,
			})
		}
	}

	if !m.IacSource.IsNull() && !m.IacSource.IsUnknown() {
		var sources []githubIacSourceModel
		diags.Append(m.IacSource.ElementsAs(ctx, &sources, false)...)
		for _, source := range sources {
			input.IacSources = append(input.IacSources, iw.GithubIacSource{
				ID:           stringPtr(source.ID),
				IacAccountID: stringPtr(source.IacAccountID),
				Repo: iw.GithubRepoRef{
					InstallationID: source.InstallationID.ValueInt64(),
					FullName:       source.Repository.ValueString(),
				},
				BaseBranch: stringPtr(source.BaseBranch),
				Directory:  source.Directory.ValueString(),
			})
		}
	}

	return input, diags
}

// githubIssueSettingsStateFrom maps the stored document back into state.
//
// Everything the document carries is surfaced. Anything this failed to read
// back would be written away on the next apply, because the write is a
// whole-document replacement.
func githubIssueSettingsStateFrom(ctx context.Context, orgID string, s *iw.GithubIssueSettings) (githubIssueSettingsResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	out := githubIssueSettingsResourceModel{
		ID:                    types.StringValue(orgID),
		Enabled:               types.BoolValue(s.Enabled),
		DefaultInstallationID: types.Int64Null(),
		DefaultRepository:     types.StringNull(),
		ResolveAction:         types.StringValue(s.ResolveAction),
		PullRequestsEnabled:   types.BoolValue(s.PullRequestsEnabled),
		UpdatedAt:             stringValue(s.UpdatedAt),
	}
	if s.DefaultRepo != nil {
		out.DefaultInstallationID = types.Int64Value(s.DefaultRepo.InstallationID)
		out.DefaultRepository = types.StringValue(s.DefaultRepo.FullName)
	}

	var d diag.Diagnostics
	out.Labels, d = stringList(ctx, s.Labels)
	diags.Append(d...)
	out.Assignees, d = stringList(ctx, s.Assignees)
	diags.Append(d...)

	routes := make([]githubIssueRouteModel, 0, len(s.Routes))
	for _, route := range s.Routes {
		labels, d := stringList(ctx, route.Labels)
		diags.Append(d...)
		assignees, d := stringList(ctx, route.Assignees)
		diags.Append(d...)

		model := githubIssueRouteModel{
			ID:             stringValue(route.ID),
			MatchKind:      types.StringValue(route.Match.Kind),
			CostCentreID:   types.StringNull(),
			TagKey:         types.StringNull(),
			TagValue:       types.StringNull(),
			InstallationID: types.Int64Value(route.Repo.InstallationID),
			Repository:     types.StringValue(route.Repo.FullName),
			Labels:         labels,
			Assignees:      assignees,
		}
		// Only the active branch's fields are surfaced, so a cost-centre route
		// never reads back a stray tag key, and vice versa.
		switch route.Match.Kind {
		case "cost_centre":
			model.CostCentreID = stringValue(route.Match.CostCentreID)
		case "tag":
			model.TagKey = stringValue(route.Match.TagKey)
			model.TagValue = stringValue(route.Match.TagValue)
		}
		routes = append(routes, model)
	}
	out.Route, d = types.ListValueFrom(ctx, githubIssueRouteObjectType, routes)
	diags.Append(d...)

	sources := make([]githubIacSourceModel, 0, len(s.IacSources))
	for _, source := range s.IacSources {
		sources = append(sources, githubIacSourceModel{
			ID:             stringValue(source.ID),
			IacAccountID:   stringValue(source.IacAccountID),
			InstallationID: types.Int64Value(source.Repo.InstallationID),
			Repository:     types.StringValue(source.Repo.FullName),
			BaseBranch:     stringValue(source.BaseBranch),
			Directory:      types.StringValue(source.Directory),
		})
	}
	out.IacSource, d = types.ListValueFrom(ctx, githubIacSourceObjectType, sources)
	diags.Append(d...)

	return out, diags
}
