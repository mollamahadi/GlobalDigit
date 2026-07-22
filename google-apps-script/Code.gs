const SPREADSHEET_ID = "1fQP5CBL1HVp5ovkp4NW7RZE6_Q_CHArGjbaUIWM2Hfs";

const SCHEMAS = {
  user_upsert: {
    tab: "Users",
    headers: ["Telegram ID", "Username", "First Name", "Balance USD", "Status", "Terms Accepted", "Channel Verified", "Created At", "Updated At"],
    row: p => [p.telegram_id, p.username, p.first_name, p.balance, p.status, p.terms_accepted, p.channel_verified, p.created_at, p.updated_at]
  },
  product_upsert: {
    tab: "Products",
    headers: ["Product ID", "Category ID", "Category", "Product Name", "Price USD", "Product Type", "Area Codes", "Delivery Mode", "Status", "Created At", "Updated At"],
    row: p => [p.id, p.category_id, p.category, p.name, p.price, p.product_type, p.area_codes, p.delivery_mode, p.status, p.created_at, p.updated_at]
  },
  stock_upsert: {
    tab: "Stock",
    headers: ["Stock ID", "Product ID", "Product Name", "Area Code", "Account / Stock Details", "Status", "Sold To", "Sold At", "Created At"],
    row: p => [p.id, p.product_id, p.product_name, p.area_code, p.stock_data, p.status, p.sold_to, p.sold_at, p.created_at]
  },
  order_upsert: {
    tab: "Orders",
    headers: ["Order ID", "Telegram ID", "Username", "Product ID", "Product Name", "Area Code", "Quantity", "Unit Price USD", "Total Price USD", "Delivery Mode", "Status", "Purchased At", "Delivered At"],
    row: p => [p.id, p.telegram_id, p.username, p.product_id, p.product_name, p.area_code, p.quantity, p.unit_price, p.total_price, p.delivery_mode, p.status, p.created_at, p.delivered_at]
  },
  delivery_upsert: {
    tab: "Delivered",
    headers: ["Delivery ID", "Order ID", "Stock ID", "Telegram ID", "Username", "Product ID", "Product Name", "Area Code", "Delivered Account Details", "Delivery Mode", "Delivered At"],
    row: p => [p.id, p.order_id, p.stock_id, p.telegram_id, p.username, p.product_id, p.product_name, p.area_code, p.delivered_data, p.delivery_mode, p.delivered_at]
  },
  deposit_upsert: {
    tab: "Deposits",
    headers: ["Request ID", "Telegram ID", "Username", "Amount USD", "Payment Method", "TXID / Hash", "Screenshot File ID", "Status", "Created At", "Reviewed At"],
    row: p => [p.id, p.telegram_id, p.username, p.amount, p.method, p.txid, p.screenshot_file_id, p.status, p.created_at, p.reviewed_at]
  }
};

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return jsonResponse({ ok: true, service: "Global Digits Sheet Sync" });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const request = JSON.parse(e.postData.contents || "{}");
    const expectedSecret = PropertiesService.getScriptProperties().getProperty("WEBHOOK_SECRET");
    if (!expectedSecret) throw new Error("WEBHOOK_SECRET is not configured in Script Properties");
    if (request.secret !== expectedSecret) throw new Error("Unauthorized webhook request");

    lock.waitLock(30000);
    if (request.action === "setup") {
      setupSheets();
      return jsonResponse({ ok: true, action: "setup" });
    }
    if (request.action !== "upsert") throw new Error("Unknown action");

    const schema = SCHEMAS[request.eventType];
    if (!schema) throw new Error("Unknown event type: " + request.eventType);
    upsertRow(schema, request.entityKey, request.payload || {});
    return jsonResponse({ ok: true, action: "upsert", eventType: request.eventType });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error.message || error) });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function setupSheets() {
  Object.keys(SCHEMAS).forEach(key => getOrCreateSheet(SCHEMAS[key]));
}

function getOrCreateSheet(schema) {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = spreadsheet.getSheetByName(schema.tab);
  if (!sheet) sheet = spreadsheet.insertSheet(schema.tab);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, schema.headers.length).setValues([schema.headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, schema.headers.length)
      .setFontWeight("bold")
      .setBackground("#1f4e78")
      .setFontColor("#ffffff");
  }
  return sheet;
}

function upsertRow(schema, entityKey, payload) {
  const sheet = getOrCreateSheet(schema);
  const lastRow = sheet.getLastRow();
  let targetRow = lastRow + 1;
  if (lastRow >= 2) {
    const keys = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    const index = keys.findIndex(row => String(row[0]) === String(entityKey));
    if (index >= 0) targetRow = index + 2;
  }
  const values = schema.row(payload).map(normalizeCell);
  sheet.getRange(targetRow, 1, 1, values.length).setValues([values]);
}

function normalizeCell(value) {
  if (value === null || typeof value === "undefined") return "";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" && /^[=+\-@]/.test(value)) return "'" + value;
  return value;
}
