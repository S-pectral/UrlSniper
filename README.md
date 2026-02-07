# Discord Vanity Sniper 🚀

This is an advanced, high-performance Discord Vanity URL Sniper written in Node.js. It is designed to bypass modern security measures such as TLS fingerprinting and automated Bot detection.

## 🔥 Key Features

- **Chrome Impersonation:** Uses raw `tls` sockets to mimic a real Google Chrome browser (v110+), completely bypassing Discord's "Password Mismatch" / "Token Invalid" errors caused by Python/Requests fingerprinting.
- **Auto-MFA Solver:** Automatically detects MFA requirements (`Code 60003`) and generates a valid 2FA token using your password.
- **Multi-URL Support (Native):** Every operation mode now automatically handles multiple vanity codes simultaneously. The sniper will monitor your entire list and lock onto the first one it successfully claims.
- **Aggressive Mode (High Speed):** An ultra-fast monitoring loop (30ms interval) that cycles through your target list at extreme speed while maintaining stealth.
- **Grace Period Tracker:** Schedule snipes for a specific date/time (e.g., when a lock ends). Automatically triggers **Burst Mode** (25ms frequency) 10 seconds before the target.
- **Guard Mode:** Once a URL is claimed, the sniper automatically enters "Guard Mode", watching specifically for that URL, and instantly re-claims it if necessary.
- **Dual-Endpoint Attack:** Simulates both the modern `/vanity-url` endpoint and the legacy `/guilds/{id}` endpoint simultaneously.
- **Webhook Notifications:** Get real-time updates for successful claims, MFA bypasses, and Guard Mode alerts directly in your Discord channel.

## 🛠️ Installation

1.  **Install Node.js:** Ensure you have [Node.js](https://nodejs.org/) (v18 or higher) installed.
2.  **Download Source:** Clone this repository or download the files.
3.  **Install Dependencies:**
    Open a terminal in the project folder and run:
    ```bash
    npm install
    ```

## ⚙️ Configuration

Create a `.env` file in the root directory (copy `.env.example`) and fill in your details:

```ini
TOKEN=your_user_token_here
GUILD_ID=your_target_server_id
# Multi-URL Support: Put a single code or multiple separated by commas
VANITY_URL=cool-url,rare-code,my-server
PASSWORD=your_account_password
WEBHOOK_URL=https://discord.com/api/webhooks/...
```

> **Note:** `GUILD_ID` must be the **Server ID** where you have "Manage Server" permissions.

## 🚀 Usage

Run the sniper:

```bash
node advanced_sniper.js
```

### 🎮 Available Modes
1.  **Instant Snipe:** Checks the entire `VANITY_URL` list immediately and attempts one-time claims.
2.  **Gateway Sniper:** Listens for Discord `GUILD_UPDATE` events. Best for catching a URL the moment it drops without hammering the API.
3.  **Aggressive Mode:** An ultra-fast, high-frequency loop (30ms) iterating through your target list. Best for high-stakes competition.
4.  **Grace Period Tracker:** Schedule a snipe based on a specific unlock time (e.g., after 30 days). Displays a countdown and initiates a 25ms polling burst right before the target.
5.  **Configuration Check:** Quickly verify your loaded settings.
6.  **Exit:** Gracefully closes the sniper.

## ⚠️ Disclaimer
This tool is for educational purposes only. Automating user accounts (Self-botting) is against Discord's Terms of Service. Use at your own risk.


## Credits
Created by [Spectral](https://github.com/S-pectral).
