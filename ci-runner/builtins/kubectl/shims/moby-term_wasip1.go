//go:build wasip1

// A WASIX job has no terminal: every descriptor reads as a file or a pipe
// (ci-runner/README.md), so nothing here is one. Added to
// github.com/moby/term's vendored copy by builtins/kubectl/build.sh, whose
// other files assume termios through golang.org/x/sys/unix.

package term

import (
	"errors"
	"io"
	"os"
)

var errNoTerminal = errors.New("a WASIX job has no terminal")

// terminalState holds nothing: there is no terminal to save.
type terminalState struct{}

func stdStreams() (stdIn io.ReadCloser, stdOut, stdErr io.Writer) {
	return os.Stdin, os.Stdout, os.Stderr
}

func getFdInfo(in interface{}) (uintptr, bool) {
	if file, ok := in.(*os.File); ok {
		return file.Fd(), false
	}
	return 0, false
}

func getWinsize(fd uintptr) (*Winsize, error) { return &Winsize{}, errNoTerminal }

func setWinsize(fd uintptr, ws *Winsize) error { return errNoTerminal }

func isTerminal(fd uintptr) bool { return false }

func restoreTerminal(fd uintptr, state *State) error { return nil }

func saveState(fd uintptr) (*State, error) { return nil, errNoTerminal }

func disableEcho(fd uintptr, state *State) error { return errNoTerminal }

func setRawTerminal(fd uintptr) (*State, error) { return nil, errNoTerminal }

func setRawTerminalOutput(fd uintptr) (*State, error) { return nil, errNoTerminal }

func makeRaw(fd uintptr) (*State, error) { return nil, errNoTerminal }
