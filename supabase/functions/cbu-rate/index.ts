// Курс доллара ЦБ Узбекистана (сум за $1). Публичные данные, без секретов.
// Браузер часто блокирует прямой запрос к cbu.uz, поэтому приложение берёт курс отсюда.
// ?date=YYYY-MM-DD отдаёт курс на эту дату (архив ЦБ); без параметра - на сегодня.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const headers = { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=900" };
const J = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const q = new URL(req.url).searchParams.get("date");
    if (q && !/^\d{4}-\d{2}-\d{2}$/.test(q)) return J({ ok: false, error: "bad_date" }, 400);
    const url = "https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/" + (q ? q + "/" : "");
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    clearTimeout(t);
    if (!r.ok) return J({ ok: false, error: "cbu_http_" + r.status }, 502);
    const d = await r.json();
    const row = Array.isArray(d) ? d[0] : null;
    const rate = row ? parseFloat(String(row.Rate).replace(",", ".")) : NaN;
    if (!isFinite(rate) || rate < 5000 || rate > 30000) return J({ ok: false, error: "bad_data" }, 502);
    // ЦБ отдаёт дату как дд.мм.гггг; если она не совпала с запрошенной, не подсовываем чужой курс
    let iso: string | null = null;
    const m = String(row.Date ?? "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) iso = `${m[3]}-${m[2]}-${m[1]}`;
    if (q && iso !== q) return J({ ok: false, error: "date_mismatch", got: iso }, 404);
    return J({ ok: true, rate, date: row.Date ?? null, iso });
  } catch (_e) {
    return J({ ok: false, error: "cbu_unreachable" }, 502);
  }
});
