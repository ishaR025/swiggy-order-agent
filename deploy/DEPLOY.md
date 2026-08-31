# Deploying to a VPS

These steps assume a small Ubuntu/Debian VPS (e.g. a $5-6/mo DigitalOcean droplet,
Hetzner CX box, or similar) reachable over SSH, chosen because this bot needs to stay
online continuously - a laptop that sleeps or reboots will miss group messages and can
destabilize the linked WhatsApp session.

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

Edit `.env`:
- `ANTHROPIC_API_KEY` - your Anthropic API key.
- `ADMIN_TOKEN_SECRET` - generate with `openssl rand -hex 32`, keep it secret.
- `WHATSAPP_GROUP_JID` - leave blank for now, filled in the next step.
- Leave `ADMIN_PORT`, `DB_PATH`, `WHATSAPP_AUTH_DIR` as default unless you have a reason to change them.

## 3. Link WhatsApp and find the group JID

```bash
npm run group-setup
```

Scan the printed QR code with WhatsApp on your phone (Linked Devices -> Link a Device).
Once connected, it prints every group you're in with its JID - copy the one for your
household group into `WHATSAPP_GROUP_JID` in `.env`.

## 4. First Swiggy login

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
is bound to `127.0.0.1` on the VPS by default - reach it over an SSH tunnel
(`ssh -L 8787:localhost:8787 bot@<vps-ip>`) rather than exposing it publicly, or add a
firewall rule scoped to your own IP if you'd rather curl it directly.

You'll need to repeat this step every 5 days (Swiggy tokens don't refresh) - the bot
posts a warning in the WhatsApp group when a token is close to expiring or already gone.

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

## 6. Verify end-to-end

Post a real message in the WhatsApp group (e.g. "get milk and eggs"), confirm the bot
resolves and posts a cart, react 👍, and check `pm2 logs` plus the real Swiggy account
for the placed order.

## Restarting / updating

```bash
git pull   # or re-upload changed files
npm install
npm run build
pm2 restart swiggy-order-agent
```

`WHATSAPP_AUTH_DIR` and `DB_PATH` persist across restarts and deploys - don't delete
them unless you intend to re-scan the WhatsApp QR code or reset the ledger.
