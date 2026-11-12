// pglite-server: PostgreSQL for a CI job's services, many connections at a
// time, over wasmer/pglite's one.
//
// pglite (PostgreSQL 18 for WASIX) is the single-user backend behind its own
// socket: one client connection, after which it exits. This starts it on a
// port of its own, keeps that one connection for the rest of the job, and
// serves PostgreSQL clients on the usual port, as many as connect, each
// getting the backend in turn for a transaction at a time (server.go says
// what that does and does not give a client).
//
//	pglite-server [-port 5432] [-wait 15s]
//
// It prints "pglite-server: ready on port 5432" once clients can connect.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"strconv"
	"time"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("pglite-server: ")
	port := flag.Int("port", 5432, "the port clients connect to")
	backendPort := flag.Int("backend-port", 54329, "the port pglite listens on, for this server alone")
	wait := flag.Duration("wait", 15*time.Second,
		"how long a statement waits for another connection's transaction that is open but doing nothing, before failing")
	upstream := flag.String("upstream", "",
		"host:port of a PostgreSQL to use instead of starting pglite (for testing this server)")
	extensions := flag.String("extensions", "/opt/pglite-server",
		"a directory whose extension/ holds more extensions' control files (extension_control_path)")
	flag.Parse()

	addr := *upstream
	options := ""
	if addr == "" {
		addr = "127.0.0.1:" + strconv.Itoa(*backendPort)
		startPglite(*backendPort)
		if *extensions != "" {
			options = "-c extension_control_path=" + *extensions + ":$system"
		}
	}
	backend := dial(addr)
	s := newServer(backend, *wait)
	if err := s.startup("postgres", "postgres", options); err != nil {
		log.Fatal(err)
	}
	go func() {
		log.Fatal(s.relay())
	}()

	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(*port))
	if err != nil {
		log.Fatal(err)
	}
	// localhost may resolve to ::1 first; serve both where both exist.
	if ln6, err := net.Listen("tcp", "[::1]:"+strconv.Itoa(*port)); err == nil {
		go func() { log.Fatal(s.serve(ln6)) }()
	}
	fmt.Fprintf(os.Stderr, "pglite-server: ready on port %d\n", *port)
	log.Fatal(s.serve(ln))
}

// startPglite runs wasmer/pglite on the given port, its output passed on.
// Nothing waits for it to exit: a wasip1 program has one thread, so a
// blocking wait would stop every goroutine. When it exits, its connection
// ends, and relay ends the server; when it never listens, dial does.
func startPglite(port int) {
	cmd := exec.Command("pglite")
	cmd.Env = append(os.Environ(), "OLIPHAUNT_WASIX_SOCKET_PORT="+strconv.Itoa(port))
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Fatalf("starting pglite: %v", err)
	}
}

// dial connects to the backend once it listens. A refused connection uses
// nothing up, so trying again is safe even with pglite's one connection.
func dial(addr string) net.Conn {
	deadline := time.Now().Add(60 * time.Second)
	for {
		conn, err := net.Dial("tcp", addr)
		if err == nil {
			return conn
		}
		if time.Now().After(deadline) {
			log.Fatalf("connecting to %s: %v", addr, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
