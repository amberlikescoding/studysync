# StudySync 🎓
WhatsApp-powered academic dashboard. Scans authorized class groups → Claude AI extracts assignments, deadlines, classes → live dashboard.

---

## Setup (5 minutes)

### Prerequisites
- Node.js 18+
- One Android or iPhone with WhatsApp installed

### 1. Install dependencies

```bash
cd studysync
npm install
```

> ⚠️ First install downloads Chromium (~170MB for WPPConnect). Do this **before** the hackathon presentation on your WiFi.

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — you only need **one key**:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Everything else has working defaults.

### 3. Run

```bash
npm run dev
```

Open **http://localhost:3001**

---

## Hackathon Demo Flow

| Step | What happens |
|------|-------------|
| 1 | Server starts, auto-seeds demo data, dashboard already looks full |
| 2 | Click **"Skip QR — Use demo mode"** (bypasses WhatsApp entirely) |
| 3 | Select any groups, click Confirm |
| 4 | Dashboard loads with assignments, calendar, reminders |
| 5 | Click **"+ Simulate message"**, type: `"Physics exam Friday 9am Room 101"` |
| 6 | Watch Claude extract it and it appears live on the dashboard ← judges love this |

To demo with a **real phone** instead:
- Don't click Skip — actually scan the QR with your phone
- Select your real WhatsApp class groups
- Any message matching academic keywords flows through Claude automatically

---

## Architecture

```
WPPConnect (Chromium headless on your laptop)
      |
      | onMessage() — in-process Node.js event, no HTTP webhook needed
      ↓
webhook.js
  ├── isGroupMsg? NO  → drop (DMs never processed)
  ├── authorizedGroup? NO → drop silently (privacy gate)
  ├── looksAcademic? NO → drop (keyword filter)
  └── YES → add to 20s batch queue
                |
                ↓
           ai.js → Claude API
           (sends text only, no names/phones)
                |
                ↓
           db.js → SQLite
           (stores structured data only, raw text discarded)
                |
                ↓
           socket.js → Socket.io → browser dashboard updates live
```

---

## File Map

| File | Purpose |
|------|---------|
| `server.js` | Express app, all API routes, boot sequence |
| `whatsapp.js` | WPPConnect — QR, session, groups, message events |
| `webhook.js` | Privacy gate + keyword filter + batch queue |
| `ai.js` | Claude extraction prompt + JSON parser |
| `db.js` | SQLite schema + all query functions |
| `socket.js` | Socket.io real-time push |
| `frontend/index.html` | Full dashboard UI, wired to all backend routes |

---

## Privacy (talk through this with judges)

1. **Personal DMs never touched** — `isGroupMsg` check drops them instantly
2. **Group allowlist** — student explicitly picks which groups; everything else is dropped at the gate before any processing or logging
3. **No raw message storage** — text goes to Claude and is then discarded; only the extracted structured item (title, date, subject) is saved
4. **Sender anonymity** — sender name and phone number are never passed to Claude or stored
5. **Full data wipe on disconnect** — one click clears everything via `DELETE CASCADE`

---

## API Routes

```
GET  /api/session/qr           QR code for WhatsApp scan
GET  /api/session/status       Connection status (polled by frontend)
POST /api/session/disconnect   Unlink + wipe all data

GET  /api/groups               All WhatsApp groups (for selector)
POST /api/groups/authorize     Save the authorized group list
GET  /api/groups/authorized    Currently authorized groups

GET  /api/dashboard            All dashboard data in one call
GET  /api/items?type=...       Filtered items
PATCH /api/items/:id/status    Mark done / dismissed

GET  /api/demo/seed            Re-seed demo data
POST /api/demo/simulate        { messages: ["..."] } → Claude pipeline live
GET  /api/health               Health check
```
