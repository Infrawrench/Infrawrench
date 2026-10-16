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
	_ resource.Resource                   = (*commitmentReportResource)(nil)
	_ resource.ResourceWithConfigure      = (*commitmentReportResource)(nil)
	_ resource.ResourceWithImportState    = (*commitmentReportResource)(nil)
	_ resource.ResourceWithValidateConfig = (*commitmentReportResource)(nil)
)

// NewCommitmentReportResource constructs the infrawrench_commitment_report resource.
func NewCommitmentReportResource() resource.Resource { return &commitmentReportResource{} }

type commitmentReportResource struct{ client *iw.Client }

// The closed enums the server's config accepts. No `hourly`: spend is stored
// one row per day, and the server refuses an hourly commitment report outright.
var (
	commitmentReportGranularities = []string{"daily", "weekly", "monthly", "quarterly"}
	commitmentReportGroupBys      = []string{"none", "provider", "commitment_type", "commitment", "service", "account", "region"}
	commitmentReportMetrics       = []string{
		"coverage", "eligibleCoverage", "utilization", "effectiveSavingsRate", "netSavings",
		"onDemandRemainder", "commitmentCost", "usedCommitmentCost", "unusedCommitmentCost",
	}
	commitmentReportKinds   = []string{"reservation", "savings_plan", "committed_use"}
	commitmentReportPresets = []string{"7d", "30d", "90d", "mtd", "last_month", "qtd", "ytd", "6m", "12m"}
)

type commitmentReportResourceModel struct {
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
	Providers       types.Set    `tfsdk:"providers"`
	CommitmentTypes types.Set    `tfsdk:"commitment_types"`
	Services        types.Set    `tfsdk:"services"`
	AccountIDs      types.Set    `tfsdk:"account_ids"`
	Regions         types.Set    `tfsdk:"regions"`
	CommitmentIDs   types.Set    `tfsdk:"commitment_ids"`
}

func (r *commitmentReportResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_commitment_report"
}

// filterSet is one optional filter attribute: a non-empty set of at most 200
// strings. Empty is refused rather than accepted, because the server drops an
// empty list when it normalizes the config and an empty set would then diff
// against the null it reads back on every plan.
func filterSet(description string, extra ...validator.Set) schema.SetAttribute {
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

func (r *commitmentReportResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A saved commitment report: coverage, utilization, effective savings rate, " +
			"net savings against on-demand, the on-demand remainder and commitment cost (used and " +
			"unused) over a window, for reserved instances, savings plans and committed-use " +
			"discounts. Every metric is computed on the amortized basis; the docs page defines each.\n\n" +
			"Reports file into the same folder tree as cost reports (`infrawrench_cost_report_folder`) " +
			"and are shared with `infrawrench_object_sharing` using `object_type = \"commitment_report\"`.\n\n" +
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
				MarkdownDescription: "A window relative to each run, one of `" + joinBackticked(commitmentReportPresets) +
					"`. Conflicts with `date_from` / `date_to`.",
				Validators: []validator.String{
					oneOfValidator(commitmentReportPresets...),
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
				MarkdownDescription: "Last day of a fixed window, `YYYY-MM-DD`, inclusive. Requires `date_from`.",
				Validators: []validator.String{
					stringvalidator.RegexMatches(budgetDayPattern, "must be a YYYY-MM-DD day"),
					stringvalidator.AlsoRequires(path.MatchRoot("date_from")),
				},
			},
			"granularity": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("weekly"),
				MarkdownDescription: "Bucket size, one of `" + joinBackticked(commitmentReportGranularities) +
					"`. Defaults to `weekly`. There is no hourly: spend is stored one row per day. Weeks " +
					"start on Monday. A daily report covers at most 366 days, any report at most 1096.",
				Validators: []validator.String{oneOfValidator(commitmentReportGranularities...)},
			},
			"group_by": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("none"),
				MarkdownDescription: "Split, one of `" + joinBackticked(commitmentReportGroupBys) + "`. Defaults " +
					"to `none`. `commitment_type` and `commitment` split the commitment side by holding " +
					"and put uncovered usage in its own group.",
				Validators: []validator.String{oneOfValidator(commitmentReportGroupBys...)},
			},
			"metric": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("coverage"),
				MarkdownDescription: "The metric the chart draws, one of `" + joinBackticked(commitmentReportMetrics) +
					"`. Defaults to `coverage`. The table always shows every metric.",
				Validators: []validator.String{oneOfValidator(commitmentReportMetrics...)},
			},
			"providers": filterSet("Plugin ids to include, e.g. `aws`, `azure`, `gcp`."),
			"commitment_types": filterSet(
				"Commitment kinds, any of `"+joinBackticked(commitmentReportKinds)+"`. Narrows the "+
					"commitment side only: uncovered usage stays in as the rest of the coverage denominator.",
				setvalidator.ValueStringsAre(oneOfValidator(commitmentReportKinds...)),
			),
			"services":    filterSet("Service names exactly as cost data reports them."),
			"account_ids": filterSet("Connected account ids, e.g. `infrawrench_account.prod.id`."),
			"regions":     filterSet("Region codes exactly as cost data reports them."),
			"commitment_ids": filterSet("Provider-native commitment ids (reservation, savings plan or " +
				"commitment ids). Narrows the commitment side only, like `commitment_types`."),
		},
	}
}

// ValidateConfig checks the one rule the attribute validators cannot express
// on their own: some window has to be named.
func (r *commitmentReportResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var model commitmentReportResourceModel
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

func (r *commitmentReportResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *commitmentReportResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan commitmentReportResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := commitmentReportInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	created, err := r.client.CreateCommitmentReport(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create commitment report", err.Error())
		return
	}
	state, diags := commitmentReportStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *commitmentReportResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state commitmentReportResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	remote, err := r.client.GetCommitmentReport(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read commitment report", err.Error())
		return
	}
	refreshed, diags := commitmentReportStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *commitmentReportResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state commitmentReportResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	input, diags := commitmentReportInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	updated, err := r.client.UpdateCommitmentReport(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Commitment report no longer exists",
				"The report was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update commitment report", err.Error())
		return
	}
	next, diags := commitmentReportStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *commitmentReportResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state commitmentReportResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteCommitmentReport(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete commitment report", err.Error())
	}
}

func (r *commitmentReportResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

// optionalSetSlice reads an optional filter set: null or unknown is "no filter".
func optionalSetSlice(ctx context.Context, set types.Set) ([]string, diag.Diagnostics) {
	if set.IsNull() || set.IsUnknown() {
		return nil, nil
	}
	var out []string
	diags := set.ElementsAs(ctx, &out, false)
	return out, diags
}

// optionalSetOf renders a filter list: absent or empty is null, the shape an
// omitted attribute plans as.
func optionalSetOf(ctx context.Context, values []string) (types.Set, diag.Diagnostics) {
	if len(values) == 0 {
		return types.SetNull(types.StringType), nil
	}
	return types.SetValueFrom(ctx, types.StringType, values)
}

func commitmentReportInputFrom(ctx context.Context, m commitmentReportResourceModel) (iw.CommitmentReportInput, diag.Diagnostics) {
	var diags diag.Diagnostics
	read := func(set types.Set) []string {
		out, d := optionalSetSlice(ctx, set)
		diags.Append(d...)
		return out
	}
	dateRange := iw.CostDateRange{Kind: "relative", Preset: stringPtr(m.DatePreset)}
	if m.DatePreset.IsNull() {
		dateRange = iw.CostDateRange{Kind: "absolute", From: stringPtr(m.DateFrom), To: stringPtr(m.DateTo)}
	}
	in := iw.CommitmentReportInput{
		Name:        m.Name.ValueString(),
		Description: stringPtr(m.Description),
		FolderID:    stringPtr(m.FolderID),
		Config: iw.CommitmentReportConfig{
			// Pinned by the provider: it describes the shape this code writes.
			Version:     1,
			DateRange:   dateRange,
			Granularity: m.Granularity.ValueString(),
			GroupBy:     m.GroupBy.ValueString(),
			Metric:      m.Metric.ValueString(),
			Filters: iw.CommitmentReportFilters{
				Providers:       read(m.Providers),
				CommitmentTypes: read(m.CommitmentTypes),
				Services:        read(m.Services),
				AccountIDs:      read(m.AccountIDs),
				Regions:         read(m.Regions),
				CommitmentIDs:   read(m.CommitmentIDs),
			},
		},
	}
	return in, diags
}

func commitmentReportStateFrom(ctx context.Context, remote *iw.CommitmentReport) (commitmentReportResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics
	set := func(values []string) types.Set {
		out, d := optionalSetOf(ctx, values)
		diags.Append(d...)
		return out
	}
	cfg := remote.Config
	model := commitmentReportResourceModel{
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
		Providers:       set(cfg.Filters.Providers),
		CommitmentTypes: set(cfg.Filters.CommitmentTypes),
		Services:        set(cfg.Filters.Services),
		AccountIDs:      set(cfg.Filters.AccountIDs),
		Regions:         set(cfg.Filters.Regions),
		CommitmentIDs:   set(cfg.Filters.CommitmentIDs),
	}
	if cfg.DateRange.Kind == "relative" {
		model.DatePreset = stringValue(cfg.DateRange.Preset)
	} else {
		model.DateFrom = stringValue(cfg.DateRange.From)
		model.DateTo = stringValue(cfg.DateRange.To)
	}
	return model, diags
}
