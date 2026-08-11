package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*statusPageResource)(nil)
	_ resource.ResourceWithConfigure   = (*statusPageResource)(nil)
	_ resource.ResourceWithImportState = (*statusPageResource)(nil)
)

// NewStatusPageResource constructs the infrawrench_status_page resource.
func NewStatusPageResource() resource.Resource { return &statusPageResource{} }

type statusPageResource struct{ client *iw.Client }

type statusPageResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Slug        types.String `tfsdk:"slug"`
	Title       types.String `tfsdk:"title"`
	Description types.String `tfsdk:"description"`
	Published   types.Bool   `tfsdk:"published"`
	ShowHistory types.Bool   `tfsdk:"show_history"`
	ShowUptime  types.Bool   `tfsdk:"show_uptime"`
	SupportURL  types.String `tfsdk:"support_url"`
	Component   types.List   `tfsdk:"component"`
}

type statusPageComponentModel struct {
	ProbeID   types.String `tfsdk:"probe_id"`
	Label     types.String `tfsdk:"label"`
	GroupName types.String `tfsdk:"group_name"`
}

var statusPageComponentAttrTypes = map[string]attr.Type{
	"probe_id":   types.StringType,
	"label":      types.StringType,
	"group_name": types.StringType,
}

var statusPageComponentObjectType = types.ObjectType{AttrTypes: statusPageComponentAttrTypes}

func (r *statusPageResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_status_page"
}

func (r *statusPageResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A public uptime page built from `infrawrench_probe` checks.\n\n" +
			"The page's URL contains a server-minted `slug` with real entropy, and that slug is the page's " +
			"**only** access credential — anyone holding the URL can read it. Rotating the slug is a " +
			"deliberate action on the API rather than something a plan can do by accident, so Terraform " +
			"never changes it.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned page id. Use it with `terraform import`."),
			"slug": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "The public URL segment, at `/status/<slug>`. Generated with real entropy " +
					"rather than derived from the title, so it cannot be guessed from the organization's name.",
			},
			"title": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Heading shown on the public page.",
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Sub-heading shown under the title.",
			},
			"published": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(false),
				MarkdownDescription: "Defaults to `false`, and a fresh page is never reachable. Publishing is the " +
					"one-line change that makes the page public — which is exactly the change worth reviewing.",
			},
			"show_history": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "Show the day-by-day incident history strip.",
			},
			"show_uptime": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "Show the uptime percentage per component.",
			},
			"support_url": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Link shown for people who need to reach you.",
			},
		},
		Blocks: map[string]schema.Block{
			"component": schema.ListNestedBlock{
				MarkdownDescription: "A probe placed on the page. **Order is the public render order**, and a " +
					"write replaces the whole set — so the blocks here are the page, not additions to it.",
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"probe_id": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Id of an `infrawrench_probe`.",
						},
						"label": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "Public name. Omit it to fall back to the probe's own name — " +
								"which is usually the wrong thing to show the public, since internal probe names " +
								"tend to carry hostnames.",
						},
						"group_name": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "Heading this component is grouped under.",
						},
					},
				},
			},
		},
	}
}

func (r *statusPageResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *statusPageResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan statusPageResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := statusPageInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateStatusPage(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create status page", err.Error())
		return
	}

	state, diags := statusPageStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *statusPageResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state statusPageResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetStatusPage(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read status page", err.Error())
		return
	}

	refreshed, diags := statusPageStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *statusPageResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan statusPageResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state statusPageResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := statusPageInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateStatusPage(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Status page no longer exists",
				"The page was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update status page", err.Error())
		return
	}

	next, diags := statusPageStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *statusPageResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state statusPageResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteStatusPage(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete status page", err.Error())
	}
}

func (r *statusPageResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func statusPageInputFrom(ctx context.Context, model statusPageResourceModel) (iw.StatusPageInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	components := []iw.StatusPageComponentInput{}
	if !model.Component.IsNull() && !model.Component.IsUnknown() {
		var blocks []statusPageComponentModel
		diags.Append(model.Component.ElementsAs(ctx, &blocks, false)...)
		if diags.HasError() {
			return iw.StatusPageInput{}, diags
		}
		for _, b := range blocks {
			components = append(components, iw.StatusPageComponentInput{
				ProbeID:   b.ProbeID.ValueString(),
				Label:     stringPtr(b.Label),
				GroupName: stringPtr(b.GroupName),
			})
		}
	}

	return iw.StatusPageInput{
		Title:       model.Title.ValueString(),
		Description: stringPtr(model.Description),
		Published:   model.Published.ValueBool(),
		ShowHistory: model.ShowHistory.ValueBool(),
		ShowUptime:  model.ShowUptime.ValueBool(),
		SupportURL:  stringPtr(model.SupportURL),
		Components:  components,
	}, diags
}

// statusPageStateFrom maps a page into state.
//
// The read shape carries the probe's own name and live status alongside each
// component. None of it is written back into the block: those are facts about
// the probe, they change without the page changing, and putting them in state
// would make every plan show a diff on a page nobody edited.
func statusPageStateFrom(ctx context.Context, remote *iw.StatusPage) (statusPageResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	blocks := make([]statusPageComponentModel, 0, len(remote.Components))
	for _, c := range remote.Components {
		blocks = append(blocks, statusPageComponentModel{
			ProbeID:   types.StringValue(c.ProbeID),
			Label:     stringValue(c.Label),
			GroupName: stringValue(c.GroupName),
		})
	}
	list, d := types.ListValueFrom(ctx, statusPageComponentObjectType, blocks)
	diags.Append(d...)

	return statusPageResourceModel{
		ID:          types.StringValue(remote.ID),
		Slug:        types.StringValue(remote.Slug),
		Title:       types.StringValue(remote.Title),
		Description: stringValue(remote.Description),
		Published:   types.BoolValue(remote.Published),
		ShowHistory: types.BoolValue(remote.ShowHistory),
		ShowUptime:  types.BoolValue(remote.ShowUptime),
		SupportURL:  stringValue(remote.SupportURL),
		Component:   list,
	}, diags
}
