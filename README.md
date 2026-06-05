# Argus Railway

Webhook relay server for the Argus autonomous PM system. Receives GitHub and Telegram webhooks, validates them, and enqueues structured tasks into a Redis queue for downstream processing.

## Architecture

```
GitHub webhook ─┐
                ├──→ Argus Railway (Express) ──→ Redis (argus:tasks) ──→ Orchestrator workers
Telegram webhook┘
```

## Endpoints

| Method | Path                | Description                                      |
|--------|---------------------|--------------------------------------------------|
| GET    | `/health`           | Health check — returns `{ status: "ok", ts }`    |
| POST   | `/webhook/github`   | Accepts GitHub webhooks, validates HMAC signature |
| POST   | `/webhook/telegram` | Accepts Telegram updates, filters by chat ID     |

## Environment Variables

| Variable               | Required | Description                                      |
|------------------------|----------|--------------------------------------------------|
| `PORT`                 | No       | HTTP port (default: `3000`)                      |
| `REDIS_URL`            | Yes      | Redis connection string (e.g. `redis://...`)     |
| `GITHUB_WEBHOOK_SECRET`| No       | HMAC secret for GitHub webhook signature verification |
| `TELEGRAM_CHAT_ID`     | No       | Allowed Telegram chat ID for incoming commands    |
| `TELEGRAM_BOT_TOKEN`   | No       | Telegram bot token for sending acknowledgment messages |

## Task Types

The server enqueues JSON tasks to the Redis list `argus:tasks`. Each task has a `type` field:

| Type                    | Trigger                                      | Key Fields                                      |
|-------------------------|----------------------------------------------|-------------------------------------------------|
| `issue_opened`          | GitHub issue opened                          | `repo`, `issue_number`, `title`, `body`, `labels`, `url` |
| `issue_labeled`         | GitHub issue labeled (agent/complexity/escalate) | `repo`, `issue_number`, `title`, `label`       |
| `pr_opened`             | GitHub pull request opened                   | `repo`, `pr_number`, `title`, `branch`, `base_branch`, `url` |
| `pr_merged`             | GitHub pull request merged                   | `repo`, `pr_number`, `title`, `branch`, `url`  |
| `pr_changes_requested`  | PR review with changes requested             | `repo`, `pr_number`, `title`, `branch`, `url`, `reviewer`, `review_body` |
| `pr_approved`           | PR review approved                           | `repo`, `pr_number`, `title`, `url`, `reviewer` |
| `ci_failed`             | GitHub check run failure                     | `repo`, `check_name`, `branch`                  |
| `push_to_main`          | Push to `main` branch                        | `repo`, `commits` (array of `{id, message}`)    |
| `user_command`          | Telegram message from configured chat        | `text`, `message_id`, `chat_id`                 |

## Telegram Acknowledgment

When a Telegram command is received from the configured chat, the server sends an immediate acknowledgment before enqueuing the task:

| Command pattern         | Acknowledgment                               |
|-------------------------|----------------------------------------------|
| `assign <ref>`          | 🚀 Assigning `<ref>`... I'm on it            |
| `status` / `status?`    | 🔍 Checking status...                        |
| `stop`                  | 🛑 Stop command received. Halting.           |
| Any other               | ⚙️ Got it: `<text>` Processing...            |

## Development

```bash
# Install dependencies
npm install

# Start with file watching
npm run dev

# Run tests
npm test
```

## Deployment

Deployed on Railway. The Dockerfile uses `npm ci --omit=dev` for a lean production image.

```bash
# Build locally
docker build -t argus-railway .
docker run -p 3000:3000 -e REDIS_URL=redis://... argus-railway
```

## Testing

Tests use Jest and Supertest. The Express app is exported as a module so tests can run without binding to a port.

```bash
npm test
```

Coverage includes:
- Health endpoint returns OK
- GitHub webhook signature validation (missing, invalid, valid)
- Task building for all event types (`issue_opened`, `pr_opened` with `base_branch`)
- Telegram webhook chat ID filtering (ignores wrong chat, accepts configured chat)
- `pr_opened` tasks include `base_branch` field
