import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = String(searchParams.get("symbol") || "").trim();
  if (!symbol) return NextResponse.json({ error: "Faltou ?symbol=PETR4" }, { status: 400 });

  const token = process.env.BRAPI_TOKEN;
  if (!token) return NextResponse.json({ error: "BRAPI_TOKEN nao configurado no Vercel/.env.local" }, { status: 500 });

  const url = `https://brapi.dev/api/quote/${encodeURIComponent(symbol)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json();

  const price = data?.results?.[0]?.regularMarketPrice;
  if (price == null) return NextResponse.json({ error: "Preco nao encontrado", raw: data }, { status: 404 });

  return NextResponse.json({ symbol, price });
}
