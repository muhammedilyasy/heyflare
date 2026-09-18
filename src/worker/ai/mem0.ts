// mem0 integration: a self-hosted mem0 server (github.com/mem0ai/mem0, server/main.py — the OSS
// server, not the hosted platform: no `/v1/` prefix, auth via `X-API-Key`) as an alternative or
// companion store for the assistant's memory. Three modes, held per user in ai_settings.mem0_mode:
//   own  — heyflare's own table only (the original behaviour, and the default).
//   both — heyflare is the store of record; every add/edit/delete also pushes to mem0, and a
//          periodic reconcile pulls in anything new from there. See reconcileUser below.
//   mem0 — heyflare keeps nothing: every read and write goes straight to mem0. The functions
//          suffixed *Direct implement this; ai/memory.ts's public functions are the only caller.
//
// mem0 scopes everything by `user_id`, and that server is often shared with other tools that
// already use their own identifier there (a plain username, an agent id) rather than heyflare's
// internal account id. `ai_settings.mem0_user_id` lets someone point heyflare at that same
// identifier instead of its own, so it reads and writes into the one shared scope; left blank, it
// falls back to the heyflare account's own id. Every function below that actually talks to mem0
// takes this resolved id from `Mem0Config.externalUserId` — never the heyflare account id directly.
//
// heyflare's memory is small, curated, one-sentence facts. mem0's `POST /memories` instead takes a
// `messages` array and runs its own extraction LLM over it to decide what, if anything, to keep —
// so every push here sends `infer: false` to store the sentence as given rather than have it
// re-summarised (or silently dropped as "not memorable"). In `both` mode, every entry heyflare
// creates on mem0 also carries `metadata.source = "heyflare"` and `metadata.heyflare_id`, which is
// how a pull tells "one of ours, already mirrored" apart from "created directly on mem0, needs
// importing" — without that tag a two-way sync would re-import its own pushes every cycle. `mem0`
// mode has no local mirror to protect, so its own writes only tag `metadata.kind`.
import type { Env } from "../env";
import { getSessionSecret } from "../secrets";
import { decryptSecret } from "./crypto";
import { loadAiSettings } from "./provider";
import { uid } from "../db";
import type { MemoryRow, MemoryKind } from "./memory";

const KNOWN_KINDS = new Set(["profile", "tone", "fact", "preference", "contact"]);
const asKind = (k: unknown): MemoryKind => (typeof k === "string" && KNOWN_KINDS.has(k) ? (k as MemoryKind) : "fact");

export type Mem0Mode = "own" | "mem0" | "both";

export interface Mem0Config {
  baseUrl: string;
  apiKey: string;
  /** The user_id heyflare scopes mem0 calls under — the account's own id unless overridden. */
  externalUserId: string;
}

export interface Mem0State {
  mode: Mem0Mode;
  cfg: Mem0Config | null;
}

/** Reads ai_settings once and resolves the mode, the decrypted config, and the effective external user id. */
export async function loadMem0State(env: Env, userId: string): Promise<Mem0State> {
  const row = await loadAiSettings(env, userId);
  const mode: Mem0Mode = row?.mem0_mode === "mem0" || row?.mem0_mode === "both" ? row.mem0_mode : "own";
  if (mode === "own" || !row?.mem0_base_url) return { mode: "own", cfg: null };
  const apiKey = row.mem0_api_key_enc ? await decryptSecret(await getSessionSecret(env), row.mem0_api_key_enc) : "";
  const externalUserId = row.mem0_user_id?.trim() || userId;
  return { mode, cfg: { baseUrl: row.mem0_base_url.replace(/\/+$/, ""), apiKey, externalUserId } };
}

/** Whether mem0 is reachably configured at all, regardless of which mode. For "Test connection". */
export async function loadMem0Config(env: Env, userId: string): Promise<Mem0Config | null> {
  return (await loadMem0State(env, userId)).cfg;
}

interface Mem0Memory {
  id: string;
  memory?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

async function mem0Fetch<T>(cfg: Mem0Config, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}), ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`mem0_http_${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function mem0Push(cfg: Mem0Config, entry: { id?: string; kind: string; content: string }): Promise<string | null> {
  const res = await mem0Fetch<{ results?: { id: string }[] }>(cfg, "/memories", {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: entry.content }],
      user_id: cfg.externalUserId,
      infer: false,
      metadata: entry.id ? { source: "heyflare", heyflare_id: entry.id, kind: entry.kind } : { kind: entry.kind },
    }),
  });
  return res.results?.[0]?.id ?? null;
}

async function mem0Get(cfg: Mem0Config, mem0Id: string): Promise<Mem0Memory> {
  return mem0Fetch<Mem0Memory>(cfg, `/memories/${encodeURIComponent(mem0Id)}`);
}

async function mem0Update(cfg: Mem0Config, mem0Id: string, content: string): Promise<void> {
  await mem0Fetch(cfg, `/memories/${encodeURIComponent(mem0Id)}`, { method: "PUT", body: JSON.stringify({ text: content }) });
}

async function mem0Delete(cfg: Mem0Config, mem0Id: string): Promise<void> {
  await mem0Fetch(cfg, `/memories/${encodeURIComponent(mem0Id)}`, { method: "DELETE" });
}

async function mem0List(cfg: Mem0Config): Promise<Mem0Memory[]> {
  const res = await mem0Fetch<{ results?: Mem0Memory[] } | Mem0Memory[]>(cfg, `/memories?user_id=${encodeURIComponent(cfg.externalUserId)}`);
  return Array.isArray(res) ? res : (res.results ?? []);
}

/** `Settings → AI → Test connection`. Throws with a readable reason on failure. */
export async function mem0Test(cfg: Mem0Config): Promise<void> {
  await mem0List(cfg);
}

/* ---------- mode: "mem0" — heyflare stores nothing, every call goes straight through ---------- */

export async function mem0ListAsRows(cfg: Mem0Config, userId: string): Promise<MemoryRow[]> {
  const remote = await mem0List(cfg);
  const rows = remote
    .filter((r) => r.memory?.trim())
    .map((r): MemoryRow => {
      const meta = (typeof r.metadata === "object" && r.metadata) || {};
      const t = r.updated_at ? Date.parse(r.updated_at) : Date.now();
      return {
        id: r.id,
        user_id: userId,
        kind: asKind((meta as Record<string, unknown>).kind),
        content: r.memory!.trim(),
        source: "mem0",
        mem0_id: r.id,
        mem0_synced_at: Date.now(),
        created_at: r.created_at ? Date.parse(r.created_at) : t,
        updated_at: t,
      };
    });
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || b.updated_at - a.updated_at);
}

export async function mem0AddDirect(cfg: Mem0Config, userId: string, kind: MemoryKind, content: string): Promise<MemoryRow> {
  const trimmed = content.trim().slice(0, 600);
  const id = await mem0Push(cfg, { kind, content: trimmed });
  if (!id) throw new Error("mem0_add_failed: the server accepted the request but returned no memory");
  const t = Date.now();
  return { id, user_id: userId, kind, content: trimmed, source: "mem0", mem0_id: id, mem0_synced_at: t, created_at: t, updated_at: t };
}

export async function mem0UpdateDirect(cfg: Mem0Config, userId: string, id: string, patch: { kind?: MemoryKind; content?: string }): Promise<MemoryRow> {
  const cur = await mem0Get(cfg, id);
  const meta = (typeof cur.metadata === "object" && cur.metadata) || {};
  const kind = patch.kind ?? asKind((meta as Record<string, unknown>).kind);
  const content = typeof patch.content === "string" ? patch.content.trim().slice(0, 600) : (cur.memory ?? "").trim();
  const body: Record<string, unknown> = {};
  if (typeof patch.content === "string") body.text = content;
  if (patch.kind) body.metadata = { ...meta, kind };
  if (Object.keys(body).length) await mem0Fetch(cfg, `/memories/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });
  const t = Date.now();
  return { id, user_id: userId, kind, content, source: "mem0", mem0_id: id, mem0_synced_at: t, created_at: cur.created_at ? Date.parse(cur.created_at) : t, updated_at: t };
}

export async function mem0DeleteDirect(cfg: Mem0Config, id: string): Promise<boolean> {
  try {
    await mem0Delete(cfg, id);
    return true;
  } catch (e) {
    console.error("mem0 delete failed", (e as Error).message);
    return false;
  }
}

export async function mem0DeleteAllDirect(cfg: Mem0Config): Promise<void> {
  await mem0Fetch(cfg, `/memories?user_id=${encodeURIComponent(cfg.externalUserId)}`, { method: "DELETE" });
}

/* ---------- mode transitions: moving existing memory when the mode, or the mem0 user id, changes ---------- */

/**
 * Entering "mem0" mode from "own"/"both": push anything not already linked, then empty the local
 * table — it must hold nothing once this mode is active. Only rows that are confirmed on mem0
 * (already linked, or just pushed successfully) are deleted; a row whose push fails or silently
 * comes back with no id stays local rather than being lost, and counts toward `failed` so the
 * caller can say so instead of the switch looking clean when it wasn't.
 */
export async function migrateToMem0Only(env: Env, userId: string, cfg: Mem0Config): Promise<{ moved: number; failed: number }> {
  const rows = await env.DB.prepare(`SELECT id, kind, content, mem0_id FROM ai_memory WHERE user_id = ?`).bind(userId).all<{ id: string; kind: string; content: string; mem0_id: string | null }>();
  const toDelete: string[] = [];
  let failed = 0;
  for (const row of rows.results) {
    if (row.mem0_id) {
      toDelete.push(row.id);
      continue;
    }
    try {
      const mem0Id = await mem0Push(cfg, row);
      if (mem0Id) toDelete.push(row.id);
      else failed++;
    } catch (e) {
      console.error("mem0 migrate push failed", (e as Error).message);
      failed++;
    }
  }
  if (toDelete.length) {
    await env.DB.prepare(`DELETE FROM ai_memory WHERE user_id = ? AND id IN (${toDelete.map(() => "?").join(",")})`).bind(userId, ...toDelete).run();
  }
  return { moved: toDelete.length, failed };
}

/** Leaving "mem0" mode for "own"/"both": copy mem0's current memories into local rows so nothing that lived only there is lost. */
export async function importFromMem0(env: Env, userId: string, cfg: Mem0Config): Promise<void> {
  const remote = await mem0List(cfg);
  for (const r of remote) {
    if (!r.memory?.trim()) continue;
    const meta = (typeof r.metadata === "object" && r.metadata) || {};
    const t = Date.now();
    await env.DB.prepare(`INSERT INTO ai_memory (id, user_id, kind, content, source, mem0_id, mem0_synced_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'mem0', ?, ?, ?, ?)`)
      .bind(uid(), userId, asKind((meta as Record<string, unknown>).kind), r.memory.trim().slice(0, 600), r.id, t, t, t)
      .run();
  }
}

/**
 * The mem0 user id itself changed (e.g. from heyflare's own account id to a shared identifier used
 * by other tools on the same server): mem0 has no "rename" — the only way to move a memory to a
 * different user_id is to recreate it there and drop the old copy. Only touches entries tagged
 * `source: "heyflare"` under the *old* id; anything already sitting under the new id (other tools'
 * memories, including whatever prompted the switch) is left exactly as it is.
 */
export async function changeMem0ExternalUserId(cfg: Mem0Config, oldExternalUserId: string): Promise<{ moved: number; failed: number }> {
  if (oldExternalUserId === cfg.externalUserId) return { moved: 0, failed: 0 };
  const remote = await mem0List({ ...cfg, externalUserId: oldExternalUserId });
  let moved = 0, failed = 0;
  for (const r of remote) {
    const meta = (typeof r.metadata === "object" && r.metadata) || {};
    if ((meta as Record<string, unknown>).source !== "heyflare" || !r.memory?.trim()) continue;
    try {
      const newId = await mem0Push(cfg, { id: (meta as Record<string, unknown>).heyflare_id as string | undefined, kind: asKind((meta as Record<string, unknown>).kind), content: r.memory });
      if (!newId) {
        failed++;
        continue;
      }
      await mem0Delete({ ...cfg, externalUserId: oldExternalUserId }, r.id);
      moved++;
    } catch (e) {
      console.error("mem0 rescope failed", (e as Error).message);
      failed++;
    }
  }
  return { moved, failed };
}

/* ---------- mode: "both" — best-effort hooks called from ai/memory.ts's CRUD ---------- */
// Every one of these swallows its own errors: a self-hosted mem0 instance being down, misconfigured
// or unreachable must never break heyflare's own memory feature. Failures are logged and picked up
// again by the next periodic reconcile, which re-pushes anything still unlinked.

export async function syncPush(cfg: Mem0Config, entry: { id: string; kind: string; content: string }): Promise<{ mem0_id: string; mem0_synced_at: number } | null> {
  try {
    const mem0_id = await mem0Push(cfg, entry);
    return mem0_id ? { mem0_id, mem0_synced_at: Date.now() } : null;
  } catch (e) {
    console.error("mem0 push failed", (e as Error).message);
    return null;
  }
}

export async function syncUpdate(cfg: Mem0Config, mem0Id: string, content: string): Promise<number | null> {
  try {
    await mem0Update(cfg, mem0Id, content);
    return Date.now();
  } catch (e) {
    console.error("mem0 update failed", (e as Error).message);
    return null;
  }
}

export async function syncDelete(cfg: Mem0Config, mem0Id: string): Promise<void> {
  try {
    await mem0Delete(cfg, mem0Id);
  } catch (e) {
    console.error("mem0 delete failed", (e as Error).message);
  }
}

/* ---------- "both" mode reconcile: catches everything the event-driven hooks above can't see ---------- */
// New heyflare rows from before mem0 was connected, an edit that happened while mem0 was
// unreachable, a memory added or edited directly on mem0 itself. Called on demand (Settings' "Sync
// now") and every `runMem0Sync` cron tick for everyone in "both" mode.

const MAX_ENTRIES = 80;

export async function reconcileUser(env: Env, userId: string): Promise<{ pushed: number; pulled: number; updated: number; removed: number } | null> {
  const { mode, cfg } = await loadMem0State(env, userId);
  if (mode !== "both" || !cfg) return null;
  const db = env.DB;
  let pushed = 0, pulled = 0, updated = 0, removed = 0;

  // 1. Local rows never sent to mem0 — new since it was connected, or a push that failed earlier.
  const unlinked = await db.prepare(`SELECT id, kind, content FROM ai_memory WHERE user_id = ? AND mem0_id IS NULL`).bind(userId).all<{ id: string; kind: string; content: string }>();
  for (const row of unlinked.results) {
    const r = await syncPush(cfg, row);
    if (r) {
      await db.prepare(`UPDATE ai_memory SET mem0_id = ?, mem0_synced_at = ? WHERE id = ?`).bind(r.mem0_id, r.mem0_synced_at, row.id).run();
      pushed++;
    }
  }

  // 2. mem0's current state for this user.
  const remote = await mem0List(cfg);
  const remoteIds = new Set(remote.map((r) => r.id));
  const local = await db
    .prepare(`SELECT id, content, mem0_id, mem0_synced_at FROM ai_memory WHERE user_id = ? AND mem0_id IS NOT NULL`)
    .bind(userId)
    .all<{ id: string; content: string; mem0_id: string; mem0_synced_at: number | null }>();
  const byMem0Id = new Map(local.results.map((r) => [r.mem0_id, r]));

  for (const r of remote) {
    const linked = byMem0Id.get(r.id);
    if (linked) {
      const remoteUpdated = r.updated_at ? Date.parse(r.updated_at) : 0;
      const content = (r.memory ?? "").trim();
      if (content && remoteUpdated && remoteUpdated > (linked.mem0_synced_at ?? 0) && content !== linked.content) {
        await db.prepare(`UPDATE ai_memory SET content = ?, mem0_synced_at = ?, updated_at = ? WHERE id = ?`).bind(content.slice(0, 600), Date.now(), Date.now(), linked.id).run();
        updated++;
      }
      continue;
    }
    const ours = typeof r.metadata === "object" && r.metadata !== null && (r.metadata as Record<string, unknown>).source === "heyflare";
    // Tagged as heyflare's own but no local row references it: it was deleted locally, and the
    // delete hook's own mem0Delete call either already removed it or is about to — not something to import.
    if (ours || !r.memory?.trim()) continue;
    const id = uid();
    const t = Date.now();
    await db
      .prepare(`INSERT INTO ai_memory (id, user_id, kind, content, source, mem0_id, mem0_synced_at, created_at, updated_at) VALUES (?, ?, 'fact', ?, 'mem0', ?, ?, ?, ?)`)
      .bind(id, userId, r.memory.trim().slice(0, 600), r.id, t, t, t)
      .run();
    pulled++;
  }

  // 3. Local rows linked to a mem0 memory that is simply gone now (deleted on mem0's side directly).
  for (const row of local.results) {
    if (!remoteIds.has(row.mem0_id)) {
      await db.prepare(`DELETE FROM ai_memory WHERE id = ?`).bind(row.id).run();
      removed++;
    }
  }

  // Keep the same cap listMemory's own trim enforces, oldest-and-not-ours first.
  await db
    .prepare(
      `DELETE FROM ai_memory WHERE user_id = ? AND id IN (
         SELECT id FROM ai_memory WHERE user_id = ? ORDER BY CASE source WHEN 'mem0' THEN 0 ELSE 1 END, updated_at ASC
         LIMIT MAX(0, (SELECT COUNT(*) FROM ai_memory WHERE user_id = ?) - ?)
       )`
    )
    .bind(userId, userId, userId, MAX_ENTRIES)
    .run();

  await db.prepare(`UPDATE ai_settings SET mem0_last_synced_at = ? WHERE user_id = ?`).bind(Date.now(), userId).run();
  return { pushed, pulled, updated, removed };
}

const SYNC_EVERY_MS = 10 * 60_000;

/** Cron entry: reconcile everyone in "both" mode, at most every 10 minutes each. */
export async function runMem0Sync(env: Env): Promise<void> {
  const users = await env.DB.prepare(`SELECT user_id FROM ai_settings WHERE mem0_mode = 'both' AND mem0_base_url <> '' AND COALESCE(mem0_last_synced_at, 0) < ?`)
    .bind(Date.now() - SYNC_EVERY_MS)
    .all<{ user_id: string }>();
  for (const { user_id } of users.results) {
    try {
      await reconcileUser(env, user_id);
    } catch (e) {
      console.error("mem0 reconcile failed", user_id, (e as Error).message);
    }
  }
}
