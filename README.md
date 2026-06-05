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

## Task Types

The server enqueues JSON tasks to the Redis list `argus:tasks`. Each task has a `type` field:

| Type                    | Trigger                                      | Key Fields                                      |
|-------------------------|----------------------------------------------|-------------------------------------------------|
| `issue_opened`          | GitHub issue opened                          | `repo`, `issue_number`, `title`, `body`, `labels`, `url` |
| `issue_labeled`         | GitHub issue labeled (agent/complexity/escalate) | `repo`, `issue_number`, `title`, `label`       |
| `pr_opened`             | GitHub pull request opened                   | `repo`, `pr_number`, `title`, `branch`, `base_branch`, `url` |
| `ci_failed`             | GitHub check run failure                     | `repo`, `check_name`, `branch`                  |
| `push_to_main`          | Push to `main` branch                        | `repo`, `commits` (array of `{id, message}`)    |
| `user_command`          | Telegram message from configured chat        | `text`, `message_id`, `chat_id`                 |

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
- Task building for all event types (issues, PRs, CI, push)
- Telegram webhook chat ID filtering
- `pr_opened` tasks include `base_branch` field
