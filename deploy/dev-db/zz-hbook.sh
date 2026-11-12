#!/usr/bin/env bash
set -Eeuo pipefail

# Supabase initializes as supabase_admin and its own migrations need that role. Running its entrypoint
# with POSTGRES_USER=hbook fails before our database exists (#363). This hook runs after those migrations,
# only for an empty PGDATA; an existing PostgreSQL 15 volume keeps its roles, databases and configuration.
# Keep the app login's original development privileges (POSTGRES_USER=hbook would be the initdb superuser).
# psql quotes the password as a SQL literal rather than interpolating shell text into SQL.
psql -X --no-password --host /var/run/postgresql --username "$POSTGRES_USER" --dbname postgres \
  --set=ON_ERROR_STOP=1 --set=hbook_password="$POSTGRES_PASSWORD" <<'SQL'
CREATE ROLE hbook WITH LOGIN SUPERUSER PASSWORD :'hbook_password';
CREATE DATABASE hbook OWNER hbook;
SQL
