# Testes de carga do Finax

Sobe a API, o Postgres 18 e o nginx em containers configurados para se comportarem
como a VM de produção (Oracle Cloud · 2 OCPU · 3GHz · 12GB), e joga em cima deles
uma carga de usuários reais: **cadastro de conta → cadastros padrões → leituras
padrões**, sem tocar em nada que dependa de serviço externo.

```
k6  ──HTTPS──▶  nginx  ──HTTP──▶  JVM (Spring Boot 4 · Jetty)  ──▶  PostgreSQL 18
(cores 2-15)    └───────── cores 0-1 compartilhados ──────────────────────┘
```

## Começando

```bash
cp .env.example .env
make preflight     # confere CPU, memória, TLS e a presença de ../finax-backend
make smoke         # ~1 min: valida o harness de ponta a ponta
make baseline      # carga de regime, o número que interessa
make seed          # pré-cria usuários (uma vez), pré-requisito do capacity
make capacity      # até onde a VM aguenta usuários simultâneos
```

Cada execução deixa tudo em `results/<timestamp>-<perfil>/`: `k6.log`, `summary.json`,
`stats.csv` (CPU/memória amostrados de 2 em 2s), `pg-top-queries.txt`,
`pg-table-sizes.txt`, `api.log`, `nginx-access.log`, `jvm.txt` (heap e threads no
fim da carga) e `finax.jfr` — a mesma gravação do Flight Recorder que produção
mantém, para abrir no JDK Mission Control quando o p95 não fizer sentido.

## Lendo o resultado

```bash
make open          # relatório da última execução no navegador
make report        # só regenera o HTML (RUN=results/<id> para uma execução antiga)
```

Três visões, em ordem de utilidade:

1. **`report.html`** (`scripts/report.py`) — tiles de pico de CPU/RSS, thresholds,
   latência por fluxo e as curvas de CPU e memória dos três containers no mesmo
   eixo de tempo. É o que responde "quem estava com a CPU quando o p95 subiu".
2. **`k6-report.html`** — dashboard nativo do k6, com as séries por segundo
   (p95 ao longo do tempo, VUs, taxa de erro). Durante a execução ele está ao vivo
   em <http://localhost:5665>.
3. **`finax.jfr`** — abra no [JDK Mission Control](https://adoptium.net/jmc/). É o
   nível de detalhe da JVM: pausas de GC, alocação por classe, contenção de lock,
   hot methods. Só vale a pena quando o report acusa CPU alta sem throughput.

## Como a VM é reproduzida

| Produção | Aqui | Por quê |
|---|---|---|
| 2 OCPU para nginx + JVM + Postgres, sem cgroup separando | `cpuset: 0,1` **no mesmo par de cores** para os três containers | Cota por container (`cpus:`) daria a cada processo uma fatia garantida — o oposto do que a VM é. Com cpuset compartilhado, eles disputam CPU como disputam lá |
| 12GB compartilhados | `API_MEM=4g`, `PG_MEM=5g`, `NGINX_MEM=256m` (9.25GB) | Memória, ao contrário de CPU, não dá para compartilhar dinamicamente entre containers, então cada um recebe um teto. A soma fica **abaixo** dos 12GB de propósito: o resto é a folga que a VM também precisa ter para SO e page cache. Como `mem_limit` é teto e não reserva, ser generoso com o Postgres não tira nada da JVM |
| JVM sob pm2: `-XX:+UseG1GC -XX:+UseCompactObjectHeaders -Xms2g -Xmx2g -XX:+AlwaysPreTouch -XX:MaxMetaspaceSize=384m`, heap dump e JFR | as mesmas flags, mais `-XX:ActiveProcessorCount=2` | Heap fixo com `AlwaysPreTouch` faz a JVM subir já com ~2.3GB de RSS e nunca redimensionar o heap no meio da medição — lá e aqui. `ActiveProcessorCount` é a única adição: na VM a JVM enxerga 2 cores de verdade; aqui ela contaria os 16 do host e dimensionaria threads de GC e pool de ForkJoin errado |
| nginx com TLS Let's Encrypt | nginx com certificado auto-assinado | O custo de handshake TLS é real num box de 2 cores e some se o teste rodar em HTTP |
| Hikari com 8 conexões, virtual threads, `open-in-view=false` | idem (vem do `application.properties` de produção) | O perfil `loadtest` só sobrepõe o que seria **errado** manter igual — ver `docker/api/config/` |
| nginx `worker_processes auto` (2 cores → 2 workers) | `worker_processes 2` fixo | nginx conta os cores do **host** (16), não os do cpuset |

**O que não é reproduzível:** produção roda ARM (Ampere) e aqui roda x86. Latência
absoluta não é comparável 1:1 — o que vale é a tendência, o formato da curva e onde
está o joelho.

## Serviços externos: nenhuma chamada sai da máquina

A API de produção fala com S3, SES, Hunter.io e Google. Nesta configuração todos
esses hosts apontam para `127.0.0.1` dentro do container da API (`extra_hosts` no
compose), então a conexão é **recusada na hora** em vez de pendurar uma thread até o
timeout. É seguro porque o código já trata esse caminho:

- `HunterIoService` captura a exceção e trata o e-mail como entregável;
- o envio SES morre no listener `@Async`, com `finax.email.retry.max-attempts=1`
  para não deixar threads em backoff exponencial (o padrão de produção são 4), e
  `AWS_MAX_ATTEMPTS=1` para desligar o retry interno do próprio SDK da AWS, que é
  independente do Spring Retry e faria três tentativas por cadastro.

Os cenários do k6 **não chamam** nenhum endpoint de anexo (`add-attachment`,
`get-attachment`, `save-payment-attachment`), `/user/profile-image`, `/auth/google`,
recuperação de senha, reenvio de ativação ou cancelamento de conta — são exatamente
os que existiriam para falar com S3/SES/Google.

Sobra o cadastro, que em produção chama Hunter.io (verificação) e SES (e-mail de
ativação) — e o cadastro é o começo da jornada que se quer medir. Ele roda pelo
endpoint real; só as duas saídas externas caem no buraco negro acima. **Consequência
a ter em mente:** `POST /auth/register` fica mais rápido aqui do que em produção,
onde há uma chamada HTTP externa no meio. O bcrypt, que é o custo de CPU dominante
do cadastro, é idêntico.

## A ativação sem e-mail

Login exige usuário ativo (`UserEntity.isEnabled()` devolve `active`), e ativar
significa clicar num link que chega por e-mail. Em vez de marcar `active = true` no
banco por fora — o que puliria a provisão assíncrona de categorias padrão e
`user_configs`, e deixaria o teste lendo conta vazia —, o k6 **assina o próprio
token de ativação**: é um JWT HS256 com `iss=api-finax`, `sub=<e-mail>` e claim
`purpose=ACTIVATE_ACCOUNT`, e o segredo (`JWT_SECRET`) é o mesmo que a API recebe.

Com isso `GET /login/activate-account/{id}/{token}` roda inteiro, do jeito real
(`k6/lib/jwt.js` espelha `security/TokenService.java`). Se o contrato do token mudar
lá, este arquivo é o que quebra.

## O que a carga faz

Dois cenários rodam juntos:

**`journey`** (`ramping-vus`) — cada VU é uma pessoa. Na primeira iteração ela se
cadastra, ativa, faz login e monta os cadastros padrões: 2 contas, 1 cartão de
crédito, 1 categoria própria com subcategoria e `RELEASES_PER_MONTH` lançamentos em
cada um dos últimos `HISTORY_MONTHS` meses — 50 × 3 = 150 por padrão (sem dados,
dashboard e relatório leem conjunto vazio e não medem nada). São ~155 requisições por
usuário novo, o que faz da rampa do `journey` uma carga de escrita por si só.
Nas iterações seguintes ela **usa** o app, com `WRITE_RATIO`
(15% por padrão) de escrita e o resto de leitura:

| Leitura (85%) | Peso | Escrita (15%) | Peso |
|---|---|---|---|
| Dashboard — as 6 chamadas de `/home/*` em lote | 45% | Novo lançamento | 45% |
| Fluxo de caixa do mês | 25% | Marcar como pago | 20% |
| Listas (contas, categorias, cartões, configs) | 15% | Editar lançamento | 13% |
| Relatórios por categoria/conta + drill-down | 10% | Compra parcelada (3-12x) | 8% |
| Faturas do cartão | 5% | Ajuste de saldo / fatura / conta nova | 14% |

**`signup`** (`constant-arrival-rate`) — usuários novos a uma taxa constante
(`SIGNUP_RATE`, 10/min por padrão) durante todo o teste, não só na rampa. Cada um
faz a jornada completa e cai na home.

Perfis (`make smoke|baseline|stress|soak`), definidos em `k6/profiles.js`:

| Perfil | O que faz |
|---|---|
| `smoke` | 2 VUs, 6 iterações. Valida o harness, não a capacidade |
| `baseline` | Rampa até `VUS` (40) + `SIGNUP_RATE`/min por `DURATION` (8) minutos |
| `stress` | 25 → 50 → 100 → 200 VUs, todos se cadastrando na rampa. Mede a rajada de divulgação |
| `seed` | Não mede nada: cria `SEED_USERS` usuários completos para o `capacity` usar |
| `capacity` | 100 → 200 → 400 → 800 VUs **logando** em usuários já existentes. Concorrência pura |
| `soak` | 25 VUs por 1 hora. Vazamento e bloat só aparecem no tempo |

### Concorrência máxima: `seed` + `capacity`

No `stress`, cada VU novo se cadastra e cria ~155 registros antes de começar a usar o
app — a rampa vira uma tempestade de escrita, e o número que sai responde "quantos
cadastros simultâneos aguento", não "quantos usuários simultâneos aguento". O par
`seed` + `capacity` separa as duas perguntas:

```bash
make clean         # opcional, mas o seed convive mal com sobras de execuções antigas
make seed          # ~5 min: cria seed-1@… até seed-800@…, 150 lançamentos cada
make capacity      # ~13 min: 100 → 200 → 400 → 800 VUs, cada um logando num deles
```

O `seed` é **idempotente**: ele tenta o login antes de cadastrar, então repetir só cria
o que faltar (e um `make clean` apaga tudo, obrigando a semear de novo). No `capacity`
a primeira iteração de cada VU custa 4 requisições (login + contas + cartões +
lançamentos do mês) em vez de 155, e `SEED_USERS` precisa ser ≥ o maior degrau de
`CAPACITY_STEPS` — abaixo disso, VUs passam a compartilhar o mesmo usuário e as
leituras ficam otimistas por cache.

Se nem 800 VUs dobrarem a curva, suba o teto sem editar nada:

```bash
CAPACITY_STEPS=400,800,1600,3200 make capacity
```

**Cuidado com o gerador nesse ponto:** acima de ~1000 VUs o k6 pode virar o gargalo
antes da API. O sintoma é `http_req_sending` subir junto com a latência — quando isso
acontece, o número que você está medindo é a máquina, não o Finax.

### Limites que falham a execução

```
http_req_failed                 < 2%
checks                          > 98%
http_req_duration{kind:read}    p95 < 800ms   p99 < 2s
http_req_duration{kind:write}   p95 < 1.2s
http_req_duration{kind:auth}    p95 < 4s      (bcrypt é caro de propósito)
dashboard_duration              p95 < 1.5s
onboarding_success              > 95%
```

São chutes iniciais deliberados. Rode `baseline` uma vez com a VM em paz, veja onde
os números caem e ajuste em `k6/profiles.js` — daí em diante eles viram regressão.

## Rate limiting

Desligado por padrão, nas duas camadas (`LT_RATE_LIMIT=false` e `NGINX_SITE=api.conf`).
Não é descuido: toda a carga sai de um IP só, e as zonas de produção (10r/s geral,
1r/s em `/auth` e `/login`) saturam em segundos — o teste passaria a medir o
limitador, não a API. Para exercitar a defesa:

```bash
LT_RATE_LIMIT=true NGINX_SITE=api-ratelimit.conf make baseline
```

O contador `rate_limited_429` do k6 mostra quantas respostas foram barradas.

## Depois do teste

```bash
make pg-top      # queries por tempo total (pg_stat_statements)
make pg-tables   # quantas linhas cada tabela ganhou
make stats       # CPU/memória ao vivo
make logs-api
```

`stats.csv` cruzado com `k6.log` é o que responde a pergunta útil: quando o p95
subiu, quem estava com a CPU — a JVM ou o Postgres?

Para começar do zero (banco vazio): `make clean`. Sem isso o banco acumula entre
execuções, o que é ótimo para medir degradação com volume — e péssimo para comparar
duas execuções.

## Estrutura

```
docker-compose.yml            topologia + limites de CPU/memória
docker/api/                   Dockerfile (build de ../finax-backend) + perfil loadtest
docker/nginx/                 espelho da configuração da VM, com e sem rate limit
docker/postgres/init/         pg_stat_statements
k6/main.js                    cenários journey + signup
k6/profiles.js                perfis e thresholds
k6/lib/                       config, cliente HTTP com tags, JWT de ativação, dados
k6/flows/                     onboarding, leituras, escritas
scripts/                      preflight, certificados, execução, monitoramento
```

> `test.js` da versão anterior deste repositório foi removido (apontava para um
> `/endpoint` inexistente). `increase-db-script/` continua aqui: é um gerador de
> volume em Go, útil para encher o banco antes de um teste de leitura pesada.
