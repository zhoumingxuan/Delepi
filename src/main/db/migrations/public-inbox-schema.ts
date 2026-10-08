/** D enriches public inbox provenance without changing the accepted V2 migration. */
export const PUBLIC_INBOX_SCHEMA_SQL = `
ALTER TABLE m2_public_inbox ADD COLUMN destination_revision INTEGER;
ALTER TABLE m2_public_inbox ADD COLUMN destination_config_hash TEXT;
ALTER TABLE m2_public_inbox ADD COLUMN content_hash TEXT;
`;
