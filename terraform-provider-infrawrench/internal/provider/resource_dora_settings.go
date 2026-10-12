package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*doraSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*doraSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*doraSettingsResource)(nil)
)

// NewDoraSettingsResource constructs the infrawrench_dora_settings resource.
func NewDoraSettingsResource() resource.Resource { return &doraSettingsResource{} }

type doraSettingsResource struct{ client *iw.Client }

type doraSettingsResourceModel struct {
	ID                     types.String `tfsdk:"id"`
	FailureWindowHours     types.Int64  `tfsdk:"failure_window_hours"`
	ProductionEnvironments types.List   `tfsdk:"production_environments"`
	PipelinePatterns       types.List   `tfsdk:"pipeline_patterns"`
	CountFailedDeploys     types.Bool   `tfsdk:"count_failed_deploys"`
	IncludeResourceChanges types.Bool   `tfsdk:"include_resource_changes"`
	DigestEnabled          types.Bool   `tfsdk:"digest_enabled"`
}

func (r *doraSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_dora_settings"
}

func (r *doraSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	patternNote := " Each pattern is matched case-insensitively and `*` is the only wildcard. " +
		"The server trims patterns and drops duplicates, so write each once and without " +
		"surrounding spaces, or the saved list will differ from the configuration."
	resp.Schema = schema.Schema{
		MarkdownDescription: "How the organization's DORA metrics (the Delivery page, `infrawrench dora`, the " +
			"weekly digest's Delivery line) decide what is production and what counts as a failed change.\n\n" +
			"An organization **singleton**. There is no DELETE on this route, so `terraform destroy` leaves " +
			"the stored settings as they are.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("DORA settings"),
			"failure_window_hours": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "Hours after a production change in which a declared incident or a rollback " +
					"counts the change as failed, 1-720. An incident is blamed on the most recent matching change " +
					"in the window only.",
				Validators: []validatorInt64{between(1, 720)},
			},
			"production_environments": schema.ListAttribute{
				Required:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Environment names that count as production, 1-50 patterns of 1-100 " +
					"characters, e.g. `[\"production\", \"prod*\"]`." + patternNote,
				Validators: []validatorList{sizeBetween(1, 50), elementsLengthBetween(1, 100)},
			},
			"pipeline_patterns": schema.ListAttribute{
				Required:    true,
				ElementType: types.StringType,
				MarkdownDescription: "CI pipeline names whose runs count as deploys (Buildkite, CircleCI, GitLab " +
					"and Bitbucket runs are only counted when they match), at most 50 patterns of 1-100 " +
					"characters. `[]` counts no pipeline runs." + patternNote,
				Validators: []validatorList{sizeAtMost(50), elementsLengthBetween(1, 100)},
			},
			"count_failed_deploys": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Count a production deploy that itself failed as a failed change.",
			},
			"include_resource_changes": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Count changes observed by sync (the change timeline: console edits, drift) " +
					"as changes too. A reverted one counts as failed.",
			},
			"digest_enabled": schema.BoolAttribute{
				Required:            true,
				MarkdownDescription: "Include the Delivery line in the weekly digest.",
			},
		},
	}
}

func (r *doraSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *doraSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan doraSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *doraSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state doraSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetDoraSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read DORA settings", err.Error())
		return
	}

	refreshed, diags := doraSettingsStateFrom(ctx, r.client.OrgID(), remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *doraSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan doraSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete is a no-op. See the schema description.
func (r *doraSettingsResource) Delete(_ context.Context, _ resource.DeleteRequest, _ *resource.DeleteResponse) {
}

func (r *doraSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *doraSettingsResource) write(ctx context.Context, plan doraSettingsResourceModel, diags *diagnostics, state *tfState) {
	production, d := stringSlice(ctx, plan.ProductionEnvironments)
	diags.Append(d...)
	pipelines, d := stringSlice(ctx, plan.PipelinePatterns)
	diags.Append(d...)
	if diags.HasError() {
		return
	}

	saved, err := r.client.PutDoraSettings(ctx, iw.DoraSettingsUpdate{
		FailureWindowHours:     int64Ptr(plan.FailureWindowHours),
		ProductionEnvironments: production,
		PipelinePatterns:       &pipelines,
		CountFailedDeploys:     boolPtr(plan.CountFailedDeploys),
		IncludeResourceChanges: boolPtr(plan.IncludeResourceChanges),
		DigestEnabled:          boolPtr(plan.DigestEnabled),
	})
	if err != nil {
		diags.AddError("Unable to write DORA settings", err.Error())
		return
	}

	next, d := doraSettingsStateFrom(ctx, r.client.OrgID(), saved)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	diags.Append(state.Set(ctx, &next)...)
}

// doraSettingsStateFrom maps the stored settings into state. Both lists are
// always present on the wire, so they map with stringList (`[]` stays `[]`).
func doraSettingsStateFrom(ctx context.Context, orgID string, remote *iw.DoraSettings) (doraSettingsResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	production, d := stringList(ctx, remote.ProductionEnvironments)
	diags.Append(d...)
	pipelines, d := stringList(ctx, remote.PipelinePatterns)
	diags.Append(d...)

	return doraSettingsResourceModel{
		ID:                     types.StringValue(orgID),
		FailureWindowHours:     types.Int64Value(remote.FailureWindowHours),
		ProductionEnvironments: production,
		PipelinePatterns:       pipelines,
		CountFailedDeploys:     types.BoolValue(remote.CountFailedDeploys),
		IncludeResourceChanges: types.BoolValue(remote.IncludeResourceChanges),
		DigestEnabled:          types.BoolValue(remote.DigestEnabled),
	}, diags
}
