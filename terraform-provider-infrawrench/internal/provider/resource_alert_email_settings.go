package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*alertEmailSettingsResource)(nil)
	_ resource.ResourceWithConfigure   = (*alertEmailSettingsResource)(nil)
	_ resource.ResourceWithImportState = (*alertEmailSettingsResource)(nil)
)

// NewAlertEmailSettingsResource constructs the
// infrawrench_alert_email_settings resource.
func NewAlertEmailSettingsResource() resource.Resource { return &alertEmailSettingsResource{} }

type alertEmailSettingsResource struct{ client *iw.Client }

type alertEmailSettingsResourceModel struct {
	ID             types.String `tfsdk:"id"`
	ExternalPolicy types.String `tfsdk:"external_policy"`
	AllowedDomains types.Set    `tfsdk:"allowed_domains"`
	EmailAvailable types.Bool   `tfsdk:"email_available"`
	MemberDomains  types.Set    `tfsdk:"member_domains"`
	Suppressions   types.List   `tfsdk:"suppressions"`
}

type alertEmailSuppressionModel struct {
	ID        types.String `tfsdk:"id"`
	Email     types.String `tfsdk:"email"`
	CreatedAt types.String `tfsdk:"created_at"`
}

var alertEmailSuppressionAttrTypes = map[string]attr.Type{
	"id":         types.StringType,
	"email":      types.StringType,
	"created_at": types.StringType,
}

var alertEmailSuppressionObjectType = types.ObjectType{AttrTypes: alertEmailSuppressionAttrTypes}

var alertEmailExternalPolicies = []string{"member-domains", "any"}

// alertEmailMaxAllowedDomains is the API's cap on allowedDomains.
const alertEmailMaxAllowedDomains = 50

// alertEmailDefaults is what destroy writes: the policy every organization
// ships with. It is the restrictive end of the two, which is the point.
func alertEmailDefaults() iw.AlertEmailSettings {
	return iw.AlertEmailSettings{ExternalPolicy: "member-domains", AllowedDomains: []string{}}
}

func (r *alertEmailSettingsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_alert_email_settings"
}

func (r *alertEmailSettingsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "The organization's external-address policy for alert email: which literal " +
			"addresses `email_addresses` (on `infrawrench_budget`, `infrawrench_cost_alert`, " +
			"`infrawrench_anomaly_settings` and `infrawrench_efficiency_alert_settings`) and `email-address` " +
			"routing destinations (on `infrawrench_alert_routing`) may name. Members reached by user id are " +
			"never subject to it.\n\n" +
			"An address is checked when the object naming it is saved and again when an alert is sent. " +
			"Tightening the policy does not edit any stored recipient list: an address that no longer " +
			"passes is skipped at send time, and loosening the policy again brings it back.\n\n" +
			"Writing it needs the `org:settings:write` permission.\n\n" +
			"An organization **singleton**, written as a whole object. `terraform destroy` restores the " +
			"shipped default (`member-domains` with no extra domains) rather than leaving the policy as " +
			"configured: a no-op would leave an `any` policy in place for a configuration that no longer " +
			"asks for it, and of the two ways to be wrong, the one that sends mail to fewer outside " +
			"mailboxes is the safer.",
		Attributes: map[string]schema.Attribute{
			"id": singletonIDAttribute("The alert email policy"),
			"external_policy": schema.StringAttribute{
				Optional: true,
				Computed: true,
				Default:  stringdefault.StaticString("member-domains"),
				MarkdownDescription: "One of `" + joinBackticked(alertEmailExternalPolicies) + "`. " +
					"`member-domains`, the default, accepts an extra address only on a domain one of the " +
					"organization's members signs in with (see `member_domains`) or one listed in " +
					"`allowed_domains`. `any` accepts every address.",
				Validators: []validatorString{oneOfValidator(alertEmailExternalPolicies...)},
			},
			"allowed_domains": schema.SetAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				Default:     setdefault.StaticValue(types.SetValueMust(types.StringType, []attr.Value{})),
				MarkdownDescription: "Extra domains accepted under `member-domains`, without the `@`, e.g. " +
					"`partner-agency.com`. At most 50. Ignored under `any`. Defaults to none: the route " +
					"replaces the whole object, so leaving this out clears it.",
				Validators: []validatorSet{setSizeAtMost(alertEmailMaxAllowedDomains)},
			},
			"email_available": schema.BoolAttribute{
				Computed: true,
				MarkdownDescription: "Whether this deployment has a mail provider configured. `false` means " +
					"no alert email is ever sent, whatever the recipient lists say.",
			},
			"member_domains": schema.SetAttribute{
				Computed:    true,
				ElementType: types.StringType,
				MarkdownDescription: "Domains the organization's members sign in with: the implicit " +
					"allowlist under `member-domains`. Follows membership, not configuration.",
			},
			"suppressions": schema.ListNestedAttribute{
				Computed: true,
				MarkdownDescription: "Addresses that used the unsubscribe link in an alert email. They " +
					"receive no alert email from this organization until an admin removes the entry in " +
					"the app. Read-only on purpose: the recipient controls this list, not the " +
					"organization's configuration, so it is reported here and never planned.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "Suppression id.",
						},
						"email": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "The unsubscribed address.",
						},
						"created_at": schema.StringAttribute{
							Computed:            true,
							MarkdownDescription: "RFC 3339 timestamp of the unsubscribe.",
						},
					},
				},
			},
		},
	}
}

func (r *alertEmailSettingsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// Create is an update in disguise: the policy always exists, defaulted.
func (r *alertEmailSettingsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan alertEmailSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

func (r *alertEmailSettingsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state alertEmailSettingsResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetAlertEmailSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Unable to read alert email settings", err.Error())
		return
	}

	refreshed, diags := alertEmailSettingsStateFrom(ctx, r.client.OrgID(), remote)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *alertEmailSettingsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan alertEmailSettingsResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.write(ctx, plan, &resp.Diagnostics, &resp.State)
}

// Delete restores the restrictive default. See the schema description.
func (r *alertEmailSettingsResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if _, err := r.client.PutAlertEmailSettings(ctx, alertEmailDefaults()); err != nil {
		resp.Diagnostics.AddError("Unable to reset alert email settings", err.Error())
	}
}

func (r *alertEmailSettingsResource) ImportState(ctx context.Context, _ resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importOrgSingleton(ctx, r.client.OrgID(), resp)
}

func (r *alertEmailSettingsResource) write(ctx context.Context, plan alertEmailSettingsResourceModel, diags *diagnostics, state *tfState) {
	domains := []string{}
	if !plan.AllowedDomains.IsNull() && !plan.AllowedDomains.IsUnknown() {
		diags.Append(plan.AllowedDomains.ElementsAs(ctx, &domains, false)...)
		if diags.HasError() {
			return
		}
	}

	saved, err := r.client.PutAlertEmailSettings(ctx, iw.AlertEmailSettings{
		ExternalPolicy: plan.ExternalPolicy.ValueString(),
		AllowedDomains: domains,
	})
	if err != nil {
		diags.AddError("Unable to write alert email settings", err.Error())
		return
	}

	next, d := alertEmailSettingsStateFrom(ctx, r.client.OrgID(), saved)
	diags.Append(d...)
	if diags.HasError() {
		return
	}
	diags.Append(state.Set(ctx, &next)...)
}

// alertEmailSettingsStateFrom maps the settings view into state.
//
// The three computed attributes deliberately carry no UseStateForUnknown:
// suppressions and member domains move under recipients and membership, not
// configuration, so a value copied from state into the plan could be stale by
// apply time and Terraform would reject the write as inconsistent. Leaving them
// unknown on an update costs a "known after apply" line and nothing else; a
// plain refresh updates them without ever showing a diff.
func alertEmailSettingsStateFrom(ctx context.Context, orgID string, remote *iw.AlertEmailSettingsView) (alertEmailSettingsResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	allowed := remote.AllowedDomains
	if allowed == nil {
		allowed = []string{}
	}
	allowedSet, d := types.SetValueFrom(ctx, types.StringType, allowed)
	diags.Append(d...)

	memberDomains := remote.MemberDomains
	if memberDomains == nil {
		memberDomains = []string{}
	}
	memberSet, d := types.SetValueFrom(ctx, types.StringType, memberDomains)
	diags.Append(d...)

	rows := make([]alertEmailSuppressionModel, 0, len(remote.Suppressions))
	for _, s := range remote.Suppressions {
		rows = append(rows, alertEmailSuppressionModel{
			ID:        types.StringValue(s.ID),
			Email:     types.StringValue(s.Email),
			CreatedAt: types.StringValue(s.CreatedAt),
		})
	}
	suppressions, d := types.ListValueFrom(ctx, alertEmailSuppressionObjectType, rows)
	diags.Append(d...)

	return alertEmailSettingsResourceModel{
		ID:             types.StringValue(orgID),
		ExternalPolicy: types.StringValue(remote.ExternalPolicy),
		AllowedDomains: allowedSet,
		EmailAvailable: types.BoolValue(remote.EmailAvailable),
		MemberDomains:  memberSet,
		Suppressions:   suppressions,
	}, diags
}
