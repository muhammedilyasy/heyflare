-- The identifier heyflare scopes its memories under on the mem0 server. Empty means "use the
-- heyflare account's own id" (the original behaviour); set to match another tool's identifier
-- (e.g. a plain username) to share one memory scope across everything pointed at the same server.
ALTER TABLE ai_settings ADD COLUMN mem0_user_id TEXT NOT NULL DEFAULT '';
