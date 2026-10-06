export const EVENT_JOURNAL_SCHEMA = "cairnstone-semantic-event-v1";
export const EVENT_JOURNAL_SOURCE = "journal";
export const EVENT_JOURNAL_CLASS = "semantic";
export const EVENT_JOURNAL_MAX_DETAIL_BYTES = 4096;
export const EVENT_JOURNAL_MAX_LIST = 100;
export const EVENT_JOURNAL_DEFAULT_LIST = 20;

const EVENT_TYPE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const LOD_LEVELS = new Set(["lod1", "lod2", "lod3", "lod4", "lod5"]);
const FORBIDDEN_DETAIL_KEY_RE = /(secret|token|api[_-]?key|authorization|capability|password|oauth|bearer|cookie)/i;
const CURSOR_PREFIX = "ej1.";

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false
  };
}

function fail(error, detail) {
  return { ok: false, error, detail, ...authorityClosedFields() };
}

function cleanOptionalString(value, field, maxLength = 2048) {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return fail("invalid_args", `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    return fail("invalid_args", `${field} must be 1..${maxLength} characters`);
  }
  return { ok: true, value: trimmed };
}

function normalizeIso(value, field, fallback = null) {
  const candidate = value ?? fallback;
  if (typeof candidate !== "string" || !candidate.trim()) {
    return fail("invalid_args", `${field} must be an ISO-8601 timestamp`);
  }
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    return fail("invalid_args", `${field} must be an ISO-8601 timestamp`);
  }
  return { ok: true, value: parsed.toISOString() };
}

function validateDetailObject(value, path = "detail") {
  if (value === null) return { ok: true };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const child = validateDetailObject(value[i], `${path}[${i}]`);
      if (!child.ok) return child;
    }
    return { ok: true };
  }
  if (typeof value === "object") {
    for (const [key, childValue] of Object.entries(value)) {
      if (FORBIDDEN_DETAIL_KEY_RE.test(key)) {
        return fail("secret_bearing_detail_rejected", `${path}.${key} is not allowed in the event journal`);
      }
      const child = validateDetailObject(childValue, `${path}.${key}`);
      if (!child.ok) return child;
    }
    return { ok: true };
  }
  if (["string", "number", "boolean", "undefined"].includes(typeof value)) return { ok: true };
  return fail("invalid_args", `${path} contains an unsupported value`);
}

function encodeUtf8Base64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeUtf8Base64Url(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeEventCursor(event = {}) {
  if (!event?.occurred_at || !event?.event_id) return null;
  return `${CURSOR_PREFIX}${encodeUtf8Base64Url(JSON.stringify({
    occurred_at: event.occurred_at,
    event_id: event.event_id
  }))}`;
}

export function decodeEventCursor(cursor) {
  if (typeof cursor !== "string" || !cursor.startsWith(CURSOR_PREFIX)) {
    return fail("invalid_cursor", "event journal cursor is invalid");
  }
  try {
    const parsed = JSON.parse(decodeUtf8Base64Url(cursor.slice(CURSOR_PREFIX.length)));
    const occurred = normalizeIso(parsed?.occurred_at, "cursor.occurred_at");
    if (!occurred.ok) return fail("invalid_cursor", occurred.detail);
    const eventId = cleanOptionalString(parsed?.event_id, "cursor.event_id", 160);
    if (!eventId.ok || !eventId.value) return fail("invalid_cursor", "cursor.event_id is invalid");
    return { ok: true, occurred_at: occurred.value, event_id: eventId.value };
  } catch {
    return fail("invalid_cursor", "event journal cursor is invalid");
  }
}

export function buildEventJournalRecord(input = {}, { now = () => new Date().toISOString(), randomUUID = () => crypto.randomUUID() } = {}) {
  const eventType = cleanOptionalString(input.event_type, "event_type", 160);
  if (!eventType.ok || !eventType.value || !EVENT_TYPE_RE.test(eventType.value)) {
    return fail("invalid_args", "event_type must be a namespaced lowercase semantic type");
  }

  const eventId = cleanOptionalString(input.event_id || `evt:${randomUUID()}`, "event_id", 160);
  if (!eventId.ok || !eventId.value) return eventId;

  const occurredAt = normalizeIso(input.occurred_at, "occurred_at", now());
  if (!occurredAt.ok) return occurredAt;

  const lodLevel = cleanOptionalString(input.lod_level, "lod_level", 16);
  if (!lodLevel.ok) return lodLevel;
  if (lodLevel.value && !LOD_LEVELS.has(lodLevel.value)) {
    return fail("invalid_args", "lod_level must be lod1..lod5");
  }

  const stringFields = [
    ["actor_id", 256], ["object_ref", 2048], ["subject_ref", 2048], ["chain", 300],
    ["path", 2048], ["stone_hash", 128], ["related_hash", 128], ["from_state", 128],
    ["to_state", 128], ["observed_commit_sha", 80], ["content_sha256", 128],
    ["request_correlation_id", 512], ["event_class", 64], ["source", 64]
  ];
  const values = {};
  for (const [field, maxLength] of stringFields) {
    const cleaned = cleanOptionalString(input[field], field, maxLength);
    if (!cleaned.ok) return cleaned;
    values[field] = cleaned.value;
  }

  const detail = input.detail ?? {};
  const detailValidation = validateDetailObject(detail);
  if (!detailValidation.ok) return detailValidation;

  let detailJson;
  try {
    detailJson = JSON.stringify(detail);
  } catch {
    return fail("invalid_args", "detail must be JSON serializable");
  }
  const detailBytes = new TextEncoder().encode(detailJson).byteLength;
  if (detailBytes > EVENT_JOURNAL_MAX_DETAIL_BYTES) {
    return fail("detail_too_large", `detail exceeds ${EVENT_JOURNAL_MAX_DETAIL_BYTES} UTF-8 bytes`);
  }

  return {
    ok: true,
    event: {
      schema: EVENT_JOURNAL_SCHEMA,
      event_id: eventId.value,
      event_type: eventType.value,
      event_class: values.event_class || EVENT_JOURNAL_CLASS,
      source: values.source || EVENT_JOURNAL_SOURCE,
      occurred_at: occurredAt.value,
      actor_id: values.actor_id,
      object_ref: values.object_ref,
      subject_ref: values.subject_ref,
      chain: values.chain,
      path: values.path,
      stone_hash: values.stone_hash,
      related_hash: values.related_hash,
      from_state: values.from_state,
      to_state: values.to_state,
      lod_level: lodLevel.value,
      observed_commit_sha: values.observed_commit_sha,
      content_sha256: values.content_sha256,
      request_correlation_id: values.request_correlation_id,
      detail,
      detail_json: detailJson,
      ...authorityClosedFields()
    }
  };
}

function insertSql() {
  return `INSERT INTO event_journal (
    event_id, schema, event_type, event_class, source, occurred_at,
    actor_id, object_ref, subject_ref, chain_name, path, stone_hash, related_hash,
    from_state, to_state, lod_level, observed_commit_sha, content_sha256,
    request_correlation_id, detail_json, accepted_state_authority
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`;
}

export async function appendEventJournal(db, input = {}, options = {}) {
  if (!db?.prepare) return fail("missing_d1_binding", "CAIRNSTONE_DB required");
  const built = buildEventJournalRecord(input, options);
  if (!built.ok) return built;
  const event = built.event;

  try {
    const write = await db.prepare(insertSql()).bind(
      event.event_id,
      event.schema,
      event.event_type,
      event.event_class,
      event.source,
      event.occurred_at,
      event.actor_id,
      event.object_ref,
      event.subject_ref,
      event.chain,
      event.path,
      event.stone_hash,
      event.related_hash,
      event.from_state,
      event.to_state,
      event.lod_level,
      event.observed_commit_sha,
      event.content_sha256,
      event.request_correlation_id,
      event.detail_json
    ).run();
    return { ok: true, event: publicEvent(event), write: write || null };
  } catch (error) {
    return fail("event_journal_write_failed", String(error?.message || error || "event journal write failed"));
  }
}

function publicEvent(row = {}) {
  let detail = row.detail;
  if (detail === undefined && typeof row.detail_json === "string") {
    try { detail = JSON.parse(row.detail_json); } catch { detail = {}; }
  }
  return {
    schema: row.schema || EVENT_JOURNAL_SCHEMA,
    event_id: row.event_id || null,
    event_type: row.event_type || null,
    event_class: row.event_class || EVENT_JOURNAL_CLASS,
    source: row.source || EVENT_JOURNAL_SOURCE,
    occurred_at: row.occurred_at || null,
    actor_id: row.actor_id || null,
    object_ref: row.object_ref || null,
    subject_ref: row.subject_ref || null,
    chain: row.chain ?? row.chain_name ?? null,
    path: row.path || null,
    stone_hash: row.stone_hash || null,
    related_hash: row.related_hash || null,
    from_state: row.from_state || null,
    to_state: row.to_state || null,
    lod_level: row.lod_level || null,
    observed_commit_sha: row.observed_commit_sha || null,
    content_sha256: row.content_sha256 || null,
    request_correlation_id: row.request_correlation_id || null,
    detail: detail ?? {},
    ...authorityClosedFields()
  };
}


const LOD_PAYLOAD_KEY_RE = /^(payload|content|raw|value|text|body|preview|layers)$/i;

export async function recordLodRead(db, input = {}) {
  const detail = input.detail && typeof input.detail === "object" ? input.detail : {};
  for (const key of Object.keys(detail)) {
    if (LOD_PAYLOAD_KEY_RE.test(key)) {
      return fail("lod_payload_rejected", "stone.lod.read detail must contain actor/object/lod identity only");
    }
  }
  return appendEventJournal(db, {
    event_type: "stone.lod.read",
    actor_id: input.actor_id,
    object_ref: input.stone_hash ? `stone:${input.stone_hash}` : input.object_ref,
    subject_ref: input.subject_ref,
    chain: input.chain,
    path: input.path,
    stone_hash: input.stone_hash,
    lod_level: input.lod_level,
    detail: { lod_level: input.lod_level || null }
  });
}

export async function listEventJournal(db, filters = {}) {
  if (!db?.prepare) return fail("missing_d1_binding", "CAIRNSTONE_DB required");
  const rawLimit = Number.isInteger(filters.limit) ? filters.limit : EVENT_JOURNAL_DEFAULT_LIST;
  const limit = Math.max(1, Math.min(EVENT_JOURNAL_MAX_LIST, rawLimit));
  const clauses = [];
  const args = [];

  const filterFields = [
    ["event_type", "event_type", 160], ["event_class", "event_class", 64], ["actor_id", "actor_id", 256],
    ["object_ref", "object_ref", 2048], ["chain", "chain_name", 300], ["stone_hash", "stone_hash", 128]
  ];
  for (const [inputName, column, maxLength] of filterFields) {
    const cleaned = cleanOptionalString(filters[inputName], inputName, maxLength);
    if (!cleaned.ok) return cleaned;
    if (cleaned.value) {
      clauses.push(`${column} = ?`);
      args.push(cleaned.value);
    }
  }

  if (filters.since) {
    const since = normalizeIso(filters.since, "since");
    if (!since.ok) return since;
    clauses.push("occurred_at > ?");
    args.push(since.value);
  }

  if (filters.after_cursor) {
    const cursor = decodeEventCursor(filters.after_cursor);
    if (!cursor.ok) return cursor;
    clauses.push("(occurred_at < ? OR (occurred_at = ? AND event_id < ?))");
    args.push(cursor.occurred_at, cursor.occurred_at, cursor.event_id);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT event_id, schema, event_type, event_class, source, occurred_at,
    actor_id, object_ref, subject_ref, chain_name, path, stone_hash, related_hash,
    from_state, to_state, lod_level, observed_commit_sha, content_sha256,
    request_correlation_id, detail_json, accepted_state_authority
    FROM event_journal${where}
    ORDER BY occurred_at DESC, event_id DESC
    LIMIT ?`;
  args.push(limit);

  try {
    const result = await db.prepare(sql).bind(...args).all();
    const rows = Array.isArray(result?.results) ? result.results : [];
    const events = rows.map(publicEvent);
    const last = events.at(-1) || null;
    return {
      ok: true,
      schema: EVENT_JOURNAL_SCHEMA,
      events,
      total: events.length,
      next_cursor: rows.length === limit && last ? encodeEventCursor(last) : null,
      ...authorityClosedFields()
    };
  } catch (error) {
    return fail("event_journal_read_failed", String(error?.message || error || "event journal read failed"));
  }
}
