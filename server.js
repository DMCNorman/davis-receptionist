/**
 * Davis Mechanical Contractors — AI Receptionist (scaffold)
 *
 * A Twilio-powered phone receptionist:
 *  - Answers incoming calls with a spoken greeting (after-hours aware)
 *  - Routes callers: new service request / existing appointment / emergency / message
 *  - Collects name, callback number, and issue description via speech
 *  - Texts the caller your Housecall Pro booking link
 *  - Texts YOU (owner) a lead alert with the details
 *  - Logs every call to data/calls.json + a simple dashboard at /
 *
 * Setup: see README.md
 */
require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');

/* ==================== Configuration ==================== */
const CONFIG = {
  businessName: process.env.BUSINESS_NAME || 'Davis Mechanical Contractors',
  ownerPhones: (process.env.OWNER_PHONE || '').split(',').map((s) => s.trim()).filter(Boolean),
  bookingUrl: process.env.BOOKING_URL || '',   // Housecall Pro booking link
  voice: 'Polly.Joanna',                       // Twilio neural voice
  language: 'en-US',
  hours: { start: 8, end: 17 },                // server-local time; greeting only
};

const twilioNumber = process.env.TWILIO_PHONE_NUMBER || '';
const hasTwilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
const client = hasTwilio ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

const app = express();
app.use(express.urlencoded({ extended: false }));

/* ==================== Call log (JSON file) ==================== */
const DATA_FILE = path.join(__dirname, 'data', 'calls.json');
function readLog() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function writeLog(entry) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const log = readLog();
    log.unshift({ at: new Date().toISOString(), ...entry });
    fs.writeFileSync(DATA_FILE, JSON.stringify(log.slice(0, 500), null, 2));
  } catch (e) {
    console.error('log write failed:', e.message);
  }
}

/* ==================== Per-call sessions ==================== */
const sessions = new Map(); // CallSid -> { step, data, seen }
function getSession(callSid) {
  let s = sessions.get(callSid);
  if (!s || Date.now() - s.seen > 20 * 60 * 1000) {
    s = { step: 'start', data: {}, seen: Date.now() };
    if (callSid) sessions.set(callSid, s);
  }
  s.seen = Date.now();
  return s;
}

/* ==================== Helpers ==================== */
const newCall = () => new twilio.twiml.VoiceResponse();
const inHours = () => {
  const h = new Date().getHours();
  return h >= CONFIG.hours.start && h < CONFIG.hours.end;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Ask a spoken question and listen for speech. Silence -> take a message. */
function ask(res, question, action) {
  const gather = res.gather({ input: 'speech', action, speechTimeout: 'auto', language: CONFIG.language });
  gather.say({ voice: CONFIG.voice }, question);
  res.redirect('/take-message');
}

function classify(text) {
  const t = (text || '').toLowerCase();
  const has = (...words) => words.some((w) => t.includes(w));
  if (has('gas', 'smell', 'leak', 'flood', 'smoke', 'spark', 'emergency', 'urgent')) return 'emergency';
  if (has('existing', 'appointment', 'scheduled', 'technician', 'coming out', 'when are')) return 'existing';
  if (
    has('new', 'service', 'repair', 'broken', 'not working', "isn't working", 'install', 'replace',
        'maintenance', 'tune', 'checkup', 'check up', 'hot', 'cold', 'warm', 'ac', 'a.c', 'air',
        'heat', 'furnace', 'thermostat', 'filter', 'quote', 'estimate')
  ) return 'service';
  return 'other';
}

async function sendSms(to, body) {
  if (!client || !twilioNumber || !to) return;
  try {
    await client.messages.create({ to, from: twilioNumber, body });
  } catch (e) {
    console.error('SMS failed:', e.message);
  }
}

/** Log the call, notify owner + caller, say goodbye. */
async function finalize(req, res, s) {
  const d = s.data;
  const caller = req.body.From || 'unknown';

  writeLog({ from: caller, type: d.type, name: d.name || '-', phone: d.phone || caller, details: d.details || '-' });

  // Alert the owner(s) — supports multiple comma-separated numbers
  for (const num of CONFIG.ownerPhones) {
    await sendSms(
      num,
      `New ${d.type} — ${d.name || 'unknown'} (${d.phone || caller}): ${d.details || 'no details'}`
    );
  }

  // Text the caller the booking link for service requests — only with explicit consent.
  const r = newCall();
  let goodbye = `Thanks ${d.name || 'for calling'}. I've passed your information along and someone will call you back.`;
  if (d.type === 'service request' && CONFIG.bookingUrl && d.smsConsent) {
    await sendSms(caller, `Thanks for calling ${CONFIG.businessName}! Book your visit here: ${CONFIG.bookingUrl}`);
    goodbye += ' I also just texted you our online booking link.';
  }
  r.say({ voice: CONFIG.voice }, goodbye + ' Goodbye.');
  r.hangup();
  sessions.delete(req.body.CallSid);
  res.type('text/xml').send(r.toString());
}

/* ==================== Voice flow ==================== */
app.post('/voice', (req, res) => {
  const r = newCall();
  const intro = inHours()
    ? `Thanks for calling ${CONFIG.businessName}.`
    : `Thanks for calling ${CONFIG.businessName}. You've reached us after hours, but I can still help you.`;
  ask(r, `${intro} Are you calling about a new service request, an existing appointment, or something else?`, '/route');
  res.type('text/xml').send(r.toString());
});

app.post('/route', (req, res) => {
  const s = getSession(req.body.CallSid);
  const kind = classify(req.body.SpeechResult);
  const r = newCall();

  if (kind === 'emergency') {
    s.data.type = 'EMERGENCY (priority)';
    s.step = 'name';
    ask(
      r,
      "I understand this is urgent. If you smell gas, please hang up right now, leave the building, and call your gas company or 911. " +
        "Otherwise I'll flag this as a priority. What's your name?",
      '/collect'
    );
  } else if (kind === 'service') {
    s.data.type = 'service request';
    s.step = 'name';
    ask(r, "Great, I can help with that. What's your name?", '/collect');
  } else if (kind === 'existing') {
    s.data.type = 'existing appointment';
    s.step = 'one-shot';
    ask(r, 'Got it. Please say your name and tell me briefly what\'s going on with your appointment.', '/collect');
  } else {
    return res.redirect(307, '/take-message');
  }
  res.type('text/xml').send(r.toString());
});

app.post('/collect', (req, res) => {
  const s = getSession(req.body.CallSid);
  const heard = (req.body.SpeechResult || '').trim();
  const r = newCall();

  if (!heard) {
    // Caller went silent mid-flow — wrap up with what we have.
    s.data.details = s.data.details || '(caller went silent)';
    return finalize(req, res, s);
  }

  if (s.step === 'one-shot') {
    s.data.name = '-';
    s.data.details = heard;
    return finalize(req, res, s);
  }
  if (s.step === 'name') {
    s.data.name = heard;
    s.step = 'phone';
    ask(r, `Thanks ${heard}. What's the best callback number? Or just say "use my caller ID".`, '/collect');
    return res.type('text/xml').send(r.toString());
  }
  if (s.step === 'phone') {
    const digits = heard.replace(/\D/g, '');
    s.data.phone = /caller|my number|this number/i.test(heard) || digits.length < 7 ? req.body.From : heard;
    s.step = 'details';
    ask(r, 'And briefly, what\'s the issue and what\'s the service address?', '/collect');
    return res.type('text/xml').send(r.toString());
  }
  if (s.step === 'details') {
    s.data.details = heard;
    if (s.data.type === 'service request') {
      // Explicit SMS consent (A2P compliance): only text the booking link on a clear yes.
      s.step = 'consent';
      ask(r, "One last thing — can I text the booking link to the number you're calling from? Just say yes or no.", '/collect');
      return res.type('text/xml').send(r.toString());
    }
    return finalize(req, res, s);
  }
  if (s.step === 'consent') {
    const t = heard.toLowerCase();
    s.data.smsConsent = /\b(yes|yeah|yep|yup|sure|okay|ok|please|go ahead|do it|sounds good|that works|correct|absolutely)\b/.test(t);
    return finalize(req, res, s);
  }
  // Unknown state — take a message.
  res.redirect(307, '/take-message');
});

app.post('/take-message', (req, res) => {
  const s = getSession(req.body.CallSid);
  s.data.type = 'message';
  s.step = 'one-shot';
  const r = newCall();
  ask(r, `Please say your name and your message, and we'll call you back.`, '/collect');
  res.type('text/xml').send(r.toString());
});

/* ==================== SMS auto-reply ==================== */
app.post('/sms', async (req, res) => {
  const r = new twilio.twiml.MessagingResponse();
  const body = `Thanks for texting ${CONFIG.businessName}! Book online here: ${CONFIG.bookingUrl || '(booking link coming soon)'} — or just reply and we'll call you back.`;
  r.message(body);
  writeLog({ from: req.body.From || 'unknown', type: 'sms inbound', name: '-', phone: req.body.From || '-', details: req.body.Body || '-' });
  res.type('text/xml').send(r.toString());
});

/* ==================== Dashboard ==================== */
app.get('/', (req, res) => {
  const log = readLog();
  const rows = log
    .map(
      (c) => `<tr><td>${esc(new Date(c.at).toLocaleString())}</td><td>${esc(c.type)}</td>` +
        `<td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${esc(c.details)}</td></tr>`
    )
    .join('');
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(CONFIG.businessName)} — Call log</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:14px}th{background:#f4f4f4}
h1{font-size:22px} .meta{color:#666;margin-bottom:16px}</style></head>
<body><h1>${esc(CONFIG.businessName)} — Receptionist call log</h1>
<div class="meta">${log.length} calls logged · <a href="/">refresh</a></div>
<table><tr><th>Time</th><th>Type</th><th>Name</th><th>Phone</th><th>Details</th></tr>${rows || '<tr><td colspan=5>No calls yet.</td></tr>'}</table>
</body></html>`);
});

app.get('/health', (req, res) => res.json({ ok: true, twilio: hasTwilio }));

/* ==================== Start ==================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Receptionist listening on :${PORT} (Twilio creds ${hasTwilio ? 'loaded' : 'MISSING — copy .env.example to .env'})`);
});
