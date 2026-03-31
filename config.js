const config = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: process.env.PORT || 8787,
  ORIGIN: process.env.ALLOWED_ORIGIN || (process.env.NODE_ENV === "production" ? "" : "*"),
  DATABASE_PATH: process.env.DATABASE_PATH || "./data/chat.db",
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
  REQUIRE_AUTH: process.env.REQUIRE_AUTH === "true",
  MESSAGE_RETENTION_DAYS: Number(process.env.MESSAGE_RETENTION_DAYS || 30),
  MAX_MESSAGE_LENGTH: Number(process.env.MAX_MESSAGE_LENGTH || 4000),
  RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED === "true",
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX || 120),
  DEBUG_LOGS: process.env.DEBUG_LOGS === "true",
  WS_HEARTBEAT_INTERVAL_MS: Number(process.env.WS_HEARTBEAT_INTERVAL_MS || 30_000),
  TRUST_PROXY: process.env.TRUST_PROXY || false
};

// I5: Validate required env vars in production — fail fast with clear messages.
if (config.NODE_ENV === "production") {
  const errors = [];
  if (!config.ORIGIN) errors.push("ALLOWED_ORIGIN is required in production.");
  if (config.ORIGIN === "*") errors.push("ALLOWED_ORIGIN must not be '*' in production.");
  if (config.REQUIRE_AUTH && !config.GOOGLE_CLIENT_ID) errors.push("GOOGLE_CLIENT_ID is required when REQUIRE_AUTH=true.");
  if (!config.REQUIRE_AUTH) errors.push("REQUIRE_AUTH should be 'true' in production (set REQUIRE_AUTH=true).");
  if (errors.length) {
    console.error("\n=== CONFIGURATION ERRORS ===");
    errors.forEach((e) => console.error(`  ✗ ${e}`));
    console.error("===========================\n");
    process.exit(1);
  }
}

export default config;
