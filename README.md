# Penthouse Dashboard

A members-only website dashboard for Solana memecoin traders, behind a crypto paywall. There is no Discord bot and no AI chat.

**What it does**
- Tracks your wallet list (`data/wallets.json`, 2,330 wallets) and keeps a roster of who is active, benched or a candidate.
- Finds new winning tokens (pump.fun, Meteora, StonkFun/LaunchLab), nominates their devs and traders, and rotates wallets in and out based on recent performance.
- Detects which narratives ("metas") are running, such as animals or GTA 6.
- Shows all of it on a website with tabs: Metas, Wallets, Live buys, Devs, Winners, Roster.
- Visitors sign in with Discord, then pay in USDC or SOL to unlock it.

## Setup

**1. Accounts**
- Helius (helius.dev): API key for `HELIUS_API_KEY`. The first ingest makes thousands of calls, so a paid plan is likely needed.
- Discord application (discord.com/developers/applications): used for login only. OAuth2 tab: copy Client ID and Client Secret, and add the redirect `https://YOUR-DOMAIN/callback` (use `http://localhost:3000/callback` to test). Do not create a bot.
- A Solana wallet you control to receive payments (`TREASURY_WALLET`). The server only watches it and never holds a key.
- A host that keeps a process running **with a persistent disk** (Railway, Render, Fly.io or a VPS) and a domain with HTTPS. The database is a file, so a host that wipes its disk would lose every subscriber and payment record.

**2. Configure**
```
cp .env.example .env     # fill it in
npm install              # Node 18+
```
Required: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `SESSION_SECRET` (a long random string), `HELIUS_API_KEY`, `TREASURY_WALLET`, and your own Discord user ID in `ADMIN_DISCORD_IDS`.
Set `DISCORD_GUILD_ID` only if you use `REQUIRE_MEMBER=1` or `ACCESS_ROLE_IDS`. To get IDs, turn on Developer Mode in Discord and right-click.
Set `NODE_ENV=production` and `AUTO_CYCLE=1` on the host. Leave `ROSTER_WEBHOOK_URL` and `META_WEBHOOK_URL` empty, or they post paid data into Discord.

Also set `DISCORD_INVITE_URL` (your server invite, like `https://discord.gg/yourcode`) so the front page's Join buttons work.

**Front page.** `public/index.html` is served at `/`: hero, what's inside, a dashboard preview, pricing, how to get in, and FAQ. Its "Log in with Discord" buttons go to `/login`, then the dashboard (which shows the paywall until the visitor pays). Signed-in visitors see "Open dashboard" instead. The price and days come from `PRICE_USD` and `PERIOD_DAYS`. Edit the placeholder stats near the top of `public/index.html` (`[ 00 ]`) and the hero image `public/hero.jpg`. Its FAQ says payments are final, so change that if your refund policy differs.

**Socials and clipping.** Set `TIKTOK_URL`, `X_URL`, `INSTAGRAM_URL` and `CONTACT_EMAIL` in `.env` (Discord uses `DISCORD_INVITE_URL`). They fill the Socials section on the front page and the buttons on `/clipping`. The Clipping Program page is `public/clipping.html`. Edit its wording there, including the payout section, which is generic until you add your real rates.

The front page also has a Contact section ("Work with us" and "Work for us"). Its buttons open an email to `CONTACT_EMAIL`, or your Discord invite if that is not set. Edit the wording in `public/index.html`.

**Contact form pop-up.** "Get in touch" and "Apply" on the front page open a pop-up asking for an email (plus an optional name, a role for applicants such as Aspiring dev, and a message). Every submission is saved in the database, and if you set `CONTACT_WEBHOOK_URL` it is also posted automatically to a Discord channel of yours: in a private staff channel go to Channel settings > Integrations > Webhooks > New Webhook, copy the URL and paste it into `.env`. The post never pings @everyone or @here. Read saved messages any time with `npm run contacts`. Spam protection: a hidden field that bots fill in, a limit of 5 messages an hour per visitor and 100 an hour overall. People do not get an automatic reply, since that needs an email service.

**Clipping page videos (max 5).** Put video files (mp4 or webm) in `public/videos/`, then list them in `public/clipping-videos.json`, for example:

```json
[
  { "title": "Clip 1", "src": "/videos/clip1.mp4", "poster": "/videos/clip1.jpg" },
  { "title": "Clip 2", "src": "https://www.youtube.com/shorts/VIDEO_ID" }
]
```

`src` can be a file in `public/videos/`, an https link to a video file, or a YouTube link. Only the first 5 are shown. With an empty list the page shows 5 "Coming soon" tiles. No restart is needed after editing the list.

**My wallets.** Paying members get a "My wallets" tab where they paste their own Solana wallet addresses (with an optional label) and see each one's closed trades, win rate, realized PnL, median multiple and recent buys and sells. Each list is private to the member who made it. Member wallets are kept separate from the Penthouse roster, so they never show up in the roster leaderboard, Live buys or rotation. When someone adds a wallet the server fetches its history in the background (it needs `HELIUS_API_KEY` in the same `.env`), and the regular `npm run ingest` keeps it up to date. Each member can track `USER_WALLET_LIMIT` wallets (default 25), and `USER_WALLET_GLOBAL_CAP` (default 500) caps the total of member wallets that are not on the roster, to protect your Helius credits. A wallet nobody tracks any more has its data deleted.

**Live pings.** A bell button ("Pings") in the dashboard header shows small corner notifications when a tracked dev launches a coin, a dev buys a coin, or a trader buys or sells a coin. Members choose which kinds they want and can switch pings off (saved in their browser), and the button lists recent pings. The dashboard checks for new pings every 5 seconds while the tab is open. Pings need live data, so they use a Helius webhook that pushes the active roster's transactions to your site as they happen:

1. Your site must be public on https. In `.env` set `PUBLIC_URL=https://yourdomain.com`, `HELIUS_WEBHOOK_SECRET` (any long random string) and optionally `PING_MIN_SOL` (smallest trade to ping, default 1).
2. Restart the server, then run `npm run webhook`. It creates the Helius webhook pointing at `/webhooks/helius` and loads the active roster into it. `npm run cycle` repeats this at the end of every run, so promotions and benchings carry over.
3. Without these settings the dashboard works as before and pings stay quiet.

Pings cover only active roster wallets, and dev sells are never pinged. A dev "launch" is exact for pump.fun coins (it checks who created the coin on-chain). For other launchpads it is only counted when the transaction is an explicit token creation. Trader trades arriving by webhook are also saved, so wallet stats stay current between cycles. Each webhook delivery costs Helius credits, so check your plan if the roster is large.

**Pictures in pings.** Each ping shows the coin's picture and the wallet's photo. The coin picture comes from DexScreener when the coin has one (a brand-new coin may not yet, and then shows coloured letters). Solana wallets have no built-in profile picture, so wallet photos are uploaded by people:
- Members upload their own on the "My wallets" tab (Add photo on a wallet card). The browser shrinks it to 128 px, and only that member sees it, in My wallets, pings and the Wallets tab.
- You set photos for roster wallets with `npm run pfp -- set <wallet address> <image file>` (also `remove` and `list`). Everyone sees these. Use a png, jpeg or webp under 150 KB, ideally 128 to 256 px square. A member's own photo for the same wallet overrides yours for that member.
- Wallets without a photo get coloured initials. Photos are checked by their real file type (png, jpeg or webp only), stored in the database and served as plain images.

**3. Run**
```
npm run cycle            # first full pass: discover > ingest > metas > rotate (slow, many API calls)
npm start                # the website; with AUTO_CYCLE=1 it also reruns the cycle daily
```
Open `https://YOUR-DOMAIN/dashboard.html`.

## The cycle (`npm run cycle`)
1. **discover**: collects trending, new and launchpad pools from GeckoTerminal, marks a token a winner if it peaked above `MIN_PEAK_FDV_USD` after a `MIN_GAIN_X` run with real liquidity, then finds its creator and the wallets that profited. Creators join as active devs, traders as candidates.
2. **ingest**: pulls swap history from Helius for active, benched and candidate wallets and stores it in `data/penthouse.db`.
3. **metas**: matches token names to the themes in `data/themes.json` (edit it to add your own), surfaces unknown emerging terms, and rates each theme emerging, hot, steady or cooling from launches and volume, week over week.
4. **rotate**: an active trader is benched after a bad week or a losing month. A candidate or benched trader is promoted only after passing 2 reviews in a row (20+ closed trades in 30 days, profitable, profitable in both halves, and profitable over the last 7 days). Devs are benched after 14 days without a winning token. Every change is logged with a reason.

Individual steps: `npm run discover`, `ingest`, `metas`, `rotate`.

## Paywall
- The buyer picks USDC or SOL and gets an invoice with an exact amount that includes a few extra digits (under one cent) that identify them. SOL quotes are held for `INVOICE_MINUTES`.
- The server checks your address every 30 seconds while invoices are open, matches the transfer by asset and exact amount, and unlocks access for `PERIOD_DAYS`. Renewing adds time on top. Payments after the quote expires are still credited for 24 hours.
- Failed transactions, other tokens, transfers older than the invoice and replays are ignored.
- Admins (`ADMIN_DISCORD_IDS`) and holders of `ACCESS_ROLE_IDS` roles skip the paywall.
- If `TREASURY_WALLET` or `HELIUS_API_KEY` is missing, nobody can pay and the dashboard stays locked for everyone else. `PAYWALL_ENABLED=0` opens it to any signed-in user and is for testing only.

```
npm run billing -- list                       # subscribers, expiry, revenue
npm run billing -- unmatched                  # transfers that matched no invoice (wrong amount)
npm run billing -- grant <discordId> <days>   # credit someone manually
npm run billing -- revoke <discordId>
```
Refunds are manual from your own wallet. Decide a refund policy first. Selling access to trading data can carry legal requirements depending on where you and your customers are, so check before charging.

## Know the limits
- Trend ratings for metas stay `unrated` for the first 14 days because they need your own history.
- Wallet stats cover `DAYS_BACK` days (default 30) and up to `MAX_PAGES` x 100 swaps per wallet. Multi-token routes are skipped.
- Creator lookup is exact for pump.fun only. For Meteora and StonkFun it uses the first signer of the token, which is a guess. Check a few on Solscan.
- Dev scoring is "did a token of theirs win recently", not a full hit rate.
- Followers always get a worse fill than a tracked wallet did, and very early buyers are often insiders you cannot copy.
- The first rotation will bench many of your seed wallets. That is intended.
- The payment QR code loads a small library from cdnjs.cloudflare.com. If it fails, the copy buttons and wallet link still work.
- Information only, not financial advice.

## Growth features (added)
- **Free preview** on the landing page: Metas and top 5 wallets, delayed `PREVIEW_DELAY_HOURS` (default 24). It stays empty until the server has been collecting that long. Endpoints: `/api/public/preview`, `/api/public/called-it`.
- **"Called it" board**: coins that a roster wallet bought before the coin was logged as a 2x+ winner (wallet names are not shown publicly).
- **Plans**: monthly plus a discounted quarter (`QUARTER_DISCOUNT_PCT`). The payment amount decides how many days are credited.
- **Referrals**: each member gets a link (`/r/CODE`); the referrer receives `REFERRAL_DAYS` free days after the friend's first payment.
- **Refund line**: `REFUND_DAYS` (0 = payments are final). Only set it if you will honor it.
- **Funnel**: `npm run funnel` prints visits, logins, invoices and payments for 7 and 30 days.
- **Daily / weekly posts**: `npm run daily`, `npm run weekly` (post to `RECAP_WEBHOOK_URL`, or print the text so you can paste it into X or TikTok). Schedule with cron.
- **Beginners guide**: `/guide` (`public/guide.html`). **CSV export** of My wallets on the dashboard.
- Not built (needs a Discord bot or an email/Telegram service): DM alerts, expiry reminders, drop-off DMs, auto roles by tenure, auto-posting to X and TikTok.
- The pre-change version is saved as `penthouse-original/` (and `penthouse-original.zip`).
