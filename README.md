# Shopee Price Tracker — Cloudflare Worker

> **สถานะ (2026-10-29): พักโปรเจ็กไว้** โค้ดเสร็จและผ่านการทดสอบในเครื่อง (`npm test`)
> แต่ยังไม่ได้ deploy เพราะยังไม่ได้สิทธิ์ใช้ Shopee Affiliate Open API ดูรายละเอียดใน
> [CLAUDE.md](CLAUDE.md)

บอท Discord สำหรับติดตามราคาสินค้า Shopee ใช้งานคนเดียว ฟรี และไม่ต้องเปิดเครื่อง
ทิ้งไว้ ราคาดึงจาก **Shopee Affiliate Open API** (API ทางการ) Cloudflare Cron
จะเช็กราคาทุก 15 นาที และแจ้งเตือนในห้อง update-price เมื่อราคาลดลง ข้อมูล
เก็บใน Cloudflare D1

## คำสั่ง (ใช้ในห้องรับลิงก์)

| คำสั่ง | ทำอะไร |
| --- | --- |
| `/track url:<ลิงก์ Shopee>` | เริ่มติดตามราคา |
| `/untrack url:<ลิงก์ หรือรหัสจาก /list>` | เลิกติดตาม |
| `/list` | ดูรายการที่ติดตามอยู่ |

## ข้อจำกัดที่ควรรู้

- ต้องมีบัญชี Shopee Affiliate (TH) ที่ได้รับอนุมัติแล้ว และติดตามได้เฉพาะสินค้าที่
  เข้าร่วมโปรแกรม Affiliate เท่านั้น สินค้าที่ไม่ได้เข้าร่วมจะขึ้นว่า "ไม่พบสินค้านี้"
- Affiliate API ให้แค่ราคาต่ำสุดและสูงสุด แยกราคาตามตัวเลือกสินค้าไม่ได้ บอทจึง
  แจ้งเตือนตามราคาต่ำสุด และราคาใน API อาจอัปเดตช้ากว่าหน้าเว็บ
- แจ้งราคาลดได้เร็วสุดทุก 15 นาที แต่ละรอบเช็กได้สูงสุด 20 รายการ ถ้าติดตาม
  เกิน 20 รายการ แต่ละชิ้นจะถูกเช็กห่างกว่า 15 นาที
- อยู่ใน Cloudflare Free plan ได้สบายถ้าใช้งานคนเดียว

## ตั้งค่า

ต้องมีบัญชี Cloudflare ฟรี และติดตั้ง Node.js ไว้ใช้เฉพาะตอน deploy

1. ขอ App ID และ Secret จาก Shopee Affiliate (affiliate.shopee.co.th → Open API)

2. ติดตั้ง dependencies แล้ว login (ถ้ายังไม่มี D1 database ให้สร้างด้วยคำสั่งสุดท้าย):

   ```powershell
   npm install
   npx wrangler login
   npx wrangler d1 create shopee-tracker
   ```

3. ใน `wrangler.toml` ให้ใส่ `database_id`, `INPUT_CHANNEL_ID`, `UPDATE_CHANNEL_ID`
   และ `OWNER_USER_ID` (แนะนำให้ใส่ เพื่อจำกัดให้ใช้ได้คนเดียว)

4. ตั้งค่า secrets คำสั่งจะให้พิมพ์ค่าในเทอร์มินัล และไม่บันทึกค่าลง Git:

   ```powershell
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put SHOPEE_AFFILIATE_APP_ID
   npx wrangler secret put SHOPEE_AFFILIATE_SECRET
   ```

5. สร้างตารางแล้ว deploy:

   ```powershell
   npm run db:init
   npm run deploy
   ```

6. คัดลอก URL ที่ deploy ได้ (เช่น `https://shopee-price-tracker.<subdomain>.workers.dev`)
   ไปใส่ใน Discord Developer Portal → **General Information** → **Interactions
   Endpoint URL** แล้วกด Save Discord จะส่งคำขอทดสอบมาตรวจ URL ให้เอง

7. ลงทะเบียนคำสั่งใน server (บอทต้องถูกเชิญเข้า server ด้วย scope `applications.commands`):

   ```powershell
   $env:DISCORD_BOT_TOKEN = Read-Host "Discord bot token"
   $env:APPLICATION_ID = "ใส่ Application ID"
   $env:DISCORD_GUILD_ID = "ใส่ Server ID"
   npm run register-command
   Remove-Item Env:DISCORD_BOT_TOKEN
   ```

## Auto-deploy จาก GitHub (ไม่บังคับ)

push โปรเจ็กนี้ขึ้น repo แบบ private แล้วไปที่ Cloudflare Dashboard → Workers →
shopee-price-tracker → Settings → Builds → Connect เลือก repo นั้น หลังจากนี้ทุก
ครั้งที่ push ขึ้น `main` ระบบจะ deploy ให้เอง ส่วน secrets ยังเก็บไว้ใน Cloudflare
ไม่ต้องใส่ใน repo

## สิทธิ์ Discord

ในห้อง update-price บอทต้องมีสิทธิ์ View Channel, Send Messages และ Embed Links
ส่วนการตอบคำสั่งในห้องรับลิงก์ ใช้ interaction webhook จึงไม่ต้องให้สิทธิ์เพิ่ม และ
ไม่ต้องเปิด Message Content Intent
