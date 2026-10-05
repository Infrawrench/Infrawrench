package provider

import (
	"context"
	"fmt"
	"math"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                   = (*virtualTagResource)(nil)
	_ resource.ResourceWithConfigure      = (*virtualTagResource)(nil)
	_ resource.ResourceWithImportState    = (*virtualTagResource)(nil)
	_ resource.ResourceWithValidateConfig = (*virtualTagResource)(nil)
)

// virtualTagKeyPattern mirrors the server's key shape: letters, digits and
// `_ . : / -`, starting with a letter or digit, so a key always renders inside
// `virtual_tag['…']` without escaping.
var virtualTagKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]*$`)

// virtualTagDayPattern is a YYYY-MM-DD UTC day.
var virtualTagDayPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

var (
	virtualTagRuleKinds       = []string{"value", "tag", "split", "metric_split"}
	virtualTagValueTransforms = []string{"none", "lower", "upper"}
)

// NewVirtualTagResource constructs the infrawrench_virtual_tag resource.
func NewVirtualTagResource() resource.Resource { return &virtualTagResource{} }

type virtualTagResource struct{ client *iw.Client }

type virtualTagSourceModel struct {
	TagKey      types.String `tfsdk:"tag_key"`
	ValuePrefix types.String `tfsdk:"value_prefix"`
	Query       types.String `tfsdk:"query"`
}

var virtualTagSourceAttrTypes = map[string]attr.Type{
	"tag_key":      types.StringType,
	"value_prefix": types.StringType,
	"query":        types.StringType,
}

var virtualTagSourceObjectType = types.ObjectType{AttrTypes: virtualTagSourceAttrTypes}

type virtualTagAllocationModel struct {
	Value    types.String  `tfsdk:"value"`
	Percent  types.Float64 `tfsdk:"percent"`
	MetricID types.String  `tfsdk:"metric_id"`
}

var virtualTagAllocationAttrTypes = map[string]attr.Type{
	"value":     types.StringType,
	"percent":   types.Float64Type,
	"metric_id": types.StringType,
}

var virtualTagAllocationObjectType = types.ObjectType{AttrTypes: virtualTagAllocationAttrTypes}

type virtualTagRuleModel struct {
	Query          types.String `tfsdk:"query"`
	Description    types.String `tfsdk:"description"`
	StartsOn       types.String `tfsdk:"starts_on"`
	EndsOn         types.String `tfsdk:"ends_on"`
	Kind           types.String `tfsdk:"kind"`
	Value          types.String `tfsdk:"value"`
	Sources        types.List   `tfsdk:"sources"`
	ValueTransform types.String `tfsdk:"value_transform"`
	Allocations    types.List   `tfsdk:"allocations"`
}

var virtualTagRuleAttrTypes = map[string]attr.Type{
	"query":           types.StringType,
	"description":     types.StringType,
	"starts_on":       types.StringType,
	"ends_on":         types.StringType,
	"kind":            types.StringType,
	"value":           types.StringType,
	"sources":         types.ListType{ElemType: virtualTagSourceObjectType},
	"value_transform": types.StringType,
	"allocations":     types.ListType{ElemType: virtualTagAllocationObjectType},
}

var virtualTagRuleObjectType = types.ObjectType{AttrTypes: virtualTagRuleAttrTypes}

type virtualTagResourceModel struct {
	ID           types.String `tfsdk:"id"`
	Key          types.String `tfsdk:"key"`
	Name         types.String `tfsdk:"name"`
	Description  types.String `tfsdk:"description"`
	DefaultValue types.String `tfsdk:"default_value"`
	Rules        types.List   `tfsdk:"rules"`
	Status       types.String `tfsdk:"status"`
	ProcessedAt  types.String `tfsdk:"processed_at"`
	StatusError  types.String `tfsdk:"status_error"`
}

func (r *virtualTagResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_virtual_tag"
}

func (r *virtualTagResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	dayValidators := []validator.String{
		stringvalidator.RegexMatches(virtualTagDayPattern, "must be a YYYY-MM-DD day, e.g. 2026-04-01"),
	}

	resp.Schema = schema.Schema{
		MarkdownDescription: "A tag the organization computes from its own ordered rules, rather than " +
			"one a provider reported.\n\n" +
			"Provider tags are whatever each team managed to apply: `env`, `Environment` and `ENV` " +
			"on three accounts, a `team` tag on half the estate, a shared database with no owner. " +
			"A virtual tag is the answer the organization actually wants to report on, defined once " +
			"and usable as the `virtual_tag` cost dimension everywhere a provider tag is: cost " +
			"reports and graphs, saved filters, budgets, cost alerts, `infrawrench_allocation_rule` " +
			"(and so showback), and `infrawrench_cost_export` columns.\n\n" +
			"Rules are evaluated **in order and the first match wins**; a row no rule matches takes " +
			"`default_value`, or is left unset. Like billing rules, a virtual tag is computed at " +
			"query time and never written into stored cost rows, so editing a rule re-answers " +
			"every past question immediately, and a split divides money by weights that sum to one, " +
			"so it never changes a total.\n\n" +
			"After every save the server re-evaluates the tag over the whole stored history in the " +
			"background; `status`, `processed_at` and `status_error` report how that pass went. " +
			"Queries never wait on it.\n\n" +
			"Deleting a virtual tag that a saved filter, budget, cost report, dashboard card, cost " +
			"alert, allocation rule, cost export or business metric still references is refused " +
			"with an error naming those objects. Remove the references first; Terraform orders " +
			"this for you when they refer to this resource's `key` attribute.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned virtual tag id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"key": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "How filters, groupings and exports address the tag, as in " +
					"`virtual_tag['team'] = 'payments'`; 1-64 characters of letters, digits and " +
					"`_ . : / -`, starting with a letter or digit. Immutable: saved filters, budgets, " +
					"reports and exports store it, so changing it destroys and recreates the tag. " +
					"Rename the display `name` instead.",
				Validators: []validator.String{
					stringvalidator.LengthBetween(1, 64),
					stringvalidator.RegexMatches(virtualTagKeyPattern,
						"may contain letters, digits and _ . : / - and must start with a letter or digit"),
				},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1-120 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
			},
			"description": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free text explaining what the tag means, 1-2000 characters when set.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 2000)},
			},
			"default_value": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Value for rows no rule matches, 1-256 characters when set. Leave " +
					"unset to leave those rows without the tag. A tag with no rules needs one.",
				Validators: []validator.String{stringvalidator.LengthBetween(1, 256)},
			},
			"rules": schema.ListNestedAttribute{
				Required: true,
				MarkdownDescription: "The ordered rule list, at most 100 rules. Order is meaningful: " +
					"each cost row takes the value of the first rule it matches, so put narrow rules " +
					"before broad ones. May be empty when `default_value` is set.",
				Validators: []validator.List{sizeAtMost(100)},
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"query": schema.StringAttribute{
							Optional: true,
							Computed: true,
							Default:  stringdefault.StaticString(""),
							MarkdownDescription: "Cost query language filter a row must match, up to 4000 " +
								"characters, e.g. `provider = 'aws' AND service = 'AmazonRDS'`. Empty (the " +
								"default) matches every row. It may not reference another virtual tag.",
							Validators: []validator.String{stringvalidator.LengthAtMost(4000)},
						},
						"description": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "Why the rule exists, 1-2000 characters when set.",
							Validators:          []validator.String{stringvalidator.LengthBetween(1, 2000)},
						},
						"starts_on": schema.StringAttribute{
							Optional: true,
							MarkdownDescription: "Inclusive UTC day (`YYYY-MM-DD`) the rule starts applying. " +
								"Leave unset for no start. Together with `ends_on` this records a " +
								"reorganisation (\"team A until March, team B from April\") without " +
								"rewriting history.",
							Validators: dayValidators,
						},
						"ends_on": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "Inclusive UTC day (`YYYY-MM-DD`) the rule stops applying. Leave unset for no end.",
							Validators:          dayValidators,
						},
						"kind": schema.StringAttribute{
							Required: true,
							MarkdownDescription: "What a matching row's value is. `value`: the fixed `value`. " +
								"`tag`: copied from the first of `sources` the row carries (key " +
								"collapsing, e.g. `env`, `Environment` and `ENV` become one key). " +
								"`split`: the row is divided across `allocations` by `percent`. " +
								"`metric_split`: the row is divided across `allocations` in proportion " +
								"to business metrics, day by day. Each kind uses only its own fields; " +
								"setting another kind's field is a plan error.",
							Validators: []validator.String{oneOfValidator(virtualTagRuleKinds...)},
						},
						"value": schema.StringAttribute{
							Optional:            true,
							MarkdownDescription: "The fixed value, 1-256 characters. Required for `kind = \"value\"` and rejected otherwise.",
							Validators:          []validator.String{stringvalidator.LengthBetween(1, 256)},
						},
						"sources": schema.ListNestedAttribute{
							Optional: true,
							Computed: true,
							Default:  listdefault.StaticValue(types.ListValueMust(virtualTagSourceObjectType, []attr.Value{})),
							MarkdownDescription: "Provider tag keys to copy the value from, at most 10, in " +
								"order: the first key the row carries wins. Required (at least one) for " +
								"`kind = \"tag\"` and rejected otherwise.",
							Validators: []validator.List{sizeAtMost(10)},
							NestedObject: schema.NestedAttributeObject{
								Attributes: map[string]schema.Attribute{
									"tag_key": schema.StringAttribute{
										Required:            true,
										MarkdownDescription: "Provider tag key to read, 1-128 characters. Listing a key twice is a plan error.",
										Validators:          []validator.String{stringvalidator.LengthBetween(1, 128)},
									},
									"value_prefix": schema.StringAttribute{
										Optional: true,
										MarkdownDescription: "Prepended to the copied value, 1-64 characters when " +
											"set, e.g. `az-`. Applied after `value_transform`.",
										Validators: []validator.String{stringvalidator.LengthBetween(1, 64)},
									},
									"query": schema.StringAttribute{
										Optional: true,
										MarkdownDescription: "Cost query language filter that must also hold for " +
											"this key to be read, 1-4000 characters when set, e.g. " +
											"`provider = 'azure'`. Leave unset to always read it.",
										Validators: []validator.String{stringvalidator.LengthBetween(1, 4000)},
									},
								},
							},
						},
						"value_transform": schema.StringAttribute{
							Optional: true,
							Computed: true,
							Default:  stringdefault.StaticString("none"),
							MarkdownDescription: "Case fold applied to a copied value before the prefix: " +
								"`none` (the default), `lower` or `upper`. Only `kind = \"tag\"` may set " +
								"it to anything but `none`.",
							Validators: []validator.String{oneOfValidator(virtualTagValueTransforms...)},
						},
						"allocations": schema.ListNestedAttribute{
							Optional: true,
							Computed: true,
							Default:  listdefault.StaticValue(types.ListValueMust(virtualTagAllocationObjectType, []attr.Value{})),
							MarkdownDescription: "The shares a split divides a row into, 2-20 of them. " +
								"Required for `split` and `metric_split` and rejected otherwise. A " +
								"split shares the money rather than copying it, so totals never change.",
							Validators: []validator.List{sizeAtMost(20)},
							NestedObject: schema.NestedAttributeObject{
								Attributes: map[string]schema.Attribute{
									"value": schema.StringAttribute{
										Required:            true,
										MarkdownDescription: "The value this share is tagged with, 1-256 characters. Each value may appear once per rule.",
										Validators:          []validator.String{stringvalidator.LengthBetween(1, 256)},
									},
									"percent": schema.Float64Attribute{
										Optional: true,
										MarkdownDescription: "This share's percentage, greater than 0 and at most " +
											"100. Required for `split`, where a rule's shares must add up to " +
											"100, and rejected for `metric_split`.",
										Validators: []validator.Float64{aboveZeroAtMostFloat(100)},
									},
									"metric_id": schema.StringAttribute{
										Optional: true,
										MarkdownDescription: "The business metric whose daily value weights this " +
											"share; see `infrawrench_business_metric`. Required for " +
											"`metric_split` and rejected for `split`. A day where any share's " +
											"metric has no value carries the last good day's weights forward, " +
											"or splits evenly when there is none.",
									},
								},
							},
						},
					},
				},
			},
			"status": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "Where the background evaluation over stored history stands: " +
					"`pending`, `processing`, `ready` or `failed`. Changes on its own after every apply, " +
					"so do not make anything depend on it.",
			},
			"processed_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "When the last background evaluation finished, successfully or not (RFC 3339). Null until one has.",
			},
			"status_error": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Why the last background evaluation failed. Null unless `status` is `failed`.",
			},
		},
	}
}

func (r *virtualTagResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// ValidateConfig enforces what the schema cannot express per attribute: which
// fields each rule kind uses, the split invariants, and that a tag with no
// rules has a default value.
//
// The server checks all of this too, but it also *normalises* first: a field
// that does not belong to the rule's kind is silently dropped. An unchecked
// `value` on a `tag` rule would therefore apply, come back null, and fail the
// apply with "provider produced inconsistent result". Rejecting it at plan
// time is both kinder and the only way to keep state and config in step.
func (r *virtualTagResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config virtualTagResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() || config.Rules.IsUnknown() || config.Rules.IsNull() {
		return
	}

	var rules []virtualTagRuleModel
	resp.Diagnostics.Append(config.Rules.ElementsAs(ctx, &rules, false)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if len(rules) == 0 && config.DefaultValue.IsNull() {
		resp.Diagnostics.AddAttributeError(path.Root("rules"), "Virtual tag would never be set",
			"Add at least one rule, or set default_value.")
	}

	for i, rule := range rules {
		at := path.Root("rules").AtListIndex(i)
		if rule.Kind.IsUnknown() {
			continue
		}
		kind := rule.Kind.ValueString()

		if !rule.StartsOn.IsNull() && !rule.StartsOn.IsUnknown() &&
			!rule.EndsOn.IsNull() && !rule.EndsOn.IsUnknown() &&
			rule.StartsOn.ValueString() > rule.EndsOn.ValueString() {
			resp.Diagnostics.AddAttributeError(at.AtName("ends_on"), "Rule would never apply",
				fmt.Sprintf("Rule %d starts on %s, after it ends on %s.", i+1,
					rule.StartsOn.ValueString(), rule.EndsOn.ValueString()))
		}

		reject := func(name, why string) {
			resp.Diagnostics.AddAttributeError(at.AtName(name), "Field not used by this rule kind",
				fmt.Sprintf("Rule %d has kind %q, which %s.", i+1, kind, why))
		}

		// value
		if kind == "value" {
			if rule.Value.IsNull() {
				resp.Diagnostics.AddAttributeError(at.AtName("value"), "Missing value",
					fmt.Sprintf("Rule %d has kind \"value\" and needs a value.", i+1))
			}
		} else if !rule.Value.IsNull() {
			reject("value", "does not use `value`; only kind \"value\" does")
		}

		// value_transform: null means the "none" default.
		if kind != "tag" && !rule.ValueTransform.IsNull() && !rule.ValueTransform.IsUnknown() &&
			rule.ValueTransform.ValueString() != "none" {
			reject("value_transform", "copies no tag value to transform; only kind \"tag\" does")
		}

		// sources
		if !rule.Sources.IsUnknown() {
			var sources []virtualTagSourceModel
			if !rule.Sources.IsNull() {
				resp.Diagnostics.Append(rule.Sources.ElementsAs(ctx, &sources, false)...)
			}
			switch {
			case kind == "tag" && len(sources) == 0:
				resp.Diagnostics.AddAttributeError(at.AtName("sources"), "Missing sources",
					fmt.Sprintf("Rule %d has kind \"tag\" and needs at least one tag key to copy from.", i+1))
			case kind != "tag" && len(sources) > 0:
				reject("sources", "does not read provider tags; only kind \"tag\" does")
			}
			seen := map[string]bool{}
			for j, s := range sources {
				if s.TagKey.IsUnknown() || s.TagKey.IsNull() {
					continue
				}
				if seen[s.TagKey.ValueString()] {
					resp.Diagnostics.AddAttributeError(at.AtName("sources").AtListIndex(j).AtName("tag_key"),
						"Duplicate tag key",
						fmt.Sprintf("Rule %d lists %q twice; the second can never be used.", i+1, s.TagKey.ValueString()))
				}
				seen[s.TagKey.ValueString()] = true
			}
		}

		// allocations
		if !rule.Allocations.IsUnknown() {
			var allocations []virtualTagAllocationModel
			if !rule.Allocations.IsNull() {
				resp.Diagnostics.Append(rule.Allocations.ElementsAs(ctx, &allocations, false)...)
			}
			isSplit := kind == "split" || kind == "metric_split"
			if isSplit && len(allocations) < 2 {
				resp.Diagnostics.AddAttributeError(at.AtName("allocations"), "Too few shares",
					fmt.Sprintf("Rule %d is a split and needs at least two allocations; use kind \"value\" for one.", i+1))
			}
			if !isSplit && len(allocations) > 0 {
				reject("allocations", "divides nothing; only kinds \"split\" and \"metric_split\" do")
			}

			seen := map[string]bool{}
			sum, sumKnown := 0.0, true
			for j, a := range allocations {
				ap := at.AtName("allocations").AtListIndex(j)
				if !a.Value.IsUnknown() && !a.Value.IsNull() {
					if seen[a.Value.ValueString()] {
						resp.Diagnostics.AddAttributeError(ap.AtName("value"), "Duplicate share value",
							fmt.Sprintf("Rule %d has %q twice; give it one combined share.", i+1, a.Value.ValueString()))
					}
					seen[a.Value.ValueString()] = true
				}
				switch kind {
				case "split":
					if a.Percent.IsUnknown() {
						sumKnown = false
					} else if a.Percent.IsNull() {
						sumKnown = false
						resp.Diagnostics.AddAttributeError(ap.AtName("percent"), "Missing percent",
							fmt.Sprintf("Rule %d is a percentage split; every allocation needs a percent.", i+1))
					} else {
						sum += a.Percent.ValueFloat64()
					}
					if !a.MetricID.IsNull() {
						resp.Diagnostics.AddAttributeError(ap.AtName("metric_id"), "Field not used by this rule kind",
							fmt.Sprintf("Rule %d is a percentage split; metric_id is only for kind \"metric_split\".", i+1))
					}
				case "metric_split":
					if a.MetricID.IsNull() {
						resp.Diagnostics.AddAttributeError(ap.AtName("metric_id"), "Missing metric_id",
							fmt.Sprintf("Rule %d is a metric split; every allocation needs the business metric that weights it.", i+1))
					}
					if !a.Percent.IsNull() {
						resp.Diagnostics.AddAttributeError(ap.AtName("percent"), "Field not used by this rule kind",
							fmt.Sprintf("Rule %d is a metric split; percent is only for kind \"split\".", i+1))
					}
				}
			}
			// The server compares within two decimal places.
			if kind == "split" && sumKnown && len(allocations) >= 2 && math.Abs(sum-100) > 0.01 {
				resp.Diagnostics.AddAttributeError(at.AtName("allocations"), "Percentages must add up to 100",
					fmt.Sprintf("Rule %d's percentages add up to %g, not 100.", i+1, math.Round(sum*100)/100))
			}
		}
	}
}

func (r *virtualTagResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan virtualTagResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := virtualTagInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateVirtualTag(ctx, input)
	if err != nil {
		if iw.IsConflict(err) {
			resp.Diagnostics.AddError("Virtual tag key already in use",
				err.Error()+"\n\nVirtual tag keys are unique per organization. If the existing tag "+
					"should be managed by Terraform, import it instead: terraform import "+
					"infrawrench_virtual_tag.<name> <id>.")
			return
		}
		resp.Diagnostics.AddError("Unable to create virtual tag", err.Error())
		return
	}

	state, diags := virtualTagStateFrom(ctx, created)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *virtualTagResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state virtualTagResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetVirtualTag(ctx, state.ID.ValueString())
	if err != nil {
		// Deleted outside Terraform: drop it from state so the next plan
		// recreates it, rather than failing the refresh.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read virtual tag", err.Error())
		return
	}

	refreshed, diags := virtualTagStateFrom(ctx, remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *virtualTagResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan virtualTagResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state virtualTagResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := virtualTagInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateVirtualTag(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Virtual tag no longer exists",
				"The virtual tag was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update virtual tag", err.Error())
		return
	}

	next, diags := virtualTagStateFrom(ctx, updated)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *virtualTagResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state virtualTagResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteVirtualTag(ctx, state.ID.ValueString()); err != nil {
		// Already gone is the outcome we wanted.
		if iw.IsNotFound(err) {
			return
		}
		// A 409 means something still filters, groups or allocates by this key.
		// Deleting would make those objects fail rather than quietly widen to
		// all spend, so the server refuses; retrying cannot clear it. The
		// message already names the referencing objects.
		if iw.IsConflict(err) {
			resp.Diagnostics.AddError(
				"Virtual tag is still referenced",
				err.Error()+"\n\nRemove the virtual tag from the saved filters, budgets, reports, "+
					"dashboard cards, cost alerts, allocation rules, cost exports or business metrics "+
					"named above, then destroy this tag. Referring to this resource's `key` "+
					"attribute from those resources lets Terraform order the deletes itself.")
			return
		}
		resp.Diagnostics.AddError("Unable to delete virtual tag", err.Error())
	}
}

func (r *virtualTagResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func virtualTagInputFrom(ctx context.Context, model virtualTagResourceModel) (iw.VirtualTagInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	var rules []virtualTagRuleModel
	if !model.Rules.IsNull() && !model.Rules.IsUnknown() {
		diags.Append(model.Rules.ElementsAs(ctx, &rules, false)...)
		if diags.HasError() {
			return iw.VirtualTagInput{}, diags
		}
	}

	wireRules := make([]iw.VirtualTagRule, 0, len(rules))
	for _, rule := range rules {
		sources := []iw.VirtualTagSource{}
		if !rule.Sources.IsNull() && !rule.Sources.IsUnknown() {
			var models []virtualTagSourceModel
			diags.Append(rule.Sources.ElementsAs(ctx, &models, false)...)
			for _, s := range models {
				sources = append(sources, iw.VirtualTagSource{
					TagKey:      s.TagKey.ValueString(),
					ValuePrefix: stringPtr(s.ValuePrefix),
					Query:       stringPtr(s.Query),
				})
			}
		}

		allocations := []iw.VirtualTagAllocation{}
		if !rule.Allocations.IsNull() && !rule.Allocations.IsUnknown() {
			var models []virtualTagAllocationModel
			diags.Append(rule.Allocations.ElementsAs(ctx, &models, false)...)
			for _, a := range models {
				allocations = append(allocations, iw.VirtualTagAllocation{
					Value:    a.Value.ValueString(),
					Percent:  float64Ptr(a.Percent),
					MetricID: stringPtr(a.MetricID),
				})
			}
		}

		transform := "none"
		if !rule.ValueTransform.IsNull() && !rule.ValueTransform.IsUnknown() {
			transform = rule.ValueTransform.ValueString()
		}

		wireRules = append(wireRules, iw.VirtualTagRule{
			Query:          rule.Query.ValueString(),
			Description:    stringPtr(rule.Description),
			StartsOn:       stringPtr(rule.StartsOn),
			EndsOn:         stringPtr(rule.EndsOn),
			Kind:           rule.Kind.ValueString(),
			Value:          stringPtr(rule.Value),
			Sources:        sources,
			ValueTransform: transform,
			Allocations:    allocations,
		})
	}
	if diags.HasError() {
		return iw.VirtualTagInput{}, diags
	}

	return iw.VirtualTagInput{
		Key:  model.Key.ValueString(),
		Name: model.Name.ValueString(),
		// No omitempty on the wire: a null attribute marshals as an explicit
		// JSON null, which is what removing it from config should mean on a
		// full-replace PUT.
		Description:  stringPtr(model.Description),
		DefaultValue: stringPtr(model.DefaultValue),
		Rules:        wireRules,
	}, diags
}

// virtualTagStateFrom maps a server virtual tag into Terraform state. Unlike
// the single-block rule resources it needs no prior value: every collection is
// either Required or defaults to an empty list, so the server's shape (empty
// arrays, explicit nulls) is already exactly what the plan held.
func virtualTagStateFrom(ctx context.Context, remote *iw.VirtualTag) (virtualTagResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	rules := make([]virtualTagRuleModel, 0, len(remote.Rules))
	for _, rule := range remote.Rules {
		sourceModels := make([]virtualTagSourceModel, 0, len(rule.Sources))
		for _, s := range rule.Sources {
			sourceModels = append(sourceModels, virtualTagSourceModel{
				TagKey:      types.StringValue(s.TagKey),
				ValuePrefix: stringValue(s.ValuePrefix),
				Query:       stringValue(s.Query),
			})
		}
		sources, d := types.ListValueFrom(ctx, virtualTagSourceObjectType, sourceModels)
		diags.Append(d...)

		allocationModels := make([]virtualTagAllocationModel, 0, len(rule.Allocations))
		for _, a := range rule.Allocations {
			allocationModels = append(allocationModels, virtualTagAllocationModel{
				Value:    types.StringValue(a.Value),
				Percent:  float64Value(a.Percent),
				MetricID: stringValue(a.MetricID),
			})
		}
		allocations, d := types.ListValueFrom(ctx, virtualTagAllocationObjectType, allocationModels)
		diags.Append(d...)

		transform := rule.ValueTransform
		if transform == "" {
			transform = "none"
		}

		rules = append(rules, virtualTagRuleModel{
			Query:          types.StringValue(rule.Query),
			Description:    stringValue(rule.Description),
			StartsOn:       stringValue(rule.StartsOn),
			EndsOn:         stringValue(rule.EndsOn),
			Kind:           types.StringValue(rule.Kind),
			Value:          stringValue(rule.Value),
			Sources:        sources,
			ValueTransform: types.StringValue(transform),
			Allocations:    allocations,
		})
	}
	ruleList, d := types.ListValueFrom(ctx, virtualTagRuleObjectType, rules)
	diags.Append(d...)

	return virtualTagResourceModel{
		ID:           types.StringValue(remote.ID),
		Key:          types.StringValue(remote.Key),
		Name:         types.StringValue(remote.Name),
		Description:  stringValue(remote.Description),
		DefaultValue: stringValue(remote.DefaultValue),
		Rules:        ruleList,
		Status:       types.StringValue(remote.Status.State),
		ProcessedAt:  stringValue(remote.Status.ProcessedAt),
		StatusError:  stringValue(remote.Status.Error),
	}, diags
}
