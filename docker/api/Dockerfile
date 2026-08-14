# syntax=docker/dockerfile:1.7
#
# Imagem da API para o ambiente de carga. O contexto de build é ../finax-backend
# (ver docker-compose.yml), então os caminhos abaixo são relativos à raiz daquele repo.

FROM eclipse-temurin:26-jdk AS build

WORKDIR /src

# pom + wrapper primeiro: enquanto as dependências não mudarem, esta camada é cache.
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./
RUN --mount=type=cache,target=/root/.m2,sharing=locked \
    ./mvnw -B -ntp dependency:go-offline -DskipTests || true

COPY src/ src/

# -DskipTests: a suíte usa Testcontainers e exigiria Docker dentro do build.
# O gate de qualidade é o CI do backend, não esta imagem.
RUN --mount=type=cache,target=/root/.m2,sharing=locked \
    ./mvnw -B -ntp -DskipTests clean package

# jdk, não jre: produção grava JFR e a imagem jre não traz jcmd/jfr para extrair a
# gravação com o processo no ar. O JVM é o mesmo; só o ferramental muda.
FROM eclipse-temurin:26-jdk

# curl entra pelo healthcheck do compose (a imagem não traz nenhum cliente HTTP).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Espelha a VM: processo Java único, sem root, timezone de São Paulo.
RUN useradd --system --create-home --uid 1001 finax
ENV TZ=America/Sao_Paulo

WORKDIR /app
COPY --from=build /src/target/finax.jar /app/finax.jar
# /logs espelha /home/ubuntu/logs da VM (JFR + heap dump). Criado aqui com o dono
# certo para que o volume nomeado herde a permissão na primeira montagem.
RUN mkdir -p /logs && chown -R finax:finax /app /logs

USER finax

# JAVA_OPTS vem do compose com as mesmas flags do pm2 em produção.
ENV JAVA_OPTS=""

EXPOSE 8080

ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/finax.jar"]
