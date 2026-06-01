// Argus — Railway Webhook Server

process.on('uncaughtException', err => { console.error('UNCAUGHT:', err.message, err.stack); });
process.on('unhandledRejection', err => { console.error('UNHANDLED:', err); });

const express = require('express');
const crypto  = require('crypto');

const app = express();
app.use(express.json());

// Lazy Redis — only connect on first use, never crash startup
let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  const Redis = require('ioredis');
  _redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    retryStrategy: (t) => Math.min(t * 300, 3000),
    enableOfflineQueue: true,
  });
  _redis.on('connect', () => console.log('[redis] connected'));
  _redis.on('error',   (e) => console.error('[redis] error:', e.message));
  return _redis;
}

function enqueue(task) {
  getRedis().lpush('argus:tasks', JSON.stringify(task)).catch(e =>
    console.error('[redis] enqueue failed:', e.message)
  );
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── GitHub webhook ────────────────────────────────────────────────────────────
app.post('/webhook/github', (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers['x-hub-signature-256'];
    if (!sig) return res.status(401).json({ error: 'missing signature' });
    const expected = 'sha256=' + crypto.createHmac('sha256', secret)
      .update(JSON.stringify(req.body)).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
      return res.status(401).json({ error: 'invalid signature' });
  }

  const event = req.headers['x-github-event'];
  const repo  = req.body.repository?.full_name || 'unknown';
  const task  = buildGithubTask(event, req.body, repo);

  if (task) {
    enqueue(task);
    console.log(`[github] queued ${task.type} from ${repo}`);
  }
  res.status(200).json({ ok: true });
});

// ── Telegram helpers ──────────────────────────────────────────────────────────
async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch (e) {
    console.error('[telegram] send failed:', e.message);
  }
}

function ackMessage(text, chatId) {
  const t = text.toLowerCase().trim();
  if (t.startsWith('assign ')) {
    const ref = text.slice(7).trim();
    return sendTelegram(chatId, `🚀 *Assigning ${ref}...*\nI'm on it — you'll get an update when it's done.`);
  }
  if (t === 'status' || t === 'status?') {
    return sendTelegram(chatId, `🔍 *Checking status...*\nFetching latest sprint progress.`);
  }
  if (t.startsWith('stop')) {
    return sendTelegram(chatId, `🛑 *Stop command received.* Halting current task.`);
  }
  // Generic ack for any other command
  return sendTelegram(chatId, `⚙️ *Got it:* \`${text}\`\nProcessing...`);
}

// ── Telegram webhook ──────────────────────────────────────────────────────────
app.post('/webhook/telegram', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(200).json({ ok: true });
  if (String(message.chat?.id) !== String(process.env.TELEGRAM_CHAT_ID))
    return res.status(200).json({ ok: true });

  const text = (message.text || '').trim();
  const chatId = message.chat.id;

  // Send immediate acknowledgment
  await ackMessage(text, chatId);

  const task = {
    type:       'user_command',
    text,
    message_id: message.message_id,
    chat_id:    chatId,
    timestamp:  new Date().toISOString(),
  };
  enqueue(task);
  console.log(`[telegram] queued: ${text}`);
  res.status(200).json({ ok: true });
});

// ── GitHub task builder ───────────────────────────────────────────────────────
function buildGithubTask(event, payload, repo) {
  if (event === 'issues' && payload.action === 'opened')
    return { type: 'issue_opened', repo, issue_number: payload.issue.number,
      title: payload.issue.title, body: payload.issue.body || '',
      labels: (payload.issue.labels || []).map(l => l.name),
      url: payload.issue.html_url, timestamp: new Date().toISOString() };

  if (event === 'issues' && payload.action === 'labeled') {
    const label = payload.label?.name || '';
    if (label.startsWith('agent:') || label.startsWith('complexity:') || label.startsWith('escalate:'))
      return { type: 'issue_labeled', repo, issue_number: payload.issue.number,
        title: payload.issue.title, label, timestamp: new Date().toISOString() };
  }

  if (event === 'pull_request' && payload.action === 'opened')
    return { type: 'pr_opened', repo, pr_number: payload.pull_request.number,
      title: payload.pull_request.title, branch: payload.pull_request.head.ref,
      base_branch: payload.pull_request.base.ref,
      url: payload.pull_request.html_url, timestamp: new Date().toISOString() };

  // PR merged → close linked issue
  if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request.merged) {
    return { type: 'pr_merged', repo, pr_number: payload.pull_request.number,
      title: payload.pull_request.title, branch: payload.pull_request.head.ref,
      url: payload.pull_request.html_url, timestamp: new Date().toISOString() };
  }

  // Review submitted → if REQUEST_CHANGES, agent must fix
  if (event === 'pull_request_review' && payload.action === 'submitted') {
    const state = payload.review?.state;
    if (state === 'changes_requested') {
      return { type: 'pr_changes_requested', repo,
        pr_number: payload.pull_request.number,
        title: payload.pull_request.title,
        branch: payload.pull_request.head.ref,
        url: payload.pull_request.html_url,
        reviewer: payload.review.user.login,
        review_body: payload.review.body || '',
        timestamp: new Date().toISOString() };
    }
    if (state === 'approved') {
      return { type: 'pr_approved', repo,
        pr_number: payload.pull_request.number,
        title: payload.pull_request.title,
        url: payload.pull_request.html_url,
        reviewer: payload.review.user.login,
        timestamp: new Date().toISOString() };
    }
  }

  if (event === 'check_run' && payload.action === 'completed' && payload.check_run.conclusion === 'failure')
    return { type: 'ci_failed', repo, check_name: payload.check_run.name,
      branch: payload.check_run.check_suite?.head_branch,
      timestamp: new Date().toISOString() };

  if (event === 'push' && payload.ref === 'refs/heads/main')
    return { type: 'push_to_main', repo,
      commits: (payload.commits || []).map(c => ({ id: c.id.slice(0,7), message: c.message.split('\n')[0] })),
      timestamp: new Date().toISOString() };

  return null;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Argus webhook server listening on port ${PORT}`));
