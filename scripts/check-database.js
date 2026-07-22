const db = require("../src/database");

async function check() {
  await db.initialize();
  const result = await db.query("SELECT CURRENT_DATABASE() database_name, CURRENT_TIMESTAMP checked_at");
  console.log(`PostgreSQL OK: ${result.rows[0].database_name} at ${result.rows[0].checked_at.toISOString()}`);
  await db.close();
}

check().catch(async (error) => {
  console.error(`PostgreSQL check failed: ${error.message}`);
  await db.close().catch(() => {});
  process.exit(1);
});
