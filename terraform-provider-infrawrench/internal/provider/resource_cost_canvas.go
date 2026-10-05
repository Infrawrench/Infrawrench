package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*costCanvasResource)(nil)
	_ resource.ResourceWithConfigure   = (*costCanvasResource)(nil)
	_ resource.ResourceWithImportState = (*costCanvasResource)(nil)
)

// NewCostCanvasResource constructs the infrawrench_cost_canvas resource.
func NewCostCanvasResource() resource.Resource { return &costCanvasResource{} }

type costCanvasResource struct{ client *iw.Client }

type costCanvasResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	SpecJSON    types.String `tfsdk:"spec_json"`
}

func (r *costCanvasResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_cost_canvas"
}

func (r *costCanvasResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A cost canvas: a report page of narrative text, KPIs, charts and tables, laid out as " +
			"one document.\n\n" +
			"Canvases are normally built by describing the report you want to the in-app assistant, " +
			"which writes the spec for you. This resource is for the step after that: keeping a canvas " +
			"somebody has already vetted in code, so it is reviewed like any other change and cannot " +
			"drift. A practical way to start is to build the canvas in the app, then `terraform import` " +
			"it and copy the spec out of state.\n\n" +
			"The spec stores queries, never numbers. Opening or delivering the canvas re-runs every " +
			"block against current spend, so the configuration does not change as the figures do.\n\n" +
			"Destroying the resource deletes the canvas, which also removes it from any dashboard that " +
			"embeds it.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned canvas id. Use it with `terraform import`, and as " +
				"`cost_canvas_id` on `infrawrench_cost_canvas_notification` or `object_id` on " +
				"`infrawrench_object_sharing`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1-120 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free-text description shown under the name, at most 1000 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(0, 1000)},
			},
			"spec_json": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The canvas spec as a JSON object, usually written with `jsonencode({...})` " +
					"or read from a file with `file()`. It has a `version` (currently `1`) and up to 24 " +
					"`blocks`, each with a caller-chosen `id` and a `kind` of `text`, `kpi`, `chart`, " +
					"`table`, `budgets`, `anomalies`, `cost_report` or `custom_graph`. A text block can quote " +
					"a KPI's figure as `{{kpi_id}}`; the last three kinds embed existing objects by id, such " +
					"as `infrawrench_cost_report.x.id` or `infrawrench_budget.x.id`.\n\n" +
					"The server validates the spec strictly: an unknown key anywhere, a missing field or a " +
					"25th block is rejected with an HTTP 400 at apply time, and there is no field that takes " +
					"a free-form query or SQL. The provider only checks at plan time that the value is a " +
					"JSON object. The simplest way to get a valid spec is to import a canvas built in the " +
					"app.\n\n" +
					"Compared as JSON rather than as text, so reformatting or reordering keys does not " +
					"register as a change on refresh.",
				Validators: []validatorString{jsonObjectString{}},
			},
		},
	}
}

func (r *costCanvasResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *costCanvasResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan costCanvasResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := costCanvasInputFrom(plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateCostCanvas(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create cost canvas", err.Error())
		return
	}

	state := costCanvasStateFrom(created, plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Read refreshes the canvas. A deleted canvas is soft-deleted server-side, and
// the single GET 404s for it exactly as for a canvas that never existed.
func (r *costCanvasResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state costCanvasResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetCostCanvas(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read cost canvas", err.Error())
		return
	}

	refreshed := costCanvasStateFrom(remote, state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *costCanvasResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan costCanvasResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state costCanvasResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := costCanvasInputFrom(plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateCostCanvas(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Cost canvas no longer exists",
				"The canvas was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update cost canvas", err.Error())
		return
	}

	next := costCanvasStateFrom(updated, plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *costCanvasResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state costCanvasResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteCostCanvas(ctx, state.ID.ValueString()); err != nil && !iw.IsNotFound(err) {
		resp.Diagnostics.AddError("Unable to delete cost canvas", err.Error())
	}
}

func (r *costCanvasResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// costCanvasInputFrom maps configuration onto the POST/PUT body. The spec is
// sent as the configured JSON, unchanged: the server is the validator of record.
func costCanvasInputFrom(model costCanvasResourceModel) (iw.CostCanvasInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	spec := model.SpecJSON.ValueString()
	if !json.Valid([]byte(spec)) {
		diags.AddAttributeError(path.Root("spec_json"), "Invalid canvas spec", "`spec_json` is not valid JSON.")
		return iw.CostCanvasInput{}, diags
	}
	return iw.CostCanvasInput{
		Name:        model.Name.ValueString(),
		Description: stringPtr(model.Description),
		Spec:        json.RawMessage(spec),
	}, diags
}

// costCanvasStateFrom maps a server canvas into state.
//
// spec_json keeps the prior string (the plan on create and update, the state on
// refresh) whenever the server's spec is the same JSON value. Writing the
// server's bytes instead would turn every difference in whitespace or key order
// into a diff that applying could never clear. Only a real change, made in the
// app or by the assistant, replaces it with the server's compact form.
func costCanvasStateFrom(remote *iw.CostCanvas, prior costCanvasResourceModel) costCanvasResourceModel {
	spec := string(remote.Spec)
	if !prior.SpecJSON.IsNull() && !prior.SpecJSON.IsUnknown() &&
		jsonSemanticallyEqual(prior.SpecJSON.ValueString(), spec) {
		spec = prior.SpecJSON.ValueString()
	}
	return costCanvasResourceModel{
		ID:          types.StringValue(remote.ID),
		Name:        types.StringValue(remote.Name),
		Description: stringValue(remote.Description),
		SpecJSON:    types.StringValue(spec),
	}
}

// jsonSemanticallyEqual reports whether two JSON documents decode to the same
// value. Key order and whitespace are ignored, and so are object keys whose
// value is null: an optional field written as null and one left out mean the
// same thing to the server, and it may echo either.
func jsonSemanticallyEqual(a, b string) bool {
	var av, bv any
	if err := json.Unmarshal([]byte(a), &av); err != nil {
		return false
	}
	if err := json.Unmarshal([]byte(b), &bv); err != nil {
		return false
	}
	return reflect.DeepEqual(dropJSONNulls(av), dropJSONNulls(bv))
}

func dropJSONNulls(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, child := range t {
			if child == nil {
				continue
			}
			out[k] = dropJSONNulls(child)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, child := range t {
			out[i] = dropJSONNulls(child)
		}
		return out
	default:
		return v
	}
}

// jsonObjectString fails a string that is not a JSON object, at plan time.
// Anything deeper is left to the server, whose validation is strict and
// authoritative; duplicating it here would only be a copy that goes stale.
type jsonObjectString struct{}

var _ validator.String = jsonObjectString{}

func (jsonObjectString) Description(_ context.Context) string {
	return "value must be a JSON object"
}

func (v jsonObjectString) MarkdownDescription(ctx context.Context) string {
	return v.Description(ctx)
}

func (jsonObjectString) ValidateString(_ context.Context, req validator.StringRequest, resp *validator.StringResponse) {
	if req.ConfigValue.IsNull() || req.ConfigValue.IsUnknown() {
		return
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(req.ConfigValue.ValueString()), &obj); err != nil || obj == nil {
		detail := "the value is not a JSON object"
		if err != nil {
			detail = err.Error()
		}
		resp.Diagnostics.AddAttributeError(req.Path, "Invalid JSON object",
			fmt.Sprintf("Expected a JSON object, such as the output of jsonencode({...}): %s.", detail))
	}
}
