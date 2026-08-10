package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*savedFilterResource)(nil)
	_ resource.ResourceWithConfigure   = (*savedFilterResource)(nil)
	_ resource.ResourceWithImportState = (*savedFilterResource)(nil)
)

// NewSavedFilterResource constructs the infrawrench_saved_filter resource.
func NewSavedFilterResource() resource.Resource { return &savedFilterResource{} }

type savedFilterResource struct{ client *iw.Client }

type savedFilterResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	Query       types.String `tfsdk:"query"`
	Filter      types.List   `tfsdk:"filter"`
}

func (r *savedFilterResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_saved_filter"
}

func (r *savedFilterResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A named, reusable cost filter that budgets, reports, alerts and dashboard " +
			"cards can point at by id.\n\n" +
			"A saved filter has two interchangeable spellings of the same thing: a list of `filter` " +
			"blocks, and a `query` string. Write **one of them**. They are mutually exclusive on the " +
			"wire — sending a query alongside a non-empty filter list is a 400 from the server, not a " +
			"precedence rule the provider can resolve for you.\n\n" +
			"Whichever one you write, the server returns both: it renders a canonical `query` from " +
			"filters and parses `filters` back out of a query. That is why `query` is optional *and* " +
			"computed, and why the `filter` blocks you read back may be ones the server derived " +
			"rather than ones you wrote.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned saved filter id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free text explaining what the filter selects. At most 2000 characters.",
				Validators:          []validator.String{stringvalidator.LengthAtMost(2000)},
			},
			"query": schema.StringAttribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "The filter written as a cost query string, e.g. " +
					"`provider in (aws, gcp) and service not in (Tax)`.\n\n" +
					"Set this **or** `filter` blocks, never both. If you leave it unset the server " +
					"renders it from the `filter` blocks and it becomes a computed, read-only value.",
			},
		},
		Blocks: map[string]schema.Block{
			"filter": costFilterBlockSchema("Filter clauses, ANDed together. Leave these out if you " +
				"set `query` instead; the server will parse the query into clauses and return them here."),
		},
	}
}

func (r *savedFilterResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *savedFilterResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan savedFilterResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := savedFilterInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateSavedFilter(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create saved filter", err.Error())
		return
	}

	state, diags := savedFilterStateFrom(ctx, created, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *savedFilterResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state savedFilterResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetSavedFilter(ctx, state.ID.ValueString())
	if err != nil {
		// Deleted outside Terraform: drop it from state so the next plan
		// recreates it, rather than failing the refresh.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read saved filter", err.Error())
		return
	}

	refreshed, diags := savedFilterStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *savedFilterResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan savedFilterResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state savedFilterResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := savedFilterInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateSavedFilter(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Saved filter no longer exists",
				"The saved filter was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update saved filter", err.Error())
		return
	}

	next, diags := savedFilterStateFrom(ctx, updated, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *savedFilterResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state savedFilterResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteSavedFilter(ctx, state.ID.ValueString()); err != nil {
		// Already gone is the outcome we wanted.
		if iw.IsNotFound(err) {
			return
		}

		// A 409 here means budgets, reports or dashboard cards still point at
		// this filter by id. That is not a transient condition and retrying
		// cannot clear it — something else has to stop referencing the filter
		// first — so the only useful thing to do is name the referents. The
		// server sends them in the error envelope and APIError.Error() already
		// renders them, so the diagnostic just has to pass the text through.
		if apiErr, ok := iw.AsAPIError(err); ok && iw.IsConflict(err) {
			resp.Diagnostics.AddError(
				"Saved filter is still in use",
				apiErr.Error()+"\n\nUpdate or destroy the budgets, cost reports and dashboard cards "+
					"listed above so they no longer reference this saved filter, then destroy it again.")
			return
		}

		resp.Diagnostics.AddError("Unable to delete saved filter", err.Error())
	}
}

func (r *savedFilterResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// savedFilterInputFrom maps Terraform configuration onto the write body.
//
// Filters and query are exclusive-or on this endpoint, so the provider has to
// pick one branch rather than send both and hope for a precedence rule. A
// configured `query` wins: it is the more specific thing to have written, and
// the `filter` blocks in state alongside it are usually the server's own parse
// of that query echoed back, which it would be wrong to send again. When no
// query is configured we send the blocks and leave query nil so the server
// renders the canonical one.
func savedFilterInputFrom(ctx context.Context, model savedFilterResourceModel) (iw.SavedCostFilterInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	input := iw.SavedCostFilterInput{
		Name:        model.Name.ValueString(),
		Description: stringPtr(model.Description),
	}

	if query := stringPtr(model.Query); query != nil && *query != "" {
		input.Query = query
		// Explicitly empty, not nil: the field has no omitempty, and `[]` is
		// what makes the query branch legal.
		input.Filters = []iw.CostFilter{}
		return input, diags
	}

	filters, d := costFiltersFrom(ctx, model.Filter)
	diags.Append(d...)
	input.Filters = filters
	return input, diags
}

// savedFilterStateFrom maps a server saved filter into Terraform state.
//
// The server canonicalises both representations — it rewrites a hand-written
// query into normal form and derives the clause list from it — but the two
// halves cannot be treated the same way here, and the asymmetry is forced by
// what the framework allows rather than by taste.
//
// `query` is an Optional+Computed attribute, so the server is free to fill it
// in: a practitioner who wrote `filter` blocks gets the canonical query back and
// Terraform is happy, because a Computed attribute is exactly the promise that
// the provider may supply a value the configuration did not.
//
// `filter` is a *block*, and the framework has no Computed blocks. Whatever
// lands in state has to match what the configuration said, or Terraform core
// rejects the apply with "Provider produced inconsistent result after apply".
// So when the practitioner wrote a query, the server's parse of it is
// deliberately not written back into the block list: the query is the source of
// truth for that resource, and the clauses are its derivative. Writing them
// would be describing the same filter twice and losing on the second telling.
//
// When the practitioner wrote blocks instead, the response's clauses are what
// gets stored — they echo what was sent, and taking them from the server is what
// surfaces a genuine edit made elsewhere.
func savedFilterStateFrom(ctx context.Context, remote *iw.SavedCostFilter, prior savedFilterResourceModel) (savedFilterResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	filters, d := costFiltersTo(ctx, remote.Filters)
	diags.Append(d...)

	// A configured query owns the resource; keep the block list exactly as the
	// configuration spelled it, which for a query-driven filter is empty.
	if !prior.Query.IsNull() && !prior.Query.IsUnknown() && prior.Query.ValueString() != "" &&
		!prior.Filter.IsNull() && !prior.Filter.IsUnknown() {
		filters = prior.Filter
	}

	return savedFilterResourceModel{
		ID:          types.StringValue(remote.ID),
		Name:        types.StringValue(remote.Name),
		Description: stringValue(remote.Description),
		Query:       types.StringValue(remote.Query),
		Filter:      filters,
	}, diags
}
