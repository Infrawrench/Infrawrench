-- pgcrypto's digest, hmac and gen_random_bytes, with its signatures and its
-- results, for the algorithms PostgreSQL has built in (md5, sha224, sha256,
-- sha384, sha512). Everything else of pgcrypto (crypt, gen_salt, sha1, the
-- PGP and raw encryption functions) is missing, so a call to it fails as an
-- undefined function rather than doing something else.

\echo Use "CREATE EXTENSION pgcrypto" to load this file. \quit

CREATE FUNCTION @extschema@.digest(bytea, text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN
  CASE lower($2)
    WHEN 'md5' THEN RETURN decode(md5($1), 'hex');
    WHEN 'sha224' THEN RETURN sha224($1);
    WHEN 'sha256' THEN RETURN sha256($1);
    WHEN 'sha384' THEN RETURN sha384($1);
    WHEN 'sha512' THEN RETURN sha512($1);
    ELSE RAISE EXCEPTION 'Cannot use "%": No such hash algorithm', $2
      USING HINT = 'pglite-server''s pgcrypto has md5, sha224, sha256, sha384 and sha512.';
  END CASE;
END
$$;

CREATE FUNCTION @extschema@.digest(text, text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN @extschema@.digest(textsend($1), $2);

-- RFC 2104: H((K ^ opad) || H((K ^ ipad) || message)), K the key, or its
-- hash when longer than the block, padded with zeros to the block.
CREATE FUNCTION @extschema@.hmac(bytea, bytea, text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  block int := CASE WHEN lower($3) IN ('sha384', 'sha512') THEN 128 ELSE 64 END;
  key bytea := $2;
  inner_pad bytea;
  outer_pad bytea;
BEGIN
  IF length(key) > block THEN
    key := @extschema@.digest(key, $3);
  END IF;
  key := key || decode(repeat('00', block - length(key)), 'hex');
  inner_pad := key;
  outer_pad := key;
  FOR i IN 0 .. block - 1 LOOP
    inner_pad := set_byte(inner_pad, i, get_byte(key, i) # 54);
    outer_pad := set_byte(outer_pad, i, get_byte(key, i) # 92);
  END LOOP;
  RETURN @extschema@.digest(outer_pad || @extschema@.digest(inner_pad || $1, $3), $3);
END
$$;

CREATE FUNCTION @extschema@.hmac(text, text, text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN @extschema@.hmac(textsend($1), textsend($2), $3);

-- From gen_random_uuid's strong randomness (122 bits a UUID), hashed.
CREATE FUNCTION @extschema@.gen_random_bytes(integer) RETURNS bytea
LANGUAGE plpgsql VOLATILE STRICT PARALLEL SAFE AS $$
DECLARE
  bytes bytea := ''::bytea;
BEGIN
  IF $1 < 1 OR $1 > 1024 THEN
    RAISE EXCEPTION 'Length not in range';
  END IF;
  WHILE length(bytes) < $1 LOOP
    bytes := bytes || sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()));
  END LOOP;
  RETURN substring(bytes FROM 1 FOR $1);
END
$$;
