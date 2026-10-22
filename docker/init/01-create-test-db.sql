-- Runs once, on first boot of an empty PostgreSQL volume.
-- POSTGRES_DB already creates the application database; this adds the
-- disposable database used by integration tests (TEST_DATABASE_URL).
-- Tests DROP SCHEMA inside it, so it must never point at real data.
CREATE DATABASE pickup_counter_test;
