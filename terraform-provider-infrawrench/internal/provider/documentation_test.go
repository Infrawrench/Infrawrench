package provider

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/resource"
)

// The repository's convention is that adding a resource also means adding a row
// to the README's table and to the website's feature page, in the same change.
// A convention nothing checks is a convention that decays: the count assertions
// in provider_test.go catch a forgotten registry entry, but nothing caught a
// registered resource that never reached the documentation.
//
// These tests close that. They are string matching over Markdown rather than
// anything clever, which is the right amount of machinery for the job — the
// failure they prevent is "shipped a resource nobody can find", and the fix is
// always one line of prose.

var typeNamePattern = regexp.MustCompile("`(infrawrench_[a-z0-9_]+)`")

// registeredTypeNames is every type name the provider serves.
func registeredTypeNames(t *testing.T) []string {
	t.Helper()

	ctx := context.Background()
	p := New("test")()

	var names []string
	for _, constructor := range p.Resources(ctx) {
		resp := &resource.MetadataResponse{}
		constructor().Metadata(ctx, resource.MetadataRequest{ProviderTypeName: "infrawrench"}, resp)
		names = append(names, resp.TypeName)
	}
	for _, constructor := range p.DataSources(ctx) {
		resp := &datasource.MetadataResponse{}
		constructor().Metadata(ctx, datasource.MetadataRequest{ProviderTypeName: "infrawrench"}, resp)
		names = append(names, resp.TypeName)
	}
	sort.Strings(names)
	return names
}

// documentedTypeNames pulls every `infrawrench_…` mention out of a Markdown
// file. Deliberately loose: a name mentioned anywhere counts, because the point
// is to catch a resource nobody wrote about at all, not to police which table it
// landed in.
func documentedTypeNames(t *testing.T, path string) (map[string]bool, bool) {
	t.Helper()

	raw, err := os.ReadFile(path)
	if err != nil {
		// The provider is meant to be extractable into its own repository, at
		// which point the website is simply not there. Skipping keeps it
		// buildable standalone without pretending the check ran.
		return nil, false
	}

	found := map[string]bool{}
	for _, match := range typeNamePattern.FindAllStringSubmatch(string(raw), -1) {
		found[match[1]] = true
	}
	return found, true
}

func TestEveryTypeIsInTheReadme(t *testing.T) {
	path, err := filepath.Abs("../../README.md")
	if err != nil {
		t.Fatalf("resolving the README path: %v", err)
	}
	documented, ok := documentedTypeNames(t, path)
	if !ok {
		t.Fatalf("the provider README is missing at %s", path)
	}

	var undocumented []string
	for _, name := range registeredTypeNames(t) {
		if !documented[name] {
			undocumented = append(undocumented, name)
		}
	}
	if len(undocumented) > 0 {
		t.Errorf("these are registered but absent from README.md: %s\n"+
			"Add a row to the matching \"Resources and data sources\" table.",
			strings.Join(undocumented, ", "))
	}

	// The other direction catches a table row left behind by a removal, which
	// is worse than a missing one: it documents something that does not exist.
	registered := map[string]bool{}
	for _, name := range registeredTypeNames(t) {
		registered[name] = true
	}
	var stale []string
	for name := range documented {
		if !registered[name] {
			stale = append(stale, name)
		}
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		t.Errorf("README.md documents these, but the provider does not serve them: %s\n"+
			"Either register them or remove the rows.", strings.Join(stale, ", "))
	}
}

// The website page is the user-facing half of the same convention. It is checked
// one way only: it is prose rather than a reference, so it is allowed to omit a
// resource's *mention* nowhere — but a resource that appears in no table on it
// is one a reader cannot discover.
func TestEveryTypeIsOnTheWebsitePage(t *testing.T) {
	path, err := filepath.Abs("../../../app/packages/website/src/content/docs/features/terraform-provider.md")
	if err != nil {
		t.Fatalf("resolving the docs path: %v", err)
	}
	documented, ok := documentedTypeNames(t, path)
	if !ok {
		t.Skipf("the website docs are not available at %s; skipping", path)
	}

	var undocumented []string
	for _, name := range registeredTypeNames(t) {
		if !documented[name] {
			undocumented = append(undocumented, name)
		}
	}
	if len(undocumented) > 0 {
		t.Errorf("these are registered but absent from the website's terraform-provider.md: %s\n"+
			"Add them to the \"What's managed\" tables.", strings.Join(undocumented, ", "))
	}
}
