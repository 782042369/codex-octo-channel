/**
 * Regression tests for the WuKongIM protocol layer after the node:crypto and
 * incremental-framing rewrite.
 *
 * The expected cipher material was produced by the previous implementation
 * (curve25519-js + crypto-js + md5-typescript), so a mismatch here means the
 * session key derivation or the payload decryption no longer matches the wire
 * contract the Octo server speaks.
 *
 * Usage: node scripts/crypto-test.mjs
 */
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { WKSocket, aesDecrypt, deriveSessionCipher } from "../lib/protocol/socket.js";

/** PKCS8 DER prefix that wraps a raw 32-byte X25519 private key. */
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** Cipher material captured from the pre-rewrite implementation. */
const VECTOR = {
  privateKeyHex: "0007070707070707070707070707070707070707070707070707070707070747",
  serverPublicBase64: "V9tLNZ8jrl4Ubk4lEgVnBHIlBjSMFQwUdT0Mkz0E1CE=",
  salt: "abcdefghijklmnopqrstuvwxyz012345",
  expectedKey: "2bb83270351b18c2",
  expectedIv: "abcdefghijklmnop",
  ciphertext: "Oxr5sQRzs+M4vUg6JgOKalTF2+80VSZTLGz+khhwJd6xIzOmX7vaY7M3V6VnuU1x",
  plaintext: JSON.stringify({ type: 1, content: "hello \u4e16\u754c" }),
};

/** Verify key derivation and payload decryption against the captured vector.
 * @returns void; throws when the wire contract changed.
 */
function testSessionCrypto() {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, Buffer.from(VECTOR.privateKeyHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const cipher = deriveSessionCipher(privateKey, VECTOR.serverPublicBase64, VECTOR.salt);
  assert.equal(cipher.aesKey, VECTOR.expectedKey, "session key matches the previous derivation");
  assert.equal(cipher.aesIV, VECTOR.expectedIv, "session IV is the first 16 salt characters");

  const decrypted = Buffer.from(
    aesDecrypt(Buffer.from(VECTOR.ciphertext, "utf8"), cipher.aesKey, cipher.aesIV),
  ).toString("utf8");
  assert.equal(decrypted, VECTOR.plaintext, "payload decrypts to the original plaintext");
}

/** Verify incremental frame framing across chunk boundaries.
 * @returns void; throws when framing drops or duplicates bytes.
 */
function testFraming() {
  const socket = new WKSocket({ wsUrl: "ws://invalid", uid: "u", token: "t", onMessage: () => undefined });
  assert.doesNotThrow(() => socket.handleRawData(new Uint8Array([0x80, 0x80])));
  assert.equal(socket.tempBuffer.length, 0, "two sticky PONG frames are both consumed");

  socket.handleRawData(new Uint8Array([0x51, 0x7f]));
  assert.equal(socket.tempBuffer.length, 2, "an incomplete RECV frame is retained, not dropped");

  socket.handleRawData(new Uint8Array(127));
  assert.equal(socket.tempBuffer.length, 0, "the completed frame is consumed and drained");

  assert.doesNotThrow(() => socket.handleRawData(new Uint8Array([0xf1, 0x00])));
  assert.equal(socket.tempBuffer.length, 0, "a malformed frame resets the parser instead of throwing out");

  assert.doesNotThrow(() => socket.handleRawData(new Uint8Array(5 * 1024 * 1024)));
  socket.disconnect();
}

testSessionCrypto();
testFraming();
console.log("Octo crypto + framing regression tests OK");
