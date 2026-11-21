# A stand-in for a MySQL server, for builtins/test.sh (there is no MySQL
# for WASIX): the handshake, TLS when the client asks for it (a self-signed
# certificate for the name `mysql`, written to ARGV[0]), the OK that ends
# authentication whatever was sent, and COM_PING. Enough for mysql2 and
# trilogy to connect over TLS and ping; nothing else.
require "socket"
require "openssl"

key = OpenSSL::PKey::EC.generate("prime256v1")
cert = OpenSSL::X509::Certificate.new
cert.version = 2
cert.serial = 1
cert.subject = cert.issuer = OpenSSL::X509::Name.parse("/CN=fake-mysql")
cert.public_key = key
ef = OpenSSL::X509::ExtensionFactory.new(cert, cert)
cert.add_extension(ef.create_extension("subjectAltName", "DNS:mysql"))
cert.add_extension(ef.create_extension("basicConstraints", "CA:TRUE", true))
cert.not_before = Time.now - 60
cert.not_after = Time.now + 3600
cert.sign(key, OpenSSL::Digest.new("SHA256"))
File.write(ARGV[0], cert.to_pem) if ARGV[0]
ctx = OpenSSL::SSL::SSLContext.new
ctx.cert = cert
ctx.key = key

def packet(io, seq, payload)
  io.write([payload.bytesize].pack("V")[0, 3] + seq.chr + payload)
end

def read_packet(io)
  header = io.read(4) or return nil
  len = (header.bytes[0]) | (header.bytes[1] << 8) | (header.bytes[2] << 16)
  [header.bytes[3], io.read(len)]
end

CAPS = 0x1 | 0x8 | 0x200 | 0x800 | 0x2000 | 0x8000 | 0x80000 | 0x200000
OK = "\x00\x00\x00\x02\x00\x00\x00".b

server = TCPServer.new("127.0.0.1", 3307)
puts "fake mysql listening"
$stdout.flush
loop do
  sock = server.accept
  begin
    scramble = "abcdefghijklmnopqrst".b
    hello = "\x0a".b + "8.0.40-fake\x00".b + [7].pack("V") + scramble[0, 8] + "\x00".b +
      [CAPS & 0xffff].pack("v") + "\x21".b + [2].pack("v") + [CAPS >> 16].pack("v") +
      "\x15".b + ("\x00" * 10).b + scramble[8, 12] + "\x00".b + "mysql_native_password\x00".b
    packet(sock, 0, hello)
    seq, req = read_packet(sock)
    io = sock
    if req.bytesize == 32 && (req.unpack1("V") & 0x800) != 0
      io = OpenSSL::SSL::SSLSocket.new(sock, ctx)
      io.accept
      seq, req = read_packet(io)
    end
    packet(io, seq + 1, OK)
    while (p = read_packet(io))
      seq, cmd = p
      case cmd.getbyte(0)
      when 0x0e then packet(io, seq + 1, OK) # COM_PING
      when 0x01 then break # COM_QUIT
      else packet(io, seq + 1, "\xff\x48\x04#HY000unsupported".b)
      end
    end
  rescue => e
    warn "fake mysql: #{e.class}: #{e.message}"
  ensure
    sock.close rescue nil
  end
end
