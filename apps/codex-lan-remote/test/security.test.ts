import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptCredential,
  digestSessionToken,
  encryptCredential,
  hashPassword,
  verifyPassword,
} from "../src/adapters/security.js";

test("password hashes are salted and verifiable", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
});

test("credentials use authenticated encryption", () => {
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptCredential("sk-example-secret-value", key);
  assert.equal(encrypted.includes("sk-example"), false);
  assert.equal(decryptCredential(encrypted, key), "sk-example-secret-value");
  assert.throws(() => decryptCredential(encrypted, Buffer.alloc(32, 8)));
});

test("session digest is stable without retaining the token", () => {
  const digest = digestSessionToken("browser-token", "server-pepper");
  assert.equal(digest, digestSessionToken("browser-token", "server-pepper"));
  assert.equal(digest.includes("browser-token"), false);
});
