---
summary: "Twilio RCS Business Messaging setup, access controls, webhooks, and delivery status"
read_when:
  - You want to connect OpenClaw to RCS Business Messaging through Twilio
  - You need RCS webhook, pairing, media, or receipt setup
title: "RCS"
---

OpenClaw receives and sends RCS Business Messaging through a dedicated Twilio Messaging Service whose sender pool contains an approved RCS sender. The Gateway exposes one signed webhook for inbound messages and delivery/read callbacks, sends only to `rcs:+E164` targets, and persists accepted callbacks before acknowledging them.

Status: official plugin, installed separately. RCS-only text and media, direct messages only. This channel does not route SMS/MMS or request SMS fallback.

## Before you begin

You need:

- The official RCS plugin installed with `openclaw plugins install @openclaw/rcs`.
- A Twilio account with an approved RCS Business Messaging sender.
- A dedicated Twilio Messaging Service containing that sender.
- The Twilio Account SID, Auth Token, and Messaging Service SID.
- A public HTTPS URL that reaches the Gateway.
- An RCS-capable, provider-approved test device or launched sender for carrier testing.

## Quick setup

<Steps>
  <Step title="Install the plugin">

```bash
openclaw plugins install @openclaw/rcs
```

  </Step>
  <Step title="Create a dedicated RCS Messaging Service">
    In Twilio, create a Messaging Service and add the approved RCS sender to its sender pool. Save:

    - Account SID, for example `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
    - Auth Token
    - Messaging Service SID, for example `MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

    Configure the service's **Inbound Request URL** as your exact public RCS URL, use HTTP `POST`, and disable **Use Inbound Webhook on Number**. Do not share this service or webhook with the SMS channel.

  </Step>
  <Step title="Configure the RCS channel">

Save this as `rcs.patch.json5` and replace the placeholders:

```json5
{
  channels: {
    rcs: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio-auth-token",
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
      dmPolicy: "pairing",
    },
  },
}
```

Apply it:

```bash
openclaw config patch --file ./rcs.patch.json5 --dry-run
openclaw config patch --file ./rcs.patch.json5
```

  </Step>
  <Step title="Approve the first sender">
    Start the Gateway, then send an RCS message from the approved test device. The first message creates a pairing request:

```bash
openclaw pairing list rcs
openclaw pairing approve rcs <CODE>
```

    Pairing codes expire after 1 hour.

  </Step>
</Steps>

## Configuration

All keys live under `channels.rcs` or `channels.rcs.accounts.<id>`:

| Key                                     | Default         | Purpose                                                      |
| --------------------------------------- | --------------- | ------------------------------------------------------------ |
| `enabled`                               | `true`          | Enable or disable the channel/account.                       |
| `accountSid`                            | —               | Twilio Account SID (`AC...`).                                |
| `authToken`                             | —               | Twilio Auth Token; plaintext string or SecretRef.            |
| `messagingServiceSid`                   | —               | Dedicated RCS Messaging Service SID (`MG...`).               |
| `webhookPath`                           | `/webhooks/rcs` | Gateway path for inbound messages and callbacks.             |
| `publicWebhookUrl`                      | —               | Exact public URL configured on the Twilio Messaging Service. |
| `dangerouslyDisableSignatureValidation` | `false`         | Skip signatures; local testing only.                         |
| `dmPolicy`                              | `"pairing"`     | `pairing`, `allowlist`, `open`, or `disabled`.               |
| `allowFrom`                             | `[]`            | E.164 senders, or `"*"` when policy is open.                 |
| `accounts`, `defaultAccount`            | —               | Multi-account map and default account id.                    |

### Environment variables

Environment variables apply to the default account only; config values take precedence:

| Variable                           | Maps to                       |
| ---------------------------------- | ----------------------------- |
| `TWILIO_ACCOUNT_SID`               | `accountSid`                  |
| `TWILIO_AUTH_TOKEN`                | `authToken`                   |
| `TWILIO_RCS_MESSAGING_SERVICE_SID` | `messagingServiceSid`         |
| `RCS_PUBLIC_WEBHOOK_URL`           | `publicWebhookUrl`            |
| `RCS_WEBHOOK_PATH`                 | `webhookPath`                 |
| `RCS_ALLOWED_USERS`                | `allowFrom` (comma-separated) |

### SecretRef

`authToken` accepts a SecretRef:

```json5
{
  channels: {
    rcs: {
      enabled: true,
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: { source: "env", provider: "default", id: "TWILIO_AUTH_TOKEN" },
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
      dmPolicy: "pairing",
    },
  },
}
```

The referenced secret must be available to the Gateway runtime.

### Multi-account

Put each account under `channels.rcs.accounts.<id>`, give it a distinct `webhookPath`, and configure the matching `publicWebhookUrl` on its dedicated Twilio Messaging Service.

## Sending RCS

Targets must be E.164 numbers. OpenClaw always forces the provider destination to `rcs:+E164` and sends through the configured Messaging Service:

```bash
openclaw message send --channel rcs --target rcs:+15551234567 --message "hello"
```

Text is converted to readable plain text and split at Twilio's 1,600-character body limit. Media sends use public HTTP(S) URLs. Cards, suggested actions, direct sender mode, and SMS/MMS fallback are not part of this release.

## Delivery and read observations

Outbound sends register each returned Twilio `MessageSid` before status callbacks are accepted. Signed callbacks for unknown message SIDs are ignored, preventing another service in the same Twilio account from changing RCS state.

Recorded observations are bounded, persist in OpenClaw's shared SQLite plugin state, and progress monotonically through `accepted → sent → delivered → read`. A late `sent` callback cannot replace `delivered` or `read`. The same webhook path handles inbound messages and status callbacks.

Inspect the channel:

```bash
openclaw channels capabilities --channel rcs
openclaw channels status --channel rcs --probe --json
```

## Webhook security and durability

OpenClaw validates `X-Twilio-Signature` using the exact public URL and Auth Token. Query bytes are preserved for signature computation; Twilio connection-override fragments are excluded. Keep `publicWebhookUrl` aligned with Twilio, including scheme, host, path, and query.

For webhook callbacks, OpenClaw:

- verifies the signature before classification;
- requires the configured `AccountSid`;
- requires RCS-shaped `From` and `To` addresses for inbound messages;
- requires the configured Messaging Service identity on every inbound message callback;
- resolves client IPs through the Gateway trusted-proxy policy;
- limits inbound admission to 30 callbacks per minute per validated sender and 300 per minute per account route, returning 429 before durable admission when either budget is exhausted;
- commits inbound messages or receipt observations before returning 2xx;
- returns a retryable failure if durable storage is unavailable;
- deduplicates retries by Twilio message SID and resumes queued ingress after restart;
- downloads authenticated inbound media to bounded local files before the agent turn;
- redacts Twilio credentials from surfaced provider errors.

Set `dangerouslyDisableSignatureValidation: true` only for local tests. Never expose an unsigned RCS webhook publicly.

## Troubleshooting

### Signature validation fails

Compare `publicWebhookUrl` with Twilio's Inbound Request URL byte for byte. Check proxy host/protocol rewriting and query strings.

### Inbound messages do not arrive

Confirm the Messaging Service contains the approved RCS sender, uses the RCS webhook with HTTP `POST`, and does not use the sender-level inbound webhook.

### Outbound sends fail

Confirm `accountSid`, `authToken`, and `messagingServiceSid` belong to the same Twilio account. The destination must be `rcs:+E164` and the device must be approved for the sender or reachable by a launched sender.

### SMS payloads are rejected

This is intentional. Configure the separate [SMS channel](/channels/sms) for SMS/MMS. RCS does not own or proxy SMS routes.

## Limits

- Twilio RCS Business Messaging is the only provider in this release.
- Text and simple media are supported; rich cards and native controls are deferred.
- There is no automatic SMS/MMS fallback.
- Final carrier/UI interoperability requires a Twilio-approved RCS sender and test device.
