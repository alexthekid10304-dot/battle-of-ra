# Battle of Rah — PUBLIC Live Scoreboard

**Game:** November 7, 2026 at 3:30 PM, Egyptian Eagles vs. Nile Vipers.

This folder is the **web-only edition**, with no native iPhone app required. It contains the same complete poster, 30-person roster, captain badges, game clock, individual player stats, 60 penalty types, field goals/PATs, kickoffs and punts from the original site. A Node.js backend broadcasts score and play changes to every viewer connected to the hosted address.

## Easiest launch: Railway

1. Upload this entire folder (all files) to a **private GitHub repository**. If using the Railway app connected to ChatGPT, connect Railway first, then ask to deploy this website. Publishing requires access to your own hosting account.
2. In [Railway](https://railway.com/), create a project from your repository and choose Deploy.
3. In the **Variables** tab set:

   - `NODE_ENV` = `production`
   - `ADMIN_PASSCODE` = a secret private password (you previously chose `6387`, but a longer private code is safer when public)
   - `DATA_DIR` = `/data`

4. Add a **persistent volume** to the Node web service, mounted at `/data`. Do **not** skip this: it keeps scores and play history across restarts and redeploys.
5. In Railway Networking, generate a **public HTTPS domain**. Open it on your phone and another phone. Both should see the same game.
6. On your phone tap **Scorekeeper Login**, enter the private password, and update a score or record a play. The other phone should reflect it without manually refreshing.

**Important:** The site cannot become public until it is actually deployed to a hosting account. The downloaded HTML file by itself saves locally on that phone and cannot live-sync with other devices. If deploying during game day, do a quick two-phone test first.

## Live functionality
- Spectators: no login, live scores, clock, game feed, profiles and player stats.
- Scorekeeper: password-protected changes, single shared game source.
- Real-time sync uses Server-Sent Events (SSE). HTTP polling is the fallback.
- A website link works on iPhone, Android and desktop browsers; no native iPhone app needed.
- Optional iOS web-push notifications require a Home Screen web app and VAPID keys. Real Dynamic Island updates require a separate native iOS app, not included in this web-only folder.
- Uploaded player photos remain stored in the scorekeeper's browser, not synchronized between devices.

## Optional web-push alerts
Generate VAPID keys using `npx web-push generate-vapid-keys` locally. Add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` to Railway Variables; then fans on supported iPhones can Add to Home Screen and opt into notifications. This is optional for universal live scores.

## Local test
Needs Node.js 20 or newer.

```sh
npm install
npm test
ADMIN_PASSCODE=6387 npm start
```

Then open `http://localhost:3100` in two tabs to test. On Windows PowerShell use `$env:ADMIN_PASSCODE='6387'; npm start` instead of the last line.

### Security / hosting notes
- Set a long private `ADMIN_PASSCODE` in production. A four-digit code can be brute-forced or shared with others, despite server-side login rate limiting.
- Use a host with stable persistence. On free/ephemeral hosts scores may disappear after restarts.
- For full spectator experience, keep the site and your scorekeeper device online during the game. The server can supply an approximate timer between updates, but the scorekeeper remains authoritative for clock adjustments.
