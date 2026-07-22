const http = require("http");
const { Telegraf, Markup, session } = require("telegraf");
const config = require("./config");
const db = require("./database");
const payments = require("./payments");
const { startSheetWorker, stopSheetWorker, queueFullSync } = require("./sheet-sync");

const bot = new Telegraf(config.botToken);
bot.use(session());
bot.use((ctx, next) => {
  ctx.session = ctx.session || {};
  return next();
});

const safeAnswer = (ctx, text) => ctx.answerCbQuery(text).catch(() => {});

function rememberScreen(ctx, message) {
  if (!message?.message_id) return message;
  ctx.session.uiMessages = ctx.session.uiMessages || [];
  ctx.session.uiMessages.push(message.message_id);
  ctx.session.uiMessages = [...new Set(ctx.session.uiMessages)].slice(-12);
  return message;
}

async function clearScreen(ctx) {
  const ids = new Set(ctx.session.uiMessages || []);
  if (ctx.callbackQuery?.message?.message_id) ids.add(ctx.callbackQuery.message.message_id);
  ctx.session.uiMessages = [];
  for (const id of ids) await ctx.telegram.deleteMessage(ctx.chat.id, id).catch(() => {});
}

async function screenReply(ctx, text, extra = {}) {
  await clearScreen(ctx);
  return rememberScreen(ctx, await ctx.reply(text, extra));
}

async function screenPhoto(ctx, photo, extra = {}) {
  await clearScreen(ctx);
  return rememberScreen(ctx, await ctx.replyWithPhoto(photo, extra));
}

async function trackedReply(ctx, text, extra = {}) {
  return rememberScreen(ctx, await ctx.reply(text, extra));
}

const backButton = (callback = "back_main") => Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", callback)]]);

const isAdmin = (ctx) => config.adminIds.includes(String(ctx.from?.id));
const adminOnly = (ctx) => {
  if (isAdmin(ctx)) return false;
  ctx.reply("❌ Admin access only.");
  return true;
};

async function getUser(ctx) {
  const id = String(ctx.from.id);
  const username = ctx.from.username || "";
  const firstName = ctx.from.first_name || "User";
  const existing = await db.prepare("SELECT * FROM users WHERE telegram_id=?").get(id);
  const profileChanged = !existing || existing.username !== username || existing.first_name !== firstName;
  await db.prepare(`INSERT INTO users (telegram_id, username, first_name) VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username=excluded.username,
      first_name=excluded.first_name,
      updated_at=CASE
        WHEN users.username IS DISTINCT FROM excluded.username OR users.first_name IS DISTINCT FROM excluded.first_name
        THEN CURRENT_TIMESTAMP ELSE users.updated_at END`)
    .run(id, username, firstName);
  const user = await db.prepare("SELECT * FROM users WHERE telegram_id=?").get(id);
  if (profileChanged) await db.enqueueSheetEvent("user_upsert", user.telegram_id, user);
  return user;
}

async function guard(ctx) {
  const user = await getUser(ctx);
  if (user.status === "blocked") {
    if (ctx.callbackQuery) safeAnswer(ctx);
    screenReply(ctx, "❌ Your account is blocked. Please contact support.").catch(() => {});
    return true;
  }
  if (!user.terms_accepted) {
    if (ctx.callbackQuery) safeAnswer(ctx);
    screenReply(ctx, "📜 Terms & Conditions\n\n1. All products are digital goods.\n2. Check product details before buying.\n3. Wallet balance is non-withdrawable.\n4. Fake payment proof may result in a block.\n5. Refund or replacement requires admin review.\n6. Do not misuse any product.\n\nDo you agree?", Markup.inlineKeyboard([
      [Markup.button.callback("✅ I Agree", "terms_agree")],
      [Markup.button.callback("❌ I Do Not Agree", "terms_decline")]
    ])).catch(() => {});
    return true;
  }
  if (!user.channel_verified) {
    if (ctx.callbackQuery) safeAnswer(ctx);
    screenReply(ctx, "📢 Join our official channel to continue.\n\nAfter joining, click ✅ I've Joined.", Markup.inlineKeyboard([
      [Markup.button.url("📢 Join Channel", config.channelLink)],
      [Markup.button.callback("✅ I've Joined", "verify_channel")]
    ])).catch(() => {});
    return true;
  }
  return false;
}

function menu(ctx) {
  const rows = [
    ["👤 My Profile", "💰 Add Fund"],
    ["🛒 Buy Product", "📦 My Orders"],
    ["🆘 Support"]
  ];
  if (isAdmin(ctx)) rows.push(["🛠 Admin Panel"]);
  return Markup.keyboard(rows).resize();
}

async function showMenu(ctx) {
  const user = await getUser(ctx);
  ctx.session.fund = null;
  ctx.session.buy = null;
  ctx.session.adminFlow = null;
  ctx.session.manualDelivery = null;
  return screenReply(ctx, `Welcome to Global Digits, ${user.first_name || "User"}!\n\nBalance: ${Number(user.balance).toFixed(2)} USD`, menu(ctx));
}

bot.start(async (ctx) => {
  if (await guard(ctx)) return;
  return showMenu(ctx);
});
bot.command("menu", async (ctx) => (await guard(ctx)) || showMenu(ctx));
bot.action("terms_agree", async (ctx) => {
  await getUser(ctx);
  await db.prepare("UPDATE users SET terms_accepted=TRUE,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(String(ctx.from.id));
  const user = await db.prepare("SELECT * FROM users WHERE telegram_id=?").get(String(ctx.from.id));
  await db.enqueueSheetEvent("user_upsert", user.telegram_id, user);
  await ctx.answerCbQuery("Accepted");
  return screenReply(ctx, "✅ Terms accepted.\n\nNow join our official channel, then click ✅ I've Joined.", Markup.inlineKeyboard([
    [Markup.button.url("📢 Join Channel", config.channelLink)],
    [Markup.button.callback("✅ I've Joined", "verify_channel")]
  ]));
});
bot.action("terms_decline", async (ctx) => {
  await ctx.answerCbQuery();
  return screenReply(ctx, "You must accept the terms to use this bot.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back to Terms", "show_terms")]]));
});

bot.action("show_terms", async (ctx) => {
  await safeAnswer(ctx);
  await db.prepare("UPDATE users SET terms_accepted=FALSE,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(String(ctx.from.id));
  return guard(ctx);
});

bot.action("verify_channel", async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const member = await ctx.telegram.getChatMember(config.channelId, ctx.from.id);
    if (!["member", "administrator", "creator"].includes(member.status)) {
      return trackedReply(ctx, "❌ You have not joined the channel yet. Please join and try again.");
    }
    await db.prepare("UPDATE users SET channel_verified=TRUE,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(String(ctx.from.id));
    const user = await db.prepare("SELECT * FROM users WHERE telegram_id=?").get(String(ctx.from.id));
    await db.enqueueSheetEvent("user_upsert", user.telegram_id, user);
    return showMenu(ctx);
  } catch (error) {
    console.error("Channel verification failed:", error.message);
    return trackedReply(ctx, "❌ Verification failed. Make sure the bot is an admin in the channel, then try again.");
  }
});

bot.action("back_main", async (ctx) => {
  await safeAnswer(ctx);
  return showMenu(ctx);
});

bot.hears("👤 My Profile", async (ctx) => {
  if (await guard(ctx)) return;
  const u = await getUser(ctx);
  return screenReply(ctx, `👤 My Profile\n\nUser ID: ${u.telegram_id}\nUsername: @${u.username || "N/A"}\nBalance: ${Number(u.balance).toFixed(2)} USD`, backButton());
});

bot.hears("💰 Add Fund", async (ctx) => {
  if (await guard(ctx)) return;
  ctx.session.fund = { step: "amount" };
  return screenReply(ctx, "💰 Send the amount in USD.\nExample: 10", backButton());
});

function paymentMethodKeyboard() {
  const entries = Object.entries(payments);
  const rows = [];
  for (let i = 0; i < entries.length; i += 2) {
    rows.push(entries.slice(i, i + 2).map(([key, item]) => Markup.button.callback(item.label, `fund_method_${key}`)));
  }
  rows.push([Markup.button.callback("⬅️ Back", "fund_back_amount")]);
  return Markup.inlineKeyboard(rows);
}

function paymentDetailKeyboard(payment) {
  return Markup.inlineKeyboard([
    [{ text: "📋 Copy Address", copy_text: { text: payment.address } }],
    [Markup.button.callback("✅ Payment Done", "fund_payment_done")],
    [Markup.button.callback("⬅️ Other Payment Method", "fund_methods")],
    [Markup.button.callback("❌ Cancel", "fund_cancel")]
  ]);
}

async function showPaymentMethods(ctx) {
  const fund = ctx.session.fund;
  if (!fund?.amount) return showMenu(ctx);
  return screenReply(ctx, `💳 Deposit Amount: $${Number(fund.amount).toFixed(2)}\n\nSelect a payment method:`, paymentMethodKeyboard());
}

bot.action("fund_back_amount", async (ctx) => {
  await safeAnswer(ctx);
  ctx.session.fund = { step: "amount" };
  return screenReply(ctx, "💰 Send the amount in USD.\nExample: 10", backButton());
});

bot.action("fund_methods", async (ctx) => {
  await safeAnswer(ctx);
  return showPaymentMethods(ctx);
});

bot.action(/^fund_method_(.+)$/, async (ctx) => {
  await safeAnswer(ctx);
  const payment = payments[ctx.match[1]];
  const fund = ctx.session.fund;
  if (!payment || !fund?.amount) return showMenu(ctx);
  Object.assign(fund, { methodKey: ctx.match[1], method: payment.label, step: "payment" });
  const caption = `💳 ${payment.label}\n\nAmount: $${Number(fund.amount).toFixed(2)}\nNetwork: ${payment.network}\n\nAddress:\n${payment.address}\n\n⚠️ Send only through the displayed network. After payment, click ✅ Payment Done.`;
  try {
    return await screenPhoto(ctx, { source: payment.image }, { caption, ...paymentDetailKeyboard(payment) });
  } catch (error) {
    console.error("Payment QR error:", error.message);
    return screenReply(ctx, caption, paymentDetailKeyboard(payment));
  }
});

bot.action("fund_payment_done", async (ctx) => {
  await safeAnswer(ctx);
  const fund = ctx.session.fund;
  if (!fund?.method) return showMenu(ctx);
  fund.step = "txid";
  return screenReply(ctx, "Send your transaction ID / hash:", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back to Payment", `fund_method_${fund.methodKey}`)]]));
});

bot.action("fund_cancel", async (ctx) => {
  await safeAnswer(ctx, "Cancelled");
  ctx.session.fund = null;
  return showMenu(ctx);
});

bot.hears("🛒 Buy Product", async (ctx) => {
  if (await guard(ctx)) return;
  const categories = await db.prepare("SELECT * FROM categories WHERE status='active' ORDER BY id").all();
  if (!categories.length) return screenReply(ctx, "No products are available right now.", backButton());
  const rows = categories.map((c) => [Markup.button.callback(`📁 ${c.name}`, `cat_${c.id}`)]);
  rows.push([Markup.button.callback("⬅️ Back", "back_main")]);
  return screenReply(ctx, "Select a category:", Markup.inlineKeyboard(rows));
});

bot.action("back_categories", async (ctx) => {
  await safeAnswer(ctx);
  const categories = await db.prepare("SELECT * FROM categories WHERE status='active' ORDER BY id").all();
  const rows = categories.map((c) => [Markup.button.callback(`📁 ${c.name}`, `cat_${c.id}`)]);
  rows.push([Markup.button.callback("⬅️ Back", "back_main")]);
  return screenReply(ctx, "Select a category:", Markup.inlineKeyboard(rows));
});

bot.action(/^cat_(\d+)$/, async (ctx) => {
  if (await guard(ctx)) return;
  const products = await db.prepare(`SELECT p.*, COUNT(CASE WHEN s.status='available' THEN 1 END) stock_count
    FROM products p LEFT JOIN stocks s ON s.product_id=p.id WHERE p.category_id=? AND p.status='active' GROUP BY p.id`).all(ctx.match[1]);
  await ctx.answerCbQuery();
  const rows = products.map((p) => [Markup.button.callback(`${p.name} — $${Number(p.price).toFixed(2)} | ${p.delivery_mode === "manual" ? "Manual" : `Stock: ${p.stock_count}`}`, `product_${p.id}`)]);
  rows.push([Markup.button.callback("⬅️ Back", "back_categories")]);
  if (!products.length) return screenReply(ctx, "No active products in this category.", Markup.inlineKeyboard(rows));
  return screenReply(ctx, "Select a product:", Markup.inlineKeyboard(rows));
});

bot.action(/^product_(\d+)$/, async (ctx) => {
  if (await guard(ctx)) return;
  const p = await db.prepare("SELECT * FROM products WHERE id=? AND status='active'").get(ctx.match[1]);
  await ctx.answerCbQuery();
  if (!p) return ctx.reply("Product not found.");
  ctx.session.buy = { productId: p.id, categoryId: p.category_id };
  if (p.product_type === "area") {
    const configured = String(p.area_codes || "").split(",").map((x) => x.trim()).filter(Boolean);
    const stockAreas = await db.prepare("SELECT area_code, COUNT(*) count FROM stocks WHERE product_id=? AND status='available' AND area_code IS NOT NULL GROUP BY area_code").all(p.id);
    const counts = Object.fromEntries(stockAreas.map((a) => [a.area_code, a.count]));
    const codes = configured.length ? configured : stockAreas.map((a) => a.area_code);
    const visible = p.delivery_mode === "manual" ? codes : codes.filter((code) => Number(counts[code] || 0) > 0);
    const rows = visible.map((code) => [Markup.button.callback(`${code}${p.delivery_mode === "auto" ? ` | Stock: ${counts[code] || 0}` : ""}`, `area_${p.id}_${code}`)]);
    rows.push([Markup.button.callback("⬅️ Back", `cat_${p.category_id}`)]);
    if (!visible.length) return screenReply(ctx, "This product is currently out of stock.", Markup.inlineKeyboard(rows));
    return screenReply(ctx, `📦 ${p.name}\nPrice: $${Number(p.price).toFixed(2)} each\nDelivery: ${p.delivery_mode === "auto" ? "Automatic" : "Manual"}\n\nSelect area code:`, Markup.inlineKeyboard(rows));
  }
  ctx.session.buy.step = "quantity";
  return screenReply(ctx, `📦 ${p.name}\nPrice: $${Number(p.price).toFixed(2)} each\nDelivery: ${p.delivery_mode === "auto" ? "Automatic" : "Manual"}\n\nSend the quantity as a number.`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", `cat_${p.category_id}`)]]));
});

bot.action(/^area_(\d+)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.buy = { productId: Number(ctx.match[1]), areaCode: ctx.match[2], step: "quantity" };
  const p = await db.prepare("SELECT * FROM products WHERE id=?").get(ctx.match[1]);
  ctx.session.buy.categoryId = p?.category_id;
  return screenReply(ctx, `Area code selected: ${ctx.match[2]}\nSend the quantity as a number.`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", `product_${ctx.match[1]}`)]]));
});

bot.hears("📦 My Orders", async (ctx) => {
  if (await guard(ctx)) return;
  const orders = await db.prepare("SELECT * FROM orders WHERE telegram_id=? ORDER BY id DESC LIMIT 10").all(String(ctx.from.id));
  if (!orders.length) return screenReply(ctx, "You have no orders yet.", backButton());
  return screenReply(ctx, "📦 My Orders\n\n" + orders.map((o) => `#${o.id} | ${o.product_name}${o.status === "pending" ? " (Pending)" : ""} | Qty: ${o.quantity} | $${Number(o.total_price).toFixed(2)} | ${o.created_at}`).join("\n"), backButton());
});

bot.hears("🆘 Support", (ctx) => screenReply(ctx, config.supportLink ? `🆘 Support\n\n${config.supportLink}` : "Support has not been configured yet.", backButton()));
function adminKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add Category", "admin_add_category"), Markup.button.callback("➕ Add Product", "admin_add_product")],
    [Markup.button.callback("📥 Add Stock", "admin_add_stock"), Markup.button.callback("📦 Products", "admin_products")],
    [Markup.button.callback("🚚 Manual Orders", "admin_manual_orders"), Markup.button.callback("💳 Deposits", "admin_deposits")],
    [Markup.button.callback("💵 Add Balance", "admin_add_balance"), Markup.button.callback("➖ Cut Balance", "admin_cut_balance")],
    [Markup.button.callback("🔄 Sheet Sync", "admin_sheet_status"), Markup.button.callback("📋 Commands", "admin_commands")],
    [Markup.button.callback("⬅️ Main Menu", "back_main")]
  ]);
}

function showAdmin(ctx) {
  ctx.session.adminFlow = null;
  ctx.session.manualDelivery = null;
  return screenReply(ctx, "🛠 Global Digits Admin Panel\n\nChoose an option:", adminKeyboard());
}

bot.hears("🛠 Admin Panel", (ctx) => adminOnly(ctx) || showAdmin(ctx));

bot.action("admin_home", async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  ctx.session.adminFlow = null;
  ctx.session.manualDelivery = null;
  return showAdmin(ctx);
});

async function sheetStatusText() {
  if (!config.sheetSyncEnabled) {
    return "🔄 Google Sheet Sync\n\nStatus: Disabled\n\nSet the Apps Script URL and secret, then enable SHEET_SYNC_ENABLED.";
  }
  const rows = await db.prepare("SELECT status,COUNT(*) count FROM sheet_outbox GROUP BY status ORDER BY status").all();
  const latestError = await db.prepare("SELECT last_error FROM sheet_outbox WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  return `🔄 Google Sheet Sync\n\nStatus: Enabled\nPending: ${counts.pending || 0}\nProcessing: ${counts.processing || 0}\nCompleted: ${counts.completed || 0}${latestError ? `\n\nLatest retry reason:\n${latestError.last_error}` : ""}`;
}

bot.action("admin_sheet_status", async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  return screenReply(ctx, await sheetStatusText(), Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Refresh", "admin_sheet_status")],
    [Markup.button.callback("♻️ Full Re-Sync", "admin_sheet_full_sync")],
    [Markup.button.callback("⬅️ Back", "admin_home")]
  ]));
});

bot.action("admin_sheet_full_sync", async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  try {
    const count = await queueFullSync();
    return screenReply(ctx, `✅ ${count} record(s) added to the Google Sheet sync queue.`, Markup.inlineKeyboard([
      [Markup.button.callback("🔄 View Status", "admin_sheet_status")],
      [Markup.button.callback("⬅️ Back", "admin_home")]
    ]));
  } catch (error) {
    return screenReply(ctx, `❌ Full sync could not start.\n\n${error.message}`, backButton("admin_sheet_status"));
  }
});

bot.action("admin_add_category", async (ctx) => {
  if (adminOnly(ctx)) return;
  await ctx.answerCbQuery();
  ctx.session.adminFlow = { type: "category", step: "name" };
  return screenReply(ctx, "Send the new category name:", backButton("admin_home"));
});

bot.action("admin_add_product", async (ctx) => {
  if (adminOnly(ctx)) return;
  await ctx.answerCbQuery();
  const categories = await db.prepare("SELECT * FROM categories WHERE status='active' ORDER BY id").all();
  if (!categories.length) return screenReply(ctx, "Add a category first.", Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add Category", "admin_add_category")],
    [Markup.button.callback("⬅️ Back", "admin_home")]
  ]));
  ctx.session.adminFlow = { type: "product", step: "category" };
  const rows = categories.map((c) => [Markup.button.callback(c.name, `admin_product_cat_${c.id}`)]);
  rows.push([Markup.button.callback("⬅️ Back", "admin_home")]);
  return screenReply(ctx, "Select product category:", Markup.inlineKeyboard(rows));
});

bot.action(/^admin_product_cat_(\d+)$/, async (ctx) => {
  if (adminOnly(ctx)) return;
  await ctx.answerCbQuery();
  ctx.session.adminFlow = { type: "product", step: "template", categoryId: Number(ctx.match[1]) };
  return screenReply(ctx, "Choose product name:", Markup.inlineKeyboard([
    [Markup.button.callback("Google Voice", "admin_name_google_voice"), Markup.button.callback("TN", "admin_name_tn")],
    [Markup.button.callback("TextNow", "admin_name_textnow"), Markup.button.callback("Telegram Stars", "admin_name_telegram_stars")],
    [Markup.button.callback("Facebook Account", "admin_name_facebook_account")],
    [Markup.button.callback("✍️ Custom Name", "admin_name_custom")],
    [Markup.button.callback("⬅️ Back", "admin_add_product")]
  ]));
});

const QUICK_PRODUCT_NAMES = {
  google_voice: "Google Voice",
  tn: "TN",
  textnow: "TextNow",
  telegram_stars: "Telegram Stars",
  facebook_account: "Facebook Account"
};

bot.action(/^admin_name_(google_voice|tn|textnow|telegram_stars|facebook_account)$/, async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  const flow = ctx.session.adminFlow;
  if (!flow || flow.type !== "product") return ctx.reply("Product setup expired. Start again.");
  flow.name = QUICK_PRODUCT_NAMES[ctx.match[1]];
  flow.step = "price";
  return screenReply(ctx, `Product: ${flow.name}\n\nSend price in USD. Example: 2.50`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", `admin_product_cat_${flow.categoryId}`)]]));
});

bot.action("admin_name_custom", async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  const flow = ctx.session.adminFlow;
  if (!flow || flow.type !== "product") return showAdmin(ctx);
  flow.step = "name";
  return screenReply(ctx, "Send custom product name:", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", `admin_product_cat_${flow.categoryId}`)]]));
});

function areaChoiceKeyboard(flow) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📍 Add Area Codes", "admin_area_add")],
    [Markup.button.callback("⏭ Skip Area Code", "admin_area_skip")],
    [Markup.button.callback("⬅️ Back", `admin_product_cat_${flow.categoryId}`)]
  ]);
}

bot.action("admin_area_add", async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  const flow = ctx.session.adminFlow;
  if (!flow || flow.type !== "product") return showAdmin(ctx);
  flow.step = "area_codes";
  return screenReply(ctx, "Send area codes separated by commas.\n\nExample: 818, 650, 415\nYou can also use words such as Random.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", `admin_product_cat_${flow.categoryId}`)]]));
});

bot.action("admin_area_skip", async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  const flow = ctx.session.adminFlow;
  if (!flow || flow.type !== "product") return showAdmin(ctx);
  flow.productType = "normal";
  flow.areaCodes = "";
  flow.step = "delivery";
  return screenReply(ctx, "Select delivery system:", Markup.inlineKeyboard([
    [Markup.button.callback("⚡ Automatic Delivery", "admin_delivery_auto")],
    [Markup.button.callback("👨‍💼 Manual Delivery", "admin_delivery_manual")],
    [Markup.button.callback("⬅️ Back", `admin_product_cat_${flow.categoryId}`)]
  ]));
});

bot.action(/^admin_delivery_(auto|manual)$/, async (ctx) => {
  if (adminOnly(ctx)) return;
  await ctx.answerCbQuery();
  const flow = ctx.session.adminFlow;
  if (!flow || flow.type !== "product" || flow.step !== "delivery") return ctx.reply("Product setup expired. Start again.");
  const result = await db.prepare("INSERT INTO products(category_id,name,price,product_type,area_codes,delivery_mode) VALUES(?,?,?,?,?,?)")
    .run(flow.categoryId, flow.name, flow.price, flow.productType, flow.areaCodes || "", ctx.match[1]);
  const product = await db.prepare("SELECT p.*,c.name category FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?").get(result.lastInsertRowid);
  await db.enqueueSheetEvent("product_upsert", product.id, product);
  const summary = `✅ Product Added\n\nID: ${result.lastInsertRowid}\nName: ${flow.name}\nPrice: $${flow.price.toFixed(2)}\nArea Codes: ${flow.areaCodes || "Skipped"}\nDelivery: ${ctx.match[1] === "auto" ? "Automatic" : "Manual"}`;
  ctx.session.adminFlow = null;
  return screenReply(ctx, summary, Markup.inlineKeyboard([
    [Markup.button.callback("📥 Add Stock", "admin_add_stock")],
    [Markup.button.callback("➕ Add Another Product", "admin_add_product")],
    [Markup.button.callback("⬅️ Admin Panel", "admin_home")]
  ]));
});

bot.action("admin_products", async (ctx) => {
  if (adminOnly(ctx)) return;
  await ctx.answerCbQuery();
  const products = await db.prepare("SELECT p.*,c.name category FROM products p JOIN categories c ON c.id=p.category_id ORDER BY p.id DESC LIMIT 40").all();
  return screenReply(ctx, products.length ? products.map((p) => `#${p.id} ${p.name}\n${p.category} | $${Number(p.price).toFixed(2)} | ${p.delivery_mode} | ${p.status}\nArea: ${p.area_codes || "None"}`).join("\n\n") : "No products found.", backButton("admin_home"));
});

bot.action("admin_add_stock", async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  const products = await db.prepare("SELECT * FROM products WHERE status='active' AND delivery_mode='auto' ORDER BY id DESC").all();
  if (!products.length) return screenReply(ctx, "No active automatic-delivery products found.", backButton("admin_home"));
  const rows = products.map((p) => [Markup.button.callback(`#${p.id} ${p.name}`, `admin_stock_product_${p.id}`)]);
  rows.push([Markup.button.callback("⬅️ Back", "admin_home")]);
  return screenReply(ctx, "Select product for stock:", Markup.inlineKeyboard(rows));
});

bot.action(/^admin_stock_product_(\d+)$/, async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  const product = await db.prepare("SELECT * FROM products WHERE id=? AND status='active'").get(ctx.match[1]);
  if (!product) return screenReply(ctx, "Product not found.", backButton("admin_add_stock"));
  const codes = String(product.area_codes || "").split(",").map((x) => x.trim()).filter(Boolean);
  ctx.session.adminFlow = { type: "stock", step: codes.length ? "area" : "data", productId: product.id, productName: product.name };
  if (codes.length) {
    const rows = codes.map((code) => [Markup.button.callback(code, `admin_stock_area_${product.id}_${code}`)]);
    rows.push([Markup.button.callback("⬅️ Back", "admin_add_stock")]);
    return screenReply(ctx, `Product: ${product.name}\n\nSelect area code:`, Markup.inlineKeyboard(rows));
  }
  return screenReply(ctx, `Product: ${product.name}\n\nSend stock data.\nSend one item per line to add multiple stock items.`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "admin_add_stock")]]));
});

bot.action(/^admin_stock_area_(\d+)_(.+)$/, async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  const product = await db.prepare("SELECT * FROM products WHERE id=?").get(ctx.match[1]);
  if (!product) return screenReply(ctx, "Product not found.", backButton("admin_add_stock"));
  ctx.session.adminFlow = { type: "stock", step: "data", productId: product.id, productName: product.name, areaCode: ctx.match[2] };
  return screenReply(ctx, `Product: ${product.name}\nArea Code: ${ctx.match[2]}\n\nSend stock data.\nSend one item per line to add multiple stock items.`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", `admin_stock_product_${product.id}`)]]));
});

bot.action("admin_manual_orders", async (ctx) => {
  if (adminOnly(ctx)) return;
  await ctx.answerCbQuery();
  const orders = await db.prepare("SELECT * FROM orders WHERE status='pending' ORDER BY id").all();
  if (!orders.length) return screenReply(ctx, "No pending manual orders.", backButton("admin_home"));
  await clearScreen(ctx);
  for (const order of orders) {
    await trackedReply(ctx, `⏳ Manual Order #${order.id}\nUser: ${order.telegram_id}\nProduct: ${order.product_name}\nQuantity: ${order.quantity}\nPaid: $${Number(order.total_price).toFixed(2)}`, Markup.inlineKeyboard([
      [Markup.button.callback("📤 Deliver", `deliver_order_${order.id}`)],
      [Markup.button.callback("⬅️ Back", "admin_home")]
    ]));
  }
});

bot.action("admin_deposits", async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  const requests = await db.prepare("SELECT * FROM fund_requests WHERE status='pending' ORDER BY id").all();
  if (!requests.length) return screenReply(ctx, "No pending deposit requests.", backButton("admin_home"));
  await clearScreen(ctx);
  for (const item of requests) {
    rememberScreen(ctx, await ctx.replyWithPhoto(item.screenshot_file_id, {
      caption: `💳 Deposit Request #${item.id}\nUser ID: ${item.telegram_id}\nAmount: $${Number(item.amount).toFixed(2)}\nMethod: ${item.method}\nTXID: ${item.txid}`,
      ...Markup.inlineKeyboard([[
        Markup.button.callback("✅ Approve", `fund_approve_${item.id}`),
        Markup.button.callback("❌ Reject", `fund_reject_${item.id}`)
      ], [Markup.button.callback("⬅️ Back", "admin_home")]])
    }));
  }
});

bot.action(/^deliver_order_(\d+)$/, async (ctx) => {
  if (adminOnly(ctx)) return;
  await ctx.answerCbQuery();
  const order = await db.prepare("SELECT * FROM orders WHERE id=? AND status='pending'").get(ctx.match[1]);
  if (!order) return screenReply(ctx, "Order is not pending or was already delivered.", backButton("admin_manual_orders"));
  ctx.session.manualDelivery = { orderId: order.id };
  return screenReply(ctx, `Send delivery details for order #${order.id}.\nThe customer will receive exactly what you send.`, backButton("admin_manual_orders"));
});

for (const [action, type] of [["admin_add_balance", "add"], ["admin_cut_balance", "cut"]]) {
  bot.action(action, async (ctx) => {
    if (adminOnly(ctx)) return;
    await ctx.answerCbQuery();
    ctx.session.adminFlow = { type: "balance", operation: type, step: "user" };
    return screenReply(ctx, "Send the customer's Telegram numeric User ID:", backButton("admin_home"));
  });
}

bot.action("admin_commands", async (ctx) => {
  if (adminOnly(ctx)) return;
  await ctx.answerCbQuery();
  return screenReply(ctx, adminText(), backButton("admin_home"));
});

async function approveFundRequest(requestId) {
  return db.transaction(async () => {
    const request = await db.prepare("SELECT * FROM fund_requests WHERE id=? AND status='pending' FOR UPDATE").get(requestId);
    if (!request) throw new Error("REQUEST_NOT_PENDING");
    const user = await db.prepare("SELECT * FROM users WHERE telegram_id=? FOR UPDATE").get(request.telegram_id);
    if (!user) throw new Error("USER_NOT_FOUND");
    const newBalance = Number(user.balance) + Number(request.amount);
    const changed = await db.prepare("UPDATE fund_requests SET status='approved',reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(requestId);
    if (!changed.changes) throw new Error("REQUEST_NOT_PENDING");
    await db.prepare("UPDATE users SET balance=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(newBalance, request.telegram_id);
    await db.prepare("INSERT INTO balance_logs(telegram_id,type,amount,old_balance,new_balance,reason) VALUES(?,?,?,?,?,?)")
      .run(request.telegram_id, "add", request.amount, user.balance, newBalance, `Fund request #${requestId}`);
    const updatedUser = await db.prepare("SELECT * FROM users WHERE telegram_id=?").get(request.telegram_id);
    const updatedRequest = await db.prepare("SELECT f.*,u.username FROM fund_requests f JOIN users u ON u.telegram_id=f.telegram_id WHERE f.id=?").get(requestId);
    await db.enqueueSheetEvent("user_upsert", updatedUser.telegram_id, updatedUser);
    await db.enqueueSheetEvent("deposit_upsert", updatedRequest.id, updatedRequest);
    return { request, newBalance };
  })();
}

async function rejectFundRequest(requestId) {
  return db.transaction(async () => {
    const request = await db.prepare("SELECT * FROM fund_requests WHERE id=? AND status='pending' FOR UPDATE").get(requestId);
    if (!request) throw new Error("REQUEST_NOT_PENDING");
    const changed = await db.prepare("UPDATE fund_requests SET status='rejected',reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(requestId);
    if (!changed.changes) throw new Error("REQUEST_NOT_PENDING");
    const updated = await db.prepare("SELECT f.*,u.username FROM fund_requests f JOIN users u ON u.telegram_id=f.telegram_id WHERE f.id=?").get(requestId);
    await db.enqueueSheetEvent("deposit_upsert", updated.id, updated);
    return request;
  })();
}

bot.action(/^fund_approve_(\d+)$/, async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  try {
    const result = await approveFundRequest(Number(ctx.match[1]));
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await bot.telegram.sendMessage(result.request.telegram_id, `✅ Deposit Approved\n\nRequest ID: ${result.request.id}\nAmount: $${Number(result.request.amount).toFixed(2)}\nNew Balance: $${result.newBalance.toFixed(2)}`).catch(() => {});
    return screenReply(ctx, `✅ Request #${result.request.id} approved.`, backButton("admin_deposits"));
  } catch { return screenReply(ctx, "This request is not pending or was already reviewed.", backButton("admin_deposits")); }
});

bot.action(/^fund_reject_(\d+)$/, async (ctx) => {
  if (adminOnly(ctx)) return;
  await safeAnswer(ctx);
  try {
    const request = await rejectFundRequest(Number(ctx.match[1]));
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await bot.telegram.sendMessage(request.telegram_id, `❌ Deposit Rejected\n\nRequest ID: ${request.id}\nAmount: $${Number(request.amount).toFixed(2)}\nPlease contact support if you need help.`).catch(() => {});
    return screenReply(ctx, `❌ Request #${request.id} rejected.`, backButton("admin_deposits"));
  } catch { return screenReply(ctx, "This request is not pending or was already reviewed.", backButton("admin_deposits")); }
});

bot.on("photo", async (ctx) => {
  const f = ctx.session?.fund;
  if (!f || f.step !== "screenshot") return;
  const fileId = ctx.message.photo.at(-1).file_id;
  const result = await db.prepare("INSERT INTO fund_requests (telegram_id, amount, method, txid, screenshot_file_id) VALUES (?, ?, ?, ?, ?)").run(String(ctx.from.id), f.amount, f.method, f.txid, fileId);
  const request = await db.prepare("SELECT f.*,u.username FROM fund_requests f JOIN users u ON u.telegram_id=f.telegram_id WHERE f.id=?").get(result.lastInsertRowid);
  await db.enqueueSheetEvent("deposit_upsert", request.id, request);
  ctx.session.fund = null;
  await screenReply(ctx, `✅ Payment proof submitted.\n\nRequest ID: ${result.lastInsertRowid}\nAmount: $${Number(f.amount).toFixed(2)}\nStatus: Pending admin review`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Main Menu", "back_main")]]));
  for (const id of config.adminIds) {
    await bot.telegram.sendPhoto(id, fileId, {
      caption: `💳 New Deposit Request #${result.lastInsertRowid}\nUser: @${ctx.from.username || "N/A"}\nUser ID: ${ctx.from.id}\nAmount: $${Number(f.amount).toFixed(2)}\nMethod: ${f.method}\nTXID: ${f.txid}`,
      ...Markup.inlineKeyboard([[
        Markup.button.callback("✅ Approve", `fund_approve_${result.lastInsertRowid}`),
        Markup.button.callback("❌ Reject", `fund_reject_${result.lastInsertRowid}`)
      ]])
    });
  }
});

bot.on("text", async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/") || ["👤 My Profile", "💰 Add Fund", "🛒 Buy Product", "📦 My Orders", "🆘 Support", "🛠 Admin Panel"].includes(text)) return next();

  if (isAdmin(ctx) && ctx.session?.manualDelivery) {
    const orderId = ctx.session.manualDelivery.orderId;
    const order = await db.transaction(async () => {
      const pending = await db.prepare("SELECT * FROM orders WHERE id=? AND status='pending' FOR UPDATE").get(orderId);
      if (!pending) return null;
      await db.prepare("UPDATE orders SET delivered_data=?,status='completed',delivered_at=CURRENT_TIMESTAMP WHERE id=?").run(text, orderId);
      const deliveryResult = await db.prepare("INSERT INTO deliveries(order_id,stock_id,telegram_id,product_id,product_name,area_code,delivered_data,delivery_mode) VALUES(?,?,?,?,?,?,?,?)")
        .run(pending.id, null, pending.telegram_id, pending.product_id, pending.product_name, pending.area_code, text, "manual");
      const completed = await db.prepare("SELECT o.*,u.username FROM orders o JOIN users u ON u.telegram_id=o.telegram_id WHERE o.id=?").get(orderId);
      const delivery = await db.prepare("SELECT d.*,u.username FROM deliveries d JOIN users u ON u.telegram_id=d.telegram_id WHERE d.id=?").get(deliveryResult.lastInsertRowid);
      await db.enqueueSheetEvent("order_upsert", completed.id, completed);
      await db.enqueueSheetEvent("delivery_upsert", delivery.id, delivery);
      return completed;
    })();
    if (!order) { ctx.session.manualDelivery = null; return screenReply(ctx, "Order is no longer pending.", backButton("admin_manual_orders")); }
    ctx.session.manualDelivery = null;
    await bot.telegram.sendMessage(order.telegram_id, `✅ Order Delivered\n\nOrder ID: ${order.id}\nProduct: ${order.product_name}\nQuantity: ${order.quantity}\n\nYour Product Details:\n${text}`).catch(() => {});
    return screenReply(ctx, `✅ Order #${order.id} delivered successfully.`, backButton("admin_home"));
  }

  const af = ctx.session?.adminFlow;
  if (isAdmin(ctx) && af?.type === "category" && af.step === "name") {
    try {
      const result = await db.prepare("INSERT INTO categories(name) VALUES(?)").run(text);
      ctx.session.adminFlow = null;
      return screenReply(ctx, `✅ Category added. ID: ${result.lastInsertRowid}`, Markup.inlineKeyboard([
        [Markup.button.callback("➕ Add Product", "admin_add_product")],
        [Markup.button.callback("⬅️ Admin Panel", "admin_home")]
      ]));
    } catch { return screenReply(ctx, "This category already exists. Send another name:", backButton("admin_home")); }
  }
  if (isAdmin(ctx) && af?.type === "product" && af.step === "name") {
    af.name = text;
    af.step = "price";
    return screenReply(ctx, "Send product price in USD. Example: 2.50", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", `admin_product_cat_${af.categoryId}`)]]));
  }
  if (isAdmin(ctx) && af?.type === "product" && af.step === "price") {
    const price = Number(text);
    if (!(price >= 0)) return screenReply(ctx, "Send a valid price. Example: 2.50", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", `admin_product_cat_${af.categoryId}`)]]));
    af.price = price;
    af.step = "area_choice";
    return screenReply(ctx, "Does this product need area codes?", areaChoiceKeyboard(af));
  }
  if (isAdmin(ctx) && af?.type === "product" && af.step === "area_codes") {
    const codes = [...new Set(text.split(",").map((x) => x.trim()).filter(Boolean))];
    if (!codes.length) return screenReply(ctx, "Send at least one area code, separated by commas.", backButton(`admin_product_cat_${af.categoryId}`));
    af.productType = "area";
    af.areaCodes = codes.join(", ");
    af.step = "delivery";
    return screenReply(ctx, `Area Codes: ${af.areaCodes}\n\nSelect delivery system:`, Markup.inlineKeyboard([
      [Markup.button.callback("⚡ Automatic Delivery", "admin_delivery_auto")],
      [Markup.button.callback("👨‍💼 Manual Delivery", "admin_delivery_manual")],
      [Markup.button.callback("⬅️ Back", `admin_product_cat_${af.categoryId}`)]
    ]));
  }
  if (isAdmin(ctx) && af?.type === "stock" && af.step === "data") {
    const items = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!items.length) return screenReply(ctx, "Send valid stock data, one item per line.", backButton("admin_add_stock"));
    const insert = db.prepare("INSERT INTO stocks(product_id,stock_data,area_code) VALUES(?,?,?)");
    await db.transaction(async () => {
      for (const item of items) {
        const result = await insert.run(af.productId, item, af.areaCode || null);
        const stock = await db.prepare("SELECT s.*,p.name product_name FROM stocks s JOIN products p ON p.id=s.product_id WHERE s.id=?").get(result.lastInsertRowid);
        await db.enqueueSheetEvent("stock_upsert", stock.id, stock);
      }
    })();
    const label = af.productName;
    const area = af.areaCode;
    ctx.session.adminFlow = null;
    return screenReply(ctx, `✅ ${items.length} stock item(s) added.\nProduct: ${label}${area ? `\nArea Code: ${area}` : ""}`, Markup.inlineKeyboard([
      [Markup.button.callback("📥 Add More Stock", `admin_stock_product_${af.productId}`)],
      [Markup.button.callback("⬅️ Admin Panel", "admin_home")]
    ]));
  }
  if (isAdmin(ctx) && af?.type === "balance" && af.step === "user") {
    if (!/^\d+$/.test(text)) return screenReply(ctx, "Send a valid numeric Telegram User ID:", backButton("admin_home"));
    const user = await db.prepare("SELECT * FROM users WHERE telegram_id=?").get(text);
    if (!user) return screenReply(ctx, "User not found. The user must start the bot first. Send another User ID:", backButton("admin_home"));
    af.userId = text;
    af.step = "amount";
    return screenReply(ctx, `Current balance: $${Number(user.balance).toFixed(2)}\n\nSend the amount in USD:`, backButton("admin_home"));
  }
  if (isAdmin(ctx) && af?.type === "balance" && af.step === "amount") {
    const amount = Number(text);
    if (!(amount > 0)) return screenReply(ctx, "Send a valid amount greater than 0:", backButton("admin_home"));
    const target = af.userId;
    const operation = af.operation;
    const newBalance = await db.transaction(async () => {
      const user = await db.prepare("SELECT * FROM users WHERE telegram_id=? FOR UPDATE").get(target);
      if (!user) throw new Error("USER_NOT_FOUND");
      const nextBalance = operation === "add" ? Number(user.balance) + amount : Math.max(0, Number(user.balance) - amount);
      await db.prepare("UPDATE users SET balance=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(nextBalance, target);
      await db.prepare("INSERT INTO balance_logs(telegram_id,type,amount,old_balance,new_balance,reason) VALUES(?,?,?,?,?,?)")
        .run(target, operation, amount, user.balance, nextBalance, "Admin panel adjustment");
      const updated = await db.prepare("SELECT * FROM users WHERE telegram_id=?").get(target);
      await db.enqueueSheetEvent("user_upsert", updated.telegram_id, updated);
      return nextBalance;
    })();
    ctx.session.adminFlow = null;
    bot.telegram.sendMessage(target, `💰 Wallet Updated\nNew balance: $${newBalance.toFixed(2)}`).catch(() => {});
    return screenReply(ctx, `✅ Wallet updated successfully.\nNew balance: $${newBalance.toFixed(2)}`, backButton("admin_home"));
  }

  const f = ctx.session?.fund;
  if (f?.step === "amount") {
    const amount = Number(text);
    if (!(amount > 0)) return screenReply(ctx, "Send a valid amount greater than 0.", backButton());
    Object.assign(f, { amount, step: "select_method" });
    return showPaymentMethods(ctx);
  }
  if (f?.step === "txid") { Object.assign(f, { txid: text, step: "screenshot" }); return screenReply(ctx, "Now send the payment screenshot as a photo.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back to Payment", `fund_method_${f.methodKey}`)]])); }
  const b = ctx.session?.buy;
  if (b?.step === "quantity") return purchase(ctx, b, Number(text));
  return next();
});

async function purchase(ctx, pending, quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) return screenReply(ctx, "Send a valid whole-number quantity.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", `product_${pending.productId}`)]]));
  const p = await db.prepare("SELECT * FROM products WHERE id=? AND status='active'").get(pending.productId);
  if (!p) return screenReply(ctx, "Product is no longer available.", backButton("back_categories"));
  const user = await getUser(ctx);
  const total = Number(p.price) * quantity;
  if (Number(user.balance) < total) return screenReply(ctx, `Insufficient balance. Required: $${total.toFixed(2)}`, Markup.inlineKeyboard([
    [Markup.button.callback("💰 Add Fund", "fund_back_amount")],
    [Markup.button.callback("⬅️ Back", `product_${p.id}`)]
  ]));
  if (p.delivery_mode === "manual") {
    let result;
    try {
      result = await db.transaction(async () => {
        const fresh = await db.prepare("SELECT * FROM users WHERE telegram_id=? FOR UPDATE").get(String(ctx.from.id));
        if (Number(fresh.balance) < total) throw new Error("BALANCE");
        const nextBalance = Number(fresh.balance) - total;
        await db.prepare("UPDATE users SET balance=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(nextBalance, String(ctx.from.id));
        const orderName = pending.areaCode ? `${p.name} - ${pending.areaCode}` : p.name;
        const order = await db.prepare("INSERT INTO orders (telegram_id,product_id,product_name,area_code,quantity,unit_price,total_price,delivery_mode,delivered_data,status) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(String(ctx.from.id), p.id, orderName, pending.areaCode || null, quantity, p.price, total, "manual", "", "pending");
        await db.prepare("INSERT INTO balance_logs(telegram_id,type,amount,old_balance,new_balance,reason) VALUES(?,?,?,?,?,?)")
          .run(String(ctx.from.id), "cut", total, fresh.balance, nextBalance, `Manual order #${order.lastInsertRowid}`);
        const savedOrder = await db.prepare("SELECT o.*,u.username FROM orders o JOIN users u ON u.telegram_id=o.telegram_id WHERE o.id=?").get(order.lastInsertRowid);
        const updatedUser = await db.prepare("SELECT * FROM users WHERE telegram_id=?").get(String(ctx.from.id));
        await db.enqueueSheetEvent("order_upsert", savedOrder.id, savedOrder);
        await db.enqueueSheetEvent("user_upsert", updatedUser.telegram_id, updatedUser);
        return { id: order.lastInsertRowid, nextBalance };
      })();
    } catch (error) {
      if (error.message === "BALANCE") return screenReply(ctx, "Insufficient balance.", Markup.inlineKeyboard([[Markup.button.callback("💰 Add Fund", "fund_back_amount")], [Markup.button.callback("⬅️ Back", `product_${p.id}`)]]));
      throw error;
    }
    ctx.session.buy = null;
    await screenReply(ctx, `⏳ Order Submitted for Manual Delivery\n\nOrder ID: ${result.id}\nProduct: ${p.name}${pending.areaCode ? `\nArea Code: ${pending.areaCode}` : ""}\nQuantity: ${quantity}\nPaid: $${total.toFixed(2)}\nRemaining Balance: $${result.nextBalance.toFixed(2)}\n\nAdmin will deliver your product shortly.`, backButton());
    for (const id of config.adminIds) {
      await bot.telegram.sendMessage(id, `🚚 New Manual Order #${result.id}\nUser: @${ctx.from.username || "N/A"}\nUser ID: ${ctx.from.id}\nProduct: ${p.name}${pending.areaCode ? `\nArea Code: ${pending.areaCode}` : ""}\nQuantity: ${quantity}\nPaid: $${total.toFixed(2)}`, Markup.inlineKeyboard([[Markup.button.callback("📤 Deliver Now", `deliver_order_${result.id}`)]]));
    }
    return;
  }
  const where = pending.areaCode ? "product_id=? AND status='available' AND area_code=?" : "product_id=? AND status='available'";
  const args = pending.areaCode ? [p.id, pending.areaCode, quantity] : [p.id, quantity];
  let done;
  try {
    done = await db.transaction(async () => {
      const fresh = await db.prepare("SELECT * FROM users WHERE telegram_id=? FOR UPDATE").get(String(ctx.from.id));
      if (Number(fresh.balance) < total) throw new Error("BALANCE");
      const stock = await db.prepare(`SELECT * FROM stocks WHERE ${where} ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`).all(...args);
      if (stock.length < quantity) {
        const error = new Error("OUT_OF_STOCK");
        error.available = stock.length;
        throw error;
      }
      const nextBalance = Number(fresh.balance) - total;
      await db.prepare("UPDATE users SET balance=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(nextBalance, String(ctx.from.id));
      const mark = db.prepare("UPDATE stocks SET status='sold',sold_to=?,sold_at=CURRENT_TIMESTAMP WHERE id=? AND status='available'");
      const delivered = stock.map((s) => s.stock_data).join("\n");
      const order = await db.prepare("INSERT INTO orders (telegram_id,product_id,product_name,area_code,quantity,unit_price,total_price,delivery_mode,delivered_data,status,delivered_at) VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
        .run(String(ctx.from.id), p.id, p.name, pending.areaCode || null, quantity, p.price, total, "auto", delivered, "completed");
      await db.prepare("INSERT INTO balance_logs(telegram_id,type,amount,old_balance,new_balance,reason) VALUES(?,?,?,?,?,?)")
        .run(String(ctx.from.id), "cut", total, fresh.balance, nextBalance, `Automatic order #${order.lastInsertRowid}`);
      for (const item of stock) {
        await mark.run(String(ctx.from.id), item.id);
        const deliveryResult = await db.prepare("INSERT INTO deliveries(order_id,stock_id,telegram_id,product_id,product_name,area_code,delivered_data,delivery_mode) VALUES(?,?,?,?,?,?,?,?)")
          .run(order.lastInsertRowid, item.id, String(ctx.from.id), p.id, p.name, pending.areaCode || item.area_code || null, item.stock_data, "auto");
        const soldStock = await db.prepare("SELECT s.*,p.name product_name FROM stocks s JOIN products p ON p.id=s.product_id WHERE s.id=?").get(item.id);
        const delivery = await db.prepare("SELECT d.*,u.username FROM deliveries d JOIN users u ON u.telegram_id=d.telegram_id WHERE d.id=?").get(deliveryResult.lastInsertRowid);
        await db.enqueueSheetEvent("stock_upsert", soldStock.id, soldStock);
        await db.enqueueSheetEvent("delivery_upsert", delivery.id, delivery);
      }
      const savedOrder = await db.prepare("SELECT o.*,u.username FROM orders o JOIN users u ON u.telegram_id=o.telegram_id WHERE o.id=?").get(order.lastInsertRowid);
      const updatedUser = await db.prepare("SELECT * FROM users WHERE telegram_id=?").get(String(ctx.from.id));
      await db.enqueueSheetEvent("order_upsert", savedOrder.id, savedOrder);
      await db.enqueueSheetEvent("user_upsert", updatedUser.telegram_id, updatedUser);
      return { id: order.lastInsertRowid, delivered, nextBalance };
    })();
  } catch (error) {
    if (error.message === "OUT_OF_STOCK") return screenReply(ctx, `Not enough stock. Available: ${error.available || 0}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", `product_${p.id}`)]]));
    if (error.message === "BALANCE") return screenReply(ctx, "Insufficient balance.", Markup.inlineKeyboard([[Markup.button.callback("💰 Add Fund", "fund_back_amount")], [Markup.button.callback("⬅️ Back", `product_${p.id}`)]]));
    throw error;
  }
  ctx.session.buy = null;
  await screenReply(ctx, `✅ Order Successful\n\nOrder ID: ${done.id}\nProduct: ${p.name}${pending.areaCode ? `\nArea Code: ${pending.areaCode}` : ""}\nQuantity: ${quantity}\nTotal: $${total.toFixed(2)}\nRemaining Balance: $${done.nextBalance.toFixed(2)}\n\nYour Products:\n${done.delivered}`, backButton());
  for (const id of config.adminIds) await bot.telegram.sendMessage(id, `🛒 New Order #${done.id}\nUser ID: ${ctx.from.id}\nProduct: ${p.name}\nQuantity: ${quantity}\nTotal: $${total.toFixed(2)}`);
}

function adminText() {
  return `🛠 Admin Commands\n\nMost work is available from Admin Panel buttons.\n\n/addcategory Name\n/categories\n/addproduct CATEGORY_ID | Name | Price | normal/area | auto/manual\n/products\n/productstatus PRODUCT_ID | active/inactive\n/deleteproduct PRODUCT_ID\n/addstock PRODUCT_ID | Stock data\n/addstock PRODUCT_ID | AREA_CODE | Stock data\n/stocks PRODUCT_ID\n/deletestock STOCK_ID\n/approve REQUEST_ID\n/reject REQUEST_ID\n/addbalance USER_ID AMOUNT\n/cutbalance USER_ID AMOUNT\n/block USER_ID\n/unblock USER_ID\n/orders\n/syncstatus\n/syncall\n/broadcast Message`;
}

bot.command("admin", (ctx) => adminOnly(ctx) || showAdmin(ctx));
bot.command("addcategory", async (ctx) => {
  if (adminOnly(ctx)) return;
  const name = ctx.message.text.replace(/^\/addcategory(@\w+)?\s*/i, "").trim();
  if (!name) return ctx.reply("Usage: /addcategory Name");
  try { const result = await db.prepare("INSERT INTO categories(name) VALUES(?)").run(name); return ctx.reply(`Category added. ID: ${result.lastInsertRowid}`); }
  catch { return ctx.reply("Category already exists or is invalid."); }
});
bot.command("categories", async (ctx) => {
  if (adminOnly(ctx)) return;
  const rows = await db.prepare("SELECT * FROM categories ORDER BY id").all();
  return ctx.reply(rows.length ? rows.map((x) => `${x.id}. ${x.name} [${x.status}]`).join("\n") : "No categories.");
});
bot.command("addproduct", async (ctx) => {
  if (adminOnly(ctx)) return;
  const raw = ctx.message.text.replace(/^\/addproduct(@\w+)?\s*/i, "");
  const [categoryId, name, price, type="normal", delivery="auto"] = raw.split("|").map((x) => x.trim());
  if (!categoryId || !name || !(Number(price) >= 0) || !["normal","area"].includes(type) || !["auto","manual"].includes(delivery)) return ctx.reply("Usage: /addproduct CATEGORY_ID | Name | Price | normal/area | auto/manual");
  try {
    const result = await db.prepare("INSERT INTO products(category_id,name,price,product_type,delivery_mode) VALUES(?,?,?,?,?)").run(Number(categoryId), name, Number(price), type, delivery);
    const product = await db.prepare("SELECT p.*,c.name category FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?").get(result.lastInsertRowid);
    await db.enqueueSheetEvent("product_upsert", product.id, product);
    return ctx.reply(`Product added. ID: ${result.lastInsertRowid}`);
  } catch (error) { return ctx.reply(`Could not add product: ${error.message}`); }
});
bot.command("products", async (ctx) => {
  if (adminOnly(ctx)) return;
  const rows = await db.prepare("SELECT p.*,c.name category,(SELECT COUNT(*) FROM stocks s WHERE s.product_id=p.id AND s.status='available') stock FROM products p JOIN categories c ON c.id=p.category_id ORDER BY p.id").all();
  return ctx.reply(rows.length ? rows.map((x) => `${x.id}. ${x.name} | ${x.category} | $${x.price} | ${x.delivery_mode} | ${x.status} | Stock ${x.stock}`).join("\n") : "No products.");
});
bot.command("productstatus", async (ctx) => {
  if (adminOnly(ctx)) return;
  const [id, status] = ctx.message.text.replace(/^\/productstatus(@\w+)?\s*/i, "").split("|").map((x) => x.trim());
  if (!id || !["active","inactive"].includes(status)) return ctx.reply("Usage: /productstatus PRODUCT_ID | active/inactive");
  const result = await db.prepare("UPDATE products SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, Number(id));
  if (result.changes) { const product = await db.prepare("SELECT p.*,c.name category FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?").get(Number(id)); await db.enqueueSheetEvent("product_upsert", product.id, product); }
  return ctx.reply(result.changes ? "Product updated." : "Product not found.");
});
bot.command("deleteproduct", async (ctx) => {
  if (adminOnly(ctx)) return;
  const id = Number(ctx.message.text.split(/\s+/)[1]);
  if (!id) return ctx.reply("Usage: /deleteproduct PRODUCT_ID");
  const result = await db.prepare("UPDATE products SET status='deleted',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  if (result.changes) { const product = await db.prepare("SELECT p.*,c.name category FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?").get(id); await db.enqueueSheetEvent("product_upsert", product.id, product); }
  return ctx.reply(result.changes ? "Product removed." : "Product not found.");
});
bot.command("addstock", async (ctx) => {
  if (adminOnly(ctx)) return;
  const parts = ctx.message.text.replace(/^\/addstock(@\w+)?\s*/i, "").split("|").map((x) => x.trim());
  const productId = Number(parts.shift());
  const product = await db.prepare("SELECT * FROM products WHERE id=?").get(productId);
  if (!product) return ctx.reply("Product not found.");
  let areaCode = null; let data;
  if (product.product_type === "area") { areaCode = parts.shift(); data = parts.join("|").trim(); } else data = parts.join("|").trim();
  if (!data || (product.product_type === "area" && !areaCode)) return ctx.reply(product.product_type === "area" ? "Usage: /addstock PRODUCT_ID | AREA_CODE | Stock data" : "Usage: /addstock PRODUCT_ID | Stock data");
  const result = await db.prepare("INSERT INTO stocks(product_id,stock_data,area_code) VALUES(?,?,?)").run(productId, data, areaCode);
  const stock = await db.prepare("SELECT s.*,p.name product_name FROM stocks s JOIN products p ON p.id=s.product_id WHERE s.id=?").get(result.lastInsertRowid);
  await db.enqueueSheetEvent("stock_upsert", stock.id, stock);
  return ctx.reply(`Stock added. ID: ${result.lastInsertRowid}`);
});
bot.command("stocks", async (ctx) => {
  if (adminOnly(ctx)) return;
  const id = Number(ctx.message.text.split(/\s+/)[1]);
  const rows = await db.prepare("SELECT id,area_code,status,created_at FROM stocks WHERE product_id=? ORDER BY id DESC LIMIT 50").all(id);
  return ctx.reply(rows.length ? rows.map((x) => `${x.id} | Area: ${x.area_code || "N/A"} | ${x.status} | ${x.created_at}`).join("\n") : "No stock found.");
});
bot.command("deletestock", async (ctx) => {
  if (adminOnly(ctx)) return;
  const id = Number(ctx.message.text.split(/\s+/)[1]);
  const result = await db.prepare("UPDATE stocks SET status='deleted' WHERE id=? AND status='available'").run(id);
  if (result.changes) { const stock = await db.prepare("SELECT s.*,p.name product_name FROM stocks s JOIN products p ON p.id=s.product_id WHERE s.id=?").get(id); await db.enqueueSheetEvent("stock_upsert", stock.id, stock); }
  return ctx.reply(result.changes ? "Stock deleted." : "Available stock not found.");
});

async function balanceCommand(ctx, type) {
  if (adminOnly(ctx)) return;
  const [, id, amountRaw] = ctx.message.text.split(/\s+/); const amount = Number(amountRaw);
  if (!id || !(amount > 0)) return ctx.reply(`Usage: /${type === "add" ? "addbalance" : "cutbalance"} USER_ID AMOUNT`);
  let next;
  try {
    next = await db.transaction(async () => {
      const user = await db.prepare("SELECT * FROM users WHERE telegram_id=? FOR UPDATE").get(id);
      if (!user) throw new Error("USER");
      const newBalance = type === "add" ? Number(user.balance) + amount : Math.max(0, Number(user.balance) - amount);
      await db.prepare("UPDATE users SET balance=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(newBalance, id);
      await db.prepare("INSERT INTO balance_logs(telegram_id,type,amount,old_balance,new_balance,reason) VALUES(?,?,?,?,?,?)").run(id, type, amount, user.balance, newBalance, "Admin adjustment");
      const updated = await db.prepare("SELECT * FROM users WHERE telegram_id=?").get(id);
      await db.enqueueSheetEvent("user_upsert", updated.telegram_id, updated);
      return newBalance;
    })();
  } catch { return ctx.reply("User not found."); }
  await ctx.reply(`Balance updated: $${next.toFixed(2)}`);
  return bot.telegram.sendMessage(id, `Your balance was updated. New balance: $${next.toFixed(2)}`).catch(() => {});
}
bot.command("addbalance", (ctx)=>balanceCommand(ctx,"add"));
bot.command("cutbalance", (ctx)=>balanceCommand(ctx,"cut"));
bot.command("block", (ctx)=>userStatus(ctx,"blocked"));
bot.command("unblock", (ctx)=>userStatus(ctx,"active"));
async function userStatus(ctx, status) {
  if (adminOnly(ctx)) return;
  const id = ctx.message.text.split(/\s+/)[1];
  const result = await db.prepare("UPDATE users SET status=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").run(status, id);
  if (result.changes) { const user = await db.prepare("SELECT * FROM users WHERE telegram_id=?").get(id); await db.enqueueSheetEvent("user_upsert", user.telegram_id, user); }
  return ctx.reply(result.changes ? `User is now ${status}.` : "User not found.");
}
bot.command("approve", async (ctx) => {
  if (adminOnly(ctx)) return;
  const id = Number(ctx.message.text.split(/\s+/)[1]);
  if (!id) return ctx.reply("Usage: /approve REQUEST_ID");
  try {
    const result = await approveFundRequest(id);
    await bot.telegram.sendMessage(result.request.telegram_id, `✅ Deposit Approved\n\nRequest ID: ${id}\nAmount: $${Number(result.request.amount).toFixed(2)}\nNew Balance: $${result.newBalance.toFixed(2)}`).catch(() => {});
    return ctx.reply(`✅ Request #${id} approved.`);
  } catch { return ctx.reply("This request is not pending or was already reviewed."); }
});
bot.command("reject", async (ctx) => {
  if (adminOnly(ctx)) return;
  const id = Number(ctx.message.text.split(/\s+/)[1]);
  if (!id) return ctx.reply("Usage: /reject REQUEST_ID");
  try {
    const request = await rejectFundRequest(id);
    await bot.telegram.sendMessage(request.telegram_id, `❌ Deposit Rejected\n\nRequest ID: ${id}\nAmount: $${Number(request.amount).toFixed(2)}`).catch(() => {});
    return ctx.reply(`❌ Request #${id} rejected.`);
  } catch { return ctx.reply("This request is not pending or was already reviewed."); }
});
bot.command("orders", async (ctx) => { if (adminOnly(ctx)) return; const rows = await db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 30").all(); return ctx.reply(rows.length ? rows.map((o) => `#${o.id} | User ${o.telegram_id} | ${o.product_name} x${o.quantity} | $${Number(o.total_price).toFixed(2)}`).join("\n") : "No orders."); });
bot.command("syncstatus", async (ctx) => { if (adminOnly(ctx)) return; return ctx.reply(await sheetStatusText()); });
bot.command("syncall", async (ctx) => { if (adminOnly(ctx)) return; try { const count = await queueFullSync(); return ctx.reply(`Full Sheet sync queued: ${count} record(s).`); } catch (error) { return ctx.reply(`Full sync failed: ${error.message}`); } });
bot.command("broadcast", async (ctx) => { if (adminOnly(ctx)) return; const msg = ctx.message.text.replace(/^\/broadcast(@\w+)?\s*/i, "").trim(); if (!msg) return ctx.reply("Usage: /broadcast Message"); const users = await db.prepare("SELECT telegram_id FROM users WHERE status='active'").all(); let sent = 0; for (const user of users) { try { await bot.telegram.sendMessage(user.telegram_id, msg); sent += 1; } catch {} } return ctx.reply(`Broadcast sent to ${sent}/${users.length} users.`); });

bot.catch((error) => console.error("Bot error:", error));
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, bot: "Global Digits", database: "PostgreSQL" }));
});

async function start() {
  console.log("Connecting to PostgreSQL...");
  await db.initialize();
  console.log("PostgreSQL is ready.");
  await startSheetWorker().catch((error) => {
    console.error("Google Sheet startup failed; bot will continue and retry after configuration is fixed:", error.message);
  });
  await bot.launch();
  server.listen(config.port, () => console.log(`Global Digits Bot is running on port ${config.port}.`));
}

async function shutdown(signal) {
  stopSheetWorker();
  bot.stop(signal);
  server.close();
  await db.close().catch(() => {});
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
start().catch((error) => {
  console.error("Startup failed:", error.message);
  process.exit(1);
});
