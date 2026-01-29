import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") || "").trim();
  if (!symbol) return NextResponse.json({ ok: false, error: "missing symbol" }, { status: 400 });

  const normalized = symbol.toUpperCase();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}?interval=1d&range=5d`;

  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    cache: "no-store",
  });

  const text = await r.text();
  if (!r.ok) return NextResponse.json({ ok: false, status: r.status, body: text.slice(0, 300) }, { status: 502 });

  const data = JSON.parse(text);
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const lastClose = closes.length ? closes[closes.length - 1] : null;

  return NextResponse.json({ ok: true, symbol: normalized, spot: meta?.regularMarketPrice ?? lastClose });
}
