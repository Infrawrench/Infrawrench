// An SSH server just big enough for builtins/test.sh's OpenSSH jobs, on
// the job's own loopback: public key authentication against an
// authorized_keys file, `exec` requests run by the job's bash, the `sftp`
// subsystem (what scp and sftp speak) on the job's files, and
// `direct-tcpip` channels, which are what ProxyJump (`ssh -W`) opens on a
// jump host. Nothing else: no shell, no terminal, no passwords. It logs
// each thing it does on stdout, so a job can check which server a
// connection reached.
//
//	sshd-fixture -listen 127.0.0.1:2222 -host-key key[,key] -authorized keys [-name label]
//
// Built for wasip1 by builtins/openssh/build.sh with env:go's toolchain,
// whose WASIX patches give it sockets and processes. A wasip1 Go program
// has one thread, and waiting for a process or reading a pipe blocks all of
// it, so an exec request does not stream: the command's stdin is the
// channel's input up to EOF, and its output is written to files that are
// sent once it exits. That is all a test needs, and it cannot deadlock.
package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

var name string

func logf(format string, args ...any) {
	fmt.Printf("sshd-fixture %s: %s\n", name, fmt.Sprintf(format, args...))
}

func main() {
	listen := flag.String("listen", "127.0.0.1:2222", "address to listen on")
	hostKeys := flag.String("host-key", "", "comma-separated private host key files")
	authorized := flag.String("authorized", "", "authorized_keys file")
	shell := flag.String("shell", "/bin/bash", "what runs an exec request")
	flag.StringVar(&name, "name", "", "label for the log")
	flag.Parse()
	if name == "" {
		name = *listen
	}
	if err := run(*listen, *hostKeys, *authorized, *shell); err != nil {
		fmt.Fprintln(os.Stderr, "sshd-fixture:", err)
		os.Exit(1)
	}
}

func run(listen, hostKeys, authorized, shell string) error {
	allowed := map[string]bool{}
	text, err := os.ReadFile(authorized)
	if err != nil {
		return err
	}
	for len(bytes.TrimSpace(text)) > 0 {
		key, _, _, rest, err := ssh.ParseAuthorizedKey(text)
		if err != nil {
			return fmt.Errorf("%s: %w", authorized, err)
		}
		allowed[string(key.Marshal())] = true
		text = rest
	}
	config := &ssh.ServerConfig{
		PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if allowed[string(key.Marshal())] {
				logf("accepted %s key %s for %s", key.Type(), ssh.FingerprintSHA256(key), meta.User())
				return &ssh.Permissions{}, nil
			}
			logf("refused %s key %s for %s", key.Type(), ssh.FingerprintSHA256(key), meta.User())
			return nil, errors.New("key not authorized")
		},
	}
	for _, path := range strings.Split(hostKeys, ",") {
		pem, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		signer, err := ssh.ParsePrivateKey(pem)
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		config.AddHostKey(signer)
	}
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	logf("listening on %s", listen)
	for {
		conn, err := listener.Accept()
		if err != nil {
			return err
		}
		go serve(conn, config, shell)
	}
}

func serve(conn net.Conn, config *ssh.ServerConfig, shell string) {
	server, channels, requests, err := ssh.NewServerConn(conn, config)
	if err != nil {
		logf("handshake: %v", err)
		conn.Close()
		return
	}
	logf("connection from %s as %s (%s)", server.RemoteAddr(), server.User(), server.ClientVersion())
	go ssh.DiscardRequests(requests)
	for newChannel := range channels {
		switch newChannel.ChannelType() {
		case "session":
			go session(newChannel, shell)
		case "direct-tcpip":
			go forward(newChannel)
		default:
			newChannel.Reject(ssh.UnknownChannelType, newChannel.ChannelType())
		}
	}
}

// forward serves a direct-tcpip channel (RFC 4254 7.2), as `ssh -W` asks
// a jump host for: a connection to host:port, piped both ways.
func forward(newChannel ssh.NewChannel) {
	var target struct {
		Host       string
		Port       uint32
		OriginHost string
		OriginPort uint32
	}
	if err := ssh.Unmarshal(newChannel.ExtraData(), &target); err != nil {
		newChannel.Reject(ssh.ConnectionFailed, "bad direct-tcpip request")
		return
	}
	address := net.JoinHostPort(target.Host, fmt.Sprint(target.Port))
	conn, err := net.Dial("tcp", address)
	if err != nil {
		logf("direct-tcpip to %s: %v", address, err)
		newChannel.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	channel, requests, err := newChannel.Accept()
	if err != nil {
		conn.Close()
		return
	}
	logf("direct-tcpip to %s", address)
	go ssh.DiscardRequests(requests)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		io.Copy(conn, channel)
		if tcp, ok := conn.(*net.TCPConn); ok {
			tcp.CloseWrite()
		}
		wg.Done()
	}()
	go func() {
		io.Copy(channel, conn)
		channel.CloseWrite()
		wg.Done()
	}()
	wg.Wait()
	conn.Close()
	channel.Close()
}

// session serves one session channel: its first exec or sftp subsystem
// request, then the exit status.
func session(newChannel ssh.NewChannel, shell string) {
	channel, requests, err := newChannel.Accept()
	if err != nil {
		return
	}
	defer channel.Close()
	for req := range requests {
		var status uint32
		switch req.Type {
		case "exec":
			var payload struct{ Command string }
			if ssh.Unmarshal(req.Payload, &payload) != nil {
				req.Reply(false, nil)
				continue
			}
			logf("exec %q", payload.Command)
			req.Reply(true, nil)
			go ssh.DiscardRequests(requests)
			status = execute(channel, shell, payload.Command)
		case "subsystem":
			var payload struct{ Name string }
			if ssh.Unmarshal(req.Payload, &payload) != nil || payload.Name != "sftp" {
				req.Reply(false, nil)
				continue
			}
			logf("subsystem sftp")
			req.Reply(true, nil)
			go ssh.DiscardRequests(requests)
			server, err := sftp.NewServer(channel)
			if err == nil {
				err = server.Serve()
			}
			if err != nil && err != io.EOF {
				logf("sftp: %v", err)
				status = 1
			}
		default:
			// env, pty-req, shell and the rest: not here.
			req.Reply(false, nil)
			continue
		}
		channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
		return
	}
}

// execute runs command with the channel's input, read to EOF first, as its
// stdin, and sends what it wrote once it exits (see the top of this file).
func execute(channel ssh.Channel, shell, command string) uint32 {
	fail := func(err error) uint32 {
		fmt.Fprintln(channel.Stderr(), "sshd-fixture:", err)
		return 255
	}
	files := make([]*os.File, 3)
	for i := range files {
		f, err := os.CreateTemp("", "sshd-fixture-")
		if err != nil {
			return fail(err)
		}
		defer os.Remove(f.Name())
		defer f.Close()
		files[i] = f
	}
	if _, err := io.Copy(files[0], channel); err != nil {
		return fail(err)
	}
	if _, err := files[0].Seek(0, io.SeekStart); err != nil {
		return fail(err)
	}
	cmd := exec.Command(shell, "-c", command)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = files[0], files[1], files[2]
	err := cmd.Run()
	for i, w := range []io.Writer{channel, channel.Stderr()} {
		if _, err := files[i+1].Seek(0, io.SeekStart); err == nil {
			io.Copy(w, files[i+1])
		}
	}
	var exit *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exit):
		return uint32(exit.ExitCode())
	default:
		return fail(err)
	}
}
