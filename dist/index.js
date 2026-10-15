import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
//#region ../clawSean/openclaw-rcs-channel/index.ts
var openclaw_rcs_channel_default = defineBundledChannelEntry({
	id: "rcs",
	name: "RCS",
	description: "Secure, durable Twilio RCS customer conversations for OpenClaw.",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "rcsPlugin"
	},
	runtime: {
		specifier: "./api.js",
		exportName: "setRcsRuntime"
	}
});
//#endregion
export { openclaw_rcs_channel_default as default };
