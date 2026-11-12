package main

// The parts of PostgreSQL's wire protocol (version 3.0) the server reads and
// writes: framing, the startup packet, and the messages whose statement and
// portal names it rewrites so that each connection's prepared statements
// stay its own on the one backend they share.

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// The largest message either side may send, PostgreSQL's own limit.
const maxMessage = 1 << 30

// Request codes a startup packet can carry instead of a protocol version.
const (
	sslRequest    = 80877103
	gssEncRequest = 80877104
	cancelRequest = 80877102
)

type message struct {
	typ  byte
	body []byte
}

func readMessage(r *bufio.Reader) (message, error) {
	typ, err := r.ReadByte()
	if err != nil {
		return message{}, err
	}
	var size [4]byte
	if _, err := io.ReadFull(r, size[:]); err != nil {
		return message{}, err
	}
	n := int64(binary.BigEndian.Uint32(size[:])) - 4
	if n < 0 || n > maxMessage {
		return message{}, fmt.Errorf("message %q has an invalid length %d", typ, n+4)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return message{}, err
	}
	return message{typ, body}, nil
}

func writeMessage(w io.Writer, m message) error {
	var head [5]byte
	head[0] = m.typ
	binary.BigEndian.PutUint32(head[1:], uint32(len(m.body)+4))
	if _, err := w.Write(head[:]); err != nil {
		return err
	}
	_, err := w.Write(m.body)
	return err
}

// readStartup reads a startup packet, which has a length but no type byte.
func readStartup(r *bufio.Reader) (code uint32, body []byte, err error) {
	var size [4]byte
	if _, err := io.ReadFull(r, size[:]); err != nil {
		return 0, nil, err
	}
	n := int(binary.BigEndian.Uint32(size[:]))
	if n < 8 || n > 10000 {
		return 0, nil, fmt.Errorf("invalid startup packet length %d", n)
	}
	buf := make([]byte, n-4)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return binary.BigEndian.Uint32(buf[:4]), buf[4:], nil
}

// startupParams decodes a startup packet's name/value pairs.
func startupParams(body []byte) (map[string]string, error) {
	params := map[string]string{}
	for off := 0; off < len(body); {
		if body[off] == 0 {
			return params, nil
		}
		name, next, err := cstring(body, off)
		if err != nil {
			return nil, err
		}
		value, next, err := cstring(body, next)
		if err != nil {
			return nil, err
		}
		params[name] = value
		off = next
	}
	return nil, errors.New("startup packet does not end in a NUL byte")
}

func startupPacket(params [][2]string) []byte {
	body := binary.BigEndian.AppendUint32(nil, 3<<16)
	for _, kv := range params {
		body = append(body, kv[0]...)
		body = append(body, 0)
		body = append(body, kv[1]...)
		body = append(body, 0)
	}
	body = append(body, 0)
	packet := binary.BigEndian.AppendUint32(nil, uint32(len(body)+4))
	return append(packet, body...)
}

// cstring reads a NUL-terminated string at off, returning the offset after it.
func cstring(b []byte, off int) (string, int, error) {
	if off > len(b) {
		return "", 0, errors.New("truncated message")
	}
	for i := off; i < len(b); i++ {
		if b[i] == 0 {
			return string(b[off:i]), i + 1, nil
		}
	}
	return "", 0, errors.New("unterminated string in message")
}

func appendCString(b []byte, s string) []byte {
	b = append(b, s...)
	return append(b, 0)
}

// named gives a connection's own name for a statement or portal. The empty
// name is the unnamed one, which lives only as long as one exchange and
// needs no prefix: no other connection runs between a Parse and its Sync.
func named(prefix, name string) string {
	if name == "" {
		return ""
	}
	return prefix + name
}

// rewriteParse renames the statement a Parse creates. It returns the new
// name (empty for the unnamed statement) and the query text.
func rewriteParse(body []byte, prefix string) (out []byte, name, query string, err error) {
	name, off, err := cstring(body, 0)
	if err != nil {
		return nil, "", "", err
	}
	query, _, err = cstring(body, off)
	if err != nil {
		return nil, "", "", err
	}
	name = named(prefix, name)
	out = appendCString(make([]byte, 0, len(body)+len(prefix)), name)
	return append(out, body[off:]...), name, query, nil
}

// rewriteBind renames a Bind's portal and its statement.
func rewriteBind(body []byte, prefix string) ([]byte, error) {
	portal, off, err := cstring(body, 0)
	if err != nil {
		return nil, err
	}
	stmt, rest, err := cstring(body, off)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(body)+2*len(prefix))
	out = appendCString(out, named(prefix, portal))
	out = appendCString(out, named(prefix, stmt))
	return append(out, body[rest:]...), nil
}

// rewriteTarget renames the statement or portal a Describe or Close names
// (a kind byte, 'S' or 'P', then the name). It returns the kind and new name.
func rewriteTarget(body []byte, prefix string) ([]byte, byte, string, error) {
	if len(body) < 1 {
		return nil, 0, "", errors.New("truncated message")
	}
	name, _, err := cstring(body, 1)
	if err != nil {
		return nil, 0, "", err
	}
	name = named(prefix, name)
	out := appendCString([]byte{body[0]}, name)
	return out, body[0], name, nil
}

// rewriteExecute renames the portal an Execute runs.
func rewriteExecute(body []byte, prefix string) ([]byte, error) {
	portal, off, err := cstring(body, 0)
	if err != nil {
		return nil, err
	}
	out := appendCString(make([]byte, 0, len(body)+len(prefix)), named(prefix, portal))
	return append(out, body[off:]...), nil
}

// SQL-level PREPARE and DEALLOCATE, which name statements in the query text
// the server cannot rename. It remembers the names a connection prepares
// and deallocates them when it disconnects, as a real backend would have.
var (
	sqlName       = `("(?:[^"]|"")+"|[A-Za-z_\x80-\xff][A-Za-z0-9_$\x80-\xff]*)`
	prepareRe     = regexp.MustCompile(`(?is)^\s*prepare\s+` + sqlName + `\s*(?:\(|as\b)`)
	deallocateRe  = regexp.MustCompile(`(?is)^\s*deallocate\s+(?:prepare\s+)?` + sqlName + `\s*;?\s*$`)
	singleCommand = regexp.MustCompile(`(?s)^[^;]*;?\s*$`)
)

// sqlStatement says whether a query is a single PREPARE or DEALLOCATE, and
// which name it gives. all is DEALLOCATE ALL.
func sqlStatement(query string) (prepare bool, name string, all bool, ok bool) {
	if m := prepareRe.FindStringSubmatch(query); m != nil {
		if strings.EqualFold(m[1], "transaction") {
			return false, "", false, false
		}
		return true, identifier(m[1]), false, true
	}
	if !singleCommand.MatchString(query) {
		return false, "", false, false
	}
	if m := deallocateRe.FindStringSubmatch(query); m != nil {
		if strings.EqualFold(m[1], "all") {
			return false, "", true, true
		}
		return false, identifier(m[1]), false, true
	}
	return false, "", false, false
}

// identifier is the name PostgreSQL stores for a written identifier.
func identifier(written string) string {
	if strings.HasPrefix(written, `"`) {
		return strings.ReplaceAll(written[1:len(written)-1], `""`, `"`)
	}
	return strings.ToLower(written)
}

func quoteIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// errorResponse is an ErrorResponse with a SQLSTATE, message and hint.
func errorResponse(severity, code, text, hint string) message {
	var b []byte
	b = append(b, 'S')
	b = appendCString(b, severity)
	b = append(b, 'V')
	b = appendCString(b, severity)
	b = append(b, 'C')
	b = appendCString(b, code)
	b = append(b, 'M')
	b = appendCString(b, text)
	if hint != "" {
		b = append(b, 'H')
		b = appendCString(b, hint)
	}
	return message{'E', append(b, 0)}
}

// errorText is the message of an ErrorResponse, for logs.
func errorText(body []byte) string {
	for off := 0; off < len(body) && body[off] != 0; {
		field := body[off]
		value, next, err := cstring(body, off+1)
		if err != nil {
			break
		}
		if field == 'M' {
			return value
		}
		off = next
	}
	return "unknown error"
}

func readyForQuery(status byte) message { return message{'Z', []byte{status}} }

func query(text string) message { return message{'Q', appendCString(nil, text)} }
