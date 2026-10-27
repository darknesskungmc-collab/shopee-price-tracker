const DISCORD_API = "https://discord.com/api/v10";
const INTERACTION_PING = 1;
const APPLICATION_COMMAND = 2;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const MAX_TRACKED_ITEMS_PER_RUN = 40;

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
    if (interaction.type !== APPLICATION_COMMAND || interaction.data?.name !== "track") {
      return discordResponse(CHANNEL_MESSAGE_WITH_SOURCE, "ยังไม่รองรับคำสั่งนี้ครับ", true);
    }

    if (env.OWNER_USER_ID && interaction.member?.user?.id !== env.OWNER_USER_ID) {
      return discordResponse(CHANNEL_MESSAGE_WITH_SOURCE, "คำสั่งนี้อนุญาตให้เจ้าของบอทใช้เท่านั้น", true);
    }
    if (interaction.channel_id !== env.INPUT_CHANNEL_ID) {
      return discordResponse(CHANNEL_MESSAGE_WITH_SOURCE, "กรุณาใช้คำสั่งนี้ในห้องรับลิงก์ที่กำหนด", true);
    }

    const productUrl = interaction.data.options?.find((option) => option.name === "url")?.value?.trim();
    if (!isShopeeUrl(productUrl)) {
      return discordResponse(CHANNEL_MESSAGE_WITH_SOURCE, "กรุณาส่งลิงก์สินค้า Shopee ที่ถูกต้อง", true);
    }

    // Discord requires this first response within three seconds. Product lookup
    // happens after the acknowledgement and reports its result in update-price.
    ctx.waitUntil(startTracking(env, productUrl));
    return discordResponse(CHANNEL_MESSAGE_WITH_SOURCE, "⏳ รับลิงก์แล้ว กำลังเริ่มติดตามสินค้า…");
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
    return crypto.subtle.verify(
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
    const host = new URL(value).hostname.toLowerCase();
    return host === "shp.ee" || host === "shopee.co.th" || host.endsWith(".shopee.co.th");
  } catch {
    return false;
  }
}

async function startTracking(env, sharedUrl) {
  try {
    const item = await resolveAndFetchItem(sharedUrl, env);
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
    await sendChannelMessage(env, env.UPDATE_CHANNEL_ID, {
      content: `✅ **${status}**`,
      embeds: [productEmbed(item, `ราคาเริ่มต้น: **฿${formatPrice(item.price)}**`)],
    });
  } catch (error) {
    console.error("Could not start tracking", error);
    await sendChannelMessage(env, env.UPDATE_CHANNEL_ID, {
      content: `❌ เริ่มติดตามสินค้าไม่สำเร็จ: ${safeError(error)}`,
    });
  }
}

async function checkTrackedPrices(env) {
  const { results: items } = await env.DB.prepare(
    "SELECT * FROM tracked_items ORDER BY updated_at ASC LIMIT ?",
  ).bind(MAX_TRACKED_ITEMS_PER_RUN).all();

  for (const item of items ?? []) {
    try {
      const latest = await fetchShopeeItem(item.shop_id, item.item_id, env);
      const previousPrice = Number(item.current_price);

      if (latest.price < previousPrice) {
        await sendChannelMessage(env, env.UPDATE_CHANNEL_ID, {
          content: "🚨 **แจ้งเตือนสินค้าลดราคา!**",
          embeds: [productEmbed(
            latest,
            `ราคาเดิม: ~~฿${formatPrice(previousPrice)}~~\n🔥 ราคาใหม่: **฿${formatPrice(latest.price)}**\n📉 ลดลง: **฿${formatPrice(previousPrice - latest.price)}**`,
          )],
        });
      }

      await env.DB.prepare(`
        UPDATE tracked_items
        SET title = ?, variant = ?, product_url = ?, image_url = ?,
            current_price = ?, updated_at = ?
        WHERE item_key = ?
      `).bind(
        latest.title, latest.variant, latest.url, latest.imageUrl, latest.price,
        new Date().toISOString(), item.item_key,
      ).run();
    } catch (error) {
      // Preserve the last known price. One unavailable Shopee product must not
      // stop the remaining products from being checked.
      console.warn(`Price check failed for ${item.item_key}: ${safeError(error)}`);
    }
  }
}

async function resolveAndFetchItem(sharedUrl, env) {
  const response = await fetch(sharedUrl, {
    redirect: "follow",
    headers: shopeeHeaders(env),
  });
  const ids = extractIds(response.url);
  if (!ids) throw new Error("ไม่พบ shop_id และ item_id ในลิงก์ Shopee");
  return fetchShopeeItem(ids.shopId, ids.itemId, env);
}

function extractIds(url) {
  const productMatch = url.match(/\/product\/(\d+)\/(\d+)/i);
  const itemMatch = url.match(/i\.(\d+)\.(\d+)/i);
  const match = productMatch ?? itemMatch;
  return match ? { shopId: match[1], itemId: match[2] } : null;
}

async function fetchShopeeItem(shopId, itemId, env) {
  const endpoint = new URL("https://shopee.co.th/api/v4/item/get");
  endpoint.searchParams.set("shopid", shopId);
  endpoint.searchParams.set("itemid", itemId);

  const response = await fetch(endpoint, { headers: shopeeHeaders(env) });
  if (!response.ok) throw new Error(`Shopee HTTP ${response.status}`);
  const payload = await response.json();
  const data = payload?.data;
  const rawPrice = data?.price_min ?? data?.price;
  if (!data?.name || !Number.isFinite(Number(rawPrice)) || Number(rawPrice) <= 0) {
    throw new Error("Shopee ไม่ส่งข้อมูลราคาสินค้าที่ใช้งานได้");
  }

  const models = Array.isArray(data.models) ? data.models : [];
  const cheapest = models.reduce(
    (lowest, model) => Number(model.price) < Number(lowest.price) ? model : lowest,
    { price: rawPrice, name: "มาตรฐาน" },
  );
  const imageUrl = data.image
    ? `https://down-th.img.susercontent.com/file/${data.image}`
    : null;

  return {
    key: `${shopId}_${itemId}`,
    shopId,
    itemId,
    title: String(data.name),
    variant: cheapest.name || "มาตรฐาน",
    price: Number(rawPrice) / 100000,
    imageUrl,
    url: `https://shopee.co.th/product/${shopId}/${itemId}`,
  };
}

function shopeeHeaders(env) {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
    Referer: "https://shopee.co.th/",
    "User-Agent": "Mozilla/5.0 (compatible; ShopeePriceTracker/1.0)",
  };
  if (env.SHOPEE_COOKIE) headers.Cookie = env.SHOPEE_COOKIE;
  return headers;
}

function productEmbed(item, description) {
  const embed = {
    title: item.title.slice(0, 256),
    url: item.url,
    color: 0xee4d2d,
    description: `ตัวเลือก: ${item.variant}\n\n${description}`,
    footer: { text: "Shopee Price Tracker" },
  };
  if (item.imageUrl) embed.thumbnail = { url: item.imageUrl };
  return embed;
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
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 }).format(value);
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}
