package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/mapplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*deployTriggerResource)(nil)
	_ resource.ResourceWithConfigure   = (*deployTriggerResource)(nil)
	_ resource.ResourceWithImportState = (*deployTriggerResource)(nil)
)

// NewDeployTriggerResource constructs the infrawrench_deploy_trigger resource.
func NewDeployTriggerResource() resource.Resource { return &deployTriggerResource{} }

type deployTriggerResource struct{ client *iw.Client }

type deployTriggerResourceModel struct {
	ID      types.String `tfsdk:"id"`
	Repo    types.String `tfsdk:"repo"`
	Branch  types.String `tfsdk:"branch"`
	Env     types.String `tfsdk:"env"`
	Answers types.Map    `tfsdk:"answers"`
	Enabled types.Bool   `tfsdk:"enabled"`
	LastSha types.String `tfsdk:"last_sha"`
}

func (r *deployTriggerResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_deploy_trigger"
}

func (r *deployTriggerResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Redeploys a repository's environment when its branch moves.\n\n" +
			"`enabled` is the **only** mutable field: repo, branch, environment and the stored deploy " +
			"answers are all fixed at creation, so changing any of them replaces the trigger. That is the " +
			"API's shape rather than a choice here, and it is a reasonable one — a trigger pointed at a " +
			"different branch is a different trigger.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned trigger id. Use it with `terraform import` — though an " +
				"imported trigger has no `answers` in state, since no route returns them."),
			"repo": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Repository, as `owner/name`. Must be one the connected GitHub App can see — " +
					"list them at `/deployments/repos`.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"branch": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Branch to watch. A push to it starts a deploy.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"env": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Environment to deploy into, e.g. `production`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"answers": schema.MapAttribute{
				Optional:    true,
				ElementType: types.StringType,
				Sensitive:   true,
				MarkdownDescription: "Stored answers to the deploy questionnaire, keyed by question id — the " +
					"values the plan step would otherwise stop and ask for.\n\n" +
					"Write-only and create-only: no route returns them, so the provider cannot detect drift on " +
					"them, and changing them replaces the trigger. Marked sensitive because deploy answers " +
					"routinely carry connection strings.",
				PlanModifiers: []planmodifier.Map{mapplanmodifier.RequiresReplace()},
			},
			"enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "A disabled trigger keeps its settings and ignores pushes.",
			},

			"last_sha": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "The commit the trigger last deployed, or null if it never has.",
			},
		},
	}
}

func (r *deployTriggerResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *deployTriggerResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan deployTriggerResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	answers, diags := stringMap(ctx, plan.Answers)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateDeployTrigger(ctx, iw.DeployTriggerInput{
		Repo:    plan.Repo.ValueString(),
		Branch:  plan.Branch.ValueString(),
		Env:     plan.Env.ValueString(),
		Answers: answers,
	})
	if err != nil {
		resp.Diagnostics.AddError("Unable to create deploy trigger", err.Error())
		return
	}

	// A trigger is created enabled. Honouring `enabled = false` therefore takes a
	// second call, done here rather than left as a surprise diff on the next plan.
	if !plan.Enabled.ValueBool() {
		created, err = r.client.SetDeployTriggerEnabled(ctx, created.ID, false)
		if err != nil {
			resp.Diagnostics.AddError("Unable to disable the new deploy trigger", err.Error())
			return
		}
	}

	state := deployTriggerStateFrom(created, plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *deployTriggerResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state deployTriggerResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetDeployTrigger(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read deploy trigger", err.Error())
		return
	}

	refreshed := deployTriggerStateFrom(remote, state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *deployTriggerResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan deployTriggerResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state deployTriggerResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.SetDeployTriggerEnabled(ctx, state.ID.ValueString(), plan.Enabled.ValueBool())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Deploy trigger no longer exists",
				"The trigger was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update deploy trigger", err.Error())
		return
	}

	next := deployTriggerStateFrom(updated, plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *deployTriggerResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state deployTriggerResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteDeployTrigger(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete deploy trigger", err.Error())
	}
}

func (r *deployTriggerResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// deployTriggerStateFrom carries `answers` forward from the prior model: they
// are write-only, and refreshing must not drop them out of state.
func deployTriggerStateFrom(remote *iw.DeployTrigger, prior deployTriggerResourceModel) deployTriggerResourceModel {
	return deployTriggerResourceModel{
		ID:      types.StringValue(remote.ID),
		Repo:    types.StringValue(remote.Repo),
		Branch:  types.StringValue(remote.Branch),
		Env:     types.StringValue(remote.Env),
		Answers: prior.Answers,
		Enabled: types.BoolValue(remote.Enabled),
		LastSha: stringValue(remote.LastSha),
	}
}
