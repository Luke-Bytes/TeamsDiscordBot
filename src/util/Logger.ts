import { createLogger, format, transports } from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.printf(
      ({ level, message, timestamp }) =>
        `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [
    new transports.Console(),

    new DailyRotateFile({
      filename: "logs/teams_bot-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      zippedArchive: false, // May make true later
      maxSize: "20m",
      maxFiles: "14d",
    }),
  ],
});

export default logger;
