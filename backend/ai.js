/**
 * ai.js — Google Gemini powered academic data extraction
 *
 * HOW IT WORKS:
 *   1. We receive a batch of raw WhatsApp message texts (no names, no phone numbers)
 *   2. We send them to Gemini with a detailed system prompt
 *   3. The model returns a JSON array of structured academic items
 *   4. We validate and normalize the response
 *   5. Return the cleaned items to webhook.js for database storage
 *
 * WHY GEMINI:
 *   Free API key — no credit card needed.
 *   Get yours at: https://aistudio.google.com/apikey
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const AI_ENABLED = !!(GEMINI_KEY && GEMINI_KEY.length > 10);

if (!AI_ENABLED) {
  console.warn('[ai] ⚠️  No GEMINI_API_KEY found — AI extraction disabled.');
  console.warn('[ai]    Get a free key at https://aistudio.google.com/apikey');
  console.warn('[ai]    Demo mode works fine without it.');
} else {
  console.log('[ai] ✅ Gemini API ready.');
}

const genAI = AI_ENABLED ? new GoogleGenerativeAI(GEMINI_KEY) : null;

const SYSTEM_PROMPT = `You are an academic assistant that extracts structured information from WhatsApp group messages sent by students and professors.

Your job: Read a batch of messages and identify any academic tasks, events, or reminders.

Return ONLY a valid JSON array. No explanation, no markdown, no preamble. Just the JSON array.

Each item in the array must follow this schema:
{
  "type": "assignment" | "class" | "reminder",
  "title": "short clear title (max 80 chars)",
  "subject": "course code or subject name if mentioned, else null",
  "dueDate": "ISO-8601 datetime string if inferable, else null",
  "description": "any extra details (location, instructions, etc.), else null",
  "location": "room/place if mentioned (for classes/exams), else null",
  "priority": "high" | "medium" | "low",
  "confidence": 0.0 to 1.0
}

Rules:
- "assignment": homework, problem sets, reports, projects, submissions with a FUTURE deadline
- "class": upcoming lectures, tutorials, labs, exams — things with a FUTURE date and TIME
- "reminder": important upcoming announcements that don't fit above
- IGNORE completely: class cancellations, class already started, past events, "class has started", "no class today", attendance messages, casual chat, reactions, memes, "ok", "noted", "thanks"
- IGNORE any event whose date has already passed — only extract FUTURE deadlines and events
- Only extract items where there is a clear actionable task or upcoming event for the student
- Do NOT extract: notifications that something already happened, cancellations, general announcements with no deadline
- Set subject to null always — do not guess subject names
- Set priority "high" if: exam/test, due within 48 hours, professor said urgent
- Set priority "medium" if: due within a week, regular assignment
- Set priority "low" if: due more than a week away
- Set confidence < 0.70 if: date is ambiguous or unclear
- For relative dates ("tomorrow", "next friday", "kal"), resolve relative to today: ${new Date().toISOString().split('T')[0]}
- Only include dates that are in the FUTURE relative to today
- Messages may be in English, Hindi, or Hinglish — handle all

If there are no valid future academic items, return an empty array: []`;

async function extractAcademicData(messageTexts) {
  if (!messageTexts || messageTexts.length === 0) return [];

  if (!AI_ENABLED) {
    throw new Error('No GEMINI_API_KEY set. Add it to .env to enable AI extraction.');
  }

  const userMessage = messageTexts
    .map((text, i) => `[${i + 1}] ${text}`)
    .join('\n');

  console.log(`[ai] Sending ${messageTexts.length} messages to Gemini for extraction`);

  let rawResponse;
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    const result = await model.generateContent(
      `${SYSTEM_PROMPT}\n\nExtract academic items from these WhatsApp messages:\n\n${userMessage}`
    );
    rawResponse = result.response.text();
  } catch (err) {
    console.error('[ai] Gemini API error:', err.message);
    throw err;
  }

  return parseResponse(rawResponse);
}

function parseResponse(raw) {
  if (!raw || raw.trim() === '') return [];

  let parsed;
  try {
    const clean = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    console.error('[ai] Failed to parse Gemini response as JSON:', raw.substring(0, 200));
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(item => item && typeof item === 'object')
    .map(normalizeItem)
    .filter(item => item !== null);
}

function normalizeItem(item) {
  if (!item.type || !item.title) return null;
  if (!['assignment', 'class', 'reminder'].includes(item.type)) return null;
  if (typeof item.title !== 'string' || item.title.trim().length === 0) return null;

  return {
    type:        item.type,
    title:       String(item.title).substring(0, 200).trim(),
    subject:     item.subject     ? String(item.subject).substring(0, 100).trim() : null,
    dueDate:     isValidDate(item.dueDate) ? item.dueDate : null,
    description: item.description ? String(item.description).substring(0, 500).trim() : null,
    location:    item.location    ? String(item.location).substring(0, 200).trim() : null,
    priority:    ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
    confidence:  typeof item.confidence === 'number'
                   ? Math.min(1.0, Math.max(0.0, item.confidence))
                   : 1.0,
  };
}

function isValidDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false;
  return !isNaN(new Date(dateStr).getTime());
}

function getDemoItems() {
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const in2days  = new Date(now); in2days.setDate(now.getDate() + 2);
  const in5days  = new Date(now); in5days.setDate(now.getDate() + 5);
  const in7days  = new Date(now); in7days.setDate(now.getDate() + 7);
  const in12days = new Date(now); in12days.setDate(now.getDate() + 12);

  return [
    { type:'assignment', title:'Linear Algebra Problem Set 3', subject:'MATH201',
      dueDate:tomorrow.toISOString(), description:'Questions 1–15 from Chapter 4. Submit on Moodle.',
      priority:'high', confidence:0.97 },
    { type:'class', title:'CS301 Midterm Exam', subject:'CS301',
      dueDate:in2days.toISOString(), location:'Room 204, Block C',
      description:'Covers Chapters 1–6. Bring student ID.', priority:'high', confidence:0.99 },
    { type:'assignment', title:'Physics Lab Report — Optics', subject:'PHYSICS',
      dueDate:in5days.toISOString(), description:'Submit via Moodle. Include error analysis.',
      priority:'medium', confidence:0.92 },
    { type:'reminder', title:'Read Chapters 7–9 before Thursday lecture', subject:'ENG LIT',
      dueDate:in7days.toISOString(), description:'Modernist Poetry unit. Discussion in class.',
      priority:'medium', confidence:0.85 },
    { type:'assignment', title:'CS301 Group Project Proposal', subject:'CS301',
      dueDate:in12days.toISOString(), description:'Submit proposal to Prof. Mehta. Max 2 pages.',
      priority:'low', confidence:0.90 },
  ];
}

module.exports = { extractAcademicData, getDemoItems };
