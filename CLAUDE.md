# CLAUDE.md — สรุปโปรเจ็กสำหรับ AI ที่มาทำต่อ

อ่านไฟล์นี้ก่อน จะได้ไม่ต้องไล่อ่านทุกไฟล์ ถ้าโค้ดเปลี่ยน ให้อัปเดตไฟล์นี้ด้วย

## โปรเจ็กนี้คืออะไร

บอท Discord ติดตามราคาสินค้า Shopee TH ใช้งานคนเดียว (เจ้าของบอทเท่านั้น)
- ผู้ใช้พิมพ์ `/track <ลิงก์>` ในห้องรับลิงก์ แล้วบอทบันทึกสินค้า
- Cron ทุก 15 นาทีเช็กราคา ถ้าราคาลดจะแจ้งในห้อง update-price
- รันบน Cloudflare Worker + D1 ฟรี 100% และไม่ต้องเปิดเครื่องทิ้งไว้

## สถานะ (2026-10-29): พักไว้

- โค้ดเสร็จ ผ่าน `npm test` และ `wrangler deploy --dry-run` แต่ **ยังไม่เคย deploy จริง**
- **ตัวที่ติดอยู่:** แหล่งราคาคือ Shopee Affiliate Open API แต่เจ้าของสมัคร Affiliate แล้ว
  ขอ Open API ไม่ผ่าน เพราะเกณฑ์ต้องมีออเดอร์มากกว่า 1,000 รายการต่อเดือน
  หรือมีเว็บ/ผู้ติดตามจำนวนมาก
- ยังไม่เคยทดสอบกับ Affiliate API จริง รูปแบบ signature และ query อ้างอิงจาก
  SDK ของบุคคลที่สาม (Shopee.Affiliate บน NuGet) ถ้าได้คีย์มา ให้ทดสอบ `/track`
  จริงก่อน แล้วค่อยเชื่อผลลัพธ์

## ข้อห้ามและสิ่งที่ลองแล้วไม่ได้ผล (อย่าวนกลับไปทำซ้ำ)

- **อย่า scrape Shopee** ทั้ง `/api/v4/item/get`, `/api/v4/pdp/get_pc` และหน้า HTML
  - ผลที่เจอ: fetch จากเซิร์ฟเวอร์ได้ `403 {"error":90309999}` (ระบบกันบอท)
    ตั้งแต่คำขอแรก ไม่เกี่ยวกับความถี่ที่ยิง
  - ทางผ่านมีแค่หลบระบบกันบอท (ปลอม TLS fingerprint ด้วย curl_cffi, headless
    browser แบบซ่อนตัว, residential proxy หรือยืม cookie) ซึ่ง**ตกลงกันแล้วว่าไม่ทำ**
- เวอร์ชันแรกเป็น Python (`main.py`) บน GitHub Actions ใช้ curl_cffi ถูกลบไปแล้ว
- เจ้าของไม่ต้องการ: ส่วนขยายเบราว์เซอร์ / การเปิดหน้าเว็บเองเพื่อเช็กราคา /
  ของที่เสียเงิน / เครื่องที่ต้องเปิดตลอด 24 ชม.

## ทางที่จะไปต่อได้

1. ได้สิทธิ์ Shopee Affiliate Open API: ตั้ง secrets 2 ตัว แล้ว deploy ตาม README
   ไม่ต้องแก้โค้ด
2. ได้ API หรือ product feed จากเครือข่าย affiliate อื่น (เช่น Involve Asia,
   ACCESSTRADE): ให้แทนที่แค่ `fetchAffiliateItem()` ใน `src/worker.js`
   ฟังก์ชันใหม่ต้องคืน object รูปแบบเดิม
   `{ key, shopId, itemId, title, variant, price, imageUrl, url }`
   ส่วนอื่น (Discord, D1, cron) ใช้ต่อได้เลย

## โครงสร้างไฟล์

| ไฟล์ | หน้าที่ |
| --- | --- |
| `src/worker.js` | โค้ดทั้งหมดของ Worker (ไฟล์เดียว ไม่มี dependency ตอนรัน) |
| `schema.sql` | ตาราง D1 `tracked_items` |
| `scripts/register-command.mjs` | ลงทะเบียน `/track` `/untrack` `/list` เป็น guild commands |
| `test/worker.test.mjs` | ทดสอบแบบออฟไลน์: SQLite จริง (`node:sqlite`) + mock fetch + Ed25519 จริง |
| `wrangler.toml` | ตั้งค่า Worker, cron, D1 binding และ vars ที่ไม่ใช่ความลับ |
| `.dev.vars.example` | รายชื่อ secrets ที่ต้องใช้ |
| `README.md` | วิธีตั้งค่าและ deploy สำหรับคน (ภาษาไทย) |

## การทำงานใน `src/worker.js`

- `fetch`: รับ Discord interaction
  1. ตรวจลายเซ็น Ed25519 ด้วย `DISCORD_PUBLIC_KEY` แล้วตอบ PING
  2. เช็กว่าเป็น `OWNER_USER_ID` และพิมพ์ใน `INPUT_CHANNEL_ID`
  3. `/list` ตอบทันที
  4. `/track` และ `/untrack` ตอบแบบ deferred (type 5) ก่อน แล้วทำงานต่อใน
     `ctx.waitUntil` จากนั้นแก้ข้อความตอบกลับผ่าน
     `PATCH /webhooks/{application_id}/{token}/messages/@original`
     (ไม่ใช้ bot token)
- `scheduled`: เลือกรายการที่ `updated_at` เก่าสุด ไม่เกิน `MAX_TRACKED_ITEMS_PER_RUN = 20`
  ถ้าราคาต่ำกว่า `current_price` จะส่ง alert ไปที่ `UPDATE_CHANNEL_ID` ด้วย bot token
  ถ้าเช็กไม่สำเร็จจะอัปเดตแค่ `updated_at` เพื่อย้ายไปท้ายคิว
- `resolveIds`: รับได้ทั้งรหัส `shopId_itemId`, ลิงก์ `/product/{shop}/{item}`
  และลิงก์ `-i.{shop}.{item}` ส่วนลิงก์สั้น (shp.ee) จะอ่านแค่ header `Location`
  ด้วย `redirect: "manual"` และไม่โหลดหน้าสินค้า
- `fetchAffiliateItem`: POST GraphQL `productOfferV2(shopId, itemId, limit: 1)`
  - header: `Authorization: SHA256 Credential={AppId}, Timestamp={unix seconds}, Signature={sha256hex(AppId+Timestamp+body+Secret)}`
  - ใช้ `priceMin` เป็นราคาที่ติดตาม และเก็บช่วงราคาไว้ในคอลัมน์ `variant`

## ข้อจำกัดของ Cloudflare Free ที่โค้ดออกแบบให้รองรับ

- fetch ได้ 50 subrequest ต่อ invocation: แต่ละรายการใช้ 1 API call + alert อีกไม่เกิน 1
  จึงจำกัดไว้ 20 รายการต่อรอบ
- CPU 10ms ต่อ invocation: ใช้งานจำนวนน้อยจึงไม่มีปัญหา
- `waitUntil` ทำงานต่อได้ประมาณ 30 วินาทีหลังตอบ Discord แล้ว
- Discord ต้องได้คำตอบแรกภายใน 3 วินาที จึงต้องใช้ deferred response

## Config

- vars (`wrangler.toml`): `INPUT_CHANNEL_ID`, `UPDATE_CHANNEL_ID`, `OWNER_USER_ID`,
  `SHOPEE_AFFILIATE_ENDPOINT` ตอนนี้ยังเป็นค่า placeholder อยู่ ยกเว้น `database_id`
- secrets (`wrangler secret put`): `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`,
  `SHOPEE_AFFILIATE_APP_ID`, `SHOPEE_AFFILIATE_SECRET`
- ตอนรัน `register-command` ต้องใช้ env: `DISCORD_BOT_TOKEN`, `APPLICATION_ID`, `DISCORD_GUILD_ID`
- เจ้าของสร้างบอท Discord ไว้แล้ว

## คำสั่ง

```bash
npm install          # ครั้งแรก
npm run check        # syntax check
npm test             # ทดสอบออฟไลน์ (Node >= 22.5)
npx wrangler deploy --dry-run   # ตรวจว่า build ผ่าน
npm run deploy       # deploy จริง (ต้อง wrangler login และตั้ง secrets ก่อน)
```

## สภาพแวดล้อมของเจ้าของ

- Windows 11, PowerShell 5.1, Node 26
- ยังไม่ได้ติดตั้ง `git` บน PATH (ต้องติดตั้ง Git for Windows ก่อนจะเชื่อม GitHub)
- ถ้าจะ auto-deploy ให้ใช้ Cloudflare Workers Builds (Connect GitHub repo)
- คุยกับเจ้าของเป็นภาษาไทย
