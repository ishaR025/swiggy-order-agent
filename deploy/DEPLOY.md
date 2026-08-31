# Deploying to a VPS

These steps assume a small Ubuntu/Debian VPS (e.g. a $5-6/mo DigitalOcean droplet,
Hetzner CX box, or similar) reachable over SSH, chosen because this bot needs to stay
online continuously - a laptop that sleeps or reboots will miss messages, and the
webhook Meta calls needs a stable public HTTPS endpoint, which a laptop can't reliably
offer either.

## 1. Provision the box

```bash
ssh root@<your-server-ip>
adduser bot && usermod -aG sudo bot   # don't run the bot as root
su - bot
```

Install Node.js 20+ (via nvm is easiest) and pm2:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
npm install -g pm2
```

## 2. Get the code onto the box

```bash
git clone <your-repo-url> swiggy-order-agent   # or scp the directory up
cd swiggy-order-agent
npm install
npm run build
cp .env.example .env
```

## 3. Set up the Meta side

1. Go to the [Meta App Dashboard](https://developers.facebook.com/apps), create an app,
   and add the **WhatsApp** product. This provisions a test WhatsApp Business Account and
   a test phone number - for a 2-person bot, the free tier (up to 5 allow-listed
   recipient numbers) covers this permanently, no business verification needed.
2. In the dashboard, add both flatmates' phone numbers as allow-listed recipient
   numbers.
3. Get a **permanent** access token, not the default 24h one: Business Settings ->
   System Users -> create one -> Assign Assets (your WhatsApp app) -> Generate Token
   with `whatsapp_business_messaging` and `whatsapp_business_management` permissions.
4. Fill in `.env`:
   - `ANTHROPIC_API_KEY` - your Anthropic API key.
   - `ADMIN_TOKEN_SECRET` - generate with `openssl rand -hex 32`, keep it secret.
   - `META_ACCESS_TOKEN` - the System User token from step 3.
   - `META_PHONE_NUMBER_ID` - from the dashboard's WhatsApp > API Setup page.
   - `META_APP_SECRET` - from the app's Basic Settings.
   - `META_WEBHOOK_VERIFY_TOKEN` - any string you make up now; you'll enter the same
     value in the dashboard in step 6.
   - `WHATSAPP_ALLOWED_NUMBERS` - both flatmates' numbers, comma-separated, E.164
     without `+` (e.g. `919804340701,919812345678`).

## 4. Expose the webhook over public HTTPS

Meta needs to reach `POST/GET https://<your-domain>/webhook` on this box. The simplest
route is a domain (or subdomain) pointed at the VPS's IP, with Caddy handling TLS
automatically:

```bash
sudo apt install -y caddy   # or see caddyserver.com/docs/install
```

`/etc/caddy/Caddyfile`:

```
bot.yourdomain.com {
    reverse_proxy localhost:8788
}
```

```bash
sudo systemctl reload caddy
```

(`8788` is `META_WEBHOOK_PORT`'s default - only this port needs to be reverse-proxied
publicly. `ADMIN_PORT` (8787) must stay off the public internet - see step 7.)

## 5. Start it under pm2

```bash
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed instructions to survive a VPS reboot
```

Check it's alive:

```bash
pm2 logs swiggy-order-agent
curl http://localhost:8787/health   # -> "ok"
```

## 6. Register the webhook with Meta

In the Meta App Dashboard, WhatsApp > Configuration > Webhook:
- Callback URL: `https://bot.yourdomain.com/webhook`
- Verify token: the same value as `META_WEBHOOK_VERIFY_TOKEN` in `.env`
- Subscribe to the `messages` field.

Meta immediately sends a verification GET request - `pm2 logs` should show no errors,
and the dashboard should show it as verified.

## 7. First Swiggy login

Run this on **your own laptop**, not the VPS - it needs an interactive browser for the
phone+OTP step, which a headless server doesn't have:

```bash
npm run swiggy-login
```

This saves tokens to your laptop's local DB. Push them to the VPS instead of copying the
DB file (the DB also holds the ledger and schedules, which you don't want to clobber):

```bash
# food
curl -X PUT http://<vps-ip>:8787/admin/token \
  -H "Authorization: Bearer <ADMIN_TOKEN_SECRET from .env>" \
  -H "Content-Type: application/json" \
  -d '{"service":"food","accessToken":"<token>","expiresAt":"<ISO timestamp>"}'

# instamart - same, with service:"instamart" and its own token
```

(`npm run swiggy-login` prints both tokens and their expiry timestamps.) The admin port
is bound to `127.0.0.1` on the VPS - reach it over an SSH tunnel
(`ssh -L 8787:localhost:8787 bot@<vps-ip>`) rather than exposing it publicly, or add a
firewall rule scoped to your own IP if you'd rather curl it directly. Unlike the webhook
port, **never** put this one behind the public reverse proxy.

You'll need to repeat this step every 5 days (Swiggy tokens don't refresh) - the bot
DMs both of you a warning when a token is close to expiring or already gone.

## 8. Verify end-to-end

DM the bot's WhatsApp number (e.g. "get milk and eggs"), confirm it resolves and sends
back a cart, react 👍, and check `pm2 logs` plus the real Swiggy account for the placed
order.

## Restarting / updating

```bash
git pull   # or re-upload changed files
npm install
npm run build
pm2 restart swiggy-order-agent
```

`DB_PATH` persists across restarts and deploys - don't delete it unless you intend to
reset the ledger, schedules, and stored Swiggy tokens.
