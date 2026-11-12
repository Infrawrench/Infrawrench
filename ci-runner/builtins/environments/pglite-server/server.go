package main

// Many client connections over one backend session.
//
// pglite is PostgreSQL's single-user backend: one session. Every client gets
// that session in turn, for as long as it needs it without interruption: from
// its first message until the backend is ready for a query outside a
// transaction block with nothing of the client's outstanding. So a
// transaction, or an extended-protocol exchange up to its Sync, always runs
// whole, and others' statements run between them, never inside. That is
// transaction pooling, as poolers do it, with one backend.
//
// What a client sees differently from a real server:
//
//   - Transactions never run at the same time. A second one waits for the
//     first to end, so it never meets the first one's row locks: `FOR
//     UPDATE SKIP LOCKED` skips nothing another transaction holds, because
//     none is open, and a claim made by one transaction is committed (or
//     rolled back) before the next reads.
//   - A client whose statement waits for another connection's transaction to
//     end, while that transaction waits for the client, would wait forever.
//     When the transaction has been idle (nothing running, nothing sent) for
//     the wait time, the waiting statement fails with 55P03 instead, naming
//     the connection that holds the backend.
//   - Session state is shared: SET, session advisory locks (one session holds
//     them all, so they never block), LISTEN, temporary tables. Prepared
//     statements are not: each connection's protocol-level names are its own,
//     and its SQL-level PREPAREs are deallocated when it disconnects. When the
//     last connection that used the session leaves, the session is reset
//     (DISCARD ALL), so a client that comes after starts from a clean
//     session as with a real server.
//   - The user, database and password a client gives are accepted as given;
//     it gets the one database as the one user.

import (
	"bufio"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"time"
)

type server struct {
	wait time.Duration

	backend *bufio.Writer // written only by the client that owns the backend
	reader  *bufio.Reader

	mu       sync.Mutex
	ready    *sync.Cond // signalled on every ReadyForQuery
	owner    *client    // nil when the backend is free
	waiters  []*client  // first in, first served
	pending  int        // Syncs, Queries and FunctionCalls not yet answered
	unsynced bool       // extended-protocol messages sent since the last Sync
	status   byte       // the backend's last transaction status: I, T or E
	active   time.Time  // the owner's or the backend's last message
	params   [][2]string
	clients  map[uint32]*client
	nextID   uint32
}

type client struct {
	id     uint32
	secret uint32
	prefix string
	conn   net.Conn
	r      *bufio.Reader

	wmu sync.Mutex
	w   *bufio.Writer

	wake    chan struct{}
	closing bool // guarded by server.mu
	used    bool // has had the backend; guarded by server.mu

	stmts    map[string]bool // protocol-level statements, by backend name
	prepared map[string]bool // SQL-level PREPAREd names
}

func newServer(backend net.Conn, wait time.Duration) *server {
	s := &server{
		wait:    wait,
		backend: bufio.NewWriterSize(backend, 64<<10),
		reader:  bufio.NewReaderSize(backend, 64<<10),
		status:  'I',
		clients: map[uint32]*client{},
	}
	s.ready = sync.NewCond(&s.mu)
	return s
}

// startup opens the backend session: no authentication (pglite trusts its
// one client), then the server's parameters, kept to hand each client.
func (s *server) startup(user, database, options string) error {
	params := [][2]string{{"user", user}, {"database", database}, {"application_name", "pglite-server"}}
	if options != "" {
		params = append(params, [2]string{"options", options})
	}
	if _, err := s.backend.Write(startupPacket(params)); err != nil {
		return err
	}
	if err := s.backend.Flush(); err != nil {
		return err
	}
	for {
		m, err := readMessage(s.reader)
		if err != nil {
			return fmt.Errorf("reading the backend's startup: %w", err)
		}
		switch m.typ {
		case 'R':
			if len(m.body) < 4 || binary.BigEndian.Uint32(m.body) != 0 {
				return errors.New("the backend asked for a password; it should trust its one client")
			}
		case 'S':
			s.setParam(m.body)
		case 'E':
			return fmt.Errorf("the backend refused the session: %s", errorText(m.body))
		case 'Z':
			return nil
		}
	}
}

func (s *server) setParam(body []byte) {
	name, off, err := cstring(body, 0)
	if err != nil {
		return
	}
	value, _, err := cstring(body, off)
	if err != nil {
		return
	}
	for i := range s.params {
		if s.params[i][0] == name {
			s.params[i][1] = value
			return
		}
	}
	s.params = append(s.params, [2]string{name, value})
}

// relay forwards the backend's messages to the client that owns it, and
// hands the backend on when that client is done with it. It returns when the
// backend's connection ends, which ends the server.
func (s *server) relay() error {
	for {
		m, err := readMessage(s.reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return errors.New("the backend closed its connection (pglite exited)")
			}
			return err
		}
		s.mu.Lock()
		owner := s.owner
		if m.typ == 'S' {
			// A SET the session ran: what later clients are told too.
			s.setParam(m.body)
		}
		forward := owner != nil && !owner.closing
		s.mu.Unlock()
		if forward {
			owner.send(m, m.typ == 'Z' || s.reader.Buffered() == 0)
		}
		if m.typ != 'Z' {
			continue
		}
		s.mu.Lock()
		if s.pending > 0 {
			s.pending--
		}
		if len(m.body) > 0 {
			s.status = m.body[0]
		}
		s.active = time.Now()
		if owner != nil && !owner.closing && s.idleLocked() {
			s.releaseLocked()
		}
		s.ready.Broadcast()
		s.mu.Unlock()
	}
}

// idleLocked: nothing outstanding and outside a transaction block, so the
// owner can give the backend up.
func (s *server) idleLocked() bool {
	return s.pending == 0 && !s.unsynced && s.status == 'I'
}

func (s *server) releaseLocked() {
	s.owner = nil
	for len(s.waiters) > 0 {
		next := s.waiters[0]
		s.waiters = s.waiters[1:]
		s.owner = next
		s.active = time.Now()
		select {
		case next.wake <- struct{}{}:
		default:
		}
		return
	}
}

// busyError: the backend is held by another connection's transaction that
// has done nothing for the wait time.
type busyError struct {
	holder uint32
	idle   time.Duration
}

func (e busyError) Error() string {
	return fmt.Sprintf("pglite-server runs one transaction at a time, and connection %d has held it open, idle, for %s",
		e.holder, e.idle.Round(100*time.Millisecond))
}

// acquire makes c the backend's owner, waiting its turn. With bounded set, it
// gives up with a busyError once the owner has sat idle in a transaction for
// the wait time.
func (s *server) acquire(c *client, bounded bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.owner == c {
		return nil
	}
	if s.owner == nil && len(s.waiters) == 0 {
		s.owner = c
		c.used = true
		s.active = time.Now()
		return nil
	}
	s.waiters = append(s.waiters, c)
	for {
		timeout := s.wait
		if bounded && s.owner != nil && !s.owner.closing && s.pending == 0 {
			idle := time.Since(s.active)
			if idle >= s.wait {
				s.removeWaiterLocked(c)
				return busyError{s.owner.id, idle}
			}
			timeout = s.wait - idle
		}
		s.mu.Unlock()
		timer := time.NewTimer(timeout)
		select {
		case <-c.wake:
		case <-timer.C:
		}
		timer.Stop()
		s.mu.Lock()
		if s.owner == c {
			c.used = true
			return nil
		}
	}
}

func (s *server) removeWaiterLocked(c *client) {
	for i, w := range s.waiters {
		if w == c {
			s.waiters = append(s.waiters[:i], s.waiters[i+1:]...)
			return
		}
	}
}

// toBackend sends one of the owner's messages, keeping count of what the
// backend owes an answer to. flush when nothing else is about to follow.
func (s *server) toBackend(m message, flush bool) error {
	s.mu.Lock()
	switch m.typ {
	case 'S':
		s.pending++
		s.unsynced = false
	case 'Q', 'F':
		s.pending++
	case 'P', 'B', 'D', 'E', 'C':
		s.unsynced = true
	}
	s.active = time.Now()
	s.mu.Unlock()
	if err := writeMessage(s.backend, m); err != nil {
		return err
	}
	if flush {
		return s.backend.Flush()
	}
	return nil
}

// settle waits until the backend has answered everything sent to it.
func (s *server) settle() {
	s.mu.Lock()
	for s.pending > 0 {
		s.ready.Wait()
	}
	s.mu.Unlock()
}

// internal runs messages of the server's own as the owner, ignoring what
// comes back (the owner is closing, so nothing is forwarded).
func (s *server) internal(ms ...message) error {
	for i, m := range ms {
		if err := s.toBackend(m, i == len(ms)-1); err != nil {
			return err
		}
	}
	s.settle()
	return nil
}

func (s *server) serve(ln net.Listener) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		go s.serveClient(conn)
	}
}

func (s *server) serveClient(conn net.Conn) {
	defer conn.Close()
	c := &client{
		conn:     conn,
		r:        bufio.NewReaderSize(conn, 64<<10),
		w:        bufio.NewWriterSize(conn, 64<<10),
		wake:     make(chan struct{}, 1),
		stmts:    map[string]bool{},
		prepared: map[string]bool{},
	}
	if !s.handshake(c) {
		return
	}
	defer s.disconnect(c)
	for {
		m, err := readMessage(c.r)
		if err != nil || m.typ == 'X' {
			return
		}
		if fatal := s.handle(c, m); fatal != nil {
			if !errors.Is(fatal, errClientGone) {
				log.Fatalf("writing to the backend: %v", fatal)
			}
			return
		}
	}
}

var errClientGone = errors.New("client disconnected")

// handshake answers the client's startup packet: no encryption, no
// password, then the session's parameters and a key of the client's own.
func (s *server) handshake(c *client) bool {
	for {
		code, body, err := readStartup(c.r)
		if err != nil {
			return false
		}
		switch code {
		case sslRequest, gssEncRequest:
			// Not offered: the client goes on unencrypted, or gives up if it
			// insisted (sslmode=require).
			if _, err := c.conn.Write([]byte{'N'}); err != nil {
				return false
			}
			continue
		case cancelRequest:
			// The backend cannot be interrupted from a second connection; a
			// cancelled statement runs to its end.
			return false
		}
		if code>>16 != 3 {
			c.send(errorResponse("FATAL", "08P01", fmt.Sprintf("unsupported frontend protocol %d.%d", code>>16, code&0xffff), ""), true)
			return false
		}
		params, err := startupParams(body)
		if err != nil {
			c.send(errorResponse("FATAL", "08P01", err.Error(), ""), true)
			return false
		}
		if code&0xffff != 0 {
			// Newer minor versions (3.2's longer cancel keys) are declined;
			// so are protocol extensions (_pq_.*).
			var unknown []string
			for name := range params {
				if len(name) > 4 && name[:4] == "_pq_" {
					unknown = append(unknown, name)
				}
			}
			b := binary.BigEndian.AppendUint32(nil, 0)
			b = binary.BigEndian.AppendUint32(b, uint32(len(unknown)))
			for _, name := range unknown {
				b = appendCString(b, name)
			}
			c.send(message{'v', b}, false)
		}
		break
	}

	var key [4]byte
	_, _ = rand.Read(key[:])
	s.mu.Lock()
	s.nextID++
	c.id = s.nextID
	c.secret = binary.BigEndian.Uint32(key[:])
	c.prefix = fmt.Sprintf("pglite_server_%d_", c.id)
	s.clients[c.id] = c
	params := append([][2]string(nil), s.params...)
	s.mu.Unlock()

	c.send(message{'R', []byte{0, 0, 0, 0}}, false)
	for _, kv := range params {
		c.send(message{'S', appendCString(appendCString(nil, kv[0]), kv[1])}, false)
	}
	kd := binary.BigEndian.AppendUint32(nil, c.id)
	c.send(message{'K', binary.BigEndian.AppendUint32(kd, c.secret)}, false)
	return c.send(readyForQuery('I'), true)
}

// handle passes one of the client's messages to the backend once the client
// has it, or answers it here when the client does not need it.
func (s *server) handle(c *client, m message) error {
	s.mu.Lock()
	owns := s.owner == c
	s.mu.Unlock()
	if !owns {
		switch m.typ {
		case 'S':
			// Nothing of the client's is outstanding and it is in no
			// transaction: a Sync on its own only asks for that status.
			c.send(readyForQuery('I'), true)
			return nil
		case 'H':
			return nil // nothing to flush
		case 'd', 'c', 'f':
			return nil // COPY data with no COPY running
		}
	}
	if err := s.acquire(c, true); err != nil {
		return s.refuse(c, m, err)
	}

	body := m.body
	var err error
	switch m.typ {
	case 'P':
		var name, text string
		body, name, text, err = rewriteParse(m.body, c.prefix)
		if name != "" {
			c.stmts[name] = true
		}
		c.noteSQL(text)
	case 'B':
		body, err = rewriteBind(m.body, c.prefix)
	case 'D':
		body, _, _, err = rewriteTarget(m.body, c.prefix)
	case 'C':
		var kind byte
		var name string
		body, kind, name, err = rewriteTarget(m.body, c.prefix)
		if kind == 'S' {
			delete(c.stmts, name)
		}
	case 'E':
		body, err = rewriteExecute(m.body, c.prefix)
	case 'Q':
		if text, _, e := cstring(m.body, 0); e == nil {
			c.noteSQL(text)
		}
	}
	if err != nil {
		// A message the backend could not read either: its own error says
		// so better, so it gets it as it is.
		body = m.body
	}
	flush := c.r.Buffered() == 0
	switch m.typ {
	case 'S', 'Q', 'H', 'F', 'c', 'f':
		flush = true
	}
	return s.toBackend(message{m.typ, body}, flush)
}

// noteSQL remembers what a query PREPAREs or DEALLOCATEs.
func (c *client) noteSQL(text string) {
	prepare, name, all, ok := sqlStatement(text)
	switch {
	case !ok:
	case all:
		c.prepared = map[string]bool{}
	case prepare:
		c.prepared[name] = true
	default:
		delete(c.prepared, name)
	}
}

// refuse answers a message that gave up waiting for the backend: an error,
// and for an extended-protocol exchange, everything up to its Sync dropped.
func (s *server) refuse(c *client, m message, why error) error {
	log.Printf("connection %d: %v", c.id, why)
	e := errorResponse("ERROR", "55P03",
		fmt.Sprintf("%v; this connection gave up waiting for it after %s", why, s.wait),
		"The connection holding it may be waiting for this one, which cannot run until it ends: PostgreSQL here is one backend (wasmer/pglite).")
	c.send(e, true)
	if m.typ != 'Q' && m.typ != 'F' {
		for m.typ != 'S' {
			next, err := readMessage(c.r)
			if err != nil || next.typ == 'X' {
				return errClientGone
			}
			m = next
		}
	}
	c.send(readyForQuery('I'), true)
	return nil
}

// disconnect puts the session back as the client found it: its exchange
// finished, its transaction rolled back, its prepared statements gone, and,
// when no other connection has used the session, the whole session reset.
func (s *server) disconnect(c *client) {
	s.mu.Lock()
	delete(s.clients, c.id)
	c.closing = true
	s.removeWaiterLocked(c)
	owns := s.owner == c
	last := s.lastLocked()
	tidy := owns || len(c.stmts) > 0 || len(c.prepared) > 0 || last
	s.mu.Unlock()
	if !tidy {
		return
	}
	if err := s.acquire(c, false); err != nil {
		return
	}
	run := func(ms ...message) {
		if err := s.internal(ms...); err != nil {
			log.Fatalf("writing to the backend: %v", err)
		}
	}
	s.mu.Lock()
	unsynced := s.unsynced
	s.mu.Unlock()
	if unsynced {
		run(message{'S', nil})
	}
	s.settle()
	s.mu.Lock()
	status := s.status
	s.mu.Unlock()
	if status != 'I' {
		run(query("ROLLBACK"))
	}
	if len(c.stmts) > 0 {
		var ms []message
		for name := range c.stmts {
			ms = append(ms, message{'C', appendCString([]byte{'S'}, name)})
		}
		run(append(ms, message{'S', nil})...)
	}
	for name := range c.prepared {
		run(query("DEALLOCATE " + quoteIdentifier(name)))
	}
	s.mu.Lock()
	last = s.lastLocked()
	s.mu.Unlock()
	if last {
		run(query("DISCARD ALL"))
	}
	s.mu.Lock()
	s.releaseLocked()
	s.mu.Unlock()
}

// lastLocked: no connection left that has used the session. One that has
// connected but not yet sent anything has seen none of it, and starts on
// the reset session as it would on a new backend.
func (s *server) lastLocked() bool {
	for _, c := range s.clients {
		if c.used {
			return false
		}
	}
	return true
}

// send writes a message to the client; false once the client is gone.
func (c *client) send(m message, flush bool) bool {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if err := writeMessage(c.w, m); err != nil {
		return false
	}
	if flush {
		return c.w.Flush() == nil
	}
	return true
}
