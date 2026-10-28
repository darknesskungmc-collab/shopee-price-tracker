const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_AFFILIATE_ENDPOINT = "https://open-api.affiliate.shopee.co.th/graphql";
const INTERACTION_PING = 1;
const APPLICATION_COMMAND = 2;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
// Free plan allows 50 fetch() subrequests per invocation. Each item costs one
// Affiliate API call plus at most one Discord alert, so 20 stays well inside.
const MAX_TRACKED_ITEMS_PER_RUN = 20;
const MAX_REDIRECTS = 5;
const DISCORD_MESSAGE_LIMIT = 2000;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Shopee Price Tracker is running.", { status: 200 });
    }

    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const rawBody = await request.text();
    if (!signature || !timestamp || !(await verifyDiscordRequest(env, signature, timestamp, rawBody))) {
      return new Response("invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(rawBody);
    if (interaction.type === INTERACTION_PING) {
      return discordResponse(INTERACTION_PING);
    }
    if (interaction.type !== APPLICATION_COMMAND) {
      return discordResponse(CHANNEL_MESSAGE_WITH_SOURCE, "ยังไม่รองรับคำสั่งนี้ครับ", true);
    }

    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    if (env.OWNER_USER_ID && userId !== env.OWNER_USER_ID) {
      return discordResponse(CHANNEL_MESSAGE_WITH_SOURCE, "คำสั่งนี้อนุญาตให้เจ้าของบอทใช้เท่านั้น", true);
    }
    if (interaction.channel_id !== env.INPUT_CHANNEL_ID) {
      return discordResponse(CHANNEL_MESSAGE_WITH_SOURCE, "กรุณาใช้คำสั่งนี้ในห้องรับลิงก์ที่กำหนด", true);
    }

    const command = interaction.data?.name;
    if (command === "list") {
      return discordResponse(CHANNEL_MESSAGE_WITH_SOURCE, await listTrackedItems(env));
    }
    if (command !== "track" && command !== "untrack") {
      return discordResponse(CHANNEL_MESSAGE_WITH_SOURCE, "ยังไม่รองรับคำสั่งนี้ครับ", true);
    }

    const input = interaction.data.options?.find((option) => option.name === "url")?.value?.trim();
    if (!parseItemKey(input) && !isShopeeUrl(input)) {
      return discordResponse(CHANNEL_MESSAGE_WITH_SOURCE, "กรุณาส่งลิงก์สินค้า Shopee ที่ถูกต้อง", true);
    }

    // Discord requires the first response within three seconds, so the
    // lookup runs after a deferred acknowledgement and edits that reply.
    const task = command === "track" ? startTracking(env, input) : stopTracking(env, input);
    ctx.waitUntil(task.then((payload) => editOriginalResponse(interaction, payload)));
    return discordResponse(DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkTrackedPrices(env));
  },
};

function discordResponse(type, content, ephemeral = false) {
  const body = { type };
  if (content) {
    body.data = { content };
    if (ephemeral) body.data.flags = 64;
  }
  return Response.json(body);
}

async function verifyDiscordRequest(env, signature, timestamp, body) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(env.DISCORD_PUBLIC_KEY),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
  } catch (error) {
    console.error("Discord signature verification failed", error);
    return false;
  }
}

function hexToBytes(value) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    throw new Error("Invalid hex value");
  }
  return Uint8Array.from(value.match(/.{1,2}/g), (byte) => Number.parseInt(byte, 16));
}

function isShopeeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" &&
      (host === "shp.ee" || host === "shopee.co.th" || host.endsWith(".shopee.co.th"));
  } catch {
    return false;
  }
}

async function startTracking(env, input) {
  try {
    const ids = await resolveIds(input);
    const item = await fetchAffiliateItem(ids.shopId, ids.itemId, env);
    const now = new Date().toISOString();
    const existing = await env.DB.prepare(
      "SELECT item_key FROM tracked_items WHERE item_key = ?",
    ).bind(item.key).first();

    await env.DB.prepare(`
      INSERT INTO tracked_items (
        item_key, shop_id, item_id, title, variant, product_url, image_url,
        initial_price, current_price, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_key) DO UPDATE SET
        title = excluded.title,
        variant = excluded.variant,
        product_url = excluded.product_url,
        image_url = excluded.image_url,
        updated_at = excluded.updated_at
    `).bind(
      item.key, item.shopId, item.itemId, item.title, item.variant, item.url,
      item.imageUrl, item.price, item.price, now, now,
    ).run();

    const status = existing ? "ติดตามรายการนี้อยู่แล้ว" : "เริ่มติดตามสินค้าแล้ว";
    return {
      content: `✅ **${status}**`,
      embeds: [productEmbed(item, `ราคาปัจจุบัน: **฿${formatPrice(item.price)}**`)],
    };
  } catch (error) {
    console.error("Could not start tracking", error);
    return { content: `❌ เริ่มติดตามสินค้าไม่สำเร็จ: ${safeError(error)}` };
  }
}

async function stopTracking(env, input) {
  try {
    const ids = await resolveIds(input);
    const key = `${ids.shopId}_${ids.itemId}`;
    const row = await env.DB.prepare(
      "DELETE FROM tracked_items WHERE item_key = ? RETURNING title",
    ).bind(key).first();
    return {
      content: row
        ? `🗑️ เลิกติดตาม **${row.title.slice(0, 200)}** แล้วครับ`
        : "ℹ️ ไม่พบสินค้านี้ในรายการติดตามครับ",
    };
  } catch (error) {
    console.error("Could not stop tracking", error);
    return { content: `❌ เลิกติดตามไม่สำเร็จ: ${safeError(error)}` };
  }
}

async function listTrackedItems(env) {
  const { results: items } = await env.DB.prepare(
    "SELECT item_key, title, initial_price, current_price FROM tracked_items ORDER BY created_at ASC",
  ).all();
  if (!items?.length) return "ℹ️ ยังไม่มีสินค้าที่ติดตามอยู่ครับ";

  const lines = [`📋 **สินค้าที่ติดตาม (${items.length} รายการ)**`];
  for (const [index, item] of items.entries()) {
    const line = `${index + 1}. ${item.title.slice(0, 60)} — ฿${formatPrice(item.current_price)}` +
      ` (เริ่ม ฿${formatPrice(item.initial_price)}) \`${item.item_key}\``;
    if (lines.join("\n").length + line.length + 30 > DISCORD_MESSAGE_LIMIT) {
      lines.push(`…และอีก ${items.length - index} รายการ`);
      break;
    }
    lines.push(line);
  }
  if (items.length > MAX_TRACKED_ITEMS_PER_RUN) {
    lines.push(`⚠️ เกิน ${MAX_TRACKED_ITEMS_PER_RUN} รายการ แต่ละชิ้นจะถูกเช็กห่างกว่า 15 นาที`);
  }
  return lines.join("\n");
}

async function checkTrackedPrices(env) {
  const { results: items } = await env.DB.prepare(
    "SELECT * FROM tracked_items ORDER BY updated_at ASC LIMIT ?",
  ).bind(MAX_TRACKED_ITEMS_PER_RUN).all();

  for (const item of items ?? []) {
    const now = new Date().toISOString();
    try {
      const latest = await fetchAffiliateItem(item.shop_id, item.item_id, env);
      const previousPrice = Number(item.current_price);

      if (latest.price < previousPrice) {
        await sendChannelMessage(env, env.UPDATE_CHANNEL_ID, {
          content: "🚨 **แจ้งเตือนสินค้าลดราคา!**",
          embeds: [productEmbed(latest, priceDropDescription(item, previousPrice, latest.price))],
        });
      }

      await env.DB.prepare(`
        UPDATE tracked_items
        SET title = ?, variant = ?, product_url = ?, image_url = ?,
            current_price = ?, updated_at = ?
        WHERE item_key = ?
      `).bind(
        latest.title, latest.variant, latest.url, latest.imageUrl, latest.price,
        now, item.item_key,
      ).run();
    } catch (error) {
      // Preserve the last known price, but move the item to the back of the
      // queue so repeatedly failing items cannot starve the others.
      console.warn(`Price check failed for ${item.item_key}: ${safeError(error)}`);
      await env.DB.prepare("UPDATE tracked_items SET updated_at = ? WHERE item_key = ?")
        .bind(now, item.item_key).run();
    }
  }
}

function priceDropDescription(item, previousPrice, newPrice) {
  const drop = previousPrice - newPrice;
  const percent = Math.round((drop / previousPrice) * 100);
  const lines = [
    `ราคาเดิม: ~~฿${formatPrice(previousPrice)}~~`,
    `🔥 ราคาใหม่: **฿${formatPrice(newPrice)}**`,
    `📉 ลดลง: **฿${formatPrice(drop)} (${percent}%)**`,
  ];
  const initialPrice = Number(item.initial_price);
  if (initialPrice > newPrice) {
    lines.push(`*(ถูกกว่าตอนเริ่มติดตาม ฿${formatPrice(initialPrice - newPrice)})*`);
  }
  return lines.join("\n");
}

function parseItemKey(value) {
  const match = value?.match(/^(\d+)[_.](\d+)$/);
  return match ? { shopId: match[1], itemId: match[2] } : null;
}

function extractIds(url) {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // Keep the raw URL when it contains a malformed escape sequence.
  }
  const match = decoded.match(/\/product\/(\d+)\/(\d+)/i) ?? decoded.match(/i\.(\d+)\.(\d+)/i);
  return match ? { shopId: match[1], itemId: match[2] } : null;
}

// Short links (shp.ee, s.shopee.co.th) are resolved by reading redirect
// Location headers only; the product page itself is never requested.
async function resolveIds(input) {
  const direct = parseItemKey(input) ?? extractIds(input);
  if (direct) return direct;

  let url = input;
  for (let hop = 0; hop < MAX_REDIRECTS && isShopeeUrl(url); hop++) {
    const response = await fetch(url, { redirect: "manual" });
    const location = response.headers.get("location");
    if (!location) break;
    url = new URL(location, url).toString();
    const ids = extractIds(url);
    if (ids) return ids;
  }
  throw new Error("ไม่พบ shop_id และ item_id ในลิงก์ Shopee (ลองใช้ลิงก์เต็มจากหน้าสินค้า)");
}

async function fetchAffiliateItem(shopId, itemId, env) {
  if (!env.SHOPEE_AFFILIATE_APP_ID || !env.SHOPEE_AFFILIATE_SECRET) {
    throw new Error("ยังไม่ได้ตั้งค่า SHOPEE_AFFILIATE_APP_ID / SHOPEE_AFFILIATE_SECRET");
  }
  if (!/^\d+$/.test(shopId) || !/^\d+$/.test(itemId)) {
    throw new Error("shop_id หรือ item_id ไม่ถูกต้อง");
  }

  // The signature covers the exact body bytes, so serialise once and reuse.
  const payload = JSON.stringify({
    query: `{ productOfferV2(shopId: ${shopId}, itemId: ${itemId}, limit: 1) {
      nodes { itemId shopId productName priceMin priceMax imageUrl productLink }
    } }`,
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await sha256Hex(
    env.SHOPEE_AFFILIATE_APP_ID + timestamp + payload + env.SHOPEE_AFFILIATE_SECRET,
  );

  const response = await fetch(env.SHOPEE_AFFILIATE_ENDPOINT || DEFAULT_AFFILIATE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `SHA256 Credential=${env.SHOPEE_AFFILIATE_APP_ID}, Timestamp=${timestamp}, Signature=${signature}`,
    },
    body: payload,
  });
  if (!response.ok) throw new Error(`Shopee Affiliate HTTP ${response.status}`);

  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(`Shopee Affiliate: ${result.errors[0].message}`);
  }
  const node = result.data?.productOfferV2?.nodes?.[0];
  if (!node || String(node.itemId) !== itemId) {
    throw new Error("ไม่พบสินค้านี้ใน Shopee Affiliate (สินค้าอาจไม่ได้เข้าร่วมโปรแกรม)");
  }

  const priceMin = Number(node.priceMin);
  const priceMax = Number(node.priceMax);
  if (!Number.isFinite(priceMin) || priceMin <= 0) {
    throw new Error("Shopee Affiliate ไม่ส่งราคาสินค้าที่ใช้งานได้");
  }

  return {
    key: `${shopId}_${itemId}`,
    shopId,
    itemId,
    title: String(node.productName),
    variant: priceMax > priceMin
      ? `฿${formatPrice(priceMin)} – ฿${formatPrice(priceMax)} (แจ้งตามราคาต่ำสุด)`
      : "ราคาเดียว",
    price: priceMin,
    imageUrl: node.imageUrl || null,
    url: node.productLink || `https://shopee.co.th/product/${shopId}/${itemId}`,
  };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function productEmbed(item, description) {
  const embed = {
    title: item.title.slice(0, 256),
    url: item.url,
    color: 0xee4d2d,
    description: `ช่วงราคา: ${item.variant}\n\n${description}`,
    footer: { text: "Shopee Price Tracker" },
  };
  if (item.imageUrl) embed.thumbnail = { url: item.imageUrl };
  return embed;
}

async function editOriginalResponse(interaction, payload) {
  // Interaction webhooks are authorised by the token in the URL, not the bot token.
  const response = await fetch(
    `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) console.error(`Discord HTTP ${response.status}: ${await response.text()}`);
}

async function sendChannelMessage(env, channelId, payload) {
  const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}: ${await response.text()}`);
}

function formatPrice(value) {
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(value);
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}
