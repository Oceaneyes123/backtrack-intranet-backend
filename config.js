const config = {
  PORT: process.env.PORT || 8787,
  ORIGIN: process.env.ALLOWED_ORIGIN || "*",
  DATABASE_PATH: process.env.DATABASE_PATH || "./data/chat.db",
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
  REQUIRE_AUTH: process.env.REQUIRE_AUTH === "true",
  MESSAGE_RETENTION_DAYS: Number(process.env.MESSAGE_RETENTION_DAYS || 30),
  RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED === "true",
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX || 120),
  DEBUG_LOGS: process.env.DEBUG_LOGS === "true"
};

export default config;
