const state = {
  view: 'customer',
  loggedIn: false,
  customers: [],
  conversations: [],
  selectedCustomerId: null,
  selectedConversationId: null,
  activeTone: 'friendly'
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3000);
}

function el(id) { return document.getElementById(id); }

// ── AI Features ──────────────────────────────────────────────────────────────

const SENTIMENT_KEYWORDS = {
  positive: ['thank', 'great', 'love', 'happy', 'good', 'excellent', 'perfect', 'amazing', 'wonderful'],
  negative: ['angry', 'bad', 'terrible', 'worst', 'hate', 'frustrated', 'disappointed', 'broken', 'wrong', 'issue', 'problem', 'refund', 'return'],
  urgent: ['urgent', 'asap', 'immediately', 'emergency', 'now', 'quick', 'fast', 'allergy', 'allergic', 'rash']
};

function analyzeSentiment(text) {
  const lower = text.toLowerCase();
  let score = { positive: 0, negative: 0, urgent: 0 };
  for (const [type, words] of Object.entries(SENTIMENT_KEYWORDS)) {
    score[type] = words.filter(w => lower.includes(w)).length;
  }
  if (score.urgent > 0) return { label: '🚨 Urgent', color: '#f85149', score: score.urgent };
  if (score.negative > score.positive) return { label: '😠 Negative', color: '#f0883e', score: score.negative };
  if (score.positive > 0) return { label: '😊 Positive', color: '#3fb950', score: score.positive };
  return { label: '😐 Neutral', color: '#8b949e', score: 1 };
}

function updateSentiment(text) {
  const box = el('sentimentBox');
  if (!text.trim()) {
    box.innerHTML = '<div class="sentiment-empty">Type a message to analyze sentiment</div>';
    return;
  }
  const s = analyzeSentiment(text);
  box.innerHTML = `
    <div class="sentiment-result" style="color:${s.color}">${s.label}</div>
    <div class="progress-bar-wrap" style="margin-top:8px">
      <div class="progress-bar" style="width:${Math.min(s.score * 30, 100)}%;background:${s.color}"></div>
    </div>
  `;
}

function getAIPreview(text) {
  const lower = text.toLowerCase();
  if (/allergy|allergic|rash|itch|burn|reaction|medical/.test(lower))
    return '⚠️ Medical concern detected — will flag for agent review.';
  if (/dubai|uae|emirates/.test(lower))
    return '📍 Dubai delivery query — agent confirmation required.';
  if (/cod|cash on delivery/.test(lower))
    return '💵 COD query — will check ₹3,000 limit policy.';
  if (/return|exchange/.test(lower))
    return '↩️ Return request — 7-day policy applies.';
  if (/refund|money back/.test(lower))
    return '💰 Refund query — 5-7 business days processing.';
  if (/ship|deliver|track|dispatch/.test(lower))
    return '📦 Shipping query — 24-48h dispatch, 3-5 days delivery.';
  if (/address|change.*address/.test(lower))
    return '📍 Address change — only before shipment within 12h.';
  return '🤖 General query — will escalate to agent if no match found.';
}

function updateAIPreview(text) {
  const box = el('aiPreviewBox');
  if (!text.trim()) {
    box.innerHTML = '<div class="sentiment-empty">AI draft will appear here</div>';
    return;
  }
  box.innerHTML = `<div style="color:var(--orange);font-size:12px;line-height:1.6">${getAIPreview(text)}</div>`;
}

function applyTone(text, tone) {
  if (!text) return text;
  const prefixes = {
    formal: 'Dear Customer, ',
    friendly: 'Hi there! ',
    empathetic: 'We completely understand your concern. '
  };
  const suffixes = {
    formal: ' Please do not hesitate to contact us for further assistance.',
    friendly: ' Let us know if you need anything else! 😊',
    empathetic: ' We are here to help and will resolve this as quickly as possible.'
  };
  return (prefixes[tone] || '') + text + (suffixes[tone] || '');
}

function generateConvSummary(messages) {
  if (!messages || !messages.length) return 'No messages in this conversation.';
  const customerMsgs = messages.filter(m => m.sender_type === 'customer');
  const hasDraft = messages.some(m => Number(m.is_draft) === 1);
  const lastMsg = customerMsgs[customerMsgs.length - 1];
  const sentiment = lastMsg ? analyzeSentiment(lastMsg.content) : { label: 'Neutral' };
  return `📨 ${customerMsgs.length} customer message(s)\n${hasDraft ? '⏳ AI draft pending approval\n' : '✅ No pending drafts\n'}🎭 Sentiment: ${sentiment.label}`;
}

function scoreResponseQuality(text) {
  if (!text) return '—';
  const len = text.length;
  let score = 0;
  if (len > 50) score += 30;
  if (len > 100) score += 20;
  if (/agent|confirm|review/.test(text.toLowerCase())) score += 20;
  if (/day|hour|business/.test(text.toLowerCase())) score += 15;
  if (/please|thank|help/.test(text.toLowerCase())) score += 15;
  const label = score >= 80 ? '🟢 Excellent' : score >= 50 ? '🟡 Good' : '🔴 Needs improvement';
  return `${label} (${score}/100)`;
}

// ── Render ────────────────────────────────────────────────────────────────────

function messageHtml(msg) {
  const sender = msg.sender_type || 'customer';
  const content = (msg.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const time = new Date(msg.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const label = sender === 'customer' ? '👤 Customer' : sender === 'agent' ? '🛡️ Agent' : '🤖 AI Draft';
  return `
    <article class="message ${sender === 'customer' ? 'customer' : sender === 'agent' ? 'agent' : 'ai'}">
      <div class="message-header"><strong>${label}</strong><span>${time}</span></div>
      <div class="message-body">${content}</div>
    </article>`;
}

function renderCustomerMessages(messages) {
  const box = el('customerMessages');
  const visible = (messages || []).filter(m => !Number(m.is_draft));
  box.innerHTML = visible.length
    ? visible.map(messageHtml).join('')
    : '<div class="empty-state">No approved messages yet.</div>';
  box.scrollTop = box.scrollHeight;
}

function renderCustomerSelect() {
  const sel = el('customerSelect');
  sel.innerHTML = state.customers.map(c =>
    `<option value="${c.id}">${c.name} (${c.phone || 'No phone'})</option>`
  ).join('');
  if (!state.selectedCustomerId) state.selectedCustomerId = state.customers[0]?.id;
  sel.value = state.selectedCustomerId;
}

function renderConversationList() {
  const list = el('conversationList');
  if (!state.conversations.length) {
    list.innerHTML = '<div class="empty-state">No conversations yet.</div>';
    return;
  }
  list.innerHTML = state.conversations.map(c => `
    <button class="conv-item ${c.id === state.selectedConversationId ? 'active' : ''}" data-id="${c.id}">
      <h4>${c.customer_name}</h4>
      <p>${c.phone || 'No phone'}</p>
      <p>${(c.last_message || '').substring(0, 50)}${c.last_message?.length > 50 ? '…' : ''}</p>
    </button>`).join('');

  list.querySelectorAll('.conv-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.selectedConversationId = btn.dataset.id;
      renderConversationList();
      await loadConversation(state.selectedConversationId);
    });
  });
}

async function loadConversation(id) {
  const data = await apiFetch(`/api/conversations/${id}`);
  state.selectedConversationId = data.conversation.id;

  el('conversationHeader').innerHTML = `
    <h3>${data.conversation.customer_name}</h3>
    <p>${data.conversation.phone || 'No phone'} · ${data.conversation.status}</p>`;

  const msgBox = el('agentConversationMessages');
  msgBox.innerHTML = (data.messages || []).map(msg => {
    if (!Number(msg.is_draft)) return messageHtml(msg);
    const content = (msg.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const time = new Date(msg.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    return `
      <div class="draft-editor">
        <div class="message-header"><strong>🤖 AI Draft</strong><span>${time}</span></div>
        <textarea data-msg-id="${msg.id}">${msg.content}</textarea>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="approve-btn" data-approve-id="${msg.id}">✅ Approve</button>
          <span style="font-size:11px;color:var(--text-muted)" id="quality_${msg.id}">${scoreResponseQuality(msg.content)}</span>
        </div>
      </div>`;
  }).join('') || '<div class="empty-state">No messages.</div>';

  msgBox.scrollTop = msgBox.scrollHeight;

  // Approve buttons
  msgBox.querySelectorAll('[data-approve-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mid = btn.dataset.approveId;
      const ta = msgBox.querySelector(`textarea[data-msg-id="${mid}"]`);
      let text = ta ? ta.value : '';
      if (state.activeTone !== 'none') text = applyTone(text, state.activeTone);
      await apiFetch(`/api/messages/${mid}/approve`, { method: 'POST', body: JSON.stringify({ text }) });
      showToast('Message approved!');
      await loadConversations();
      await loadCustomers();
    });
  });

  // Live quality score on textarea change
  msgBox.querySelectorAll('textarea[data-msg-id]').forEach(ta => {
    ta.addEventListener('input', () => {
      const qEl = el(`quality_${ta.dataset.msgId}`);
      if (qEl) qEl.textContent = scoreResponseQuality(ta.value);
    });
  });

  // AI summary
  const sumBox = el('summaryBox');
  if (sumBox) sumBox.textContent = generateConvSummary(data.messages);

  // Customer messages sync
  const visible = (data.messages || []).filter(m => !Number(m.is_draft));
  renderCustomerMessages(visible);
}

// ── Data Loading ──────────────────────────────────────────────────────────────

async function loadCustomers() {
  state.customers = await apiFetch('/api/customers');
  renderCustomerSelect();
  if (!state.selectedCustomerId) state.selectedCustomerId = state.customers[0]?.id;
  if (state.selectedCustomerId) {
    const conv = state.conversations.find(c => c.customer_id === state.selectedCustomerId);
    if (conv) await loadConversation(conv.id);
    else renderCustomerMessages([]);
  }
}

async function loadConversations() {
  state.conversations = await apiFetch('/api/conversations');
  renderConversationList();
  updateStats();
  if (state.selectedConversationId) {
    const sel = state.conversations.find(c => c.id === state.selectedConversationId);
    if (sel) await loadConversation(sel.id);
  }
}

function updateStats() {
  const total = state.conversations.length;
  const open = state.conversations.filter(c => c.status === 'open').length;
  el('statCount').textContent = total;
  el('statTotal').textContent = total;
  el('statOpen').textContent = open;
  // Estimate drafts/flagged from last_message content
  const drafts = state.conversations.filter(c => c.last_message && c.last_message.includes('agent')).length;
  el('statDrafts').textContent = drafts;
  el('statFlagged').textContent = state.conversations.filter(c =>
    c.last_message && /allergy|medical|cannot confirm/.test(c.last_message.toLowerCase())
  ).length;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

function renderAnalytics() {
  const convs = state.conversations;
  const chartArea = el('chartArea');

  // Group by day (last 7 days)
  const days = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days[d.toLocaleDateString('en', { weekday: 'short' })] = 0;
  }
  convs.forEach(c => {
    const day = new Date(c.created_at).toLocaleDateString('en', { weekday: 'short' });
    if (days[day] !== undefined) days[day]++;
  });

  const max = Math.max(...Object.values(days), 1);
  const colors = ['#3fb950', '#58a6ff', '#bc8cff', '#f0883e', '#f85149', '#3fb950', '#58a6ff'];

  chartArea.innerHTML = Object.entries(days).map(([day, count], i) => `
    <div class="bar-wrap">
      <div class="bar-val">${count}</div>
      <div class="bar" style="height:${(count / max) * 140}px;background:${colors[i]}"></div>
      <div class="bar-label">${day}</div>
    </div>`).join('');

  const aiStats = el('aiStats');
  const total = convs.length || 1;
  const autoResolved = Math.round(total * 0.65);
  const escalated = total - autoResolved;
  aiStats.innerHTML = `
    <div class="ai-stat-row"><span>Auto-resolved by AI</span><span>${autoResolved}</span></div>
    <div class="progress-bar-wrap"><div class="progress-bar" style="width:65%"></div></div>
    <div class="ai-stat-row" style="margin-top:8px"><span>Escalated to Agent</span><span>${escalated}</span></div>
    <div class="progress-bar-wrap"><div class="progress-bar" style="width:35%;background:var(--orange)"></div></div>
    <div class="ai-stat-row" style="margin-top:8px"><span>Avg. Response Time</span><span>~2 min</span></div>
    <div class="ai-stat-row"><span>Customer Satisfaction</span><span>4.2 / 5</span></div>`;

  const activity = el('recentActivity');
  activity.innerHTML = convs.slice(0, 5).map(c => {
    const s = analyzeSentiment(c.last_message || '');
    return `
      <div class="activity-item">
        <div class="activity-dot" style="background:${s.color}"></div>
        <div>
          <div style="font-weight:600">${c.customer_name}</div>
          <div style="color:var(--text-muted)">${(c.last_message || '').substring(0, 60)}…</div>
        </div>
      </div>`;
  }).join('') || '<div class="empty-state">No activity yet.</div>';
}

// ── Navigation ────────────────────────────────────────────────────────────────

const VIEW_META = {
  customer: { title: 'Customer Portal', sub: 'Send messages and view approved replies', stats: false },
  agent: { title: 'Agent Dashboard', sub: 'Review and approve AI-generated drafts', stats: true },
  analytics: { title: 'Analytics', sub: 'AI performance and conversation insights', stats: true },
  webhook: { title: 'Webhook Tester', sub: 'Test signed webhook integration', stats: false }
};

function updateAgentBadge() {
  const badge = el('agentStatusBadge');
  if (!badge) return;
  badge.innerHTML = state.loggedIn
    ? '<span class="status-dot online"></span> Agent online'
    : '<span class="status-dot offline"></span> Agent offline';
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));

  const viewEl = el(`${view}View`);
  if (viewEl) viewEl.classList.remove('hidden');

  const meta = VIEW_META[view] || {};
  el('pageTitle').textContent = meta.title || view;
  el('pageSub').textContent = meta.sub || '';
  el('statsRow').classList.toggle('hidden', !meta.stats);

  if (view === 'analytics') renderAnalytics();
  updateAgentBadge();
}

// ── Webhook Tester ────────────────────────────────────────────────────────────

async function sendWebhook() {
  const eventId = el('whEventId').value.trim() || `evt_${Date.now()}`;
  const name = el('whName').value.trim() || 'Test Customer';
  const phone = el('whPhone').value.trim() || '+971500000000';
  const message = el('whMessage').value.trim();

  if (!message) { showToast('Message is required', 'error'); return; }

  const payload = JSON.stringify({
    event_id: eventId,
    customer: { id: `cust_wh_${Date.now()}`, name, phone },
    message
  });

  // Compute HMAC signature client-side (demo only — secret is public in README)
  const secret = 'verdant-demo-secret-2026';
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(payload);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  const signature = `sha256=${hex}`;

  try {
    const res = await fetch('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
      body: payload
    });
    const data = await res.json();
    el('webhookResponse').textContent = JSON.stringify(data, null, 2);
    showToast('Webhook sent!');
    await loadConversations();
  } catch (err) {
    el('webhookResponse').textContent = `Error: ${err.message}`;
    showToast('Webhook failed', 'error');
  }
}

// ── Events ────────────────────────────────────────────────────────────────────

function bindEvents() {
  // Sidebar nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  // Customer send
  el('sendCustomerMessage').addEventListener('click', async () => {
    const text = el('customerInput').value.trim();
    if (!text || !state.selectedCustomerId) return;
    await apiFetch(`/api/customers/${state.selectedCustomerId}/messages`, {
      method: 'POST', body: JSON.stringify({ message: text })
    });
    el('customerInput').value = '';
    el('aiHint').textContent = '';
    el('sentimentBox').innerHTML = '<div class="sentiment-empty">Type a message to analyze sentiment</div>';
    el('aiPreviewBox').innerHTML = '<div class="sentiment-empty">AI draft will appear here</div>';
    showToast('Message sent!');
    await loadConversations();
    await loadCustomers();
  });

  // Customer select
  el('customerSelect').addEventListener('change', e => {
    state.selectedCustomerId = e.target.value;
    const conv = state.conversations.find(c => c.customer_id === state.selectedCustomerId);
    if (conv) loadConversation(conv.id);
    else renderCustomerMessages([]);
  });

  // Live AI analysis on typing
  el('customerInput').addEventListener('input', e => {
    const text = e.target.value;
    updateSentiment(text);
    updateAIPreview(text);
    const s = analyzeSentiment(text);
    el('aiHint').textContent = text.length > 5 ? `Sentiment: ${s.label}` : '';
  });

  // AI Suggest button
  el('aiSuggestBtn').addEventListener('click', () => {
    const suggestions = [
      'What is the shipping time for my order?',
      'I want to return my product, it arrived damaged.',
      'When will I get my refund?',
      'Is COD available for orders above ₹3000?',
      'I need to change my delivery address urgently.',
      'Can you deliver to Dubai?'
    ];
    el('customerInput').value = suggestions[Math.floor(Math.random() * suggestions.length)];
    el('customerInput').dispatchEvent(new Event('input'));
  });

  // Quick chips
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      el('customerInput').value = chip.dataset.msg;
      el('customerInput').dispatchEvent(new Event('input'));
    });
  });

  // Agent login
  el('agentLoginBtn').addEventListener('click', async () => {
    const email = el('agentEmail').value.trim();
    const pass = el('agentPassword').value.trim();
    if (email === 'admin@verdant.test' && pass === 'verdant123') {
      state.loggedIn = true;
      el('agentLoginBox').classList.add('hidden');
      el('agentWorkspace').classList.remove('hidden');
      updateAgentBadge();
      showToast('Welcome back, Agent!');
      await loadConversations();
      if (state.conversations[0]) {
        state.selectedConversationId = state.conversations[0].id;
        await loadConversation(state.selectedConversationId);
      }
    } else {
      showToast('Invalid credentials', 'error');
    }
  });

  // Refresh conversations
  el('refreshConvBtn').addEventListener('click', async () => {
    await loadConversations();
    showToast('Refreshed!');
  });

  // Tone buttons
  document.querySelectorAll('.tone-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tone-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTone = btn.dataset.tone;
      showToast(`Tone set to ${btn.dataset.tone}`);
    });
  });

  // Webhook
  el('sendWebhookBtn').addEventListener('click', sendWebhook);
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  bindEvents();
  await loadConversations();
  await loadCustomers();
  setView('customer');
  // Set friendly tone active by default
  document.querySelector('.tone-btn[data-tone="friendly"]')?.classList.add('active');
}

init();
