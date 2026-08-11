package provider

import (
	"strings"

	"github.com/hashicorp/terraform-plugin-framework-validators/float64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
)

// Type aliases so a schema file can spell `[]validatorInt64{between(…)}`
// without importing the framework's validator package. Forty-odd resource files
// each carrying that import for one literal is noise, and the aliases keep the
// types identical.
type (
	validatorString  = validator.String
	validatorInt64   = validator.Int64
	validatorFloat64 = validator.Float64
	validatorList    = validator.List
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

// between bounds an integer attribute to the range the API documents.
//
// The rule is the same one oneOfValidator follows, and it applies to every
// numeric attribute whose description states a range: an out-of-range value is
// knowable at plan time, so making somebody discover it from an HTTP 400
// halfway through an apply is a choice, not a constraint.
//
// Two shapes of server behaviour end up here, and the second is the one worth
// noticing:
//
//   - Most of these routes *reject* an out-of-range value. Validating converts a
//     failed apply into a plan error.
//   - The probe's timings are *clamped* instead — 90 seconds becomes 60 and the
//     write succeeds. That is worse than a rejection, because the configuration
//     and the stored object now disagree forever and every subsequent plan shows
//     a diff that applying cannot fix. Validating is the only way to surface it.
func between(minimum, maximum int64) validator.Int64 {
	return int64validator.Between(minimum, maximum)
}

// atLeast bounds an integer attribute from below only, for the handful of
// fields the API floors without capping.
func atLeast(minimum int64) validator.Int64 {
	return int64validator.AtLeast(minimum)
}

// betweenFloat is `between` for a float attribute.
func betweenFloat(minimum, maximum float64) validator.Float64 {
	return float64validator.Between(minimum, maximum)
}

// elementsBetween bounds every element of an integer list — the weekday lists,
// and the efficiency alert's notice horizons. An out-of-range element is as
// rejectable as an out-of-range scalar and just as knowable in advance.
func elementsBetween(minimum, maximum int64) validator.List {
	return listvalidator.ValueInt64sAre(int64validator.Between(minimum, maximum))
}

// sizeBetween bounds how many elements a list may hold, where the API caps it.
// Applies to nested blocks as well as list attributes — both are validator.List.
func sizeBetween(minimum, maximum int) validator.List {
	return listvalidator.SizeBetween(minimum, maximum)
}

// sizeAtMost caps a list's length where the API states a maximum but no
// minimum, which is most of them: an empty list is usually meaningful.
func sizeAtMost(maximum int) validator.List {
	return listvalidator.SizeAtMost(maximum)
}

// elementsLengthBetween bounds the length of every string in a list, for the
// places the API states a per-element limit.
func elementsLengthBetween(minimum, maximum int) validator.List {
	return listvalidator.ValueStringsAre(stringvalidator.LengthBetween(minimum, maximum))
}

// joinBackticked renders an enum for a Markdown description.
func joinBackticked(values []string) string {
	return strings.Join(values, "`, `")
}
