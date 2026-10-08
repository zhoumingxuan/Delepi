/** C adds file identities without rewriting the accepted V2 SQL or its receipts. */
export const BROKER_STORAGE_SCHEMA_SQL = `
CREATE TABLE m2_public_file_identity (
 resource_id TEXT PRIMARY KEY,
 file_dev INTEGER NOT NULL CHECK(file_dev>=0), file_ino INTEGER NOT NULL CHECK(file_ino>=0),
 parent_dev INTEGER NOT NULL CHECK(parent_dev>=0), parent_ino INTEGER NOT NULL CHECK(parent_ino>=0),
 created_at TEXT NOT NULL
);
CREATE TABLE m2_public_write_journal (
 operation_id TEXT PRIMARY KEY,resource_ref TEXT NOT NULL,target_path TEXT NOT NULL UNIQUE,
 expected_hash TEXT NOT NULL,size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
 state TEXT NOT NULL CHECK(state IN ('intent','written','registered','review_required')),
 file_dev INTEGER,file_ino INTEGER,parent_dev INTEGER,parent_ino INTEGER,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
`;
