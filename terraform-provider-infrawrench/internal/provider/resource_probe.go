package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*probeResource)(nil)
	_ resource.ResourceWithConfigure   = (*probeResource)(nil)
	_ resource.ResourceWithImportState = (*probeResource)(nil)
)

// NewProbeResource constructs the infrawrench_probe resource.
func NewProbeResource() resource.Resource { return &probeResource{} }

type probeResource struct{ client *iw.Client }

type probeResourceModel struct {
	ID               types.String `tfsdk:"id"`
	Name             types.String `tfsdk:"name"`
	URL              types.String `tfsdk:"url"`
	Method           types.String `tfsdk:"method"`
	IntervalSeconds  types.Int64  `tfsdk:"interval_seconds"`
	TimeoutMs        types.Int64  `tfsdk:"timeout_ms"`
	FailureThreshold types.Int64  `tfsdk:"failure_threshold"`
	Enabled          types.Bool   `tfsdk:"enabled"`
	ResourceID       types.String `tfsdk:"resource_id"`
	OutputKey        types.String `tfsdk:"output_key"`

	Status    types.String `tfsdk:"status"`
	AccountID types.String `tfsdk:"account_id"`
}

var probeMethods = []string{"GET", "HEAD", "OPTIONS"}

func (r *probeResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_probe"
}

func (r *probeResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "An HTTP check run from the edge against a URL, which flips to `down` after enough " +
			"consecutive failures and raises a `probeAlerts` notification.\n\n" +
			"A probe is what `infrawrench_status_page` puts on a public page, so the two go together: the " +
			"probe decides what is checked, the page decides what the public is told about it.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned probe id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Internal name. The public page can show a different label.",
			},
			"url": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Absolute `http(s)` URL the check hits.",
			},
			"method": schema.StringAttribute{
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("GET"),
				MarkdownDescription: "One of `" + joinBackticked(probeMethods) + "`. Defaults to `GET`.",
				Validators:          []validatorString{oneOfValidator(probeMethods...)},
			},
			"interval_seconds": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				Default:  int64default.StaticInt64(60),
				MarkdownDescription: "Seconds between checks. Clamped server-side to 60–86400, so a value outside " +
					"that range is stored as the nearest bound rather than rejected — which would read as " +
					"permanent drift against the configuration. Keep it in range.",
			},
			"timeout_ms": schema.Int64Attribute{
				Optional:            true,
				Computed:            true,
				Default:             int64default.StaticInt64(10000),
				MarkdownDescription: "Per-check timeout in milliseconds. Clamped server-side to 1000–60000.",
			},
			"failure_threshold": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				Default:  int64default.StaticInt64(3),
				MarkdownDescription: "Consecutive failures before the probe flips to `down` and notifies. Clamped " +
					"server-side to 1–20.",
			},
			"enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "A paused probe keeps its history and stops checking.",
			},
			"resource_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Link the probe to the Infrawrench resource whose output the URL came from — " +
					"use `data.infrawrench_resources` to resolve one. Advisory rather than a foreign key, and " +
					"recorded at creation only: the update route does not carry it, so changing it replaces " +
					"the probe.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"output_key": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "The resource output or field key the URL was taken from. Create-only, like " +
					"`resource_id`.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},

			"status": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "`unknown` until the first result, `down` after `failure_threshold` " +
					"consecutive failures, `up` on any success.",
			},
			"account_id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Account of the linked resource, when the URL came from one.",
			},
		},
	}
}

func (r *probeResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *probeResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan probeResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateProbe(ctx, iw.SyntheticProbeCreate{
		Name:             plan.Name.ValueString(),
		URL:              plan.URL.ValueString(),
		Method:           stringPtr(plan.Method),
		IntervalSeconds:  int64Ptr(plan.IntervalSeconds),
		TimeoutMs:        int64Ptr(plan.TimeoutMs),
		FailureThreshold: int64Ptr(plan.FailureThreshold),
		Enabled:          boolPtr(plan.Enabled),
		ResourceID:       stringPtr(plan.ResourceID),
		OutputKey:        stringPtr(plan.OutputKey),
	})
	if err != nil {
		resp.Diagnostics.AddError("Unable to create probe", err.Error())
		return
	}

	state := probeStateFrom(created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *probeResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state probeResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetProbe(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read probe", err.Error())
		return
	}

	refreshed := probeStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

// Update sends every mutable field.
//
// The route treats an omitted key as "leave it alone", which for Terraform is
// the wrong default: a practitioner who deletes an attribute means "put it back
// to the default", and the schema's Computed defaults have already filled that
// in by the time the plan reaches here.
func (r *probeResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan probeResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state probeResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateProbe(ctx, state.ID.ValueString(), iw.SyntheticProbeUpdate{
		Name:             stringPtr(plan.Name),
		URL:              stringPtr(plan.URL),
		Method:           stringPtr(plan.Method),
		IntervalSeconds:  int64Ptr(plan.IntervalSeconds),
		TimeoutMs:        int64Ptr(plan.TimeoutMs),
		FailureThreshold: int64Ptr(plan.FailureThreshold),
		Enabled:          boolPtr(plan.Enabled),
	})
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Probe no longer exists",
				"The probe was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update probe", err.Error())
		return
	}

	next := probeStateFrom(updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete removes the probe. Any status page component pointing at it goes with
// it, so a page managed by `infrawrench_status_page` will show the component
// gone on its next refresh.
func (r *probeResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state probeResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteProbe(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete probe", err.Error())
	}
}

func (r *probeResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func probeStateFrom(remote *iw.SyntheticProbe) probeResourceModel {
	return probeResourceModel{
		ID:               types.StringValue(remote.ID),
		Name:             types.StringValue(remote.Name),
		URL:              types.StringValue(remote.URL),
		Method:           types.StringValue(remote.Method),
		IntervalSeconds:  types.Int64Value(remote.IntervalSeconds),
		TimeoutMs:        types.Int64Value(remote.TimeoutMs),
		FailureThreshold: types.Int64Value(remote.FailureThreshold),
		Enabled:          types.BoolValue(remote.Enabled),
		ResourceID:       stringValue(remote.ResourceID),
		OutputKey:        stringValue(remote.OutputKey),
		Status:           types.StringValue(remote.Status),
		AccountID:        stringValue(remote.AccountID),
	}
}
