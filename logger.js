import pino from "pino";
import config from "./config.js";

const logger = pino({
  level: config.DEBUG_LOGS ? "debug" : "info",
  ...(config.NODE_ENV !== "production" && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" }
    }
  })
});

export default logger;
