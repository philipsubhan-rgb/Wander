import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.philipsubhan.wander",
  appName: "Wander",
  webDir: "dist/public",
  server: {
    // Phase 1 (TestFlight internal): the native shell loads the live
    // production web app, so the December stack reaches the app the
    // moment it deploys — no rebuild needed. Bundled-assets mode is a
    // later step (needs an API-base strategy for the relative /api
    // calls + cross-origin session cookies).
    url: "https://wander.philipsubhan.com",
    cleartext: false,
  },
};

export default config;
