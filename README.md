# OpenClaw RCS channel plugin (Twilio)

Source snapshot of the `rcs` channel plugin proposed for
[OpenClaw](https://github.com/openclaw/openclaw): RCS Business Messaging through
Twilio, exposed behind a provider-neutral channel surface.

## Provenance and status

- Initial-version snapshot of upstream PR
  [openclaw/openclaw#105025](https://github.com/openclaw/openclaw/pull/105025)
  at commit `d981800ca4`, taken 2026-07-12.
- The PR is open upstream. Whether the channel ships in OpenClaw core or is
  distributed through ClawHub is an unresolved scope decision, tracked in
  [openclaw/openclaw#105710](https://github.com/openclaw/openclaw/issues/105710).
- This repository exists for reading and sharing that proposal. The plugin is
  not bundled in OpenClaw and not published on ClawHub.

## What it does

- Registers an `rcs` channel with `rcs:+E164` addressing and pairing/allowlist
  access control, mirroring the model of OpenClaw's bundled `sms` channel.
- Validates Twilio webhook signatures fail-closed: `X-Twilio-Signature` is
  checked against the configured public webhook URL and auth token before any
  dispatch, and turning validation off requires an explicit
  `dangerouslyDisableSignatureValidation` flag.
- Captures delivery and read receipts for outbound messages, including mapping
  Twilio's post-delivery `EventType=READ` callbacks to `read` status.
- Handles over-limit webhook traffic per upstream
  [#104862](https://github.com/openclaw/openclaw/issues/104862): rate-limited
  but signature-validated Twilio callbacks are acknowledged with HTTP 200 and
  empty TwiML (not dispatched), because Twilio treats non-2xx responses as
  delivery failures; over-limit traffic that fails validation still gets
  HTTP 429.
- Provides a shared SMS/RCS webhook router for Twilio Messaging Services that
  post both kinds of traffic to one URL, with startup guards against webhook
  path conflicts (the shared path may not equal the RCS webhook path or the
  SMS forward path, and native SMS moves to a distinct internal route).
- Keeps Twilio specifics isolated in a provider layer behind provider-neutral
  channel seams — channel id, addressing, pairing policy, and status capture do
  not encode Twilio, so other RCS Business Messaging providers can back the
  same surface.

## Configuration quickstart

Prerequisites: a Twilio account with an approved RCS Business Messaging sender,
a Twilio Messaging Service that owns that sender, the Account SID and Auth
Token, and a public HTTPS URL reaching your OpenClaw Gateway.

1. On the Twilio Messaging Service, set **Inbound Request URL** to
   `https://<your-gateway>/webhooks/rcs` (HTTP `POST`) and set
   **Use Inbound Webhook on Number** to `false` (RCS senders are agents, not
   phone numbers).

2. Configure the channel:

   ```json5
   // rcs.patch.json5
   {
     channels: {
       rcs: {
         enabled: true,
         accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
         authToken: "twilio-auth-token",
         messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
         transport: "rcs-only",
         publicWebhookUrl: "https://<your-gateway>/webhooks/rcs",
         statusCallbacks: true,
         dmPolicy: "pairing",
       },
     },
   }
   ```

   ```bash
   openclaw config patch --file ./rcs.patch.json5
   ```

3. Start the Gateway (`openclaw gateway`), send an RCS message to the sender
   from an RCS-capable device, then approve the pairing request:

   ```bash
   openclaw pairing list rcs
   openclaw pairing approve rcs <CODE>
   ```

`transport: "rcs-only"` (default) targets `rcs:+E164` with no SMS fallback;
`rcs-preferred` lets Twilio fall back to SMS/MMS. `publicWebhookUrl` must match
the URL configured in Twilio byte-for-byte, or signature validation will reject
the webhooks. Full setup, multi-account config, the shared SMS/RCS webhook
topology, and troubleshooting are in [docs/rcs.md](docs/rcs.md).

## Layout

- `index.ts` — plugin entrypoint (`defineChannelPluginEntry`)
- `api.ts`, `channel-plugin-api.ts`, `secret-contract-api.ts` — public API
  surface modules
- `src/` — channel implementation and tests (webhook handling, sending, status
  capture, addressing, config schema, Twilio provider layer)
- `openclaw.plugin.json` — plugin manifest (channel config schema and UI hints)
- `docs/rcs.md`, `docs/plugin-reference.md` — the PR's documentation pages;
  `docs/rcs.md` uses MDX components (`<Card>`, `<Steps>`) that render as plain
  tags outside the OpenClaw docs site

## Testing

The test suite (`src/*.test.ts`) runs inside the OpenClaw monorepo via
`pnpm test:extension rcs` and depends on the monorepo's plugin SDK and test
harness (`@openclaw/plugin-sdk` is a `workspace:*` dependency, and
`tsconfig.json` extends a monorepo base config that does not resolve here).
This snapshot is for reading and sharing the proposed plugin; it is not yet an
installable or independently buildable package.

## License

MIT — see [LICENSE](LICENSE).
