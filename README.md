# OpenClaw RCS channel

[![OpenClaw](https://img.shields.io/badge/OpenClaw-plugin-6f42c1)](https://github.com/openclaw/openclaw)
[![Twilio](https://img.shields.io/badge/Twilio-RCS-F22F46)](https://www.twilio.com/docs/rcs)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Community distribution repository for the Twilio RCS Business Messaging channel
proposed in [openclaw/openclaw#105025](https://github.com/openclaw/openclaw/pull/105025).

## Status

- Source synchronized to reviewed PR head `4dd5832e90fbbbdf9e169722cc0a169a1db07300`
  on 2026-08-16.
- The upstream implementation has no current actionable or security findings;
  its focused RCS suite passes 63 tests and hosted CI is green apart from the
  expected dependency-approval gate.
- The upstream PR still needs a maintainer distribution decision and a redacted
  approved-sender/device carrier round trip.
- This repository is the community source for the ClawHub package
  `clawSean/rcs`. It is not published to npm.

The implementation remains synchronized with the reviewed upstream proposal;
only community distribution metadata differs.

## What it does

- Sends RCS-only text and media through a dedicated Twilio Messaging Service.
- Receives signed Twilio callbacks through a public HTTPS webhook.
- Persists accepted inbound callbacks before acknowledging them.
- Supports pairing, allowlists, multi-account configuration, and durable replay.
- Publishes Gateway lifecycle state and monotonic delivery/read observations.
- Rejects callbacks whose Account SID or Messaging Service SID does not match
  the configured account.

## Requirements

- OpenClaw `2026.8.1` or newer
- A Twilio account with an approved RCS sender
- A dedicated Twilio Messaging Service containing that sender
- A public HTTPS webhook URL reaching the OpenClaw Gateway

## Configuration

Install the community package through OpenClaw's plugin manager:

```bash
openclaw plugins install clawhub:clawSean/rcs
```

The complete setup guide is in [docs/rcs.md](docs/rcs.md).

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

## Development and verification

This source is synchronized from `extensions/rcs` in the OpenClaw monorepo. The
full suite runs from an OpenClaw checkout:

```bash
pnpm test:extension rcs
```

The repository ships compiled JavaScript in `dist/` for ClawHub installation,
but intentionally does not vendor OpenClaw's test harness or duplicate the
monorepo lockfile. See the upstream PR for exact-head CI, package-runtime, and
isolated Gateway proof.

## Provenance

- Upstream PR: [openclaw/openclaw#105025](https://github.com/openclaw/openclaw/pull/105025)
- Distribution decision: [openclaw/openclaw#105710](https://github.com/openclaw/openclaw/issues/105710)
- Synchronized head: [`4dd5832e90f`](https://github.com/openclaw/openclaw/commit/4dd5832e90fbbbdf9e169722cc0a169a1db07300)

## License

MIT — see [LICENSE](LICENSE).
