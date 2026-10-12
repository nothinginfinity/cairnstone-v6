// Staging-only token minting for tests and the Stage C harness. Same wire format the staging verifier accepts:
// csat_<base64url(payload)>.<base64url(HMAC-SHA256(payload))>. Requires the STAGING signing key; never a production key.
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function mintStagingToken(signingKey, payload) {
  if (typeof signingKey !== "string" || signingKey.length < 32) throw new Error("staging_signing_key_required");
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `csat_${body}.${b64url(sig)}`;
}
