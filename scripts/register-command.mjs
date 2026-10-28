const required = ["DISCORD_BOT_TOKEN", "APPLICATION_ID", "DISCORD_GUILD_ID"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  throw new Error(`Missing environment variables: ${missing.join(", ")}`);
}

const commands = [
  {
    name: "track",
    description: "เริ่มติดตามราคาสินค้า Shopee",
    type: 1,
    options: [{ name: "url", description: "ลิงก์สินค้า Shopee", type: 3, required: true }],
  },
  {
    name: "untrack",
    description: "เลิกติดตามสินค้า Shopee",
    type: 1,
    options: [{ name: "url", description: "ลิงก์สินค้า หรือรหัสจาก /list", type: 3, required: true }],
  },
  { name: "list", description: "ดูรายการสินค้าที่ติดตามอยู่", type: 1 },
];

const endpoint = new URL(
  `https://discord.com/api/v10/applications/${process.env.APPLICATION_ID}` +
    `/guilds/${process.env.DISCORD_GUILD_ID}/commands`,
);
const response = await fetch(endpoint, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  throw new Error(`Discord command registration failed: ${response.status} ${await response.text()}`);
}

console.log("Registered /track, /untrack and /list for this Discord server.");
