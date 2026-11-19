import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_SECRET = "test-secret";

const aes = await import("../lib/crypto/aes");
const password = await import("../lib/auth/password");
const render = await import("../lib/email/render");
const money = await import("../lib/payments/money");
const tokens = await import("../lib/crypto/tokens");

test("AES-256-GCM round trip, AAD binding and tamper detection", () => {
  const enc = aes.encrypt("sk_test_secret", "merchant.credentials");
  assert.match(enc, /^enc:v1:[0-9a-f]{8}:/);
  assert.equal(aes.decrypt(enc, "merchant.credentials"), "sk_test_secret");
  assert.throws(() => aes.decrypt(enc, "other.context"));
  const parts = enc.split(":");
  parts[5] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => aes.decrypt(parts.join(":"), "merchant.credentials"));
  assert.notEqual(aes.encrypt("x"), aes.encrypt("x"), "random IV per message");
});

test("AES key rotation: old ciphertext still decrypts", () => {
  const old = aes.encrypt("hello");
  const oldKey = process.env.ENCRYPTION_KEY!;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.ENCRYPTION_KEYS_PREVIOUS = oldKey;
  assert.equal(aes.decrypt(old), "hello");
  assert.equal(aes.needsReEncryption(old), true);
  delete process.env.ENCRYPTION_KEYS_PREVIOUS;
  assert.throws(() => aes.decrypt(old));
});

test("password policy", () => {
  assert.deepEqual(password.passwordProblems("Str0ng!Passw0rd#2026", "owner@example.com"), []);
  assert.ok(password.passwordProblems("short").length > 0);
  assert.ok(password.passwordProblems("ownerowner!A1xyz", "owner@example.com").includes("must not contain your email name"));
});

test("email templates escape variables and support sections", () => {
  const html = render.renderTemplate("Hi {{customer_name}}{{#memo}} — {{memo}}{{/memo}}{{^memo}} (no memo){{/memo}}", { customer_name: "<script>x</script>", memo: "" });
  assert.equal(html, "Hi &lt;script&gt;x&lt;/script&gt; (no memo)");
  assert.equal(render.renderSubject("Invoice {{n}}\r\nBcc: evil@x.com", { n: "1" }), "Invoice 1 Bcc: evil@x.com");
});

test("money parsing is exact", () => {
  assert.equal(money.toMinor("19.99", "USD"), 1999);
  assert.equal(money.toMinor("1,000", "USD"), 100000);
  assert.equal(money.toMinor("500", "JPY"), 500);
  assert.throws(() => money.toMinor("1.234", "USD"));
  assert.throws(() => money.toMinor("-5", "USD"));
  assert.equal(money.toDecimalString(5, "USD"), "0.05");
  assert.equal(money.toDecimalString(1234, "KWD"), "1.234");
});

test("constant-time compare and token hashing", () => {
  assert.equal(tokens.safeEqual("abc", "abc"), true);
  assert.equal(tokens.safeEqual("abc", "abd"), false);
  assert.equal(tokens.safeEqual("abc", "abcd"), false);
  assert.equal(tokens.hashToken("t"), tokens.hashToken("t"));
  assert.notEqual(tokens.hashToken("t"), tokens.sha256Hex("t"), "peppered");
});
