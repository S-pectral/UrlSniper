# Discord Vanity Sniper 🚀

An advanced, high-performance Discord Vanity URL Sniper written in Node.js, built using direct TLS sockets and Discord's Gateway protocol.

## 🔥 Key Features

- **Direct TLS Socket & HTTP/1.1 Engine:** Uses raw TLS sockets with persistent HTTP keep-alive, chunked transfer decoding, and browser headers (`User-Agent` & `X-Super-Properties`).
- **Proxy Support with Auto-Test (`proxy.txt`):** Supports HTTP/HTTPS CONNECT proxy tunneling (`ip:port`, `ip:port:user:pass`, `http://user:pass@ip:port`). Automatically tests latency and connectivity on startup and gracefully falls back to direct connection if proxies fail.
- **Multi-Token Concurrent Gateway:** Run multiple user tokens simultaneously. Each account connects to Discord Gateway in parallel, monitoring mutual servers across all accounts and feeding real-time drop events to the sniper.
- **Multi-Target Server Support:** Specify multiple guild IDs in priority order. Automatically monitors and secures vanities across all target servers.
- **Auto-MFA Solver & Token Refresh:** Detects 2FA challenges (`Code 60003`), automatically submits account password verification via Discord's `/mfa/finish` endpoint, and auto-refreshes expired MFA tokens seamlessly during claims.
- **Multi-URL Priority Support:** Set multiple vanity codes in comma-separated order. The sniper monitors your target list, prioritizes available codes, and protects already claimed vanities.
- **Robust Gateway Integration:** Full Discord Gateway v9 lifecycle support including session resume (OP 6), heartbeat tracking with ACK verification (OP 1, OP 11), reconnect handling (OP 7), and unhandled error protection (`ws.on('error')`).
- **Rate Limit (429) & Error Protection:** Strictly verifies HTTP status codes (200 OK) and honors `retry_after` cooldowns, preventing false alarms and rate-limit loops.
- **Guard Mode:** Once a target vanity is claimed or detected, the sniper watches `GUILD_UPDATE` gateway events in real time and re-claims immediately if the URL drops.
- **Discord Webhook Alerts:** Real-time notifications for successful snipes, Guard mode triggers, MFA events, and errors.

## 🛠️ Installation

1. **Install Node.js:** Ensure you have [Node.js](https://nodejs.org/) (v18 or higher) installed.
2. **Download Source:** Clone this repository or download the files.
3. **Install Dependencies:**
   Open a terminal in the project folder and run:
   ```bash
   npm install
   ```

## ⚙️ Configuration

### 1. `.env` Configuration
Copy `.env.example` to `.env` in the root directory and fill in your details:

```ini
# Multi-Token Support: Put a single token or multiple separated by commas
TOKEN=primary_token_here,second_token_optional
# Multi-Guild Support: Put a single guild ID or multiple separated by commas
GUILD_ID=primary_guild_id,secondary_guild_id
# Multi-URL Support: Put a single code or multiple separated by commas
VANITY_URL=cool-url,rare-code,my-server
PASSWORD=your_account_password
WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### 2. Proxy Configuration (`proxy.txt`)
Add your proxies (one per line) to `proxy.txt`. Supported formats:
- `ip:port`
- `ip:port:user:password`
- `http://user:password@ip:port`

> **Note:** If `proxy.txt` is left empty, the sniper automatically uses your direct connection. If proxies are provided, the sniper tests their connectivity and latency on startup.

## 🚀 Usage

Run the sniper:

```bash
node advanced_sniper.js
```

### 🎮 Available Modes
1. **Instant Snipe:** Iterates through the `VANITY_URL` list immediately and attempts one-time claims.
2. **Gateway Sniper:** Listens for Discord `GUILD_UPDATE` events across all configured tokens and servers.
3. **Aggressive Mode:** High-frequency loop monitoring your target guilds' vanity state with intelligent 429 rate-limit backoff.
4. **Grace Period Tracker:** Schedule a snipe for a specific unlock date/time. Pre-arms MFA ahead of time and bursts claims around the target timestamp.
5. **Configuration & Proxy Check:** Displays loaded settings, tests proxy latency, and verifies account tokens and target servers.
6. **Exit:** Gracefully closes sockets and shuts down.

## ⚠️ Disclaimer
This tool is for educational and security auditing purposes only. Automating user accounts (Self-botting) is against Discord's Terms of Service. Use at your own risk.

## Credits
Created by [Spectral](https://github.com/S-pectral).
