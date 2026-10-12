// S1-3 staging-only durable authorization store adapter (issue #94). DORMANT until bound to a staging D1.
// Backed by migrations/staging-auth/0001_staging_auth.sql. NEVER bound to production or the private realm D1.
//
// checkAuth() is the only question the verifier asks, and it answers `true` only when EVERY condition holds:
//   the token family row exists, is not revoked, belongs to the stated connection AND account, and the connection row
//   exists, is 'active' and belongs to the same account. Missing / unknown / inactive / revoked / mismatched / malformed
//   input, and ANY query error (missing table, D1 outage, malformed row) answer `false`. There is no permissive path.
import { PrivateRealmError } from "../private-realm/scope.js";

export const STAGING_AUTH_SCHEMA_VERSION = 1;
const ID = /^[A-Za-z0-9_-]{5,80}$/;
const FAMILY_SQL =
  "SELECT f.revoked AS revoked, f.account_id AS family_account, f.connection_id AS family_connection, " +
  "c.status AS connection_status, c.account_id AS connection_account " +
  "FROM staging_token_families f JOIN staging_connections c ON c.connection_id = f.connection_id " +
  "WHERE f.token_family_id = ?1";
const CONNECTION_SQL = "SELECT status FROM staging_connections WHERE connection_id = ?1";

export function createD1StagingAuthStore(db) {
  if (!db || typeof db.prepare !== "function") throw new PrivateRealmError("trusted_gateway_dependencies_required");

  async function checkAuth(input) {
    try {
      const { tokenFamilyId, connectionId, accountId } = input ?? {};
      if (![tokenFamilyId, connectionId, accountId].every((v) => typeof v === "string" && ID.test(v))) return false;
      const row = await db.prepare(FAMILY_SQL).bind(tokenFamilyId).first();
      if (!row) return false;
      return Number(row.revoked) === 0 && row.revoked !== null && row.revoked !== undefined &&
        row.connection_status === "active" &&
        row.family_account === accountId && row.connection_account === accountId &&
        row.family_connection === connectionId;
    } catch {
      return false;
    }
  }

  // Convenience reads, same fail-closed rules (unknown family reads as revoked; unknown connection reads as inactive).
  async function isRevoked(tokenFamilyId) {
    try {
      if (typeof tokenFamilyId !== "string" || !ID.test(tokenFamilyId)) return true;
      const row = await db.prepare("SELECT revoked FROM staging_token_families WHERE token_family_id = ?1").bind(tokenFamilyId).first();
      return !(row && Number(row.revoked) === 0);
    } catch {
      return true;
    }
  }
  async function connectionActive(connectionId) {
    try {
      if (typeof connectionId !== "string" || !ID.test(connectionId)) return false;
      const row = await db.prepare(CONNECTION_SQL).bind(connectionId).first();
      return row?.status === "active";
    } catch {
      return false;
    }
  }
  // True only when the expected schema version row is present. Used by preflight/readiness, never to grant access.
  async function schemaReady() {
    try {
      const row = await db.prepare("SELECT MAX(version) AS v FROM staging_auth_schema").bind().first();
      return Number(row?.v) === STAGING_AUTH_SCHEMA_VERSION;
    } catch {
      return false;
    }
  }
  return Object.freeze({ checkAuth, isRevoked, connectionActive, schemaReady });
}
