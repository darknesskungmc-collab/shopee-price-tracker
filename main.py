import json
import os
import random
import re
import time
import urllib.parse
from curl_cffi import requests as cffi_requests
import requests

# ดึงค่าจาก GitHub Secrets
DISCORD_BOT_TOKEN = os.getenv("BOT_TOKEN")
INPUT_CHANNEL_ID = os.getenv("CHATBOT_SHOPEE")
ALERT_CHANNEL_ID = os.getenv("UPDATE_PRICE")
SHOPEE_COOKIE = os.getenv("SHOPEE_COOKIE", "")

DB_FILE = "tracked_items.json"
DISCORD_API_BASE = "https://discord.com/api/v10"


def get_discord_headers() -> dict:
    return {
        "Authorization": f"Bot {DISCORD_BOT_TOKEN}",
        "Content-Type": "application/json",
    }


def get_shopee_headers() -> dict:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Referer": "https://shopee.co.th/",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
        "X-Requested-With": "XMLHttpRequest",
    }
    if SHOPEE_COOKIE:
        headers["Cookie"] = SHOPEE_COOKIE
    return headers

def load_db() -> dict:
    if not os.path.exists(DB_FILE):
        return {}
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_db(data: dict):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def extract_shop_and_item_id(url: str) -> tuple[str | None, str | None, str]:
    """แปลงลิงก์สั้นให้เป็นลิงก์เต็ม และแกะ shop_id กับ item_id"""
    final_url = url
    try:
        resp = cffi_requests.get(
            url,
            headers=get_shopee_headers(),
            impersonate="chrome",
            allow_redirects=True,
            timeout=15,
        )
        final_url = str(resp.url)
    except Exception as e:
        print(f"[Warning] ไม่สามารถตาม Redirect ลิงก์ได้: {e}")

    # รูปแบบที่ 1: shopee.co.th/...-i.{shop_id}.{item_id}
    match = re.search(r"i\.(\d+)\.(\d+)", final_url)
    if match:
        return match.group(1), match.group(2), final_url

    # รูปแบบที่ 2: shopee.co.th/product/{shop_id}/{item_id}
    match_prod = re.search(r"/product/(\d+)/(\d+)", final_url)
    if match_prod:
        return match_prod.group(1), match_prod.group(2), final_url

    return None, None, final_url


def fetch_shopee_item(shop_id: str, item_id: str) -> dict | None:
    """ดึงข้อมูลสินค้าผ่าน Shopee Internal Endpoint API และมีแผนสำรองผ่าน LD+JSON"""
    api_url = (
        f"https://shopee.co.th/api/v4/item/get?itemid={item_id}&shopid={shop_id}"
    )
    clean_url = f"https://shopee.co.th/product/{shop_id}/{item_id}"

    try:
        resp = cffi_requests.get(
            api_url,
            headers=get_shopee_headers(),
            impersonate="chrome",
            timeout=15,
        )
        if resp.status_code == 200:
            json_data = resp.json()
            data = json_data.get("data")
            if data and data.get("name"):
                # ราคาใน Internal API ต้องนำมาหารด้วย 100,000 เสมอ
                raw_price = data.get("price_min") or data.get("price") or 0
                price = float(raw_price) / 100000.0

                # ประกอบลิงก์รูปภาพสินค้า
                image_hash = data.get("image", "")
                image_url = (
                    f"https://down-th.img.susercontent.com/file/{image_hash}"
                    if image_hash
                    else ""
                )

                # ดึงชื่อตัวเลือกสินค้า (ถ้ามี)
                models = data.get("models", [])
                variant_name = "มาตรฐาน"
                if models and isinstance(models, list):
                    cheapest_model = min(
                        models, key=lambda m: m.get("price", raw_price)
                    )
                    variant_name = cheapest_model.get("name") or "มาตรฐาน"

                return {
                    "shop_id": str(shop_id),
                    "item_id": str(item_id),
                    "title": data.get("name", "สินค้า Shopee"),
                    "price": price,
                    "variant": variant_name,
                    "image_url": image_url,
                    "url": clean_url,
                }
    except Exception as e:
        print(f"[Error] ดึงข้อมูลจาก Endpoint API ไม่สำเร็จ ({item_id}): {e}")

    try:
        html_resp = cffi_requests.get(
            clean_url,
            headers=get_shopee_headers(),
            impersonate="chrome",
            timeout=15,
        )
        if html_resp.status_code == 200:
            matches = re.findall(
                r'<script type="application/ld\+json">(.*?)</script>',
                html_resp.text,
                re.DOTALL,
            )
            for m in matches:
                ld_data = json.loads(m)
                if ld_data.get("@type") == "Product":
                    offers = ld_data.get("offers", {})
                    raw_p = (
                        offers.get("lowPrice")
                        or offers.get("price")
                        or 0
                    )
                    price = float(raw_p)
                    if price > 0:
                        img = ld_data.get("image", "")
                        if isinstance(img, list) and img:
                            img = img[0]
                        return {
                            "shop_id": str(shop_id),
                            "item_id": str(item_id),
                            "title": ld_data.get("name", "สินค้า Shopee"),
                            "price": price,
                            "variant": "มาตรฐาน",
                            "image_url": img,
                            "url": clean_url,
                        }
    except Exception as e:
        print(f"[Error] แผนสำรอง LD+JSON ล้มเหลว ({item_id}): {e}")

    return None

def get_recent_messages(channel_id: str, limit: int = 20) -> list:
    url = f"{DISCORD_API_BASE}/channels/{channel_id}/messages?limit={limit}"
    resp = requests.get(url, headers=get_discord_headers(), timeout=15)
    if resp.status_code == 200:
        return resp.json()
    print(f"[Error] ไม่สามารถดึงข้อความจาก Discord ได้: {resp.status_code} {resp.text}")
    return []


def add_reaction(channel_id: str, message_id: str, emoji: str = "✅"):
    encoded_emoji = urllib.parse.quote(emoji)
    url = (
        f"{DISCORD_API_BASE}/channels/{channel_id}/messages/"
        f"{message_id}/reactions/{encoded_emoji}/@me"
    )
    requests.put(url, headers=get_discord_headers(), timeout=15)


def send_text_message(channel_id: str, content: str):
    url = f"{DISCORD_API_BASE}/channels/{channel_id}/messages"
    payload = {"content": content}
    requests.post(url, headers=get_discord_headers(), json=payload, timeout=15)


def send_price_drop_alert(item_data: dict, old_price: float, new_price: float):
    """สร้างและส่งการ์ดแจ้งเตือนเมื่อราคาลดลงไปยังห้อง #แจ้งเตือน-ราคาลด"""
    initial_price = item_data.get("initial_price", old_price)
    drop_amount = old_price - new_price
    drop_percent = int((drop_amount / old_price) * 100) if old_price > 0 else 0
    total_drop = initial_price - new_price

    voucher_url = "https://shopee.co.th/m/free-shipping"
    product_url = item_data["url"]

    embed = {
        "title": f"🔻 ราคาลดแล้ว! | {item_data['title'][:200]}",
        "url": product_url,
        "color": 15022389,
        "description": (
            f"**ตัวเลือก:** {item_data.get('variant', 'มาตรฐาน')}\n\n"
            f"ราคาเดิม: ~~฿{old_price:,.0f}~~\n"
            f"🔥 **ราคาใหม่: ฿{new_price:,.0f}**\n\n"
            f"📉 **ถูกลง ฿{drop_amount:,.0f} ({drop_percent}%)**\n"
            f"*(ถูกกว่าตอนที่คุณเพิ่ม ฿{total_drop:,.0f})*\n\n"
            f"👉 **[🎟 เก็บโค้ดลดก่อนสั่งซื้อ]({voucher_url})** | "
            f"**[🛒 ซื้อเลย]({product_url})**"
        ),
        "footer": {"text": "Shopee Price Tracker Bot"},
    }

    if item_data.get("image_url"):
        embed["image"] = {"url": item_data["image_url"]}

    payload = {
        "content": "🚨 **แจ้งเตือนสินค้าลดราคา!**",
        "embeds": [embed],
    }

    url = f"{DISCORD_API_BASE}/channels/{ALERT_CHANNEL_ID}/messages"
    resp = requests.post(
        url, headers=get_discord_headers(), json=payload, timeout=15
    )
    if resp.status_code not in (200, 201):
        print(f"[Error] ส่งการ์ดแจ้งเตือนไม่สำเร็จ: {resp.text}")

def process_input_channel(db: dict):
    """กวาดอ่านข้อความในห้อง #เพิ่ม-ลบ-สินค้า เพื่อเพิ่มหรือลบรายการ"""
    messages = get_recent_messages(INPUT_CHANNEL_ID, limit=20)
    url_pattern = r"(https?://(?:s\.shopee\.co\.th|shp\.ee|shopee\.co\.th)/\S+)"

    for msg in reversed(messages):
        if msg.get("author", {}).get("bot"):
            continue

        reactions = msg.get("reactions", [])
        already_processed = any(
            r.get("emoji", {}).get("name") == "✅" and r.get("me")
            for r in reactions
        )
        if already_processed:
            continue

        content = msg.get("content", "").strip()
        urls = re.findall(url_pattern, content)
        if not urls:
            continue

        target_url = urls[0]
        is_delete_cmd = content.startswith("ลบ") or content.lower().startswith("delete")

        shop_id, item_id, _ = extract_shop_and_item_id(target_url)
        if not shop_id or not item_id:
            send_text_message(
                INPUT_CHANNEL_ID,
                f"⚠️ ไม่สามารถแกะรหัสสินค้าจากลิงก์นี้ได้ครับ: {target_url}",
            )
            add_reaction(INPUT_CHANNEL_ID, msg["id"], "✅")
            continue

        key = f"{shop_id}_{item_id}"

        if is_delete_cmd:
            if key in db:
                removed_title = db[key]["title"]
                del db[key]
                send_text_message(
                    INPUT_CHANNEL_ID,
                    f"🗑️ ลบรายการ **{removed_title}** ออกจากระบบติดตามแล้วครับ",
                )
            else:
                send_text_message(
                    INPUT_CHANNEL_ID,
                    "ℹ️ ไม่พบสินค้านี้ในรายการติดตามครับ",
                )
            add_reaction(INPUT_CHANNEL_ID, msg["id"], "✅")
            continue

        item_info = fetch_shopee_item(shop_id, item_id)
        if item_info and item_info["price"] > 0:
            db[key] = {
                "shop_id": shop_id,
                "item_id": item_id,
                "title": item_info["title"],
                "variant": item_info["variant"],
                "url": item_info["url"],
                "image_url": item_info["image_url"],
                "initial_price": item_info["price"],
                "current_price": item_info["price"],
            }
            add_reaction(INPUT_CHANNEL_ID, msg["id"], "✅")
            send_text_message(
                INPUT_CHANNEL_ID,
                f"✅ **บันทึกสินค้าเรียบร้อย!**\n"
                f"📦 **{item_info['title'][:100]}**\n"
                f"💰 ราคาเริ่มต้น: **฿{item_info['price']:,.0f}**",
            )
        else:
            send_text_message(
                INPUT_CHANNEL_ID,
                f"❌ ดึงข้อมูลราคาจาก Shopee ไม่สำเร็จสำหรับรหัส `{key}` (อาจติดการบล็อกชั่วคราว)",
            )

        time.sleep(random.uniform(2, 4))


def check_all_tracked_items(db: dict):
    """วนลูปเช็กราคาสินค้าทุกชิ้นในฐานข้อมูล"""
    if not db:
        print("ยังไม่มีรายการสินค้าใน tracked_items.json")
        return

    for key, item in list(db.items()):
        shop_id = item["shop_id"]
        item_id = item["item_id"]
        old_price = float(item["current_price"])

        print(f"กำลังเช็กราคา: {item['title'][:50]}...")
        latest_info = fetch_shopee_item(shop_id, item_id)

        if latest_info and latest_info["price"] > 0:
            new_price = latest_info["price"]

            item["title"] = latest_info["title"]
            item["variant"] = latest_info["variant"]
            if latest_info.get("image_url"):
                item["image_url"] = latest_info["image_url"]

            if new_price < old_price:
                print(f"🔻 ราคาลดลง! เดิม {old_price} -> ใหม่ {new_price}")
                send_price_drop_alert(item, old_price, new_price)

            item["current_price"] = new_price

        time.sleep(random.uniform(3, 7))


def main():
    if not all([DISCORD_BOT_TOKEN, INPUT_CHANNEL_ID, ALERT_CHANNEL_ID]):
        raise ValueError(
            "กรุณาตั้งค่า DISCORD_BOT_TOKEN, DISCORD_INPUT_CHANNEL_ID และ DISCORD_ALERT_CHANNEL_ID ใน GitHub Secrets ให้ครบถ้วน"
        )

    db = load_db()

    process_input_channel(db)

    check_all_tracked_items(db)

    save_db(db)
    print("ทำงานเสร็จสิ้นและอัปเดตฐานข้อมูลเรียบร้อยแล้ว!")


if __name__ == "__main__":
    main()