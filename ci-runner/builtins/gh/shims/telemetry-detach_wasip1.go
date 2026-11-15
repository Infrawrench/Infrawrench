// WASIX has no process groups, so a child cannot be put in one of its
// own; it gets what any child gets. The package sets GH_TELEMETRY to
// `disabled`, so gh starts no such child unless a job turns it back on.
// builtins/gh/build.sh copies this into internal/telemetry.

package telemetry

import "syscall"

func detachAttrs() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{}
}
