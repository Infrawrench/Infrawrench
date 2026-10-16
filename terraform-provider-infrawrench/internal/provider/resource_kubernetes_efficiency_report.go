package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
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
	_ resource.Resource                = (*kubernetesEfficiencyReportResource)(nil)
	_ resource.ResourceWithConfigure   = (*kubernetesEfficiencyReportResource)(nil)
	_ resource.ResourceWithImportState = (*kubernetesEfficiencyReportResource)(nil)
)

// NewKubernetesEfficiencyReportResource constructs the
// infrawrench_kubernetes_efficiency_report resource.
func NewKubernetesEfficiencyReportResource() resource.Resource {
	return &kubernetesEfficiencyReportResource{}
}

type kubernetesEfficiencyReportResource struct{ client *iw.Client }

// The closed enums the report config accepts.
var (
	k8sEfficiencyGranularities = []string{"day", "week", "month"}
	k8sEfficiencyGroupBys      = []string{"cluster", "namespace", "workload", "label", "node_pool", "category"}
	k8sEfficiencyCategories    = []string{"cpu", "memory", "gpu", "storage", "network", "control_plane", "compute"}
	k8sEfficiencyIdleModes     = []string{"separate", "spread"}
	k8sEfficiencyBases         = []string{"total", "allocated"}
	k8sEfficiencyDimensions    = []string{"account", "region", "tag"}
	costRangePresets           = []string{"7d", "30d", "90d", "mtd", "last_month", "qtd", "ytd", "6m", "12m"}
)

type kubernetesEfficiencyReportModel struct {
	ID              types.String `tfsdk:"id"`
	Name            types.String `tfsdk:"name"`
	Description     types.String `tfsdk:"description"`
	FolderID        types.String `tfsdk:"folder_id"`
	DatePreset      types.String `tfsdk:"date_preset"`
	DateFrom        types.String `tfsdk:"date_from"`
	DateTo          types.String `tfsdk:"date_to"`
	Granularity     types.String `tfsdk:"granularity"`
	GroupBy         types.String `tfsdk:"group_by"`
	GroupByLabelKey types.String `tfsdk:"group_by_label_key"`
	Categories      types.List   `tfsdk:"categories"`
	Idle            types.String `tfsdk:"idle"`
	Basis           types.String `tfsdk:"basis"`
	Filter          types.List   `tfsdk:"filter"`
}

func (r *kubernetesEfficiencyReportResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_kubernetes_efficiency_report"
}

func (r *kubernetesEfficiencyReportResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A saved Kubernetes efficiency report: how much of each cluster's derived " +
			"cost bought capacity that was used, requested but unused, unmeasured, idle, or cluster " +
			"overhead, grouped by cluster, namespace, workload, label, node pool or cost category.\n\n" +
			"Efficiency on the `total` basis is `used / (total - unmeasured)`, so idle capacity and " +
			"overhead count against it; on the `allocated` basis it is `used / (used + unused)`, " +
			"what workloads reserved only. The figures are computed when the report runs, under the " +
			"viewer's cost visibility scope; this resource manages the definition.\n\n" +
			"Write either `date_preset` (a rolling window) or both `date_from` and `date_to` (a fixed " +
			"span).",
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
				MarkdownDescription: "Free text shown under the report title. At most 2000 characters.",
				Validators:          []validator.String{stringvalidator.LengthAtMost(2000)},
			},
			"folder_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Id of the `infrawrench_cost_report_folder` the report is filed in " +
					"(efficiency reports share the cost report folder tree and inherit its sharing). " +
					"Clearing it moves the report back to the top level.",
			},
			"date_preset": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "A rolling window resolved each time the report runs. One of `" +
					joinBackticked(costRangePresets) + "`. Conflicts with `date_from`/`date_to`.",
				Validators: []validator.String{
					oneOfValidator(costRangePresets...),
					stringvalidator.ConflictsWith(path.MatchRoot("date_from"), path.MatchRoot("date_to")),
					stringvalidator.AtLeastOneOf(path.MatchRoot("date_from")),
				},
			},
			"date_from": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Inclusive start date, `YYYY-MM-DD`, with `date_to`. At most 366 days apart.",
				Validators: []validator.String{
					stringvalidator.AlsoRequires(path.MatchRoot("date_to")),
				},
			},
			"date_to": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Inclusive end date, `YYYY-MM-DD`, with `date_from`.",
				Validators: []validator.String{
					stringvalidator.AlsoRequires(path.MatchRoot("date_from")),
				},
			},
			"granularity": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("day"),
				MarkdownDescription: "Period of the series. One of `" + joinBackticked(k8sEfficiencyGranularities) +
					"`; weeks start on Monday. Defaults to `day`.",
				Validators: []validator.String{oneOfValidator(k8sEfficiencyGranularities...)},
			},
			"group_by": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "One row per value of this. One of `" + joinBackticked(k8sEfficiencyGroupBys) +
					"`. `label` groups by `group_by_label_key`.",
				Validators: []validator.String{oneOfValidator(k8sEfficiencyGroupBys...)},
			},
			"group_by_label_key": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "The tag key to group by when `group_by` is `label`, 1–300 characters: a " +
					"pod, node or volume label (`k8s_pod_label:team`, `k8s_node_label:team`, " +
					"`k8s_pvc_label:app.kubernetes.io/name`) or a normalised attribute such as " +
					"`capacity_type`. Required for `label` and rejected otherwise.",
				Validators: []validator.String{stringvalidator.LengthBetween(1, 300)},
			},
			"categories": schema.ListAttribute{
				Optional:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Cost categories to include, at most 7: any of `" +
					joinBackticked(k8sEfficiencyCategories) + "`. Omitted or empty is every category.",
				Validators: []validator.List{
					sizeAtMost(len(k8sEfficiencyCategories)),
					listvalidator.UniqueValues(),
					listvalidator.ValueStringsAre(oneOfValidator(k8sEfficiencyCategories...)),
				},
			},
			"idle": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("separate"),
				MarkdownDescription: "`separate` keeps idle capacity and cluster overhead as their own rows; " +
					"`spread` shares them across each cluster's groups, per period, in proportion to what " +
					"each was allocated. Defaults to `separate`.",
				Validators: []validator.String{oneOfValidator(k8sEfficiencyIdleModes...)},
			},
			"basis": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("total"),
				MarkdownDescription: "Efficiency denominator: `total` or `allocated` (see the resource " +
					"description). Defaults to `total`.",
				Validators: []validator.String{oneOfValidator(k8sEfficiencyBases...)},
			},
		},
		Blocks: map[string]schema.Block{
			"filter": schema.ListNestedBlock{
				MarkdownDescription: "Restricts the report, at most 20 clauses, ANDed together.",
				Validators:          []validator.List{sizeAtMost(20)},
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"dimension": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "`account` (a Kubernetes cluster's account id), `region`, or `tag` " +
								"(namespace, workload, workload_kind, node_pool, capacity_type and the pod, node " +
								"and volume labels).",
							Validators: []validator.String{oneOfValidator(k8sEfficiencyDimensions...)},
						},
						"op": schema.StringAttribute{
							Required:            true,
							MarkdownDescription: "`in` to keep matching cost, `not_in` to exclude it.",
							Validators:          []validator.String{oneOfValidator("in", "not_in")},
						},
						"values": schema.ListAttribute{
							Required:            true,
							ElementType:         types.StringType,
							MarkdownDescription: "Values to match, 1–200 of them.",
							Validators:          []validator.List{sizeBetween(1, 200)},
						},
						"tag_key": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "The tag key, required when `dimension` is `tag`. 1–300 characters.",
							Validators:          []validator.String{stringvalidator.LengthBetween(1, 300)},
						},
					},
				},
			},
		},
	}
}

func (r *kubernetesEfficiencyReportResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *kubernetesEfficiencyReportResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan kubernetesEfficiencyReportModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := kubernetesEfficiencyInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateKubernetesEfficiencyReport(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create Kubernetes efficiency report", err.Error())
		return
	}
	state, diags := kubernetesEfficiencyStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *kubernetesEfficiencyReportResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state kubernetesEfficiencyReportModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetKubernetesEfficiencyReport(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read Kubernetes efficiency report", err.Error())
		return
	}
	refreshed, diags := kubernetesEfficiencyStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *kubernetesEfficiencyReportResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state kubernetesEfficiencyReportModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := kubernetesEfficiencyInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateKubernetesEfficiencyReport(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Kubernetes efficiency report no longer exists",
				"The report was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update Kubernetes efficiency report", err.Error())
		return
	}
	next, diags := kubernetesEfficiencyStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *kubernetesEfficiencyReportResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state kubernetesEfficiencyReportModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteKubernetesEfficiencyReport(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete Kubernetes efficiency report", err.Error())
	}
}

func (r *kubernetesEfficiencyReportResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// kubernetesEfficiencyInputFrom maps configuration onto the write body. The
// date range is a tagged union on the wire; only the branch in use is sent,
// because the server's schema is strict.
func kubernetesEfficiencyInputFrom(ctx context.Context, m kubernetesEfficiencyReportModel) (iw.KubernetesEfficiencyReportInput, diag.Diagnostics) {
	var diags diag.Diagnostics
	dateRange := iw.CostDateRange{Kind: "relative", Preset: stringPtr(m.DatePreset)}
	if m.DatePreset.IsNull() {
		dateRange = iw.CostDateRange{Kind: "absolute", From: stringPtr(m.DateFrom), To: stringPtr(m.DateTo)}
	}
	filters, d := costFiltersFrom(ctx, m.Filter)
	diags.Append(d...)
	var categories []string
	if !m.Categories.IsNull() && !m.Categories.IsUnknown() {
		values, d := stringSlice(ctx, m.Categories)
		diags.Append(d...)
		categories = values
	}
	if diags.HasError() {
		return iw.KubernetesEfficiencyReportInput{}, diags
	}
	return iw.KubernetesEfficiencyReportInput{
		Name:        m.Name.ValueString(),
		Description: stringPtr(m.Description),
		FolderID:    stringPtr(m.FolderID),
		Config: iw.KubernetesEfficiencyConfig{
			// Pinned by the provider: the shape this code writes and reads.
			Version:         1,
			DateRange:       dateRange,
			Granularity:     m.Granularity.ValueString(),
			Filters:         filters,
			GroupBy:         m.GroupBy.ValueString(),
			GroupByLabelKey: stringPtr(m.GroupByLabelKey),
			Categories:      categories,
			Idle:            m.Idle.ValueString(),
			Basis:           m.Basis.ValueString(),
		},
	}, diags
}

// kubernetesEfficiencyStateFrom maps a server report into state. Categories
// read back as null when the server holds none, matching an omitted attribute.
func kubernetesEfficiencyStateFrom(ctx context.Context, remote *iw.KubernetesEfficiencyReport) (kubernetesEfficiencyReportModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	filters, d := costFiltersTo(ctx, remote.Config.Filters)
	diags.Append(d...)
	categories := types.ListNull(types.StringType)
	if remote.Config.Categories != nil {
		list, d := stringList(ctx, remote.Config.Categories)
		diags.Append(d...)
		categories = list
	}
	cfg := remote.Config
	model := kubernetesEfficiencyReportModel{
		ID:              types.StringValue(remote.ID),
		Name:            types.StringValue(remote.Name),
		Description:     stringValue(remote.Description),
		FolderID:        stringValue(remote.FolderID),
		DatePreset:      types.StringNull(),
		DateFrom:        types.StringNull(),
		DateTo:          types.StringNull(),
		Granularity:     types.StringValue(cfg.Granularity),
		GroupBy:         types.StringValue(cfg.GroupBy),
		GroupByLabelKey: stringValue(cfg.GroupByLabelKey),
		Categories:      categories,
		Idle:            types.StringValue(cfg.Idle),
		Basis:           types.StringValue(cfg.Basis),
		Filter:          filters,
	}
	if cfg.DateRange.Kind == "relative" {
		model.DatePreset = stringValue(cfg.DateRange.Preset)
	} else {
		model.DateFrom = stringValue(cfg.DateRange.From)
		model.DateTo = stringValue(cfg.DateRange.To)
	}
	return model, diags
}
