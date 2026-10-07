package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*prCheckRepositoryResource)(nil)
	_ resource.ResourceWithConfigure   = (*prCheckRepositoryResource)(nil)
	_ resource.ResourceWithImportState = (*prCheckRepositoryResource)(nil)
)

const (
	prCheckMaxDirectories     = 20
	prCheckMaxDirectoryLength = 255
	prCheckMaxCostThreshold   = 10_000_000
)

var prCheckThresholdConclusions = []string{"neutral", "failure"}

// NewPrCheckRepositoryResource constructs the infrawrench_pr_check_repository resource.
func NewPrCheckRepositoryResource() resource.Resource { return &prCheckRepositoryResource{} }

type prCheckRepositoryResource struct{ client *iw.Client }

type prCheckRepositoryResourceModel struct {
	ID                  types.String  `tfsdk:"id"`
	InstallationID      types.Int64   `tfsdk:"installation_id"`
	Repository          types.String  `tfsdk:"repository"`
	Enabled             types.Bool    `tfsdk:"enabled"`
	CommentEnabled      types.Bool    `tfsdk:"comment_enabled"`
	CostThreshold       types.Float64 `tfsdk:"cost_threshold"`
	ThresholdConclusion types.String  `tfsdk:"threshold_conclusion"`
	Directories         types.List    `tfsdk:"directories"`
}

func (r *prCheckRepositoryResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_pr_check_repository"
}

func (r *prCheckRepositoryResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Pull request checks on one GitHub repository: on every new commit of an open pull " +
			"request, Infrawrench posts a check run with the estimated monthly cost change of the Terraform " +
			"it adds, edits or removes, the blast radius of every existing resource it touches, and " +
			"right-sizing, tag policy and posture warnings.\n\n" +
			"Checks are posted by the organization's GitHub App, as the app, so there is no token here. The " +
			"repository is named by the `installation_id` of a GitHub App installation connected to the " +
			"organization plus its `owner/name`; both come from the organization's `/github/repos` listing " +
			"(the repository picker under **Settings, Pull Request Checks** reads the same list). The " +
			"installation must have approved the app's **Checks: read and write**, **Pull requests: read** " +
			"(read and write for `comment_enabled`) and **Contents: read** permissions; the settings page " +
			"shows which are missing.\n\n" +
			"Existing resources are matched through the Terraform state uploaded to IaC reconciliation, so a " +
			"repository whose state has not been uploaded gets cost estimates from the code alone and no " +
			"blast radius for edits.\n\n" +
			"Reading needs `iac:read`; changing anything needs `org:settings:write`. `terraform destroy` " +
			"turns the checks off and deletes the repository's check history; checks already posted on " +
			"GitHub stay there.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned id. Use it with `terraform import`."),
			"installation_id": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "The GitHub App installation that reaches `repository`, as listed by " +
					"`/github/repos`.",
				Validators: []validatorInt64{atLeast(1)},
			},
			"repository": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The repository, as `owner/name`, 3-201 characters. One resource per " +
					"repository: a second resource naming the same repository is refused.",
				Validators: githubRepositoryValidators(),
			},
			"enabled": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
				MarkdownDescription: "Post checks on this repository's pull requests. Defaults to true; " +
					"false keeps the settings without posting.",
			},
			"comment_enabled": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(false),
				MarkdownDescription: "Also keep one summary comment on each pull request that changes " +
					"infrastructure, edited in place on every push rather than posted again. Defaults to " +
					"false.",
			},
			"cost_threshold": schema.Float64Attribute{
				Optional: true,
				MarkdownDescription: "Monthly cost increase, between 0 and 10000000 in the estimate's " +
					"currency (USD for every provider that prices today), above which the check concludes " +
					"`threshold_conclusion` instead of success. Omit it for no threshold. An increase that " +
					"could not be priced never trips it.",
				Validators: []validatorFloat64{betweenFloat(0, prCheckMaxCostThreshold)},
			},
			"threshold_conclusion": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("neutral"),
				MarkdownDescription: "What the check concludes above `cost_threshold`: `neutral` (the " +
					"default) flags it without blocking, `failure` fails the check, which blocks merging " +
					"where branch protection requires it.",
				Validators: []validatorString{oneOfValidator(prCheckThresholdConclusions...)},
			},
			"directories": schema.ListAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				Default:     emptyStringListDefault(),
				MarkdownDescription: "Path prefixes the check looks in, up to 20, each 1-255 characters, " +
					"without leading or trailing slashes (`infra/prod`). Empty, the default, covers the " +
					"whole repository.",
				Validators: []validatorList{
					sizeAtMost(prCheckMaxDirectories),
					elementsLengthBetween(1, prCheckMaxDirectoryLength),
				},
			},
		},
	}
}

func (r *prCheckRepositoryResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *prCheckRepositoryResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan prCheckRepositoryResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := prCheckRepositoryInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreatePrCheckRepository(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to turn on pull request checks", err.Error())
		return
	}

	state, diags := prCheckRepositoryStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *prCheckRepositoryResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state prCheckRepositoryResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetPrCheckRepository(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read pull request check settings", err.Error())
		return
	}

	refreshed, diags := prCheckRepositoryStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *prCheckRepositoryResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan prCheckRepositoryResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state prCheckRepositoryResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := prCheckRepositoryInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdatePrCheckRepository(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Pull request check settings no longer exist",
				"The repository's checks were removed outside Terraform. They have been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update pull request check settings", err.Error())
		return
	}

	next, diags := prCheckRepositoryStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *prCheckRepositoryResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state prCheckRepositoryResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeletePrCheckRepository(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to turn off pull request checks", err.Error())
	}
}

func (r *prCheckRepositoryResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func prCheckRepositoryInputFrom(ctx context.Context, model prCheckRepositoryResourceModel) (iw.PrCheckRepositoryInput, diag.Diagnostics) {
	directories, diags := stringSlice(ctx, model.Directories)
	if directories == nil {
		directories = []string{}
	}
	return iw.PrCheckRepositoryInput{
		InstallationID:      model.InstallationID.ValueInt64(),
		Repo:                model.Repository.ValueString(),
		Enabled:             model.Enabled.ValueBool(),
		CommentEnabled:      model.CommentEnabled.ValueBool(),
		CostThreshold:       float64Ptr(model.CostThreshold),
		ThresholdConclusion: model.ThresholdConclusion.ValueString(),
		Directories:         directories,
	}, diags
}

func prCheckRepositoryStateFrom(ctx context.Context, remote *iw.PrCheckRepository) (prCheckRepositoryResourceModel, diag.Diagnostics) {
	directories, diags := stringList(ctx, remote.Directories)
	return prCheckRepositoryResourceModel{
		ID:                  types.StringValue(remote.ID),
		InstallationID:      types.Int64Value(remote.InstallationID),
		Repository:          types.StringValue(remote.Repo),
		Enabled:             types.BoolValue(remote.Enabled),
		CommentEnabled:      types.BoolValue(remote.CommentEnabled),
		CostThreshold:       float64Value(remote.CostThreshold),
		ThresholdConclusion: types.StringValue(remote.ThresholdConclusion),
		Directories:         directories,
	}, diags
}
