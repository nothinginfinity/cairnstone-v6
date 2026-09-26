// Minimal WebAuthn (WebAuthn Level 2) helpers for Cloudflare Workers.
// ES256 / P-256 only. Stores public keys as JWK — never private keys.
// No external dependency: CBOR decode is bounded to attestation needs.

const textEncoder = new TextEncoder();

export function base64UrlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value) {
  if (typeof value !== "string" || !value) {
    throw new Error("base64url_invalid");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Bytes(data) {
  const buf = typeof data === "string" ? textEncoder.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

export function timingSafeEqualBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Minimal CBOR decoder for WebAuthn attestationObject / COSE keys.
 * Supports major types needed for packed/none attestation authData maps.
 */
export function decodeCbor(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let offset = 0;

  function readLength(ai) {
    if (ai < 24) return ai;
    if (ai === 24) {
      const v = view[offset];
      offset += 1;
      return v;
    }
    if (ai === 25) {
      const v = (view[offset] << 8) | view[offset + 1];
      offset += 2;
      return v;
    }
    if (ai === 26) {
      const v = ((view[offset] * 0x1000000) + (view[offset + 1] << 16) + (view[offset + 2] << 8) + view[offset + 3]) >>> 0;
      offset += 4;
      return v;
    }
    throw new Error("cbor_length_unsupported");
  }

  function decodeItem() {
    if (offset >= view.length) throw new Error("cbor_truncated");
    const ib = view[offset];
    offset += 1;
    const major = ib >> 5;
    const ai = ib & 0x1f;

    if (major === 0) return readLength(ai);
    if (major === 1) return -1 - readLength(ai);
    if (major === 2) {
      const len = readLength(ai);
      const slice = view.slice(offset, offset + len);
      offset += len;
      return slice;
    }
    if (major === 3) {
      const len = readLength(ai);
      const slice = view.slice(offset, offset + len);
      offset += len;
      return new TextDecoder().decode(slice);
    }
    if (major === 4) {
      const len = readLength(ai);
      const arr = [];
      for (let i = 0; i < len; i += 1) arr.push(decodeItem());
      return arr;
    }
    if (major === 5) {
      const len = readLength(ai);
      const map = new Map();
      for (let i = 0; i < len; i += 1) {
        const k = decodeItem();
        const v = decodeItem();
        map.set(k, v);
      }
      return map;
    }
    if (major === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      if (ai === 23) return undefined;
      throw new Error("cbor_simple_unsupported");
    }
    throw new Error(`cbor_major_unsupported:${major}`);
  }

  const value = decodeItem();
  return value;
}

export function parseAuthenticatorData(authData) {
  if (!(authData instanceof Uint8Array) || authData.length < 37) {
    throw new Error("authdata_too_short");
  }
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const signCount = ((authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36]) >>> 0;
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;
  const attestedCredentialData = (flags & 0x40) !== 0;
  let rest = authData.slice(37);
  let credentialId = null;
  let credentialPublicKeyCose = null;

  if (attestedCredentialData) {
    if (rest.length < 18) throw new Error("authdata_attested_truncated");
    // AAGUID (16) + credIdLen (2) + credId + COSE key
    const credIdLen = (rest[16] << 8) | rest[17];
    const credIdStart = 18;
    const credIdEnd = credIdStart + credIdLen;
    if (rest.length < credIdEnd) throw new Error("authdata_cred_id_truncated");
    credentialId = rest.slice(credIdStart, credIdEnd);
    const coseBytes = rest.slice(credIdEnd);
    credentialPublicKeyCose = decodeCbor(coseBytes);
    rest = new Uint8Array(0);
  }

  return {
    rpIdHash,
    flags,
    signCount,
    userPresent,
    userVerified,
    attestedCredentialData,
    credentialId,
    credentialPublicKeyCose
  };
}

export function coseEc2ToJwk(coseMap) {
  if (!(coseMap instanceof Map)) throw new Error("cose_not_map");
  const kty = coseMap.get(1);
  const alg = coseMap.get(3);
  const crv = coseMap.get(-1);
  const x = coseMap.get(-2);
  const y = coseMap.get(-3);
  if (kty !== 2) throw new Error("cose_kty_unsupported");
  if (alg !== -7) throw new Error("cose_alg_unsupported");
  if (crv !== 1) throw new Error("cose_crv_unsupported");
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new Error("cose_xy_invalid");
  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(x),
    y: base64UrlEncode(y),
    ext: true
  };
}

export async function importEs256PublicKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
}

export async function verifyEs256Signature(publicKey, signature, data) {
  // WebAuthn signatures are IEEE P1363 (r||s). Web Crypto ECDSA expects that form.
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    data
  );
}

export async function parseClientDataJSON(clientDataJSONBytes, {
  expectedType,
  expectedChallenge,
  expectedOrigin
}) {
  const jsonText = new TextDecoder().decode(clientDataJSONBytes);
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "client_data_json_invalid" };
  }
  if (data.type !== expectedType) {
    return { ok: false, error: "client_data_type_mismatch" };
  }
  if (typeof data.challenge !== "string" || data.challenge !== expectedChallenge) {
    return { ok: false, error: "client_data_challenge_mismatch" };
  }
  if (typeof data.origin !== "string" || data.origin !== expectedOrigin) {
    return { ok: false, error: "client_data_origin_mismatch" };
  }
  return { ok: true, clientData: data, clientDataJSONBytes };
}

export async function verifyRpIdHash(rpIdHash, rpId) {
  const expected = await sha256Bytes(rpId);
  return timingSafeEqualBytes(rpIdHash, expected);
}

/**
 * Verify a WebAuthn assertion (publicKeyCredential.get).
 */
export async function verifyAssertion({
  credentialId,
  authenticatorDataB64u,
  clientDataJSONB64u,
  signatureB64u,
  expectedChallenge,
  expectedOrigin,
  rpId,
  publicKeyJwk,
  previousSignCount
}) {
  let authData;
  let clientDataJSON;
  let signature;
  try {
    authData = base64UrlDecode(authenticatorDataB64u);
    clientDataJSON = base64UrlDecode(clientDataJSONB64u);
    signature = base64UrlDecode(signatureB64u);
  } catch {
    return { ok: false, error: "assertion_encoding_invalid" };
  }

  const client = await parseClientDataJSON(clientDataJSON, {
    expectedType: "webauthn.get",
    expectedChallenge,
    expectedOrigin
  });
  if (!client.ok) return client;

  let parsed;
  try {
    parsed = parseAuthenticatorData(authData);
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }

  if (!(await verifyRpIdHash(parsed.rpIdHash, rpId))) {
    return { ok: false, error: "rp_id_hash_mismatch" };
  }
  if (!parsed.userPresent) {
    return { ok: false, error: "user_presence_required" };
  }
  if (!parsed.userVerified) {
    return { ok: false, error: "user_verification_required" };
  }
  if (typeof previousSignCount === "number" && previousSignCount > 0 && parsed.signCount > 0
    && parsed.signCount <= previousSignCount) {
    return { ok: false, error: "sign_count_replay" };
  }

  const clientDataHash = await sha256Bytes(clientDataJSON);
  const signed = new Uint8Array(authData.length + clientDataHash.length);
  signed.set(authData, 0);
  signed.set(clientDataHash, authData.length);

  let key;
  try {
    key = await importEs256PublicKey(publicKeyJwk);
  } catch {
    return { ok: false, error: "public_key_import_failed" };
  }

  const valid = await verifyEs256Signature(key, signature, signed);
  if (!valid) return { ok: false, error: "assertion_signature_invalid" };

  return {
    ok: true,
    credential_id: credentialId,
    sign_count: parsed.signCount,
    user_verified: true,
    step_up_confirmed: true
  };
}

/**
 * Verify a WebAuthn registration (publicKeyCredential.create) and extract public key.
 */
export async function verifyRegistration({
  credentialId,
  attestationObjectB64u,
  clientDataJSONB64u,
  expectedChallenge,
  expectedOrigin,
  rpId
}) {
  let attestationObject;
  let clientDataJSON;
  try {
    attestationObject = base64UrlDecode(attestationObjectB64u);
    clientDataJSON = base64UrlDecode(clientDataJSONB64u);
  } catch {
    return { ok: false, error: "registration_encoding_invalid" };
  }

  const client = await parseClientDataJSON(clientDataJSON, {
    expectedType: "webauthn.create",
    expectedChallenge,
    expectedOrigin
  });
  if (!client.ok) return client;

  let decoded;
  try {
    decoded = decodeCbor(attestationObject);
  } catch {
    return { ok: false, error: "attestation_cbor_invalid" };
  }
  if (!(decoded instanceof Map)) return { ok: false, error: "attestation_not_map" };
  const authData = decoded.get("authData");
  if (!(authData instanceof Uint8Array)) return { ok: false, error: "attestation_authdata_missing" };

  let parsed;
  try {
    parsed = parseAuthenticatorData(authData);
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }

  if (!(await verifyRpIdHash(parsed.rpIdHash, rpId))) {
    return { ok: false, error: "rp_id_hash_mismatch" };
  }
  if (!parsed.userPresent) return { ok: false, error: "user_presence_required" };
  if (!parsed.userVerified) return { ok: false, error: "user_verification_required" };
  if (!parsed.credentialId || !parsed.credentialPublicKeyCose) {
    return { ok: false, error: "attested_credential_missing" };
  }

  const parsedCredId = base64UrlEncode(parsed.credentialId);
  if (credentialId && credentialId !== parsedCredId) {
    return { ok: false, error: "credential_id_mismatch" };
  }

  let publicKeyJwk;
  try {
    publicKeyJwk = coseEc2ToJwk(parsed.credentialPublicKeyCose);
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }

  return {
    ok: true,
    credential_id: parsedCredId,
    public_key_jwk: publicKeyJwk,
    sign_count: parsed.signCount,
    user_verified: true,
    step_up_confirmed: true
  };
}

/**
 * Test helper: build a COSE EC2 key map + CBOR-encode a none attestationObject.
 * Used only by automated tests (no live secrets).
 */
export function encodeCbor(value) {
  const chunks = [];

  function pushByte(b) {
    chunks.push(Uint8Array.of(b & 0xff));
  }

  function pushBytes(arr) {
    chunks.push(arr instanceof Uint8Array ? arr : new Uint8Array(arr));
  }

  function encodeLength(major, length) {
    if (length < 24) {
      pushByte((major << 5) | length);
    } else if (length < 256) {
      pushByte((major << 5) | 24);
      pushByte(length);
    } else if (length < 65536) {
      pushByte((major << 5) | 25);
      pushByte((length >> 8) & 0xff);
      pushByte(length & 0xff);
    } else {
      throw new Error("cbor_encode_length_unsupported");
    }
  }

  function encode(v) {
    if (v === null) {
      pushByte(0xf6);
      return;
    }
    if (typeof v === "boolean") {
      pushByte(v ? 0xf5 : 0xf4);
      return;
    }
    if (typeof v === "number" && Number.isInteger(v)) {
      if (v >= 0) encodeLength(0, v);
      else encodeLength(1, -1 - v);
      return;
    }
    if (typeof v === "string") {
      const bytes = textEncoder.encode(v);
      encodeLength(3, bytes.length);
      pushBytes(bytes);
      return;
    }
    if (v instanceof Uint8Array) {
      encodeLength(2, v.length);
      pushBytes(v);
      return;
    }
    if (Array.isArray(v)) {
      encodeLength(4, v.length);
      for (const item of v) encode(item);
      return;
    }
    if (v instanceof Map) {
      encodeLength(5, v.size);
      for (const [k, val] of v) {
        encode(k);
        encode(val);
      }
      return;
    }
    throw new Error("cbor_encode_unsupported");
  }

  encode(value);
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function buildCoseEc2Map(xBytes, yBytes) {
  const map = new Map();
  map.set(1, 2);
  map.set(3, -7);
  map.set(-1, 1);
  map.set(-2, xBytes);
  map.set(-3, yBytes);
  return map;
}

export function buildNoneAttestationObject({ rpIdHash, signCount = 0, credentialIdBytes, coseKeyMap, userVerified = true }) {
  const flags = 0x01 | (userVerified ? 0x04 : 0) | 0x40; // UP | UV | AT
  const authData = new Uint8Array(37 + 16 + 2 + credentialIdBytes.length + encodeCbor(coseKeyMap).length);
  authData.set(rpIdHash, 0);
  authData[32] = flags;
  authData[33] = (signCount >>> 24) & 0xff;
  authData[34] = (signCount >>> 16) & 0xff;
  authData[35] = (signCount >>> 8) & 0xff;
  authData[36] = signCount & 0xff;
  // AAGUID zeros
  let offset = 37 + 16;
  authData[offset] = (credentialIdBytes.length >> 8) & 0xff;
  authData[offset + 1] = credentialIdBytes.length & 0xff;
  offset += 2;
  authData.set(credentialIdBytes, offset);
  offset += credentialIdBytes.length;
  const coseBytes = encodeCbor(coseKeyMap);
  authData.set(coseBytes, offset);

  const attMap = new Map();
  attMap.set("fmt", "none");
  attMap.set("attStmt", new Map());
  attMap.set("authData", authData);
  return encodeCbor(attMap);
}
