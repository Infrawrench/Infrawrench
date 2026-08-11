package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*workflowScheduleResource)(nil)
	_ resource.ResourceWithConfigure   = (*workflowScheduleResource)(nil)
	_ resource.ResourceWithImportState = (*workflowScheduleResource)(nil)
)

// NewWorkflowScheduleResource constructs the infrawrench_workflow_schedule
// resource.
func NewWorkflowScheduleResource() resource.Resource { return &workflowScheduleResource{} }

type workflowScheduleResource struct{ client *iw.Client }

type workflowScheduleResourceModel struct {
	ID         types.String `tfsdk:"id"`
	WorkflowID types.String `tfsdk:"workflow_id"`
	Expression types.String `tfsdk:"expression"`
	Timezone   types.String `tfsdk:"timezone"`
	Enabled    types.Bool   `tfsdk:"enabled"`
	NextRunAt  types.String `tfsdk:"next_run_at"`
}

func (r *workflowScheduleResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_workflow_schedule"
}

func (r *workflowScheduleResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The cron attached to an existing workflow.\n\n" +
			"**The workflow itself is not managed here.** Its definition lives in the workflow editor or " +
			"in a git-backed repository, and neither is written through this API surface — so this " +
			"resource attaches a timetable to a workflow that already exists, addressed by id. Terraform " +
			"owning the schedule but not the code is a deliberate split rather than an oversight: the " +
			"schedule is operational configuration, and the code is code.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("The workflow id. A workflow has at most one schedule, so the two are the " +
				"same identifier — `terraform import` takes the workflow id."),
			"workflow_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The workflow to schedule. Changing it replaces the schedule: there is " +
					"nothing to move, since the route is nested under the workflow.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"expression": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Standard 5-field cron expression — minute, hour, day-of-month, month, " +
					"day-of-week — e.g. `0 9 * * 1` for 09:00 every Monday.\n\n" +
					"Supports `*`, lists, ranges and steps, 3-letter month and weekday names, and `7` as " +
					"Sunday. When both day fields are restricted a date matches if **either** does, which is " +
					"POSIX behaviour and surprises people who expect an AND.",
			},
			"timezone": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "IANA timezone the expression's wall times are evaluated in, e.g. " +
					"`Europe/London`. Omit it for UTC.",
			},
			"enabled": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
				MarkdownDescription: "Mirrors the **workflow's** own enabled flag rather than being a property " +
					"of the schedule — setting it here enables or disables the workflow itself, and a disabled " +
					"workflow never fires however its cron reads.",
			},

			"next_run_at": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The persisted next fire time the scheduler will claim. Null while " +
					"disabled, or when the expression never matches — which is the quickest way to notice a " +
					"cron like `0 0 30 2 *` that can never run.",
			},
		},
	}
}

func (r *workflowScheduleResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *workflowScheduleResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan workflowScheduleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Read refreshes the schedule.
//
// A workflow whose trigger is no longer cron returns a null schedule, which
// iw.Client.GetWorkflowSchedule reports as a 404 — so switching a workflow to a
// manual trigger in the editor makes the next plan a create rather than an
// update against something that is not there.
func (r *workflowScheduleResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state workflowScheduleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetWorkflowSchedule(ctx, state.WorkflowID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read workflow schedule", err.Error())
		return
	}

	refreshed := workflowScheduleStateFrom(state.WorkflowID.ValueString(), remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *workflowScheduleResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan workflowScheduleResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete detaches the cron. The workflow survives — it simply stops firing on a
// timetable, which is what removing a schedule ought to mean.
func (r *workflowScheduleResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state workflowScheduleResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteWorkflowSchedule(ctx, state.WorkflowID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete workflow schedule", err.Error())
	}
}

// ImportState takes the workflow id, which is also this resource's id.
func (r *workflowScheduleResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("workflow_id"), req.ID)...)
}

func (r *workflowScheduleResource) write(ctx context.Context, plan workflowScheduleResourceModel, diags *diag.Diagnostics, state *tfState) {
	workflowID := plan.WorkflowID.ValueString()
	saved, err := r.client.PutWorkflowSchedule(ctx, workflowID, iw.WorkflowScheduleInput{
		Expression: plan.Expression.ValueString(),
		Timezone:   stringPtr(plan.Timezone),
		Enabled:    boolPtr(plan.Enabled),
	})
	if err != nil {
		diags.AddError("Unable to write workflow schedule", err.Error())
		return
	}
	next := workflowScheduleStateFrom(workflowID, saved)
	diags.Append(state.Set(ctx, &next)...)
}

// workflowScheduleStateFrom maps a schedule into state.
//
// `nextRuns` — the preview of upcoming fire times — is deliberately dropped: it
// is recomputed at read time from the current clock, so putting it in state
// would make every refresh a change.
func workflowScheduleStateFrom(workflowID string, remote *iw.WorkflowSchedule) workflowScheduleResourceModel {
	return workflowScheduleResourceModel{
		ID:         types.StringValue(workflowID),
		WorkflowID: types.StringValue(workflowID),
		Expression: types.StringValue(remote.Expression),
		Timezone:   stringValue(remote.Timezone),
		Enabled:    types.BoolValue(remote.Enabled),
		NextRunAt:  stringValue(remote.NextRunAt),
	}
}
