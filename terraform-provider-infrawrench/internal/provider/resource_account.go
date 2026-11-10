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
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*accountResource)(nil)
	_ resource.ResourceWithConfigure   = (*accountResource)(nil)
	_ resource.ResourceWithImportState = (*accountResource)(nil)
)

// NewAccountResource constructs the infrawrench_account resource.
func NewAccountResource() resource.Resource { return &accountResource{} }

type accountResource struct{ client *iw.Client }

type accountResourceModel struct {
	ID          types.String `tfsdk:"id"`
	PluginID    types.String `tfsdk:"plugin_id"`
	DisplayName types.String `tfsdk:"display_name"`
	Credentials types.Map    `tfsdk:"credentials"`
	BastionID   types.String `tfsdk:"bastion_id"`
	Products    types.Set    `tfsdk:"products"`
}

// accountProductIDs are the apps a connection can be made for. The list is the
// product ids of the plugin contract (`PRODUCT_IDS`); which of them a given
// plugin offers is decided by the server, which rejects the rest by name.
var accountProductIDs = []string{
	"infrastructure", "costs", "observability", "incidents", "security", "delivery", "automation",
}

func (r *accountResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_account"
}

func (r *accountResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A connected cloud account — the credential Infrawrench uses to list and manage " +
			"one provider's resources.\n\n" +
			"This is the resource that makes onboarding an environment reproducible: a new organization " +
			"gets its accounts, cost centres, budgets and alerts from one `terraform apply` instead of " +
			"from a runbook.\n\n" +
			"**Credentials are write-only.** No route returns them, so the provider cannot detect drift on " +
			"their values: a secret rotated in the Infrawrench UI will not show up as a diff here, and the " +
			"next apply that touches `credentials` overwrites it. Feed them from a secret manager rather " +
			"than a literal — and remember that whatever Terraform sends is in the state file and in any " +
			"saved plan.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned account id. Use it with `terraform import` — though an " +
				"imported account has no `credentials` in state, so supply them in configuration."),
			"plugin_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Which provider plugin this account is for, e.g. `aws`. Resolve the valid " +
					"ids with `data.infrawrench_plugins`. Fixed at creation: an account is its credential, and " +
					"a credential does not change provider.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"display_name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Name shown throughout the app, e.g. `Production (eu-west-1)`.",
			},
			"credentials": schema.MapAttribute{
				Required:    true,
				ElementType: types.StringType,
				Sensitive:   true,
				MarkdownDescription: "The plugin's credential fields, keyed by the field names that plugin " +
					"declares — `accessKeyId` and `secretAccessKey` for AWS, a kubeconfig for Kubernetes, a " +
					"personal access token for most SaaS providers. The account creation form in the app lists " +
					"them per plugin.\n\n" +
					"A write replaces the whole set, so send every field the plugin needs and not just the one " +
					"you are rotating.",
			},
			"bastion_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Route this account's cloud API traffic through an `infrawrench_bastion`. " +
					"Omit it to reach the provider directly from Infrawrench.",
			},
			"products": schema.SetAttribute{
				Optional:    true,
				ElementType: types.StringType,
				MarkdownDescription: "The apps this connection is for: any of `infrastructure`, `costs`, " +
					"`observability`, `incidents`, `security`, `delivery`, `automation` that the plugin " +
					"offers. Omit it for every app, which is what an account connected before this choice " +
					"existed has.\n\n" +
					"Collection follows the choice, so the credential only needs the permissions of the " +
					"apps listed: an account for `[\"costs\"]` alone has its bill read and no resources " +
					"synced, and one without `costs` has no cost data collected. A plugin offers the apps " +
					"its capabilities power (most clouds offer `infrastructure`, `costs` and " +
					"`observability`); naming one it does not offer, or setting this on a plugin that offers " +
					"no choice, is rejected when applied with a message listing what it does offer.\n\n" +
					"Do not list every app the plugin offers: that is the same as omitting the attribute, " +
					"and it is stored as such. The provider keeps your list in state in that case, so an " +
					"out-of-band change back to every app is not reported as drift.",
				Validators: []validator.Set{
					setvalidator.SizeAtLeast(1),
					setvalidator.ValueStringsAre(stringvalidator.OneOf(accountProductIDs...)),
				},
			},
		},
	}
}

// productsFromPlan reads the configured apps, nil for a null attribute (every
// app). The order is not significant: the server stores them in its own.
func productsFromPlan(ctx context.Context, set types.Set) ([]string, diag.Diagnostics) {
	if set.IsNull() || set.IsUnknown() {
		return nil, nil
	}
	var out []string
	diags := set.ElementsAs(ctx, &out, false)
	return out, diags
}

// productsForState renders what the server stores. The server stores "every
// app the plugin offers" as null, including when a list naming all of them was
// sent, so a null answer under a configured list keeps the list: replacing it
// with null would plan a change on every run that no apply could settle.
func productsForState(ctx context.Context, remote []string, prior types.Set) (types.Set, diag.Diagnostics) {
	if remote == nil {
		if prior.IsNull() || prior.IsUnknown() {
			return types.SetNull(types.StringType), nil
		}
		return prior, nil
	}
	return types.SetValueFrom(ctx, types.StringType, remote)
}

func (r *accountResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// Create connects the account.
//
// A first sync that fails is reported as a warning rather than an error: the
// account exists, and failing the apply would leave a connected account outside
// Terraform's state; the worst of both outcomes. A credential that is actually
// wrong shows up as a sync error in the app, where it can be fixed.
func (r *accountResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan accountResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	credentials, diags := stringMap(ctx, plan.Credentials)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	products, diags := productsFromPlan(ctx, plan.Products)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateAccount(ctx, iw.CreateAccountRequest{
		PluginID:    plan.PluginID.ValueString(),
		DisplayName: plan.DisplayName.ValueString(),
		Credentials: credentials,
		BastionID:   stringPtr(plan.BastionID),
		Products:    products,
	})
	if err != nil {
		resp.Diagnostics.AddError("Unable to connect account", err.Error())
		return
	}
	if created.SyncError != nil {
		resp.Diagnostics.AddWarning(
			"The account was connected but its first sync failed",
			created.SyncError.Message+
				"\n\nThe account exists and is under Terraform's management. Check the credential in the "+
				"app — resources will not be listed until a sync succeeds.")
	}

	state := plan
	state.ID = types.StringValue(created.ID)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Read refreshes the account.
//
// `credentials` is carried forward from prior state untouched, because no route
// returns it. That is the one place this resource cannot detect drift, and it is
// called out in the schema description rather than papered over.
func (r *accountResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state accountResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetAccount(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read account", err.Error())
		return
	}

	products, diags := productsForState(ctx, remote.Products, state.Products)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	refreshed := accountResourceModel{
		ID:          types.StringValue(remote.ID),
		PluginID:    types.StringValue(remote.PluginID),
		DisplayName: types.StringValue(remote.DisplayName),
		Credentials: state.Credentials,
		BastionID:   stringValue(remote.BastionID),
		Products:    products,
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

// Update writes the name, the bastion binding and the apps the connection is
// for, and rotates the credentials when they changed.
//
// They are two routes because they are gated on different permissions (renaming
// an account is `accounts:write`, replacing its secret is `secrets:write`) so a
// token that may do one and not the other gets a clear failure on the half it
// may not do, rather than being refused the whole update.
func (r *accountResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan accountResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state accountResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	products, diags := productsFromPlan(ctx, plan.Products)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	id := state.ID.ValueString()
	err := r.client.UpdateAccount(ctx, id, iw.UpdateAccountRequest{
		DisplayName: stringPtr(plan.DisplayName),
		BastionID:   stringPtr(plan.BastionID),
		Products:    products,
	})
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Account no longer exists",
				"The account was removed outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update account", err.Error())
		return
	}

	// The rename has already landed at this point. If the credential rotation
	// then fails, state has to record the half that succeeded and keep the *old*
	// credentials: writing the plan's wholesale would claim a rotation that did
	// not happen, and the next apply would see no diff and never retry it.
	next := plan
	next.ID = state.ID

	if !plan.Credentials.Equal(state.Credentials) {
		credentials, diags := stringMap(ctx, plan.Credentials)
		resp.Diagnostics.Append(diags...)
		if resp.Diagnostics.HasError() {
			return
		}
		if err := r.client.PutAccountCredentials(ctx, id, iw.AccountCredentialsInput{Credentials: credentials}); err != nil {
			next.Credentials = state.Credentials
			resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
			resp.Diagnostics.AddError(
				"The account was updated but its credentials could not be rotated",
				err.Error()+"\n\nRotating a credential is gated on `secrets:write`, which renaming an "+
					"account is not — a token holding only `accounts:write` reaches exactly this point. "+
					"The name and bastion binding have been saved; the next apply retries the rotation.")
			return
		}
	}

	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

// Delete disconnects the account and removes the resources synced from it. The
// cloud resources themselves are untouched: this is a credential, not the
// account at the provider.
func (r *accountResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state accountResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteAccount(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to disconnect account", err.Error())
	}
}

func (r *accountResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
