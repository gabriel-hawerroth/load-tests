#!/usr/bin/env bash
# Certificado auto-assinado para o nginx do ambiente de carga.
# Produção termina TLS no nginx; rodar o teste em HTTP puro tiraria da conta o
# custo de handshake e o cookie Secure pararia de ser aceito pelo k6.
set -euo pipefail

cd "$(dirname "$0")/.."
TLS_DIR="docker/nginx/tls"

if [[ -f "$TLS_DIR/server.crt" && -f "$TLS_DIR/server.key" ]]; then
  echo "certificado já existe em $TLS_DIR (apague para regerar)"
  exit 0
fi

mkdir -p "$TLS_DIR"

SUBJ="/C=BR/ST=SC/L=Loadtest/O=Finax/CN=nginx"
ALT="subjectAltName=DNS:nginx,DNS:localhost,IP:127.0.0.1"

if command -v openssl >/dev/null 2>&1; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.crt" \
    -subj "$SUBJ" -addext "$ALT" 2>/dev/null
else
  docker run --rm -v "$PWD/$TLS_DIR:/tls" alpine/openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout /tls/server.key -out /tls/server.crt -subj "$SUBJ" -addext "$ALT"
fi

chmod 644 "$TLS_DIR/server.crt" "$TLS_DIR/server.key"
echo "certificado gerado em $TLS_DIR"
