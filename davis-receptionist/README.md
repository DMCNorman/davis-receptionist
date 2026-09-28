# AI Receptionist — Davis Mechanical Contractors

A Twilio-powered phone receptionist. Answers every call 24/7, routes callers
(new service / existing appointment / emergency / message), collects their info
by voice, texts them your Housecall Pro booking link, and texts **you** an
instant lead alert.

## How it works

```
Caller dials your Twilio number
        │
        ▼
  Spoken greeting (after-hours aware)
        │
        ▼
  "New service request, existing appointment, or something else?"
        │
   ┌────┴───────────────────────────────┐
   ▼                                    ▼
Service / Emergency               Existing / Other
   │                                    │
   ▼                                    ▼
Name → callback number →        One-shot: "say your name
issue + address                 and what's going on"
   │                                    │
   └────────────┬───────────────────────┘
                ▼
   Log call → text caller booking link (service only)
           → text YOU the lead details
           → say goodbye
```

Also included: SMS auto-reply (`/sms`) and a call-log dashboard at `/`.

## Setup

### 1. Install
```bash
cd ~/workspace/ai-receptionist
npm install
cp .env.example .env
```
`.env` is pre-filled with your business name, cell (lead alerts), and
Housecall Pro booking link. You only need to add the Twilio values.

### 2. Get a Twilio number
1. Create an account at twilio.com/try-twilio (free trial works for testing).
2. Buy a phone number: **Phone Numbers → Buy a number** (~$1–2/mo).
3. Copy your **Account SID** and **Auth Token** from the Twilio console into `.env`,
   along with the number as `TWILIO_PHONE_NUMBER` (E.164 format, e.g. `+17135551212`).

**Costs to expect:** number ~$1–2/mo, inbound voice ~$0.0085/min,
outbound SMS ~$0.008/segment (US). A shop taking ~100 calls/mo typically lands
under $10–15/mo in usage.

### 3. Deploy (needs a public HTTPS URL)
This server must be reachable by Twilio. Easiest options:
- **Render.com** — free tier, `render.com`, new Web Service from this folder.
- **Railway.app** or **Fly.io** — similar one-command deploys.

Set the same env vars from `.env` in the host's dashboard.

### 4. Point Twilio at your server
In the Twilio console, open your number's configuration:
- **Voice → A call comes in → Webhook** → `POST https://YOUR-APP/voice`
- **Messaging → A message comes in → Webhook** → `POST https://YOUR-APP/sms`

### 5. Test
Call the Twilio number. Try: *"I need AC repair"*, *"where's my technician"*,
*"I smell gas"*, and silence (should take a message). Check the dashboard at
`https://YOUR-APP/` and confirm you got the lead-alert text.

### 6. Go live
Forward your business line to the Twilio number (conditional forward on
no-answer is ideal: your phone rings first, the receptionist catches what you miss).

## Customizing

- **Wording/hours:** edit the `CONFIG` block at the top of `server.js`
  (business name, voice, business hours for the greeting).
- **Full call script:** see `call-script.md` — the implemented flow matches it.
- **Security (recommended):** validate that webhooks really come from Twilio:
  ```js
  // put before your routes:
  app.use('/voice', twilio.webhook({ protocol: 'https' }));
  app.use('/route', twilio.webhook({ protocol: 'https' }));
  app.use('/collect', twilio.webhook({ protocol: 'https' }));
  app.use('/take-message', twilio.webhook({ protocol: 'https' }));
  app.use('/sms', twilio.webhook({ protocol: 'https' }));
  ```

## Limitations of this scaffold (upgrade paths)

- **Keyword-based routing**, not a full LLM conversation. Upgrade: pipe the
  transcript through an LLM (OpenAI/Anthropic API) in `/route` for natural
  understanding, or use Twilio's ConversationRelay for real-time voice AI.
- **In-memory sessions** — a server restart mid-call loses that call's state.
  Upgrade: Redis or a database.
- **JSON log file** — fine to start; move to Postgres/Supabase if you outgrow it.
- **Single language** (English). Twilio supports `es-US` — duplicate the
  gather prompts to add Spanish.
