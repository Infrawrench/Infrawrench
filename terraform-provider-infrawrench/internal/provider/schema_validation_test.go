package provider

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
)

// TestGetProviderSchemaIsValid runs every schema through the framework's own
// validation, which is strictly deeper than calling Schema() and checking the
// diagnostics.
//
// Schema() only builds the struct. It is GetProviderSchema that walks it and
// enforces the rules a provider author gets wrong: an attribute that is neither
// Required, Optional nor Computed; a Computed attribute nested somewhere it
// cannot be resolved; a Default on an attribute that is not Computed; a
// duplicate type name. Every one of those compiles cleanly and fails only when
// Terraform first talks to the provider — which, without this test, means it
// fails for a user rather than in CI.
//
// It needs no Terraform binary and no credentials, so unlike the acceptance
// tests it runs on every `go test`.
func TestGetProviderSchemaIsValid(t *testing.T) {
	ctx := context.Background()

	server, err := providerserver.NewProtocol6WithError(New("test")())()
	if err != nil {
		t.Fatalf("constructing the provider server: %v", err)
	}

	resp, err := server.GetProviderSchema(ctx, &tfprotov6.GetProviderSchemaRequest{})
	if err != nil {
		t.Fatalf("GetProviderSchema: %v", err)
	}

	for _, d := range resp.Diagnostics {
		if d.Severity == tfprotov6.DiagnosticSeverityError {
			t.Errorf("schema error: %s — %s", d.Summary, d.Detail)
		}
	}

	if resp.Provider == nil {
		t.Fatal("the provider schema is missing")
	}
	// Counts, not just names: a resource added to the registry and forgotten in
	// the README's table, the docs page and this number is the failure mode this
	// guards. Bump all four together.
	if len(resp.ResourceSchemas) != wantResources {
		t.Errorf("expected %d resource schemas, got %d", wantResources, len(resp.ResourceSchemas))
	}
	if len(resp.DataSourceSchemas) != wantDataSources {
		t.Errorf("expected %d data source schemas, got %d", wantDataSources, len(resp.DataSourceSchemas))
	}

	for name := range resp.ResourceSchemas {
		if !strings.HasPrefix(name, "infrawrench_") {
			t.Errorf("resource %q is not namespaced to the provider", name)
		}
	}
	for name := range resp.DataSourceSchemas {
		if !strings.HasPrefix(name, "infrawrench_") {
			t.Errorf("data source %q is not namespaced to the provider", name)
		}
	}
}

// TestEveryResourceCanBeImported guards the property that made this provider
// worth writing at all: somebody adopting it already has budgets, cost centres
// and reports, and a resource without ImportState is a resource they would have
// to delete and recreate to bring under management.
func TestEveryResourceCanBeImported(t *testing.T) {
	ctx := context.Background()

	constructors := New("test")().Resources(ctx)
	if len(constructors) == 0 {
		t.Fatal("the provider registered no resources")
	}

	for _, constructor := range constructors {
		res := constructor()
		if _, ok := res.(resource.ResourceWithImportState); !ok {
			t.Errorf("%T does not implement ImportState; every resource in this provider must be importable", res)
		}
		if _, ok := res.(resource.ResourceWithConfigure); !ok {
			t.Errorf("%T does not implement Configure, so it can never reach the API client", res)
		}
	}
}

// TestDocumentedRangesAreValidated is the check that would have caught the gap
// a reviewer found: `initial_lookback_days` said "1–30" in its description and
// enforced nothing, so an out-of-range value reached apply and came back as an
// HTTP 400 from the server rather than as a plan-time attribute error.
//
// The description is the contract a practitioner reads. A schema that states a
// bound and does not enforce it is worse than one that states nothing: it reads
// as a promise the provider has no intention of keeping, and the failure lands
// halfway through an apply that may already have created other resources.
//
// So this asserts the invariant rather than the individual fix — any numeric
// attribute whose description spells a range must carry a validator. It scans
// the served gRPC schema, which is what Terraform actually sees.
func TestDocumentedRangesAreValidated(t *testing.T) {
	ctx := context.Background()
	p := New("test")()

	// "5–1440", "0–23", "1–100000" — an en dash or a hyphen between two
	// numbers, which is how every bounded attribute in this provider is
	// written. Deliberately narrow: prose like "at most one every six hours"
	// is not a bound on the attribute's value.
	documentsRange := regexp.MustCompile(`\b\d[\d,]*\s*[–-]\s*\d[\d,]*\b`)

	var offenders []string

	var walk func(typeName string, attrs map[string]schema.Attribute, blocks map[string]schema.Block)
	walk = func(typeName string, attrs map[string]schema.Attribute, blocks map[string]schema.Block) {
		for name, attr := range attrs {
			description := attr.GetMarkdownDescription()
			if !documentsRange.MatchString(description) {
				continue
			}
			var validated bool
			switch a := attr.(type) {
			case schema.Int64Attribute:
				validated = len(a.Validators) > 0
			case schema.Float64Attribute:
				validated = len(a.Validators) > 0
			case schema.ListAttribute:
				validated = len(a.Validators) > 0
			case schema.StringAttribute:
				validated = len(a.Validators) > 0
			default:
				// Bools, maps and sets carry no ranges worth bounding; a number
				// in their description is prose.
				continue
			}
			if !validated {
				offenders = append(offenders, typeName+"."+name)
			}
		}
		for name, block := range blocks {
			nested, ok := block.(schema.ListNestedBlock)
			if !ok {
				continue
			}
			walk(typeName+"."+name, nested.NestedObject.Attributes, nested.NestedObject.Blocks)
		}
	}

	for _, constructor := range p.Resources(ctx) {
		r := constructor()

		metaResp := &resource.MetadataResponse{}
		r.Metadata(ctx, resource.MetadataRequest{ProviderTypeName: "infrawrench"}, metaResp)

		schemaResp := &resource.SchemaResponse{}
		r.Schema(ctx, resource.SchemaRequest{}, schemaResp)
		if schemaResp.Diagnostics.HasError() {
			continue
		}
		walk(metaResp.TypeName, schemaResp.Schema.Attributes, schemaResp.Schema.Blocks)
	}

	sort.Strings(offenders)
	if len(offenders) > 0 {
		t.Errorf("these attributes document a range and do not enforce it:\n  %s\n\n"+
			"Add a validator from validators.go — between, betweenFloat, elementsBetween, "+
			"sizeBetween, sizeAtMost — or reword the description if the bound is not real. "+
			"An unenforced bound fails at apply, as an HTTP 400, after other resources "+
			"in the graph have already been created.",
			strings.Join(offenders, "\n  "))
	}
}
