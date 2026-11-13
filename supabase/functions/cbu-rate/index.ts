// Курс доллара ЦБ Узбекистана (сум за $1). Публичные данные, без секретов.
// Браузер часто блокирует прямой запрос к cbu.uz, поэтому приложение берёт курс отсюда.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const headers = { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=900" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch("https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/", { signal: ctl.signal, headers: { Accept: "application/json" } });
    clearTimeout(t);
    if (!r.ok) return new Response(JSON.stringify({ ok: false, error: "cbu_http_" + r.status }), { status: 502, headers });
    const d = await r.json();
    const row = Array.isArray(d) ? d[0] : null;
    const rate = row ? parseFloat(String(row.Rate).replace(",", ".")) : NaN;
    if (!isFinite(rate) || rate <= 0) return new Response(JSON.stringify({ ok: false, error: "bad_data" }), { status: 502, headers });
    return new Response(JSON.stringify({ ok: true, rate, date: row.Date ?? null }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "cbu_unreachable" }), { status: 502, headers });
  }
});
