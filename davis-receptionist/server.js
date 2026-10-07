/**
 * Davis Mechanical Contractors — AI Receptionist (scaffold)
 *
 * A Twilio-powered phone receptionist:
 *  - Answers incoming calls with a spoken greeting (after-hours aware)
 *  - Routes callers: new service request / existing appointment / emergency / message
 *  - Collects name, callback number, and issue description via speech
 *  - Texts the caller your Housecall Pro booking link as a unique tracked URL
 *    (/b/:token) — taps are logged and shown in the dashboard's "Link tap" column,
 *    then redirect to the real booking page. Self-hosted: no Twilio add-ons or DNS
 *    changes needed.
 *  - Texts YOU (owner) a lead alert with the details
 *  - Logs every call to data/calls.json + a simple dashboard at /
 *
 * Setup: see README.md
 */
require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ==================== Configuration ==================== */
const CONFIG = {
  businessName: process.env.BUSINESS_NAME || 'Davis Mechanical Contractors',
  ownerPhones: (process.env.OWNER_PHONE || '').split(',').map((s) => s.trim()).filter(Boolean),
  bookingUrl: process.env.BOOKING_URL || '',   // Housecall Pro booking link
  // Public base URL used for self-hosted tracked booking links (/b/:token).
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'https://davis-receptionist.onrender.com').replace(/\/$/, ''),
  voice: 'Polly.Salli-Neural',                // Twilio Polly neural voice (on Twilio's supported list)
  language: 'en-US',
  hours: { start: 8, end: 17 },                // business hours in CONFIG.timeZone; greeting only
  timeZone: process.env.TIME_ZONE || 'America/Chicago',
  // Booking-link auto-reply to inbound texts fires only if this number hasn't
  // texted within the window — avoids spamming it mid-conversation.
  autoReplyCooldownHours: Number(process.env.AUTO_REPLY_COOLDOWN_HOURS) || 24,
};

const twilioNumber = process.env.TWILIO_PHONE_NUMBER || '';
const hasTwilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
const client = hasTwilio ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

const app = express();
app.use(express.urlencoded({ extended: false }));

/* ==================== Call log + tracked links (Postgres when DATABASE_URL
     is set — survives deploys/restarts; JSON file fallback otherwise) ==================== */
const DATA_FILE = path.join(__dirname, 'data', 'calls.json');
const LINK_FILE = path.join(__dirname, 'data', 'links.json');
let pgPool = null;

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log('storage: no DATABASE_URL — using local JSON files');
    return;
  }
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await pgPool.query(`CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      type TEXT, name TEXT, phone TEXT, from_number TEXT, details TEXT,
      link_clicked_at TIMESTAMPTZ, link_click_count INT DEFAULT 0
    )`);
    await pgPool.query(`CREATE TABLE IF NOT EXISTS booking_links (
      token TEXT PRIMARY KEY,
      url TEXT NOT NULL, to_number TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      hits INT DEFAULT 0, last_hit_at TIMESTAMPTZ, tapped_at TIMESTAMPTZ
    )`);
    console.log('storage: Postgres connected (durable log)');
    await migrateLocalFilesOnce();
  } catch (e) {
    console.error('storage: Postgres init failed, falling back to local files:', e.message);
    pgPool = null;
  }
}

/** One-time import of any pre-existing local JSON log/links into Postgres. */
async function migrateLocalFilesOnce() {
  if (!pgPool) return;
  try {
    const calls = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(calls) && calls.length) {
      for (const c of calls) {
        await pgPool.query(
          `INSERT INTO calls (at, type, name, phone, from_number, details, link_clicked_at, link_click_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [c.at || new Date().toISOString(), c.type, c.name, c.phone, c.from, c.details,
           c.linkClickedAt || null, c.linkClickCount || 0]
        );
      }
      console.log(`storage: migrated ${calls.length} local log entries`);
    }
    const links = JSON.parse(fs.readFileSync(LINK_FILE, 'utf8'));
    const keys = links && typeof links === 'object' ? Object.keys(links) : [];
    for (const token of keys) {
      const l = links[token];
      if (!l || !l.url) continue;
      await pgPool.query(
        `INSERT INTO booking_links (token, url, to_number, created_at, hits, last_hit_at, tapped_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (token) DO NOTHING`,
        [token, l.url, l.to, l.createdAt || new Date().toISOString(), l.hits || 0, l.lastHitAt || null, l.tappedAt || null]
      );
    }
    if (keys.length) console.log(`storage: migrated ${keys.length} tracked links`);
    // Archive the local files so they can't be re-imported.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const f of [DATA_FILE, LINK_FILE]) {
      try { fs.renameSync(f, `${f}.${stamp}.migrated`); } catch {}
    }
  } catch (e) {
    // No local files or empty — nothing to migrate.
  }
}

function readLogLocal() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}
async function readLog() {
  if (pgPool) {
    try {
      const { rows } = await pgPool.query(
        `SELECT id, at, type, name, phone, from_number, details, link_clicked_at, link_click_count
         FROM calls ORDER BY at DESC LIMIT 500`
      );
      return rows.map((r) => ({
        at: r.at.toISOString(), type: r.type, name: r.name, phone: r.phone, from: r.from_number,
        details: r.details, linkClickedAt: r.link_clicked_at ? r.link_clicked_at.toISOString() : null,
        linkClickCount: r.link_click_count,
      }));
    } catch (e) {
      console.error('log read failed:', e.message);
      return readLogLocal();
    }
  }
  return readLogLocal();
}
async function writeLog(entry) {
  if (pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO calls (at, type, name, phone, from_number, details) VALUES ($1,$2,$3,$4,$5,$6)`,
        [new Date().toISOString(), entry.type, entry.name, entry.phone, entry.from, entry.details]
      );
      return;
    } catch (e) {
      console.error('log write failed:', e.message);
    }
  }
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const log = readLogLocal();
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
  // Business hours are evaluated in the business's timezone, not the server's (Render runs on UTC).
  const h = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.timeZone, hour: 'numeric', hour12: false,
  }).format(new Date()));
  return h >= CONFIG.hours.start && h < CONFIG.hours.end;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Ask a spoken question and listen for speech. Silence -> take a message. */
function ask(res, question, action) {
  const gather = res.gather({ input: 'speech', action, speechTimeout: 2, language: CONFIG.language });
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

async function sendSms(to, body, mediaUrls) {
  if (!client || !twilioNumber || !to) return;
  try {
    const msg = { to, from: twilioNumber, body };
    if (Array.isArray(mediaUrls) && mediaUrls.length) msg.mediaUrl = mediaUrls.slice(0, 10);
    await client.messages.create(msg);
  } catch (e) {
    console.error('SMS failed:', e.message);
  }
}

/* ==================== Inbound MMS photos ==================== */
// Incoming picture texts arrive on /sms with NumMedia/MediaUrl{i}. Twilio's
// media URLs require basic auth, so we download each photo server-side and
// re-host it at /m/:token for the owner alert + dashboard.
const MEDIA_DIR = path.join(__dirname, 'data', 'media');
const MEDIA_MAX_BYTES = 5 * 1024 * 1024; // Twilio MMS cap; skip anything bigger

function twilioAuthHeader() {
  return 'Basic ' + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID || ''}:${process.env.TWILIO_AUTH_TOKEN || ''}`
  ).toString('base64');
}

function downloadUrl(url, maxBytes, hops = 0) {
  return new Promise((resolve) => {
    if (hops > 5) return resolve(null);
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, { headers: { Authorization: twilioAuthHeader() } }, (res) => {
      // Twilio media URLs 307-redirect to mms.twiliocdn.com — follow them.
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(downloadUrl(next, maxBytes, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); return resolve(null); }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

/** Download inbound MMS attachments, store them, return public URLs. */
async function storeInboundMedia(body, from) {
  const n = Math.min(parseInt(body.NumMedia || '0', 10) || 0, 10);
  const urls = [];
  for (let i = 0; i < n; i++) {
    const mediaUrl = body[`MediaUrl${i}`];
    if (!mediaUrl) continue;
    const contentType = body[`MediaContentType${i}`] || 'application/octet-stream';
    const token = crypto.randomBytes(9).toString('hex');
    try {
      const data = await downloadUrl(mediaUrl, MEDIA_MAX_BYTES);
      if (!data) continue;
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      fs.writeFileSync(path.join(MEDIA_DIR, token), data);
      fs.writeFileSync(path.join(MEDIA_DIR, `${token}.json`),
        JSON.stringify({ contentType, from, at: new Date().toISOString() }));
      // Prune oldest files past the cap so the media dir can't grow forever.
      try {
        const files = fs.readdirSync(MEDIA_DIR).filter((f) => !f.endsWith('.json'))
          .map((f) => ({ f, m: fs.statSync(path.join(MEDIA_DIR, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        for (const old of files.slice(200)) {
          try { fs.unlinkSync(path.join(MEDIA_DIR, old.f)); fs.unlinkSync(path.join(MEDIA_DIR, `${old.f}.json`)); } catch {}
        }
      } catch {}
      urls.push({ url: `${CONFIG.publicBaseUrl}/m/${token}`, contentType });
    } catch (e) {
      console.error('media store failed:', e.message);
    }
  }
  return urls;
}

/** Serve a stored inbound photo. */
app.get('/m/:token', (req, res) => {
  const token = String(req.params.token || '').replace(/[^a-f0-9]/g, '');
  if (!token) return res.status(404).send('Not found.');
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, `${token}.json`), 'utf8'));
    const data = fs.readFileSync(path.join(MEDIA_DIR, token));
    res.type(meta.contentType || 'application/octet-stream').send(data);
  } catch {
    res.status(404).send('This photo is no longer available.');
  }
});

/* ==================== Self-hosted tracked booking links ==================== */
// Each booking-link text gets a unique /b/:token URL. Tapping it logs the tap
// (dashboard "Link tap" column) and 302-redirects to the real booking URL.
// No Twilio add-ons, no DNS changes — everything runs on this server.

async function getLink(token) {
  if (pgPool) {
    try {
      const { rows } = await pgPool.query('SELECT * FROM booking_links WHERE token = $1', [token]);
      const r = rows[0];
      if (!r) return null;
      return { url: r.url, to: r.to_number, createdAt: r.created_at.toISOString(), hits: r.hits,
               lastHitAt: r.last_hit_at ? r.last_hit_at.toISOString() : null, tappedAt: r.tapped_at ? r.tapped_at.toISOString() : null };
    } catch (e) {
      console.error('link read failed:', e.message);
    }
  }
  return readLinksLocal()[token] || null;
}
function readLinksLocal() {
  try {
    return JSON.parse(fs.readFileSync(LINK_FILE, 'utf8'));
  } catch {
    return {};
  }
}
async function saveLink(token, rec) {
  if (pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO booking_links (token, url, to_number, created_at, hits, last_hit_at, tapped_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (token) DO UPDATE SET url=EXCLUDED.url, to_number=EXCLUDED.to_number,
           hits=EXCLUDED.hits, last_hit_at=EXCLUDED.last_hit_at, tapped_at=EXCLUDED.tapped_at`,
        [token, rec.url, rec.to, rec.createdAt || new Date().toISOString(), rec.hits || 0,
         rec.lastHitAt || null, rec.tappedAt || null]
      );
      return;
    } catch (e) {
      console.error('link save failed:', e.message);
    }
  }
  try {
    fs.mkdirSync(path.dirname(LINK_FILE), { recursive: true });
    const links = readLinksLocal();
    links[token] = rec;
    const keys = Object.keys(links).slice(-2000);
    const trimmed = {};
    for (const k of keys) trimmed[k] = links[k];
    fs.writeFileSync(LINK_FILE, JSON.stringify(trimmed));
  } catch (e) {
    console.error('link save failed:', e.message);
  }
}
const readLinks = readLinksLocal; // local snapshot helper (sync contexts)
async function makeTrackedLink(to, url) {
  const token = crypto.randomBytes(9).toString('hex');
  const rec = { url, to, createdAt: new Date().toISOString(), hits: 0 };
  await saveLink(token, rec);
  return `${CONFIG.publicBaseUrl}/b/${token}`;
}
// User-agents that fetch link previews/thumbnails without a human tapping.
// Imperfect by nature (some phone previews look like normal browsers), but it
// filters the obvious bots so the "Link tap" column stays honest.
const PREVIEW_UA = /facebookexternalhit|twitterbot|linkedinbot|slackbot|whatsapp|telegrambot|discordbot|googlebot|bingbot|preview|prerender|headless|phantomjs/i;

/** Mark the most recent call-log entry for a phone number as link-clicked. */
async function recordLinkClick(toNumber, clickTime) {
  const want = digits(toNumber);
  const at = clickTime || new Date().toISOString();
  if (pgPool) {
    try {
      const { rowCount } = await pgPool.query(
        `UPDATE calls SET link_clicked_at = $1, link_click_count = link_click_count + 1
         WHERE id = (SELECT id FROM calls
                     WHERE link_clicked_at IS NULL
                       AND (regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $2
                            OR regexp_replace(COALESCE(from_number,''), '\\D', '', 'g') = $2)
                     ORDER BY at DESC LIMIT 1)`,
        [at, want]
      );
      return rowCount > 0;
    } catch (e) {
      console.error('link click log failed:', e.message);
    }
  }
  try {
    const log = readLogLocal();
    const entry = log.find(
      (c) => !c.linkClickedAt && (digits(c.phone) === want || digits(c.from) === want)
    );
    if (entry) {
      entry.linkClickedAt = at;
      entry.linkClickCount = (entry.linkClickCount || 0) + 1;
      fs.writeFileSync(DATA_FILE, JSON.stringify(log.slice(0, 500), null, 2));
      return true;
    }
  } catch (e) {
    console.error('link click log failed:', e.message);
  }
  return false;
}

/** Log the call, notify owner + caller, say goodbye. */
async function finalize(req, res, s) {
  try {
    return await finalizeInner(req, res, s);
  } catch (e) {
    console.error('finalize error:', e.message);
    sessions.delete(req.body.CallSid);
    const r = newCall();
    r.say(
      { voice: CONFIG.voice },
      "Sorry, something went wrong on our end. We've logged your call and someone will call you back shortly."
    );
    r.hangup();
    return res.type('text/xml').send(r.toString());
  }
}

async function finalizeInner(req, res, s) {
  const d = s.data;
  const caller = req.body.From || 'unknown';
  s.finalized = true; // Prevent double-alert from /call-status

  await writeLog({ from: caller, type: d.type, name: d.name || '-', phone: d.phone || caller, details: d.details || '-' });

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
    const link = await makeTrackedLink(caller, CONFIG.bookingUrl);
    await sendSms(caller, `Thanks for calling ${CONFIG.businessName}! Book your visit here: ${link}`);
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
    ? `Thank you for contacting ${CONFIG.businessName}.`
    : `Thank you for contacting ${CONFIG.businessName}. You've reached us after hours, but I can still help you.`;
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
    // "Something else" — ask what they need before taking a message.
    s.data.type = 'general inquiry';
    s.step = 'se-help';
    ask(r, "Of course — what can I help you with?", '/collect');
  }
  res.type('text/xml').send(r.toString());
});

app.post('/collect', (req, res) => {
  const s = getSession(req.body.CallSid);
  const heard = (req.body.SpeechResult || '').trim();
  const r = newCall();

  if (!heard) {
    // Caller went silent mid-flow — wrap up with what we have.
    s.data.details = s.data.details ||
      (s.data.issue ? `Issue: ${s.data.issue} | Address: (not provided)` : '(caller went silent)');
    return finalize(req, res, s);
  }
  s.silentLoops = 0; // They spoke — reset the silence counter.

  if (s.step === 'one-shot') {
    s.data.name = '-';
    s.data.details = heard;
    return finalize(req, res, s);
  }
  // "Something else" flow: what they need -> name -> callback number -> done.
  if (s.step === 'se-help') {
    s.data.details = heard;
    s.step = 'se-name';
    ask(r, "Got it. What's your name?", '/collect');
    return res.type('text/xml').send(r.toString());
  }
  if (s.step === 'se-name') {
    s.data.name = heard;
    s.step = 'se-phone';
    ask(r, `Thanks ${heard}. What's the best callback number? Or just say "use my caller ID".`, '/collect');
    return res.type('text/xml').send(r.toString());
  }
  if (s.step === 'se-phone') {
    const digits = heard.replace(/\D/g, '');
    s.data.phone = /caller|my number|this number/i.test(heard) || digits.length < 7 ? req.body.From : heard;
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
    s.step = 'issue';
    ask(r, "Briefly, what's the issue with your system?", '/collect');
    return res.type('text/xml').send(r.toString());
  }
  if (s.step === 'issue') {
    s.data.issue = heard;
    s.step = 'address';
    ask(r, "And what's the service address?", '/collect');
    return res.type('text/xml').send(r.toString());
  }
  if (s.step === 'address') {
    s.data.address = heard;
    s.data.details = `Issue: ${s.data.issue} | Address: ${heard}`;
    if (s.data.type === 'service request') {
      // Preferred appointment day + window before the SMS consent question.
      s.step = 'date';
      ask(r, "What day works best for your appointment? We're open weekdays from 8 to 5.", '/collect');
      return res.type('text/xml').send(r.toString());
    }
    return finalize(req, res, s);
  }
  if (s.step === 'date') {
    s.data.prefDate = heard;
    s.step = 'window';
    ask(r, 'And do you prefer a morning or an afternoon window?', '/collect');
    return res.type('text/xml').send(r.toString());
  }
  if (s.step === 'window') {
    s.data.prefWindow = heard;
    s.data.details += ` | Preferred: ${s.data.prefDate}, ${heard}`;
    // Explicit SMS consent (A2P compliance): only text the booking link on a clear yes.
    // Script includes the required disclosures: frequency, rates, opt-out, and
    // agreement to SMS terms and privacy policy.
    s.step = 'consent';
    ask(r, "One last thing — can I text the booking link to the number you're calling from? " +
      'Message frequency varies, message and data rates may apply, and reply STOP to cancel. ' +
      'By saying yes, you agree to our SMS terms and privacy policy, which are posted on our website. ' +
      'Just say yes or no.', '/collect');
    return res.type('text/xml').send(r.toString());
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
  // If the caller has been silent through 3 prompts, stop looping and alert the owner.
  s.silentLoops = (s.silentLoops || 0) + 1;
  if (s.silentLoops >= 3) {
    s.data.details = '(caller stayed on the line but did not leave a message)';
    return finalize(req, res, s);
  }
  const r = newCall();
  ask(r, `Please say your name and your message, and we'll call you back.`, '/collect');
  res.type('text/xml').send(r.toString());
});

// Twilio calls this when a call ends (set as statusCallback on the phone number).
// Catches callers who hang up mid-flow before finalize() runs.
app.post('/call-status', async (req, res) => {
  const callSid = req.body.CallSid;
  const status = req.body.CallStatus;
  const s = sessions.get(callSid);
  if (s && !s.finalized && ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status)) {
    s.finalized = true;
    const caller = req.body.From || 'unknown';
    const d = s.data || {};
    const duration = parseInt(req.body.CallDuration || '0', 10);
    // Only alert if we learned something or they stayed on a while.
    if (d.name || d.phone || d.issue || d.details || duration > 20) {
      await writeLog({ from: caller, type: (d.type || 'incomplete') + ' (hung up)', name: d.name || '-', phone: d.phone || caller, details: d.details || '(hung up before leaving details)' });
      for (const num of CONFIG.ownerPhones) {
        await sendSms(num, `Missed call — ${d.name || 'unknown'} (${d.phone || caller}) hung up before finishing. ${d.details || 'No details left.'} Call back: ${d.phone || caller}`);
      }
    }
    sessions.delete(callSid);
  }
  res.sendStatus(200);
});

/* ==================== SMS auto-reply ==================== */
const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');

/* Count prior inbound texts from a number within the given hours (used to
   suppress the booking-link auto-reply mid-conversation). */
async function recentSmsInboundCount(from, hours) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  if (pgPool) {
    try {
      const { rows } = await pgPool.query(
        `SELECT COUNT(*)::int AS n FROM calls
         WHERE type = 'sms inbound' AND from_number = $1 AND at > $2`,
        [from, new Date(cutoff).toISOString()]
      );
      return rows[0].n;
    } catch (e) {
      console.error('sms recency check failed:', e.message);
      return 0; // fail-open: send the auto-reply (current behavior)
    }
  }
  try {
    return readLogLocal().filter(
      (l) => l.type === 'sms inbound' && l.from === from && new Date(l.at).getTime() > cutoff
    ).length;
  } catch {
    return 0;
  }
}

app.post('/sms', async (req, res) => {
  const r = new twilio.twiml.MessagingResponse();
  const from = req.body.From || 'unknown';
  const text = req.body.Body || '-';
  // Inbound photos: download, re-host, and include them in the owner alert.
  const media = await storeInboundMedia(req.body, from);
  const mediaUrls = media.map((m) => m.url);
  const photoNote = mediaUrls.length
    ? ` [${mediaUrls.length} photo${mediaUrls.length > 1 ? 's' : ''}: ${mediaUrls.join(', ')}]`
    : '';
  // Only auto-reply with the booking link on a fresh conversation — if they've
  // texted within the cooldown window, just log and alert the owner instead.
  const priorCount = await recentSmsInboundCount(from, CONFIG.autoReplyCooldownHours);
  if (priorCount === 0) {
    const link = CONFIG.bookingUrl ? await makeTrackedLink(from, CONFIG.bookingUrl) : '(booking link coming soon)';
    const body = mediaUrls.length
      ? `Got the photo, thanks! We'll take a look. Book online here: ${link} — or just reply and we'll call you back.`
      : `Thanks for texting ${CONFIG.businessName}! Book online here: ${link} — or just reply and we'll call you back.`;
    r.message(body);
  } else if (mediaUrls.length) {
    // Mid-conversation photo: acknowledge it without re-sending the booking link.
    r.message('Got the photo, thanks — we\'ll take a look and get back to you.');
  }
  await writeLog({ from, type: 'sms inbound', name: '-', phone: from, details: text + photoNote });
  // Alert the owner(s) so text replies don't sit unseen on the dashboard.
  // Photos go through as MMS attachments so the owner sees them in the thread.
  // Skip when the reply came from one of the owner's own numbers (avoid self-pings).
  const ownerDigits = CONFIG.ownerPhones.map(digits);
  const isOwner = ownerDigits.includes(digits(from));
  if (!isOwner) {
    for (const num of CONFIG.ownerPhones) {
      await sendSms(num, `Text reply from ${from}: ${text}${mediaUrls.length ? ' (photo attached)' : ''}`, mediaUrls);
    }
  } else if (mediaUrls.length) {
    // Owner testing MMS from their own phone: echo the photo back so they
    // can confirm the pipeline works (self-ping guard skips the normal alert).
    const m = r.message('Photo received and stored:');
    for (const u of mediaUrls.slice(0, 10)) m.media(u);
  }
  res.type('text/xml').send(r.toString());
});

/* ==================== Tracked link redirect (/b/:token) ==================== */
app.get('/b/:token', async (req, res) => {
  const rec = await getLink(req.params.token);
  if (!rec || !rec.url) return res.status(404).send('This link is no longer available.');
  const ua = req.get('user-agent') || '';
  rec.hits = (rec.hits || 0) + 1;
  rec.lastHitAt = new Date().toISOString();
  if (!PREVIEW_UA.test(ua) && !rec.tappedAt) {
    rec.tappedAt = rec.lastHitAt;
    const matched = await recordLinkClick(rec.to, rec.lastHitAt);
    console.log(`link tap: ${rec.to} at ${rec.lastHitAt} (matched call log: ${matched})`);
  }
  await saveLink(req.params.token, rec);
  res.redirect(302, rec.url);
});

/* ==================== Error handling ==================== */
// If anything throws, never hand Twilio an HTML error page (it plays
// "an application error has occurred" and hangs up). Answer with valid
// TwiML so the caller hears a graceful goodbye instead.
app.use((err, req, res, next) => {
  console.error('webhook error:', err && err.message);
  try {
    const r = newCall();
    r.say(
      { voice: CONFIG.voice },
      "Sorry, something went wrong on our end. Please call back in a moment, or send us a text and we'll get right back to you."
    );
    r.hangup();
    res.type('text/xml').send(r.toString());
  } catch {
    res.type('text/xml').send('<Response><Hangup/></Response>');
  }
});

/* ==================== Dashboard ==================== */
app.get('/', async (req, res) => {
  const log = await readLog();
  const rows = log
    .map((c) => {
      const link = c.linkClickedAt
        ? `✅ ${esc(new Date(c.linkClickedAt).toLocaleString())}${c.linkClickCount > 1 ? ` (${c.linkClickCount}×)` : ''}`
        : '–';
      return `<tr><td>${esc(new Date(c.at).toLocaleString())}</td><td>${esc(c.type)}</td>` +
        `<td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${esc(c.details)}</td><td>${link}</td></tr>`;
    })
    .join('');
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(CONFIG.businessName)} — Call log</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:14px}th{background:#f4f4f4}
h1{font-size:22px} .meta{color:#666;margin-bottom:16px}</style></head>
<body><h1>${esc(CONFIG.businessName)} — Receptionist call log</h1>
<div class="meta">${log.length} calls logged · <a href="/">refresh</a></div>
<table><tr><th>Time</th><th>Type</th><th>Name</th><th>Phone</th><th>Details</th><th>Link tap</th></tr>${rows || '<tr><td colspan=6>No calls yet.</td></tr>'}</table>
</body></html>`);
});

app.get('/health', (req, res) => res.json({ ok: true, twilio: hasTwilio, linkTracking: 'self-hosted' }));

/* ==================== Public compliance pages (A2P registration) ==================== */
const PAGE_STYLE = `body{font-family:system-ui,-apple-system,sans-serif;margin:0;color:#222;line-height:1.6}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px}
h1{font-size:26px;margin-bottom:4px}h2{font-size:18px;margin-top:28px}
p,li{font-size:15px}.updated{color:#666;font-size:13px;margin-bottom:24px}
footer{margin-top:40px;padding-top:16px;border-top:1px solid #ddd;font-size:13px;color:#666}`;

app.get('/privacy-policy', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy — Davis Mechanical Contractors</title>
<style>${PAGE_STYLE}</style></head><body><div class="wrap">
<h1>Privacy Policy</h1>
<div class="updated">Davis Mechanical Contractors · Effective September 28, 2026</div>

<h2>Information we collect</h2>
<p>When you call Davis Mechanical Contractors at <strong>713-875-0980</strong>, our automated
receptionist may collect your name, phone number, service address, and a description of the
HVAC issue you are calling about, and any photos you choose to text to our number
(e.g. pictures of your equipment). We also retain call timestamps and call logs for service
and compliance purposes.</p>

<h2>How we use your information</h2>
<ul>
<li>To respond to your service request and arrange a callback or appointment.</li>
<li>To send you a text message with our online booking link — <em>only</em> if you verbally
agree to receive it during your call.</li>
<li>To maintain records of service requests.</li>
</ul>

<h2>Text messages (SMS)</h2>
<p>We send transactional text messages only — such as a booking link in direct response to a
service call you placed with us. We do not send marketing or promotional texts. Message
frequency varies by request and is typically one message per service call. Message and data
rates may apply. Reply <strong>STOP</strong> to opt out of future texts, or
<strong>HELP</strong> for help.</p>

<h2>Sharing of information</h2>
<p>We do not sell your personal information. <strong>Mobile information and messaging consent —
including phone numbers collected for SMS — are not shared with third parties or affiliates
for marketing or promotional purposes.</strong> We share information only as needed to provide
the service you requested (for example, with our phone service provider to deliver a text
you asked for) or as required by law.</p>

<h2>Data security and retention</h2>
<p>We take reasonable measures to protect your information and retain call records only as
long as needed for business and compliance purposes.</p>

<h2>Contact us</h2>
<p>Davis Mechanical Contractors<br>
Brazoria County, Texas<br>
Phone: <a href="tel:+17138750980">713-875-0980</a><br>
Email: <a href="mailto:ndavis@davismechanicaltx.com">ndavis@davismechanicaltx.com</a></p>

<p>We may update this policy from time to time; the current version will always be posted
at this address.</p>
<footer>© 2026 Davis Mechanical Contractors. All rights reserved.</footer>
</div></body></html>`);
});

app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMS Terms of Service — Davis Mechanical Contractors</title>
<style>${PAGE_STYLE}</style></head><body><div class="wrap">
<h1>SMS Terms of Service</h1>
<div class="updated">Davis Mechanical Contractors · Effective September 28, 2026</div>

<h2>Program description</h2>
<p>Davis Mechanical Contractors operates a customer-care text messaging program. When you call
us at <strong>713-875-0980</strong> and request HVAC service through our automated
receptionist, we may send you transactional text messages — such as a link to book your
appointment online — in direct response to your call. This program is strictly for customer
care; we do not send marketing or promotional messages.</p>

<h2>Opting in</h2>
<p>You opt in by calling us and verbally agreeing to receive a text message during your
service call. A text is only sent when you clearly say yes. If you say no, stay silent, or
give an unclear answer, no text is sent.</p>

<h2>Message frequency</h2>
<p>Message frequency varies based on your requests — typically one message per service call.</p>

<h2>Cost</h2>
<p><strong>Message and data rates may apply</strong> depending on your mobile plan.</p>

<h2>Opting out</h2>
<p>You can opt out at any time by replying <strong>STOP</strong> to any message. After you
opt out, you will receive a confirmation text and no further messages will be sent unless
you opt in again. For help, reply <strong>HELP</strong> or contact us at
<a href="tel:+17138750980">713-875-0980</a>.</p>

<h2>Supported carriers and delivery</h2>
<p>Messages are sent through major U.S. wireless carriers. Delivery is subject to your
carrier's coverage and is not guaranteed. Supported carriers may change without notice.</p>

<h2>Privacy</h2>
<p>Your mobile information is handled according to our
<a href="/privacy-policy">Privacy Policy</a>. Mobile information and messaging consent are
not shared with third parties or affiliates for marketing or promotional purposes.</p>

<h2>Contact us</h2>
<p>Davis Mechanical Contractors<br>
Brazoria County, Texas<br>
Phone: <a href="tel:+17138750980">713-875-0980</a><br>
Email: <a href="mailto:ndavis@davismechanicaltx.com">ndavis@davismechanicaltx.com</a></p>

<h2>Changes to these terms</h2>
<p>We may update these terms from time to time; the current version will always be posted
at this address. Continued participation in the program after changes are posted
constitutes acceptance of the updated terms.</p>
<footer>© 2026 Davis Mechanical Contractors. All rights reserved.</footer>
</div></body></html>`);
});

/* ==================== Start ==================== */
const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Receptionist listening on :${PORT} (Twilio creds ${hasTwilio ? 'loaded' : 'MISSING — copy .env.example to .env'})`);
  });
});
