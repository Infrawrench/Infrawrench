package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*aiAttributionDimensionResource)(nil)
	_ resource.ResourceWithConfigure   = (*aiAttributionDimensionResource)(nil)
	_ resource.ResourceWithImportState = (*aiAttributionDimensionResource)(nil)
)

// aiDimensionKeyPattern is the server's AI_DIMENSION_KEY_PATTERN. The key
// becomes a tag key and a CLI argument, so it is kept to a safe slug.
var aiDimensionKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

// NewAIAttributionDimensionResource constructs the infrawrench_ai_attribution_dimension resource.
func NewAIAttributionDimensionResource() resource.Resource {
	return &aiAttributionDimensionResource{}
}

type aiAttributionDimensionResource struct{ client *iw.Client }

type aiAttributionDimensionResourceModel struct {
	ID           types.String `tfsdk:"id"`
	Key          types.String `tfsdk:"key"`
	Label        types.String `tfsdk:"label"`
	MetadataKeys types.List   `tfsdk:"metadata_keys"`
	TagKey       types.String `tfsdk:"tag_key"`
}

func (r *aiAttributionDimensionResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_ai_attribution_dimension"
}

func (r *aiAttributionDimensionResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A caller dimension for [AI attribution](https://infrawrench.com/docs/features/ai-attribution): " +
			"which request-metadata keys name a team, user, feature or customer. Attributed AI spend appears in " +
			"every cost report, budget filter and allocation rule under the tag key `caller:<key>`, with " +
			"`(not set)` for matched requests that carried none of the keys.\n\n" +
			"An organization can map at most 6 dimensions, because each one multiplies the combinations stored " +
			"per day. A mapping change applies to days collected from then on; re-collect a source from the " +
			"settings page or the CLI to apply it to history.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned dimension id. Use it with `terraform import`."),
			"key": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Slug that becomes the tag key `caller:<key>`: a lowercase letter, then up " +
					"to 31 lowercase letters, digits, `_` or `-`. Unique within the organization. Renaming it " +
					"renames the tag key, so reports, budgets and rules that filter on the old one stop matching.",
				Validators: []validatorString{stringvalidator.RegexMatches(aiDimensionKeyPattern,
					"must start with a lowercase letter and use only a-z, digits, _ and -, at most 32 characters")},
			},
			"label": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1-60 characters, e.g. `Team`.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 60)},
			},
			"metadata_keys": schema.ListAttribute{
				Required:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Request-metadata keys that feed the dimension, 1-8 of them, each 1-256 " +
					"characters and unique. **Order matters**: for each request the first key present wins, so " +
					"`[\"team\", \"team_id\", \"user_api_key_team_alias\"]` prefers an explicit `team` over " +
					"LiteLLM's key alias. The same list applies across every source.",
				Validators: []validatorList{
					sizeBetween(1, 8),
					elementsLengthBetween(1, 256),
					listvalidator.UniqueValues(),
				},
			},

			"tag_key": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "The tag key the dimension appears under in cost reports, `caller:<key>`.",
			},
		},
	}
}

func (r *aiAttributionDimensionResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *aiAttributionDimensionResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan aiAttributionDimensionResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := aiAttributionDimensionInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateAIAttributionDimension(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create AI attribution dimension", err.Error())
		return
	}

	state, diags := aiAttributionDimensionStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Read refreshes one dimension out of the org's listing.
//
// There is no `GET /ai-attribution/dimensions/{id}` route, so
// iw.GetAIAttributionDimension lists and filters, synthesising the 404 when the
// id is absent; a dimension deleted outside Terraform lands as "needs
// recreating" exactly as it would with a real single-GET route.
func (r *aiAttributionDimensionResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state aiAttributionDimensionResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetAIAttributionDimension(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read AI attribution dimension", err.Error())
		return
	}

	refreshed, diags := aiAttributionDimensionStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *aiAttributionDimensionResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan aiAttributionDimensionResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state aiAttributionDimensionResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := aiAttributionDimensionInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateAIAttributionDimension(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"AI attribution dimension no longer exists",
				"The dimension was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update AI attribution dimension", err.Error())
		return
	}

	next, diags := aiAttributionDimensionStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *aiAttributionDimensionResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state aiAttributionDimensionResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteAIAttributionDimension(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete AI attribution dimension", err.Error())
	}
}

func (r *aiAttributionDimensionResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func aiAttributionDimensionInputFrom(ctx context.Context, model aiAttributionDimensionResourceModel) (iw.AIAttributionDimensionInput, diag.Diagnostics) {
	keys, diags := stringSlice(ctx, model.MetadataKeys)
	return iw.AIAttributionDimensionInput{
		Key:          model.Key.ValueString(),
		Label:        model.Label.ValueString(),
		MetadataKeys: keys,
	}, diags
}

// aiAttributionDimensionStateFrom maps a server dimension into state. Every
// attribute round-trips: the validators reject exactly what the server would
// otherwise normalise (uppercase keys, duplicate metadata keys).
func aiAttributionDimensionStateFrom(ctx context.Context, remote *iw.AIAttributionDimension) (aiAttributionDimensionResourceModel, diag.Diagnostics) {
	keys, diags := stringList(ctx, remote.MetadataKeys)
	return aiAttributionDimensionResourceModel{
		ID:           types.StringValue(remote.ID),
		Key:          types.StringValue(remote.Key),
		Label:        types.StringValue(remote.Label),
		MetadataKeys: keys,
		TagKey:       types.StringValue("caller:" + remote.Key),
	}, diags
}
