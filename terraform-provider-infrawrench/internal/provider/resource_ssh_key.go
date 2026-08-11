package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*sshKeyResource)(nil)
	_ resource.ResourceWithConfigure   = (*sshKeyResource)(nil)
	_ resource.ResourceWithImportState = (*sshKeyResource)(nil)
)

// NewSSHKeyResource constructs the infrawrench_ssh_key resource.
func NewSSHKeyResource() resource.Resource { return &sshKeyResource{} }

type sshKeyResource struct{ client *iw.Client }

type sshKeyResourceModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	PublicKey   types.String `tfsdk:"public_key"`
	KeyType     types.String `tfsdk:"key_type"`
	Fingerprint types.String `tfsdk:"fingerprint"`
	IsImported  types.Bool   `tfsdk:"is_imported"`
	PrivateKey  types.String `tfsdk:"private_key"`
}

func (r *sshKeyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_ssh_key"
}

func (r *sshKeyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "An SSH key registered with the organization, in one of two modes.\n\n" +
			"**Import a key you already hold** by setting `public_key`. Nothing secret enters Terraform, " +
			"and this is the mode to reach for by default.\n\n" +
			"**Have the server generate one** by leaving `public_key` unset. The private half is returned " +
			"exactly once and lands in your state file in plaintext — same warning as " +
			"`infrawrench_api_key`: only do this with a state backend you would keep any other secret in.\n\n" +
			"There is no update route. Every attribute forces replacement.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned key id. Use it with `terraform import`."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"public_key": schema.StringAttribute{
				Optional: true,
				Computed: true,
				MarkdownDescription: "OpenSSH public key line, e.g. `ssh-ed25519 AAAA… you@host`. Set it to " +
					"register a key you already have; leave it unset to have one generated, in which case it " +
					"is filled in from the response.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
					stringplanmodifier.UseStateForUnknown(),
				},
			},

			"key_type": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Algorithm, e.g. `ssh-ed25519`. Parsed from the key rather than configured.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"fingerprint": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Key fingerprint, for comparing against what a host reports.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"is_imported": schema.BoolAttribute{
				Computed:            true,
				MarkdownDescription: "`true` when the key was registered rather than generated.",
			},
			"private_key": schema.StringAttribute{
				Computed:  true,
				Sensitive: true,
				MarkdownDescription: "The generated private key, in OpenSSH format. Returned **once**, at " +
					"creation, and not persisted in plaintext server-side.\n\n" +
					"Null for an imported key, and null after an import into Terraform: nothing can recover it.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *sshKeyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// Create picks the route from whether a public key was supplied. The two are
// different endpoints rather than one with an optional field, which is why the
// resource branches here rather than in the client.
func (r *sshKeyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan sshKeyResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	var (
		created *iw.GeneratedSSHKey
		err     error
	)
	if plan.PublicKey.IsNull() || plan.PublicKey.IsUnknown() {
		created, err = r.client.GenerateSSHKey(ctx, iw.GenerateSSHKeyRequest{Name: plan.Name.ValueString()})
	} else {
		created, err = r.client.ImportSSHKey(ctx, iw.ImportSSHKeyRequest{
			Name:      plan.Name.ValueString(),
			PublicKey: plan.PublicKey.ValueString(),
		})
	}
	if err != nil {
		resp.Diagnostics.AddError("Unable to create SSH key", err.Error())
		return
	}

	state := sshKeyResourceModel{
		ID:          types.StringValue(created.ID),
		Name:        types.StringValue(created.Name),
		PublicKey:   types.StringValue(created.PublicKey),
		KeyType:     types.StringValue(created.KeyType),
		Fingerprint: types.StringValue(created.Fingerprint),
		IsImported:  boolValueOrDefault(created.IsImported, !plan.PublicKey.IsNull()),
		PrivateKey:  stringValue(created.PrivateKey),
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *sshKeyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state sshKeyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetSSHKey(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read SSH key", err.Error())
		return
	}

	refreshed := sshKeyResourceModel{
		ID:          types.StringValue(remote.ID),
		Name:        types.StringValue(remote.Name),
		PublicKey:   types.StringValue(remote.PublicKey),
		KeyType:     types.StringValue(remote.KeyType),
		Fingerprint: stringValue(remote.Fingerprint),
		IsImported:  types.BoolValue(remote.IsImported),
		// Carried forward: no route returns it, so refreshing must not drop it
		// from the state of a key that was generated.
		PrivateKey: state.PrivateKey,
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

// Update is unreachable — every attribute forces replacement.
func (r *sshKeyResource) Update(_ context.Context, _ resource.UpdateRequest, resp *resource.UpdateResponse) {
	resp.Diagnostics.AddError(
		"SSH keys cannot be updated",
		"Every attribute of infrawrench_ssh_key forces replacement, so this should be unreachable. "+
			"Please report it to the provider developers.")
}

func (r *sshKeyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state sshKeyResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteSSHKey(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete SSH key", err.Error())
	}
}

func (r *sshKeyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
