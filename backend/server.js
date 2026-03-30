/**
 * server.js — StudySync Express server (WPPConnect + local demo mode)
 *
 * KEY DIFFERENCE FROM A CLOUD SETUP:
 *   • With whapi.cloud, messages arrive via HTTP webhook (POST from their server)
 *   • With WPPConnect (local), messages arrive as Node.js events directly
 *   • This means no public URL, no ngrok, no network tunnels needed at all
 *   • Perfect for a hackathon laptop demo
 *
 * BOOT SEQUENCE:
 *   1. Express starts, SQLite DB initialised, demo data auto-seeded if empty
 *   2. WPPConnect launches Chromium headlessly in the background
 *   3. Frontend polls GET /api/session/qr → shows QR code
 *   4. Student scans → WPPConnect fires CONNECTED status
 *   5. Frontend polls GET /api/session/status → moves to group selector
 *   6. Student picks groups → POST /api/groups/authorize
 *   7. WPPConnect onMessage fires in-process for every new message
 *   8. webhook.js drops unauthorised messages, batches the rest for Claude
 *   9. Claude extracts structured items → saved to DB → Socket.io pushes to browser
 */

require('dotenv').config();

const express = require('express');
const http    = require('http');
const cors    = require('cors');
const path    = require('path');

const db = require('./db');
const wa = require('./whatsapp');
const { registerMessageHandler, scanExistingMessages } = require('./webhook');
const { extractAcademicData, getDemoItems } = require('./ai');
const { initSocket, pushToUser } = require('./socket');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3001;

// ── Initialize Socket.io ──────────────────────────────────────────────────────
initSocket(server);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── Demo user ─────────────────────────────────────────────────────────────────
const DEMO_USER_ID = 'demo-user-001';

function getOrCreateDemoUser() {
  let user = db.getUserById(DEMO_USER_ID);
  if (!user) {
    db.upsertUser({
      id:           DEMO_USER_ID,
      phone:        null,
      name:         'Demo Student',
      whapiSession: 'local-wpp-session',
    });
    user = db.getUserById(DEMO_USER_ID);
  }
  return user;
}

function getUserFromRequest(req) {
  const id = req.headers['x-user-id'];
  return (id && db.getUserById(id)) || getOrCreateDemoUser();
}

/**
 * clearAllUserData(userId)
 *
 * Helper to safely wipe extracted items from the database.
 * Handles multiple possible DB interfaces.
 */
function clearAllUserData(userId) {
  try {
    if (typeof db.clearUserItems === 'function') {
      db.clearUserItems(userId);
    } else if (db.db && typeof db.db.prepare === 'function') {
      db.db.prepare('DELETE FROM extracted_items WHERE user_id = ?').run(userId);
    } else if (typeof db.prepare === 'function') {
      db.prepare('DELETE FROM extracted_items WHERE user_id = ?').run(userId);
    } else {
      console.warn('[server] No valid DB method found to clear items. Check db.js exports.');
    }
  } catch (err) {
    console.error('[server] Error clearing user data:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/session/qr
app.get('/api/session/qr', (req, res) => {
  const qr = wa.getQRCode();
  if (!qr) {
    return res.status(202).json({ status: 'PENDING', message: 'Starting WhatsApp...' });
  }
  res.json(qr);
});

// GET /api/session/status
// GET /api/session/status
app.get('/api/session/status', async (req, res) => {
  try {
    const status = await wa.checkSessionStatus();

    // Handle SYNCING state — tell frontend to wait
    if (status.status === 'SYNCING') {
      return res.json({
        status: 'SYNCING',
        phone:  null,
        name:   null,
        message: 'WhatsApp is syncing your chats... Please wait.',
      });
    }

    if (status.status === 'CONNECTED' && status.phone) {
      const user = db.getUserById(DEMO_USER_ID);

      if (!user || !user.phone) {
        console.log('[server] Real WhatsApp connected! Clearing any demo data...');
        clearAllUserData(DEMO_USER_ID);
        db.setAuthorizedGroups(DEMO_USER_ID, []);
      }

      db.upsertUser({
        id:           DEMO_USER_ID,
        phone:        status.phone,
        name:         status.name || 'Student',
        whapiSession: 'local-wpp-session',
      });
    }

    res.json(status);
  } catch (err) {
    console.error('[server] Status check error:', err.message);
    res.json({ status: 'LOADING', phone: null, name: null });
  }
});

// POST /api/session/disconnect
app.post('/api/session/disconnect', async (req, res) => {
  try {
    await wa.disconnectSession();
    clearAllUserData(DEMO_USER_ID);
    db.deleteUser(DEMO_USER_ID);
    res.json({ success: true, message: 'WhatsApp disconnected. All data cleared.' });
  } catch (err) {
    res.status(500).json({ error: 'Could not disconnect' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/groups
app.get('/api/groups', async (req, res) => {
  try {
    const status = await wa.checkSessionStatus();

    if (status.status === 'CONNECTED') {
      const groups = await wa.getGroups();

      // If connected but groups array is empty, WhatsApp is still syncing
      if (groups.length === 0) {
        return res.json({
          groups:  [],
          message: 'WhatsApp is syncing your groups... Please refresh in 5 seconds.',
          syncing: true,
        });
      }

      return res.json({ groups });
    }

    // WhatsApp is loading or QR not scanned yet
    if (status.status === 'LOADING' || status.status === 'QR_READY') {
      return res.json({
        groups:  [],
        message: 'WhatsApp is not connected yet. Please scan the QR code.',
      });
    }
  } catch (err) {
    console.error('[server] getGroups error:', err.message);
  }

  // FIX: Return empty instead of demo groups
  // Demo groups are only available via /api/demo/seed
  res.json({
    groups:  [],
    message: 'WhatsApp disconnected. Please scan QR code first.',
  });
});

// POST /api/groups/authorize
app.post('/api/groups/authorize', async (req, res) => {
  const user = getUserFromRequest(req);
  const { groups } = req.body;

  if (!Array.isArray(groups) || groups.length === 0) {
    return res.status(400).json({ error: 'At least one group must be authorized' });
  }
  const valid = groups.filter(g => g.groupId && g.groupName);
  if (!valid.length) return res.status(400).json({ error: 'Invalid group data' });

  // FIX: Clear ALL old data (demo + previous scans) before fresh authorization
  console.log('[server] Clearing old extracted items before new group authorization...');
  clearAllUserData(user.id);

  // Save the authorized groups
  db.setAuthorizedGroups(user.id, valid);
  console.log(`[server] User ${user.id} authorized: ${valid.map(g => g.groupName).join(', ')}`);

  // Respond immediately so the frontend doesn't hang
  res.json({
    success: true,
    message: `${valid.length} group(s) authorized. Scanning past messages in background...`,
    groups:  valid,
  });

  // FIX: Trigger historical message scan in background!
  // This reads existing messages from the authorized groups and extracts deadlines.
  try {
    console.log('[server] Starting background scan of existing messages...');
    const itemCount = await scanExistingMessages(wa, valid);
    console.log(`[server] ✅ Background scan complete: ${itemCount} items extracted`);

    // Notify frontend that scanning is done
    pushToUser(user.id, {
      event:   'scan_complete',
      count:   itemCount,
      message: `Scanned ${valid.length} group(s) and found ${itemCount} deadline(s)`,
    });
  } catch (err) {
    console.error('[server] Background scan error:', err.message);
    pushToUser(user.id, {
      event:   'scan_error',
      message: 'Failed to scan some groups. New messages will still be processed.',
    });
  }
});

// GET /api/groups/authorized
app.get('/api/groups/authorized', (req, res) => {
  const user = getUserFromRequest(req);
  res.json({ groups: db.getAuthorizedGroups(user.id) });
});

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD + ITEM ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/dashboard', async (req, res) => {
  const user  = getUserFromRequest(req);
  const items = db.getItemsForUser(user.id);
  const groups = db.getAuthorizedGroups(user.id);

  // Try to get real name from live WPPConnect session
  let displayName = user.name;
  try {
    const sessionStatus = await wa.checkSessionStatus();
    if (sessionStatus.name && sessionStatus.name !== 'Demo Student') {
      displayName = sessionStatus.name;
      // Update DB with real name
      if (displayName !== user.name) {
        db.upsertUser({ id: user.id, phone: user.phone, name: displayName, whapiSession: user.whapi_session });
      }
    }
  } catch {}

  res.json({
    user:        { id: user.id, name: displayName },
    stats:       db.getStatsForUser(user.id),
    groups,
    assignments: items.filter(i => i.type === 'assignment'),
    classes:     items.filter(i => i.type === 'class'),
    reminders:   items.filter(i => i.type === 'reminder'),
    lastUpdated: new Date().toISOString(),
  });
});

app.get('/api/items', (req, res) => {
  const user  = getUserFromRequest(req);
  const items = req.query.type
    ? db.getItemsByType(user.id, req.query.type)
    : db.getItemsForUser(user.id);
  res.json({ items });
});

app.patch('/api/items/:id/status', (req, res) => {
  const user   = getUserFromRequest(req);
  const { status } = req.body;
  const valid  = ['active', 'done', 'dismissed', 'needs_review'];

  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const result = db.updateItemStatus(Number(req.params.id), user.id, status);
  if (result.changes === 0) return res.status(404).json({ error: 'Item not found' });

  res.json({ success: true, id: req.params.id, status });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEMO / HACKATHON HELPERS
// These are now EXPLICIT — they only run when you manually call them.
// No more auto-seeding on boot!
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/demo/clear', (req, res) => {
  const user = getOrCreateDemoUser();
  clearAllUserData(user.id);
  db.setAuthorizedGroups(user.id, []);
  res.json({ success: true, message: 'Cleared all items and authorized groups' });
});

app.get('/api/demo/seed', (req, res) => {
  const user  = getOrCreateDemoUser();

  // Clear existing data first to avoid duplicates
  clearAllUserData(user.id);

  const items = getDemoItems();
  db.setAuthorizedGroups(user.id, [
    { groupId: 'cs301@g.us', groupName: 'CS301 — Algorithms' },
    { groupId: 'phy@g.us',   groupName: 'Physics Lab 2026' },
    { groupId: 'math@g.us',  groupName: 'MATH201 — Linear Algebra' },
    { groupId: 'eng@g.us',   groupName: 'English Literature' },
  ]);
  db.insertExtractedItems(user.id, items, 'demo@g.us');
  res.json({ success: true, itemCount: items.length, message: 'Demo data seeded!' });
});

app.post('/api/demo/simulate', async (req, res) => {
  const user = getUserFromRequest(req);
  const { messages } = req.body;

  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const extracted = await extractAcademicData(messages);
    if (extracted.length > 0) {
      db.insertExtractedItems(user.id, extracted, 'demo-simulate@g.us');
      pushToUser(user.id, { event: 'new_items', count: extracted.length, items: extracted });
    }
    res.json({ success: true, extracted, message: `Extracted ${extracted.length} item(s)` });
  } catch (err) {
    console.error('[server] simulate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  const key = process.env.OPENAI_API_KEY || '';
  res.json({
    status:    'ok',
    whatsapp:  wa.getQRCode()?.status || 'unknown',
    aiEnabled: !!(key && key.startsWith('sk-') && key.length > 20),
    timestamp: new Date().toISOString(),
  });
});

// API Catch-All — prevents "Unexpected token < in JSON" errors
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

// Serve frontend for all unmatched NON-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════╗
║   StudySync — Local Hackathon Edition    ║
║   http://localhost:${PORT}                   ║
╠══════════════════════════════════════════╣
║  Demo seed:  GET  /api/demo/seed         ║
║  Demo clear: GET  /api/demo/clear        ║
║  Simulate:   POST /api/demo/simulate     ║
║  Health:     GET  /api/health            ║
╚══════════════════════════════════════════╝
  `);

  // FIX: Just create the user entry — do NOT seed demo data automatically
  getOrCreateDemoUser();
  console.log('[server] User initialized (no demo data seeded — use /api/demo/seed if needed)');

  // Start WhatsApp connection
  console.log('[server] Starting WPPConnect (Chromium launching in background)...');
  wa.initWPP()
    .then(() => {
      registerMessageHandler(wa);
      console.log('[server] ✅ WPPConnect ready. Real-time message listener active.');
    })
    .catch(err => {
      console.warn('[server] ⚠️ WPPConnect could not start:', err.message);
      console.warn('[server] Use /api/demo/seed to load demo data for testing.');
    });
});