package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                   = (*networkFlowReportResource)(nil)
	_ resource.ResourceWithConfigure      = (*networkFlowReportResource)(nil)
	_ resource.ResourceWithImportState    = (*networkFlowReportResource)(nil)
	_ resource.ResourceWithValidateConfig = (*networkFlowReportResource)(nil)
)

// NewNetworkFlowReportResource constructs the infrawrench_network_flow_report resource.
func NewNetworkFlowReportResource() resource.Resource { return &networkFlowReportResource{} }

type networkFlowReportResource struct{ client *iw.Client }

// The closed enums the server's config accepts. No `hourly` (flows are stored
// one row per day) and no `quarterly` (the store keeps 90 days).
var (
	networkFlowReportGranularities = []string{"daily", "weekly", "monthly"}
	networkFlowReportGroupBys      = []string{
		"none", "pair", "source", "destination", "traffic_class", "service",
		"zone_pair", "region_pair", "account", "network",
	}
	networkFlowReportMetrics        = []string{"cost", "bytes", "both"}
	networkFlowReportTrafficClasses = []string{
		"intra_zone", "cross_zone", "cross_region", "internet_egress", "internet_ingress",
		"nat_gateway", "private_interconnect", "provider_service", "unknown",
	}
	networkFlowReportDirections = []string{"egress", "ingress"}
	networkFlowReportPresets    = []string{"7d", "30d", "90d", "mtd", "last_month", "qtd", "ytd", "6m", "12m"}
)

type networkFlowReportResourceModel struct {
	ID              types.String `tfsdk:"id"`
	Name            types.String `tfsdk:"name"`
	Description     types.String `tfsdk:"description"`
	FolderID        types.String `tfsdk:"folder_id"`
	DatePreset      types.String `tfsdk:"date_preset"`
	DateFrom        types.String `tfsdk:"date_from"`
	DateTo          types.String `tfsdk:"date_to"`
	Granularity     types.String `tfsdk:"granularity"`
	GroupBy         types.String `tfsdk:"group_by"`
	Metric          types.String `tfsdk:"metric"`
	TopN            types.Int64  `tfsdk:"top_n"`
	AccountIDs      types.Set    `tfsdk:"account_ids"`
	Networks        types.Set    `tfsdk:"networks"`
	Regions         types.Set    `tfsdk:"regions"`
	Zones           types.Set    `tfsdk:"zones"`
	SourceRefs      types.Set    `tfsdk:"source_refs"`
	DestinationRefs types.Set    `tfsdk:"destination_refs"`
	Services        types.Set    `tfsdk:"services"`
	ResourceTypes   types.Set    `tfsdk:"resource_types"`
	TrafficClasses  types.Set    `tfsdk:"traffic_classes"`
	Directions      types.Set    `tfsdk:"directions"`
}

func (r *networkFlowReportResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_network_flow_report"
}

// networkFlowFilterSet is one optional filter attribute: a non-empty set of at
// most 200 strings. Empty is refused rather than accepted, because the server
// drops an empty list when it normalizes the config and an empty set would
// then diff against the null it reads back on every plan.
func networkFlowFilterSet(description string, extra ...validator.Set) schema.SetAttribute {
	return schema.SetAttribute{
		Optional:            true,
		ElementType:         types.StringType,
		MarkdownDescription: description + " Omit for no filter. When set: 1–200 values.",
		Validators: append([]validator.Set{
			setvalidator.SizeAtLeast(1),
			setSizeAtMost(200),
		}, extra...),
	}
}

func (r *networkFlowReportResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A saved network flow report: bytes and estimated cost of network traffic " +
			"over a window, by flow pair, endpoint, traffic class, peer service, zone or region pair, " +
			"account or VPC, with the top talking pairs. Every cost is an estimate at the provider's " +
			"list rate for the boundary crossed, read from the flows Infrawrench collects (turn " +
			"collection on with `infrawrench_network_flow_settings`). Flows are kept for 90 days.\n\n" +
			"Reports file into the same folder tree as cost reports (`infrawrench_cost_report_folder`) " +
			"and are shared with `infrawrench_object_sharing` using `object_type = \"network_flow_report\"`.\n\n" +
			"Set either `date_preset`, or both `date_from` and `date_to`.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned report id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free text shown under the title. At most 2000 characters.",
				Validators:          []validator.String{stringvalidator.LengthAtMost(2000)},
			},
			"folder_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Id of the `infrawrench_cost_report_folder` the report is filed in. " +
					"Clearing it moves the report to the top level.",
			},
			"date_preset": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "A window relative to each run, one of `" + joinBackticked(networkFlowReportPresets) +
					"`. Conflicts with `date_from` / `date_to`.",
				Validators: []validator.String{
					oneOfValidator(networkFlowReportPresets...),
					stringvalidator.ConflictsWith(path.MatchRoot("date_from"), path.MatchRoot("date_to")),
				},
			},
			"date_from": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "First day of a fixed window, `YYYY-MM-DD`. Requires `date_to`.",
				Validators: []validator.String{
					stringvalidator.RegexMatches(budgetDayPattern, "must be a YYYY-MM-DD day"),
					stringvalidator.AlsoRequires(path.MatchRoot("date_to")),
				},
			},
			"date_to": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Last day of a fixed window, `YYYY-MM-DD`, inclusive. Requires `date_from`. A report covers at most 366 days.",
				Validators: []validator.String{
					stringvalidator.RegexMatches(budgetDayPattern, "must be a YYYY-MM-DD day"),
					stringvalidator.AlsoRequires(path.MatchRoot("date_from")),
				},
			},
			"granularity": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("daily"),
				MarkdownDescription: "Bucket size, one of `" + joinBackticked(networkFlowReportGranularities) +
					"`. Defaults to `daily`. There is no hourly: flows are stored one row per day. Weeks " +
					"start on Monday.",
				Validators: []validator.String{oneOfValidator(networkFlowReportGranularities...)},
			},
			"group_by": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("none"),
				MarkdownDescription: "Grouping, one of `" + joinBackticked(networkFlowReportGroupBys) + "`. " +
					"Defaults to `none`. `service` is the peer's provider service (the destination of " +
					"egress, the source of ingress); `network` is the local side's VPC.",
				Validators: []validator.String{oneOfValidator(networkFlowReportGroupBys...)},
			},
			"metric": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("both"),
				MarkdownDescription: "What the report shows, one of `" + joinBackticked(networkFlowReportMetrics) +
					"`. Defaults to `both`. `bytes` ranks groups and pairs by bytes; the others rank by " +
					"estimated cost.",
				Validators: []validator.String{oneOfValidator(networkFlowReportMetrics...)},
			},
			"top_n": schema.Int64Attribute{
				Optional:            true,
				MarkdownDescription: "Groups and top talking pairs listed, 1–200. Omit for the default of 25.",
				Validators:          []validator.Int64{between(1, 200)},
			},
			"account_ids": networkFlowFilterSet("Connected account ids, e.g. `infrawrench_account.prod.id`. " +
				"Without it, Kubernetes cluster traffic is left out (a cloud flow log already counts it); " +
				"naming a cluster's account includes it."),
			"networks": networkFlowFilterSet("VPC / network ids (`vpc-0abc…`), matched at either end of a flow."),
			"regions":  networkFlowFilterSet("Provider regions, matched at either end of a flow."),
			"zones":    networkFlowFilterSet("Availability zone ids (`use1-az1`), matched at either end of a flow."),
			"source_refs": networkFlowFilterSet("Source endpoints by flow ref: a provider resource id " +
				"(`i-0abc…`), a Kubernetes workload (`namespace/Kind/name`) or a class token."),
			"destination_refs": networkFlowFilterSet("Destination endpoints by flow ref: a provider " +
				"resource id, a workload, `internet`, or a service token such as `aws:s3`."),
			"services":       networkFlowFilterSet("The peer's provider service (`s3`, `dynamodb`)."),
			"resource_types": networkFlowFilterSet("The peer's resource type id (`ec2-instance`)."),
			"traffic_classes": networkFlowFilterSet(
				"Boundaries crossed, any of `"+joinBackticked(networkFlowReportTrafficClasses)+"`. "+
					"Intra-region VPC peering is billed, and classified, as `cross_zone`; transit gateway, "+
					"VPN and interconnect traffic is `private_interconnect`.",
				setvalidator.ValueStringsAre(oneOfValidator(networkFlowReportTrafficClasses...)),
			),
			"directions": networkFlowFilterSet(
				"Directions relative to the observing endpoint, any of `egress`, `ingress`.",
				setvalidator.ValueStringsAre(oneOfValidator(networkFlowReportDirections...)),
			),
		},
	}
}

// ValidateConfig checks the one rule the attribute validators cannot express
// on their own: some window has to be named.
func (r *networkFlowReportResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var model networkFlowReportResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &model)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if model.DatePreset.IsUnknown() || model.DateFrom.IsUnknown() || model.DateTo.IsUnknown() {
		return
	}
	if model.DatePreset.IsNull() && model.DateFrom.IsNull() && model.DateTo.IsNull() {
		resp.Diagnostics.AddAttributeError(path.Root("date_preset"),
			"Missing window",
			"Set date_preset, or both date_from and date_to.")
	}
}

func (r *networkFlowReportResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *networkFlowReportResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan networkFlowReportResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := networkFlowReportInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateNetworkFlowReport(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create network flow report", err.Error())
		return
	}
	state, diags := networkFlowReportStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *networkFlowReportResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state networkFlowReportResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetNetworkFlowReport(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read network flow report", err.Error())
		return
	}
	refreshed, diags := networkFlowReportStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *networkFlowReportResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state networkFlowReportResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := networkFlowReportInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateNetworkFlowReport(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Network flow report no longer exists",
				"The report was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update network flow report", err.Error())
		return
	}
	next, diags := networkFlowReportStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *networkFlowReportResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state networkFlowReportResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteNetworkFlowReport(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete network flow report", err.Error())
	}
}

func (r *networkFlowReportResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// networkFlowSetSlice reads an optional filter set: null or unknown is "no filter".
func networkFlowSetSlice(ctx context.Context, set types.Set) ([]string, diag.Diagnostics) {
	if set.IsNull() || set.IsUnknown() {
		return nil, nil
	}
	var out []string
	diags := set.ElementsAs(ctx, &out, false)
	return out, diags
}

// networkFlowSetOf renders a filter list: absent or empty is null, the shape
// an omitted attribute plans as.
func networkFlowSetOf(ctx context.Context, values []string) (types.Set, diag.Diagnostics) {
	if len(values) == 0 {
		return types.SetNull(types.StringType), nil
	}
	return types.SetValueFrom(ctx, types.StringType, values)
}

func networkFlowReportInputFrom(ctx context.Context, m networkFlowReportResourceModel) (iw.NetworkFlowReportInput, diag.Diagnostics) {
	var diags diag.Diagnostics
	read := func(set types.Set) []string {
		out, d := networkFlowSetSlice(ctx, set)
		diags.Append(d...)
		return out
	}
	dateRange := iw.CostDateRange{Kind: "relative", Preset: stringPtr(m.DatePreset)}
	if m.DatePreset.IsNull() {
		dateRange = iw.CostDateRange{Kind: "absolute", From: stringPtr(m.DateFrom), To: stringPtr(m.DateTo)}
	}
	in := iw.NetworkFlowReportInput{
		Name:        m.Name.ValueString(),
		Description: stringPtr(m.Description),
		FolderID:    stringPtr(m.FolderID),
		Config: iw.NetworkFlowReportConfig{
			// Pinned by the provider: it describes the shape this code writes.
			Version:     1,
			DateRange:   dateRange,
			Granularity: m.Granularity.ValueString(),
			GroupBy:     m.GroupBy.ValueString(),
			Metric:      m.Metric.ValueString(),
			TopN:        int64Ptr(m.TopN),
			Filters: iw.NetworkFlowReportFilters{
				AccountIDs:      read(m.AccountIDs),
				Networks:        read(m.Networks),
				Regions:         read(m.Regions),
				Zones:           read(m.Zones),
				SourceRefs:      read(m.SourceRefs),
				DestinationRefs: read(m.DestinationRefs),
				Services:        read(m.Services),
				ResourceTypes:   read(m.ResourceTypes),
				TrafficClasses:  read(m.TrafficClasses),
				Directions:      read(m.Directions),
			},
		},
	}
	return in, diags
}

func networkFlowReportStateFrom(ctx context.Context, remote *iw.NetworkFlowReport) (networkFlowReportResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	set := func(values []string) types.Set {
		out, d := networkFlowSetOf(ctx, values)
		diags.Append(d...)
		return out
	}
	cfg := remote.Config
	model := networkFlowReportResourceModel{
		ID:              types.StringValue(remote.ID),
		Name:            types.StringValue(remote.Name),
		Description:     stringValue(remote.Description),
		FolderID:        stringValue(remote.FolderID),
		DatePreset:      types.StringNull(),
		DateFrom:        types.StringNull(),
		DateTo:          types.StringNull(),
		Granularity:     types.StringValue(cfg.Granularity),
		GroupBy:         types.StringValue(cfg.GroupBy),
		Metric:          types.StringValue(cfg.Metric),
		TopN:            int64Value(cfg.TopN),
		AccountIDs:      set(cfg.Filters.AccountIDs),
		Networks:        set(cfg.Filters.Networks),
		Regions:         set(cfg.Filters.Regions),
		Zones:           set(cfg.Filters.Zones),
		SourceRefs:      set(cfg.Filters.SourceRefs),
		DestinationRefs: set(cfg.Filters.DestinationRefs),
		Services:        set(cfg.Filters.Services),
		ResourceTypes:   set(cfg.Filters.ResourceTypes),
		TrafficClasses:  set(cfg.Filters.TrafficClasses),
		Directions:      set(cfg.Filters.Directions),
	}
	if cfg.DateRange.Kind == "relative" {
		model.DatePreset = stringValue(cfg.DateRange.Preset)
	} else {
		model.DateFrom = stringValue(cfg.DateRange.From)
		model.DateTo = stringValue(cfg.DateRange.To)
	}
	return model, diags
}
