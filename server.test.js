const crypto = require('crypto');
const request = require('supertest');
const { app, buildGithubTask } = require('./server');

function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret)
    .update(JSON.stringify(body))
    .digest('hex');
}

describe('Argus webhook relay', () => {
  const originalEnv = process.env;
  let enqueued;

  beforeEach(() => {
    process.env = { ...originalEnv };
    enqueued = [];
    app.locals.enqueue = (task) => enqueued.push(task);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.ts).toBeDefined();
  });

  it('rejects GitHub webhook without signature when secret is set', async () => {
    process.env.GITHUB_WEBHOOK_SECRET = 'secret';

    const res = await request(app)
      .post('/webhook/github')
      .set('x-github-event', 'issues')
      .send({ repository: { full_name: 'fatoh2/test' }, action: 'opened', issue: { number: 1, title: 'Bug' } });

    expect(res.status).toBe(401);
    expect(enqueued).toHaveLength(0);
  });

  it('rejects GitHub webhook with invalid signature', async () => {
    process.env.GITHUB_WEBHOOK_SECRET = 'secret';

    const res = await request(app)
      .post('/webhook/github')
      .set('x-github-event', 'issues')
      .set('x-hub-signature-256', 'sha256=bad')
      .send({ repository: { full_name: 'fatoh2/test' }, action: 'opened', issue: { number: 1, title: 'Bug' } });

    expect(res.status).toBe(401);
    expect(enqueued).toHaveLength(0);
  });

  it('accepts GitHub webhook with valid signature and enqueues task', async () => {
    process.env.GITHUB_WEBHOOK_SECRET = 'secret';
    const body = {
      repository: { full_name: 'fatoh2/test' },
      action: 'opened',
      issue: { number: 1, title: 'Bug', body: 'details', labels: [], html_url: 'https://example.test/issue/1' },
    };

    const res = await request(app)
      .post('/webhook/github')
      .set('x-github-event', 'issues')
      .set('x-hub-signature-256', sign(body, 'secret'))
      .send(body);

    expect(res.status).toBe(200);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ type: 'issue_opened', repo: 'fatoh2/test', issue_number: 1 });
  });

  it('buildGithubTask creates issue_opened tasks', () => {
    const task = buildGithubTask('issues', {
      action: 'opened',
      issue: { number: 2, title: 'Fix me', body: '', labels: [{ name: 'agent:ai' }], html_url: 'https://example.test/2' },
    }, 'fatoh2/test');

    expect(task).toMatchObject({
      type: 'issue_opened',
      repo: 'fatoh2/test',
      issue_number: 2,
      title: 'Fix me',
      labels: ['agent:ai'],
      url: 'https://example.test/2',
    });
  });

  it('buildGithubTask creates pr_opened tasks with base branch', () => {
    const task = buildGithubTask('pull_request', {
      action: 'opened',
      pull_request: {
        number: 3,
        title: 'Add feature',
        head: { ref: 'feature/x' },
        base: { ref: 'main' },
        html_url: 'https://example.test/pr/3',
      },
    }, 'fatoh2/test');

    expect(task).toMatchObject({
      type: 'pr_opened',
      repo: 'fatoh2/test',
      pr_number: 3,
      title: 'Add feature',
      branch: 'feature/x',
      base_branch: 'main',
      url: 'https://example.test/pr/3',
    });
  });

  it('Telegram webhook ignores wrong chat ID', async () => {
    process.env.TELEGRAM_CHAT_ID = '123';

    const res = await request(app)
      .post('/webhook/telegram')
      .send({ message: { chat: { id: 999 }, text: 'status', message_id: 10 } });

    expect(res.status).toBe(200);
    expect(enqueued).toHaveLength(0);
  });

  it('Telegram webhook accepts configured chat ID', async () => {
    process.env.TELEGRAM_CHAT_ID = '123';

    const res = await request(app)
      .post('/webhook/telegram')
      .send({ message: { chat: { id: 123 }, text: 'status', message_id: 10 } });

    expect(res.status).toBe(200);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ type: 'user_command', text: 'status', chat_id: 123, message_id: 10 });
  });
});
