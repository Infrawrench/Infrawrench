package provider

import (
	"context"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/resource"
)

// wantResources and wantDataSources are the registry's expected size, asserted
// from two directions — the Go constructors here, and the served gRPC schema in
// schema_validation_test.go. They are deliberately hand-maintained: the number
// is the reminder that adding a resource also means adding a row to the
// README's table and to the docs page, neither of which any test can check.
const (
	wantResources   = 46
	wantDataSources = 6
)

// These are unit tests over the provider's wiring, not acceptance tests: nothing
// here talks to an Infrawrench installation. They exist because the framework
// checks most of this at gRPC serve time, where a mistake surfaces as a cryptic
// runtime failure in someone's `terraform plan` rather than as a build failure.
// Running the same checks under `go test` moves the whole class of error left.

func TestProviderSchema(t *testing.T) {
	resp := &provider.SchemaResponse{}
	New("test")().Schema(context.Background(), provider.SchemaRequest{}, resp)

	if resp.Diagnostics.HasError() {
		t.Fatalf("provider schema produced errors: %v", resp.Diagnostics)
	}

	for _, name := range []string{"base_url", "api_key", "organization_id"} {
		if _, ok := resp.Schema.Attributes[name]; !ok {
			t.Errorf("provider schema is missing the %q attribute", name)
		}
	}

	// The API key is a credential; losing the Sensitive flag would print it in
	// plan output and in the CLI's error messages.
	apiKey, ok := resp.Schema.Attributes["api_key"]
	if ok && !apiKey.IsSensitive() {
		t.Error("api_key must be marked Sensitive")
	}
}

func TestProviderMetadata(t *testing.T) {
	resp := &provider.MetadataResponse{}
	New("test")().Metadata(context.Background(), provider.MetadataRequest{}, resp)

	if resp.TypeName != "infrawrench" {
		t.Errorf("provider type name = %q, want %q", resp.TypeName, "infrawrench")
	}
}

func TestResourcesAndDataSourcesConstruct(t *testing.T) {
	ctx := context.Background()
	p := New("test")()

	resources := p.Resources(ctx)
	if len(resources) != wantResources {
		t.Errorf("provider exposes %d resources, want %d", len(resources), wantResources)
	}
	dataSources := p.DataSources(ctx)
	if len(dataSources) != wantDataSources {
		t.Errorf("provider exposes %d data sources, want %d", len(dataSources), wantDataSources)
	}

	// A duplicated TypeName is a real bug — the second registration silently
	// shadows the first, and the framework only notices when the plugin is
	// served. Collecting the names into a set catches a copy-pasted Metadata.
	seen := map[string]bool{}
	check := func(kind, typeName string) {
		if !strings.HasPrefix(typeName, "infrawrench_") {
			t.Errorf("%s type name %q is not prefixed with %q", kind, typeName, "infrawrench_")
		}
		if seen[typeName] {
			t.Errorf("%s type name %q is registered twice", kind, typeName)
		}
		seen[typeName] = true
	}

	for _, newResource := range resources {
		resp := &resource.MetadataResponse{}
		newResource().Metadata(ctx, resource.MetadataRequest{ProviderTypeName: "infrawrench"}, resp)
		check("resource", resp.TypeName)
	}
	for _, newDataSource := range dataSources {
		resp := &datasource.MetadataResponse{}
		newDataSource().Metadata(ctx, datasource.MetadataRequest{ProviderTypeName: "infrawrench"}, resp)
		check("data source", resp.TypeName)
	}
}

func TestSchemasAreValid(t *testing.T) {
	ctx := context.Background()
	p := New("test")()

	for _, newResource := range p.Resources(ctx) {
		r := newResource()

		metaResp := &resource.MetadataResponse{}
		r.Metadata(ctx, resource.MetadataRequest{ProviderTypeName: "infrawrench"}, metaResp)

		schemaResp := &resource.SchemaResponse{}
		r.Schema(ctx, resource.SchemaRequest{}, schemaResp)
		if schemaResp.Diagnostics.HasError() {
			t.Errorf("%s schema produced errors: %v", metaResp.TypeName, schemaResp.Diagnostics)
			continue
		}
		// Every object this provider manages is addressable by id, and
		// `terraform import` has nothing to write without one.
		if _, ok := schemaResp.Schema.Attributes["id"]; !ok {
			t.Errorf("%s schema has no id attribute", metaResp.TypeName)
		}
	}

	for _, newDataSource := range p.DataSources(ctx) {
		d := newDataSource()

		metaResp := &datasource.MetadataResponse{}
		d.Metadata(ctx, datasource.MetadataRequest{ProviderTypeName: "infrawrench"}, metaResp)

		schemaResp := &datasource.SchemaResponse{}
		d.Schema(ctx, datasource.SchemaRequest{}, schemaResp)
		if schemaResp.Diagnostics.HasError() {
			t.Errorf("%s schema produced errors: %v", metaResp.TypeName, schemaResp.Diagnostics)
			continue
		}
		if _, ok := schemaResp.Schema.Attributes["id"]; !ok {
			t.Errorf("%s schema has no id attribute", metaResp.TypeName)
		}
	}
}
