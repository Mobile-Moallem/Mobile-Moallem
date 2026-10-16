CREATE TABLE IF NOT EXISTS hymn_library_presentation (
  hymn_id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  folder_order INTEGER,
  updated_at INTEGER NOT NULL
);
