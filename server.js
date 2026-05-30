// Argus — Railway Webhook Server
// Receives GitHub webhooks and Telegram messages, pushes tasks to Redis queue.

const express = require('express');
const crypto = require('crypto');
const Redis = require('ioredis');

const app = express();
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true });
redis.connect().catch(err => console.error('Redis connect error:', err));

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── GitHub webhook ────────────────────────────────────────────────────────────
app.post('/webhook/github', (req, res) => {
  if (!verifyGithubSig(req)) {
    console.warn('Invalid GitHub webhook signature');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const event = req.headers['x-github-event'];
  const payload = req.body;
  const repo = payload.repository?.full_name || 'unknown';

  const task = buildGithubTask(event, payload, repo);
  if (task) {
    enqueue(task);
    console.log(`[github] queued ${task.type} from ${repo}`);
  } else {
    console.log(`[github] ignored ${event} from ${repo}`);
  }

  res.status(200).json({ ok: true });
});

// ── Telegram webhook (messages FROM you) ──────────────────────────────────────
app.post('/webhook/telegram', (req, res) => {
  const { message } = req.body;

  if (!message) return res.status(200).json({ ok: true });

  // Only accept messages from your chat ID
  if (String(message.chat?.id) !== String(TELEGRAM_CHAT_ID)) {
    console.warn(`[telegram] ignored message from unknown chat ${message.chat?.id}`);
    return res.status(200).json({ ok: true });
  }

  const text = message.text || '';
  const task = {
    type: 'user_command',
    text: text.trim(),
    message_id: message.message_id,
    chat_id: message.chat.id,
    timestamp: new Date().toISOString(),
  };

  enqueue(task);
  console.log(`[telegram] queued user command: ${text}`);
  res.status(200).json({ ok: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function verifyGithubSig(req) {
  if (!WEBHOOK_SECRET) return true; // dev mode
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
}

function enqueue(task) {
  redis.lpush('argus:tasks', JSON.stringify(task)).catch(err =>
    console.error('Redis enqueue error:', err)
  );
}

function buildGithubTask(event, payload, repo) {
  // New issue opened
  if (event === 'issues' && payload.action === 'opened') {
    return {
      type: 'issue_opened',
      repo,
      issue_number: payload.issue.number,
      title: payload.issue.title,
      body: payload.issue.body || '',
      labels: (payload.issue.labels || []).map(l => l.name),
      author: payload.issue.user.login,
      url: payload.issue.html_url,
      timestamp: new Date().toISOString(),
    };
  }

  // Label added to issue — triggers routing
  if (event === 'issues' && payload.action === 'labeled') {
    const label = payload.label?.name || '';
    if (label.startsWith('agent:') || label.startsWith('complexity:') || label.startsWith('escalate:')) {
      return {
        type: 'issue_labeled',
        repo,
        issue_number: payload.issue.number,
        title: payload.issue.title,
        body: payload.issue.body || '',
        label,
        all_labels: (payload.issue.labels || []).map(l => l.name),
        url: payload.issue.html_url,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // PR opened — trigger review
  if (event === 'pull_request' && payload.action === 'opened') {
    return {
      type: 'pr_opened',
      repo,
      pr_number: payload.pull_request.number,
      title: payload.pull_request.title,
      body: payload.pull_request.body || '',
      branch: payload.pull_request.head.ref,
      base_branch: payload.pull_request.base.ref,
      author: payload.pull_request.user.login,
      url: payload.pull_request.html_url,
      diff_url: payload.pull_request.diff_url,
      timestamp: new Date().toISOString(),
    };
  }

  // CI check failed
  if (event === 'check_run' && payload.action === 'completed') {
    if (payload.check_run.conclusion === 'failure') {
      return {
        type: 'ci_failed',
        repo,
        check_name: payload.check_run.name,
        branch: payload.check_run.check_suite?.head_branch || 'unknown',
        details_url: payload.check_run.details_url,
        commit_sha: payload.check_run.head_sha,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Push to main — trigger docs update
  if (event === 'push' && payload.ref === 'refs/heads/main') {
    return {
      type: 'push_to_main',
      repo,
      pusher: payload.pusher?.name || 'unknown',
      commits: (payload.commits || []).map(c => ({
        id: c.id.slice(0, 7),
        message: c.message.split('\n')[0],
      })),
      timestamp: new Date().toISOString(),
    };
  }

  return null;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Argus webhook server listening on port ${PORT}`);
});
