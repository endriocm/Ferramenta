import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = String(searchParams.get("symbol") || "").trim();
    if (!symbol) return NextResponse.json({ error: "Faltou ?symbol=PETR4" }, { status: 400 });

    const normalized = symbol.toUpperCase().replace(/\.SA$/, "");
    const getBrapiToken = () => process.env.BRAPI_TOKEN || process.env.brapi_token || process.env.BRAPI_API_KEY;
    const normalizeYahooSymbol = (ticker) => {
      if (!ticker) return "";
      const raw = String(ticker).trim().toUpperCase();
      if (raw.includes(".")) return raw;
      if (/^[A-Z]{4,6}\d{1,2}[A-Z]?$/.test(raw)) return `${raw}.SA`;
      return raw;
    };
    const readPayload = async (response) => {
      try {
        const text = await response.text();
        return { text, data: text ? JSON.parse(text) : null };
      } catch {
        return { text: "", data: null };
      }
    };
    const snippet = (text) => (text ? text.slice(0, 300) : "");

    const token = getBrapiToken();
    const brapiUrl = `https://brapi.dev/api/quote/${encodeURIComponent(normalized)}`;
    const brapiHeaders = token ? { Authorization: `Bearer ${token}` } : {};
    const brapiResponse = await fetch(brapiUrl, { headers: brapiHeaders });
    const brapiPayload = await readPayload(brapiResponse);

    const price = brapiPayload.data?.results?.[0]?.regularMarketPrice;
    if (brapiResponse.ok && price != null) {
      return NextResponse.json({ symbol: normalized, price, source: "brapi" });
    }

    const yahooSymbol = normalizeYahooSymbol(symbol);
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d`;
    const yahooResponse = await fetch(yahooUrl, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      cache: "no-store",
    });
    const yahooPayload = await readPayload(yahooResponse);
    if (!yahooResponse.ok) {
      return NextResponse.json({
        error: "spot_unavailable",
        source: "yahoo",
        status: yahooResponse.status,
        detailsSnippet: snippet(yahooPayload.text),
      }, { status: 502 });
    }
    const result = yahooPayload.data?.chart?.result?.[0];
    const meta = result?.meta;
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const lastClose = closes.length ? closes[closes.length - 1] : null;
    const yahooPrice = meta?.regularMarketPrice ?? lastClose;

    if (yahooPrice == null) {
      return NextResponse.json({
        error: "spot_unavailable",
        source: "yahoo",
        status: yahooResponse.status,
        detailsSnippet: snippet(yahooPayload.text),
      }, { status: 502 });
    }

    return NextResponse.json({ symbol: yahooSymbol, price: yahooPrice, source: "yahoo" });
  } catch (error) {
    return NextResponse.json({
      error: "Erro geral",
      source: "server",
      status: 500,
      detailsSnippet: String(error).slice(0, 300),
    }, { status: 500 });
  }
}
