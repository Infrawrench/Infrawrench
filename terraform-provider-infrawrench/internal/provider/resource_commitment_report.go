package provider

import (
	"context"
	"fmt"
	"time"

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

// The closed enums and limits the server's config accepts
// (client-core's commitment-reports.ts). No `hourly`: spend is stored one row
// per day, and the server refuses an hourly commitment report outright.
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

const (
	// commitmentReportMaxRangeDays is the longest absolute window any report covers.
	commitmentReportMaxRangeDays = 1096
	// commitmentReportMaxDailyRangeDays is the longest absolute window at daily
	// granularity. Every relative preset fits every granularity.
	commitmentReportMaxDailyRangeDays = 367
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

// commitmentReportFilterSet is one optional filter attribute. The server
// refuses rather than normalizes a non-canonical list (empty, a blank or
// padded value, a value over 500 characters), so each of those is a plan
// error here instead of an HTTP 400 halfway through an apply. A set already
// rules out the repeated value the server also refuses.
func commitmentReportFilterSet(description string, element validator.String) schema.SetAttribute {
	return schema.SetAttribute{
		Optional:            true,
		ElementType:         types.StringType,
		MarkdownDescription: description + " Omit for no filter; an empty set is refused. When set: 1–200 values, none blank or padded with whitespace.",
		Validators: []validator.Set{
			setvalidator.SizeAtLeast(1),
			setSizeAtMost(200),
			setvalidator.ValueStringsAre(element),
		},
	}
}

func (r *commitmentReportResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	// A free-text filter value: 1 to 500 characters with no surrounding
	// whitespace, the shape the server stores without rewriting.
	value := validator.String(stringvalidator.All(
		stringvalidator.LengthBetween(1, 500),
		stringvalidator.RegexMatches(trimmedPattern, "must not be blank or start or end with whitespace"),
	))
	resp.Schema = schema.Schema{
		MarkdownDescription: "A saved commitment report: coverage (and its eligible-usage upper bound), " +
			"utilization, effective savings rate, net savings against on-demand, the on-demand remainder " +
			"and commitment cost (used and unused) over a window, for reservations, savings plans and " +
			"committed-use discounts. Every metric is computed on the amortized basis; the docs page " +
			"defines each.\n\n" +
			"Reports file into the same folder tree as cost reports (`infrawrench_cost_report_folder`) " +
			"and are shared with `infrawrench_object_sharing` using `object_type = \"commitment_report\"`.\n\n" +
			"Set either `date_preset`, or both `date_from` and `date_to`. The server stores a report " +
			"exactly as sent and refuses any value it would otherwise have to rewrite, so the provider " +
			"checks the same rules at plan time.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned report id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters, without leading or trailing whitespace.",
				Validators: []validator.String{
					stringvalidator.LengthBetween(1, 120),
					stringvalidator.RegexMatches(trimmedPattern, "must not be blank or start or end with whitespace"),
				},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free text shown under the title, stored as written. At most 2000 characters.",
				Validators:          []validator.String{stringvalidator.LengthAtMost(2000)},
			},
			"folder_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Id of the `infrawrench_cost_report_folder` the report is filed in. " +
					"Clearing it moves the report to the top level.",
				Validators: []validator.String{stringvalidator.LengthAtLeast(1)},
			},
			"date_preset": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "A window relative to each run, one of `" + joinBackticked(commitmentReportPresets) +
					"`. Every preset runs at every granularity. Conflicts with `date_from` / `date_to`.",
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
				Optional: true,
				MarkdownDescription: "Last day of a fixed window, `YYYY-MM-DD`, inclusive. Requires `date_from`. " +
					"A fixed window covers at most 1096 days, and at most 367 at `daily` granularity.",
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
					"start on Monday.",
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
			"providers": commitmentReportFilterSet("Plugin ids to include, e.g. `aws`, `azure`, `gcp`.", value),
			"commitment_types": commitmentReportFilterSet(
				"Commitment kinds, any of `"+joinBackticked(commitmentReportKinds)+"`. Narrows the "+
					"commitment side only: uncovered usage stays in as the rest of the coverage denominator.",
				oneOfValidator(commitmentReportKinds...),
			),
			"services": commitmentReportFilterSet("Service names exactly as cost data reports them, "+
				"each at most 500 characters.", value),
			"account_ids": commitmentReportFilterSet("Connected account ids, e.g. `infrawrench_account.prod.id`.", value),
			"regions": commitmentReportFilterSet("Region codes exactly as cost data reports them, "+
				"each at most 500 characters.", value),
			"commitment_ids": commitmentReportFilterSet("Provider-native commitment ids (reservation, savings "+
				"plan or commitment ids), each at most 500 characters. Narrows the commitment side only, "+
				"like `commitment_types`.", value),
		},
	}
}

// ValidateConfig checks the rules the attribute validators cannot express on
// their own: some window has to be named, and a fixed one has to be real days,
// in order, within the length the server allows for the granularity. The
// server refuses each of these with a 400, so they belong in the plan.
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
		return
	}
	if model.DateFrom.IsNull() || model.DateTo.IsNull() {
		return
	}
	granularity := "weekly"
	if !model.Granularity.IsNull() {
		if model.Granularity.IsUnknown() {
			granularity = ""
		} else {
			granularity = model.Granularity.ValueString()
		}
	}
	if attr, summary, detail := commitmentReportRangeProblem(model.DateFrom.ValueString(), model.DateTo.ValueString(), granularity); summary != "" {
		resp.Diagnostics.AddAttributeError(path.Root(attr), summary, detail)
	}
}

// commitmentReportRangeProblem mirrors the server's check of a fixed window
// (client-core's commitmentReportRangeProblem plus the calendar-day check in
// the request schema). It returns the attribute to blame and the error, or an
// empty summary when the window is fine. An empty granularity (not yet known)
// skips the daily limit. Malformed days are the regex validators' to report.
func commitmentReportRangeProblem(fromDay, toDay, granularity string) (attr, summary, detail string) {
	if !budgetDayPattern.MatchString(fromDay) || !budgetDayPattern.MatchString(toDay) {
		return "", "", ""
	}
	from, err := time.Parse(time.DateOnly, fromDay)
	if err != nil {
		return "date_from", "Invalid date_from", fmt.Sprintf("%q is not a calendar day.", fromDay)
	}
	to, err := time.Parse(time.DateOnly, toDay)
	if err != nil {
		return "date_to", "Invalid date_to", fmt.Sprintf("%q is not a calendar day.", toDay)
	}
	if to.Before(from) {
		return "date_to", "Window ends before it starts", "date_to must not be before date_from."
	}
	days := int(to.Sub(from).Hours()/24) + 1
	if days > commitmentReportMaxRangeDays {
		return "date_to", "Window too long",
			fmt.Sprintf("A report covers at most %d days; this window is %d.", commitmentReportMaxRangeDays, days)
	}
	if granularity == "daily" && days > commitmentReportMaxDailyRangeDays {
		return "date_to", "Window too long for daily granularity",
			fmt.Sprintf("A daily report covers at most %d days; this window is %d. Use weekly or monthly "+
				"for longer windows.", commitmentReportMaxDailyRangeDays, days)
	}
	return "", "", ""
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

// commitmentReportSetSlice reads an optional filter set: null or unknown is
// "no filter", sent as an absent key. The schema refuses an empty set, so a
// list that reaches the body always has at least one value.
func commitmentReportSetSlice(ctx context.Context, set types.Set) ([]string, diag.Diagnostics) {
	if set.IsNull() || set.IsUnknown() {
		return nil, nil
	}
	var out []string
	diags := set.ElementsAs(ctx, &out, false)
	return out, diags
}

// commitmentReportSetOf renders a filter list: absent is null, the shape an
// omitted attribute plans as.
func commitmentReportSetOf(ctx context.Context, values []string) (types.Set, diag.Diagnostics) {
	if len(values) == 0 {
		return types.SetNull(types.StringType), nil
	}
	return types.SetValueFrom(ctx, types.StringType, values)
}

func commitmentReportInputFrom(ctx context.Context, m commitmentReportResourceModel) (iw.CommitmentReportInput, diag.Diagnostics) {
	var diags diag.Diagnostics
	read := func(set types.Set) []string {
		out, d := commitmentReportSetSlice(ctx, set)
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
		out, d := commitmentReportSetOf(ctx, values)
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
