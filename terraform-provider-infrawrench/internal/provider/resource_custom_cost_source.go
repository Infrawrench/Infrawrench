package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*customCostSourceResource)(nil)
	_ resource.ResourceWithConfigure   = (*customCostSourceResource)(nil)
	_ resource.ResourceWithImportState = (*customCostSourceResource)(nil)
)

// NewCustomCostSourceResource constructs the infrawrench_custom_cost_source resource.
func NewCustomCostSourceResource() resource.Resource { return &customCostSourceResource{} }

type customCostSourceResource struct{ client *iw.Client }

type customCostSourceResourceModel struct {
	ID              types.String `tfsdk:"id"`
	Name            types.String `tfsdk:"name"`
	Description     types.String `tfsdk:"description"`
	DefaultCurrency types.String `tfsdk:"default_currency"`
	PluginID        types.String `tfsdk:"plugin_id"`
}

var currencyCodePattern = regexp.MustCompile(`^[A-Z]{3}$`)

func (r *customCostSourceResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_custom_cost_source"
}

func (r *customCostSourceResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A named source of spend Infrawrench has no integration for: a colo bill, a SaaS " +
			"invoice, another tool's FOCUS export. Files are uploaded into it from Settings → Custom Cost " +
			"Sources or with `infrawrench costs push --source <name> --format csv|focus`, and the source " +
			"appears as its own provider in every cost report, filter and budget.\n\n" +
			"Terraform manages the source, not its uploads: uploads are data with a history, and are " +
			"left alone by plan and apply. **Destroying the source deletes every cost row it holds**, " +
			"from every report, budget and export; renaming it relabels that history in place.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned source id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Display name, 1–80 characters, unique in the organization " +
					"(case-insensitively). It is the provider name reports show and what the CLI's " +
					"`--source` resolves.",
				Validators: []validatorString{stringvalidator.LengthBetween(1, 80)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free-text description, up to 500 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 500)},
			},
			"default_currency": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Upper-case ISO 4217 code applied to rows whose file has no currency " +
					"column. Omit it to require every file to carry one.",
				Validators: []validatorString{
					stringvalidator.RegexMatches(currencyCodePattern, "must be an upper-case 3-letter ISO 4217 code"),
				},
			},
			"plugin_id": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The value this source's rows carry in the cost `provider` dimension " +
					"(`custom:<id>`). Use it in budgets, saved filters and allocation rules.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *customCostSourceResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *customCostSourceResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan customCostSourceResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateCustomCostSource(ctx, customCostSourceInputFrom(plan))
	if err != nil {
		resp.Diagnostics.AddError("Unable to create custom cost source", err.Error())
		return
	}
	state := customCostSourceStateFrom(created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *customCostSourceResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state customCostSourceResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetCustomCostSource(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read custom cost source", err.Error())
		return
	}
	refreshed := customCostSourceStateFrom(remote)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *customCostSourceResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan customCostSourceResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state customCostSourceResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateCustomCostSource(ctx, state.ID.ValueString(), customCostSourceInputFrom(plan))
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Custom cost source no longer exists",
				"The source was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update custom cost source", err.Error())
		return
	}
	next := customCostSourceStateFrom(updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *customCostSourceResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state customCostSourceResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteCustomCostSource(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete custom cost source", err.Error())
	}
}

func (r *customCostSourceResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func customCostSourceInputFrom(model customCostSourceResourceModel) iw.CustomCostSourceInput {
	return iw.CustomCostSourceInput{
		Name:            model.Name.ValueString(),
		Description:     stringPtr(model.Description),
		DefaultCurrency: stringPtr(model.DefaultCurrency),
	}
}

// customCostSourceStateFrom maps the server object into state. Every
// configurable attribute round-trips verbatim (the validators reject the
// lower-case currency the server would otherwise upper-case into a diff).
func customCostSourceStateFrom(remote *iw.CustomCostSource) customCostSourceResourceModel {
	return customCostSourceResourceModel{
		ID:              types.StringValue(remote.ID),
		Name:            types.StringValue(remote.Name),
		Description:     stringValue(remote.Description),
		DefaultCurrency: stringValue(remote.DefaultCurrency),
		PluginID:        types.StringValue(remote.PluginID),
	}
}
