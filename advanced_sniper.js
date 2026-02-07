import WebSocket from 'ws';
import tls from 'tls';
import dotenv from 'dotenv';
import fs from 'fs';
import readline from 'readline';

// Load config
dotenv.config();

const USER_TOKEN = process.env.TOKEN;
const TARGET_GUILD_ID = process.env.GUILD_ID;
const USER_PASSWORD = process.env.PASSWORD;
const VANITY_CODES = (process.env.VANITY_URL || "").split(",").map(s => s.trim()).filter(Boolean);
const VANITY_CODE = VANITY_CODES[0]; // Primary for backward compatibility/guard
const WEBHOOK_URL = process.env.WEBHOOK_URL;

let mfaAuthToken = null;
let latestSequence = null;
let heartbeatTimer = null;
let tlsSocket = null;
let rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const printConfig = () => {
    console.log(`
    \x1b[36m┌──────────────────────┬──────────────────────────────────────┐
    │ \x1b[1mCONFIGURATION\x1b[0m\x1b[36m        │ \x1b[1mSTATUS\x1b[0m\x1b[36m                               │
    ├──────────────────────┼──────────────────────────────────────┤
    │ Token                │ ${USER_TOKEN ? "\x1b[32m✅ Loaded\x1b[36m                           " : "\x1b[31m❌ MISSING\x1b[36m                          "} │
    │ Guild ID             │ \x1b[33m${(TARGET_GUILD_ID || "MISSING").padEnd(36)}\x1b[36m │
    │ Vanity URL(s)        │ \x1b[35m${(VANITY_CODES.join(", ") || "MISSING").padEnd(36)}\x1b[36m │
    │ Password             │ ${USER_PASSWORD ? "\x1b[32m✅ Loaded\x1b[36m                           " : "\x1b[31m❌ MISSING\x1b[36m                          "} │
    │ Webhook              │ ${WEBHOOK_URL ? "\x1b[32m✅ Loaded\x1b[36m                           " : "\x1b[31m❌ MISSING\x1b[36m                          "} │
    └──────────────────────┴──────────────────────────────────────┘\x1b[0m`);
};

function createTlsSocket() {
    return tls.connect({
        host: 'canary.discord.com',
        port: 443,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2'
    });
}

// --- WEBHOOK UTIL ---
async function sendWebhook(title, description, color = 0x00FF00, mentionEveryone = false) {
    if (!WEBHOOK_URL) return;

    const embed = {
        title: title,
        description: description,
        color: color,
        footer: { text: "Spectral Sniper 🚀" },
        timestamp: new Date().toISOString()
    };

    const payload = {
        username: "Sniper Bot",
        embeds: [embed]
    };

    // if (mentionEveryone) payload.content = "@everyone";

    try {
        await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.log(`\x1b[31m[Webhook] Failed to send: ${e.message}\x1b[0m`);
    }
}

// Retries wrapper for sendHttpRequest
async function sendHttpRequest(method, path, body = null, extraHeaders = {}, closeConnection = false, attempt = 1) {
    return new Promise((resolve) => {
        const payload = body ? JSON.stringify(body) : '';

        // If retrying, force a fresh socket
        if (attempt > 1 && tlsSocket) {
            try { tlsSocket.destroy(); } catch { }
            tlsSocket = null;
        }

        if (!tlsSocket || tlsSocket.destroyed || closeConnection) {
            tlsSocket = createTlsSocket();
            tlsSocket.setNoDelay(true);
        }
        const socket = tlsSocket;

        const headers = [
            `${method} ${path} HTTP/1.1`,
            'Host: canary.discord.com',
            `Connection: ${closeConnection ? 'close' : 'keep-alive'}`,
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(payload)}`,
            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
            `Authorization: ${USER_TOKEN}`,
            'X-Super-Properties: eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRmlyZWZveCIsImRldmljZSI6IiIsInN5c3RlbV9sb2NhbGUiOiJ0ci1UUiIsImJyb3dzZXJfdXNlcl9hZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQ7IHJ2OjEzMy4wKSBHZWNrby8yMDEwMDEwMSBGaXJlZm94LzEzMy4wIiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTMzLjAiLCJvc192ZXJzaW9uIjoiMTAiLCJyZWZlcnJlciI6Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vIiwicmVmZXJyaW5nX2RvbWFpbiI6Ind3dy5nb29nbGUuY29tIiwic2VhcmNoX2VuZ2luZSI6Imdvb2dsZSIsInJlZmVycmVyX2N1cnJlbnQiOiIiLCJyZWZlcnJpbmdfZG9tYWluX2N1cnJlbnQiOiIiLCJyZWxlYXNlX2NoYW5uZWwiOiJjYW5hcnkiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjozNTYxNDAsImNsaWVudF9ldmVudF9zb3VyY2UiOm51bGwsImhhc19jbGllbnRfbW9kcyI6ZmFsc2V9'
        ];

        if (extraHeaders['X-Discord-MFA-Authorization']) {
            headers.push(`X-Discord-MFA-Authorization: ${extraHeaders['X-Discord-MFA-Authorization']}`);
        }

        headers.push('', payload);

        let responseData = '';

        // Handle socket errors specifically
        const errorHandler = (err) => {
            // console.log("Socket Error:", err);
            // On error, if we haven't retried too many times, try again
            socket.removeListener('data', dataHandler);
            socket.removeListener('end', endHandler);

            if (attempt <= 3) {
                // console.log(`[Network] Retrying request (Attempt ${attempt + 1})...`);
                // Recursively call self with clean socket
                resolve(sendHttpRequest(method, path, body, extraHeaders, closeConnection, attempt + 1));
            } else {
                resolve('{}');
            }
        };

        const dataHandler = (chunk) => { responseData += chunk.toString(); };

        const endHandler = () => {
            try {
                const separatorIndex = responseData.indexOf('\r\n\r\n');
                if (separatorIndex === -1) return resolve('{}');
                let bodyRaw = responseData.slice(separatorIndex + 4);

                const firstTrace = bodyRaw.indexOf('{');
                const lastTrace = bodyRaw.lastIndexOf('}');

                if (firstTrace !== -1 && lastTrace !== -1 && lastTrace > firstTrace) {
                    resolve(bodyRaw.substring(firstTrace, lastTrace + 1));
                } else {
                    resolve('{}');
                }
            } catch (e) {
                resolve('{}');
            } finally {
                if (closeConnection) socket.destroy();
                // Clean up listeners
                socket.removeListener('error', errorHandler);
                socket.removeListener('data', dataHandler);
            }
        };

        socket.once('error', errorHandler);
        socket.on('data', dataHandler);
        socket.once('end', endHandler);

        socket.write(headers.join('\r\n'));
    });
}

// --- CORE UTILS ---

async function authenticateMfa() {
    console.log("\x1b[36m[MFA] 🛡️ Checking Security Requirements...\x1b[0m");
    try {
        const patchResp = await sendHttpRequest('PATCH', `/api/v9/guilds/${TARGET_GUILD_ID}/vanity-url`, { code: VANITY_CODE }, {}, true);

        let patchData = {};
        try { patchData = JSON.parse(patchResp); } catch { }

        if (patchData.code === 60003) {
            console.log("\x1b[33m[MFA] 🔒 Two-Factor Auth Required (Code 60003). Auto-Solving...\x1b[0m");
            const finishResp = await sendHttpRequest('POST', '/api/v9/mfa/finish', {
                ticket: patchData.mfa.ticket,
                mfa_type: 'password',
                data: USER_PASSWORD
            }, {}, true);

            let finishData = {};
            try { finishData = JSON.parse(finishResp); } catch { }

            if (finishData.token) {
                console.log('\x1b[32m[MFA] 🔓 MFA TOKEN OBTAINED SUCCESSFULLY!\x1b[0m');
                sendWebhook("MFA Security Bypassed", "Successfully solved 2FA challenge and obtained authorization token.", 0x00FF00);
                return finishData.token;
            } else {
                console.log("\x1b[31m[MFA] ❌ Failed to get MFA Token.\x1b[0m");
                sendWebhook("MFA Failed", `Failed to solve MFA challenge.\nError: ${finishData.message}`, 0xFF0000);
                if (finishData.message) console.log(`\x1b[31m[Error] ${finishData.message} (Code: ${finishData.code})\x1b[0m`);
            }
        } else if (patchData.code === VANITY_CODE || patchData.code === 200) {
            console.log("\x1b[32m!!! STATUS !!! Vanity status check successful.\x1b[0m");
            return "CHECK_COMPLETE";
        } else {
            // let tryClaim handle it
        }
    } catch (e) {
        console.log("MFA Auth Error:", e);
    }
    return null;
}

async function tryClaim(mfaToken, code = VANITY_CODE, keepAlive = false) {
    if (!mfaToken) {
        console.log("\x1b[31m[Claim] Cannot claim without MFA Token!\x1b[0m");
        return false;
    }

    // Slight Optimization: Special flag for "Check Complete"
    if (mfaToken === "CHECK_COMPLETE") {
        return false; // Just used for auth check
    }

    console.log(`\x1b[36m[Sniper] 🔫 Attempting to claim '${code}'...\x1b[0m`);

    // STRATEGY 1: Specific Endpoint
    let resp = await sendHttpRequest(
        'PATCH',
        `/api/v9/guilds/${TARGET_GUILD_ID}/vanity-url`,
        { code: code },
        { 'X-Discord-MFA-Authorization': mfaToken },
        true
    );

    let result = {};
    try { result = JSON.parse(resp); } catch { }

    // Fallback if 10008 (Unknown Message) or 404
    if (result.code === 10008 || result.code === 404) {
        console.log(`\x1b[33m[Sniper] Endpoint Error (${result.code}). Trying Fallback (Generic Guild Patch)...\x1b[0m`);
        resp = await sendHttpRequest(
            'PATCH',
            `/api/v9/guilds/${TARGET_GUILD_ID}`,
            // Send both common keys to be sure
            { code: code, vanity_code: code },
            { 'X-Discord-MFA-Authorization': mfaToken },
            true
        );
        try { result = JSON.parse(resp); } catch { }
    }

    // Check success
    const validKeys = ["vanity_url_code", "code", "vanity_code"];
    const isSuccess = validKeys.some(key => result[key] === code);

    // Also check raw string matching just in case
    const rawSuccess = resp.includes(`"${code}"`) && !resp.includes("errors");

    if (isSuccess || rawSuccess) {
        console.log(`\x1b[32m!!! VICTORY !!! URL '${code}' SNIPED SUCCESSFULLY !\x1b[0m`);
        sendWebhook("🎯 VANITY URL SNIPED!", `**URL:** ${code}\n**Guild:** ${TARGET_GUILD_ID}`, 0x00FF00, true);

        if (keepAlive) {
            console.log("\x1b[35m[Guard] 🛡️ Entering GUARD MODE. I will watch this server and re-claim if the URL drops.\x1b[0m");
            sendWebhook("🛡️ Guard Mode Active", `Watching for changes to **${code}**...`, 0x0000FF);
            return true;
        } else {
            return true;
        }
    } else {
        if (result.code === 50013) {
            console.log("\x1b[31m[Sniper] ⛔ PERMISSION DENIED (50013)\x1b[0m");
            sendWebhook("⛔ Permission Denied", "Code 50013: Missing 'Manage Server' permission.", 0xFF0000);
            console.log("\x1b[33m👉 Check Account Permissions! (Need 'Manage Server')\x1b[0m");
        } else if (result.code === 10008) {
            console.log("\x1b[31m[Sniper] ⛔ UNKNOWN MESSAGE (10008) - BOTH ENDPOINTS FAILED.\x1b[0m");
            console.log("\x1b[33m👉 Check if Guild still exists and you are in it.\x1b[0m");
        } else if (result.code) {
            console.log(`\x1b[31m[Sniper] ❌ Failed: ${result.message} (Code: ${result.code})\x1b[0m`);
        } else {
            // If we got the guild object back but code didn't change:
            if (result.id === TARGET_GUILD_ID) {
                console.log(`\x1b[31m[Sniper] ❌ Server accepted request but didn't update URL.\x1b[0m`);
                console.log(`\x1b[33mCurrent URL: ${result.vanity_url_code}\x1b[0m`);
                sendWebhook("❌ Claim Failed", `Server returned 200 OK but URL is still **${result.vanity_url_code}**.\nPossible Rate Limit or Taken.`, 0xFFA500);
            } else {
                console.log(`[Sniper] Response: ${resp}`);
            }
        }
    }
    return false;
}

// --- CHECKS ---

async function verifyGuild() {
    console.log(`\x1b[36m[Check] Verifying Guild ID: ${TARGET_GUILD_ID}...\x1b[0m`);
    const resp = await sendHttpRequest('GET', `/api/v9/guilds/${TARGET_GUILD_ID}`, null, {}, true);

    let data = {};
    try { data = JSON.parse(resp); } catch { }

    if (data.id === TARGET_GUILD_ID) {
        console.log(`\x1b[32m[Check] ✅ Guild Found: "${data.name}" (Owner ID: ${data.owner_id})\x1b[0m`);
        return true;
    } else {
        console.log(`\x1b[31m[Check] ❌ Guild Check Failed!\x1b[0m`);
        console.log(`\x1b[31mResponse: ${resp}\x1b[0m`);

        if (data.code === 10004) console.log("\x1b[33m👉 Diagnosis: UNKNOWN GUILD. The ID is wrong or you are not in the server.\x1b[0m");
        if (data.code === 10008) console.log("\x1b[33m👉 Diagnosis: UNKNOWN MESSAGE. You likely copied a Message ID, not the Server ID!\x1b[0m");
        sendWebhook("⚠️ Config Error", "Guild Verification Failed. Check ID.", 0xFF0000);
        return false;
    }
}

// --- MODES ---

async function modeInstant() {
    sendWebhook("🚀 Sniper Started", "Mode: Instant Snipe", 0xFFFF00);
    const guildOK = await verifyGuild();
    if (!guildOK) {
        console.log("Aborting Snipe due to invalid Guild ID.");
        rl.question("\nPress Enter to return...", () => showMenu());
        return;
    }

    const token = await authenticateMfa();
    if (token && token !== "CHECK_COMPLETE") {
        console.log(`\x1b[36m[Instant] 🔄 Checking list: ${VANITY_CODES.join(', ')}\x1b[0m`);
        for (const code of VANITY_CODES) {
            const success = await tryClaim(token, code, false);
            if (success) process.exit(0);
            await new Promise(r => setTimeout(r, 200));
        }
        rl.question("\nFinished checklist. Press Enter to return...", () => showMenu());
    } else {
        rl.question("\nAuth failed or no action needed. Press Enter...", () => showMenu());
    }
}

async function modeGateway() {
    sendWebhook("🚀 Sniper Started", "Mode: Gateway Sniper (Guard Active)", 0xFFFF00);
    const guildOK = await verifyGuild();
    if (!guildOK) return;

    const token = await authenticateMfa();
    if (!token || token === "CHECK_COMPLETE") {
        // Even if direct check failed, we might want to start listening
        // but we need a real MFA token for re-claiming if it drops.
        // If we don't have it, we should probably warn.
        if (token === "CHECK_COMPLETE") {
            console.log("\x1b[33m[Gateway] Note: Using Gateway without persistent MFA token might fail re-claims.\x1b[0m");
        } else return;
    }

    console.log(`\x1b[36m[Gateway] � Monitoring for: ${VANITY_CODES.join(', ')}\x1b[0m`);

    // Initial attempt for all
    for (const code of VANITY_CODES) {
        const success = await tryClaim(token, code, true);
        if (success) {
            establishGatewayConnection(token, code);
            return;
        }
    }

    // Default to watching the primary if none claimed yet
    establishGatewayConnection(token, VANITY_CODE);
}


async function modeAggressive() {
    sendWebhook("🚀 Sniper Started", "Mode: Aggressive Mode (High Speed)", 0xFFFF00);
    const guildOK = await verifyGuild();
    if (!guildOK) {
        rl.question("\nPress Enter to return...", () => showMenu());
        return;
    }

    const token = await authenticateMfa();
    if (!token) return;

    // Connect Gateway as backup/alert
    establishGatewayConnection(token, VANITY_CODE);

    console.log(`\x1b[36m[Aggressive] 🚀 STARTING ULTRA 30ms MONITORING\x1b[0m`);
    console.log(`\x1b[33mPress Ctrl+C to stop.\x1b[0m`);

    const CHECK_INTERVAL = 30;
    let nextCheckTime = Date.now();
    let checks = 0;

    const statsShowInterval = 100; // Show stats every 100 checks

    while (true) {
        const now = Date.now();
        if (now >= nextCheckTime) {
            checks++;

            for (const code of VANITY_CODES) {
                // Check
                const resp = await sendHttpRequest('GET', `/api/v9/guilds/${TARGET_GUILD_ID}/vanity-url`, null, {}, false);
                let data = {};
                try { data = JSON.parse(resp); } catch { }

                if (data.code !== code) {
                    console.log(`\x1b[31m[Aggressive] 🚨 ALERT! Vanity '${code}' is missing! (Current: ${data.code || "NONE"}) Claiming NOW...\x1b[0m`);
                    const success = await tryClaim(token, code, true);
                    if (success) {
                        establishGatewayConnection(token, code);
                        return;
                    }
                }
            }

            if (checks % statsShowInterval === 0) {
                process.stdout.write(`\x1b[36m[Aggressive] Pulse: ${checks} cycles completed...\r\x1b[0m`);
            }

            nextCheckTime = now + CHECK_INTERVAL;
        }

        const sleepTime = Math.max(0, nextCheckTime - Date.now());
        if (sleepTime > 0) {
            await new Promise(r => setTimeout(r, sleepTime));
        }
    }
}

async function modeScheduled() {
    printConfig();
    console.log(`\n\x1b[36m[Grace Tracker] ⏳ Prepare for a scheduled claim.\x1b[0m`);
    console.log(`\x1b[33mExample Format: 2026-02-07 20:00:00 (Local Time)\x1b[0m`);

    const askTarget = () => new Promise(resolve => rl.question("\nTarget Date/Time (YYYY-MM-DD HH:mm:ss): ", resolve));
    let input = await askTarget();
    let targetDate = new Date(input);

    if (isNaN(targetDate.getTime())) {
        console.log("\x1b[31mInvalid date format! Returning to menu...\x1b[0m");
        rl.question("\nPress Enter...", () => showMenu());
        return;
    }

    const targetTs = targetDate.getTime();
    console.log(`\x1b[32mTarget Locked: ${targetDate.toLocaleString()}\x1b[0m`);

    sendWebhook("🕒 Scheduled Snipe Active", `Monitoring until **${targetDate.toLocaleString()}** for **${VANITY_CODE}**`, 0x00FFFF);

    const countdown = setInterval(() => {
        const now = Date.now();
        const diff = targetTs - now;

        if (diff <= 0) {
            clearInterval(countdown);
            return;
        }

        if (diff > 10000) { // More than 10s left
            const hours = Math.floor(diff / 3600000);
            const mins = Math.floor((diff % 3600000) / 60000);
            const secs = Math.floor((diff % 60000) / 1000);
            process.stdout.write(`\x1b[36m[Countdown] T-Minus: ${hours}h ${mins}m ${secs}s ...     \r\x1b[0m`);
        }
    }, 1000);

    // Main wait loop
    while (true) {
        const now = Date.now();
        const diff = targetTs - now;

        if (diff <= 10000) { // 10 seconds before target
            clearInterval(countdown);
            console.log(`\n\x1b[31m[Grace Tracker] 🚨 T-10 SECONDS! INITIATING BURST MODE NOW!\x1b[0m`);
            sendWebhook("🚨 BURST MODE", "Scheduled target is 10 seconds away! Starting aggressive polling.", 0xFF0000);

            // Switch to logic similar to modeAggressive but even more prioritized
            const burstInterval = 25; // Even faster 25ms
            let nextCheck = Date.now();
            const token = await authenticateMfa();
            if (!token) break;

            while (Date.now() < targetTs + 5000) { // Run for 5s after target to be safe
                if (Date.now() >= nextCheck) {
                    for (const code of VANITY_CODES) {
                        sendHttpRequest('PATCH', `/api/v9/guilds/${TARGET_GUILD_ID}/vanity-url`, { code: code }, { 'X-Discord-MFA-Authorization': token }, false).then(resp => {
                            if (resp.includes(`"${code}"`)) {
                                console.log(`\x1b[32m!!! SUCCESS !!! SCHEDULED SNIPE VICTORY: ${code} !\x1b[0m`);
                                process.exit(0);
                            }
                        });
                    }
                    nextCheck = Date.now() + burstInterval;
                }
                await new Promise(r => setTimeout(r, 5));
            }
            console.log("\n\x1b[33m[Grace Tracker] Target window passed. Returning to menu.\x1b[0m");
            break;
        }
        await new Promise(r => setTimeout(r, 100)); // Sleep 100ms when far away
    }
    rl.question("\nPress Enter...", () => showMenu());
}

function establishGatewayConnection(mfaToken, activeCode) {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');

    ws.on('open', () => {
        console.log("\x1b[36m[Gateway] Connected.\x1b[0m");
        sendWebhook("📡 Gateway Connected", "Listening for GUILD_UPDATE events...", 0x00FFFF);
        ws.send(JSON.stringify({
            op: 2,
            d: {
                token: USER_TOKEN,
                intents: 1,
                properties: { $os: 'linux', $browser: 'Discord Client', $device: 'desktop' }
            }
        }));
    });

    ws.on('message', async (msg) => {
        try {
            const packet = JSON.parse(msg);
            if (packet.s) latestSequence = packet.s;

            if (packet.op === 10) {
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                heartbeatTimer = setInterval(() => {
                    ws.send(JSON.stringify({ op: 1, d: latestSequence }));
                }, packet.d.heartbeat_interval);
            } else if (packet.t === 'GUILD_UPDATE') {
                const g = packet.d;
                if (g.id === TARGET_GUILD_ID) {
                    // If the current vanity is NOT in our target list, it might have dropped or changed
                    // Or if we are specifically watching 'activeCode'
                    if (activeCode && g.vanity_url_code !== activeCode) {
                        console.log(`\x1b[31m[Guard] 🚨 ALERT! URL Changed to '${g.vanity_url_code}'! RE-CLAIMING '${activeCode}' NOW!\x1b[0m`);
                        sendWebhook("🚨 GUARD TRIGGERED", `URL dropped to **${g.vanity_url_code}**. Re-claiming **${activeCode}** immediately!`, 0xFF0000, true);
                        await tryClaim(mfaToken, activeCode, true);
                    } else if (!activeCode) {
                        // If no specific code is being guarded, check if any of our codes are missing
                        for (const code of VANITY_CODES) {
                            if (g.vanity_url_code !== code) {
                                // This is a bit complex because one of them will always not match if we have multiple
                                // So Gateway mode with multiple URLs needs to be smart.
                                // For now, let's just use the activeCode logic which is safer.
                            }
                        }
                    }
                }
            } else if (packet.t === 'READY') {
                console.log(`\x1b[32m[Gateway] Ready! Logged in as ${packet.d.user.username}\x1b[0m`);
            }
        } catch { }
    });

    ws.on('close', () => {
        setTimeout(() => establishGatewayConnection(mfaToken, activeCode), 5000); // Pass activeCode
    });
}

function showMenu() {
    console.clear();
    console.log(`
    \x1b[35m__  ___      __   _____       _
   / / / /____  / /  / ___/____  (_)___  ___  _____
  / / / / ___/ / /   \\__ \\/ __ \\/ / __ \\/ _ \\/ ___/
 / /_/ / /    / /   ___/ / / / / / /_/ /  __/ /
 \\____/_/    /_/   /____/_/ /_/_/ .___/\\___/_/
                               /_/
    Created by Spectral.\x1b[0m
    `);
    console.log("\x1b[36m1. Instant Snipe (Try to claim NOW)\x1b[0m");
    console.log("\x1b[36m2. Gateway Sniper (Listen for URL changes)\x1b[0m");
    console.log("\x1b[36m3. Aggressive Mode (High Speed - 30ms)\x1b[0m");
    console.log("\x1b[36m4. Grace Period Tracker (Scheduled Snipe)\x1b[0m");
    console.log("\x1b[36m5. Configuration Check\x1b[0m");
    console.log("\x1b[31m6. Exit\x1b[0m");

    rl.question("\n\x1b[33mSelect Mode (1-6): \x1b[0m", handleMenu);
}

async function handleMenu(option) {
    if (option === '1') {
        await modeInstant();
    } else if (option === '2') {
        console.log("Starting Gateway Sniper...");
        await modeGateway();
    } else if (option === '3') {
        await modeAggressive();
    } else if (option === '4') {
        await modeScheduled();
    } else if (option === '5') {
        printConfig();
        rl.question("\nPress Enter to return...", () => showMenu());
    } else if (option === '6') {
        console.log("Exiting...");
        process.exit(0);
    } else {
        showMenu();
    }
}

if (!USER_TOKEN || !TARGET_GUILD_ID || !USER_PASSWORD || !VANITY_CODE) {
    console.error("\x1b[31mHATA: .env dosyasında eksik bilgiler var!\x1b[0m");
    process.exit(1);
}

showMenu();
