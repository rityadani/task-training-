require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'verdant-demo-secret-2026';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'verdant.db'));
db.pragma('journal_mode = WAL');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      content TEXT NOT NULL,
      is_draft INTEGER NOT NULL DEFAULT 0,
      approved INTEGER NOT NULL DEFAULT 0,
      requires_agent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id),
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const seed = [
    ['cust_1001', 'Aisha Khan', '+971501234567'],
    ['cust_1002', 'Rohan Malik', '+919876543210'],
    ['cust_1003', 'Nadia Feris', '+971555112233']
  ];

  const insertCustomer = db.prepare(`
    INSERT OR IGNORE INTO customers (id, name, phone) VALUES (?, ?, ?)
  `);

  for (const customer of seed) {
    insertCustomer.run(...customer);
  }
}

function uuid() {
  return crypto.randomUUID();
}

function verifySignature(signature, rawBody, secret) {
  if (!signature || typeof signature !== 'string') return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex');
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (error) {
    return false;
  }
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function getOrCreateCustomer(payloadCustomer) {
  const customer = payloadCustomer || {};
  const customerId = normalizeText(customer.id || customer.customer_id || customer.customerId || `${customer.phone || 'guest'}_${Date.now()}`);
  const name = normalizeText(customer.name || 'Customer');
  const phone = normalizeText(customer.phone || customer.mobile || '');

  db.prepare(`
    INSERT OR IGNORE INTO customers (id, name, phone) VALUES (?, ?, ?)
  `).run(customerId, name || 'Customer', phone || '');

  return { id: customerId, name: name || 'Customer', phone: phone || '' };
}

function ensureOpenConversation(customerId) {
  let conversation = db.prepare(`
    SELECT * FROM conversations WHERE customer_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1
  `).get(customerId);

  if (!conversation) {
    conversation = {
      id: uuid(),
      customer_id: customerId,
      status: 'open',
      created_at: new Date().toISOString()
    };
    db.prepare(`
      INSERT INTO conversations (id, customer_id, status, created_at) VALUES (?, ?, ?, ?)
    `).run(conversation.id, conversation.customer_id, conversation.status, conversation.created_at);
  }

  return conversation;
}

function insertMessage({ conversationId, customerId, senderType, content, isDraft = 0, approved = 0, requiresAgent = 0 }) {
  const id = uuid();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, customer_id, sender_type, content, is_draft, approved, requires_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, conversationId, customerId, senderType, content, Number(isDraft), Number(approved), Number(requiresAgent), new Date().toISOString());
  return id;
}

const KNOWLEDGE_BASE = `
You are a support agent for Verdant & Co, an online skincare brand. Reply using ONLY the policies below. Be short, polite and accurate. If the answer is not in the policies, say you cannot confirm it and that an agent will follow up. Never guess.

Policies:
- Shipping: Orders ship within 24 hours Mon-Sat. Delivery: 3-5 business days in metro cities, 5-8 days elsewhere in India.
- Address change: Only before shipment AND within 12 hours of placing the order. After shipping, address cannot be changed.
- Cancellation: Can cancel before shipment. After shipment, customer can refuse delivery; refund issued once parcel returns.
- Returns: Within 7 days of delivery for unopened, unused products. Opened products accepted only if damaged or wrong item sent.
- Refunds: Approved refunds go back to original payment method within 5-7 business days after receiving the returned parcel.
- Cash on delivery (COD): Available for orders under ₹3,000 with a ₹50 fee. Not available for orders ₹3,000 or above.
- Ingredients: All Verdant & Co products are fragrance-free and vegan.
- Medical/allergy concerns: Do NOT give medical advice. Tell the customer to stop using the product and consult a doctor, and flag for agent.
- Delivery outside India (e.g. Dubai, UAE): Not covered in the knowledge base. Do not guess. Tell the customer an agent will confirm.
`;

async function generateDraftReply(messageText) {
  const text = normalizeText(messageText || '');

  // Always flag medical cases immediately without LLM
  if (/allergy|allergic|rash|itch|sore|burn|swollen|reaction|medical/i.test(text)) {
    return 'We are sorry to hear this. Please stop using the product immediately and consult a doctor. We have flagged your message for our agent who will follow up with you shortly.';
  }

  // Try Groq first, then OpenRouter, then fallback
  const apiKey = GROQ_API_KEY || OPENROUTER_API_KEY;
  const apiUrl = GROQ_API_KEY
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';
  const model = GROQ_API_KEY
    ? 'qwen/qwen3.8-27b'
    : 'mistralai/mistral-7b-instruct:free';

  if (apiKey) {
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: KNOWLEDGE_BASE },
            { role: 'user', content: text }
          ],
          max_tokens: 200,
          temperature: 0.3
        })
      });
      const data = await response.json();
      const reply = data?.choices?.[0]?.message?.content?.trim();
      if (reply) return reply;
    } catch (err) {
      console.error('LLM error, falling back to keyword reply:', err.message);
    }
  }

  // Keyword fallback (used when no API key or LLM fails)
  const lower = text.toLowerCase();

  if (/dubai|uae|emirates|abu dhabi/.test(lower))
    return 'I cannot confirm delivery to Dubai from our knowledge base. An agent will reach out to confirm availability and shipping options.';

  if (/cod|cash on delivery/.test(lower)) {
    if (/3[,.]?500|3500/.test(lower) || /₹\s*3[,.]?5/.test(lower))
      return 'COD is not available for orders of ₹3,000 or above. Please choose a prepaid payment method or contact our agent for help.';
    return 'COD is available for orders under ₹3,000 with a ₹50 fee. An agent can confirm your order details.';
  }

  if (/change.*address|address.*change|update.*address/.test(lower))
    return 'Delivery address changes are only possible before the order ships and within 12 hours of placing it. Please contact us urgently if your order was placed recently.';

  if (/cancel/.test(lower))
    return 'Orders can be cancelled before they ship. If your order has already shipped, you can refuse delivery and a refund will be issued once the parcel returns to us.';

  if (/return|exchange/.test(lower))
    return 'We accept returns within 7 days of delivery for unopened, unused products. Opened products are accepted only if damaged or if the wrong item was sent. Please share your order number so our agent can assist.';

  if (/refund|money back/.test(lower))
    return 'Approved refunds are processed to your original payment method within 5-7 business days after we receive the returned parcel. Please share your order number for follow-up.';

  if (/ship|deliver|dispatch|track|arrive|where.*order|when.*order/.test(lower))
    return 'Orders are dispatched within 24 hours (Mon–Sat). Delivery takes 3–5 business days in metro cities and 5–8 days elsewhere in India. Share your order number and an agent will confirm the exact status.';

  if (/ingredient|fragrance|vegan|cruelty/.test(lower))
    return 'All Verdant & Co products are fragrance-free and vegan. If you have a specific ingredient concern, our agent will be happy to help.';

  return 'Thank you for reaching out. I was unable to find a specific answer in our knowledge base. An agent will review your message and get back to you shortly.';
}

function getConversationSummary(customerId) {
  const conversation = db.prepare(`
    SELECT c.*, cust.name AS customer_name, cust.phone
    FROM conversations c
    JOIN customers cust ON cust.id = c.customer_id
    WHERE c.customer_id = ? AND c.status = 'open'
    ORDER BY c.created_at DESC LIMIT 1
  `).get(customerId);

  return conversation;
}

function getConversationWithMessages(conversationId) {
  const conversation = db.prepare(`
    SELECT c.*, cust.name AS customer_name, cust.phone
    FROM conversations c
    JOIN customers cust ON cust.id = c.customer_id
    WHERE c.id = ?
  `).get(conversationId);

  if (!conversation) return null;

  const messages = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC
  `).all(conversationId);

  return { conversation, messages };
}

function getCustomerMessages(customerId) {
  const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId);
  if (!customer) return [];

  const conversation = getConversationSummary(customerId);
  if (!conversation) return [];

  return db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC
  `).all(conversation.id);
}

function getConversationList() {
  const conversations = db.prepare(`
    SELECT c.id, c.customer_id, c.status, c.created_at, cust.name AS customer_name, cust.phone
    FROM conversations c
    JOIN customers cust ON cust.id = c.customer_id
    ORDER BY c.created_at DESC
  `).all();

  return conversations.map((conversation) => {
    const lastMessage = db.prepare(`
      SELECT content, created_at, sender_type FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(conversation.id);

    const totalMessages = db.prepare(`
      SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?
    `).get(conversation.id).count;

    return {
      id: conversation.id,
      customer_id: conversation.customer_id,
      customer_name: conversation.customer_name,
      phone: conversation.phone,
      status: conversation.status,
      created_at: conversation.created_at,
      last_message: lastMessage ? lastMessage.content : 'No messages yet',
      total_messages: totalMessages
    };
  });
}

app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/webhook') {
    let rawBody = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      req.rawBody = rawBody;
      next();
    });
    return;
  }
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Verdant support desk', time: new Date().toISOString() });
});

app.get('/api/customers', (_req, res) => {
  const customers = db.prepare(`SELECT * FROM customers ORDER BY created_at ASC`).all();
  res.json(customers);
});

app.get('/api/conversations', (_req, res) => {
  res.json(getConversationList());
});

app.get('/api/conversations/:id', (req, res) => {
  const data = getConversationWithMessages(req.params.id);
  if (!data) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  res.json(data);
});

app.post('/api/customers/:customerId/messages', async (req, res) => {
  const customerId = req.params.customerId;
  const text = normalizeText(req.body?.message || req.body?.text || '');

  if (!text) return res.status(400).json({ error: 'Message text is required' });

  const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const conversation = ensureOpenConversation(customerId);

  const customerMessageId = insertMessage({
    conversationId: conversation.id,
    customerId,
    senderType: 'customer',
    content: text,
    isDraft: 0,
    approved: 1,
    requiresAgent: 0
  });

  const requiresAgent = /allergy|allergic|rash|itch|sore|burn|swollen|reaction|medical/i.test(text) ? 1 : 0;
  let draftText = 'I could not generate a response right now. An agent will review this.';

  try {
    draftText = await generateDraftReply(text);
  } catch (err) {
    console.error('Draft generation failed:', err.message);
  }

  const draftMessageId = insertMessage({
    conversationId: conversation.id,
    customerId,
    senderType: 'ai',
    content: draftText,
    isDraft: 1,
    approved: 0,
    requiresAgent
  });

  res.status(201).json({ ok: true, customerMessageId, draftMessageId, draft: draftText, conversationId: conversation.id });
});

app.post('/api/messages/:messageId/approve', (req, res) => {
  const messageId = req.params.messageId;
  const incomingText = normalizeText(req.body?.text || req.body?.content || '');
  const existingMessage = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId);

  if (!existingMessage) {
    return res.status(404).json({ error: 'Message not found' });
  }

  const safeText = incomingText || existingMessage.content;

  db.prepare(`
    UPDATE messages
    SET content = ?, is_draft = 0, approved = 1, sender_type = 'agent', requires_agent = 0
    WHERE id = ?
  `).run(safeText, messageId);

  return res.json({ ok: true, messageId, approvedText: safeText });
});

app.post('/webhook', async (req, res) => {
  const rawBody = req.rawBody || '';
  const signature = req.headers['x-signature'];

  if (!verifySignature(signature, rawBody, WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid or missing X-Signature header' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch (error) {
    return res.status(400).json({ error: 'Request body must be valid JSON' });
  }

  const eventId = normalizeText(payload.event_id || payload.id || '');
  if (eventId) {
    const seen = db.prepare(`SELECT 1 FROM webhook_events WHERE event_id = ?`).get(eventId);
    if (seen) return res.status(200).json({ ok: true, duplicate: true, event_id: eventId });
  }

  // Support both exact task format { message: { id, text } } and flat { message: "..." }
  const customerPayload = payload.customer || {};
  const customer = getOrCreateCustomer({
    id: customerPayload.id || `cust_${Date.now()}`,
    name: customerPayload.name || 'Customer',
    phone: customerPayload.phone || customerPayload.mobile || ''
  });

  const conversation = ensureOpenConversation(customer.id);

  // Extract message text from both formats
  const messageText = normalizeText(
    (typeof payload.message === 'object' ? payload.message?.text : payload.message) ||
    payload.text || payload.content || ''
  );

  if (!messageText) return res.status(400).json({ error: 'Customer message text is required' });

  const savedMessageId = insertMessage({
    conversationId: conversation.id,
    customerId: customer.id,
    senderType: 'customer',
    content: messageText,
    isDraft: 0,
    approved: 1,
    requiresAgent: 0
  });

  if (eventId) {
    db.prepare(`INSERT INTO webhook_events (event_id, payload) VALUES (?, ?)`).run(eventId, JSON.stringify(payload));
  }

  const requiresAgent = /allergy|allergic|rash|itch|sore|burn|swollen|reaction|medical/i.test(messageText) ? 1 : 0;
  let draftText = 'I could not generate a response right now. An agent will review this.';

  try {
    draftText = await generateDraftReply(messageText);
  } catch (err) {
    console.error('Draft generation failed:', err.message);
  }

  const draftMessageId = insertMessage({
    conversationId: conversation.id,
    customerId: customer.id,
    senderType: 'ai',
    content: draftText,
    isDraft: 1,
    approved: 0,
    requiresAgent
  });

  return res.status(200).json({
    ok: true,
    duplicate: false,
    conversationId: conversation.id,
    customerId: customer.id,
    messageId: savedMessageId,
    draftMessageId,
    draft: draftText
  });
});

initDb();

app.listen(PORT, () => {
  console.log(`Verdant support desk running on http://localhost:${PORT}`);
});
