//go:build wasip1

// Added to k8s.io/kubectl's vendored pkg/util by builtins/kubectl/build.sh:
// WASIX keeps no umask a program can read back (syscall.Umask is a stub
// there), so the mask reads as unset, as on Windows.

package util

import "errors"

func Umask(mask int) (old int, err error) {
	return 0, errors.New("umask is not supported on wasip1")
}
