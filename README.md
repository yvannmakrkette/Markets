# Y2 Markets (y2markets.site)

A trading platform with an Angular front end and a Node/Express back end. It offers fixed-time trades on live Binance crypto and 24/7 OTC instruments, CFD positions, M-Pesa deposits and payouts, bonuses, tournaments, signals, social copy trading, support chat and an admin console.

```
Y2 trades/
├─ backend/    Node 20+ · Express 5 · TypeScript · Socket.IO · Mongoose (replica set) · Zod · JWT
└─ frontend/   Angular 22 (standalone, signals, @if/@for) · SCSS · lightweight-charts · socket.io-client
```

The two folders are independent projects: each has its own `npm install` and its own `npm start`.

---

## 1. Run it locally (Windows / PowerShell)

Requirements: **Node.js 20 or newer** (tested on Node 24). Docker is optional.

```powershell
# Terminal 1: API on http://localhost:4000
cd "C:\Y2 trades\backend"
npm install
Copy-Item .env.example .env        # first time only
npm start

# Terminal 2: web app on http://localhost:4200
cd "C:\Y2 trades\frontend"
npm install
npm start
```

Open **http://localhost:4200**.

* **Database:** with `MONGO_URI` empty, the backend starts an embedded MongoDB replica set and keeps its data in `backend/.data/mongo`. The first start downloads `mongod` (about 600 MB, one time only).
  * To use Docker instead, run `docker compose up -d` in `backend/`, then set `MONGO_URI=mongodb://localhost:27017/y2markets?replicaSet=rs0&directConnection=true`.
* **Admin login:** `admin@y2markets.site` / `Admin@12345` (set in `.env`). Change this password immediately.
* **Demo traders for Social Trading:** run `npm run seed` in `backend/`. It creates `amina_fx`, `brian_trades` and `grace_m`, each with password `Password123`.
* **Development mode:** `npm run dev` in `backend/` restarts the API when files change.
* **M-Pesa in development:** with `MPESA_SIMULATE=true`, STK pushes and B2C payouts complete automatically after a few seconds.
* **E-mail in development:** e-mails (verification, password reset) are printed to the backend console until you set `SMTP_*`.

### Tests

```powershell
cd "C:\Y2 trades\backend"
npm test            # unit tests (OTC isolation, settlement maths, CFD, bonus terms, candles, helpers)
npm run typecheck
npm run smoke       # end-to-end API test against the running server: register → trade → settle →
                    # M-Pesa deposit + bonus + Trader's Box → cancel bonus → admin audit → CFD
```

---

## 2. What is implemented

| Area | Highlights |
|---|---|
| Loader | Five glowing candlesticks with a shimmering "Y2 MARKETS" wordmark; shown at boot and on slow route loads, then fades out. |
| Landing | Glass pill navbar with sliding underline; dotted world map with pulsing cities, animated arcs and live price chips (socket); mouse parallax; staggered gradient headline; markets table, features, platforms, partners, and a footer with risk warning; mobile menu. |
| Auth | Right-hand drawer with blurred background. Sign-up checks username/e-mail availability as you type (debounced), shows a password strength meter, prefills the referrer from `?ref=`, and requires accepting the terms. Also: login, forgot/reset password, 2FA (TOTP). JWT access token (15 min) plus a rotating httpOnly refresh cookie (7 days) with reuse detection; silent refresh interceptor; route guards. Registration creates DEMO ($10,000) and REAL ($0) accounts. |
| Market engine | Live Binance trade stream (sampled every 250 ms). OTC prices come from a secret-seeded, mean-reverting random walk in `market/otc-generator.ts`, which imports nothing from the app (a test enforces this). Every tick is stored in a time-series collection. Candles are built from memory, the database, or Binance klines. Socket rooms are per symbol. |
| Trading | The server uses its own latest tick as the open price (any client price is ignored). Each order carries an idempotency key. Debit, trade record and ledger entry are written in one transaction. The settlement worker closes trades from recorded ticks, stores the tick ids used, and pushes the result over the socket. Also: crowd sentiment, pending trades, copy trading, AI signal assistant. |
| Terminal | Top bar (pins, dismissible promos, DEMO/REAL/tournament switcher with animated balance, Top up, avatar menu with background picker), left sidebar with OTC/CFD popover, right rail (Classic/Pro, Trades, Signals, Social, Pending), scenic background. On mobile: bottom navigation and bottom sheets. |
| Chart | Area/line/candles/bars; smooth tick interpolation; glowing line; live price pill; expiration line with flag; open trades with entry line and countdown; hover zone preview; sentiment bar; SMA/EMA/Bollinger; horizontal and trend lines; crosshair; M2-style visible window; time-zone clock. |
| Trades panel | Opened/Closed tabs with sliding underline, countdown rings, win/loss flash, virtual scrolling with lazy loading, and a detail sheet with a tick-by-tick replay chart. |
| Onboarding | Welcome modal with rotating globe → "Good luck" cards → guided tour using a custom spotlight engine that animates between elements. Progress is saved per user; the tour can be restarted from Help. |
| CFD | Market and by-price orders, lots, leverage margin, SL/TP, stop-out at 95% of margin, positions/orders/history, equity and margin footer, close all / winning / losing. |
| Finance | Three-step deposit flow (method → details → process), M-Pesa Daraja STK Push with live status, USDT with tx-hash review, sandbox card. Withdrawals need a verified e-mail, hold funds immediately, go to admin approval, and pay out via B2C. History with filters and CSV export. |
| Bonuses | Bonus funds are kept separate from deposits. Full terms are shown before opt-in, turnover progress is visible, and bonuses can be cancelled anytime. The Trader's Box draw uses `crypto.randomInt`, with the odds and every roll recorded. |
| Other | Profile (details, KYC upload, password, 2FA, sessions), Referrals (link, statistics, commissions), trading History, Help/FAQ, support Chat, Tournaments (join, leaderboard, automatic prize payout), Signals (with honest accuracy), Social Trading (copy). |
| Admin | Dashboard, users (block/role, audited balance adjustments), KYC review with document viewer, deposit and withdrawal approvals, assets/payouts/CFD settings, bonus config, ledger, trade audit (re-derives the result from stored ticks and replays it), support inbox, tournaments. |

**Money rules:** all amounts are integer cents. Every balance change goes through `services/ledger.service.ts`, which runs inside a MongoDB transaction, guards against negative balances atomically, and writes a `LedgerEntry`.

---

## 3. Configuration

All settings are in `backend/.env` (see `.env.example`). The most important ones:

| Variable | Purpose |
|---|---|
| `MONGO_URI` | Replica-set connection string (required in production). |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OTC_SEED`, `MPESA_CALLBACK_SECRET` | Long random secrets. The server **refuses to start in production** if they are weak or still the defaults. |
| `APP_URL`, `API_PUBLIC_URL`, `CORS_ORIGINS` | Public URLs (`https://y2markets.site`). |
| `COOKIE_SECURE=true` | Required behind HTTPS. |
| `MPESA_*` | Daraja credentials. Set `MPESA_SIMULATE=false` to call Safaricom. |
| `SANDBOX_PAYMENTS=false` | Disables the simulated card processor in production. |
| `USDT_*_ADDRESS` | Your company wallets. |
| `SMTP_*` | Mail server for verification and reset e-mails. |

Generate a secret in PowerShell:

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
```

### M-Pesa Daraja sandbox

1. Create an app at https://developer.safaricom.co.ke and copy the Consumer Key and Secret.
2. Sandbox values are already in `.env.example` (`MPESA_SHORTCODE=174379` and the sandbox passkey).
3. Callbacks must reach your API over HTTPS. For local testing, run `ngrok http 4000` and set `API_PUBLIC_URL` to the ngrok URL.
4. Set `MPESA_SIMULATE=false` and restart the backend.
5. For B2C payouts, also set `MPESA_B2C_SHORTCODE`, `MPESA_B2C_INITIATOR` and `MPESA_B2C_SECURITY_CREDENTIAL` (the initiator password encrypted with the Safaricom certificate).

---

## 4. Deploying to y2markets.site (Ubuntu 22.04/24.04 VPS)

1. **DNS:** point `y2markets.site` and `www.y2markets.site` (A records) to the server's IP address.
2. **Install Node and nginx:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs nginx
   sudo npm i -g pm2
   ```
3. **Database:** use MongoDB Atlas (it runs as a replica set by default) or `docker compose up -d` from `backend/`. Put the connection string in `MONGO_URI`.
4. **Backend:**
   ```bash
   cd /srv/y2markets/backend
   npm ci
   cp .env.example .env    # then edit: production values and secrets
   npm run build
   pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup
   ```

## 5. MongoDB migration and storage

The backend keeps one-second Binance and OTC prices in memory for live trading, while persisting historical tick samples every five seconds. Persisted ticks expire after one day by default; user, trade, account, deposit, withdrawal, wallet, KYC metadata, and ledger collections do not use that expiry. Ticks referenced directly by trade and CFD records are persisted even between history samples.

Binance instruments use Binance's public market-data-only REST and WebSocket endpoints. If the WebSocket is unavailable, the backend falls back to polling REST prices. If `BINANCE_WS_URL` or `BINANCE_REST_URL` is set directly in Render, use the values in `backend/.env.example`; dashboard variables override code defaults.

To copy application data to a separate MongoDB cluster, put the current cluster URI in `backend/.env` as `MONGO_URI` and the destination URI as `MIGRATION_NEW_URI`. Both URIs must point to the `y2markets` database, and the destination must be a different, empty cluster. Stop the live backend to prevent writes during the final copy. From `backend/`, review the collection counts with:

```powershell
npx tsx scripts/migrate-user-data.ts
```

Then run the copy:

```powershell
npx tsx scripts/migrate-user-data.ts --execute
```

The script copies every non-system collection except `ticks`, preserves document IDs and indexes, and leaves the source untouched. It refuses a non-empty destination; use `--resume` only after a partial migration. After checking the destination counts and app login/history, change the deployed service's `MONGO_URI` to the destination URI and restart it. Historical trade and wallet records remain available, while tick-by-tick chart replay older than the new cluster's retained tick window will not.

KYC document records are copied, but any files referenced by those records must also be moved from the configured `UPLOAD_DIR` (or its persistent file store) separately.
   Key production values: `NODE_ENV=production`, `APP_URL=https://y2markets.site`, `API_PUBLIC_URL=https://y2markets.site`, `CORS_ORIGINS=https://y2markets.site`, `COOKIE_SECURE=true`.
5. **Frontend:**
   ```bash
   cd /srv/y2markets/frontend
   npm ci
   npm run build
   sudo mkdir -p /var/www/y2markets
   sudo cp -r dist/client/browser/* /var/www/y2markets/
   ```
6. **nginx and HTTPS:**
   ```bash
   sudo cp /srv/y2markets/backend/deploy/nginx.conf /etc/nginx/sites-available/y2markets
   sudo ln -s /etc/nginx/sites-available/y2markets /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo apt-get install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d y2markets.site -d www.y2markets.site
   ```
7. **Point Safaricom at the live API:** your callback URLs become `https://y2markets.site/api/payments/mpesa/<MPESA_CALLBACK_SECRET>/stk` (and `/b2c/result`, `/b2c/timeout`).

The API runs as a **single instance**. The settlement, pending-order, CFD and tournament workers are safe against double payment (every payout is a conditional status change inside a transaction). They are designed to run in one process, so don't scale horizontally without first moving the workers to a dedicated process.

### Production checklist

- [ ] Strong secrets, and `COOKIE_SECURE=true`.
- [ ] `MPESA_SIMULATE=false` and `SANDBOX_PAYMENTS=false`.
- [ ] Admin password changed and 2FA enabled on admin accounts.
- [ ] MongoDB backups (Atlas backups or `mongodump` via cron).
- [ ] `uploads/` (KYC documents) on persistent disk and included in backups.
- [ ] Legal texts in `frontend/src/app/features/landing/legal.component.ts` reviewed by a lawyer.
- [ ] **Licensing:** offering fixed-time trades or CFDs to the public is regulated in most countries. In Kenya this falls under the Capital Markets Authority (CMA). Get the required licence before accepting real deposits.

---

## 4. Hosting: Frontend on Cloudflare Pages & Backend on Render

### A. Deploy Frontend to Cloudflare Pages
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
2. Select your repository: `laalysweed/laalysweed`.
3. Set the build configuration:
   - **Framework preset**: `None` (or `Angular`)
   - **Root directory**: `frontend`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist/client/browser`
   - **Environment variables**:
     - `NODE_VERSION`: `20` (or `22`)
4. **API URL Connection**:
   - In `frontend/src/index.html`, set your Render backend URL:
     ```html
     <script>
       window.__API_URL__ = 'https://your-backend-name.onrender.com';
     </script>
     ```
   - Cloudflare Pages will automatically serve `dist/client/browser/_redirects` to handle client-side Angular routing for all sub-routes (`/app/trading`, `/admin`, etc.).

### B. Deploy Backend to Render
1. Go to [Render Dashboard](https://dashboard.render.com/) → **New +** → **Blueprint** (or **Web Service**).
2. Connect your repository: `laalysweed/laalysweed`.
3. If using **Blueprint**, Render will automatically detect the root [`render.yaml`](./render.yaml).
4. If setting up manually as a **Web Service**:
   - **Runtime**: `Node`
   - **Root Directory**: `backend`
   - **Build Command**: `npm install --include=dev && npm run build`
   - **Start Command**: `npm run start:prod`
   - **Environment Variables**:
     - `NODE_ENV`: `production`
     - `PORT`: `10000` (or leave default assigned by Render)
     - `MONGO_URI`: `mongodb+srv://...` (your MongoDB Atlas connection string with replica set)
     - `APP_URL`: `https://your-project.pages.dev` (your Cloudflare Pages domain)
     - `API_PUBLIC_URL`: `https://your-backend-name.onrender.com`
     - `CORS_ORIGINS`: `https://your-project.pages.dev`
     - `JWT_ACCESS_SECRET`: (at least 32 random characters)
     - `JWT_REFRESH_SECRET`: (at least 32 random characters)
     - `OTC_SEED`: (at least 16 random characters)
     - `BINANCE_ENABLED`: `true`
     - `MPESA_ENV`: `sandbox` (or `production`)
