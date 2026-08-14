#!/usr/bin/env bash
# Amostra CPU/memória dos containers do sistema sob teste durante a execução.
# Sem isto, o resultado do k6 diz "ficou lento" mas não diz se o gargalo foi CPU
# da JVM, CPU do Postgres ou memória.
#
# uso: monitor.sh <arquivo-csv> [intervalo-segundos]
set -euo pipefail

OUT="${1:?informe o arquivo de saída}"
INTERVAL="${2:-2}"

echo "timestamp,container,cpu_perc,mem_usage,mem_perc,net_io,block_io,pids" >"$OUT"

while true; do
  ts=$(date +%s)
  docker stats --no-stream --format \
    "{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.NetIO}},{{.BlockIO}},{{.PIDs}}" \
    finax-loadtest-api-1 finax-loadtest-postgres-1 finax-loadtest-nginx-1 2>/dev/null |
    sed "s/^/$ts,/" |
    tr -d ' ' >>"$OUT"

  sleep "$INTERVAL"
done
