-- pg_stat_statements: sem ele não há como responder, depois do teste, qual query
-- consumiu tempo total e quantas vezes rodou. `make pg-top` lê desta view.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
