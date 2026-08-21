// =============================================================
// Supabase-backed Shopify session storage
// File: /app/session-storage.server.js
//
// Implements the SessionStorage interface from
// @shopify/shopify-app-session-storage. This is the piece that makes
// multi-store auth work on serverless: access tokens live in Postgres,
// not on an ephemeral filesystem, so a cold start doesn't log every
// merchant out and re-trigger OAuth.
//
// The template ships Prisma + SQLite, which silently loses every
// session on redeploy. Do not go back to that.
// =============================================================
import { Session } from "@shopify/shopify-api";
import { db } from "./db.server";
import { log } from "./utils/log.server";

const TABLE = "shopify_sessions";

function toRow(session) {
  return {
    id: session.id,
    shop: session.shop,
    state: session.state,
    is_online: Boolean(session.isOnline),
    scope: session.scope ?? null,
    expires: session.expires ? new Date(session.expires).toISOString() : null,
    access_token: session.accessToken ?? null,
    refresh_token: session.refreshToken ?? null,
    refresh_token_expires: session.refreshTokenExpires
      ? new Date(session.refreshTokenExpires).toISOString()
      : null,
    online_access_info: session.onlineAccessInfo ?? null,
    updated_at: new Date().toISOString(),
  };
}

function toSession(row) {
  // expires / refreshTokenExpires MUST be rehydrated as Date objects —
  // as strings, session.isExpired() and isActive() misbehave silently.
  return new Session({
    id: row.id,
    shop: row.shop,
    state: row.state,
    isOnline: Boolean(row.is_online),
    scope: row.scope ?? undefined,
    expires: row.expires ? new Date(row.expires) : undefined,
    accessToken: row.access_token ?? undefined,
    refreshToken: row.refresh_token ?? undefined,
    refreshTokenExpires: row.refresh_token_expires
      ? new Date(row.refresh_token_expires)
      : undefined,
    onlineAccessInfo: row.online_access_info ?? undefined,
  });
}

export class SupabaseSessionStorage {
  async storeSession(session) {
    const { error } = await db.from(TABLE).upsert(toRow(session), { onConflict: "id" });
    if (error) {
      log.error("session.storeSession_failed", { error });
      return false;
    }
    return true;
  }

  async loadSession(id) {
    const { data, error } = await db.from(TABLE).select("*").eq("id", id).maybeSingle();
    if (error) {
      log.error("session.loadSession_failed", { error });
      return undefined;
    }
    return data ? toSession(data) : undefined;
  }

  async deleteSession(id) {
    const { error } = await db.from(TABLE).delete().eq("id", id);
    if (error) {
      log.error("session.deleteSession_failed", { error });
      return false;
    }
    return true;
  }

  async deleteSessions(ids) {
    if (!ids?.length) return true;
    const { error } = await db.from(TABLE).delete().in("id", ids);
    if (error) {
      log.error("session.deleteSessions_failed", { error });
      return false;
    }
    return true;
  }

  async findSessionsByShop(shop) {
    const { data, error } = await db.from(TABLE).select("*").eq("shop", shop);
    if (error) {
      log.error("session.findSessionsByShop_failed", { error });
      return [];
    }
    return (data || []).map(toSession);
  }
}
