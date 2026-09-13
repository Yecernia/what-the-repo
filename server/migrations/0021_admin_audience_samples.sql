BEGIN;
CREATE TABLE admin_audience_samples (
  minute timestamptz PRIMARY KEY,
  observed_at timestamptz NOT NULL,
  github integer NOT NULL CHECK (github >= 0),
  guest integer NOT NULL CHECK (guest >= 0),
  online_github integer NOT NULL CHECK (online_github >= 0),
  online_guest integer NOT NULL CHECK (online_guest >= 0)
);
INSERT INTO schema_migrations(version) VALUES ('0021_admin_audience_samples');
COMMIT;
