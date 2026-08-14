#!/usr/bin/env bash
# Confere o que faz o resultado do teste ser confiável — ou não.
set -uo pipefail

cd "$(dirname "$0")/.."
[[ -f .env ]] && set -a && . ./.env && set +a

CPUSET_SUT="${CPUSET_SUT:-0,1}"
CPUSET_LOAD="${CPUSET_LOAD:-2-15}"
API_MEM="${API_MEM:-4g}"
PG_MEM="${PG_MEM:-5g}"
NGINX_MEM="${NGINX_MEM:-256m}"
VM_MEM_MB=12288  # a VM de produção

fail=0
warn() { echo "  AVISO: $*"; }
err()  { echo "  ERRO:  $*"; fail=1; }

echo "== Docker"
if ! docker info >/dev/null 2>&1; then
  err "docker não está acessível"
else
  echo "  ok: $(docker --version)"
fi

echo "== CPU"
HOST_CPUS=$(nproc)
count_cpuset() {
  local total=0 part
  IFS=',' read -ra parts <<<"$1"
  for part in "${parts[@]}"; do
    if [[ "$part" == *-* ]]; then
      total=$(( total + ${part#*-} - ${part%-*} + 1 ))
    else
      total=$(( total + 1 ))
    fi
  done
  echo "$total"
}
SUT_CPUS=$(count_cpuset "$CPUSET_SUT")
echo "  host=$HOST_CPUS cores | sistema sob teste=$CPUSET_SUT ($SUT_CPUS cores) | k6=$CPUSET_LOAD"
[[ "$SUT_CPUS" != "2" ]] && warn "a VM de produção tem 2 OCPU; CPUSET_SUT expõe $SUT_CPUS"
[[ "$HOST_CPUS" -lt 4 ]] && err "com menos de 4 cores o k6 disputa CPU com o alvo e o resultado não vale"

echo "== Memória"
HOST_MEM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
to_mb() { local v="${1,,}"; case "$v" in *g) echo $(( ${v%g} * 1024 ));; *m) echo "${v%m}";; *) echo $(( v / 1048576 ));; esac; }
BUDGET_MB=$(( $(to_mb "$API_MEM") + $(to_mb "$PG_MEM") + $(to_mb "$NGINX_MEM") ))
echo "  host=${HOST_MEM_MB}MB | orçamento dos containers=${BUDGET_MB}MB de ${VM_MEM_MB}MB da VM (api=$API_MEM pg=$PG_MEM nginx=$NGINX_MEM)"
if [[ "$BUDGET_MB" -gt "$VM_MEM_MB" ]]; then
  err "o orçamento passa dos ${VM_MEM_MB}MB da VM de produção — o teste teria mais memória que o alvo"
fi
if [[ "$HOST_MEM_MB" -lt "$BUDGET_MB" ]]; then
  warn "o host tem menos RAM que o orçamento dos containers."
  warn "no WSL2, aumente em %USERPROFILE%\\.wslconfig: [wsl2] memory=12GB  →  wsl --shutdown"
  warn "limite é teto, não reserva: o teste roda, mas sob pressão de memória o número deixa de valer"
fi

echo "== Arquitetura"
ARCH=$(uname -m)
echo "  host=$ARCH"
[[ "$ARCH" != aarch64 && "$ARCH" != arm64 ]] && \
  warn "produção é ARM (Ampere); aqui é $ARCH. Latência absoluta não é comparável 1:1 — compare tendências e o formato da curva"

echo "== TLS"
if [[ -f docker/nginx/tls/server.crt ]]; then
  echo "  ok: certificado presente"
else
  warn "certificado ausente — rode: make certs"
fi

echo "== Backend"
if [[ -f ../finax-backend/pom.xml ]]; then
  echo "  ok: ../finax-backend encontrado ($(grep -m1 '<version>' ../finax-backend/pom.xml | sed 's/[^0-9.A-Za-z-]//g'))"
else
  err "../finax-backend não encontrado — o build da imagem da API depende dele"
fi

echo
[[ $fail -eq 0 ]] && echo "preflight ok" || echo "preflight com erros"
exit $fail
