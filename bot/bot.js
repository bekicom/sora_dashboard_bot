require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const API = axios.create({
  baseURL: process.env.API_BASE_URL || "http://localhost:8072/api",
  timeout: 20000,
});

// =====================
// AUTH (PASSWORD GATE)
// =====================
const BOT_PASSWORD = String(process.env.BOT_PASSWORD || "3322");
const authState = new Map(); // chatId -> { authorized: true/false }

function isAuthorized(chatId) {
  return authState.get(chatId)?.authorized === true;
}

// =====================
// BRANCH LABELS (UI)
// =====================
const BRANCH_LABELS = {
  branch1: "NAVOIY",
  branch2: "DOSTLIK",
  branch3: "TORQOR",
};
function branchLabel(branchKey) {
  return BRANCH_LABELS[branchKey] || branchKey;
}

// =====================
// CHAT STATE
// =====================
// chatId -> { branch, from, to, mode, products:{category,page,limit} }
const chatState = new Map();

function ymd(date) {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(ymdStr, deltaDays) {
  const [Y, M, D] = ymdStr.split("-").map(Number);
  const dt = new Date(Date.UTC(Y, M - 1, D));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return ymd(dt);
}

function todayYMD() {
  return ymd(new Date());
}

function setDefaultState(chatId) {
  const t = todayYMD();
  if (!chatState.has(chatId)) {
    chatState.set(chatId, {
      branch: "branch1",
      from: t,
      to: t,
      mode: "day", // day | range | year
      products: { category: null, page: 1, limit: 10 },
    });
    return;
  }
  const st = chatState.get(chatId) || {};
  if (!st.branch) st.branch = "branch1";
  if (!st.from) st.from = t;
  if (!st.to) st.to = t;
  if (!st.mode) st.mode = "day";
  if (!st.products) st.products = { category: null, page: 1, limit: 10 };
  if (typeof st.products.page !== "number") st.products.page = 1;
  if (typeof st.products.limit !== "number") st.products.limit = 10;
  chatState.set(chatId, st);
}

function getState(chatId) {
  setDefaultState(chatId);
  return chatState.get(chatId);
}

function setRange(chatId, from, to, mode = "range") {
  const st = getState(chatId);
  st.from = from;
  st.to = to;
  st.mode = mode;
  // products pagination reset
  st.products.page = 1;
  chatState.set(chatId, st);
}

function formatMoney(n) {
  const x = Math.round(Number(n || 0));
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function isValidYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

function formatRange(st) {
  if (st.from === st.to) return st.from;
  return `${st.from} → ${st.to}`;
}

// =====================
// HELPERS (salary %)
// =====================
function calcPercent(amount, percent) {
  const a = Number(amount || 0);
  const p = Number(percent || 0);
  if (!Number.isFinite(a) || !Number.isFinite(p)) return 0;
  return (a * p) / 100;
}

// =====================
// UI
// =====================
function mainMenu(chatId) {
  const st = getState(chatId);
  const branch = st.branch;
  const rangeText = formatRange(st);

  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: `🏢 Filial: ${branchLabel(branch)}`,
            callback_data: "BRANCH_MENU",
          },
        ],
        [{ text: `📅 Sana: ${rangeText}`, callback_data: "DATE_MENU" }],

        [
          { text: "📊 Hisobot", callback_data: "SUMMARY" },
          { text: "👨‍🍳 Ofitsiantlar", callback_data: "WAITERS" },
        ],
        [
          { text: "🍽 Top taomlar", callback_data: "TOP_PRODUCTS" },
          { text: "📦 Mahsulotlar", callback_data: "PRODUCTS_MENU" },
        ],
      ],
    },
  };
}

function branchMenu(chatId) {
  const st = getState(chatId);
  const cur = st.branch;

  const mark = (k, label) => (cur === k ? `✅ ${label}` : label);

  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: mark("branch1", "NAVOIY"),
            callback_data: "SET_BRANCH:branch1",
          },
        ],
        [
          {
            text: mark("branch2", "DOSTLIK"),
            callback_data: "SET_BRANCH:branch2",
          },
        ],
        [
          {
            text: mark("branch3", "TORQOR"),
            callback_data: "SET_BRANCH:branch3",
          },
        ],
        [{ text: "⬅️ Orqaga", callback_data: "BACK_MAIN" }],
      ],
    },
  };
}

function dateMenu(chatId) {
  const t = todayYMD();

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🟦 Bugun", callback_data: `SET_RANGE:DAY:${t}:${t}` },
          {
            text: "🕘 Kecha",
            callback_data: `SET_RANGE:DAY:${addDays(t, -1)}:${addDays(t, -1)}`,
          },
        ],
        [
          {
            text: "7 kun",
            callback_data: `SET_RANGE:RANGE:${addDays(t, -6)}:${t}`,
          },
          {
            text: "15 kun",
            callback_data: `SET_RANGE:RANGE:${addDays(t, -14)}:${t}`,
          },
          {
            text: "30 kun",
            callback_data: `SET_RANGE:RANGE:${addDays(t, -29)}:${t}`,
          },
        ],
        [
          {
            text: "Yillik",
            callback_data: `SET_RANGE:YEAR:${t.slice(0, 4)}-01-01:${t.slice(
              0,
              4
            )}-12-31`,
          },
        ],
        [{ text: "✍️ Sana yuborish", callback_data: "DATE_HELP" }],
        [{ text: "⬅️ Orqaga", callback_data: "BACK_MAIN" }],
      ],
    },
  };
}

function productsMenu(chatId) {
  const st = getState(chatId);
  const cat = st.products.category ? st.products.category : "Barchasi";

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `🏷 Category: ${cat}`, callback_data: "CATEGORIES" }],
        [
          { text: "📄 Ro'yxat (page)", callback_data: "PRODUCTS_PAGE" },
          { text: "🔝 Top 10", callback_data: "PRODUCTS_TOP10" },
        ],
        [{ text: "⬅️ Orqaga", callback_data: "BACK_MAIN" }],
      ],
    },
  };
}

function productsPager(chatId, meta) {
  const st = getState(chatId);
  const page = meta?.page ?? st.products.page;
  const pages = meta?.pages ?? 1;

  const prevDisabled = page <= 1;
  const nextDisabled = page >= pages;

  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: prevDisabled ? "⬅️" : "⬅️ Oldingi",
            callback_data: prevDisabled ? "NOOP" : "PRODUCTS_PREV",
          },
          { text: `📄 ${page}/${pages}`, callback_data: "NOOP" },
          {
            text: nextDisabled ? "➡️" : "Keyingi ➡️",
            callback_data: nextDisabled ? "NOOP" : "PRODUCTS_NEXT",
          },
        ],
        [{ text: "🏷 Category tanlash", callback_data: "CATEGORIES" }],
        [{ text: "⬅️ Orqaga", callback_data: "PRODUCTS_MENU" }],
      ],
    },
  };
}

// =====================
// API wrappers
// =====================
async function apiSummary(branch, from, to) {
  const res = await API.get("/reports/summary", {
    params: { branch, from, to },
  });
  return res.data?.data;
}

async function apiWaiters(branch, from, to, page = 1, limit = 10) {
  const res = await API.get("/reports/waiters", {
    params: { branch, from, to, page, limit },
  });
  return res.data;
}

async function apiTopProducts(branch, from, to, limit = 10, category = null) {
  const params = { branch, from, to, limit };
  if (category) params.category = category;
  const res = await API.get("/reports/top-products", { params });
  return res.data;
}

async function apiCategories(branch, from, to) {
  const res = await API.get("/reports/categories", {
    params: { branch, from, to },
  });
  return res.data;
}

async function apiProducts(branch, from, to, page, limit, category = null) {
  const params = { branch, from, to, page, limit };
  if (category) params.category = category;
  const res = await API.get("/reports/products", { params });
  return res.data;
}

// =====================
// COMMANDS
// =====================
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  authState.set(chatId, { authorized: false });
  setDefaultState(chatId);
  return bot.sendMessage(chatId, "🔐 Botga kirish uchun parolni yuboring:");
});

bot.onText(/^\/logout$/, async (msg) => {
  const chatId = msg.chat.id;
  authState.set(chatId, { authorized: false });
  return bot.sendMessage(
    chatId,
    "🔒 Siz tizimdan chiqdingiz. Parolni qayta yuboring:"
  );
});

// =====================
// CALLBACKS
// =====================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  try {
    if (!isAuthorized(chatId)) {
      await bot.answerCallbackQuery(q.id, { text: "Avval parol kiriting" });
      return bot.sendMessage(
        chatId,
        "🔐 Avval parolni kiriting. /start bosing.",
      );
    }

    // no-op
    if (data === "NOOP") {
      return bot.answerCallbackQuery(q.id);
    }

    if (data === "BACK_MAIN") {
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(chatId, "Asosiy menyu:", mainMenu(chatId));
    }

    // Branch menu
    if (data === "BRANCH_MENU") {
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(chatId, "Filialni tanlang:", branchMenu(chatId));
    }

    if (data.startsWith("SET_BRANCH:")) {
      const branch = data.split(":")[1];
      const st = getState(chatId);
      st.branch = branch;
      chatState.set(chatId, st);
      await bot.answerCallbackQuery(q.id, {
        text: `Filial: ${branchLabel(branch)}`,
      });
      return bot.sendMessage(
        chatId,
        `✅ Filial o‘zgardi: ${branchLabel(branch)}`,
        mainMenu(chatId),
      );
    }

    // Date menu
    if (data === "DATE_MENU") {
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(chatId, "📅 Tez filtrlar:", dateMenu(chatId));
    }

    if (data === "DATE_HELP") {
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(
        chatId,
        `✍️ Sana yuborish:\n` +
          `1) Bitta kun: 2025-09-26\n` +
          `2) Oraliq: 2025-09-01 2025-09-30 (ikki sana orasiga bo'sh joy)\n\n` +
          `Format: YYYY-MM-DD`,
      );
    }

    if (data.startsWith("SET_RANGE:")) {
      // SET_RANGE:TYPE:from:to
      const parts = data.split(":");
      const type = parts[1];
      const from = parts[2];
      const to = parts[3];

      setRange(
        chatId,
        from,
        to,
        type === "YEAR" ? "year" : type === "DAY" ? "day" : "range",
      );

      await bot.answerCallbackQuery(q.id, {
        text: `Sana: ${from === to ? from : `${from}→${to}`}`,
      });
      return bot.sendMessage(
        chatId,
        `✅ Sana tanlandi: ${from === to ? from : `${from} → ${to}`}`,
        mainMenu(chatId),
      );
    }

    // SUMMARY
    // SUMMARY
    if (data === "SUMMARY") {
      const st = getState(chatId);
      await bot.answerCallbackQuery(q.id);

      const d = await apiSummary(st.branch, st.from, st.to);

      // 🔑 ofitsiantlar 10% jami hisoblash
      const waitersRes = await apiWaiters(st.branch, st.from, st.to, 1, 500);
      const waiters = waitersRes?.data || [];

      let waiters10Total = 0;

      for (const w of waiters) {
        const name = String(w.waiter_name || "").toLowerCase();
        if (name === "saboy") continue;

        const revenue = Number(w.revenueTotal || 0);
        if (!revenue) continue;

        const pure = revenue / 1.1;
        const tenPercent = pure * 0.1;

        waiters10Total += tenPercent;
      }

      waiters10Total = Math.round(waiters10Total);

      const text =
        `📊 Hisobot\n` +
        `🏢 Filial: ${branchLabel(st.branch)}\n` +
        `📅 Sana: ${formatRange(st)}\n\n` +
        `🧾 Buyurtmalar: ${d.ordersCount}\n` +
        `💰 Tushum: ${formatMoney(d.revenueTotal)}\n` +
        `🧾 O‘rtacha chek: ${formatMoney(d.avgCheck)}\n` +
        `👨‍🍳 Ofitsiantlarga ajratilgan (10%): ${formatMoney(waiters10Total)}\n\n` +
        `💵 Naqd: ${formatMoney(d.payments.cash)}\n` +
        `💳 Karta: ${formatMoney(d.payments.card)}\n` +
        `📲 Click: ${formatMoney(d.payments.click)}`;

      return bot.sendMessage(chatId, text, mainMenu(chatId));
    }


    
 if (data === "WAITERS") {
   const st = getState(chatId);
   await bot.answerCallbackQuery(q.id);

   const res = await apiWaiters(st.branch, st.from, st.to, 1, 50);
   const rows = res?.data || [];

   if (!rows.length) {
     return bot.sendMessage(
       chatId,
       "Bu sanada ofitsiantlar bo‘yicha data yo‘q.",
       mainMenu(chatId),
     );
   }

   const text =
     `👨‍🍳 Ofitsiantlar\n` +
     `🏢 ${branchLabel(st.branch)}\n` +
     `📅 ${formatRange(st)}\n\n` +
     rows
       .map((w, i) => {
         const name = String(w.waiter_name || "Noma'lum").trim();
         const isSaboy = name.toLowerCase() === "saboy";

         const revenue = Number(w.revenueTotal || 0);

         let base10 = 0;
         let salary7 = 0;

         if (!isSaboy && revenue > 0) {
           // 🔑 1️⃣ sof xizmat summasi (10% ni chiqarib tashlaymiz)
           const pureService = revenue / 1.1;

           // 🔑 2️⃣ asosiy 10%
           base10 = Math.round(pureService * 0.1);

           // 🔑 3️⃣ oylik 7% (10% dan)
           salary7 = Math.round(base10 * 0.7);
         }

         return (
           `${i + 1}) ${name}\n` +
           `🧾 ${w.ordersCount} ta | 💰 ${formatMoney(revenue)}\n` +
           `👨‍🍳 Oylik:\n` +
           ` • Asosiy (10%): ${formatMoney(base10)}\n` +
           ` • Oylik (7%): ${formatMoney(salary7)}`
         );
       })
       .join("\n\n");

   return bot.sendMessage(chatId, text, mainMenu(chatId));
 }



    // TOP PRODUCTS
    if (data === "TOP_PRODUCTS") {
      const st = getState(chatId);
      await bot.answerCallbackQuery(q.id);

      const res = await apiTopProducts(
        st.branch,
        st.from,
        st.to,
        10,
        st.products.category,
      );
      const rows = res?.data || [];

      if (!rows.length) {
        return bot.sendMessage(
          chatId,
          "Bu sanada top taomlar data yo‘q.",
          mainMenu(chatId),
        );
      }

      const text =
        `🍽 Top taomlar (Top 10)\n` +
        `🏢 ${branchLabel(st.branch)}\n` +
        `📅 ${formatRange(st)}\n` +
        `🏷 ${
          st.products.category
            ? `Category: ${st.products.category}`
            : "Category: Barchasi"
        }\n\n` +
        rows
          .map(
            (p, i) =>
              `${i + 1}) ${p.name} (${p.category_name || "-"})\n` +
              `   📦 ${p.totalQty} | 💰 ${formatMoney(p.revenueTotal)}`,
          )
          .join("\n");

      return bot.sendMessage(chatId, text, mainMenu(chatId));
    }

    // PRODUCTS MENU
    if (data === "PRODUCTS_MENU") {
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(
        chatId,
        "📦 Mahsulotlar menyusi:",
        productsMenu(chatId),
      );
    }

    // CATEGORIES (buttons)
    if (data === "CATEGORIES") {
      const st = getState(chatId);
      await bot.answerCallbackQuery(q.id);

      const catsRes = await apiCategories(st.branch, st.from, st.to);
      const cats = catsRes?.data || [];

      // Inline keyboard (chunk 2 per row)
      const rows = [];
      // "Barchasi"
      rows.push([
        {
          text: st.products.category ? "Barchasi" : "✅ Barchasi",
          callback_data: "SET_CATEGORY:__ALL__",
        },
      ]);

      for (let i = 0; i < cats.length; i += 2) {
        const a = cats[i];
        const b = cats[i + 1];

        const btnA = {
          text: st.products.category === a ? `✅ ${a}` : a,
          callback_data: `SET_CATEGORY:${a}`,
        };

        const row = [btnA];

        if (b) {
          row.push({
            text: st.products.category === b ? `✅ ${b}` : b,
            callback_data: `SET_CATEGORY:${b}`,
          });
        }

        rows.push(row);
      }

      rows.push([{ text: "⬅️ Orqaga", callback_data: "PRODUCTS_MENU" }]);

      return bot.sendMessage(chatId, "🏷 Category tanlang:", {
        reply_markup: { inline_keyboard: rows },
      });
    }

    if (data.startsWith("SET_CATEGORY:")) {
      const st = getState(chatId);
      const cat = data.split(":").slice(1).join(":");
      st.products.category = cat === "__ALL__" ? null : cat;
      st.products.page = 1;
      chatState.set(chatId, st);

      await bot.answerCallbackQuery(q.id, {
        text: `Category: ${st.products.category || "Barchasi"}`,
      });
      return bot.sendMessage(
        chatId,
        `✅ Category tanlandi: ${st.products.category || "Barchasi"}`,
        productsMenu(chatId),
      );
    }

    // PRODUCTS PAGE (list)
    if (data === "PRODUCTS_PAGE") {
      const st = getState(chatId);
      await bot.answerCallbackQuery(q.id);

      const page = st.products.page || 1;
      const limit = st.products.limit || 10;

      const res = await apiProducts(
        st.branch,
        st.from,
        st.to,
        page,
        limit,
        st.products.category,
      );
      const items = res?.data || [];
      const meta = res?.meta || { page, pages: 1, total: items.length, limit };

      if (!items.length) {
        return bot.sendMessage(
          chatId,
          "Bu sanada mahsulotlar bo‘yicha data yo‘q.",
          productsMenu(chatId),
        );
      }

      const head =
        `📦 Mahsulotlar\n` +
        `🏢 ${branchLabel(st.branch)}\n` +
        `📅 ${formatRange(st)}\n` +
        `🏷 ${
          st.products.category
            ? `Category: ${st.products.category}`
            : "Category: Barchasi"
        }\n\n`;

      const body = items
        .map(
          (x, i) =>
            `${(page - 1) * limit + (i + 1)}) ${x.name}\n` +
            `   📦 ${x.totalQty} | 💵 ${formatMoney(
              x.avgPrice,
            )} | 💰 ${formatMoney(x.revenueTotal)} | 🧾 ${x.ordersCount}`,
        )
        .join("\n");

      return bot.sendMessage(chatId, head + body, productsPager(chatId, meta));
    }

    if (data === "PRODUCTS_PREV") {
      const st = getState(chatId);
      st.products.page = Math.max((st.products.page || 1) - 1, 1);
      chatState.set(chatId, st);
      await bot.answerCallbackQuery(q.id);
      return bot
        .sendMessage(chatId, "⬅️ Oldingi sahifa:", {
          reply_markup: { inline_keyboard: [] },
        })
        .then(() =>
          bot.emit("callback_query", { ...q, data: "PRODUCTS_PAGE" }),
        );
    }

    if (data === "PRODUCTS_NEXT") {
      const st = getState(chatId);
      st.products.page = (st.products.page || 1) + 1;
      chatState.set(chatId, st);
      await bot.answerCallbackQuery(q.id);
      return bot
        .sendMessage(chatId, "➡️ Keyingi sahifa:", {
          reply_markup: { inline_keyboard: [] },
        })
        .then(() =>
          bot.emit("callback_query", { ...q, data: "PRODUCTS_PAGE" }),
        );
    }

    // PRODUCTS TOP10 (same as products endpoint but 10)
    if (data === "PRODUCTS_TOP10") {
      const st = getState(chatId);
      await bot.answerCallbackQuery(q.id);

      const res = await apiProducts(
        st.branch,
        st.from,
        st.to,
        1,
        10,
        st.products.category,
      );
      const items = res?.data || [];

      if (!items.length) {
        return bot.sendMessage(
          chatId,
          "Bu sanada mahsulotlar bo‘yicha data yo‘q.",
          productsMenu(chatId),
        );
      }

      const text =
        `📦 Mahsulotlar (Top 10)\n` +
        `🏢 ${branchLabel(st.branch)}\n` +
        `📅 ${formatRange(st)}\n` +
        `🏷 ${
          st.products.category
            ? `Category: ${st.products.category}`
            : "Category: Barchasi"
        }\n\n` +
        items
          .map(
            (x, i) =>
              `${i + 1}) ${x.name}\n` +
              `   📦 ${x.totalQty} | 💵 ${formatMoney(
                x.avgPrice,
              )} | 💰 ${formatMoney(x.revenueTotal)} | 🧾 ${x.ordersCount}`,
          )
          .join("\n");

      return bot.sendMessage(chatId, text, productsMenu(chatId));
    }

    await bot.answerCallbackQuery(q.id);
  } catch (err) {
    try {
      await bot.answerCallbackQuery(q.id, { text: "Xatolik" });
    } catch (_) {}

    const msgText =
      "❌ Xatolik yuz berdi.\n" +
      (err.response?.data?.message
        ? `message: ${err.response.data.message}\n`
        : "") +
      (err.message ? `error: ${err.message}` : "");

    return bot.sendMessage(chatId, msgText);
  }
});

// =====================
// MESSAGE (PASSWORD + DATE/RANGE)
// =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();

  if (text.startsWith("/")) return;

  setDefaultState(chatId);

  // 🔐 Parol bosqichi
  if (!isAuthorized(chatId)) {
    if (text === BOT_PASSWORD) {
      authState.set(chatId, { authorized: true });
      const st = getState(chatId);

      return bot.sendMessage(
        chatId,
        `✅ Kirish muvaffaqiyatli!\n` +
          `🏢 Filial: ${branchLabel(st.branch)}\n` +
          `📅 Sana: ${formatRange(st)}\n\n` +
          `Menyudan foydalaning yoki sana yuboring.`,
        mainMenu(chatId)
      );
    }
    return bot.sendMessage(chatId, "❌ Parol noto‘g‘ri. Qayta urinib ko‘ring:");
  }

  // 1) Bitta sana: YYYY-MM-DD
  if (isValidYMD(text)) {
    setRange(chatId, text, text, "day");
    return bot.sendMessage(
      chatId,
      `✅ Sana tanlandi: ${text}`,
      mainMenu(chatId)
    );
  }

  // 2) Oraliq: "YYYY-MM-DD YYYY-MM-DD"
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 2 && isValidYMD(parts[0]) && isValidYMD(parts[1])) {
    const from = parts[0];
    const to = parts[1];
    setRange(chatId, from, to, "range");
    return bot.sendMessage(
      chatId,
      `✅ Sana tanlandi: ${from} → ${to}`,
      mainMenu(chatId)
    );
  }

  return bot.sendMessage(
    chatId,
    "ℹ️ Buyruqlar:\n" +
      "- Bitta sana: 2025-09-26\n" +
      "- Oraliq: 2025-09-01 2025-09-30\n" +
      "Yoki menyudan foydalaning."
  );
});

console.log("🤖 Bot running (polling)...");
