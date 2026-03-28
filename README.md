# StudySync 🎓
WhatsApp-powered academic dashboard. Scans authorized class groups → GPT-4o-mini extracts assignments, deadlines, classes → live dashboard.

---

## Setup (5 minutes)

### Prerequisites
- Node.js 20+
- One Android or iPhone with WhatsApp installed
- Google Chrome installed

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
OPENAI_API_KEY=your-openai-key-here
```

Get your key from: https://platform.openai.com/api-keys

Everything else has working defaults.

### 3. Run

```bash
npm run dev
```

Open **http://localhost:3001**

> Note: Add a valid OPENAI_API_KEY to .env to enable live AI extraction. Demo mode works without it.

---

## Hackathon Demo Flow

| Step | What happens |
|------|-------------|
| 1 | Server starts, dashboard ready |
| 2 | Click **"Skip QR — Use demo mode"** (bypasses WhatsApp entirely) |
| 3 | Select any groups, click Confirm |
| 4 | Dashboard loads with assignments, calendar, reminders |
| 5 | Click **"+ Simulate message"**, type: `"Physics exam Friday 9am Room 101"` |
| 6 | Watch GPT-4o-mini extract it and it appears live on the dashboard |

To demo with a **real phone** instead:
- Don't click Skip — actually scan the QR with your phone
- Select your real WhatsApp class groups
- Any message matching academic keywords flows through GPT-4o-mini automatically

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
           ai.js → OpenAI API (GPT-4o-mini)
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
| `ai.js` | GPT-4o-mini extraction prompt + JSON parser |
| `db.js` | SQLite schema + all query functions |
| `socket.js` | Socket.io real-time push |
| `frontend/index.html` | Full dashboard UI, wired to all backend routes |

---

## Privacy (talk through this with judges)

1. **Personal DMs never touched** — `isGroupMsg` check drops them instantly
2. **Group allowlist** — student explicitly picks which groups; everything else is dropped at the gate before any processing or logging
3. **No raw message storage** — text goes to GPT-4o-mini and is then discarded; only the extracted structured item (title, date, subject) is saved
4. **Sender anonymity** — sender name and phone number are never passed to the AI or stored
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
POST /api/demo/simulate        { messages: ["..."] } → GPT-4o-mini pipeline live
GET  /api/health               Health check
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Database | SQLite (better-sqlite3) |
| WhatsApp | WPPConnect (open source, runs locally) |
| AI Extraction | GPT-4o-mini (OpenAI API) |
| Realtime | Socket.io WebSockets |
| Frontend | Vanilla HTML + CSS + JavaScript |
