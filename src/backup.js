const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

function parseDatabaseUrl(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is invalid");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const username = decodeURIComponent(parsed.username);
  if (!parsed.hostname || !username || !database) {
    throw new Error("DATABASE_URL is missing host, username, or database name");
  }
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    username,
    password: decodeURIComponent(parsed.password),
    database
  };
}

function runPgDump(connection, filePath) {
  const args = [
    "--format=custom",
    "--compress=6",
    "--no-owner",
    "--no-privileges",
    "--host", connection.host,
    "--port", connection.port,
    "--username", connection.username,
    "--file", filePath,
    connection.database
  ];
  const env = {
    ...process.env,
    PGPASSWORD: connection.password || "",
    PGCONNECT_TIMEOUT: process.env.PGCONNECTTIMEOUT || "15"
  };
  if (process.env.DATABASE_SSL === "true" && !env.PGSSLMODE) env.PGSSLMODE = "require";

  return new Promise((resolve, reject) => {
    const child = spawn("pg_dump", args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8000) stderr += chunk.toString();
    });
    child.once("error", (error) => {
      reject(new Error(error.code === "ENOENT" ? "pg_dump is not installed on the VPS" : error.message));
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `pg_dump exited with code ${code}`));
    });
  });
}

async function createDatabaseBackup(databaseUrl) {
  const connection = parseDatabaseUrl(databaseUrl);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `global_digits_${stamp}_${crypto.randomUUID().slice(0, 8)}.dump`;
  const filePath = path.join(os.tmpdir(), fileName);
  try {
    await runPgDump(connection, filePath);
    await fs.chmod(filePath, 0o600);
    const stat = await fs.stat(filePath);
    if (!stat.size) throw new Error("pg_dump created an empty backup");
    return { filePath, fileName, sizeBytes: stat.size, createdAt: new Date() };
  } catch (error) {
    await fs.unlink(filePath).catch(() => {});
    throw error;
  }
}

module.exports = { createDatabaseBackup, parseDatabaseUrl };
