package provider

import (
	"context"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-framework/resource"
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
