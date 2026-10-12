package provider

import (
	"context"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework-validators/resourcevalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                     = (*complianceControlResource)(nil)
	_ resource.ResourceWithConfigure        = (*complianceControlResource)(nil)
	_ resource.ResourceWithImportState      = (*complianceControlResource)(nil)
	_ resource.ResourceWithValidateConfig   = (*complianceControlResource)(nil)
	_ resource.ResourceWithConfigValidators = (*complianceControlResource)(nil)
)

// complianceFrameworks is the server's framework registry. A closed list, so
// an unknown id is a plan error rather than an HTTP 404 mid-apply.
var complianceFrameworks = []string{"soc2", "iso27001"}

// NewComplianceControlResource constructs the infrawrench_compliance_control
// resource.
func NewComplianceControlResource() resource.Resource {
	return &complianceControlResource{}
}

type complianceControlResource struct{ client *iw.Client }

type complianceControlResourceModel struct {
	ID            types.String `tfsdk:"id"`
	FrameworkID   types.String `tfsdk:"framework_id"`
	ControlID     types.String `tfsdk:"control_id"`
	Applicable    types.Bool   `tfsdk:"applicable"`
	Justification types.String `tfsdk:"justification"`
	OwnerUserID   types.String `tfsdk:"owner_user_id"`
	OwnerLabel    types.String `tfsdk:"owner_label"`
	Notes         types.String `tfsdk:"notes"`
	UpdatedAt     types.String `tfsdk:"updated_at"`
}

func (r *complianceControlResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_compliance_control"
}

func (r *complianceControlResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The organization's decision about one compliance framework control: whether it " +
			"applies (and, when it does not, why), who owns it, and free-form notes. These are what the " +
			"compliance page and every evidence pack show beside the control's evidence.\n\n" +
			"A control with no stored decision is applicable and unowned, so this resource only needs to " +
			"exist for controls you want to say something about. Creating it over a control somebody " +
			"already decided about in the web app adopts and overwrites that decision; `terraform destroy` " +
			"resets the control to applicable and unowned.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("`<framework_id>/<control_id>`, which is also the import address."),
			"framework_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The framework the control belongs to. One of `" +
					joinBackticked(complianceFrameworks) + "`. Changing it replaces the resource.",
				Validators:    []validatorString{oneOfValidator(complianceFrameworks...)},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"control_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "The control's id within the framework, exactly as the compliance page " +
					"lists it: `CC6.1` for SOC 2, `8.8` for ISO/IEC 27001 Annex A. An id the framework " +
					"does not cover fails at apply. Changing it replaces the resource.",
				Validators:    []validatorString{stringvalidator.LengthAtLeast(1)},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"applicable": schema.BoolAttribute{
				Required: true,
				MarkdownDescription: "Whether the control applies to the organization. A control marked not " +
					"applicable reads as `not-applicable` rather than as a gap, and needs a `justification`.",
			},
			"justification": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Why the control does not apply, at most 2000 characters. Required when " +
					"`applicable` is `false`; kept but not shown as the reason while it is `true`.",
				Validators: []validatorString{stringvalidator.LengthAtMost(2000)},
			},
			"owner_user_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "The member who owns the control, from the `infrawrench_members` data " +
					"source. Must be a member when written; one who later leaves shows as a former member " +
					"rather than leaving the control unowned. Conflicts with `owner_label`.",
			},
			"owner_label": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "A team or alias that owns the control when no single member does, at " +
					"most 200 characters. Conflicts with `owner_user_id`.",
				Validators: []validatorString{stringvalidator.LengthAtMost(200)},
			},
			"notes": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Free-form notes shown with the control, at most 2000 characters.",
				Validators:          []validatorString{stringvalidator.LengthAtMost(2000)},
			},
			"updated_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "When the decision was last written (RFC 3339).",
			},
		},
	}
}

func (r *complianceControlResource) ConfigValidators(_ context.Context) []resource.ConfigValidator {
	return []resource.ConfigValidator{
		resourcevalidator.Conflicting(
			path.MatchRoot("owner_user_id"),
			path.MatchRoot("owner_label"),
		),
	}
}

// ValidateConfig enforces the one rule spanning attributes: a control marked
// not applicable needs a justification. The server trims before checking, so
// a whitespace-only justification is as missing as an absent one.
func (r *complianceControlResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config complianceControlResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() || config.Applicable.IsNull() || config.Applicable.IsUnknown() {
		return
	}
	if config.Applicable.ValueBool() || config.Justification.IsUnknown() {
		return
	}
	if config.Justification.IsNull() || strings.TrimSpace(config.Justification.ValueString()) == "" {
		resp.Diagnostics.AddAttributeError(path.Root("justification"), "Missing justification",
			"A control marked not applicable (`applicable = false`) needs a `justification` saying why.")
	}
}

func (r *complianceControlResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *complianceControlResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan complianceControlResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.PutComplianceControlSetting(ctx, plan.FrameworkID.ValueString(), plan.ControlID.ValueString(), complianceControlInputFrom(plan))
	if err != nil {
		resp.Diagnostics.AddError("Unable to save compliance control decision", err.Error())
		return
	}
	state := complianceControlStateFrom(remote, plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *complianceControlResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state complianceControlResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetComplianceControlSetting(ctx, state.FrameworkID.ValueString(), state.ControlID.ValueString())
	if err != nil {
		// No stored decision: somebody reset the control outside Terraform
		// (or the control left the registry). Either way it needs writing again.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read compliance control decision", err.Error())
		return
	}
	refreshed := complianceControlStateFrom(remote, state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *complianceControlResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan complianceControlResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// PUT is an upsert, so a decision reset out of band is simply written
	// again here; there is no 404 to recover from.
	remote, err := r.client.PutComplianceControlSetting(ctx, plan.FrameworkID.ValueString(), plan.ControlID.ValueString(), complianceControlInputFrom(plan))
	if err != nil {
		resp.Diagnostics.AddError("Unable to save compliance control decision", err.Error())
		return
	}
	next := complianceControlStateFrom(remote, plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *complianceControlResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state complianceControlResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	err := r.client.DeleteComplianceControlSetting(ctx, state.FrameworkID.ValueString(), state.ControlID.ValueString())
	if err != nil && !iw.IsNotFound(err) {
		resp.Diagnostics.AddError("Unable to reset compliance control decision", err.Error())
	}
}

// ImportState takes "<framework_id>/<control_id>", split on the first slash:
// framework ids never contain one, so anything after it belongs to the control.
func (r *complianceControlResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	frameworkID, controlID, ok := strings.Cut(req.ID, "/")
	if !ok || strings.TrimSpace(frameworkID) == "" || strings.TrimSpace(controlID) == "" {
		resp.Diagnostics.AddError("Invalid import id",
			`expected an import id of the form "<framework_id>/<control_id>", e.g. "soc2/CC6.1", got "`+req.ID+`"`)
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("framework_id"), frameworkID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("control_id"), controlID)...)
}

/* -------------------------------- mapping --------------------------------- */

// complianceControlInputFrom maps configuration onto the PUT body. Every
// optional string is sent, null when unset, because the PUT is a full replace.
func complianceControlInputFrom(model complianceControlResourceModel) iw.ComplianceControlSettingInput {
	return iw.ComplianceControlSettingInput{
		Applicable:    model.Applicable.ValueBool(),
		Justification: stringPtr(model.Justification),
		OwnerUserID:   stringPtr(model.OwnerUserID),
		OwnerLabel:    stringPtr(model.OwnerLabel),
		Notes:         stringPtr(model.Notes),
	}
}

// complianceControlStateFrom maps the stored decision into state.
//
// The server trims every string and stores an empty one as null. Writing its
// answer back verbatim would turn a configured `"Owned by SRE "` into an
// inconsistent result after apply, so each string keeps the prior value while
// it trims to what the server holds, and takes the server's otherwise (which
// is how an out-of-band edit shows up as drift).
func complianceControlStateFrom(remote *iw.ComplianceControlSetting, prior complianceControlResourceModel) complianceControlResourceModel {
	return complianceControlResourceModel{
		ID:            types.StringValue(remote.FrameworkID + "/" + remote.ControlID),
		FrameworkID:   types.StringValue(remote.FrameworkID),
		ControlID:     types.StringValue(remote.ControlID),
		Applicable:    types.BoolValue(remote.Applicable),
		Justification: trimmedStringValue(prior.Justification, remote.Justification),
		OwnerUserID:   trimmedStringValue(prior.OwnerUserID, remote.OwnerUserID),
		OwnerLabel:    trimmedStringValue(prior.OwnerLabel, remote.OwnerLabel),
		Notes:         trimmedStringValue(prior.Notes, remote.Notes),
		UpdatedAt:     types.StringValue(remote.UpdatedAt),
	}
}

// trimmedStringValue reconciles a prior value with a server that trims and
// nulls empty strings: the prior wins while it is equivalent.
func trimmedStringValue(prior types.String, remote *string) types.String {
	stored := ""
	if remote != nil {
		stored = *remote
	}
	if !prior.IsNull() && !prior.IsUnknown() && strings.TrimSpace(prior.ValueString()) == stored {
		return prior
	}
	return stringValue(remote)
}
