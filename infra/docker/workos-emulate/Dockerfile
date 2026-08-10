# WorkOS emulator (github.com/workos/emulate) for local dev — there is no
# official image, so wrap the npm package. State is in-memory: every restart
# re-seeds from seed.yaml and invalidates existing sessions (you just log in
# again).
FROM node:22-alpine

RUN npm install -g "@workos/emulate@^0.5.0"

COPY seed.yaml /etc/workos-emulate/seed.yaml

# Signing key generated at BUILD time, so it is stable across container
# restarts (a fresh key per start would strand the web process: the WorkOS
# SDK caches the JWKS per client instance and keeps rejecting every session
# until web itself restarts). Image rebuilds rotate it, which just means
# logging in again. Deliberately not a committed PEM.
RUN node -e "const{generateKeyPairSync}=require('crypto');const{privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});require('fs').writeFileSync('/etc/workos-emulate/signing-key.pem',privateKey.export({type:'pkcs8',format:'pem'}))"

# --host 0.0.0.0 because the emulator binds localhost by default, which would
# be unreachable even from the web container's shared network namespace's
# published port. --interactive serves real login pages so the browser flow
# works end to end.
CMD ["workos-emulate", "--host", "0.0.0.0", "--port", "4100", "--interactive", "--seed", "/etc/workos-emulate/seed.yaml", "--signing-key", "/etc/workos-emulate/signing-key.pem", "--kid", "dev_key", "--json"]
