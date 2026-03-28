/**
 * whatsapp.js — WPPConnect local WhatsApp bridge
 *
 * WHY WPPConnect FOR A HACKATHON:
 *   • Runs 100% on your machine — zero cloud accounts needed
 *   • One npm package, no sign-ups, no API keys, no credit cards
 *   • Saves the WhatsApp session to a local file so you only scan
 *     the QR code ONCE — restarts don't need a rescan
 *   • Fires an event directly in Node.js when a message arrives,
 *     so we don't need webhooks or a public URL at all
 *
 * HOW IT WORKS UNDER THE HOOD:
 *   WPPConnect uses Puppeteer (headless Chromium) to run WhatsApp Web
 *   invisibly in the background. It exposes a clean JS API on top.
 *   The QR code it gives us is identical to the one on web.whatsapp.com.
 *
 * SESSION PERSISTENCE:
 *   After the first QR scan, WPPConnect saves an encrypted session token
 *   to ./tokens/<session-name>/. On the next restart it rehydrates
 *   automatically — no re-scan needed during the hackathon demo.
 *
 * FIRST-TIME SETUP NOTE:
 *   The first `npm install` will download Chromium (~170 MB).
 *   This is a one-time cost — do it before the hackathon presentation.
 */

const wppconnect = require('@wppconnect-team/wppconnect');
const fs2 = require('fs');
function getChromePath() {
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  const found = paths.find(p => { try { return fs2.existsSync(p); } catch { return false; } });
  console.log('[wpp] Chrome:', found || 'not found, using built-in');
  return found || undefined;
}
const qrcode     = require('qrcode');
require('dotenv').config();

// ── Module-level state ────────────────────────────────────────────────────────
// We keep a single WPPConnect client instance for the lifetime of the process.
// Everything (QR, groups, message events) flows through this one object.

let wppClient   = null;   // the WPPConnect client once created
let qrCodeData  = null;   // base64 PNG of latest QR code (for GET /api/session/qr)
let sessionState = 'LOADING'; // 'LOADING' | 'QR_READY' | 'CONNECTED' | 'DISCONNECTED'
let connectedPhone = null;
let connectedName  = null;

// Callbacks registered by webhook.js so it receives message events
const messageHandlers = [];

// ─────────────────────────────────────────────────────────────────────────────
// INITIALISE — called once on server startup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * initWPP()
 *
 * Starts WPPConnect. If a saved session exists, it reconnects silently.
 * If not, it generates a QR code and waits for the student to scan.
 *
 * This is async and resolves quickly — the actual WhatsApp connection
 * happens in the background while the server is already serving routes.
 */
async function initWPP() {
  console.log('[wpp] Starting WPPConnect...');
  sessionState = 'LOADING';

  try {
    wppClient = await wppconnect.create({
      session:    process.env.WPP_SESSION_NAME || 'studysync-demo',
      catchQR:    onQRCode,          // called when a fresh QR is ready
      statusFind: onStatusChange,    // called when connection status changes
      headless:   true,              // run Chromium invisibly
      logQR:      false,             // don't print QR to terminal (we serve it via API)
      disableWelcome: true,
      autoClose: 0,
      executablePath: getChromePath(),

      // Store the session token as a local JSON file.
      // This means after the first scan, restarts don't need a re-scan.
      tokenStore: process.env.WPP_TOKEN_STORE || 'file',

      // Folder where session tokens are saved
      folderNameToken: './tokens',

      // Browser args for running in a hackathon laptop environment
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    });

    // ── Register message listener ─────────────────────────────────────────
    // This is the equivalent of a webhook — but all in-process, no HTTP needed.
    // Every incoming message fires this callback.
    wppClient.onMessage(async (message) => {
      for (const handler of messageHandlers) {
        try {
          await handler(message);
        } catch (err) {
          console.error('[wpp] Message handler error:', err.message);
        }
      }
    });

    console.log('[wpp] WPPConnect client ready');

  } catch (err) {
    console.error('[wpp] Failed to start WPPConnect:', err.message);
    sessionState = 'DISCONNECTED';
    // Non-fatal: the server still runs, demo mode still works
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WPPConnect CALLBACKS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * onQRCode(qrData, asciiArt, attempt)
 *
 * WPPConnect calls this when a QR code is ready to display.
 * We convert the raw QR data into a base64 PNG using the `qrcode` package.
 * The frontend polls GET /api/session/qr to fetch this image.
 */
async function onQRCode(qrData, asciiArt, attempt) {
  console.log(`[wpp] QR code ready (attempt ${attempt})`);
  sessionState = 'QR_READY';
  qrCodeData = qrData;
}

/**
 * onStatusChange(status)
 *
 * WPPConnect calls this when the connection state changes.
 * Possible values: 'notLogged', 'browserClose', 'qrReadSuccess',
 *                  'chatsAvailable', 'connected', 'desconnectedMobile', etc.
 */
function onStatusChange(status) {
  console.log('[wpp] Status:', status);

  switch (status) {
    case 'isLogged':
    case 'qrReadSuccess':
    case 'chatsAvailable':
    case 'connected':
      sessionState = 'CONNECTED';
      break;
    case 'notLogged':
    case 'browserClose':
    case 'desconnectedMobile':
    case 'deleteToken':
      sessionState = 'DISCONNECTED';
      qrCodeData   = null;
      wppClient    = null;
      break;
    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API — called by server.js route handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getQRCode()
 * Returns the current QR code as a base64 PNG string.
 * Returns null if session is already connected or QR not ready yet.
 */
function getQRCode() {
  return {
    qrBase64:  qrCodeData,
    mimeType:  'image/png',
    expiresIn: 60,
    status:    sessionState,
  };
}

/**
 * checkSessionStatus()
 * Returns current connection state — polled by frontend every 3 seconds.
 */
async function checkSessionStatus() {
  if (!wppClient || sessionState !== 'CONNECTED') {
    return { status: sessionState, phone: null, name: null };
  }

  // Try to fetch the connected phone's profile info
  try {
    if (!connectedPhone) {
      const me = await wppClient.getHostDevice();
      connectedPhone = me?.id?.user  || null;
      connectedName  = me?.pushname  || me?.name || 'Student';
    }
  } catch { /* ignore — not critical */ }

  return {
    status: 'CONNECTED',
    phone:  connectedPhone,
    name:   connectedName,
  };
}

/**
 * getGroups()
 *
 * Fetches all WhatsApp groups the connected account is a member of.
 * Returns a clean normalized array — shown to student in the group selector.
 *
 * PRIVACY: This list is shown to the student but NOT stored.
 * Only groups they explicitly check get saved in the database.
 */
async function getGroups() {
  if (!wppClient || sessionState !== 'CONNECTED') return [];

  try {
    // WPPConnect returns all chats — we filter to groups only
    const allChats = await wppClient.listChats({ onlyGroups: true });

    return allChats.map(chat => ({
      id:                chat.id._serialized || chat.id,
      name:              chat.name || chat.formattedTitle || 'Unnamed Group',
      participantsCount: chat.groupMetadata?.participants?.length || 0,
      imageUrl:          null,
    }));
  } catch (err) {
    console.error('[wpp] getGroups error:', err.message);
    return [];
  }
}

/**
 * disconnectSession()
 * Logs out WhatsApp and clears the saved session token.
 */
async function disconnectSession() {
  if (!wppClient) return { success: true };

  try {
    await wppClient.logout();
    await wppClient.close();
  } catch (err) {
    console.error('[wpp] disconnect error:', err.message);
  }

  wppClient    = null;
  qrCodeData   = null;
  sessionState = 'DISCONNECTED';
  connectedPhone = null;
  connectedName  = null;

  return { success: true };
}

/**
 * onMessage(handler)
 *
 * Register a callback that fires whenever a WhatsApp message arrives.
 * Called by webhook.js to hook into the message stream.
 *
 * handler(message) — message shape from WPPConnect:
 *   {
 *     id:        string,
 *     body:      string,          ← the text content
 *     from:      "1234@g.us",     ← group JID (ends @g.us for groups)
 *     isGroupMsg: boolean,
 *     timestamp:  number,
 *     ...
 *   }
 */
function onMessage(handler) {
  messageHandlers.push(handler);
}

module.exports = {
  initWPP,
  getQRCode,
  checkSessionStatus,
  getGroups,
  disconnectSession,
  onMessage,
  get wppClient() { return wppClient; },
};

