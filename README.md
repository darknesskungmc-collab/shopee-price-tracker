# Shopee Price Tracker for Discord

This project runs on GitHub Actions every 15 minutes. It reads recent Shopee
links from one Discord channel, saves the products in `tracked_items.json`, and
sends an alert to another channel only when a tracked price decreases.

It is a scheduled REST integration, not a continuously connected Discord bot.
The bot can show as offline between workflow runs and will not reply instantly.

## Required GitHub Actions secrets

Create these exact repository secrets under **Settings → Secrets and variables
→ Actions**. Do not commit their values to the repository.

| Secret | Value |
| --- | --- |
| `BOT_TOKEN` | Discord application **Bot Token** |
| `CHATBOT_SHOPEE` | Numeric ID of the input channel where users post links |
| `UPDATE_PRICE` | Numeric ID of the channel that receives price alerts |
| `SHOPEE_COOKIE` | Optional Shopee browser cookie; may help if Shopee rate-limits requests |

Enable Discord Developer Mode, right-click each channel, and select **Copy
Channel ID**. A channel ID is a 17–20 digit number, not a channel name or URL.

## Discord setup

Invite the Discord application as a bot to the target server. In the channel
permissions for the bot role, enable:

| Channel | Required permissions |
| --- | --- |
| Input channel | View Channel, Read Message History, Send Messages, Add Reactions |
| Alert channel | View Channel, Send Messages, Embed Links |

After changing a secret or permission, run **Actions → Shopee Price Tracker →
Run workflow**, then read the log in **Run Shopee Tracker Script**. The script
now fails the workflow with the Discord HTTP status if its token, channel ID,
or permissions are invalid.

## Using the bot

Post one supported Shopee URL in the input channel. The bot reacts with ✅ and
posts a confirmation after it stores the item. To remove an item, post the same
URL prefixed with `ลบ` or `delete`.

Supported links include `s.shopee.co.th`, `shp.ee`, `shopee.co.th`, and
`www.shopee.co.th`. The workflow checks the 20 most recent input messages on
each run.

## Local verification

```powershell
./updateprice_bot/Scripts/python.exe -m pip install -r requirements.txt
$env:BOT_TOKEN = "..."
$env:CHATBOT_SHOPEE = "..."
$env:UPDATE_PRICE = "..."
./updateprice_bot/Scripts/python.exe main.py
```

Use a test Discord server or channels when testing. Never paste the bot token
into Actions logs, chat messages, or committed files.
