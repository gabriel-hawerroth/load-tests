SHELL := /bin/bash
COMPOSE := docker compose
PSQL := $(COMPOSE) exec -T postgres psql -U $${DB_USER:-finax} -d $${DB_NAME:-finax} -P pager=off

.DEFAULT_GOAL := help

.PHONY: help preflight certs build up down clean smoke baseline stress soak seed capacity run report open logs logs-api psql pg-top pg-tables stats shell-api

help: ## Lista os alvos
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

preflight: ## Confere host, CPU, memória e certificado
	@./scripts/preflight.sh

certs: ## Gera o certificado auto-assinado do nginx
	@./scripts/gen-certs.sh

build: certs ## Constrói a imagem da API a partir de ../finax-backend
	$(COMPOSE) build

up: certs ## Sobe postgres + api + nginx e espera ficarem saudáveis
	$(COMPOSE) up -d --build --wait

down: ## Derruba o ambiente (mantém o volume do banco)
	$(COMPOSE) down

clean: ## Derruba tudo e apaga o volume do banco
	$(COMPOSE) down -v
	rm -rf results/nginx/*.log

smoke: ## ~1 min, valida o harness inteiro
	@./scripts/run.sh smoke

baseline: ## Carga de regime (padrão)
	@./scripts/run.sh baseline

stress: ## Sobe até quebrar
	@./scripts/run.sh stress

soak: ## 1 hora de carga contínua
	@./scripts/run.sh soak

seed: ## Pré-cria SEED_USERS usuários completos (pré-requisito de capacity)
	@./scripts/run.sh seed

capacity: ## Concorrência máxima: VUs logam em usuários já semeados
	@./scripts/run.sh capacity

run: baseline ## Alias de baseline

report: ## Refaz o report.html da execução mais recente (ou RUN=results/<id>)
	@./scripts/report.py "$${RUN:-$$(ls -dt results/*/ | head -1)}"

open: report ## Abre o relatório da execução mais recente no navegador
	@f="$$(ls -t results/*/report.html | head -1)"; \
	  (command -v xdg-open >/dev/null && xdg-open "$$f") \
	  || (command -v explorer.exe >/dev/null && explorer.exe "$$(wslpath -w "$$f")") \
	  || echo "abra manualmente: $$f"

logs: ## Segue o log de todos os serviços
	$(COMPOSE) logs -f

logs-api: ## Segue o log da API
	$(COMPOSE) logs -f api

psql: ## Abre um psql no banco de carga
	$(COMPOSE) exec postgres psql -U $${DB_USER:-finax} -d $${DB_NAME:-finax}

pg-top: ## Queries mais caras desde o último reset
	@$(PSQL) -c "SELECT calls, round(total_exec_time::numeric,1) AS total_ms, round(mean_exec_time::numeric,2) AS mean_ms, rows, left(regexp_replace(query,'\s+',' ','g'),120) AS query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;"

pg-tables: ## Volume de linhas por tabela
	@$(PSQL) -c "SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) AS size FROM pg_stat_user_tables ORDER BY n_live_tup DESC;"

stats: ## CPU/memória ao vivo dos containers do alvo
	docker stats finax-loadtest-api-1 finax-loadtest-postgres-1 finax-loadtest-nginx-1

shell-api: ## Shell dentro do container da API
	$(COMPOSE) exec api bash
