-- Which store the assistant's memory actually lives in: 'own' (heyflare only, the original
-- behaviour), 'mem0' (mem0 only — heyflare keeps nothing locally, every read and write goes
-- straight to the self-hosted server), or 'both' (heyflare is the store of record, mem0 kept
-- in sync — what mem0_enabled alone used to mean).
ALTER TABLE ai_settings ADD COLUMN mem0_mode TEXT NOT NULL DEFAULT 'own';
