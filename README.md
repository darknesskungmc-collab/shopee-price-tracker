# Shopee Price Tracker — Cloudflare Worker

บอทนี้ตอบคำสั่ง Discord `/track <ลิงก์ Shopee>` ทันทีโดยไม่ต้องมีเครื่อง
เปิดตลอดเวลา จากนั้น Cloudflare Cron จะเช็กราคาทุก 15 นาทีและแจ้งเตือนใน
ห้อง `update-price` เมื่อราคาลดลง ข้อมูลรายการติดตามเก็บใน Cloudflare D1
แทน GitHub Actions และ JSON file

## ข้อจำกัดที่ควรรู้

- ฟรีได้สำหรับการใช้งานส่วนตัวจำนวนน้อยภายใน quota ของ Cloudflare Free
  (100,000 Worker requests/วัน, Cron Trigger 5 รายการ, D1 มี daily limit)
- การตอบ `/track` เป็นแบบทันที แต่การแจ้งราคาลดจะเร็วสุดตามรอบ 15 นาที
- Shopee อาจเปลี่ยน endpoint, rate limit หรือบล็อก IP ของ Cloudflare ได้
  เป็นครั้งคราว; เมื่อดึงราคาไม่ได้ Worker จะเก็บราคาเดิมไว้และลองใหม่รอบหน้า
- Worker ตรวจได้สูงสุด 40 รายการต่อรอบ เพื่ออยู่ในขีดจำกัด Free plan
- โค้ดเดิมใน `main.py` และ workflow เก่าถูกเก็บเป็น fallback เท่านั้น; schedule
  ของ GitHub Actions ถูกปิดแล้ว ห้ามรันสองระบบพร้อมกัน

## ตั้งค่าแบบฟรี

ต้องมีบัญชี Cloudflare ฟรี และติดตั้ง Node.js ที่มาพร้อม `npm` ไว้ใช้เฉพาะตอน
deploy (ไม่ต้องเปิดเครื่องหลัง deploy)

1. ติดตั้ง dependencies และ login:

   ```powershell
   npm install
   npx wrangler login
   npx wrangler d1 create shopee-tracker
   ```

2. นำ `database_id` ที่คำสั่งคืนมาใส่ใน `wrangler.toml` และเติมค่า ID ทั้งหมด:
   `APPLICATION_ID`, `DISCORD_GUILD_ID`, `INPUT_CHANNEL_ID`, `UPDATE_CHANNEL_ID`
   และแนะนำให้ใส่ `OWNER_USER_ID` เพื่อจำกัดให้ใช้ได้คนเดียว

3. ตั้งค่า secrets โดยคำสั่งต่อไปนี้จะถามค่าโดยไม่บันทึกลง Git:

   ```powershell
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put SHOPEE_COOKIE
   ```

   `SHOPEE_COOKIE` ไม่บังคับ แต่ช่วยได้เมื่อ Shopee ปฏิเสธคำขอ

4. สร้างตารางและ deploy:

   ```powershell
   npm run db:init
   npm run deploy
   ```

5. คัดลอก URL ที่ deploy ได้ (เช่น `https://shopee-price-tracker.<subdomain>.workers.dev`)
   ไปใส่ใน Discord Developer Portal → **General Information** → **Interactions
   Endpoint URL**. Discord จะส่ง PING เพื่อตรวจสอบโดยอัตโนมัติ

6. เพิ่ม scope `applications.commands` ให้บอทใน OAuth2 URL Generator แล้วเชิญบอท
   เข้า server อีกครั้งถ้ายังไม่มี scope นี้ จากนั้นลงทะเบียนคำสั่งเฉพาะ server:

   ```powershell
   $env:DISCORD_BOT_TOKEN = Read-Host "Discord bot token"
   $env:APPLICATION_ID = "ใส่ Application ID"
   $env:DISCORD_GUILD_ID = "ใส่ Server ID"
   npm run register-command
   Remove-Item Env:DISCORD_BOT_TOKEN
   ```

เมื่อคำสั่งปรากฏใน Discord ให้ใช้ในห้องรับลิงก์:

```text
/track url:https://shopee.co.th/...
```

บอทจะตอบ `กำลังเริ่มติดตาม…` ทันที และส่งผลการเริ่มติดตามไปที่ห้อง update-price

## สิทธิ์ Discord

บอทต้องมี View Channel, Send Messages และ Embed Links ในห้อง update-price และ
View Channel กับ Send Messages ในห้องรับลิงก์. รูปแบบ Slash Command ไม่ต้องเปิด
Message Content Intent เพราะไม่ได้อ่านข้อความธรรมดาแล้ว.
