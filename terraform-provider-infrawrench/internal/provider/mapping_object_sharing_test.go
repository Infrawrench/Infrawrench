package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// objectSharingSpecPath is the monorepo's OpenAPI document, relative to this package.
const objectSharingSpecPath = "../../../app/packages/web/openapi.json"

// TestObjectSharingTypesMatchSpec holds object_type's accepted values to the
// API's ShareableObjectType enum. A kind the server learns to share without the
// provider following (kubernetes_efficiency_report was one, #1306) would
// otherwise fail at a user's plan with a validator error for a value the API
// accepts.
func TestObjectSharingTypesMatchSpec(t *testing.T) {
	abs, err := filepath.Abs(objectSharingSpecPath)
	if err != nil {
		t.Fatalf("resolving spec path: %v", err)
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		// Same reasoning as the wire drift check: the provider stays buildable
		// once extracted from the monorepo.
		t.Skipf("OpenAPI document not available at %s (%v); skipping", abs, err)
	}
	var doc struct {
		Components struct {
			Schemas map[string]struct {
				Enum []any `json:"enum"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parsing %s: %v", abs, err)
	}
	var want []string
	for _, v := range doc.Components.Schemas["ShareableObjectType"].Enum {
		if s, ok := v.(string); ok {
			want = append(want, s)
		}
	}
	if len(want) == 0 {
		t.Fatal("openapi.json has no ShareableObjectType enum")
	}
	got := slices.Clone(objectSharingTypes)
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("object_type accepts %v, the API's ShareableObjectType is %v", got, want)
	}
}

func TestObjectSharingObjectTypeValidator(t *testing.T) {
	v := oneOfValidator(objectSharingTypes...)
	for value, ok := range map[string]bool{
		"kubernetes_efficiency_report": true,
		"cost_report":                  true,
		"savings_view":                 true,
		"commitment":                   false,
	} {
		resp := &validator.StringResponse{}
		v.ValidateString(context.Background(), validator.StringRequest{
			Path:        path.Root("object_type"),
			ConfigValue: types.StringValue(value),
		}, resp)
		if resp.Diagnostics.HasError() == ok {
			t.Errorf("object_type %q: accepted = %v, want %v (%v)", value, !resp.Diagnostics.HasError(), ok, resp.Diagnostics)
		}
	}
}
