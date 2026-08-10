package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/objectvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                = (*costExportResource)(nil)
	_ resource.ResourceWithConfigure   = (*costExportResource)(nil)
	_ resource.ResourceWithImportState = (*costExportResource)(nil)
)

// costExportQueryVersion is the query document version this provider writes.
//
// The field is part of the stored document rather than of the route, so the
// server can evolve the query language and keep reading old exports. The
// provider pins it: the schema below describes version 1 and nothing else, so
// hard-coding it is more honest than exposing a number a practitioner could set
// to a version whose semantics this resource does not implement.
const costExportQueryVersion int64 = 1

// NewCostExportResource constructs the infrawrench_cost_export resource.
func NewCostExportResource() resource.Resource { return &costExportResource{} }

type costExportResource struct{ client *iw.Client }

type costExportQueryModel struct {
	Dimensions  types.List   `tfsdk:"dimensions"`
	TagKeys     types.List   `tfsdk:"tag_keys"`
	ChargeTypes types.List   `tfsdk:"charge_types"`
	CostBasis   types.String `tfsdk:"cost_basis"`
	Filter      types.List   `tfsdk:"filter"`
}

var costExportQueryAttrTypes = map[string]attr.Type{
	"dimensions":   types.ListType{ElemType: types.StringType},
	"tag_keys":     types.ListType{ElemType: types.StringType},
	"charge_types": types.ListType{ElemType: types.StringType},
	"cost_basis":   types.StringType,
	"filter":       types.ListType{ElemType: costFilterObjectType},
}

type costExportDestinationModel struct {
	Kind           types.String `tfsdk:"kind"`
	Bucket         types.String `tfsdk:"bucket"`
	Prefix         types.String `tfsdk:"prefix"`
	Region         types.String `tfsdk:"region"`
	Endpoint       types.String `tfsdk:"endpoint"`
	ForcePathStyle types.Bool   `tfsdk:"force_path_style"`
	Method         types.String `tfsdk:"method"`
	URLHint        types.String `tfsdk:"url_hint"`
}

var costExportDestinationAttrTypes = map[string]attr.Type{
	"kind":             types.StringType,
	"bucket":           types.StringType,
	"prefix":           types.StringType,
	"region":           types.StringType,
	"endpoint":         types.StringType,
	"force_path_style": types.BoolType,
	"method":           types.StringType,
	"url_hint":         types.StringType,
}

type costExportResourceModel struct {
	ID              types.String `tfsdk:"id"`
	Name            types.String `tfsdk:"name"`
	Format          types.String `tfsdk:"format"`
	Cadence         types.String `tfsdk:"cadence"`
	Hour            types.Int64  `tfsdk:"hour"`
	Timezone        types.String `tfsdk:"timezone"`
	RestatementDays types.Int64  `tfsdk:"restatement_days"`
	Enabled         types.Bool   `tfsdk:"enabled"`

	AccessKeyID     types.String `tfsdk:"access_key_id"`
	SecretAccessKey types.String `tfsdk:"secret_access_key"`
	URL             types.String `tfsdk:"url"`
	HasCredentials  types.Bool   `tfsdk:"has_credentials"`
	CredentialHint  types.String `tfsdk:"credential_hint"`

	Query       types.Object `tfsdk:"query"`
	Destination types.Object `tfsdk:"destination"`
}

func (r *costExportResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_cost_export"
}

func (r *costExportResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A scheduled delivery of cost rows to an S3-compatible bucket or an HTTP " +
			"endpoint.\n\n" +
			"**Credentials are write-only.** `access_key_id`, `secret_access_key` and `url` are " +
			"accepted on write and never returned by any route — not by the create response, not " +
			"by a read, not by the listing. Three things follow, and all three are permanent " +
			"properties of the API rather than gaps this provider will close:\n\n" +
			"1. The provider cannot detect drift on a credential. If someone rotates the stored " +
			"secret through the UI, Terraform will not notice and will not plan a change. The " +
			"only way to be certain of the stored value is to write it again.\n" +
			"2. On update, a credential left out of the configuration is *kept*, not cleared. " +
			"There is no way to express \"remove the secret and leave the export\"; delete and " +
			"recreate the export instead.\n" +
			"3. On import, credentials are unrecoverable — see the import notes below.\n\n" +
			"`has_credentials` and `credential_hint` are the only readable signal that a secret " +
			"exists at all.\n\n" +
			"Operational state — when the export last ran, whether it succeeded, how many rows and " +
			"objects it wrote, when it runs next — is deliberately not exposed. It changes on every " +
			"refresh and would make every plan noisy for no gain, exactly as budget spend status is " +
			"left off `infrawrench_budget`. Read it from the UI, the CLI, or the API.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Server-assigned export id. Use it with `terraform import`.",
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1–120 characters.",
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
			},
			"format": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "`csv` for a spreadsheet-and-warehouse friendly file, `ndjson` for " +
					"one JSON object per line.",
				Validators: []validator.String{oneOfValidator("csv", "ndjson")},
			},
			"cadence": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "How often the export runs: `daily`, `weekly` or `monthly`.",
				Validators:          []validator.String{oneOfValidator("daily", "weekly", "monthly")},
			},
			"hour": schema.Int64Attribute{
				Required:            true,
				MarkdownDescription: "Hour of the day the run starts, 0–23, interpreted in `timezone`.",
				Validators:          []validator.Int64{int64validator.Between(0, 23)},
			},
			"timezone": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "IANA timezone name the schedule is expressed in, e.g. `Europe/London`. " +
					"It is the zone, not a fixed offset, so the wall-clock `hour` survives daylight saving.",
				Validators: []validator.String{stringvalidator.LengthAtLeast(1)},
			},
			"restatement_days": schema.Int64Attribute{
				Required: true,
				MarkdownDescription: "How many days of already-exported history to re-emit on each run, " +
					"0–90. Providers restate recent spend after the fact, so a window here is what " +
					"keeps a warehouse's copy in step with the invoice. Set it to 0 only if the " +
					"consumer reconciles restatements itself.",
				Validators: []validator.Int64{int64validator.Between(0, 90)},
			},
			"enabled": schema.BoolAttribute{
				Optional: true,
				Computed: true,
				Default:  booldefault.StaticBool(true),
				MarkdownDescription: "Whether the schedule runs. Disabling pauses delivery without " +
					"discarding the stored credential.",
			},
			"access_key_id": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				MarkdownDescription: "Access key id for an `s3` destination. Write-only: the API never " +
					"returns it, so the provider cannot tell whether the stored value still matches " +
					"this one, and omitting it on a later apply keeps whatever is stored rather than " +
					"clearing it.",
			},
			"secret_access_key": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				MarkdownDescription: "Secret access key for an `s3` destination. Write-only, with the same " +
					"consequences as `access_key_id`: no drift detection, and omission means keep.",
			},
			"url": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				MarkdownDescription: "Full webhook URL for an `http` destination, including any secret in " +
					"its path or query. It travels as a top-level credential rather than inside the " +
					"`destination` block precisely because it is secret material. Write-only: no " +
					"drift detection, and omission means keep. Supplying a new one recomputes " +
					"`destination.url_hint`.",
			},
			"has_credentials": schema.BoolAttribute{
				Computed: true,
				MarkdownDescription: "Whether the server holds a credential for this export. Together with " +
					"`credential_hint` this is the only readable evidence a secret exists.",
			},
			"credential_hint": schema.StringAttribute{
				Computed: true,
				MarkdownDescription: "Redacted fragment of the stored credential, e.g. `AKIA…7F2Q`. Enough " +
					"to recognise which key is in place, never enough to reconstruct it.",
			},
		},
		Blocks: map[string]schema.Block{
			"query": schema.SingleNestedBlock{
				MarkdownDescription: "Which rows and columns the export emits. Required.",
				Attributes: map[string]schema.Attribute{
					"dimensions": schema.ListAttribute{
						Required:    true,
						ElementType: types.StringType,
						MarkdownDescription: "Columns to group the exported rows by, in order, at most 8. " +
							"Each is one of `" + joinBackticked(costDimensions) + "`. More dimensions " +
							"means more rows: this is the knob that decides whether the export is a " +
							"summary or a ledger.",
						Validators: []validator.List{
							listvalidator.SizeAtMost(8),
							listvalidator.ValueStringsAre(oneOfValidator(costDimensions...)),
						},
					},
					"tag_keys": schema.ListAttribute{
						Optional:    true,
						ElementType: types.StringType,
						MarkdownDescription: "Tag keys to emit as their own columns, at most 25. Only " +
							"meaningful for keys your resources actually carry; see " +
							"`infrawrench_tag_policy` for enforcing that.",
						Validators: []validator.List{listvalidator.SizeAtMost(25)},
					},
					"charge_types": schema.ListAttribute{
						Optional:    true,
						ElementType: types.StringType,
						MarkdownDescription: "Restrict the export to these classes of charge, e.g. `usage`, " +
							"`commitment_fee`, `credit`, `tax`. Leave unset to export every class.",
					},
					"cost_basis": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "`cash` to export invoiced spend, `amortized` to spread " +
							"commitment fees across the term they cover.",
						Validators: []validator.String{oneOfValidator("cash", "amortized")},
					},
				},
				Blocks: map[string]schema.Block{
					"filter": costExportFilterBlockSchema(),
				},
				Validators: []validator.Object{objectvalidator.IsRequired()},
			},
			"destination": schema.SingleNestedBlock{
				MarkdownDescription: "Where the files go. Required.\n\n" +
					"The two branches do not mix: the server's destination schema is a strict " +
					"discriminated union, so the provider sends only the keys belonging to `kind` " +
					"and an `endpoint` left over from an earlier `s3` configuration is not " +
					"quietly forwarded on an `http` destination. Attributes belonging to the other " +
					"branch are rejected rather than ignored.",
				Attributes: map[string]schema.Attribute{
					"kind": schema.StringAttribute{
						Required: true,
						MarkdownDescription: "`s3` to write objects to an S3-compatible bucket, `http` to " +
							"POST or PUT each file to a webhook.",
						Validators: []validator.String{oneOfValidator("s3", "http")},
					},
					"bucket": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "Bucket name. `s3` only.",
					},
					"prefix": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "Key prefix objects are written under. `s3` only.",
					},
					"region": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "Bucket region, e.g. `eu-west-2`. `s3` only.",
					},
					"endpoint": schema.StringAttribute{
						Optional: true,
						MarkdownDescription: "Custom S3 endpoint for a non-AWS implementation such as R2, " +
							"MinIO or Spaces. `s3` only; leave unset for AWS.",
					},
					"force_path_style": schema.BoolAttribute{
						Optional: true,
						MarkdownDescription: "Address objects as `endpoint/bucket/key` rather than as a " +
							"virtual host. Most self-hosted S3 implementations need this. `s3` only.",
					},
					"method": schema.StringAttribute{
						Optional:            true,
						MarkdownDescription: "HTTP method each file is delivered with, `POST` or `PUT`. `http` only.",
						Validators:          []validator.String{oneOfValidator("POST", "PUT")},
					},
					"url_hint": schema.StringAttribute{
						Computed: true,
						MarkdownDescription: "Server's redacted echo of the `http` destination's URL, " +
							"recomputed whenever a new `url` is supplied. Null for an `s3` destination.",
					},
				},
				Validators: []validator.Object{objectvalidator.IsRequired()},
			},
		},
	}
}

// costExportFilterBlockSchema is the shared cost filter block with the export's
// own cap on it.
func costExportFilterBlockSchema() schema.ListNestedBlock {
	block := costFilterBlockSchema(
		"Restricts the export to matching spend. Clauses are ANDed. At most 25.")
	block.Validators = []validator.List{listvalidator.SizeAtMost(25)}
	return block
}

func (r *costExportResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

func (r *costExportResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan costExportResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := costExportInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateCostExport(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create cost export", err.Error())
		return
	}

	state, diags := costExportStateFrom(ctx, created, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *costExportResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state costExportResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetCostExport(ctx, state.ID.ValueString())
	if err != nil {
		// Deleted outside Terraform: drop it from state so the next plan
		// recreates it, rather than failing the refresh.
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read cost export", err.Error())
		return
	}

	refreshed, diags := costExportStateFrom(ctx, remote, state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *costExportResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan costExportResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state costExportResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := costExportInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateCostExport(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"Cost export no longer exists",
				"The cost export was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update cost export", err.Error())
		return
	}

	next, diags := costExportStateFrom(ctx, updated, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *costExportResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state costExportResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteCostExport(ctx, state.ID.ValueString()); err != nil {
		// Already gone is the outcome we wanted.
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete cost export", err.Error())
	}
}

// ImportState takes the export id and reads everything the API will give back —
// which does not include the credential.
//
// An imported export therefore lands in state with `access_key_id`,
// `secret_access_key` and `url` all null, whatever the server actually holds.
// There is no route that would let the provider recover them and no hint format
// they could be reconstructed from. The practitioner must put the real values
// back into the configuration after importing; the first apply then writes them
// through. Until that happens the plan will show the credentials being added,
// which is accurate — Terraform genuinely does not know them.
//
// `has_credentials` and `credential_hint` do import correctly, so they are the
// way to confirm which key the export is currently delivering with.
func (r *costExportResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

/* -------------------------------- mapping --------------------------------- */

func costExportInputFrom(ctx context.Context, model costExportResourceModel) (iw.CostExportInput, diag.Diagnostics) {
	var diags diag.Diagnostics

	query := iw.CostExportQuery{Version: costExportQueryVersion}
	if !model.Query.IsNull() && !model.Query.IsUnknown() {
		var q costExportQueryModel
		diags.Append(model.Query.As(ctx, &q, basetypes.ObjectAsOptions{
			UnhandledNullAsEmpty:    true,
			UnhandledUnknownAsEmpty: true,
		})...)
		if diags.HasError() {
			return iw.CostExportInput{}, diags
		}

		dimensions, d := stringSlice(ctx, q.Dimensions)
		diags.Append(d...)
		tagKeys, d := stringSlice(ctx, q.TagKeys)
		diags.Append(d...)
		chargeTypes, d := stringSlice(ctx, q.ChargeTypes)
		diags.Append(d...)
		filters, d := costFiltersFrom(ctx, q.Filter)
		diags.Append(d...)
		if diags.HasError() {
			return iw.CostExportInput{}, diags
		}

		query.Dimensions = dimensions
		query.TagKeys = tagKeys
		query.ChargeTypes = chargeTypes
		query.Filters = filters
		query.CostBasis = stringPtr(q.CostBasis)
	}

	destination := iw.CostExportDestination{}
	if !model.Destination.IsNull() && !model.Destination.IsUnknown() {
		var dest costExportDestinationModel
		diags.Append(model.Destination.As(ctx, &dest, basetypes.ObjectAsOptions{
			UnhandledNullAsEmpty:    true,
			UnhandledUnknownAsEmpty: true,
		})...)
		if diags.HasError() {
			return iw.CostExportInput{}, diags
		}
		// Every branch's fields are carried here, but CostExportDestination's
		// MarshalJSON emits only the ones belonging to Kind: the server's schema
		// is a strict discriminated union and a stray key from the other branch is
		// a 400, not a field it ignores. The http branch's URL is not part of this
		// struct at all — it is secret material and travels as a top-level
		// write-only credential below.
		destination = iw.CostExportDestination{
			Kind:           dest.Kind.ValueString(),
			Bucket:         stringPtr(dest.Bucket),
			Prefix:         stringPtr(dest.Prefix),
			Region:         stringPtr(dest.Region),
			Endpoint:       stringPtr(dest.Endpoint),
			ForcePathStyle: boolPtr(dest.ForcePathStyle),
			Method:         stringPtr(dest.Method),
		}
	}

	return iw.CostExportInput{
		Name:            model.Name.ValueString(),
		Format:          model.Format.ValueString(),
		Query:           query,
		Cadence:         model.Cadence.ValueString(),
		Hour:            model.Hour.ValueInt64(),
		Timezone:        model.Timezone.ValueString(),
		RestatementDays: model.RestatementDays.ValueInt64(),
		Enabled:         model.Enabled.ValueBool(),
		Destination:     destination,

		// The three write-only credentials. stringPtr yields nil for a null or
		// unknown attribute, and the corresponding wire fields are omitempty
		// pointers, so an omitted credential is an omitted JSON key — which the
		// server reads as "keep the stored one". That is exactly the semantics we
		// want and it needs no special casing: a practitioner who supplies the
		// secret through a variable in CI and leaves it out locally does not blank
		// the export by running a local apply.
		AccessKeyID:     stringPtr(model.AccessKeyID),
		SecretAccessKey: stringPtr(model.SecretAccessKey),
		URL:             stringPtr(model.URL),
	}, diags
}

// costExportStateFrom maps a server export into Terraform state.
//
// `prior` is the plan (on write) or the previous state (on refresh), and here it
// is load bearing rather than a fallback for the odd nullable field: it is the
// only source for the three write-only credentials. No route returns
// `accessKeyId`, `secretAccessKey` or `url`, so there is literally no field on
// `remote` to read them from and nothing to compare against. They are carried
// through from `prior` unchanged, which keeps what the practitioner wrote in
// state and makes the resource consistent after apply. The unavoidable cost is
// that a credential rotated outside Terraform is invisible: the provider will
// never plan a change for it. `has_credentials` and `credential_hint` do come
// from the server and are the only signal that anything is stored.
//
// Operational fields on the response — lastRunAt, lastStatus, lastError,
// lastObjectCount, lastRowCount, nextRunAt — are read and discarded. They change
// on every refresh and belong in the UI, not in a plan diff, the same way budget
// spend status is left off `infrawrench_budget`.
func costExportStateFrom(ctx context.Context, remote *iw.CostExport, prior costExportResourceModel) (costExportResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	dimensions, d := stringList(ctx, remote.Query.Dimensions)
	diags.Append(d...)
	// tag_keys and charge_types are Optional and the server answers an unset one
	// as an empty array; mapping empty back to null is what keeps a config that
	// never mentioned them from showing perpetual drift.
	tagKeys, d := optionalStringList(ctx, remote.Query.TagKeys)
	diags.Append(d...)
	chargeTypes, d := optionalStringList(ctx, remote.Query.ChargeTypes)
	diags.Append(d...)
	filters, d := costFiltersTo(ctx, remote.Query.Filters)
	diags.Append(d...)
	if diags.HasError() {
		return costExportResourceModel{}, diags
	}

	query, d := types.ObjectValueFrom(ctx, costExportQueryAttrTypes, costExportQueryModel{
		Dimensions:  dimensions,
		TagKeys:     tagKeys,
		ChargeTypes: chargeTypes,
		CostBasis:   stringValue(remote.Query.CostBasis),
		Filter:      filters,
	})
	diags.Append(d...)

	destination, d := types.ObjectValueFrom(ctx, costExportDestinationAttrTypes, costExportDestinationModel{
		Kind:           types.StringValue(remote.Destination.Kind),
		Bucket:         stringValue(remote.Destination.Bucket),
		Prefix:         stringValue(remote.Destination.Prefix),
		Region:         stringValue(remote.Destination.Region),
		Endpoint:       stringValue(remote.Destination.Endpoint),
		ForcePathStyle: boolValue(remote.Destination.ForcePathStyle),
		Method:         stringValue(remote.Destination.Method),
		URLHint:        stringValue(remote.Destination.URLHint),
	})
	diags.Append(d...)

	return costExportResourceModel{
		ID:              types.StringValue(remote.ID),
		Name:            types.StringValue(remote.Name),
		Format:          types.StringValue(remote.Format),
		Cadence:         types.StringValue(remote.Cadence),
		Hour:            types.Int64Value(remote.Hour),
		Timezone:        types.StringValue(remote.Timezone),
		RestatementDays: types.Int64Value(remote.RestatementDays),
		Enabled:         types.BoolValue(remote.Enabled),

		// Carried through, never read from the response — see the doc comment.
		AccessKeyID:     prior.AccessKeyID,
		SecretAccessKey: prior.SecretAccessKey,
		URL:             prior.URL,

		HasCredentials: types.BoolValue(remote.HasCredentials),
		CredentialHint: stringValue(remote.CredentialHint),

		Query:       query,
		Destination: destination,
	}, diags
}
