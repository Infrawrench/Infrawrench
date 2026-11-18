package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/resourcevalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                     = (*heartbeatResource)(nil)
	_ resource.ResourceWithConfigure        = (*heartbeatResource)(nil)
	_ resource.ResourceWithImportState      = (*heartbeatResource)(nil)
	_ resource.ResourceWithConfigValidators = (*heartbeatResource)(nil)
)

// NewHeartbeatResource constructs the infrawrench_heartbeat resource.
func NewHeartbeatResource() resource.Resource { return &heartbeatResource{} }

type heartbeatResource struct{ client *iw.Client }

type heartbeatResourceModel struct {
	ID              types.String `tfsdk:"id"`
	Name            types.String `tfsdk:"name"`
	CronExpression  types.String `tfsdk:"cron_expression"`
	Timezone        types.String `tfsdk:"timezone"`
	IntervalMinutes types.Int64  `tfsdk:"interval_minutes"`
	GraceMinutes    types.Int64  `tfsdk:"grace_minutes"`
	Enabled         types.Bool   `tfsdk:"enabled"`
	ResourceID      types.String `tfsdk:"resource_id"`
	FieldKey        types.String `tfsdk:"field_key"`

	PingURL   types.String `tfsdk:"ping_url"`
	Status    types.String `tfsdk:"status"`
	AccountID types.String `tfsdk:"account_id"`
}

func (r *heartbeatResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_heartbeat"
}

func (r *heartbeatResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A heartbeat monitor for a scheduled job. The job pings `ping_url` each time it " +
			"runs (`/start` before, `/fail` on failure); when a ping is later than the schedule plus " +
			"`grace_minutes`, the heartbeat goes `down` and raises a `heartbeatAlerts` notification.\n\n" +
			"Set exactly one of `cron_expression` (read in `timezone`) and `interval_minutes`. A heartbeat " +
			"stays `new` until its first ping, so it never alerts before the job has been wired up.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned heartbeat id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1 to 120 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
			},
			"cron_expression": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Five-field cron the job runs on, e.g. `0 2 * * *`. The server refuses an " +
					"expression it cannot read, or one that never fires.",
			},
			"timezone": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("UTC"),
				MarkdownDescription: "IANA time zone `cron_expression` is read in. Defaults to `UTC`.",
			},
			"interval_minutes": schema.Int64Attribute{
				Optional: true,
				MarkdownDescription: "Minutes between expected pings, for a job on a fixed interval, 1 to 44640 " +
					"(31 days).",
				Validators: []validatorInt64{between(1, 44640)},
			},
			"grace_minutes": schema.Int64Attribute{
				Optional:            true,
				Computed:            true,
				Default:             int64default.StaticInt64(10),
				MarkdownDescription: "How late a ping may be before the heartbeat goes down, 1 to 10080 minutes.",
				Validators:          []validatorInt64{between(1, 10080)},
			},
			"enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "False pauses the heartbeat. Resuming returns it to `new` until the next ping.",
			},
			"resource_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "The scheduled Infrawrench resource this heartbeat watches; use " +
					"`data.infrawrench_resources` to resolve one. Advisory rather than a foreign key, and recorded " +
					"at creation only: the update route does not carry it, so changing it replaces the heartbeat.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"field_key": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "The resource field the schedule was read from. Create-only, like " +
					"`resource_id`.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},

			"ping_url": schema.StringAttribute{
				Computed:  true,
				Sensitive: true,
				MarkdownDescription: "The secret URL the job pings. Anyone holding it can record pings, so it is " +
					"marked sensitive; replace it from the app if it leaks.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"status": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "`new` until the first ping, `up` after a success, `down` after a missed deadline or a `/fail` ping.",
			},
			"account_id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Account of the linked resource, when there is one.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *heartbeatResource) ConfigValidators(_ context.Context) []resource.ConfigValidator {
	return []resource.ConfigValidator{
		resourcevalidator.ExactlyOneOf(
			path.MatchRoot("cron_expression"),
			path.MatchRoot("interval_minutes"),
		),
	}
}

func (r *heartbeatResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// scheduleOf is the schedule half of a body, from the plan: a cron
// expression with its zone, or an interval.
func scheduleOf(plan heartbeatResourceModel) (kind string, cron *string, zone *string, interval *int64) {
	if !plan.CronExpression.IsNull() && !plan.CronExpression.IsUnknown() {
		return "cron", stringPtr(plan.CronExpression), stringPtr(plan.Timezone), nil
	}
	return "interval", nil, nil, int64Ptr(plan.IntervalMinutes)
}

func (r *heartbeatResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan heartbeatResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	kind, cron, zone, interval := scheduleOf(plan)
	created, err := r.client.CreateHeartbeat(ctx, iw.HeartbeatCreate{
		Name:            plan.Name.ValueString(),
		ScheduleKind:    kind,
		CronExpression:  cron,
		Timezone:        zone,
		IntervalMinutes: interval,
		GraceMinutes:    int64Ptr(plan.GraceMinutes),
		Enabled:         boolPtr(plan.Enabled),
		ResourceID:      stringPtr(plan.ResourceID),
		FieldKey:        stringPtr(plan.FieldKey),
	})
	if err != nil {
		resp.Diagnostics.AddError("Unable to create heartbeat", err.Error())
		return
	}

	state := heartbeatStateFrom(created, plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *heartbeatResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state heartbeatResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetHeartbeat(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read heartbeat", err.Error())
		return
	}

	refreshed := heartbeatStateFrom(remote, state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

// Update sends every mutable field: the route treats an omitted key as "leave
// it alone", and a practitioner who deletes an attribute means "put it back to
// the default", which the schema's defaults have already filled in.
func (r *heartbeatResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan heartbeatResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state heartbeatResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	kind, cron, zone, interval := scheduleOf(plan)
	updated, err := r.client.UpdateHeartbeat(ctx, state.ID.ValueString(), iw.HeartbeatUpdate{
		Name:            stringPtr(plan.Name),
		ScheduleKind:    &kind,
		CronExpression:  cron,
		Timezone:        zone,
		IntervalMinutes: interval,
		GraceMinutes:    int64Ptr(plan.GraceMinutes),
		Enabled:         boolPtr(plan.Enabled),
	})
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Heartbeat no longer exists",
				"The heartbeat was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update heartbeat", err.Error())
		return
	}

	next := heartbeatStateFrom(updated, plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *heartbeatResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state heartbeatResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteHeartbeat(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete heartbeat", err.Error())
	}
}

func (r *heartbeatResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// heartbeatStateFrom maps the server's row. `field_key` is kept from prior
// (plan or state) when the server has none to report, since it is only
// recorded alongside a resource.
func heartbeatStateFrom(remote *iw.Heartbeat, prior heartbeatResourceModel) heartbeatResourceModel {
	model := heartbeatResourceModel{
		ID:              types.StringValue(remote.ID),
		Name:            types.StringValue(remote.Name),
		CronExpression:  types.StringNull(),
		Timezone:        types.StringValue(remote.Timezone),
		IntervalMinutes: types.Int64Null(),
		GraceMinutes:    types.Int64Value(remote.GraceMinutes),
		Enabled:         types.BoolValue(remote.Enabled),
		ResourceID:      stringValue(remote.ResourceID),
		FieldKey:        stringValue(remote.FieldKey),
		PingURL:         types.StringValue(remote.PingURL),
		Status:          types.StringValue(remote.Status),
		AccountID:       stringValue(remote.AccountID),
	}
	if remote.ScheduleKind == "cron" {
		model.CronExpression = stringValue(remote.CronExpression)
	} else {
		model.IntervalMinutes = int64Value(remote.IntervalMinutes)
	}
	if model.FieldKey.IsNull() && !prior.FieldKey.IsUnknown() {
		model.FieldKey = prior.FieldKey
	}
	return model
}
