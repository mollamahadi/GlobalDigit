const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const config = {
  botToken: process.env.BOT_TOKEN || "",
  adminIds: (process.env.ADMIN_IDS || "").split(",").map((v) => v.trim()).filter(Boolean),
  supportLink: process.env.SUPPORT_LINK || "",
  channelLink: process.env.CHANNEL_LINK || "",
  channelId: process.env.CHANNEL_ID || "",
  databaseUrl: process.env.DATABASE_URL || "",
  googleAppsScriptUrl: process.env.GOOGLE_APPS_SCRIPT_URL || "",
  googleAppsScriptSecret: process.env.GOOGLE_APPS_SCRIPT_SECRET || "",
  sheetSyncEnabled: ["1", "true", "yes"].includes(String(process.env.SHEET_SYNC_ENABLED || "false").toLowerCase()),
  port: Number(process.env.PORT || 3000)
};

if (!config.botToken) throw new Error("BOT_TOKEN is missing in .env");
if (!config.adminIds.length) throw new Error("ADMIN_IDS is missing in .env");
if (!config.databaseUrl) throw new Error("DATABASE_URL is missing in .env");

module.exports = config;
