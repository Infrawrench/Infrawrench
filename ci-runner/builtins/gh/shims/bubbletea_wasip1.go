// Bubble Tea's terminal hooks for wasip1, which has no terminal, no
// signals and no job control: what tty_windows.go and signals_windows.go
// give a console that is not a terminal. gh only starts a Bubble Tea
// program on a terminal. builtins/gh/build.sh copies this into
// vendor/charm.land/bubbletea/v2.

package tea

func (p *Program) initInput() error {
	return nil
}

const suspendSupported = false

func suspendProcess() {}

func (p *Program) listenForResize(done chan struct{}) {
	close(done)
}
