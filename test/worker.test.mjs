import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
// Offline tests: real SQLite (same schema as D1), mocked Discord and Shopee Affiliate.
// Run with: npm test
import worker from "../src/worker.js";

const schemaUrl = new URL("../schema.sql", import.meta.url);

// D1-compatible wrapper around real SQLite with the project's schema.
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(schemaUrl, "utf8"));
const DB = {
  prepare(sql) {
    let args = [];
    const stmt = { bind: (...a) => { args = a; return stmt; },
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      run: async () => sqlite.prepare(sql).run(...args),
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }) };
    return stmt;
  },
};

const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pub = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
const env = { DB, DISCORD_PUBLIC_KEY: pub, DISCORD_BOT_TOKEN: "bot", INPUT_CHANNEL_ID: "111",
  UPDATE_CHANNEL_ID: "222", OWNER_USER_ID: "999", SHOPEE_AFFILIATE_APP_ID: "app1",
  SHOPEE_AFFILIATE_SECRET: "sec1" };

let price = "199.00";
let calls = [];
let affiliateFails = false;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, init });
  if (url.startsWith("https://shp.ee/")) {
    return new Response(null, { status: 302, headers: { location: "https://shopee.co.th/universal-link/product/123/456?x=1" } });
  }
  if (url.includes("affiliate")) {
    if (affiliateFails) return new Response("err", { status: 500 });
    const auth = init.headers.Authorization;
    const ts = auth.match(/Timestamp=(\d+)/)[1];
    const expected = createHash("sha256").update("app1" + ts + init.body + "sec1").digest("hex");
    assert.equal(auth, `SHA256 Credential=app1, Timestamp=${ts}, Signature=${expected}`);
    assert.match(JSON.parse(init.body).query, /productOfferV2\(shopId: 123, itemId: 456, limit: 1\)/);
    return Response.json({ data: { productOfferV2: { nodes: [{ itemId: 456, shopId: 123,
      productName: "Test Product", priceMin: price, priceMax: "299.00", imageUrl: "https://img/x",
      productLink: "https://shopee.co.th/product/123/456" }] } } });
  }
  return new Response("{}", { status: 200 });
};

async function interact(body, { badSig = false } = {}) {
  const raw = JSON.stringify(body);
  const ts = "1700000000";
  let sig = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + raw))).toString("hex");
  if (badSig) sig = sig.replace(/^./, (c) => (c === "0" ? "1" : "0"));
  const pending = [];
  const res = await worker.fetch(new Request("https://w/", { method: "POST", body: raw,
    headers: { "x-signature-ed25519": sig, "x-signature-timestamp": ts } }), env,
    { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return res;
}
const cmd = (name, url, extra = {}) => ({ type: 2, application_id: "app", token: "tok", channel_id: "111",
  member: { user: { id: "999" } }, data: { name, options: url ? [{ name: "url", value: url }] : [] }, ...extra });
const patched = () => JSON.parse(calls.find((c) => c.init.method === "PATCH").init.body);

assert.equal((await interact({ type: 1 }, { badSig: true })).status, 401);
assert.equal((await (await interact({ type: 1 })).json()).type, 1);

assert.match((await (await interact(cmd("list"))).json()).data.content, /ยังไม่มีสินค้า/);
assert.match((await (await interact(cmd("list", null, { member: { user: { id: "1" } } }))).json()).data.content, /เจ้าของ/);
assert.match((await (await interact(cmd("list", null, { channel_id: "5" }))).json()).data.content, /ห้องรับลิงก์/);
assert.equal((await (await interact(cmd("track", "https://evil.com/product/1/2"))).json()).data.flags, 64);

calls = [];
assert.equal((await (await interact(cmd("track", "https://shp.ee/abc"))).json()).type, 5);
assert.ok(calls.some((c) => c.url === "https://shp.ee/abc" && c.init.redirect === "manual"));
assert.ok(!calls.some((c) => c.url.includes("universal-link")), "must not fetch product page");
assert.match(patched().content, /เริ่มติดตามสินค้าแล้ว/);
assert.match(patched().embeds[0].description, /฿199 – ฿299/);
assert.ok(calls.find((c) => c.init.method === "PATCH").url.endsWith("/webhooks/app/tok/messages/@original"));

calls = [];
await interact(cmd("track", "https://shopee.co.th/Test-i.123.456"));
assert.match(patched().content, /ติดตามรายการนี้อยู่แล้ว/);

assert.match((await (await interact(cmd("list"))).json()).data.content, /Test Product — ฿199.*`123_456`/);

// Price drop sends an alert with percentage and saves the new price.
price = "149.00"; calls = [];
await worker.scheduled({}, env, { waitUntil: (p) => p });
await new Promise((r) => setTimeout(r, 50));
const alert = calls.find((c) => c.url.endsWith("/channels/222/messages"));
assert.ok(alert, "alert sent");
assert.match(JSON.parse(alert.init.body).embeds[0].description, /ลดลง: \*\*฿50 \(25%\)\*\*/);
assert.equal(sqlite.prepare("SELECT current_price FROM tracked_items").get().current_price, 149);

// Failure keeps the price but moves the item back in the queue.
const before = sqlite.prepare("SELECT updated_at FROM tracked_items").get().updated_at;
await new Promise((r) => setTimeout(r, 10));
affiliateFails = true;
await worker.scheduled({}, env, { waitUntil: (p) => p });
await new Promise((r) => setTimeout(r, 50));
const row = sqlite.prepare("SELECT updated_at, current_price FROM tracked_items").get();
assert.equal(row.current_price, 149);
assert.notEqual(row.updated_at, before);
affiliateFails = false;

calls = [];
await interact(cmd("untrack", "123_456"));
assert.match(patched().content, /เลิกติดตาม \*\*Test Product\*\*/);
calls = [];
await interact(cmd("untrack", "123_456"));
assert.match(patched().content, /ไม่พบสินค้านี้/);

console.log("ALL TESTS PASSED");
