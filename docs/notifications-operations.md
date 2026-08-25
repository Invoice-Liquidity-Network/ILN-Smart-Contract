# Notifications Service Operations & Credential Rotation Runbook

This guide covers operational procedures for the `@iln/notifications` service, specifically credential rotation for Slack Incoming Webhooks and Telegram Bot Tokens, configuration management, and service redeploy requirements.

---

## 1. Overview & Security Context

The `@iln/notifications` service delivers invoice lifecycle notifications across multiple channels: Webhooks, Slack, Telegram, and Email.

### Why Credential Rotation is Critical
- **Slack Incoming Webhooks**: If an incoming webhook URL is leaked or compromised, an attacker can send spoofed messages or malicious links directly into internal team or community channels.
- **Telegram Bot Tokens**: If a bot token is compromised, unauthorized actors can send messages, alter bot metadata, intercept updates, or impersonate the ILN protocol.

---

## 2. Slack Webhook Rotation Procedure

### When to Rotate
- Scheduled periodic rotation (recommended every 90 days).
- Personnel offboarding with access to Slack app settings.
- Suspected or confirmed credential compromise/leakage.

### Step-by-Step Rotation

#### Step 1: Generate a New Webhook in Slack
1. Open the [Slack App Management Console](https://api.slack.com/apps).
2. Select your ILN Notifications Slack app.
3. Navigate to **Incoming Webhooks** under Features.
4. Click **Add New Webhook to Workspace** and select the destination channel.
5. Copy the newly generated Webhook URL (format: `https://hooks.slack.com/services/T000/B000/XXXX`).

#### Step 2: Register the New Webhook Subscription
Register the new webhook URL with `@iln/notifications`:

```bash
curl -X POST http://localhost:3001/subscriptions/slack \
  -H "content-type: application/json" \
  -d '{
    "url": "https://hooks.slack.com/services/T000/B000/NEW_WEBHOOK_URL",
    "eventTypes": [
      "invoice.submitted",
      "invoice.funded",
      "invoice.paid",
      "invoice.expiring_soon"
    ]
  }'
```

The service will respond with the newly created subscription:
```json
{
  "id": "slk_m1abc_1",
  "url": "https://hooks.slack.com/services/T000/B000/NEW_WEBHOOK_URL",
  "eventTypes": ["invoice.submitted", "invoice.funded", "invoice.paid", "invoice.expiring_soon"]
}
```

#### Step 3: Verify Notification Delivery
Trigger a test notification to confirm the new webhook is operational:

```bash
curl -X POST http://localhost:3001/notify/slack \
  -H "content-type: application/json" \
  -d '{
    "type": "invoice.submitted",
    "invoiceId": 9999,
    "token": "USDC",
    "amount": "100000000",
    "dueDate": 1735689600
  }'
```

Verify that the message appears formatted correctly in the Slack channel.

#### Step 4: Remove the Old Subscription
1. List all active Slack subscriptions to locate the previous subscription ID:
   ```bash
   curl http://localhost:3001/subscriptions/slack
   ```
2. Delete the old subscription:
   ```bash
   curl -X DELETE http://localhost:3001/subscriptions/slack/slk_OLD_ID
   ```

#### Step 5: Invalidate the Old Webhook in Slack
Return to the Slack App Management Console under **Incoming Webhooks**, find the old webhook URL, and click **Revoke** / **Delete**.

---

## 3. Telegram Bot Token Rotation Procedure

### When to Rotate
- Scheduled periodic rotation (recommended every 90 days).
- Team member offboarding with access to Telegram bot tokens.
- Suspected compromise or accidental public exposure in logs or code.

### Step-by-Step Rotation

#### Step 1: Revoke and Re-issue Token via `@BotFather`
1. In the Telegram client, open a direct chat with [`@BotFather`](https://t.me/BotFather).
2. Send the command `/mybots` and select your notifications bot.
3. Select **API Token**.
4. Click **Revoke current token** (or send `/revoke`).
5. `@BotFather` will immediately invalidate the previous token and issue a new bot token (format: `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`).

#### Step 2: Register the New Telegram Subscription
Register the new subscription with the new bot token and destination chat ID:

```bash
curl -X POST http://localhost:3001/subscriptions/telegram \
  -H "content-type: application/json" \
  -d '{
    "botToken": "123456789:NEW_BOT_TOKEN",
    "chatId": "-1001234567890",
    "eventTypes": [
      "invoice.submitted",
      "invoice.funded",
      "invoice.paid",
      "invoice.expiring_soon",
      "invoice.disputed"
    ]
  }'
```

The response confirms the new subscription ID:
```json
{
  "id": "tg_m1abc_1",
  "botToken": "123456789:NEW_BOT_TOKEN",
  "chatId": "-1001234567890",
  "eventTypes": ["invoice.submitted", "invoice.funded", "invoice.paid", "invoice.expiring_soon", "invoice.disputed"]
}
```

#### Step 3: Verify Delivery
Trigger a test notification:

```bash
curl -X POST http://localhost:3001/notify/telegram \
  -H "content-type: application/json" \
  -d '{
    "type": "invoice.submitted",
    "invoiceId": 9999,
    "token": "USDC",
    "amount": "100000000",
    "dueDate": 1735689600
  }'
```

Verify that the message appears in the Telegram channel/group.

#### Step 4: Remove the Old Subscription
Delete the stale subscription:
```bash
curl -X DELETE http://localhost:3001/subscriptions/telegram/tg_OLD_ID
```

---

## 4. Configuration Reload & Redeploy Behavior

An audit of `src/config.ts` and the notification routers reveals distinct operational lifecycles for different types of configuration:

### Static Service Configuration (`src/config.ts`)
`src/config.ts` reads environment variables at module evaluation time:
- `PORT`
- `NOTIFICATIONS_DB_PATH`
- `NOTIFICATIONS_PUBLIC_URL`
- `EMAIL_FROM`
- `EMAIL_TOKEN_SECRET`
- `RESEND_API_KEY`

**Redeploy Requirement**:
Because these variables are evaluated once on application startup, **hot-reload is not supported** for `config.ts` values. Any update to these environment variables requires a process restart or container redeploy:
```bash
# Docker / Docker Compose
docker compose restart notifications

# Kubernetes
kubectl rollout restart deployment/iln-notifications

# Systemd / PM2
systemctl restart iln-notifications
# or
pm2 restart iln-notifications
```

### Dynamic Delivery Subscriptions (Slack & Telegram)
In contrast, Slack and Telegram delivery credentials and destinations are managed dynamically through their REST API routers (`src/api/slack.ts` and `src/api/telegram.ts`):
- **Hot-Reload Supported**: Adding a new subscription (`POST /subscriptions/...`) or removing an old subscription (`DELETE /subscriptions/.../:id`) updates the runtime store immediately.
- **Zero Downtime**: Credential rotation for Slack and Telegram is fully hot-applied without restarting the service or interrupting in-flight deliveries.

---

## 5. Emergency Incident Response Checklist

In the event of an active credential leak or unauthorized message broadcast:

1. **Immediate Revocation**:
   - **Slack**: Immediately delete the incoming webhook in Slack App Console.
   - **Telegram**: Send `/revoke` to `@BotFather` to immediately invalidate the token.
2. **Purge Subscriptions**:
   - Delete the compromised subscription ID via `DELETE /subscriptions/slack/:id` or `DELETE /subscriptions/telegram/:id`.
3. **Issue & Register Replacement**:
   - Follow the rotation procedures above to register new credentials.
4. **Audit Logs & Channels**:
   - Inspect delivery history and channel messages for any unauthorized activity.
   - Post an advisory in community channels if unauthorized messages were delivered.
5. **Post-Mortem**:
   - Document root cause (e.g., exposed commit, logs, misconfigured CI) and apply preventive measures.
