-- Up Migration
create extension if not exists citext;
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- Down Migration
-- Extensions are shared database infrastructure and are intentionally not dropped.
