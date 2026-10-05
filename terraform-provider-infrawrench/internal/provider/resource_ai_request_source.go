package provider

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework-validators/mapvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/mapdefault"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Infrawrench/terraform-provider-infrawrench/internal/iw"
)

var (
	_ resource.Resource                   = (*aiRequestSourceResource)(nil)
	_ resource.ResourceWithConfigure      = (*aiRequestSourceResource)(nil)
	_ resource.ResourceWithImportState    = (*aiRequestSourceResource)(nil)
	_ resource.ResourceWithValidateConfig = (*aiRequestSourceResource)(nil)
)

// NewAIRequestSourceResource constructs the infrawrench_ai_request_source resource.
func NewAIRequestSourceResource() resource.Resource { return &aiRequestSourceResource{} }

type aiRequestSourceResource struct{ client *iw.Client }

const (
	aiSourceKindPlugin  = "plugin"
	aiSourceKindLiteLLM = "litellm"
	// aiLiteLLMSourceKindID is the only source_kind_id a LiteLLM source accepts.
	aiLiteLLMSourceKindID = "litellm-spend-logs"
)

type aiRequestSourceResourceModel struct {
	ID           types.String `tfsdk:"id"`
	Name         types.String `tfsdk:"name"`
	Kind         types.String `tfsdk:"kind"`
	AccountID    types.String `tfsdk:"account_id"`
	SourceKindID types.String `tfsdk:"source_kind_id"`
	Location     types.Map    `tfsdk:"location"`
	Enabled      types.Bool   `tfsdk:"enabled"`
	LookbackDays types.Int64  `tfsdk:"lookback_days"`
	BaseURL      types.String `tfsdk:"base_url"`
	APIKey       types.String `tfsdk:"api_key"`

	PluginID         types.String `tfsdk:"plugin_id"`
	AccountName      types.String `tfsdk:"account_name"`
	HasAPIKey        types.Bool   `tfsdk:"has_api_key"`
	CollectedThrough types.String `tfsdk:"collected_through"`
	LastRunAt        types.String `tfsdk:"last_run_at"`
	NextRunAt        types.String `tfsdk:"next_run_at"`
	LastError        types.String `tfsdk:"last_error"`
	LastErrorHelpURL types.String `tfsdk:"last_error_help_url"`
	FailureCount     types.Int64  `tfsdk:"failure_count"`
}

func (r *aiRequestSourceResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_ai_request_source"
}

func (r *aiRequestSourceResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A request-log source for [AI attribution](https://infrawrench.com/docs/features/ai-attribution), " +
			"which splits billed AI spend by caller. Each closed UTC day the source's per-request logs are read " +
			"once and folded into daily token totals per provider, model and mapped metadata key; raw requests " +
			"are never stored.\n\n" +
			"Two kinds exist. A `plugin` source is read through a connected account's provider plugin: Bedrock " +
			"invocation logs in S3 (`bedrock-s3`) or CloudWatch Logs (`bedrock-cloudwatch`), custom JSONL request " +
			"logs in S3 (`jsonl-s3`), all through an AWS account, or a Cloudflare AI Gateway's request log " +
			"(`ai-gateway`) through a Cloudflare account. A `litellm` source reads `/spend/logs/v2` on a LiteLLM " +
			"proxy you run, with `source_kind_id = \"litellm-spend-logs\"`.\n\n" +
			"An organization can have at most 25 sources. Collection state (`collected_through`, `last_error` " +
			"and the rest of the computed attributes) changes on its own every day and never produces a diff.",
		Attributes: map[string]schema.Attribute{
			"id": computedIDAttribute("Server-assigned source id. Use it with `terraform import`; an imported " +
				"LiteLLM source has no `api_key` in state, since no route returns it."),
			"name": schema.StringAttribute{
				Required:            true,
				MarkdownDescription: "Display name, 1-120 characters.",
				Validators:          []validatorString{stringvalidator.LengthBetween(1, 120)},
			},
			"kind": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Who reads the source: `plugin` for a connected account's provider plugin, " +
					"`litellm` for a LiteLLM proxy.",
				Validators: []validatorString{oneOfValidator(aiSourceKindPlugin, aiSourceKindLiteLLM)},
			},
			"account_id": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "Connected account whose plugin reads the source, e.g. " +
					"`infrawrench_account.aws.id` or an id from the `infrawrench_accounts` data source. " +
					"**Required** for `plugin` sources and must be unset for `litellm`.",
			},
			"source_kind_id": schema.StringAttribute{
				Required: true,
				MarkdownDescription: "Which of the account's request-log kinds to read: `bedrock-s3`, " +
					"`bedrock-cloudwatch` or `jsonl-s3` on an AWS account, `ai-gateway` on a Cloudflare account, " +
					"or `litellm-spend-logs` for a `litellm` source. A CloudWatch source runs a Logs Insights query " +
					"each day, billed to the AWS account per GB scanned.",
			},
			"location": schema.MapAttribute{
				Optional:    true,
				Computed:    true,
				ElementType: types.StringType,
				Default:     mapdefault.StaticValue(types.MapValueMust(types.StringType, map[string]attr.Value{})),
				MarkdownDescription: "Where the logs live, as the source's location picker in **Settings → AI " +
					"Attribution** returns it (the bucket, log group or gateway the plugin discovered), plus " +
					"`prefix` for kinds that accept one (`jsonl-s3`). Opaque to Infrawrench and passed to the " +
					"plugin as is: `bucket`, `prefix` and `region` for the S3 kinds, `logGroupName` and `region` " +
					"for `bedrock-cloudwatch`, `gatewayId` for `ai-gateway`. At most 16 keys. Leave it unset for " +
					"`litellm` sources, which have no location.",
				Validators: []validator.Map{mapvalidator.SizeAtMost(16)},
			},
			"enabled": schema.BoolAttribute{
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(true),
				MarkdownDescription: "A disabled source keeps its settings and stops collecting. Defaults to `true`.",
			},
			"lookback_days": schema.Int64Attribute{
				Optional: true,
				Computed: true,
				Default:  int64default.StaticInt64(7),
				MarkdownDescription: "How many days back the first collection reaches, 1-90. Defaults to `7`.\n\n" +
					"The server clamps the value to the source kind's own history cap: 90 days for " +
					"`bedrock-s3`, `jsonl-s3` and `litellm-spend-logs`, 30 for `bedrock-cloudwatch` and " +
					"`ai-gateway`. When the server has clamped it, the provider keeps the configured value in " +
					"state rather than reporting a diff that no apply could resolve, and warns at apply time.",
				Validators: []validatorInt64{between(1, 90)},
			},
			"base_url": schema.StringAttribute{
				Optional: true,
				MarkdownDescription: "`litellm` only, and required there: the proxy's public https URL, e.g. " +
					"`https://litellm.example.com`. Private and reserved addresses are refused.",
			},
			"api_key": schema.StringAttribute{
				Optional:  true,
				Sensitive: true,
				MarkdownDescription: "`litellm` only: an admin (master) key for the proxy. **Required when the " +
					"source is created**; omit it afterwards to keep the stored key.\n\n" +
					"Write-only: no route returns it, so the provider cannot detect drift on its value. " +
					"`has_api_key` says whether one is stored.",
			},

			"plugin_id": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Plugin that reads the source, derived from `account_id`; null for `litellm`.",
			},
			"account_name": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Display name of the account in `account_id`; null for `litellm`.",
			},
			"has_api_key": schema.BoolAttribute{
				Computed:            true,
				MarkdownDescription: "Whether a LiteLLM API key is stored. The key itself is never returned.",
			},
			"collected_through": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Last UTC day (`YYYY-MM-DD`) fully collected, or null before the first run.",
			},
			"last_run_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "When the source was last collected (RFC 3339), or null.",
			},
			"next_run_at": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "When the next collection is due (RFC 3339), or null.",
			},
			"last_error": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Why the last collection failed, or null when it succeeded.",
			},
			"last_error_help_url": schema.StringAttribute{
				Computed:            true,
				MarkdownDescription: "Documentation for fixing `last_error`, when the plugin supplies one.",
			},
			"failure_count": schema.Int64Attribute{
				Computed:            true,
				MarkdownDescription: "Consecutive failed collections; reset by a successful one.",
			},
		},
	}
}

func (r *aiRequestSourceResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFromResourceConfigure(req, resp)
}

// ValidateConfig enforces the per-kind shape the schema cannot express.
//
// Each rule is a guaranteed 400, or worse, a silent drop: the server stores a
// LiteLLM source's location as `{}` and a plugin source's base URL as null
// whatever was sent, which Terraform would report as an inconsistent result
// after apply. Unknown values pass, since they may come from another resource.
func (r *aiRequestSourceResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var config aiRequestSourceResourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &config)...)
	if resp.Diagnostics.HasError() || config.Kind.IsNull() || config.Kind.IsUnknown() {
		return
	}

	mustBeUnset := func(attribute string, v attr.Value, kind string) {
		if !v.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root(attribute), "Attribute not allowed for this kind",
				fmt.Sprintf("`%s` applies only to `litellm` sources; remove it from this `%s` source.", attribute, kind))
		}
	}

	switch config.Kind.ValueString() {
	case aiSourceKindPlugin:
		if config.AccountID.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root("account_id"), "Missing account",
				"A `plugin` source is read through a connected account; set `account_id`.")
		}
		mustBeUnset("base_url", config.BaseURL, aiSourceKindPlugin)
		mustBeUnset("api_key", config.APIKey, aiSourceKindPlugin)

	case aiSourceKindLiteLLM:
		if !config.AccountID.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root("account_id"), "Attribute not allowed for this kind",
				"A `litellm` source is read by Infrawrench itself, not through an account; remove `account_id`.")
		}
		if config.BaseURL.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root("base_url"), "Missing base URL",
				"A `litellm` source needs the proxy's https URL in `base_url`.")
		}
		if !config.SourceKindID.IsNull() && !config.SourceKindID.IsUnknown() &&
			config.SourceKindID.ValueString() != aiLiteLLMSourceKindID {
			resp.Diagnostics.AddAttributeError(path.Root("source_kind_id"), "Invalid source kind",
				fmt.Sprintf("A `litellm` source's `source_kind_id` must be %q.", aiLiteLLMSourceKindID))
		}
		if !config.Location.IsNull() && !config.Location.IsUnknown() && len(config.Location.Elements()) > 0 {
			resp.Diagnostics.AddAttributeError(path.Root("location"), "Attribute not allowed for this kind",
				"A `litellm` source has no location; the server discards it. Remove `location`.")
		}
	}
}

func (r *aiRequestSourceResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan aiRequestSourceResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := aiRequestSourceInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	created, err := r.client.CreateAIRequestSource(ctx, input)
	if err != nil {
		resp.Diagnostics.AddError("Unable to create AI request source", err.Error())
		return
	}

	// State is set even when mapping reported an error: the source exists, and
	// Terraform persists the state of a failed create (tainted) so the next
	// apply replaces it rather than creating a second one.
	state, diags := r.stateFrom(ctx, created, plan, true)
	resp.Diagnostics.Append(diags...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *aiRequestSourceResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state aiRequestSourceResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	remote, err := r.client.GetAIRequestSource(ctx, state.ID.ValueString())
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Unable to read AI request source", err.Error())
		return
	}

	refreshed, diags := r.stateFrom(ctx, remote, state, false)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &refreshed)...)
}

func (r *aiRequestSourceResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan aiRequestSourceResourceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var state aiRequestSourceResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	input, diags := aiRequestSourceInputFrom(ctx, plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	updated, err := r.client.UpdateAIRequestSource(ctx, state.ID.ValueString(), input)
	if err != nil {
		if iw.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			resp.Diagnostics.AddWarning(
				"AI request source no longer exists",
				"The source was deleted outside Terraform. It has been removed from state and will be recreated on the next apply.")
			return
		}
		resp.Diagnostics.AddError("Unable to update AI request source", err.Error())
		return
	}

	next, diags := r.stateFrom(ctx, updated, plan, true)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &next)...)
}

func (r *aiRequestSourceResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state aiRequestSourceResourceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteAIRequestSource(ctx, state.ID.ValueString()); err != nil {
		if iw.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Unable to delete AI request source", err.Error())
	}
}

func (r *aiRequestSourceResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

// stateFrom maps a server source into state, looking up the source kind's
// history cap only when the stored lookback is below the configured one.
//
// That is the single case where the cap matters: the server clamps
// lookbackDays to it, and answering a planned 90 with a stored 30 would fail
// Terraform's consistency check on apply and diff forever on refresh. The
// listing is fetched only then, so an ordinary read costs one request.
func (r *aiRequestSourceResource) stateFrom(ctx context.Context, remote *iw.AIRequestSource, prior aiRequestSourceResourceModel, applying bool) (aiRequestSourceResourceModel, diag.Diagnostics) {
	var diags diag.Diagnostics

	var historyCap int64
	if !prior.LookbackDays.IsNull() && !prior.LookbackDays.IsUnknown() && prior.LookbackDays.ValueInt64() > remote.LookbackDays {
		kinds, err := r.client.ListAIRequestSourceKinds(ctx)
		if err != nil {
			// The mapped state is still returned: on create the source exists,
			// and state must record it so the next apply does not duplicate it.
			diags.AddError("Unable to read AI request source kinds",
				"Needed to tell whether the server clamped lookback_days: "+err.Error())
		} else {
			historyCap = aiSourceHistoryCap(kinds, remote)
		}
		if applying && historyCap > 0 && historyCap == remote.LookbackDays {
			diags.AddAttributeWarning(path.Root("lookback_days"), "Lookback clamped",
				fmt.Sprintf("Source kind %q keeps at most %d days of history, so the server stored lookback_days = %d. "+
					"Set lookback_days to at most %d to make the configuration match.",
					remote.SourceKindID, historyCap, historyCap, historyCap))
		}
	}

	state, mapDiags := aiRequestSourceStateFrom(ctx, remote, prior, historyCap)
	diags.Append(mapDiags...)
	return state, diags
}

/* -------------------------------- mapping --------------------------------- */

// aiRequestSourceInputFrom maps configuration onto the POST/PUT body. A null
// api_key is omitted, which on a PUT keeps the stored key.
func aiRequestSourceInputFrom(ctx context.Context, model aiRequestSourceResourceModel) (iw.AIRequestSourceInput, diag.Diagnostics) {
	location, diags := stringMap(ctx, model.Location)
	return iw.AIRequestSourceInput{
		Name:         model.Name.ValueString(),
		Kind:         model.Kind.ValueString(),
		AccountID:    stringPtr(model.AccountID),
		SourceKindID: model.SourceKindID.ValueString(),
		Location:     location,
		Enabled:      model.Enabled.ValueBool(),
		LookbackDays: model.LookbackDays.ValueInt64(),
		BaseURL:      stringPtr(model.BaseURL),
		APIKey:       stringPtr(model.APIKey),
	}, diags
}

// aiSourceHistoryCap finds the history cap of a source's kind, or 0 when the
// listing no longer offers it (an account deleted since, a plugin dropped).
func aiSourceHistoryCap(kinds []iw.AIRequestSourceKindOption, remote *iw.AIRequestSource) int64 {
	for _, k := range kinds {
		if k.Kind != remote.Kind || k.SourceKindID != remote.SourceKindID {
			continue
		}
		if remote.Kind == aiSourceKindPlugin && (k.PluginID == nil || remote.PluginID == nil || *k.PluginID != *remote.PluginID) {
			continue
		}
		return k.MaxHistoryDays
	}
	return 0
}

// aiRequestSourceStateFrom maps a server source into state.
//
// Three attributes cannot be read back verbatim:
//
//   - api_key is write-only and carried forward from the prior model.
//   - lookback_days keeps the prior value when the server clamped it to the
//     kind's history cap (historyCap, 0 when unknown); the stored value is the
//     configured one as far as the server allows, so it is not drift.
//   - base_url keeps the prior spelling when the server's normalised form (no
//     trailing slash, lowercase host, no default port) is the same URL.
func aiRequestSourceStateFrom(ctx context.Context, remote *iw.AIRequestSource, prior aiRequestSourceResourceModel, historyCap int64) (aiRequestSourceResourceModel, diag.Diagnostics) {
	location := remote.Location
	if location == nil {
		location = map[string]string{}
	}
	locationValue, diags := types.MapValueFrom(ctx, types.StringType, location)

	lookback := types.Int64Value(remote.LookbackDays)
	if historyCap > 0 && remote.LookbackDays == historyCap &&
		!prior.LookbackDays.IsNull() && !prior.LookbackDays.IsUnknown() &&
		prior.LookbackDays.ValueInt64() > historyCap {
		lookback = prior.LookbackDays
	}

	baseURL := stringValue(remote.BaseURL)
	if remote.BaseURL != nil && !prior.BaseURL.IsNull() && !prior.BaseURL.IsUnknown() &&
		sameBaseURL(prior.BaseURL.ValueString(), *remote.BaseURL) {
		baseURL = prior.BaseURL
	}

	return aiRequestSourceResourceModel{
		ID:           types.StringValue(remote.ID),
		Name:         types.StringValue(remote.Name),
		Kind:         types.StringValue(remote.Kind),
		AccountID:    stringValue(remote.AccountID),
		SourceKindID: types.StringValue(remote.SourceKindID),
		Location:     locationValue,
		Enabled:      types.BoolValue(remote.Enabled),
		LookbackDays: lookback,
		BaseURL:      baseURL,
		APIKey:       prior.APIKey,

		PluginID:         stringValue(remote.PluginID),
		AccountName:      stringValue(remote.AccountName),
		HasAPIKey:        types.BoolValue(remote.HasAPIKey),
		CollectedThrough: stringValue(remote.CollectedThrough),
		LastRunAt:        stringValue(remote.LastRunAt),
		NextRunAt:        stringValue(remote.NextRunAt),
		LastError:        stringValue(remote.LastError),
		LastErrorHelpURL: stringValue(remote.LastErrorHelpURL),
		FailureCount:     types.Int64Value(remote.FailureCount),
	}, diags
}

// sameBaseURL reports whether two LiteLLM base URLs are the same once put in
// the form the server stores: origin plus path, with the trailing slash gone.
func sameBaseURL(a, b string) bool {
	return normaliseBaseURL(a) == normaliseBaseURL(b)
}

func normaliseBaseURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return strings.TrimRight(strings.TrimSpace(raw), "/")
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Host)
	if (scheme == "https" && strings.HasSuffix(host, ":443")) || (scheme == "http" && strings.HasSuffix(host, ":80")) {
		host = host[:strings.LastIndex(host, ":")]
	}
	return scheme + "://" + host + strings.TrimRight(u.EscapedPath(), "/")
}
