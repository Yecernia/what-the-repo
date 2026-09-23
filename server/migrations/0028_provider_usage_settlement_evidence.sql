BEGIN;

-- NULL marks legacy rows whose settlement cause was not recorded.
ALTER TABLE provider_usage_events
    ADD COLUMN settlement_evidence text
    CHECK (settlement_evidence IN ('provider_reported', 'not_started', 'explicit_rejection', 'unknown', 'lease_expired'));

INSERT INTO schema_migrations(version) VALUES ('0028_provider_usage_settlement_evidence');
COMMIT;
