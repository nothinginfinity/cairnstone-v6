import {
  REHYDRATION_SCHEMA,
  rehydrateRoute,
  rehydrateRoutesFromBody
} from "./context-retention.js";

function closed() {
  return {
    accepted_state_authority: false,
    storage_deleted: false,
    chain_heads_mutated: false
  };
}

function isHex40(value) {
  return typeof value === "string" && value.length === 40 && /^[0-9a-f]+$/i.test(value);
}

export function parseExactRepoSnapshot(ref) {
  if (typeof ref !== "string" || !ref.startsWith("repo:")) return null;
  const withoutPrefix = ref.slice(5);
  const ownerSeparator = withoutPrefix.indexOf("/");
  if (ownerSeparator <= 0) return null;
  const owner = withoutPrefix.slice(0, ownerSeparator);
  const repoAndRest = withoutPrefix.slice(ownerSeparator + 1);
  const snapshotSeparator = repoAndRest.indexOf("@");
  if (snapshotSeparator <= 0) return null;
  const repo = repoAndRest.slice(0, snapshotSeparator);
  const snapshotAndPath = repoAndRest.slice(snapshotSeparator + 1);
  const pathSeparator = snapshotAndPath.indexOf("/");
  if (pathSeparator <= 0) return null;
  const commit_sha = snapshotAndPath.slice(0, pathSeparator);
  const path = snapshotAndPath.slice(pathSeparator + 1);
  if (!isHex40(commit_sha) || !path) return null;
  return { owner, repo, commit_sha, path };
}

function result(extra = {}) {
  return { schema: REHYDRATION_SCHEMA, ...extra, ...closed() };
}

export async function executeRehydrate(routeOrRef, bindings = {}) {
  const route = rehydrateRoute(routeOrRef);
  if (!route.ok || route.exact !== true) return route;

  if (route.route === "repo_at_sha") {
    const parsed = parseExactRepoSnapshot(route.ref);
    if (!parsed) {
      return result({ ok: false, exact: false, error: "rehydration_unavailable", reason: "exact_repo_snapshot_unparsed", ref: route.ref });
    }
    const fetchGitHubFile = bindings.fetchGitHubFile;
    if (typeof fetchGitHubFile !== "function") {
      return result({ ok: false, exact: false, error: "rehydration_unavailable", reason: "fetch_impl_missing", ref: route.ref });
    }
    try {
      const file = await fetchGitHubFile({
        owner: parsed.owner,
        repo: parsed.repo,
        path: parsed.path,
        ref: parsed.commit_sha,
        returnContent: true
      }, bindings.env);
      const content = file?.content ?? file?.text ?? null;
      return result({
        ok: true,
        exact: true,
        snapshot: true,
        route: "repo_at_sha",
        ref: route.ref,
        commit_sha: parsed.commit_sha,
        path: parsed.path,
        content,
        content_sha256: file?.sha256 || file?.fetch?.sha256 || null,
        bytes: file?.bytes || file?.fetch?.bytes || (typeof content === "string" ? content.length : null),
        provenance: {
          owner: parsed.owner,
          repo: parsed.repo,
          path: parsed.path,
          commit_sha: parsed.commit_sha
        }
      });
    } catch (err) {
      return result({
        ok: false,
        exact: false,
        error: "rehydration_unavailable",
        reason: String(err && err.message ? err.message : err),
        ref: route.ref
      });
    }
  }

  if (route.route === "stone_expand") {
    return result({
      ok: false,
      exact: false,
      error: "rehydration_unavailable",
      reason: "read_stone_impl_missing",
      ref: route.ref
    });
  }

  if (route.route === "receipt_or_checkpoint") {
    return result({
      ok: false,
      exact: false,
      error: "rehydration_unavailable",
      reason: "receipt_lookup_not_wired",
      ref: route.ref
    });
  }

  return result({ ok: false, exact: false, error: "rehydration_unavailable", ref: route.ref });
}

export async function executeRehydrateFromBody(body = {}, bindings = {}) {
  if (!body || typeof body.actor_id !== "string" || !body.actor_id.trim()) {
    return { ok: false, error: "actor_id_required", ...closed() };
  }
  const refs = Array.isArray(body.refs) ? body.refs : [];
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const executed = await Promise.all([...refs, ...candidates].map((item) => executeRehydrate(item, bindings)));
  return { ok: true, schema: REHYDRATION_SCHEMA, execute: true, routes: executed, ...closed() };
}

export function rehydrateDispatchFromBody(body = {}, bindings = {}) {
  if (body && body.execute === true) return executeRehydrateFromBody(body, bindings);
  return rehydrateRoutesFromBody(body);
}
