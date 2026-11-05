import WebSocket from 'ws';
import tls from 'tls';
import net from 'net';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import readline from 'readline';
import { Buffer } from 'node:buffer';

// Load config
dotenv.config();

const USER_TOKENS = (process.env.TOKENS || process.env.TOKEN || "").split(",").map(t => t.trim()).filter(Boolean);
const USER_TOKEN = USER_TOKENS[0]; // Primary token for claims

const TARGET_GUILD_IDS = (process.env.GUILD_IDS || process.env.GUILD_ID || "").split(",").map(g => g.trim()).filter(Boolean);
const TARGET_GUILD_ID = TARGET_GUILD_IDS[0]; // Primary target guild

const USER_PASSWORD = process.env.PASSWORD;
const VANITY_CODES = (process.env.VANITY_URL || "").split(",").map(s => s.trim()).filter(Boolean);
const VANITY_CODE = VANITY_CODES[0];
const WEBHOOK_URL = process.env.WEBHOOK_URL;

let mfaAuthToken = null;
let activeProxy = null;
let validatedAccounts = [];
let validatedGuilds = [];

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// --- PROXY HANDLER & TESTER ---

function parseProxy(rawLine) {
    if (!rawLine) return null;
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) return null;

    line = line.replace(/^(https?:\/\/)/i, '');

    if (line.includes('@')) {
        const [authPart, hostPortPart] = line.split('@');
        const [host, port] = hostPortPart.split(':');
        return {
            host,
            port: parseInt(port, 10),
            auth: authPart,
            raw: rawLine.trim()
        };
    }

    const parts = line.split(':');
    if (parts.length === 4) {
        return {
            host: parts[0],
            port: parseInt(parts[1], 10),
            auth: `${parts[2]}:${parts[3]}`,
            raw: rawLine.trim()
        };
    }

    if (parts.length === 2) {
        return {
            host: parts[0],
            port: parseInt(parts[1], 10),
            auth: null,
            raw: rawLine.trim()
        };
    }

    return null;
}

function testProxyConnection(proxy) {
    return new Promise((resolve) => {
        const start = Date.now();
        const netSocket = net.connect({
            host: proxy.host,
            port: proxy.port
        });

        netSocket.setNoDelay(true);

        let finished = false;
        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                netSocket.destroy();
                resolve({ success: false, error: 'Connection timed out (5s)' });
            }
        }, 5000);

        netSocket.once('error', (err) => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                resolve({ success: false, error: err.message });
            }
        });

        netSocket.once('connect', () => {
            let connectReq = `CONNECT canary.discord.com:443 HTTP/1.1\r\nHost: canary.discord.com:443\r\n`;
            if (proxy.auth) {
                const b64 = Buffer.from(proxy.auth).toString('base64');
                connectReq += `Proxy-Authorization: Basic ${b64}\r\n`;
            }
            connectReq += `\r\n`;
            netSocket.write(connectReq);
        });

        let buf = '';
        const onData = (chunk) => {
            buf += chunk.toString('utf-8');
            if (buf.includes('\r\n\r\n')) {
                netSocket.removeListener('data', onData);
                if (!finished) {
                    finished = true;
                    clearTimeout(timer);
                    netSocket.destroy();

                    const statusLine = buf.split('\r\n')[0] || '';
                    const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
                    const statusCode = match ? parseInt(match[1], 10) : 0;

                    if (statusCode >= 200 && statusCode < 300) {
                        const latency = Date.now() - start;
                        resolve({ success: true, latency });
                    } else {
                        resolve({ success: false, error: `Proxy returned HTTP ${statusCode}: ${statusLine}` });
                    }
                }
            }
        };
        netSocket.on('data', onData);
    });
}

async function initProxies() {
    const proxyFilePath = path.join(process.cwd(), 'proxy.txt');
    if (!fs.existsSync(proxyFilePath)) {
        const template = `# Proxy Listesi (Her satira bir proxy girin)
# Desteklenen formatlar:
# ip:port
# ip:port:kullanici:sifre
# http://kullanici:sifre@ip:port
#
# Eger proxy kullanmak istemiyorsaniz bu dosyayi bos birakabilirsiniz.
`;
        fs.writeFileSync(proxyFilePath, template, 'utf-8');
        console.log("\x1b[36m[Proxy] ℹ️ 'proxy.txt' olusturuldu (bos). Dogrudan baglanti kullanilacak.\x1b[0m");
        return null;
    }

    const content = fs.readFileSync(proxyFilePath, 'utf-8');
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    if (lines.length === 0) {
        console.log("\x1b[36m[Proxy] ℹ️ 'proxy.txt' bos. Dogrudan baglanti (Direct Connection) kullaniliyor.\x1b[0m");
        return null;
    }

    console.log(`\x1b[36m[Proxy] 🔍 'proxy.txt' icinde ${lines.length} proxy bulundu. Baglanti test ediliyor...\x1b[0m`);

    for (const line of lines) {
        const parsed = parseProxy(line);
        if (!parsed) {
            console.log(`\x1b[33m[Proxy] ⚠️ Gecersiz proxy formati: ${line}\x1b[0m`);
            continue;
        }

        const res = await testProxyConnection(parsed);
        if (res.success) {
            console.log(`\x1b[32m[Proxy] ✅ Proxy aktif: ${parsed.host}:${parsed.port} (Gecikme: ${res.latency}ms)\x1b[0m`);
            parsed.latency = res.latency;
            return parsed;
        } else {
            console.log(`\x1b[31m[Proxy] ❌ Proxy calismiyor: ${parsed.host}:${parsed.port} (${res.error})\x1b[0m`);
        }
    }

    console.log("\x1b[33m[Proxy] ⚠️ Calisan proxy bulunamadi! DOGRUDAN BAGLANTIYA geciliyor.\x1b[0m");
    return null;
}

// --- TLS SOKET & HTTP/1.1 PARSER ---

function createTlsSocket(proxy = activeProxy) {
    if (proxy) {
        return new Promise((resolve, reject) => {
            const netSocket = net.connect({
                host: proxy.host,
                port: proxy.port
            });
            netSocket.setNoDelay(true);

            let isResolved = false;
            const timer = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    netSocket.destroy();
                    reject(new Error(`Proxy connection timeout: ${proxy.host}:${proxy.port}`));
                }
            }, 6000);

            netSocket.once('error', (err) => {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timer);
                    reject(err);
                }
            });

            netSocket.once('connect', () => {
                let connectReq = `CONNECT canary.discord.com:443 HTTP/1.1\r\nHost: canary.discord.com:443\r\n`;
                if (proxy.auth) {
                    const b64 = Buffer.from(proxy.auth).toString('base64');
                    connectReq += `Proxy-Authorization: Basic ${b64}\r\n`;
                }
                connectReq += `\r\n`;
                netSocket.write(connectReq);
            });

            let headerBuf = '';
            const onData = (chunk) => {
                headerBuf += chunk.toString('utf-8');
                if (headerBuf.includes('\r\n\r\n')) {
                    netSocket.removeListener('data', onData);
                    clearTimeout(timer);
                    if (!isResolved) {
                        isResolved = true;
                        const statusLine = headerBuf.split('\r\n')[0] || '';
                        const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
                        const statusCode = match ? parseInt(match[1], 10) : 0;

                        if (statusCode >= 200 && statusCode < 300) {
                            const tlsSocket = tls.connect({
                                socket: netSocket,
                                host: 'canary.discord.com',
                                servername: 'canary.discord.com',
                                rejectUnauthorized: true,
                                minVersion: 'TLSv1.2',
                                maxVersion: 'TLSv1.3'
                            });
                            tlsSocket.setNoDelay(true);
                            tlsSocket.on('error', () => {
                                try { tlsSocket.destroy(); } catch { }
                            });
                            resolve(tlsSocket);
                        } else {
                            netSocket.destroy();
                            reject(new Error(`Proxy CONNECT error: ${statusLine}`));
                        }
                    }
                }
            };
            netSocket.on('data', onData);
        });
    }

    // Direct TLS socket
    const socket = tls.connect({
        host: 'canary.discord.com',
        port: 443,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3'
    });
    socket.setNoDelay(true);

    socket.on('error', () => {
        try { socket.destroy(); } catch { }
    });

    return Promise.resolve(socket);
}

function parseHttpResponse(rawBuffer, isSocketEnded = false) {
    const headerSep = Buffer.from('\r\n\r\n');
    const sepIndex = rawBuffer.indexOf(headerSep);
    if (sepIndex === -1) {
        return null;
    }

    const headerStr = rawBuffer.subarray(0, sepIndex).toString('utf-8');
    const headerLines = headerStr.split('\r\n');
    const statusLine = headerLines[0] || '';
    const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})(?:\s+(.*))?$/);

    if (!statusMatch) {
        return { error: 'Invalid HTTP status line', raw: headerStr };
    }

    const statusCode = parseInt(statusMatch[1], 10);
    const statusMessage = statusMatch[2] || '';
    const headers = {};

    for (let i = 1; i < headerLines.length; i++) {
        const line = headerLines[i];
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
            const key = line.substring(0, colonIdx).trim().toLowerCase();
            const val = line.substring(colonIdx + 1).trim();
            headers[key] = val;
        }
    }

    const bodyStart = sepIndex + 4;
    const bodyBuffer = rawBuffer.subarray(bodyStart);

    if (statusCode === 204 || statusCode === 304) {
        return {
            statusCode,
            statusMessage,
            headers,
            body: '',
            remainingBuffer: bodyBuffer
        };
    }

    const isChunked = (headers['transfer-encoding'] || '').toLowerCase().includes('chunked');
    const contentLength = headers['content-length'] ? parseInt(headers['content-length'], 10) : null;

    if (isChunked) {
        let offset = 0;
        const chunkParts = [];

        while (true) {
            const crlfIdx = bodyBuffer.indexOf(Buffer.from('\r\n'), offset);
            if (crlfIdx === -1) {
                return null;
            }

            const sizeHex = bodyBuffer.subarray(offset, crlfIdx).toString('utf-8').trim();
            const chunkSize = parseInt(sizeHex, 16);
            if (isNaN(chunkSize)) {
                return { error: 'Invalid chunk size: ' + sizeHex };
            }

            if (chunkSize === 0) {
                const trailerIdx = bodyBuffer.indexOf(Buffer.from('\r\n'), crlfIdx + 2);
                if (trailerIdx === -1 && bodyBuffer.length < crlfIdx + 4) {
                    return null;
                }
                const finalOffset = (trailerIdx !== -1) ? trailerIdx + 2 : crlfIdx + 4;
                const fullBody = Buffer.concat(chunkParts);
                return {
                    statusCode,
                    statusMessage,
                    headers,
                    body: fullBody.toString('utf-8'),
                    remainingBuffer: bodyBuffer.subarray(finalOffset)
                };
            }

            const dataStart = crlfIdx + 2;
            const dataEnd = dataStart + chunkSize;
            if (bodyBuffer.length < dataEnd + 2) {
                return null;
            }

            chunkParts.push(bodyBuffer.subarray(dataStart, dataEnd));
            offset = dataEnd + 2;
        }
    } else if (contentLength !== null) {
        if (bodyBuffer.length < contentLength) {
            return null;
        }
        const fullBody = bodyBuffer.subarray(0, contentLength);
        return {
            statusCode,
            statusMessage,
            headers,
            body: fullBody.toString('utf-8'),
            remainingBuffer: bodyBuffer.subarray(contentLength)
        };
    } else if (isSocketEnded) {
        return {
            statusCode,
            statusMessage,
            headers,
            body: bodyBuffer.toString('utf-8'),
            remainingBuffer: Buffer.alloc(0)
        };
    }

    return null;
}

// HTTP Connection Manager
let sharedKeepAliveSocket = null;
let sharedSocketBusy = false;

async function sendHttpRequest(method, path, body = null, extraHeaders = {}, closeConnection = false, token = USER_TOKEN, attempt = 1, timeoutMs = 8000) {
    const payload = body ? JSON.stringify(body) : '';
    let socket;
    let isShared = false;

    if (!closeConnection) {
        if (sharedKeepAliveSocket && !sharedKeepAliveSocket.destroyed && !sharedSocketBusy) {
            socket = sharedKeepAliveSocket;
            sharedSocketBusy = true;
            isShared = true;
        } else if (!sharedSocketBusy) {
            try {
                sharedKeepAliveSocket = await createTlsSocket();
                socket = sharedKeepAliveSocket;
                sharedSocketBusy = true;
                isShared = true;
            } catch {
                socket = await createTlsSocket();
                isShared = false;
            }
        } else {
            socket = await createTlsSocket();
            isShared = false;
        }
    } else {
        socket = await createTlsSocket();
        isShared = false;
    }

    return new Promise((resolve) => {
        const headers = [
            `${method} ${path} HTTP/1.1`,
            'Host: canary.discord.com',
            `Connection: ${closeConnection ? 'close' : 'keep-alive'}`,
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(payload)}`,
            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
            `Authorization: ${token}`,
            'X-Super-Properties: eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRmlyZWZveCIsImRldmljZSI6IiIsInN5c3RlbV9sb2NhbGUiOiJ0ci1UUiIsImJyb3dzZXJfdXNlcl9hZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQ7IHJ2OjEzMy4wKSBHZWNrby8yMDEwMDEwMSBGaXJlZm94LzEzMy4wIiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTMzLjAiLCJvc192ZXJzaW9uIjoiMTAiLCJyZWZlcnJlciI6Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vIiwicmVmZXJyaW5nX2RvbWFpbiI6Ind3dy5nb29nbGUuY29tIiwic2VhcmNoX2VuZ2luZSI6Imdvb2dsZSIsInJlZmVycmVyX2N1cnJlbnQiOiIiLCJyZWZlcnJpbmdfZG9tYWluX2N1cnJlbnQiOiIiLCJyZWxlYXNlX2NoYW5uZWwiOiJjYW5hcnkiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjozNTYxNDAsImNsaWVudF9ldmVudF9zb3VyY2UiOm51bGwsImhhc19jbGllbnRfbW9kcyI6ZmFsc2V9'
        ];

        if (extraHeaders['X-Discord-MFA-Authorization']) {
            headers.push(`X-Discord-MFA-Authorization: ${extraHeaders['X-Discord-MFA-Authorization']}`);
        }

        headers.push('', payload);

        let recvBuffer = socket._residualBuffer || Buffer.alloc(0);
        socket._residualBuffer = Buffer.alloc(0);

        let isCompleted = false;

        const cleanupAndFinish = (responseObj) => {
            if (isCompleted) return;
            isCompleted = true;
            clearTimeout(timeoutId);

            socket.removeListener('data', onData);
            socket.removeListener('end', onEnd);
            socket.removeListener('error', onError);

            if (isShared) {
                sharedSocketBusy = false;
                if (closeConnection || (responseObj?.headers && responseObj.headers['connection'] === 'close')) {
                    try { socket.destroy(); } catch { }
                    sharedKeepAliveSocket = null;
                }
            } else {
                try { socket.destroy(); } catch { }
            }

            let parsedJson = null;
            if (responseObj?.body) {
                try { parsedJson = JSON.parse(responseObj.body); } catch { }
            }

            resolve({
                statusCode: responseObj?.statusCode || 0,
                statusMessage: responseObj?.statusMessage || '',
                headers: responseObj?.headers || {},
                body: responseObj?.body || '',
                json: parsedJson,
                ok: (responseObj?.statusCode >= 200 && responseObj?.statusCode < 300)
            });
        };

        const timeoutId = setTimeout(() => {
            if (isCompleted) return;
            try { socket.destroy(); } catch { }
            if (isShared) {
                sharedSocketBusy = false;
                sharedKeepAliveSocket = null;
            }

            if (attempt <= 3) {
                resolve(sendHttpRequest(method, path, body, extraHeaders, closeConnection, token, attempt + 1, timeoutMs));
            } else {
                cleanupAndFinish({ statusCode: 408, statusMessage: 'Request Timeout', body: '' });
            }
        }, timeoutMs);

        const onData = (chunk) => {
            recvBuffer = Buffer.concat([recvBuffer, chunk]);
            const parsed = parseHttpResponse(recvBuffer, false);
            if (parsed) {
                if (parsed.error) {
                    cleanupAndFinish({ statusCode: 500, statusMessage: parsed.error, body: '' });
                } else {
                    socket._residualBuffer = parsed.remainingBuffer;
                    cleanupAndFinish(parsed);
                }
            }
        };

        const onEnd = () => {
            const parsed = parseHttpResponse(recvBuffer, true);
            cleanupAndFinish(parsed || { statusCode: 0, statusMessage: 'Connection Closed', body: '' });
        };

        const onError = (err) => {
            if (isCompleted) return;
            try { socket.destroy(); } catch { }
            if (isShared) {
                sharedSocketBusy = false;
                sharedKeepAliveSocket = null;
            }

            if (attempt <= 3) {
                resolve(sendHttpRequest(method, path, body, extraHeaders, closeConnection, token, attempt + 1, timeoutMs));
            } else {
                cleanupAndFinish({ statusCode: 500, statusMessage: err.message, body: '' });
            }
        };

        socket.on('data', onData);
        socket.once('end', onEnd);
        socket.once('error', onError);

        if (recvBuffer.length > 0) {
            const initialCheck = parseHttpResponse(recvBuffer, false);
            if (initialCheck && !initialCheck.error) {
                socket._residualBuffer = initialCheck.remainingBuffer;
                cleanupAndFinish(initialCheck);
                return;
            }
        }

        socket.write(headers.join('\r\n'));
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

    if (mentionEveryone) {
        payload.content = "@everyone";
    }

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

// --- MFA UTILS ---

async function solveMfaChallenge(ticket) {
    if (!USER_PASSWORD) {
        console.log("\x1b[31m[MFA] ❌ Cannot solve MFA: PASSWORD is not set in .env!\x1b[0m");
        return null;
    }

    console.log("\x1b[33m[MFA] 🔒 Two-Factor Auth Challenge detected. Auto-solving with account password...\x1b[0m");
    const finishRes = await sendHttpRequest('POST', '/api/v9/mfa/finish', {
        ticket: ticket,
        mfa_type: 'password',
        data: USER_PASSWORD
    }, {}, true);

    if (finishRes.json?.token) {
        console.log('\x1b[32m[MFA] 🔓 MFA TOKEN OBTAINED SUCCESSFULLY!\x1b[0m');
        mfaAuthToken = finishRes.json.token;
        await sendWebhook("MFA Security Solved", "Successfully solved 2FA challenge and obtained authorization token.", 0x00FF00);
        return finishRes.json.token;
    } else {
        const errMsg = finishRes.json?.message || finishRes.statusMessage || 'Unknown error';
        console.log(`\x1b[31m[MFA] ❌ Failed to get MFA Token: ${errMsg} (Code: ${finishRes.json?.code})\x1b[0m`);
        await sendWebhook("MFA Failed", `Failed to solve MFA challenge.\nError: ${errMsg}`, 0xFF0000);
        return null;
    }
}

async function authenticateMfa() {
    console.log("\x1b[36m[MFA] 🛡️ Checking Security Requirements...\x1b[0m");
    if (!USER_PASSWORD) {
        console.log("\x1b[33m[MFA] ⚠️ No PASSWORD provided in .env. Skipping pre-authentication.\x1b[0m");
        return null;
    }

    try {
        const patchRes = await sendHttpRequest('PATCH', `/api/v9/guilds/${TARGET_GUILD_ID}/vanity-url`, { code: VANITY_CODE }, {}, true);
        const patchData = patchRes.json || {};

        if (patchData.code === 60003 && patchData.mfa?.ticket) {
            console.log("\x1b[33m[MFA] 🔒 Two-Factor Auth Required (Code 60003). Auto-Solving...\x1b[0m");
            return await solveMfaChallenge(patchData.mfa.ticket);
        } else if (patchRes.statusCode === 200 && (patchData.code === VANITY_CODE || patchData.vanity_url_code === VANITY_CODE)) {
            console.log(`\x1b[32m!!! VICTORY !!! Vanity '${VANITY_CODE}' claimed during initial verification!\x1b[0m`);
            await sendWebhook("🎯 VANITY URL SNIPED!", `**URL:** ${VANITY_CODE}\n**Guild:** ${TARGET_GUILD_ID}`, 0x00FF00, true);
            return "ALREADY_CLAIMED";
        } else {
            console.log(`\x1b[32m[MFA] ✅ Pre-check complete (HTTP ${patchRes.statusCode}). Ready.\x1b[0m`);
            return null;
        }
    } catch (e) {
        console.log(`\x1b[31m[MFA] Auth verification error: ${e.message}\x1b[0m`);
        return null;
    }
}

// --- CLAIM LOGIC ---

async function tryClaim(code = VANITY_CODE, targetGuildId = TARGET_GUILD_ID, keepAlive = false, isRetry = false) {
    if (!code) return false;

    console.log(`\x1b[36m[Sniper] 🔫 Attempting to claim '${code}' on Guild '${targetGuildId}'...\x1b[0m`);

    const headers = {};
    if (mfaAuthToken) {
        headers['X-Discord-MFA-Authorization'] = mfaAuthToken;
    }

    const res = await sendHttpRequest(
        'PATCH',
        `/api/v9/guilds/${targetGuildId}/vanity-url`,
        { code: code },
        headers,
        true
    );

    const result = res.json || {};

    // 1. Handle MFA challenge (code 60003)
    if (result.code === 60003 && result.mfa?.ticket) {
        if (isRetry) {
            console.log("\x1b[31m[MFA] ❌ Code 60003 returned again after solving MFA.\x1b[0m");
            return false;
        }
        console.log("\x1b[33m[Sniper] ⚠️ MFA required or token expired (Code 60003). Auto-solving now...\x1b[0m");
        const freshToken = await solveMfaChallenge(result.mfa.ticket);
        if (freshToken) {
            return await tryClaim(code, targetGuildId, keepAlive, true);
        }
        return false;
    }

    // 2. Handle 429 Rate Limit
    if (res.statusCode === 429) {
        const retryAfter = result.retry_after || parseFloat(res.headers['retry-after']) || 2;
        console.log(`\x1b[31m[Sniper] ⛔ Rate Limited (429)! Cooldown: ${retryAfter}s\x1b[0m`);
        await new Promise(r => setTimeout(r, Math.ceil(retryAfter * 1000)));
        return false;
    }

    // 3. Strict Victory Verification
    const isSuccess = res.statusCode === 200 && (result.code === code || result.vanity_url_code === code);

    if (isSuccess) {
        console.log(`\x1b[32m!!! VICTORY !!! URL '${code}' SNIPED SUCCESSFULLY ON GUILD ${targetGuildId} !\x1b[0m`);
        await sendWebhook("🎯 VANITY URL SNIPED!", `**URL:** ${code}\n**Guild:** ${targetGuildId}`, 0x00FF00, true);

        if (keepAlive) {
            console.log("\x1b[35m[Guard] 🛡️ Entering GUARD MODE. Watching servers to re-claim if the URL drops.\x1b[0m");
            await sendWebhook("🛡️ Guard Mode Active", `Watching for changes to **${code}** on **${targetGuildId}**...`, 0x0000FF);
        }
        return true;
    }

    // 4. Detailed error diagnosis
    if (result.code === 50013) {
        console.log(`\x1b[31m[Sniper] ⛔ PERMISSION DENIED (50013): Missing 'Manage Server' on Guild ${targetGuildId}.\x1b[0m`);
        await sendWebhook("⛔ Permission Denied", `Code 50013: Missing 'Manage Server' permission on Guild ${targetGuildId}.`, 0xFF0000);
    } else if (result.code === 50020) {
        console.log(`\x1b[33m[Sniper] ⚠️ Vanity '${code}' is already taken (Code: 50020).\x1b[0m`);
    } else if (result.code === 50035) {
        console.log(`\x1b[31m[Sniper] ⚠️ Invalid vanity code '${code}' (Code: 50035).\x1b[0m`);
    } else if (result.code) {
        console.log(`\x1b[31m[Sniper] ❌ Failed: ${result.message} (Code: ${result.code})\x1b[0m`);
    } else {
        console.log(`\x1b[31m[Sniper] ❌ Server returned HTTP ${res.statusCode}: ${res.body || res.statusMessage}\x1b[0m`);
    }

    return false;
}

// --- VERIFICATION CHECKS ---

async function verifyTokens() {
    validatedAccounts = [];
    console.log(`\x1b[36m[Check] Verifying ${USER_TOKENS.length} token(s)...\x1b[0m`);

    for (let i = 0; i < USER_TOKENS.length; i++) {
        const token = USER_TOKENS[i];
        const res = await sendHttpRequest('GET', '/api/v9/users/@me', null, {}, true, token);
        if (res.statusCode === 200 && res.json?.id) {
            const acc = res.json;
            const tag = acc.discriminator && acc.discriminator !== '0' ? `#${acc.discriminator}` : '';
            console.log(`\x1b[32m[Auth] ✅ Token #${i + 1}: ${acc.username}${tag} (ID: ${acc.id})\x1b[0m`);
            validatedAccounts.push({ token, user: acc });
        } else {
            console.log(`\x1b[31m[Auth] ❌ Token #${i + 1} INVALID! (Status: ${res.statusCode})\x1b[0m`);
        }
    }
    return validatedAccounts.length > 0;
}

async function verifyGuilds() {
    validatedGuilds = [];
    console.log(`\x1b[36m[Check] Verifying ${TARGET_GUILD_IDS.length} target guild(s)...\x1b[0m`);

    for (let i = 0; i < TARGET_GUILD_IDS.length; i++) {
        const guildId = TARGET_GUILD_IDS[i];
        const res = await sendHttpRequest('GET', `/api/v9/guilds/${guildId}`, null, {}, true);
        const data = res.json || {};

        if (res.statusCode === 200 && data.id === guildId) {
            const hasVanityFeature = Array.isArray(data.features) && data.features.includes('VANITY_URL');
            const vanityStatus = data.vanity_url_code ? `Current: '${data.vanity_url_code}'` : 'No vanity';
            console.log(`\x1b[32m[Check] ✅ Guild #${i + 1}: "${data.name}" (${vanityStatus}, Tier: ${data.premium_tier || 0}, Feature: ${hasVanityFeature ? 'YES' : 'NO'})\x1b[0m`);
            validatedGuilds.push(data);
        } else {
            console.log(`\x1b[31m[Check] ❌ Guild #${i + 1} (${guildId}) check failed! (Status: ${res.statusCode})\x1b[0m`);
            if (data.code === 10004) console.log("👉 Diagnosis: UNKNOWN GUILD. Account is not in this server or ID is wrong.");
        }
    }
    return validatedGuilds.length > 0;
}

// --- GATEWAY MANAGER (MULTI-TOKEN & MULTI-GUILD) ---

class GatewayClient {
    constructor(token, accountName, onDropCallback) {
        this.token = token;
        this.accountName = accountName;
        this.onDrop = onDropCallback;
        this.ws = null;
        this.heartbeatTimer = null;
        this.heartbeatAcked = true;
        this.sessionId = null;
        this.resumeGatewayUrl = null;
        this.latestSequence = null;
        this.shouldReconnect = true;
        this.guildVanities = new Map();
    }

    connect() {
        this.clearHeartbeat();
        const endpoint = (this.resumeGatewayUrl && this.sessionId)
            ? `${this.resumeGatewayUrl}/?v=9&encoding=json`
            : 'wss://gateway.discord.gg/?v=9&encoding=json';

        const wsOptions = {};
        if (activeProxy) {
            wsOptions.createConnection = (options, cb) => {
                createTlsSocket(activeProxy)
                    .then(sock => cb(null, sock))
                    .catch(err => cb(err));
            };
        }

        this.ws = new WebSocket(endpoint, wsOptions);

        this.ws.on('error', (err) => {
            console.log(`\x1b[31m[Gateway-${this.accountName}] Error: ${err.message}\x1b[0m`);
        });

        this.ws.on('open', () => {
            console.log(`\x1b[36m[Gateway-${this.accountName}] Connected.\x1b[0m`);

            if (this.sessionId && this.latestSequence !== null) {
                this.sendPacket({
                    op: 6,
                    d: {
                        token: this.token,
                        session_id: this.sessionId,
                        seq: this.latestSequence
                    }
                });
            } else {
                this.sendPacket({
                    op: 2,
                    d: {
                        token: this.token,
                        intents: 1,
                        properties: { $os: 'Windows', $browser: 'Firefox', $device: '' }
                    }
                });
            }
        });

        this.ws.on('message', async (data) => {
            try {
                const packet = JSON.parse(data);
                if (packet.s !== null && packet.s !== undefined) {
                    this.latestSequence = packet.s;
                }

                if (packet.op === 10) {
                    const interval = packet.d.heartbeat_interval;
                    this.heartbeatAcked = true;
                    this.clearHeartbeat();

                    const jitter = Math.floor(interval * Math.random());
                    setTimeout(() => {
                        this.sendHeartbeat();
                        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), interval);
                    }, jitter);
                } else if (packet.op === 11) {
                    this.heartbeatAcked = true;
                } else if (packet.op === 7) {
                    this.reconnect(true);
                } else if (packet.op === 9) {
                    const canResume = packet.d === true;
                    if (!canResume) {
                        this.sessionId = null;
                        this.latestSequence = null;
                    }
                    this.reconnect(canResume);
                } else if (packet.op === 0) {
                    if (packet.t === 'READY') {
                        this.sessionId = packet.d.session_id;
                        if (packet.d.resume_gateway_url) {
                            this.resumeGatewayUrl = packet.d.resume_gateway_url;
                        }
                        console.log(`\x1b[32m[Gateway-${this.accountName}] Ready! Monitoring ${packet.d.guilds?.length || 0} mutual guild(s).\x1b[0m`);

                        if (Array.isArray(packet.d.guilds)) {
                            for (const g of packet.d.guilds) {
                                if (g.id && g.vanity_url_code) {
                                    this.guildVanities.set(g.id, g.vanity_url_code);
                                }
                            }
                        }
                    } else if (packet.t === 'RESUMED') {
                        console.log(`\x1b[32m[Gateway-${this.accountName}] Session resumed.\x1b[0m`);
                    } else if (packet.t === 'GUILD_CREATE') {
                        const g = packet.d;
                        if (g.id && g.vanity_url_code) {
                            this.guildVanities.set(g.id, g.vanity_url_code);
                        }
                    } else if (packet.t === 'GUILD_UPDATE') {
                        const guild = packet.d;
                        const previousVanity = this.guildVanities.get(guild.id);
                        const currentVanity = guild.vanity_url_code;
                        this.guildVanities.set(guild.id, currentVanity);

                        this.onDrop(guild, previousVanity, currentVanity, this.accountName);
                    }
                }
            } catch (err) {
                console.log(`\x1b[31m[Gateway-${this.accountName}] Message Error: ${err.message}\x1b[0m`);
            }
        });

        this.ws.on('close', (code, reason) => {
            this.clearHeartbeat();
            if (!this.shouldReconnect) return;
            setTimeout(() => {
                if (this.shouldReconnect) this.connect();
            }, 3000);
        });
    }

    sendPacket(obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj));
        }
    }

    sendHeartbeat() {
        if (!this.heartbeatAcked) {
            this.reconnect(true);
            return;
        }
        this.heartbeatAcked = false;
        this.sendPacket({ op: 1, d: this.latestSequence });
    }

    clearHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    reconnect(attemptResume = true) {
        if (!attemptResume) {
            this.sessionId = null;
            this.latestSequence = null;
        }
        this.clearHeartbeat();
        if (this.ws) {
            try { this.ws.terminate(); } catch { }
            this.ws = null;
        }
    }

    stop() {
        this.shouldReconnect = false;
        this.clearHeartbeat();
        if (this.ws) {
            try { this.ws.close(); } catch { }
            this.ws = null;
        }
    }
}

class MultiGatewayManager {
    constructor() {
        this.clients = [];
        this.activeCode = VANITY_CODE;
    }

    start(codeToGuard) {
        this.activeCode = codeToGuard || VANITY_CODE;
        if (this.clients.length > 0) {
            console.log(`\x1b[35m[Multi-Gateway] Active code updated: '${this.activeCode}' across ${this.clients.length} token client(s).\x1b[0m`);
            return;
        }

        console.log(`\x1b[36m[Multi-Gateway] Spawning Gateway clients for ${USER_TOKENS.length} account(s)...\x1b[0m`);

        for (let i = 0; i < USER_TOKENS.length; i++) {
            const token = USER_TOKENS[i];
            const accName = validatedAccounts[i]?.user?.username || `Token-${i + 1}`;

            const client = new GatewayClient(token, accName, (guild, prevVanity, currVanity, accountName) => {
                this.handleGuildUpdate(guild, prevVanity, currVanity, accountName);
            });
            client.connect();
            this.clients.push(client);
        }
    }

    async handleGuildUpdate(guild, previousVanity, currentVanity, accountName) {
        // CASE 1: Guarding any of our target guilds
        if (TARGET_GUILD_IDS.includes(guild.id)) {
            if (this.activeCode && currentVanity !== this.activeCode) {
                console.log(`\x1b[31m[Guard] 🚨 ALERT via ${accountName}! Target Guild '${guild.name}' (${guild.id}) URL changed to '${currentVanity || "NONE"}'! Re-claiming '${this.activeCode}' NOW!\x1b[0m`);
                await sendWebhook("🚨 GUARD TRIGGERED", `Target Guild **${guild.name}** lost vanity **${this.activeCode}**! Re-claiming!`, 0xFF0000, true);
                await tryClaim(this.activeCode, guild.id, true);
            }
        }
        // CASE 2: External Guild dropped target code
        else {
            for (const targetCode of VANITY_CODES) {
                const hadTarget = (previousVanity === targetCode);
                const lostTarget = (currentVanity !== targetCode);

                if (hadTarget && lostTarget) {
                    console.log(`\x1b[32m[Gateway Snipe] 🎯 DROP DETECTED by ${accountName}! Guild '${guild.name}' dropped '${targetCode}'! SNIPING NOW...\x1b[0m`);
                    await sendWebhook("🎯 EXTERNAL DROP DETECTED", `Account **${accountName}** detected Guild **${guild.name}** dropped **${targetCode}**!`, 0x00FF00, true);

                    // Claim on primary target guild (or find first target guild needing vanity)
                    for (const targetGuildId of TARGET_GUILD_IDS) {
                        const success = await tryClaim(targetCode, targetGuildId, true);
                        if (success) {
                            this.activeCode = targetCode;
                            break;
                        }
                    }
                }
            }
        }
    }

    setActiveCode(code) {
        this.activeCode = code;
    }

    stop() {
        for (const client of this.clients) {
            client.stop();
        }
        this.clients = [];
    }
}

const multiGateway = new MultiGatewayManager();

// --- CONFIG DISPLAY ---

const printConfig = () => {
    const vanityStr = VANITY_CODES.join(", ") || "MISSING";
    const displayVanity = vanityStr.length > 36 ? vanityStr.substring(0, 33) + "..." : vanityStr;

    const tokenSummary = `${USER_TOKENS.length} Token(s) Loaded`;
    const guildSummary = `${TARGET_GUILD_IDS.length} Guild(s) Loaded`;
    const proxyStatus = activeProxy ? `✅ ${activeProxy.host}:${activeProxy.port} (${activeProxy.latency || 0}ms)` : "❌ Direct Connection";

    console.log(`
    \x1b[36m┌──────────────────────┬──────────────────────────────────────┐
    │ \x1b[1mCONFIGURATION\x1b[0m\x1b[36m        │ \x1b[1mSTATUS\x1b[0m\x1b[36m                               │
    ├──────────────────────┼──────────────────────────────────────┤
    │ Tokens               │ \x1b[32m${tokenSummary.padEnd(36)}\x1b[36m │
    │ Target Guilds        │ \x1b[33m${guildSummary.padEnd(36)}\x1b[36m │
    │ Vanity URL(s)        │ \x1b[35m${displayVanity.padEnd(36)}\x1b[36m │
    │ Password             │ ${USER_PASSWORD ? "\x1b[32m✅ Loaded\x1b[36m                           " : "\x1b[31m❌ MISSING\x1b[36m                          "} │
    │ Proxy                │ \x1b[32m${proxyStatus.padEnd(36)}\x1b[36m │
    │ Webhook              │ ${WEBHOOK_URL ? "\x1b[32m✅ Loaded\x1b[36m                           " : "\x1b[31m❌ MISSING\x1b[36m                          "} │
    └──────────────────────┴──────────────────────────────────────┘\x1b[0m`);

    console.log(`    \x1b[33mTarget Guilds:\x1b[0m ${TARGET_GUILD_IDS.join(', ')}`);
    console.log(`    \x1b[35mTarget Vanities:\x1b[0m ${vanityStr}\n`);
};

// --- MODES ---

async function modeInstant() {
    await sendWebhook("🚀 Sniper Started", "Mode: Instant Snipe", 0xFFFF00);
    const guildsOK = await verifyGuilds();
    if (!guildsOK) {
        rl.question("\nPress Enter to return...", () => showMenu());
        return;
    }

    const authResult = await authenticateMfa();
    if (authResult === "ALREADY_CLAIMED") {
        rl.question("\nVanity already claimed on primary guild! Press Enter to return...", () => showMenu());
        return;
    }

    console.log(`\x1b[36m[Instant] 🔄 Checking list: ${VANITY_CODES.join(', ')}\x1b[0m`);
    for (const code of VANITY_CODES) {
        for (const guildId of TARGET_GUILD_IDS) {
            const success = await tryClaim(code, guildId, false);
            if (success) {
                console.log("\x1b[32mClaim completed successfully! Exiting...\x1b[0m");
                await new Promise(r => setTimeout(r, 1000));
                process.exit(0);
            }
        }
        await new Promise(r => setTimeout(r, 200));
    }
    rl.question("\nFinished checklist. Press Enter to return...", () => showMenu());
}

async function modeGateway() {
    await sendWebhook("🚀 Sniper Started", "Mode: Gateway Sniper (Multi-Token Guard Active)", 0xFFFF00);
    const guildsOK = await verifyGuilds();
    if (!guildsOK) {
        rl.question("\nPress Enter to return...", () => showMenu());
        return;
    }

    const authResult = await authenticateMfa();
    if (authResult === "ALREADY_CLAIMED") {
        console.log(`\x1b[35m[Gateway] 🛡️ Vanity '${VANITY_CODE}' is already claimed! Starting Multi-Token Guard.\x1b[0m`);
        multiGateway.start(VANITY_CODE);
        return;
    }

    console.log(`\x1b[36m[Gateway] 📡 Monitoring for: ${VANITY_CODES.join(', ')}\x1b[0m`);

    for (const code of VANITY_CODES) {
        for (const guildId of TARGET_GUILD_IDS) {
            const success = await tryClaim(code, guildId, true);
            if (success) {
                multiGateway.start(code);
                return;
            }
        }
        await new Promise(r => setTimeout(r, 200));
    }

    multiGateway.start(VANITY_CODE);
}

async function modeAggressive() {
    await sendWebhook("🚀 Sniper Started", "Mode: Aggressive Mode (High Speed)", 0xFFFF00);
    const guildsOK = await verifyGuilds();
    if (!guildsOK) {
        rl.question("\nPress Enter to return...", () => showMenu());
        return;
    }

    const authResult = await authenticateMfa();
    if (authResult === "ALREADY_CLAIMED") {
        console.log(`\x1b[35m[Aggressive] 🛡️ Vanity '${VANITY_CODE}' is already active! Starting Guard.\x1b[0m`);
        multiGateway.start(VANITY_CODE);
        return;
    }

    multiGateway.start(VANITY_CODE);

    console.log(`\x1b[36m[Aggressive] 🚀 STARTING MONITORING FOR: ${VANITY_CODES.join(', ')} across ${TARGET_GUILD_IDS.length} guild(s)\x1b[0m`);
    console.log(`\x1b[33mPress Ctrl+C to stop.\x1b[0m`);

    const CHECK_INTERVAL = 150;
    let nextCheckTime = Date.now();
    let checks = 0;
    const statsShowInterval = 25;

    while (true) {
        const now = Date.now();
        if (now >= nextCheckTime) {
            checks++;

            for (const guildId of TARGET_GUILD_IDS) {
                const res = await sendHttpRequest('GET', `/api/v9/guilds/${guildId}/vanity-url`, null, {}, false);

                if (res.statusCode === 429) {
                    const retryAfter = res.json?.retry_after || parseFloat(res.headers['retry-after']) || 2;
                    console.log(`\n\x1b[33m[Aggressive] ⏳ Rate limit reached (429). Pausing for ${retryAfter}s...\x1b[0m`);
                    await new Promise(r => setTimeout(r, Math.ceil(retryAfter * 1000)));
                    nextCheckTime = Date.now() + CHECK_INTERVAL;
                    break;
                }

                if (res.statusCode === 200 && res.json) {
                    const currentVanity = res.json.code;
                    if (currentVanity && VANITY_CODES.includes(currentVanity)) {
                        multiGateway.setActiveCode(currentVanity);
                    } else {
                        console.log(`\n\x1b[31m[Aggressive] 🚨 Guild ${guildId} vanity is '${currentVanity || "NONE"}'. Target missing! Claiming...\x1b[0m`);
                        for (const code of VANITY_CODES) {
                            const success = await tryClaim(code, guildId, true);
                            if (success) {
                                multiGateway.setActiveCode(code);
                                return;
                            }
                        }
                    }
                } else if (res.statusCode === 404) {
                    console.log(`\n\x1b[31m[Aggressive] 🚨 Guild ${guildId} has no vanity! Claiming...\x1b[0m`);
                    for (const code of VANITY_CODES) {
                        const success = await tryClaim(code, guildId, true);
                        if (success) {
                            multiGateway.setActiveCode(code);
                            return;
                        }
                    }
                }
            }

            if (checks % statsShowInterval === 0) {
                process.stdout.write(`\x1b[36m[Aggressive] Pulse: ${checks} checks completed...\r\x1b[0m`);
            }

            nextCheckTime = now + CHECK_INTERVAL;
        }

        const sleepTime = Math.max(0, nextCheckTime - Date.now());
        if (sleepTime > 0) {
            await new Promise(r => setTimeout(r, Math.min(sleepTime, 50)));
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

    await sendWebhook("🕒 Scheduled Snipe Active", `Monitoring until **${targetDate.toLocaleString()}** for **${VANITY_CODES.join(', ')}**`, 0x00FFFF);

    let mfaPreArmed = false;

    const countdown = setInterval(() => {
        const now = Date.now();
        const diff = targetTs - now;

        if (diff <= 0) {
            clearInterval(countdown);
            return;
        }

        if (diff > 10000) {
            const hours = Math.floor(diff / 3600000);
            const mins = Math.floor((diff % 3600000) / 60000);
            const secs = Math.floor((diff % 60000) / 1000);
            process.stdout.write(`\x1b[36m[Countdown] T-Minus: ${hours}h ${mins}m ${secs}s ...     \r\x1b[0m`);
        }
    }, 1000);

    while (true) {
        const now = Date.now();
        const diff = targetTs - now;

        if (diff <= 60000 && !mfaPreArmed) {
            mfaPreArmed = true;
            console.log("\n\x1b[36m[Grace Tracker] 🛡️ Pre-arming MFA verification (T-60s)...\x1b[0m");
            await authenticateMfa();
        }

        if (diff <= 10000) {
            clearInterval(countdown);
            console.log(`\n\x1b[31m[Grace Tracker] 🚨 T-10 SECONDS! INITIATING BURST MODE NOW!\x1b[0m`);
            await sendWebhook("🚨 BURST MODE", "Scheduled target is 10 seconds away! Starting burst claim attempts.", 0xFF0000);

            const burstInterval = 50;
            let nextBurst = Date.now();

            while (Date.now() < targetTs + 5000) {
                const current = Date.now();
                if (current >= nextBurst) {
                    for (const code of VANITY_CODES) {
                        for (const guildId of TARGET_GUILD_IDS) {
                            const success = await tryClaim(code, guildId, false);
                            if (success) {
                                console.log(`\x1b[32m!!! SUCCESS !!! SCHEDULED SNIPE VICTORY: ${code} on ${guildId} !\x1b[0m`);
                                await new Promise(r => setTimeout(r, 1000));
                                process.exit(0);
                            }
                        }
                    }
                    nextBurst = current + burstInterval;
                }
                await new Promise(r => setTimeout(r, 10));
            }

            console.log("\n\x1b[33m[Grace Tracker] Target window passed. Returning to menu.\x1b[0m");
            break;
        }

        await new Promise(r => setTimeout(r, 200));
    }

    rl.question("\nPress Enter to return...", () => showMenu());
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
    console.log("\x1b[36m2. Gateway Sniper (Multi-Token Real-time Listener)\x1b[0m");
    console.log("\x1b[36m3. Aggressive Mode (High Speed Monitoring)\x1b[0m");
    console.log("\x1b[36m4. Grace Period Tracker (Scheduled Snipe)\x1b[0m");
    console.log("\x1b[36m5. Configuration & Proxy Check\x1b[0m");
    console.log("\x1b[31m6. Exit\x1b[0m");

    rl.question("\n\x1b[33mSelect Mode (1-6): \x1b[0m", handleMenu);
}

async function handleMenu(option) {
    if (option === '1') {
        await modeInstant();
    } else if (option === '2') {
        console.log("Starting Multi-Token Gateway Sniper...");
        await modeGateway();
    } else if (option === '3') {
        await modeAggressive();
    } else if (option === '4') {
        await modeScheduled();
    } else if (option === '5') {
        printConfig();
        await verifyTokens();
        await verifyGuilds();
        rl.question("\nPress Enter to return...", () => showMenu());
    } else if (option === '6') {
        console.log("Exiting...");
        multiGateway.stop();
        process.exit(0);
    } else {
        showMenu();
    }
}

async function bootstrap() {
    if (USER_TOKENS.length === 0 || TARGET_GUILD_IDS.length === 0 || !USER_PASSWORD || VANITY_CODES.length === 0) {
        console.error("\x1b[31m[Config Error] Missing required variables in .env (TOKEN, GUILD_ID, PASSWORD, VANITY_URL)!\x1b[0m");
        process.exit(1);
    }

    // 1. Initialize and test proxies
    activeProxy = await initProxies();

    // 2. Start menu
    showMenu();
}

bootstrap();
