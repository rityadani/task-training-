# Verdant & Co Take-home Assessment

Verdant & Co is a skincare brand. Customers send support messages such as "when will my order arrive?" or "can I return this?". The task is to build a support tool that helps the support team answer quickly.

## Functional requirements

1. Webhook: POST /webhook
   - Customer message arrives as JSON.
   - Save in a database: customer (id, name, phone), conversation, and messages.
   - Each customer has one open conversation.

2. AI draft reply
   - For every new message, create a suggested reply using an LLM-style draft process.
   - Only the provided knowledge base is the source of truth for shipping, returns, refunds, COD, and related policies.
   - Drafts must not be shown to the customer automatically.

3. Agent web app
   - Agent sign in.
   - View conversation list sorted newest first.
   - Open a conversation and edit the AI draft.
   - Click Approve to save the approved reply into the conversation.

4. Customer/Agent toggle
   - At the top, add a switch to switch between Customer view and Agent view.
   - Customer view lets a test customer be chosen, a message be sent, and approved replies shown.
   - Customer view receives no sign-in flow.
   - Messages from the customer view must be handled exactly the same as webhook messages.

## Webhook security

- Every request includes `X-Signature: sha256=<hex>`.
- The value is the HMAC-SHA256 of the raw request body using the shared secret `verdant-demo-secret-2026`.
- Verify the signature before processing any payload.
- Return a 2xx response when the request is handled successfully.

## Edge cases and hidden tests

- Dubai delivery is not in the knowledge base. The AI must not guess. It must say an agent will confirm.
- Allergy-related messages are medical in nature. The AI must not provide advice; it must recommend stopping use and speaking to a doctor, and the agent should be flagged.
- COD above ₹3,000 is not available.
- Address changes are only allowed before shipment and within 12 hours of order placement.
- Duplicate `event_id` values should not create double saves.
- If LLM generation fails, the customer message should still be stored.

## Delivery expectations

The final app should be demonstrable end-to-end:
- Send a message from customer view.
- See the draft in agent view.
- Edit and approve it.
- Verify the approved reply appears in customer view.
- Also verify that the same flow works when a signed webhook request is sent directly.

## Submission checklist

- Deployed link (Vercel/Render/Railway/Supabase free tier) or local run instructions.
- GitHub repo with `.env.example` and no committed secrets.
- README under one page with local run steps, main decisions, what was left out, AI help, AI mistake, and 2 question answers.
- Demo video within 3 minutes showing the full end-to-end flow. 
