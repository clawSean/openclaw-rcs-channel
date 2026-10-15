// Rcs plugin entrypoint registers its OpenClaw integration.
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "rcs",
  name: "RCS",
  description: "Secure, durable Twilio RCS customer conversations for OpenClaw.",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "rcsPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setRcsRuntime",
  },
});
