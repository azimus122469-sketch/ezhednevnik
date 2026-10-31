// Ежедневник: MCP-сервер и простой HTTP-вход для n8n.
// Чтение: всё. Запись: только предложения (ai_actions), исполняет их владелец кнопкой «Одобрить» в приложении.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const WALLET_CUR: Record<string, string> = { cash_uzs: "UZS", card_uzs: "UZS", cash_usd: "USD", card_usd: "USD" };
const WALLET_NAME: Record<string, string> = {
  cash_uzs: "Наличка сум", card_uzs: "Карта сум", cash_usd: "Наличка $", card_usd: "Карта $",
};
const COL_NAME: Record<string, string> = {
  in: "Приход", real: "Реализация", byt: "Быт", lich: "Личное", auto: "Машина",
  cout: "Обмен (списано)", cin: "Обмен (получено)", self: "Себе",
};
const SIGN: Record<string, number> = { in: 1, real: -1, byt: -1, lich: -1, auto: -1, cout: -1, cin: 1, self: -1 };
const ADD_COLS = ["in", "real", "byt", "lich", "auto"];
const EXPENSE_COLS = ["real", "byt", "lich", "auto"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-ezh-token, mcp-session-id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function sha256hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authenticate(req: Request) {
  const url = new URL(req.url);
  let t = url.searchParams.get("token") || req.headers.get("x-ezh-token") || "";
  const a = req.headers.get("authorization") || "";
  if (!t && a.toLowerCase().startsWith("bearer ")) t = a.slice(7).trim();
  if (!t.startsWith("ezh_")) return null;
  const { data } = await db.from("ai_tokens").select("id,user_id,revoked_at").eq("token_hash", await sha256hex(t)).maybeSingle();
  if (!data || data.revoked_at) return null;
  db.from("ai_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {});
  return { tokenId: data.id as string, userId: data.user_id as string };
}

type Ctx = { tokenId: string; userId: string };

/* ---------- данные ---------- */
async function loadAll(table: string, uid: string, order: string[]) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select("*").eq("user_id", uid);
    for (const o of order) q = q.order(o, { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const loadEntries = (uid: string) => loadAll("entries", uid, ["date", "created_at"]);
async function loadSettings(uid: string) {
  const { data, error } = await db.from("settings").select("*").eq("user_id", uid).maybeSingle();
  if (error) throw new Error(error.message);
  return data || { starts: {}, base_cur: "USD", rate: 12600, rate_source: "cbu", notify_time: "21:00", pay_pct: 10, pay_base: "all" };
}

function toBase(amount: number, cur: string, s: any) {
  const rate = Number(s.rate) || 1;
  if (cur === s.base_cur) return amount;
  if (s.base_cur === "USD" && cur === "UZS") return amount / rate;
  if (s.base_cur === "UZS" && cur === "USD") return amount * rate;
  return amount;
}
const r2 = (n: number) => Math.round(n * 100) / 100;

function balances(entries: any[], s: any, beforeDate?: string) {
  const b: Record<string, number> = {};
  for (const w of Object.keys(WALLET_CUR)) b[w] = Number(s.starts?.[w] || 0);
  for (const e of entries) {
    if (beforeDate && e.date >= beforeDate) continue;
    if (e.wallet in b) b[e.wallet] += (SIGN[e.col] ?? 0) * Number(e.amount);
  }
  return b;
}
function walletList(b: Record<string, number>, s: any) {
  return Object.keys(WALLET_CUR).map((id) => ({
    id, name: WALLET_NAME[id], currency: WALLET_CUR[id], balance: r2(b[id]),
    in_base: r2(toBase(b[id], WALLET_CUR[id], s)),
  }));
}

/* ---------- проверки ---------- */
const isDate = (s: any) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
function money(n: number, cur: string) {
  const v = cur === "USD" ? r2(n) : Math.round(n);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (cur === "USD" ? " $" : " сум");
}
const dm = (d: string) => d.slice(8, 10) + "." + d.slice(5, 7);
function num(v: any, name: string) {
  const n = Number(v);
  if (!isFinite(n) || n < 0 || n > 1e13) throw new Error(`${name}: нужно число от 0`);
  return r2(n);
}
function wallet(v: any, name = "wallet") {
  if (!(v in WALLET_CUR)) throw new Error(`${name}: одно из ${Object.keys(WALLET_CUR).join(", ")}`);
  return v as string;
}
function dateArg(v: any, name = "date") {
  if (!isDate(v)) throw new Error(`${name}: формат ГГГГ-ММ-ДД`);
  return v as string;
}

async function propose(ctx: Ctx, summary: string, ops: any[], message?: string) {
  if (!ops.length) throw new Error("пустое предложение");
  if (ops.length > 200) throw new Error("слишком много операций в одном предложении (максимум 200)");
  const { count } = await db.from("ai_actions").select("id", { count: "exact", head: true })
    .eq("user_id", ctx.userId).eq("status", "pending");
  if ((count ?? 0) >= 50) throw new Error("Очередь неодобренных предложений заполнена (50). Дождись решений владельца.");
  const { data, error } = await db.from("ai_actions")
    .insert({ user_id: ctx.userId, token_id: ctx.tokenId, summary, ops }).select("id").single();
  if (error) throw new Error(error.message);
  await db.from("ai_chat").insert({
    user_id: ctx.userId, role: "assistant", content: (message || summary).slice(0, 8000), action_id: data.id,
  });
  return {
    proposal_id: data.id, status: "pending", summary,
    note: "Ничего не изменено. Предложение ждёт одобрения владельца в приложении (вкладка «Помощник»). Одобрение разовое.",
  };
}

/* ---------- инструменты ---------- */
const DESCRIBE = `Ежедневник — личная денежная тетрадь (PWA). Данные одного владельца.
Колонки (col): in = Приход (+), real = Реализация (-), byt = Быт (-), lich = Личное (-), auto = Машина (-).
Служебные: cout/cin = обмен между кошельками, пара записей с общим conv_id (списано/получено, не приход и не расход); self = «Плачу себе» (выплата владельцу, отдельно от расходов).
Кошельки: cash_uzs, card_uzs (сум), cash_usd, card_usd (доллары). Валюта записи всегда равна валюте кошелька.
Остаток кошелька = стартовый остаток (settings.starts) + сумма записей со знаком колонки. Общий итог сводится в base_cur по курсу rate (сумов за доллар).
Прибыль месяца = приход минус расходы; pay_base=all считает все четыре расходные колонки, pay_base=real только Реализацию. Выплата себе = pay_pct% от прибыли.
source: user = внёс владелец, ai = внёс или правил помощник.
ПРАВИЛО: любое добавление, исправление и удаление ты только предлагаешь (инструменты propose_*). Ничего не меняется, пока владелец не нажмёт «Одобрить» в приложении; одобрение действует один раз на одно предложение. Не выдумывай данные: если чего-то не хватает, спроси в чате (send_chat_message). Перед ответом по теме разговора смотри get_chat_history.`;

const t = (name: string, description: string, properties: any = {}, required: string[] = []) => ({
  name, description, inputSchema: { type: "object", properties, required },
});
const S = { type: "string" }, N = { type: "number" }, B = { type: "boolean" };
const MSG = { type: "string", description: "Короткий текст для чата рядом с предложением (необязательно)" };
const WAL = { type: "string", enum: Object.keys(WALLET_CUR) };

const TOOLS = [
  t("describe_diary", "Как устроен ежедневник: колонки, кошельки, знаки, правила. Прочитай первым."),
  t("get_overview", "Остатки по четырём кошелькам, общий итог, курс, настройки, число записей, открытые цели, число ждущих предложений."),
  t("list_entries", "Записи с фильтрами. По умолчанию последние 100, новые сверху.", {
    date_from: S, date_to: S, col: { type: "string", enum: Object.keys(COL_NAME) }, wallet: WAL,
    source: { type: "string", enum: ["user", "ai"] }, search: { type: "string", description: "Поиск по заметке" },
    limit: { type: "number", description: "до 500" }, order: { type: "string", enum: ["asc", "desc"] },
  }),
  t("month_report", "Отчёт за месяц: суммы по колонкам, приход, расход, прибыль, выплата себе, по дням, остатки на начало и конец.", { ym: { type: "string", description: "ГГГГ-ММ" } }, ["ym"]),
  t("list_goals", "Цели и дедлайны."),
  t("list_pending_actions", "Предложения, которые ждут одобрения владельца."),
  t("get_chat_history", "История чата с владельцем (от старых к новым), со статусами предложений. Используй, чтобы понять, о чём шёл разговор.", {
    limit: { type: "number", description: "по умолчанию 30, максимум 200" }, before: { type: "string", description: "ISO-время: только сообщения раньше" },
    search: { type: "string", description: "Поиск по тексту" },
  }),
  t("send_chat_message", "Написать владельцу в чат приложения (вопрос, ответ, отчёт). Данные не меняет.", { content: S, action_id: S }, ["content"]),
  t("propose_add_entries", "Предложить добавить записи (приход и расходы). Обмен и выплату себе — отдельными инструментами.", {
    entries: { type: "array", items: { type: "object", properties: { date: S, col: { type: "string", enum: ADD_COLS }, amount: N, wallet: WAL, note: S }, required: ["date", "col", "amount", "wallet"] } },
    message: MSG,
  }, ["entries"]),
  t("propose_update_entry", "Предложить исправить одну запись. Для пары обмена используй удаление и propose_exchange заново.", {
    id: S, fields: { type: "object", properties: { date: S, col: { type: "string", enum: ADD_COLS }, amount: N, wallet: WAL, note: S } }, message: MSG,
  }, ["id", "fields"]),
  t("propose_delete_entries", "Предложить удалить записи (для обмена удаляются обе половины).", { ids: { type: "array", items: S }, message: MSG }, ["ids"]),
  t("propose_exchange", "Предложить обмен/перевод между кошельками. Между разными валютами обязателен amount_in.", {
    date: S, from_wallet: WAL, to_wallet: WAL, amount_out: N, amount_in: N, note: S, message: MSG,
  }, ["date", "from_wallet", "to_wallet", "amount_out"]),
  t("propose_pay_self", "Предложить запись «Плачу себе».", { date: S, wallet: WAL, amount: N, note: S, message: MSG }, ["date", "wallet", "amount"]),
  t("propose_goal", "Предложить добавить, изменить или удалить цель.", {
    action: { type: "string", enum: ["add", "update", "delete"] }, id: S, title: S, due: S, done: B, notify: B, message: MSG,
  }, ["action"]),
  t("propose_update_settings", "Предложить изменить настройки: стартовые остатки, курс, источник курса, время напоминания, процент и базу «Плачу себе», базовую валюту.", {
    starts: { type: "object", description: "по кошелькам, например {\"cash_uzs\": 100000}" }, rate: N,
    rate_source: { type: "string", enum: ["cbu", "manual"] }, notify_time: { type: "string", description: "ЧЧ:ММ" },
    pay_pct: N, pay_base: { type: "string", enum: ["all", "real"] }, base_cur: { type: "string", enum: ["USD", "UZS"] }, message: MSG,
  }),
];

const HANDLERS: Record<string, (a: any, c: Ctx) => Promise<unknown>> = {
  async describe_diary() { return DESCRIBE; },

  async get_overview(_a, c) {
    const [entries, s, goals] = await Promise.all([loadEntries(c.userId), loadSettings(c.userId), loadAll("goals", c.userId, ["due"])]);
    const b = balances(entries, s);
    const { count } = await db.from("ai_actions").select("id", { count: "exact", head: true }).eq("user_id", c.userId).eq("status", "pending");
    const w = walletList(b, s);
    return {
      base_currency: s.base_cur, rate_uzs_per_usd: Number(s.rate), wallets: w,
      total_in_base: r2(w.reduce((x, y) => x + y.in_base, 0)),
      settings: { rate_source: s.rate_source, notify_time: s.notify_time, pay_pct: Number(s.pay_pct), pay_base: s.pay_base, starts: s.starts },
      entries_count: entries.length, first_date: entries[0]?.date ?? null, last_date: entries[entries.length - 1]?.date ?? null,
      open_goals: goals.filter((g) => !g.done).length, pending_proposals: count ?? 0,
    };
  },

  async list_entries(a, c) {
    const limit = Math.min(Math.max(Number(a.limit) || 100, 1), 500);
    let q = db.from("entries").select("id,date,col,amount,cur,wallet,note,source,conv_id,rate,created_at").eq("user_id", c.userId);
    if (a.date_from) q = q.gte("date", dateArg(a.date_from, "date_from"));
    if (a.date_to) q = q.lte("date", dateArg(a.date_to, "date_to"));
    if (a.col) q = q.eq("col", a.col);
    if (a.wallet) q = q.eq("wallet", wallet(a.wallet));
    if (a.source) q = q.eq("source", a.source);
    if (a.search) q = q.ilike("note", `%${String(a.search).slice(0, 100)}%`);
    const asc = a.order === "asc";
    const { data, error } = await q.order("date", { ascending: asc }).order("created_at", { ascending: asc }).limit(limit);
    if (error) throw new Error(error.message);
    return { count: data!.length, entries: data!.map((e) => ({ ...e, col_name: COL_NAME[e.col] })) };
  },

  async month_report(a, c) {
    const ym = String(a.ym || "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new Error("ym: формат ГГГГ-ММ");
    const [y, m] = ym.split("-").map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    const [entries, s] = await Promise.all([loadEntries(c.userId), loadSettings(c.userId)]);
    const mon = entries.filter((e) => e.date >= ym + "-01" && e.date < next + "-01");
    const byCol: Record<string, number> = { in: 0, real: 0, byt: 0, lich: 0, auto: 0 };
    const native: Record<string, Record<string, number>> = { UZS: { in: 0, real: 0, byt: 0, lich: 0, auto: 0 }, USD: { in: 0, real: 0, byt: 0, lich: 0, auto: 0 } };
    const days: Record<string, { in: number; out: number }> = {};
    let paid = 0, conv = 0;
    for (const e of mon) {
      const amt = Number(e.amount), base = toBase(amt, WALLET_CUR[e.wallet], s);
      if (e.col === "self") { paid += base; continue; }
      if (e.col === "cout" || e.col === "cin") { conv++; continue; }
      byCol[e.col] += base; native[WALLET_CUR[e.wallet]][e.col] += amt;
      const d = (days[e.date] ||= { in: 0, out: 0 });
      if (e.col === "in") d.in += base; else d.out += base;
    }
    const spent = s.pay_base === "real" ? byCol.real : EXPENSE_COLS.reduce((x, k) => x + byCol[k], 0);
    const profit = byCol.in - spent;
    const due = Math.max(0, profit) * Number(s.pay_pct) / 100;
    const rnd = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));
    return {
      month: ym, base_currency: s.base_cur, entries_count: mon.length, exchange_entries: conv,
      by_column_base: rnd(byCol), by_column_native: { UZS: rnd(native.UZS), USD: rnd(native.USD) },
      income: r2(byCol.in), expenses_all: r2(EXPENSE_COLS.reduce((x, k) => x + byCol[k], 0)),
      profit: r2(profit), profit_basis: s.pay_base, pay_pct: Number(s.pay_pct),
      due_to_self: r2(due), paid_to_self: r2(paid),
      by_day: Object.keys(days).sort().map((d) => ({ date: d, income: r2(days[d].in), expenses: r2(days[d].out) })),
      opening_balances: walletList(balances(entries, s, ym + "-01"), s),
      closing_balances: walletList(balances(entries, s, next + "-01"), s),
    };
  },

  async list_goals(_a, c) {
    const g = await loadAll("goals", c.userId, ["due"]);
    return g.map((x) => ({ id: x.id, title: x.title, due: x.due, done: x.done, notify: x.notify, source: x.source }));
  },

  async list_pending_actions(_a, c) {
    const { data, error } = await db.from("ai_actions").select("id,summary,created_at").eq("user_id", c.userId).eq("status", "pending").order("created_at", { ascending: false }).limit(50);
    if (error) throw new Error(error.message);
    return data;
  },

  async get_chat_history(a, c) {
    const limit = Math.min(Math.max(Number(a.limit) || 30, 1), 200);
    let q = db.from("ai_chat").select("id,role,content,action_id,created_at").eq("user_id", c.userId);
    if (a.before) q = q.lt("created_at", String(a.before));
    if (a.search) q = q.ilike("content", `%${String(a.search).slice(0, 100)}%`);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    const ids = [...new Set(data!.map((m) => m.action_id).filter(Boolean))] as string[];
    const st: Record<string, any> = {};
    if (ids.length) {
      const { data: acts } = await db.from("ai_actions").select("id,status,error,summary").in("id", ids);
      for (const x of acts || []) st[x.id] = { status: x.status, error: x.error, summary: x.summary };
    }
    return data!.reverse().map((m) => ({ ...m, proposal: m.action_id ? st[m.action_id] ?? null : undefined }));
  },

  async send_chat_message(a, c) {
    const content = String(a.content || "").trim();
    if (!content) throw new Error("content пустой");
    const row: any = { user_id: c.userId, role: "assistant", content: content.slice(0, 8000) };
    if (a.action_id) row.action_id = a.action_id;
    const { data, error } = await db.from("ai_chat").insert(row).select("id,created_at").single();
    if (error) throw new Error(error.message);
    return { sent: true, id: data.id, created_at: data.created_at };
  },

  async propose_add_entries(a, c) {
    if (!Array.isArray(a.entries) || !a.entries.length) throw new Error("entries: нужен непустой список");
    const ops: any[] = [], lines: string[] = [];
    a.entries.forEach((e: any, i: number) => {
      const w = wallet(e.wallet, `entries[${i}].wallet`);
      if (!ADD_COLS.includes(e.col)) throw new Error(`entries[${i}].col: одно из ${ADD_COLS.join(", ")}`);
      const row = { date: dateArg(e.date, `entries[${i}].date`), col: e.col, amount: num(e.amount, `entries[${i}].amount`), cur: WALLET_CUR[w], wallet: w, note: String(e.note || "").slice(0, 300) };
      ops.push({ op: "insert", table: "entries", id: crypto.randomUUID(), row });
      lines.push(`${dm(row.date)} ${COL_NAME[row.col]} ${money(row.amount, row.cur)}, ${WALLET_NAME[w]}${row.note ? " «" + row.note + "»" : ""}`);
    });
    return propose(c, "Добавить: " + lines.join("; "), ops, a.message);
  },

  async propose_update_entry(a, c) {
    const f = a.fields || {};
    const { data: e } = await db.from("entries").select("*").eq("id", String(a.id)).eq("user_id", c.userId).maybeSingle();
    if (!e) throw new Error("запись не найдена");
    if (e.conv_id) throw new Error("это половина обмена: удали пару и предложи обмен заново");
    const row: any = {}, parts: string[] = [];
    if (f.date !== undefined) { row.date = dateArg(f.date, "fields.date"); parts.push(`дата → ${dm(row.date)}`); }
    if (f.col !== undefined) {
      if (e.col === "self") throw new Error("колонку выплаты себе менять нельзя");
      if (!ADD_COLS.includes(f.col)) throw new Error(`fields.col: одно из ${ADD_COLS.join(", ")}`);
      row.col = f.col; parts.push(`колонка → ${COL_NAME[f.col]}`);
    }
    if (f.wallet !== undefined) { row.wallet = wallet(f.wallet, "fields.wallet"); row.cur = WALLET_CUR[row.wallet]; parts.push(`кошелёк → ${WALLET_NAME[row.wallet]}`); }
    if (f.amount !== undefined) { row.amount = num(f.amount, "fields.amount"); parts.push(`сумма → ${money(row.amount, row.cur || e.cur)}`); }
    if (f.note !== undefined) { row.note = String(f.note).slice(0, 300); parts.push(`заметка → «${row.note}»`); }
    if (!parts.length) throw new Error("fields пустой");
    return propose(c, `Исправить запись ${dm(e.date)} ${COL_NAME[e.col]} ${money(Number(e.amount), e.cur)}: ${parts.join(", ")}`, [{ op: "update", table: "entries", id: e.id, row }], a.message);
  },

  async propose_delete_entries(a, c) {
    if (!Array.isArray(a.ids) || !a.ids.length) throw new Error("ids: нужен непустой список");
    const { data: found } = await db.from("entries").select("*").eq("user_id", c.userId).in("id", a.ids.map(String));
    if (!found || found.length !== new Set(a.ids.map(String)).size) throw new Error("часть записей не найдена");
    const all = new Map<string, any>(found.map((e) => [e.id, e]));
    const cids = [...new Set(found.map((e) => e.conv_id).filter(Boolean))];
    if (cids.length) {
      const { data: pairs } = await db.from("entries").select("*").eq("user_id", c.userId).in("conv_id", cids);
      for (const p of pairs || []) all.set(p.id, p);
    }
    const list = [...all.values()];
    return propose(c, "Удалить: " + list.map((e) => `${dm(e.date)} ${COL_NAME[e.col]} ${money(Number(e.amount), e.cur)}${e.note ? " «" + e.note + "»" : ""}`).join("; "),
      list.map((e) => ({ op: "delete", table: "entries", id: e.id })), a.message);
  },

  async propose_exchange(a, c) {
    const from = wallet(a.from_wallet, "from_wallet"), to = wallet(a.to_wallet, "to_wallet");
    if (from === to) throw new Error("кошельки должны отличаться");
    const date = dateArg(a.date), out = num(a.amount_out, "amount_out");
    if (!out) throw new Error("amount_out: больше нуля");
    const cross = WALLET_CUR[from] !== WALLET_CUR[to];
    let inn = out, rate: number | null = null;
    if (cross) {
      if (a.amount_in === undefined) throw new Error("для обмена между валютами нужен amount_in");
      inn = num(a.amount_in, "amount_in");
      if (!inn) throw new Error("amount_in: больше нуля");
      const usd = WALLET_CUR[from] === "USD" ? out : inn, uzs = WALLET_CUR[from] === "USD" ? inn : out;
      rate = r2(uzs / usd);
    }
    const note = String(a.note || "").slice(0, 300), cid = crypto.randomUUID();
    const ops = [
      { op: "insert", table: "entries", id: crypto.randomUUID(), row: { date, col: "cout", amount: out, cur: WALLET_CUR[from], wallet: from, note, conv_id: cid, rate } },
      { op: "insert", table: "entries", id: crypto.randomUUID(), row: { date, col: "cin", amount: inn, cur: WALLET_CUR[to], wallet: to, note, conv_id: cid, rate } },
    ];
    return propose(c, `Обмен ${dm(date)}: ${WALLET_NAME[from]} −${money(out, WALLET_CUR[from])} → ${WALLET_NAME[to]} +${money(inn, WALLET_CUR[to])}${rate ? ", курс " + rate : ""}`, ops, a.message);
  },

  async propose_pay_self(a, c) {
    const w = wallet(a.wallet), date = dateArg(a.date), amount = num(a.amount, "amount");
    if (!amount) throw new Error("amount: больше нуля");
    const row = { date, col: "self", amount, cur: WALLET_CUR[w], wallet: w, note: String(a.note || "").slice(0, 300) };
    return propose(c, `Выплата себе ${dm(date)}: ${money(amount, row.cur)}, ${WALLET_NAME[w]}`, [{ op: "insert", table: "entries", id: crypto.randomUUID(), row }], a.message);
  },

  async propose_goal(a, c) {
    const row: any = {};
    if (a.title !== undefined) row.title = String(a.title).trim().slice(0, 200);
    if (a.due !== undefined) row.due = a.due === "" || a.due === null ? null : dateArg(a.due, "due");
    if (a.done !== undefined) row.done = !!a.done;
    if (a.notify !== undefined) row.notify = !!a.notify;
    if (a.action === "add") {
      if (!row.title) throw new Error("title обязателен");
      return propose(c, `Новая цель: «${row.title}»${row.due ? " до " + row.due : ""}`, [{ op: "insert", table: "goals", id: crypto.randomUUID(), row }], a.message);
    }
    if (a.action !== "update" && a.action !== "delete") throw new Error("action: add, update или delete");
    const { data: g } = await db.from("goals").select("id,title").eq("id", String(a.id)).eq("user_id", c.userId).maybeSingle();
    if (!g) throw new Error("цель не найдена");
    if (a.action === "delete") return propose(c, `Удалить цель «${g.title}»`, [{ op: "delete", table: "goals", id: g.id }], a.message);
    if (!Object.keys(row).length) throw new Error("нечего менять");
    return propose(c, `Изменить цель «${g.title}»: ${Object.entries(row).map(([k, v]) => `${k} → ${v}`).join(", ")}`, [{ op: "update", table: "goals", id: g.id, row }], a.message);
  },

  async propose_update_settings(a, c) {
    const row: any = {}, parts: string[] = [];
    if (a.starts !== undefined) {
      const s = await loadSettings(c.userId), starts = { ...(s.starts || {}) };
      for (const [k, v] of Object.entries(a.starts || {})) {
        wallet(k, "starts." + k);
        const n = Number(v); if (!isFinite(n)) throw new Error(`starts.${k}: число`);
        starts[k] = n; parts.push(`старт ${WALLET_NAME[k]} → ${n}`);
      }
      row.starts = starts;
    }
    if (a.rate !== undefined) { const n = Number(a.rate); if (!(n > 0)) throw new Error("rate: больше нуля"); row.rate = n; parts.push(`курс → ${n}`); }
    if (a.rate_source !== undefined) { if (!["cbu", "manual"].includes(a.rate_source)) throw new Error("rate_source: cbu или manual"); row.rate_source = a.rate_source; parts.push(`источник курса → ${a.rate_source}`); }
    if (a.notify_time !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a.notify_time)) throw new Error("notify_time: ЧЧ:ММ"); row.notify_time = a.notify_time; parts.push(`напоминание → ${a.notify_time}`); }
    if (a.pay_pct !== undefined) { const n = Number(a.pay_pct); if (!(n >= 1 && n <= 100)) throw new Error("pay_pct: от 1 до 100"); row.pay_pct = n; parts.push(`«Плачу себе» → ${n}%`); }
    if (a.pay_base !== undefined) { if (!["all", "real"].includes(a.pay_base)) throw new Error("pay_base: all или real"); row.pay_base = a.pay_base; parts.push(`база выплаты → ${a.pay_base}`); }
    if (a.base_cur !== undefined) { if (!["USD", "UZS"].includes(a.base_cur)) throw new Error("base_cur: USD или UZS"); row.base_cur = a.base_cur; parts.push(`базовая валюта → ${a.base_cur}`); }
    if (!parts.length) throw new Error("нечего менять");
    return propose(c, "Настройки: " + parts.join(", "), [{ op: "update", table: "settings", row }], a.message);
  },
};

async function callTool(name: string, args: any, ctx: Ctx) {
  const h = HANDLERS[name];
  if (!h) throw new Error("неизвестный инструмент: " + name);
  return await h(args || {}, ctx);
}

/* ---------- протоколы ---------- */
async function rpc(msg: any, ctx: Ctx) {
  const id = msg.id, reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} }, serverInfo: { name: "ezhednevnik", version: "1.0.0" }, instructions: DESCRIBE,
      });
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call":
      try {
        const out = await callTool(msg.params?.name, msg.params?.arguments, ctx);
        return reply({ content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return reply({ content: [{ type: "text", text: "Ошибка: " + (e as Error).message }], isError: true });
      }
    default:
      if (String(msg.method || "").startsWith("notifications/")) return null;
      return fail(-32601, "method not found: " + msg.method);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const ctx = await authenticate(req);
  if (!ctx) return json({ error: "нужен действующий токен ассистента (ezh_...)" }, 401);
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  try {
    // Простой HTTP для n8n и скриптов
    if (path.endsWith("/tools") && req.method === "GET") return json({ tools: TOOLS });
    if (path.endsWith("/call") && req.method === "POST") {
      const b = await req.json();
      try { return json({ ok: true, result: await callTool(b.tool, b.arguments ?? b.args, ctx) }); }
      catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
    }
    // MCP (Streamable HTTP, ответ обычным JSON)
    if (req.method === "POST") {
      const body = await req.json();
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map((m) => rpc(m, ctx)))).filter(Boolean);
        return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
      }
      const out = await rpc(body, ctx);
      return out ? json(out) : new Response(null, { status: 202, headers: CORS });
    }
    return json({ error: "используй POST" }, 405);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
