// WASIX has no flock(), and Go's wasip1 syscall package none either. A
// lock that always succeeds, as on a file system without locks: two gh
// processes refreshing the same configuration at once in one job could
// race, where on Linux the second would wait. builtins/gh/build.sh copies
// this into internal/flock.

package flock

import "os"

// TryLock opens path for reading and writing and "locks" it: it never
// returns ErrLocked here.
func TryLock(path string) (f *os.File, unlock func(), err error) {
	f, err = os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, nil, err
	}
	return f, func() { _ = f.Close() }, nil
}
