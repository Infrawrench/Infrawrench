// A job has no clipboard: on wasip1, as on a Linux machine without xsel,
// xclip or wl-clipboard, reading or writing it fails with a reason.
// builtins/gh/build.sh copies this into vendor/github.com/atotto/clipboard.

package clipboard

import "errors"

var errNoClipboard = errors.New("no clipboard: a CI job has none")

func init() {
	Unsupported = true
}

func readAll() (string, error) {
	return "", errNoClipboard
}

func writeAll(string) error {
	return errNoClipboard
}
