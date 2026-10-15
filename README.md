# OpenClaw RCS for Business

<p align="center">
  <img src="assets/icon.png" alt="OpenClaw RCS conversation-claw icon" width="180" />
</p>

[![ClawHub](https://img.shields.io/badge/ClawHub-clawsean%2Frcs-EA4AAA)](https://clawhub.ai/clawsean/plugins/rcs)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-channel_plugin-6f42c1)](https://github.com/openclaw/openclaw)
[![Twilio](https://img.shields.io/badge/Twilio-RCS_Business_Messaging-F22F46)](https://www.twilio.com/docs/rcs)
[![Tests](https://img.shields.io/badge/RCS_tests-63_passing-brightgreen)](#what-has-been-verified)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Give an OpenClaw agent a dedicated **RCS Business Messaging** channel for
professional customer conversations: two-way text and media, sender-aware
access control, durable webhooks, and delivery/read visibility.

The plugin connects OpenClaw to a Twilio Messaging Service containing an
approved RCS sender. Twilio, Google, and carrier approval remains an external
commercial requirement; this package does not pretend to replace that process.

## Why RCS

RCS can make an automated phone-number conversation feel like a real business
channel instead of a fallback transport:

- **Approved business identity:** use the profile attached to your approved RCS
  sender rather than an anonymous application endpoint.
- **More useful conversations:** exchange readable long-form text and simple
  media without SMS's 160-character fragmentation.
- **Operational visibility:** track accepted, sent, delivered, and read
  observations without allowing late callbacks to move state backward.
- **A clean channel boundary:** keep RCS traffic, credentials, webhooks, and
  delivery state separate from SMS/MMS.
- **Agent-ready controls:** pair or allowlist senders, run multiple accounts,
  and durably resume accepted inbound work after a restart.

## Who it is for

| Team | Where it helps |
| --- | --- |
| Customer support and concierge teams | Two-way customer conversations with text, media, and delivery visibility |
| Operations and professional-service teams | Controlled inbound access, durable intake, and account separation |
| Conversational AI and automation builders | An OpenClaw-native channel implementation instead of a custom webhook sidecar |
| RCS product evaluators | A public, MIT-licensed reference for Twilio RCS security, lifecycle, and delivery design |

The runtime is OpenClaw-specific. Teams using another agent platform can still
reuse the architecture and implementation as an open reference, but it is not a
drop-in generic RCS SDK.

## What it does

- Sends RCS-only text and simple media through a dedicated Twilio Messaging
  Service.
- Receives signed inbound messages and delivery/read callbacks through one
  public HTTPS route.
- Commits accepted inbound callbacks before returning success, deduplicates
  retries, and resumes queued work after restart.
- Supports pairing, allowlists, open or disabled DM policy, and multiple
  independently configured accounts.
- Publishes Gateway lifecycle state and monotonic delivery observations.
- Validates Twilio signatures and binds inbound work to the configured Account
  SID and Messaging Service SID.
- Applies bounded media handling, admission limits, and credential-safe provider
  errors.

## What has been verified

| Proven | Still requires a real commercial RCS environment |
| --- | --- |
| `63/63` focused RCS tests pass on the final reviewed source | Approved-sender → real device → carrier/UI round trip |
| A prior package-loaded isolated Gateway proof registered the channel and webhook | Live carrier interoperability across target devices and regions |
| Signed inbound, durable replay, lifecycle, and mock-provider outbound paths complete without live Twilio traffic | Observation of Twilio's production `EventType=READ` callback shape |
| ClawHub's inspector reports no compatibility issues or deprecation warnings against OpenClaw `2026.10.3` | Twilio/Google onboarding, commercial plan, policy, and launch approval |

This is a technically validated community plugin, **not a claim of carrier
certification or a completed paid production rollout**. Rich cards, suggested
actions, automatic SMS/MMS fallback, and direct sender mode are not included in
this release.

## Install

```bash
openclaw plugins install clawhub:clawSean/rcs
```

Then follow the complete [setup and operations guide](docs/rcs.md).

### Requirements

- OpenClaw `2026.8.1` or newer
- A Twilio account with an approved RCS sender
- A dedicated Twilio Messaging Service containing that sender
- A public HTTPS webhook URL reaching the OpenClaw Gateway
- An approved test device or launched sender for real carrier validation

### Minimal configuration

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

## Safety and operating model

RCS is deliberately isolated from the SMS/MMS channel. The plugin always uses
`rcs:+E164` destinations and never silently falls back to SMS. Every account
gets an exact public webhook URL and a dedicated Messaging Service identity.

For inbound traffic, the plugin verifies the Twilio signature before
classification, enforces account and service identity, applies sender/account
admission limits, durably records accepted work, and redacts credentials from
surfaced provider errors. See [docs/rcs.md](docs/rcs.md) for the full contract.

## Development and verification

This repository is the canonical community distribution derived from the final
reviewed implementation in `openclaw/openclaw#105025`. The focused suite runs
from the preserved OpenClaw source checkout:

```bash
pnpm test:extension rcs
```

The repository ships compiled JavaScript in `dist/` for ClawHub installation
and keeps the TypeScript source alongside it for review. It intentionally does
not vendor OpenClaw's test harness or duplicate the monorepo lockfile.

## Provenance and credit

This implementation was developed publicly as
[openclaw/openclaw#105025](https://github.com/openclaw/openclaw/pull/105025).
OpenClaw subsequently directed RCS to third-party ClawHub distribution in
[openclaw/openclaw#105710](https://github.com/openclaw/openclaw/issues/105710),
which is why this repository and [`clawsean/rcs`](https://clawhub.ai/clawsean/plugins/rcs)
are the maintained community surfaces.

If a future bundled or official OpenClaw RCS channel is informed by this work,
please preserve its implementation history by citing this repository and the
original PR in release notes or source provenance. Reuse remains governed by
the MIT license and [third-party notices](THIRD_PARTY_NOTICES.md).

## License

MIT — see [LICENSE](LICENSE).
