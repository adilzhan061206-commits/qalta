// Daily reminder for Qalta. Called every hour by pg_cron (header x-qalta-cron must match the Vault secret).
// For each device whose local hour equals its chosen hour, and that has not been reminded today:
// if the person already recorded something today, stay quiet; otherwise send a Web Push.
// Deployed to Supabase as "qalta-remind" with verify_jwt = false (it checks its own secret).
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function secret(name: string): Promise<string> {
  const { data, error } = await sb.rpc("qalta_push_secret", { secret_name: name });
  if (error || !data) throw new Error("missing secret " + name);
  return data as string;
}

const T: Record<string, { title: string; plain: string; streak: (n: number) => string }> = {
  kk: { title: "Қалта", plain: "Бүгінгі шығындарды енгіздіңіз бе? Бір минут жетеді ✍️", streak: n => `🔥 ${n} күн қатарынан жазып келесіз! Бүгінгісін енгізіп, серияны үзбеңіз.` },
  ru: { title: "Қалта", plain: "Внесли сегодняшние расходы? Хватит одной минуты ✍️", streak: n => `🔥 ${n} дн. подряд! Внесите сегодняшние расходы, чтобы не прервать серию.` },
  en: { title: "Қалта", plain: "Logged today's spending yet? It takes a minute ✍️", streak: n => `🔥 ${n}-day streak! Log today's spending to keep it going.` },
};

const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const shiftDays = (s: string, n: number) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return dayStr(d); };

Deno.serve(async (req) => {
  let cron: string;
  try { cron = await secret("qalta_cron_secret"); } catch (e) { return new Response(String(e), { status: 500 }); }
  if (req.headers.get("x-qalta-cron") !== cron) return new Response("forbidden", { status: 403 });
  const body = await req.json().catch(() => ({}));
  const force: string | undefined = body && body.endpoint; // test: send to this one device now

  webpush.setVapidDetails("https://adilzhan061206-commits.github.io/qalta/", await secret("qalta_vapid_public"), await secret("qalta_vapid_private"));

  // a payment just arrived from Apple Pay (database trigger on qalta_inbox): ask which category it was
  if (body && body.pay) {
    const p = body.pay;
    const { data: subs } = await sb.from("qalta_push").select("*").eq("user_id", p.user_id);
    let merchant = String(p.merchant || "").trim();
    const { data: st } = await sb.from("qalta_docs").select("data").eq("user_id", p.user_id).eq("path", "settings").maybeSingle();
    const names: string[] = ((st && st.data && st.data.accounts) || []).map((a: any) => String(a.name || "")).filter(Boolean).sort((a: string, b: string) => b.length - a.length);
    const hit = names.find(n => merchant.length > n.length && merchant.toLowerCase().endsWith(n.toLowerCase()));
    if (hit) merchant = merchant.slice(0, -hit.length).trim();
    // a merchant the person already categorised is filed automatically: just confirm it; a new one: ask
    let knownCat = "";
    if (merchant) {
      const ym = new Date().toISOString().slice(0, 7), pm = shiftDays(ym + "-01", -1).slice(0, 7);
      const { data: docs } = await sb.from("qalta_docs").select("data").eq("user_id", p.user_id).in("path", ["m/" + ym, "m/" + pm]);
      const m = merchant.toLowerCase();
      let hitT: any = null;
      for (const d of docs || []) for (const t of (d.data && d.data.items) || []) if (t && t.t === "exp" && !t.ask && String(t.n || "").trim().toLowerCase() === m && (!hitT || (t.ts || 0) > (hitT.ts || 0))) hitT = t;
      // well-known chains are filed by the app without asking (same list as CAT_HINTS in index.html)
      const HINTS: [RegExp, string][] = [[/magnum|small|galmart|anvar|арзан|toimart|interfood|metro|green|супермаркет|маркет|market|продукт/i, "food"], [/yandex|яндекс|uber|indrive|taxi|такси/i, "taxi"], [/kfc|burger|бургер|coffee|кофе|starbucks|cafe|кафе|pizza|пицца|doner|донер|salam|bro|mcdonald|hardee|tomyumbar|sushi|суши|restaurant|ресторан/i, "cafe"], [/apteka|аптека|дәріхана|europharma|biosfera|med|clinic|клиника/i, "health"], [/onay|bus|автобус|azs|азс|helios|sinooil|qazaq oil|kazmunaygas|kmg|gazprom/i, "transport"], [/beeline|kcell|activ|tele2|altel|kazakhtelecom/i, "phone"], [/netflix|spotify|apple\.com|icloud|youtube|yandex plus|kinopoisk|ivi/i, "subs"], [/zara|h&m|lc waikiki|bershka|adidas|nike|defacto|koton|mango/i, "clothes"], [/kino|cinema|кино|chaplin|kinopark|steam|playstation/i, "fun"]];
      const catId = hitT ? hitT.c : (HINTS.find(([re]) => re.test(m)) || [])[1];
      if (catId) { const c = ((st && st.data && st.data.cats) || []).find((x: any) => x.id === catId); knownCat = c ? `${c.icon || ""} ${c.name}`.trim() : "✓"; }
    }
    const amt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(+p.amount)) + " ₸";
    const ask: Record<string, string> = { kk: "қай санатқа жазайын?", ru: "в какую категорию записать?", en: "which category is it?" };
    const res: unknown[] = [];
    for (const s of subs || []) {
      const msg = knownCat ? `✓ ${amt}${merchant ? " · " + merchant : ""} → ${knownCat}` : `${amt}${merchant ? " · " + merchant : ""} — ${ask[s.lang] || ask.kk}`;
      const payload = JSON.stringify({ title: "Қалта · Apple Pay", body: msg, url: knownCat ? "./" : "./?review=1", tag: "qalta-pay" });
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: "high" }); res.push({ sent: true }); }
      catch (e: any) { const code = e && e.statusCode; if (code === 404 || code === 410) await sb.from("qalta_push").delete().eq("endpoint", s.endpoint); res.push({ sent: false, code }); }
    }
    return new Response(JSON.stringify({ pay: true, results: res }), { headers: { "Content-Type": "application/json" } });
  }

  const now = Date.now();
  let q = sb.from("qalta_push").select("*");
  if (force) q = q.eq("endpoint", force);
  const { data: subs, error } = await q;
  if (error) return new Response(error.message, { status: 500 });

  const out: unknown[] = [];
  for (const s of subs || []) {
    const local = new Date(now + s.tz_min * 60000);
    const today = dayStr(local);
    if (!force && (local.getUTCHours() !== s.hour || s.last_sent === today)) continue;

    // what has this person recorded this month and last month?
    const prev = shiftDays(today.slice(0, 7) + "-01", -1).slice(0, 7);
    const { data: docs } = await sb.from("qalta_docs").select("path,data").eq("user_id", s.user_id).in("path", ["m/" + today.slice(0, 7), "m/" + prev]);
    const days = new Set<string>();
    for (const d of docs || []) for (const t of (d.data && d.data.items) || []) if (t && t.date) days.add(t.date);

    if (days.has(today) && !force) {
      await sb.from("qalta_push").update({ last_sent: today }).eq("endpoint", s.endpoint);
      out.push({ skipped: "already recorded today" });
      continue;
    }
    let streak = 0;
    for (let d = shiftDays(today, -1); days.has(d); d = shiftDays(d, -1)) streak++;
    const t = T[s.lang] || T.kk;
    const payload = JSON.stringify({ title: t.title, body: streak >= 2 ? t.streak(streak) : t.plain, url: "./?add=exp", tag: "qalta-daily" });
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 4 * 3600, urgency: "normal" });
      await sb.from("qalta_push").update({ last_sent: today }).eq("endpoint", s.endpoint);
      out.push({ sent: true, streak });
    } catch (e: any) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) await sb.from("qalta_push").delete().eq("endpoint", s.endpoint);
      out.push({ sent: false, code, error: String((e && e.body) || e).slice(0, 200) });
    }
  }
  return new Response(JSON.stringify({ checked: (subs || []).length, results: out }), { headers: { "Content-Type": "application/json" } });
});
