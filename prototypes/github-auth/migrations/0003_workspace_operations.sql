-- Retry identity and immutable Git identities only. No draft/source/image bytes.
CREATE TABLE workspace_operations (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  digest TEXT NOT NULL,
  expected_head TEXT NOT NULL,
  path_oids TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX workspace_operation_account ON workspace_operations(user_id, id);
