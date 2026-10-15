import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
//#region ../clawSean/openclaw-rcs-channel/src/runtime.ts
const { setRuntime: setRcsRuntime, getRuntime: getRcsRuntime } = createPluginRuntimeStore({
	pluginId: "rcs",
	errorMessage: "RCS runtime not initialized - plugin not registered"
});
//#endregion
export { setRcsRuntime as n, getRcsRuntime as t };
