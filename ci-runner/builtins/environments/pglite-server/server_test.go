package main

import (
	"bufio"
	"encoding/binary"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeBackend answers like a single PostgreSQL session, enough for the
// scheduler: BEGIN/COMMIT/ROLLBACK move its transaction status, and every
// message it gets is logged, with the statement and portal names it saw.
type fakeBackend struct {
	mu  sync.Mutex
	log []string
}

func (f *fakeBackend) record(s string) {
	f.mu.Lock()
	f.log = append(f.log, s)
	f.mu.Unlock()
}

func (f *fakeBackend) entries() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.log...)
}

func (f *fakeBackend) serve(t *testing.T, conn net.Conn) {
	r := bufio.NewReader(conn)
	w := bufio.NewWriter(conn)
	if _, _, err := readStartup(r); err != nil {
		t.Errorf("backend startup: %v", err)
		return
	}
	writeMessage(w, message{'R', []byte{0, 0, 0, 0}})
	writeMessage(w, message{'S', appendCString(appendCString(nil, "server_version"), "18.4")})
	writeMessage(w, readyForQuery('I'))
	w.Flush()
	status := byte('I')
	run := func(text string) {
		switch strings.ToUpper(strings.TrimSpace(text)) {
		case "BEGIN":
			status = 'T'
		case "COMMIT", "ROLLBACK":
			status = 'I'
		}
		writeMessage(w, message{'C', appendCString(nil, "OK")})
	}
	for {
		m, err := readMessage(r)
		if err != nil {
			return
		}
		switch m.typ {
		case 'Q':
			text, _, _ := cstring(m.body, 0)
			f.record("Q " + text)
			run(text)
			writeMessage(w, readyForQuery(status))
			w.Flush()
		case 'P':
			name, off, _ := cstring(m.body, 0)
			text, _, _ := cstring(m.body, off)
			f.record("P " + name + " " + text)
			writeMessage(w, message{'1', nil})
		case 'B':
			portal, off, _ := cstring(m.body, 0)
			stmt, _, _ := cstring(m.body, off)
			f.record("B " + portal + " " + stmt)
			writeMessage(w, message{'2', nil})
		case 'E':
			f.record("E")
			run("")
		case 'C':
			name, _, _ := cstring(m.body, 1)
			f.record("C " + string(m.body[0]) + " " + name)
			writeMessage(w, message{'3', nil})
		case 'S':
			f.record("S")
			writeMessage(w, readyForQuery(status))
			w.Flush()
		}
	}
}

// start runs a server over a fake backend and returns its address.
func start(t *testing.T, wait time.Duration) (*fakeBackend, string) {
	t.Helper()
	f := &fakeBackend{}
	backendLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		conn, err := backendLn.Accept()
		if err == nil {
			f.serve(t, conn)
		}
	}()
	s := newServer(dial(backendLn.Addr().String()), wait)
	if err := s.startup("postgres", "postgres", ""); err != nil {
		t.Fatal(err)
	}
	go s.relay()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go s.serve(ln)
	t.Cleanup(func() { ln.Close(); backendLn.Close() })
	return f, ln.Addr().String()
}

type testClient struct {
	t    *testing.T
	conn net.Conn
	r    *bufio.Reader
}

func connect(t *testing.T, addr string) *testClient {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	c := &testClient{t, conn, bufio.NewReader(conn)}
	conn.Write(startupPacket([][2]string{{"user", "app"}, {"database", "app"}}))
	c.until('Z')
	return c
}

func (c *testClient) write(ms ...message) {
	w := bufio.NewWriter(c.conn)
	for _, m := range ms {
		writeMessage(w, m)
	}
	if err := w.Flush(); err != nil {
		c.t.Fatal(err)
	}
}

// until reads up to a message of the type, returning the messages read.
func (c *testClient) until(typ byte) []message {
	c.t.Helper()
	c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var got []message
	for {
		m, err := readMessage(c.r)
		if err != nil {
			c.t.Fatalf("reading: %v (after %d messages)", err, len(got))
		}
		got = append(got, m)
		if m.typ == typ {
			return got
		}
	}
}

func (c *testClient) query(text string) []message {
	c.write(query(text))
	return c.until('Z')
}

func waitFor(t *testing.T, f *fakeBackend, entry string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range f.entries() {
			if e == entry {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the backend never got %q; it got %q", entry, f.entries())
}

func indexOf(t *testing.T, log []string, entry string) int {
	t.Helper()
	for i, e := range log {
		if e == entry {
			return i
		}
	}
	t.Fatalf("no %q in %q", entry, log)
	return -1
}

func TestATransactionRunsWhole(t *testing.T) {
	f, addr := start(t, 5*time.Second)
	a, b := connect(t, addr), connect(t, addr)
	a.query("BEGIN")
	a.query("select 'a1'")
	done := make(chan struct{})
	go func() {
		b.query("select 'b'")
		close(done)
	}()
	time.Sleep(50 * time.Millisecond)
	select {
	case <-done:
		t.Fatal("b ran inside a's transaction")
	default:
	}
	a.query("select 'a2'")
	a.query("COMMIT")
	<-done
	log := f.entries()
	if indexOf(t, log, "Q select 'b'") < indexOf(t, log, "Q COMMIT") {
		t.Fatalf("b ran before a committed: %q", log)
	}
}

func TestAnIdleTransactionTurnsAWaitIntoAnError(t *testing.T) {
	_, addr := start(t, 100*time.Millisecond)
	a, b := connect(t, addr), connect(t, addr)
	a.query("BEGIN")
	got := b.query("select 1")
	if got[0].typ != 'E' || !strings.Contains(string(got[0].body), "55P03") || got[len(got)-1].body[0] != 'I' {
		t.Fatalf("b got %q", got)
	}
	// An extended exchange is dropped up to its Sync, then answered.
	b.write(message{'P', []byte("\x00select 1\x00\x00\x00")}, message{'B', []byte("\x00\x00\x00\x00\x00\x00\x00\x00")},
		message{'E', []byte("\x00\x00\x00\x00\x00")}, message{'S', nil})
	got = b.until('Z')
	if got[0].typ != 'E' || len(got) != 2 {
		t.Fatalf("b's extended exchange got %q", got)
	}
	a.query("COMMIT")
	if got := b.query("select 2"); got[0].typ != 'C' {
		t.Fatalf("b after a committed got %q", got)
	}
}

func TestStatementNamesAreAConnectionsOwn(t *testing.T) {
	f, addr := start(t, 5*time.Second)
	a := connect(t, addr)
	a.write(message{'P', []byte("s1\x00select 1\x00\x00\x00")}, message{'S', nil})
	a.until('Z')
	a.write(message{'B', []byte("p1\x00s1\x00\x00\x00\x00\x00\x00\x00")}, message{'S', nil})
	a.until('Z')
	log := f.entries()
	indexOf(t, log, "P pglite_server_1_s1 select 1")
	indexOf(t, log, "B pglite_server_1_p1 pglite_server_1_s1")
	a.write(message{'X', nil})
	a.conn.Close()
	waitFor(t, f, "C S pglite_server_1_s1")
}

func TestDisconnectingEndsTheTransactionAndTheSession(t *testing.T) {
	f, addr := start(t, 5*time.Second)
	a, b := connect(t, addr), connect(t, addr)
	b.query("select 0") // b has used the session, so it is not reset under it
	a.query("PREPARE q AS select 1")
	a.query("BEGIN")
	a.conn.Close()
	waitFor(t, f, `Q DEALLOCATE "q"`)
	log := f.entries()
	if indexOf(t, log, "Q ROLLBACK") > indexOf(t, log, `Q DEALLOCATE "q"`) {
		t.Fatalf("deallocated before rolling back: %q", log)
	}
	for _, e := range log {
		if e == "Q DISCARD ALL" {
			t.Fatalf("reset the session with b still connected: %q", log)
		}
	}
	if got := b.query("select 1"); got[0].typ != 'C' {
		t.Fatalf("b got %q", got)
	}
	b.conn.Close()
	waitFor(t, f, "Q DISCARD ALL")
}

func TestAConnectionThatHasNotUsedTheSessionGetsItReset(t *testing.T) {
	f, addr := start(t, 5*time.Second)
	a, b := connect(t, addr), connect(t, addr)
	a.query("SET search_path = nowhere")
	a.conn.Close()
	waitFor(t, f, "Q DISCARD ALL")
	b.query("select 1")
	log := f.entries()
	if indexOf(t, log, "Q DISCARD ALL") > indexOf(t, log, "Q select 1") {
		t.Fatalf("b ran before the reset: %q", log)
	}
}

func TestSyncWithoutTheBackendIsAnsweredHere(t *testing.T) {
	f, addr := start(t, 5*time.Second)
	a, b := connect(t, addr), connect(t, addr)
	a.query("BEGIN")
	b.write(message{'S', nil})
	if got := b.until('Z'); got[0].body[0] != 'I' {
		t.Fatalf("b got %q", got)
	}
	for _, e := range f.entries() {
		if e == "S" {
			t.Fatalf("b's Sync reached the backend inside a's transaction: %q", f.entries())
		}
	}
}

func TestNegotiatesDownToProtocol30(t *testing.T) {
	_, addr := start(t, 5*time.Second)
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	packet := startupPacket([][2]string{{"user", "app"}, {"_pq_.thing", "1"}})
	binary.BigEndian.PutUint32(packet[4:], 3<<16|2)
	conn.Write(packet)
	c := &testClient{t, conn, bufio.NewReader(conn)}
	got := c.until('Z')
	if got[0].typ != 'v' || !strings.Contains(string(got[0].body), "_pq_.thing") {
		t.Fatalf("got %q", got)
	}
}

func TestSQLStatements(t *testing.T) {
	for _, tc := range []struct {
		query   string
		prepare bool
		name    string
		all     bool
		ok      bool
	}{
		{"PREPARE __iw_shadow_1 AS SELECT 1", true, "__iw_shadow_1", false, true},
		{"  prepare Foo (int) as select $1", true, "foo", false, true},
		{`PREPARE "Mixed ""q""" AS SELECT 1`, true, `Mixed "q"`, false, true},
		{"PREPARE TRANSACTION 'x'", false, "", false, false},
		{"DEALLOCATE foo", false, "foo", false, true},
		{"deallocate prepare foo;", false, "foo", false, true},
		{"DEALLOCATE ALL", false, "", true, true},
		{"DEALLOCATE foo; SELECT 1", false, "", false, false},
		{"SELECT 'PREPARE x AS'", false, "", false, false},
	} {
		prepare, name, all, ok := sqlStatement(tc.query)
		if prepare != tc.prepare || name != tc.name || all != tc.all || ok != tc.ok {
			t.Errorf("%q: got %v %q %v %v", tc.query, prepare, name, all, ok)
		}
	}
}
