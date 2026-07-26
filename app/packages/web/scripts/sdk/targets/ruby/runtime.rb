# frozen_string_literal: true
#
# The hand-written half of the generated Ruby SDK.
#
# This file is **not loaded by anything in this repo** — the generator reads it
# off disk and emits everything below the sentinel as
# `lib/infrawrench/transport.rb`. Keeping it as real Ruby (rather than a heredoc
# inside index.ts) means `ruby -c` and a Ruby editor can see it, so a mistake in
# the request plumbing shows up here instead of in generated output nobody
# reads.
#
# Two tokens are substituted at generation time — see `loadRuntime` in
# `./index.ts`. They are written as plain literals so this file still parses on
# its own.
#
# Nothing here may require anything outside the standard library: the published
# gem has zero runtime dependencies and must work on stock Ruby 3.0+.

# --8<-- everything below this line is emitted as lib/infrawrench/transport.rb --8<--

require "json"
require "net/http"
require "securerandom"
require "uri"

module Infrawrench
  # Replaced with the first server advertised by the spec.
  DEFAULT_BASE_URL = "@@BASE_URL@@"

  # Replaced with the path parameter the client can carry as configuration
  # (`orgId`), or `nil` if the API has no such parameter.
  SCOPE_PARAM = "@@SCOPE_PARAM@@"

  # Base class for everything this gem raises, so `rescue Infrawrench::Error`
  # catches transport misconfiguration and HTTP failures alike.
  class Error < StandardError; end

  # Raised before anything is sent: a required path parameter has no value from
  # either the call site or the client's configuration.
  class ConfigurationError < Error; end

  # Raised for any non-2xx response.
  #
  # Branch on {#code} rather than on the message — it carries the API's
  # machine-readable discriminator (e.g. `reauthentication_required` on a
  # step-up 403) whenever the response body has one.
  class ApiError < Error
    # @return [Integer] HTTP status code.
    attr_reader :status
    # @return [String, nil] Machine-readable error code, when the API sent one.
    attr_reader :code
    # @return [Object] Parsed response body — a Hash for JSON, else the raw String.
    attr_reader :body
    # @return [String] HTTP method of the failed request, e.g. `"GET"`.
    attr_reader :http_method
    # @return [String] Fully resolved URL of the failed request.
    attr_reader :url

    def initialize(status:, message:, code:, body:, http_method:, url:)
      super(message)
      @status = status
      @code = code
      @body = body
      @http_method = http_method
      @url = url
    end
  end

  # A file to send in a `multipart/form-data` request.
  #
  # Call sites rarely need this: a plain String of bytes or any IO-like object
  # is accepted wherever a file is expected, and {.coerce} wraps it. Construct
  # one explicitly only to control the filename or content type the server sees.
  class Upload
    # @return [String] The file's bytes.
    attr_reader :bytes
    # @return [String] Filename sent in the part's Content-Disposition.
    attr_reader :filename
    # @return [String] Content-Type sent for the part.
    attr_reader :content_type

    def initialize(content, filename: "file", content_type: "application/octet-stream")
      @bytes = (content.respond_to?(:read) ? content.read : content.to_s).b
      @filename = filename
      @content_type = content_type
    end

    # Wrap whatever a caller passed for a file field.
    #
    # A `File` keeps its basename, because a server that stores the upload under
    # the name it was given should get the name the user actually chose.
    #
    # @param value [Upload, IO, String]
    # @return [Upload]
    def self.coerce(value)
      return value if value.is_a?(Upload)
      return new(value) unless value.respond_to?(:read)

      path = value.respond_to?(:path) ? value.path : nil
      path ? new(value, filename: File.basename(path)) : new(value)
    end
  end

  # Request plumbing shared by every namespace.
  #
  # The generated namespace classes each hold one of these; reach for
  # {APIV1Client} instead unless you need the resolved {#base_url}.
  class Transport
    # Net::HTTP models each verb as its own request class, so the generated
    # method strings have to be mapped rather than interpolated.
    METHOD_CLASSES = {
      "GET" => Net::HTTP::Get,
      "POST" => Net::HTTP::Post,
      "PUT" => Net::HTTP::Put,
      "PATCH" => Net::HTTP::Patch,
      "DELETE" => Net::HTTP::Delete
    }.freeze
    private_constant :METHOD_CLASSES

    # Everything RFC 3986 lets a path segment carry unescaped.
    PATH_SAFE = /[^a-zA-Z0-9\-._~]/n.freeze
    private_constant :PATH_SAFE

    # @return [String] Normalized base URL, without a trailing slash.
    attr_reader :base_url

    # @param base_url [String, nil] Base URL of the deployment. Defaults to the production API.
    # @param api_key [String, nil] API key or WorkOS access token, sent as `Authorization: Bearer <key>`.
    # @param org_id [String, nil] Default organization id, filled in for every org-scoped call.
    # @param headers [Hash{String => String}] Headers merged into every request. Per-call headers win.
    # @param timeout [Numeric, nil] Read timeout in seconds. Net::HTTP's default when nil.
    # @param open_timeout [Numeric, nil] Connect timeout in seconds.
    # @param http_handler [#call, nil] Replaces the network call entirely. Receives
    #   `(URI, Net::HTTPRequest)` and must return something that answers `code`,
    #   `body` and `[]`. This is the seam for tests and for routing through a
    #   pre-configured connection pool.
    def initialize(base_url: nil, api_key: nil, org_id: nil, headers: {}, timeout: nil,
                   open_timeout: nil, http_handler: nil)
      @base_url = (base_url || DEFAULT_BASE_URL).sub(%r{/+\z}, "")
      @api_key = api_key
      @defaults = SCOPE_PARAM.nil? ? {} : { SCOPE_PARAM => org_id }
      @headers = headers.transform_keys(&:to_s)
      @timeout = timeout
      @open_timeout = open_timeout
      @http_handler = http_handler
    end

    # Perform one call. The generated methods are thin wrappers around this.
    #
    # @param http_method [String] Uppercase verb.
    # @param path [String] URL template with `{param}` placeholders.
    # @param path_params [Hash{String => Object}, nil] Values for those placeholders, by wire name.
    # @param query [Hash{String => Object}, nil] Query parameters; nil values are dropped, Arrays repeat.
    # @param body [Object, nil] JSON request body. Omitted when nil.
    # @param form [Hash{String => Object}, nil] `multipart/form-data` fields. Mutually exclusive with body.
    # @param form_files [Array<String>] Which form fields are file parts rather than scalars.
    # @param accept [Symbol] `:json`, `:binary` or `:empty` — what the endpoint returns.
    # @param request_options [Hash, nil] Per-call `:headers`, `:timeout`, `:open_timeout`.
    # @return [Object, nil] Parsed JSON, raw bytes, or nil.
    # @raise [ApiError] On any non-2xx response.
    # @raise [ConfigurationError] When a path parameter has no value.
    def request(http_method:, path:, path_params: nil, query: nil, body: nil, form: nil,
                form_files: [], accept: :json, request_options: nil)
      options = request_options || {}
      url = "#{@base_url}#{resolve_path(http_method, path, path_params)}#{serialize_query(query)}"
      uri = URI.parse(url)

      request_class = METHOD_CLASSES.fetch(http_method)
      req = request_class.new(uri)
      req["accept"] = accept == :binary ? "application/octet-stream" : "application/json"
      @headers.each { |name, value| req[name] = value }
      (options[:headers] || {}).each { |name, value| req[name.to_s] = value }
      req["authorization"] = "Bearer #{@api_key}" unless @api_key.nil? || @api_key.empty?

      if form
        boundary = SecureRandom.hex(16)
        req["content-type"] = "multipart/form-data; boundary=#{boundary}"
        req.body = encode_multipart(form, form_files, boundary)
      elsif !body.nil?
        req["content-type"] = "application/json"
        req.body = JSON.generate(body)
      end

      response = perform(uri, req, options)
      status = response.code.to_i
      raise build_error(response, status, http_method, url) unless (200..299).cover?(status)

      decode(response, status, accept)
    end

    private

    def perform(uri, req, options)
      return @http_handler.call(uri, req) if @http_handler

      http = Net::HTTP.new(uri.hostname, uri.port)
      http.use_ssl = uri.scheme == "https"
      read_timeout = options.fetch(:timeout, @timeout)
      open_timeout = options.fetch(:open_timeout, @open_timeout)
      http.read_timeout = read_timeout if read_timeout
      http.open_timeout = open_timeout if open_timeout
      http.start { |connection| connection.request(req) }
    end

    # Fill `{param}` placeholders from the call, falling back to client config.
    def resolve_path(http_method, path, path_params)
      path.gsub(/\{([^}]+)\}/) do
        name = Regexp.last_match(1)
        value = path_params && path_params.key?(name) ? path_params[name] : nil
        value = @defaults[name] if value.nil?
        if value.nil? || value.to_s.empty?
          hint =
            if name == SCOPE_PARAM
              " — pass it, or set `org_id:` when constructing the client."
            else
              "."
            end
          raise ConfigurationError, "Missing path parameter \"#{name}\" for #{http_method} #{path}#{hint}"
        end
        value.to_s.b.gsub(PATH_SAFE) { |byte| format("%%%02X", byte.ord) }
      end
    end

    def serialize_query(query)
      return "" if query.nil?

      pairs = []
      query.each do |name, value|
        next if value.nil?

        if value.is_a?(Array)
          value.each { |item| pairs << [name.to_s, item.to_s] unless item.nil? }
        else
          pairs << [name.to_s, value.to_s]
        end
      end
      pairs.empty? ? "" : "?#{URI.encode_www_form(pairs)}"
    end

    def encode_multipart(fields, form_files, boundary)
      files = Array(form_files).map(&:to_s)
      parts = []
      fields.each do |name, value|
        next if value.nil?

        key = name.to_s
        if files.include?(key)
          upload = Upload.coerce(value)
          parts << +"--#{boundary}\r\n" \
                    "Content-Disposition: form-data; name=\"#{escape_part(key)}\"; " \
                    "filename=\"#{escape_part(upload.filename)}\"\r\n" \
                    "Content-Type: #{upload.content_type}\r\n\r\n"
          parts << upload.bytes
          parts << "\r\n"
        else
          # Anything that isn't a file goes over as a scalar. A Hash or Array
          # here would be ambiguous on the wire, so it is JSON-encoded rather
          # than silently stringified into `{"a"=>1}`.
          scalar = value.is_a?(Hash) || value.is_a?(Array) ? JSON.generate(value) : value.to_s
          parts << +"--#{boundary}\r\n" \
                    "Content-Disposition: form-data; name=\"#{escape_part(key)}\"\r\n\r\n"
          parts << scalar
          parts << "\r\n"
        end
      end
      parts << "--#{boundary}--\r\n"
      parts.map(&:b).join
    end

    # Per WHATWG, a quote inside a multipart field name or filename is
    # percent-escaped rather than backslash-escaped.
    def escape_part(value)
      value.to_s.gsub("\"", "%22").gsub(/[\r\n]/, "")
    end

    def decode(response, status, accept)
      return (response.body || "").b if accept == :binary
      return nil if accept == :empty || status == 204 || status == 205

      text = response.body
      return nil if text.nil? || text.empty?
      return text unless (response["content-type"] || "").include?("json")

      JSON.parse(text)
    end

    def build_error(response, status, http_method, url)
      text = response.body || ""
      body = text
      unless text.empty?
        begin
          body = JSON.parse(text)
        rescue JSON::ParserError
          # Not JSON — keep the raw text as the body.
        end
      end
      record = body.is_a?(Hash) ? body : {}
      detail = record["error"] || record["message"] || "#{status} Request failed"
      ApiError.new(
        status: status,
        message: "#{http_method} #{url} failed: #{detail}",
        code: record["code"].is_a?(String) ? record["code"] : nil,
        body: body,
        http_method: http_method,
        url: url
      )
    end
  end
end
