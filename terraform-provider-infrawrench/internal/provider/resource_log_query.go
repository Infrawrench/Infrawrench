package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"

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
	_ resource.Resource                = (*logQueryResource)(nil)
	_ resource.ResourceWithConfigure   = (*logQueryResource)(nil)
	_ resource.ResourceWithImportState = (*logQueryResource)(nil)
)

// NewLogQueryResource constructs the infrawrench_log_query resource.
func NewLogQueryResource() resource.Resource { return &logQueryResource{} }

type logQueryResource struct{ client *iw.Client }

type logQueryResourceModel struct {
	ID           types.String `tfsdk:"id"`
	Name         types.String `tfsdk:"name"`
	Search       types.String `tfsdk:"search"`
	AlertEnabled types.Bool   `tfsdk:"alert_enabled"`
	Stream       types.List   `tfsdk:"stream"`
}

type logStreamModel struct {
	ResourceID       types.String `tfsdk:"resource_id"`
	AccountID        types.String `tfsdk:"account_id"`
	PluginID         types.String `tfsdk:"plugin_id"`
	ResourceTypeID   types.String `tfsdk:"resource_type_id"`
	ParentResourceID types.String `tfsdk:"parent_resource_id"`
	Container        types.String `tfsdk:"container"`
}

var logStreamAttrTypes = map[string]attr.Type{
	"resource_id":        types.StringType,
	"account_id":         types.StringType,
	"plugin_id":          types.StringType,
	"resource_type_id":   types.StringType,
	"parent_resource_id": types.StringType,
	"container":          types.StringType,
}

var logStreamObjectType = types.ObjectType{AttrTypes: logStreamAttrTypes}

func (r *logQueryResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_log_query"
}

func (r *logQueryResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A saved multi-resource log tail, optionally evaluated on a schedule so a matching " +
			"line raises a `logMatchAlerts` notification.\n\n" +
			"Kept in Terraform, the searches a team actually relies on — the one that catches the OOM " +
			"killer, the one that catches a certificate refusing to renew — survive the person who wrote " +
			"them and arrive automatically in a new environment.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned query id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"search": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The search expression, up to 500 characters.\n\n" +
					"Empty matches every line. `/pattern/` — optionally `/pattern/i` — is a regular " +
					"expression. Anything else is whitespace-separated terms that must **all** appear in a " +
					"line, matched case-insensitively, with `\"quoted phrases\"` and `-term` negation. For " +
					"example: `error -healthcheck \"connection reset\"`.",
			},
			"alert_enabled": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(false),
				MarkdownDescription: "When `true` the poller periodically evaluates the query and alerts on a " +
					"match. Defaults to `false`: a saved search is useful on its own, and turning every one " +
					"of them into a pager is not what saving one means.",
			},
		},
		Blocks: map[string]schema.Block{
			"stream": schema.ListNestedBlock{
				MarkdownDescription: "A log stream to tail. One to eight of them; a write replaces the whole set.",
				Validators:          []validatorList{sizeBetween(1, 8)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"resource_id": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "Infrawrench resource id of the stream — or, for a sidecar " +
								"stream, the peer plugin's own resource id. Resolve one with " +
								"`data.infrawrench_resources`.",
						},
						"account_id": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Account the resource belongs to.",
						},
						"plugin_id": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Plugin the resource belongs to.",
						},
						"resource_type_id": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "Resource type within the plugin.",
						},
						"parent_resource_id": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "Set for a sidecar stream — a pod inside a managed cluster, say — " +
								"naming the stored parent resource whose outputs mint the peer plugin's " +
								"credentials.",
						},
						"container": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "Container to fetch when the resource has more than one. Omit " +
								"for the default.",
						},
					},
				},
			},
		},
	}
}

func (r *logQueryResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *logQueryResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan logQueryResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := logQueryInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateLogQuery(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create log query", err.Error())
		return
	}

	state, diags := logQueryStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *logQueryResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state logQueryResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetLogQuery(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read log query", err.Error())
		return
	}

	refreshed, diags := logQueryStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *logQueryResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan logQueryResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state logQueryResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := logQueryInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateLogQuery(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Log query no longer exists",
				"The query was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update log query", err.Error())
		return
	}

	next, diags := logQueryStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *logQueryResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state logQueryResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteLogQuery(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete log query", err.Error())
	}
}

func (r *logQueryResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func logQueryInputFrom(ctx context.Context, model logQueryResourceModel) (iw.LogWorkspaceQueryInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	streams := []iw.LogStreamSelector{}
	if !model.Stream.IsNull() && !model.Stream.IsUnknown() {
		var blocks []logStreamModel
		diags.Append(model.Stream.ElementsAs(ctx, &blocks, false)...)
		if diags.HasError() {
			return iw.LogWorkspaceQueryInput{}, diags
		}
		for _, b := range blocks {
			streams = append(streams, iw.LogStreamSelector{
				ResourceID:       b.ResourceID.ValueString(),
				AccountID:        b.AccountID.ValueString(),
				PluginID:         b.PluginID.ValueString(),
				ResourceTypeID:   b.ResourceTypeID.ValueString(),
				ParentResourceID: stringPtr(b.ParentResourceID),
				Container:        stringPtr(b.Container),
			})
		}
	}

	return iw.LogWorkspaceQueryInput{
		Name:         model.Name.ValueString(),
		Resources:    streams,
		Search:       model.Search.ValueString(),
		AlertEnabled: boolPtr(model.AlertEnabled),
	}, diags
}

func logQueryStateFrom(ctx context.Context, remote *iw.LogWorkspaceQuery) (logQueryResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	blocks := make([]logStreamModel, 0, len(remote.Resources))
	for _, s := range remote.Resources {
		blocks = append(blocks, logStreamModel{
			ResourceID:       types.StringValue(s.ResourceID),
			AccountID:        types.StringValue(s.AccountID),
			PluginID:         types.StringValue(s.PluginID),
			ResourceTypeID:   types.StringValue(s.ResourceTypeID),
			ParentResourceID: stringValue(s.ParentResourceID),
			Container:        stringValue(s.Container),
		})
	}
	list, d := types.ListValueFrom(ctx, logStreamObjectType, blocks)
	diags.Append(d...)

	return logQueryResourceModel{
		ID:           types.StringValue(remote.ID),
		Name:         types.StringValue(remote.Name),
		Search:       types.StringValue(remote.Search),
		AlertEnabled: types.BoolValue(remote.AlertEnabled),
		Stream:       list,
	}, diags
}
