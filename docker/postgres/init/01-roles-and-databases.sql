-- Runs once, when the Postgres data volume is first initialized.
-- Two roles keep the schema owner apart from the runtime user (see docs/adr/0006-schema-level-guarantees.md):
--   wagering_migrator: owns the schema and applies migrations.
--   wagering_app:      runtime DML only; table privileges are granted by the migrations.
-- Passwords are local-only test values.

CREATE ROLE wagering_migrator LOGIN PASSWORD 'migrator' CREATEDB;
CREATE ROLE wagering_app LOGIN PASSWORD 'app';

CREATE DATABASE wagering OWNER wagering_migrator;
CREATE DATABASE wagering_test OWNER wagering_migrator;
