import test from "node:test";
import assert from "node:assert/strict";
import {
  base64UrlEncode,
  coseEc2ToJwk,
  es256SignatureToP1363,
  sha256Bytes,
  verifyAssertion
} from "../src/webauthn.js";

function b64uToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function derInteger(bytes) {
  let value = bytes;
  let start = 0;
  while (start < value.length - 1 && value[start] === 0x00) start += 1;
  value = value.subarray(start);
  const needsPad = (value[0] & 0x80) !== 0;
  const body = new Uint8Array(value.length + (needsPad ? 1 : 0));
  if (needsPad) body[0] = 0x00;
  body.set(value, needsPad ? 1 : 0);
  return new Uint8Array([0x02, body.length, ...body]);
}

function p1363ToDer(raw) {
  if (raw.length !== 64) throw new Error("expected P1363");
  const r = derInteger(raw.subarray(0, 32));
  const s = derInteger(raw.subarray(32));
  const body = new Uint8Array(r.length + s.length);
  body.set(r, 0);
  body.set(s, r.length);
  if (body.length > 127) throw new Error("length form unexpected");
  return new Uint8Array([0x30, body.length, ...body]);
}

async function assertionFixture(signatureBytes) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const rpId = "cairnstone.test";
  const origin = "https://cairnstone.test";
  const challenge = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const clientData = new TextEncoder().encode(JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin
  }));
  const rpIdHash = await sha256Bytes(rpId);
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = 0x05;
  authData[36] = 1;
  const clientHash = await sha256Bytes(clientData);
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0);
  signed.set(clientHash, authData.length);
  const raw = signatureBytes || new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    signed
  ));
  return {
    pair,
    jwk,
    challenge,
    origin,
    rpId,
    authData,
    signed,
    raw,
    args: {
      credentialId: "cred-der",
      authenticatorDataB64u: base64UrlEncode(authData),
      clientDataJSONB64u: base64UrlEncode(clientData),
      expectedChallenge: challenge,
      expectedOrigin: origin,
      rpId,
      publicKeyJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
      previousSignCount: 0
    }
  };
}

test("real WebAuthn DER ES256 assertion signature verifies", async () => {
  const fixture = await assertionFixture();
  const der = p1363ToDer(fixture.raw);
  assert.notEqual(der.length, 64);
  assert.equal(der[0], 0x30);
  const raw = es256SignatureToP1363(der);
  assert.deepEqual(raw, fixture.raw);
  const result = await verifyAssertion({
    ...fixture.args,
    signatureB64u: base64UrlEncode(der)
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.sign_count, 1);
});

test("existing P1363 assertion signature still verifies", async () => {
  const fixture = await assertionFixture();
  const result = await verifyAssertion({
    ...fixture.args,
    signatureB64u: base64UrlEncode(fixture.raw)
  });
  assert.equal(result.ok, true, result.error);
});

test("malformed DER assertion signatures fail closed", async () => {
  const fixture = await assertionFixture();
  const der = p1363ToDer(fixture.raw);
  const cases = [
    der.subarray(0, der.length - 1),
    new Uint8Array([0x31, ...der.subarray(1)]),
    new Uint8Array([...der, 0x00]),
    new Uint8Array([0x30, 0x08, 0x02, 0x02, 0x00, 0x01, 0x02, 0x02, 0x00, 0x01]),
    new Uint8Array(70)
  ];
  for (const signature of cases) {
    assert.throws(() => es256SignatureToP1363(signature));
    const result = await verifyAssertion({
      ...fixture.args,
      signatureB64u: base64UrlEncode(signature)
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "assertion_signature_invalid");
  }
});

test("oversize DER integer fails closed before WebCrypto", () => {
  const oversize = new Uint8Array(33);
  oversize[0] = 0x01;
  const r = new Uint8Array([0x02, 33, ...oversize]);
  const s = derInteger(new Uint8Array(32).fill(1));
  const body = new Uint8Array(r.length + s.length);
  body.set(r, 0);
  body.set(s, r.length);
  const der = new Uint8Array([0x30, body.length, ...body]);
  assert.throws(() => es256SignatureToP1363(der), /signature_der_integer_oversize/);
});

test("cose import helper remains ES256-only", () => {
  assert.throws(() => coseEc2ToJwk(new Map([[1, 2], [3, -8], [-1, 1], [-2, new Uint8Array(32), [-3, new Uint8Array(32)]]])), /cose_alg_unsupported/);
});
