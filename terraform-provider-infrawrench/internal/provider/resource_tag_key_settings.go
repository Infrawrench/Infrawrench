package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*tagKeySettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*tagKeySettingsResource)(nil)
	_ resource.ResourceWithImportState = (*tagKeySettingsResource)(nil)
)

// hiddenTagKeyPattern accepts an exact key or a prefix ending in a single `*`,
// with no surrounding whitespace. The server trims entries, so a padded value
// would come back different from the configuration and diff forever; a lone
// `*` (hide everything) and an inner `*` are rejected there too.
var hiddenTagKeyPattern = regexp.MustCompile(`^[^\s*]([^*]*[^\s*])?\*?$`)

// preferredTagKeyPattern is an exact key: no `*`, no surrounding whitespace.
var preferredTagKeyPattern = regexp.MustCompile(`^[^\s*]([^*]*[^\s*])?$`)

// NewTagKeySettingsResource constructs the infrawrench_tag_key_settings resource.
func NewTagKeySettingsResource() resource.Resource { return &tagKeySettingsResource{} }

type tagKeySettingsResource struct{ client *iw.Client }

type tagKeySettingsResourceModel struct {
	ID            types.String `tfsdk:"id"`
	HiddenKeys    types.List   `tfsdk:"hidden_keys"`
	PreferredKeys types.List   `tfsdk:"preferred_keys"`
}

func (r *tagKeySettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_tag_key_settings"
}

func (r *tagKeySettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The organization's tag key settings: the tag keys hidden from every tag picker " +
			"and group-by dropdown, and the ones pinned to the top of them.\n\n" +
			"This is a display preference. Hiding a key changes what the pickers in cost reports, " +
			"dashboards, saved filters, budgets, alerts and cost centre rules offer; it does not " +
			"touch any stored cost data, exports still carry the key, and a filter that names it " +
			"still works.\n\n" +
			"This is a singleton. The organization always has exactly one settings document, so " +
			"declaring this resource adopts it and overwrites it, and only one instance should " +
			"exist in a configuration. `terraform destroy` clears both lists, which restores the " +
			"default: every key visible, alphabetical, nothing pinned.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The organization id. The settings are a singleton with no id of their own, " +
					"so the organization is the identity, and the id to hand `terraform import`.",
			},
			"hidden_keys": schema.ListAttribute{
				Optional:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Tag keys to leave out of every picker, at most 200 entries and each " +
					"1–512 characters. Each entry is an exact key (`Name`) or a prefix pattern ending in a " +
					"single `*` (`aws:cloudformation:*`). Matching is case-sensitive. A lone `*`, a `*` " +
					"anywhere but the end, and leading or trailing whitespace are rejected. A key listed " +
					"in `preferred_keys` stays visible even when a prefix here covers it.",
				Validators: []validatorList{
					sizeAtMost(200),
					elementsLengthBetween(1, 512),
					listvalidator.ValueStringsAre(stringvalidator.RegexMatches(
						hiddenTagKeyPattern,
						"must be an exact tag key or a prefix ending in a single *, with no surrounding whitespace",
					)),
				},
			},
			"preferred_keys": schema.ListAttribute{
				Optional:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Exact tag keys pinned to the top of every picker, in this order, at most " +
					"50 entries and each 1–512 characters. Patterns are not accepted here, and a key cannot " +
					"also appear verbatim in `hidden_keys` (the API rejects it). Keys the organization's " +
					"data does not carry are kept but not shown.",
				Validators: []validatorList{
					sizeAtMost(50),
					elementsLengthBetween(1, 512),
					listvalidator.ValueStringsAre(stringvalidator.RegexMatches(
						preferredTagKeyPattern,
						"must be an exact tag key: no *, no surrounding whitespace",
					)),
				},
			},
		},
	}
}

func (r *tagKeySettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// Create adopts the organization's settings. There is no POST: the document
// exists for every organization, so creating is the same PUT Update makes.
func (r *tagKeySettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan tagKeySettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.State, &resp.Diagnostics, "Unable to write tag key settings")
}

// Read refreshes the singleton. Like the tag policy, a 404 is an error rather
// than "gone": the settings cannot be deleted, so a 404 means the organization
// or the token's access to it is.
func (r *tagKeySettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state tagKeySettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetTagKeySettings(ctx)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.Diagnostics.AddError(
				"Tag key settings not found",
				"The tag key settings are an organization singleton and cannot be deleted, so a 404 "+
					"from this route means the organization is unreachable. Check that the configured "+
					"organization still exists and that the API token still has access to it.\n\n"+err.Error())
			return
		}
		resp.Diagnostics.AddError("Unable to read tag key settings", err.Error())
		return
	}

	refreshed, diags := tagKeySettingsStateFrom(ctx, remote, state, r.client.OrgID())
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *tagKeySettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan tagKeySettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.State, &resp.Diagnostics, "Unable to update tag key settings")
}

// Delete clears both lists. There is no DELETE route; an empty document is
// the shipped default (nothing hidden, nothing pinned), and unlike the network
// flow settings there is no cost to leaving it, so clearing is both safe and
// what removing the configuration that set it means.
func (r *tagKeySettingsResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if _, err := r.client.PutTagKeySettings(ctx, iw.TagKeySettings{
		Hidden:    []string{},
		Preferred: []string{},
	}); err != nil {
		resp.Diagnostics.AddError("Unable to reset tag key settings", err.Error())
	}
}

// ImportState stores the organization id; the singleton needs no other address.
func (r *tagKeySettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *tagKeySettingsResource) write(
	ctx context.Context,
	plan tagKeySettingsResourceModel,
	state interface {
		Set(context.Context, any) diag.Diagnostics
	},
	diags *diag.Diagnostics,
	summary string,
) {
	hidden, d := stringSlice(ctx, plan.HiddenKeys)
	diags.Append(d...)
	preferred, d := stringSlice(ctx, plan.PreferredKeys)
	diags.Append(d...)
	if diags.HasError() {
		return
	}

	saved, err := r.client.PutTagKeySettings(ctx, iw.TagKeySettings{Hidden: hidden, Preferred: preferred})
	if err != nil {
		diags.AddError(summary, err.Error())
		return
	}

	next, d := tagKeySettingsStateFrom(ctx, saved, plan, r.client.OrgID())
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	diags.Append(state.Set(ctx, &next)...)
}

/* -------------------------------- mapping --------------------------------- */

// tagKeySettingsStateFrom maps the server document into state.
//
// The wire always carries both lists, `[]` when empty, while a configuration
// may omit either attribute. An empty list therefore keeps whatever shape the
// prior value had: null when the configuration omitted it (or on import), an
// empty list when it spelled `[]`. Mapping `[]` to null unconditionally would
// be "inconsistent result after apply" for the second case, and mapping it to
// `[]` unconditionally would diff forever against the first.
func tagKeySettingsStateFrom(
	ctx context.Context,
	remote *iw.TagKeySettings,
	prior tagKeySettingsResourceModel,
	orgID string,
) (tagKeySettingsResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	hidden, d := listKeepingEmptyShape(ctx, remote.Hidden, prior.HiddenKeys)
	diags.Append(d...)
	preferred, d := listKeepingEmptyShape(ctx, remote.Preferred, prior.PreferredKeys)
	diags.Append(d...)
	return tagKeySettingsResourceModel{
		ID:            types.StringValue(orgID),
		HiddenKeys:    hidden,
		PreferredKeys: preferred,
	}, diags
}

func listKeepingEmptyShape(ctx context.Context, values []string, prior types.List) (types.List, diag.Diagnostics) {
	if len(values) == 0 {
		if !prior.IsNull() && !prior.IsUnknown() {
			return types.ListValueFrom(ctx, types.StringType, []string{})
		}
		return types.ListNull(types.StringType), nil
	}
	return types.ListValueFrom(ctx, types.StringType, values)
}
