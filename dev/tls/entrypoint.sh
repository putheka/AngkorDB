#!/bin/sh
# Makes a CA, a server certificate and client certificates in /certs (a folder shared with the
# tests) the first time, then starts Postgres with TLS on. Delete the folder's files and restart
# the container to make new ones.
set -e
CERTS=/certs

if [ ! -f "$CERTS/ca.crt" ]; then
  cd "$CERTS"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 3650 \
    -subj "/CN=AngkorDB test CA" 2>/dev/null
  # The server's certificate is for `localhost` and `postgres-tls` and NOT for 127.0.0.1, so
  # a verify-full connection to the IP fails the way a wrong host name does.
  openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
  printf 'subjectAltName=DNS:localhost,DNS:postgres-tls\nextendedKeyUsage=serverAuth\n' > server.ext
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt \
    -days 3650 -extfile server.ext 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr -subj "/CN=certuser" 2>/dev/null
  printf 'extendedKeyUsage=clientAuth\n' > client.ext
  openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAserial ca.srl -out client.crt \
    -days 3650 -extfile client.ext 2>/dev/null
  # The same client key as a protected PKCS#8 key (passphrase `angkor-key`) and as an old-style
  # RSA key.
  openssl pkcs8 -topk8 -in client.key -out client-protected.key -v2 aes-256-cbc \
    -passout pass:angkor-key
  openssl rsa -in client.key -traditional -out client-rsa.key 2>/dev/null
  rm -f server.csr client.csr server.ext client.ext
  chmod 644 ca.crt server.crt client.crt client.key client-protected.key client-rsa.key
fi

# Postgres wants its key owned by it and private.
install -d -o postgres -g postgres -m 700 /var/lib/postgresql/tls
install -o postgres -g postgres -m 600 "$CERTS/server.key" /var/lib/postgresql/tls/server.key
install -o postgres -g postgres -m 644 "$CERTS/server.crt" /var/lib/postgresql/tls/server.crt
install -o postgres -g postgres -m 644 "$CERTS/ca.crt" /var/lib/postgresql/tls/ca.crt

exec docker-entrypoint.sh "$@" \
  -c ssl=on \
  -c ssl_cert_file=/var/lib/postgresql/tls/server.crt \
  -c ssl_key_file=/var/lib/postgresql/tls/server.key \
  -c ssl_ca_file=/var/lib/postgresql/tls/ca.crt \
  -c hba_file=/etc/postgresql/pg_hba_tls.conf
