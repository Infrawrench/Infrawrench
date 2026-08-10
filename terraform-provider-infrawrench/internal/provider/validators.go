package provider

import (
	"strings"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
)

// oneOfValidator is the enum check used throughout the schemas.
//
// The server's zod schemas are `strict()` with closed enums, so an invalid
// value is a guaranteed 400. Catching it at plan time turns a failed apply —
// which may already have created half the resources in a graph — into a plan
// error that costs nothing.
func oneOfValidator(allowed ...string) validator.String {
	return stringvalidator.OneOf(allowed...)
}

// joinBackticked renders an enum for a Markdown description.
func joinBackticked(values []string) string {
	return strings.Join(values, "`, `")
}
