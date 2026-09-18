-- Two-way sync of assistant memory with a self-hosted mem0 server (see src/worker/ai/mem0.ts).
ALTER TABLE ai_settings ADD COLUMN mem0_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_settings ADD COLUMN mem0_base_url TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_settings ADD COLUMN mem0_api_key_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_settings ADD COLUMN mem0_key_hint TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_settings ADD COLUMN mem0_last_synced_at INTEGER;
-- `mem0_id` links a row to its mem0 memory; `mem0_synced_at` is when that link was last confirmed
-- current, so a later sync can tell which side changed since.
ALTER TABLE ai_memory ADD COLUMN mem0_id TEXT;
ALTER TABLE ai_memory ADD COLUMN mem0_synced_at INTEGER;
