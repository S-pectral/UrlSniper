# Discord Vanity Sniper (JS Edition) 🚀

This is an advanced, high-performance Discord Vanity URL Sniper written in Node.js. It is designed to bypass modern security measures such as TLS fingerprinting and automated Bot detection.

## 🔥 Key Features

- **Chrome Impersonation:** Uses `tls` sockets to mimic a real Google Chrome browser (v110+), completely bypassing Discord's "Password Mismatch" / "Token Invalid" errors caused by Python/Requests fingerprinting.
- **Auto-MFA Solver:** Automatically detects MFA requirements (`Code 60003`) and generates a valid 2FA token using your password.
- **Dual-Endpoint Attack:** Simulates both the modern `/vanity-url` endpoint and the legacy `/guilds/{id}` endpoint simultaneously to ensure the claim succeeds even if one API method is patched or blocked.
- **Gateway Mode:** Connects to the Discord Gateway and listens for `GUILD_UPDATE` events to instantly snipe a URL the moment it is released or the server is updated.
- **Interactive Menu:** Simple, clean CLI interface.

## 🛠️ Installation

1.  **Install Node.js:** Ensure you have Node.js (v18+) installed.
2.  **Install Dependencies:**
    ```bash
    npm install
    ```

## ⚙️ Configuration

Create a `.env` file in the root directory (or use the provided example):

```env
TOKEN=your_user_token_here
GUILD_ID=your_target_server_id
VANITY_URL=target_vanity_code
PASSWORD=your_account_password
```

> **Note:** `GUILD_ID` must be the **Server ID** where you have "Manage Server" permissions. Do not use Channel or Message IDs.

## 🚀 Usage

Run the sniper:

```bash
node advanced_sniper.js
```

### Modes
1.  **Instant Snipe:** Attempts to claim the URL immediately. Best for checking if a URL is free right now.
2.  **Gateway Sniper:** Connects to Discord and waits. Ideal for camping on a URL that you expect to be released soon or grabbing a URL during a server transfer.

## ⚠️ Disclaimer
This tool is for educational purposes only. Automating user accounts (Self-botting) is against Discord's Terms of Service. Use at your own risk.
