#!/usr/bin/env bash
# Execução completa: sobe o ambiente, dispara o k6 e recolhe tudo que explica o
# resultado (resumo, amostra de recursos, top de queries, log da API).
#
# uso: run.sh [smoke|baseline|stress|soak|seed|capacity]
set -euo pipefail

cd "$(dirname "$0")/.."

PROFILE="${1:-baseline}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$PROFILE}"
RESULTS="results/$RUN_ID"

# Sem isto o k6 (uid próprio da imagem) não escreve o summary em ./results.
export LOCAL_UID="$(id -u)" LOCAL_GID="$(id -g)"

mkdir -p "$RESULTS" results/nginx

./scripts/preflight.sh || { echo "corrija o preflight antes de rodar"; exit 1; }
./scripts/gen-certs.sh

echo "== subindo o ambiente"
docker compose up -d --build --wait

echo "== zerando estatísticas do Postgres"
docker compose exec -T postgres psql -U "${DB_USER:-finax}" -d "${DB_NAME:-finax}" \
  -c "SELECT pg_stat_statements_reset();" >/dev/null 2>&1 || true

echo "== monitorando recursos"
./scripts/monitor.sh "$RESULTS/stats.csv" 2 &
MONITOR_PID=$!
trap 'kill "$MONITOR_PID" 2>/dev/null || true' EXIT

echo "== k6 (perfil $PROFILE, run $RUN_ID) — dashboard ao vivo em http://localhost:${K6_DASHBOARD_PORT:-5665}"
set +e
PROFILE="$PROFILE" RUN_ID="$RUN_ID" docker compose run --rm -T --service-ports k6 run \
  --summary-mode full \
  --summary-export "/results/$RUN_ID/summary.json" \
  /k6/main.js 2>&1 | tee "$RESULTS/k6.log"
K6_STATUS=${PIPESTATUS[0]}
set -e

kill "$MONITOR_PID" 2>/dev/null || true

echo "== coletando evidências"
docker compose exec -T postgres psql -U "${DB_USER:-finax}" -d "${DB_NAME:-finax}" -P pager=off -c "
  SELECT calls,
         round(total_exec_time::numeric, 1) AS total_ms,
         round(mean_exec_time::numeric, 2)  AS mean_ms,
         rows,
         left(regexp_replace(query, '\s+', ' ', 'g'), 140) AS query
  FROM pg_stat_statements
  ORDER BY total_exec_time DESC
  LIMIT 25;" >"$RESULTS/pg-top-queries.txt" 2>/dev/null || true

docker compose logs --no-color --tail 2000 api >"$RESULTS/api.log" 2>&1 || true

# JFR com o processo ainda no ar (dumponexit só salvaria no shutdown) + estado do
# heap e das threads no fim da carga.
docker compose exec -T api sh -c '
  jcmd 1 JFR.dump name=finax filename=/logs/run.jfr >/dev/null 2>&1
  jcmd 1 GC.heap_info; echo; jcmd 1 Thread.print -l | head -400
' >"$RESULTS/jvm.txt" 2>&1 || true
docker compose cp api:/logs/run.jfr "$RESULTS/finax.jfr" >/dev/null 2>&1 || true
cp results/nginx/access.log "$RESULTS/nginx-access.log" 2>/dev/null || true
docker compose exec -T postgres psql -U "${DB_USER:-finax}" -d "${DB_NAME:-finax}" -P pager=off -c "
  SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 15;" \
  >"$RESULTS/pg-table-sizes.txt" 2>/dev/null || true

./scripts/report.py "$RESULTS" >/dev/null 2>&1 || true

echo
echo "resultados em $RESULTS"
echo "  relatório:      $RESULTS/report.html"
[[ -f "$RESULTS/k6-report.html" ]] && echo "  dashboard k6:   $RESULTS/k6-report.html"
[[ $K6_STATUS -eq 0 ]] && echo "thresholds: ok" || echo "thresholds: FALHARAM (saída $K6_STATUS)"
exit "$K6_STATUS"
