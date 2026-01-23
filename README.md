# Discord Vanity Sniper (JS Edition) 🚀

This is an advanced, high-performance Discord Vanity URL Sniper written in Node.js. It is designed to bypass modern security measures such as TLS fingerprinting and automated Bot detection.

## 🔥 Key Features

- **Chrome Impersonation:** Uses raw `tls` sockets to mimic a real Google Chrome browser (v110+), completely bypassing Discord's "Password Mismatch" / "Token Invalid" errors caused by Python/Requests fingerprinting.
- **Auto-MFA Solver:** Automatically detects MFA requirements (`Code 60003`) and generates a valid 2FA token using your password.
- **Multi-URL Support:** Monitor and snipe multiple vanity codes simultaneously. The sniper will cycle through them and lock onto the first one it successfully claims.
- **Guard Mode:** Once a URL is claimed, the sniper automatically enters "Guard Mode", watching specifically for that URL to drop or change, and instantly re-claims it if necessary.
- **Dual-Endpoint Attack:** Simulates both the modern `/vanity-url` endpoint and the legacy `/guilds/{id}` endpoint simultaneously to ensure the claim succeeds even if one API method is patched.
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
# You can put a single code or multiple separated by commas
VANITY_URL=cool-url,rare-code,my-server
PASSWORD=your_account_password
WEBHOOK_URL=https://discord.com/api/webhooks/...
```

> **Note:** `GUILD_ID` must be the **Server ID** where you have "Manage Server" permissions. Do not use Channel or Message IDs.

## 🚀 Usage

Run the sniper:

```bash
node advanced_sniper.js
```

### Modes
1.  **Instant Snipe:** Attempts to claim the primary URL immediately. Best for checking if a URL is free right now.
2.  **Gateway Sniper:** Connects to Discord Gateway and listens for `GUILD_UPDATE` events. Best for camping on a URL you expect to drop soon (e.g., during a transfer).
3.  **Multi-Snipe Loop:** Continuously cycles through all URLs defined in `VANITY_URL`. If one is claimed, it switches to **Guard Mode** for that specific URL.

## ⚠️ Disclaimer
This tool is for educational purposes only. Automating user accounts (Self-botting) is against Discord's Terms of Service. Use at your own risk.
