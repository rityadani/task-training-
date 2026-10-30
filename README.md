# Verdant & Co — Support Desk

A lightweight support workflow for a skincare brand. Customer messages arrive via webhook, an AI draft reply is generated using the brand's knowledge base, and a support agent reviews and approves it. The approved reply is then visible in the customer view.

---

## Local run

```bash
# 1. Clone and install
npm install

# 2. Copy env file
cp .env.example .env

# 3. (Optional) Add your OpenRouter API key in .env for real LLM replies
#    Free key at https://openrouter.ai — uses mistral-7b-instruct:free
#    Without a key, the app falls back to accurate keyword-based replies

# 4. Start
npm start

# 5. Open
http://localhost:3000
```

Demo agent login: `admin@verdant.test` / `verdant123`

---

## Webhook endpoint

```
POST /webhook
Header: X-Signature: sha256=<hmac-sha256 of raw body using secret verdant-demo-secret-2026>
Content-Type: application/json
```

Exact format supported:

```json
{
  "event_id": "evt_7f3a91c2",
  "type": "message.received",
  "brand_id": "verdant-co",
  "timestamp": "2026-11-03T10:15:22Z",
  "customer": {
    "id": "cust_1042",
    "name": "Aisha Khan",
    "phone": "+919800000001"
  },
  "message": {
    "id": "msg_88213",
    "type": "text",
    "text": "Hi, my order hasn't arrived. Can I change the delivery address?"
  }
}
```

Test with curl:

```bash
BODY='{"event_id":"evt_test01","customer":{"id":"cust_test","name":"Test User","phone":"+919999999999"},"message":{"text":"What is your return policy?"}}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "verdant-demo-secret-2026" | awk '{print "sha256="$2}')
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIG" \
  -d "$BODY"
```

---

## Main decisions

**Backend:** Node.js + Express. Fast to set up, single-process deployment, no build step needed for a task of this scope.

**Database:** SQLite via `better-sqlite3`. The schema is fully relational (customers → conversations → messages, plus webhook_events for deduplication). SQLite is fine for a local demo and single-instance deployment. For production or multi-instance deployment, swapping to PostgreSQL requires only changing the DB driver — the schema and queries are standard SQL.

**AI replies:** Two-layer approach:
1. If `OPENROUTER_API_KEY` is set, the app calls `mistralai/mistral-7b-instruct:free` via OpenRouter with the full knowledge base as the system prompt. Temperature is set to 0.3 to keep replies factual and consistent.
2. If no key is set or the LLM call fails, the app falls back to deterministic keyword matching against the same knowledge base. The fallback covers all five sample messages correctly.

**Retrieval:** The knowledge base is small (7 policies, ~200 words), so it fits entirely in the LLM system prompt. No vector database or embeddings are needed at this scale. This approach stops working well when the knowledge base grows beyond ~10,000 tokens or when policies become ambiguous — at that point, chunked retrieval with embeddings would be the right next step.

**Webhook format:** The server handles the exact task format where `message` is an object with a `text` field (`payload.message.text`), as well as a flat string format for convenience.

**Duplicate events:** Webhook events with a previously seen `event_id` return `200 { duplicate: true }` without re-processing.

**Safety:** Medical and allergy messages are intercepted before the LLM call and always return a safe, pre-written response flagged for agent review.

---

## What was intentionally left out

- **PostgreSQL:** SQLite used for zero-config local setup. The schema is portable.
- **Session-based auth:** Agent login is a hardcoded demo credential. A real system would use JWT or session tokens.
- **Real WhatsApp integration:** Not required by the task.
- **Pagination:** Conversation and message lists are unpaginated — fine for a demo, not for production.

---

## Where AI helped, and where it went wrong

AI helped by drafting the initial schema, the Express route structure, the HMAC signature verification, and the knowledge-base guardrails for all five sample messages.

One place it got something wrong: the first generated version read `payload.message` as a plain string, which would have broken the exact webhook format specified in the task (where `message` is an object with a `text` field). I caught this by reading the task spec carefully and fixed the extraction to handle both `payload.message.text` and `payload.message` as a string.

---

## Questions

**1. A customer message arrives at 2 AM and something fails. What does the agent see in the morning, and how would you find out what went wrong?**

Message persistence and AI draft generation are separate steps. If the AI step fails, the customer message is still saved and the conversation appears in the agent's list — the agent sees the message with a fallback draft ("An agent will review this") instead of an AI reply. To find out what broke, I would check the server logs (the app logs all LLM errors with `console.error`) and the `webhook_events` table, which stores the raw payload of every incoming request. In production I would add structured logging (e.g. with `pino`) and ship logs to a sink like Logtail or Datadog so they survive a server restart.

**2. This now has to serve 20 brands, each with its own knowledge base and agents.**

The first change would be adding a `brand_id` column to every table and scoping all queries by it. Each brand gets its own knowledge base stored in the database (or a separate file/blob), and the LLM system prompt is assembled per-brand at request time. Agent accounts get a `brand_id` foreign key so they only see their brand's conversations. This is a single-tenant-to-multi-tenant migration — the core workflow stays the same, only the data isolation and prompt assembly change. I would do this before adding any other feature because retrofitting multi-tenancy later is significantly harder than building it in from the start.

---

## Demo flow

1. **Customer view** — select a test customer, type one of the sample messages, click Send.
2. **Agent view** — sign in, open the newest conversation, read the AI draft, edit if needed, click Approve.
3. **Customer view** — switch back and see the approved reply.
4. **Webhook** — use the curl command above or the built-in Webhook Tester tab to send a signed request directly.
