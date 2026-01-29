import { NextResponse } from "next/server";
import { createRequire } from "node:module";

export const runtime = "nodejs";

const require = createRequire(import.meta.url);
const { getDividendsResult } = require("../../../../api/lib/dividends");

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const ticker = (searchParams.get("ticker") || "").trim();
  const from = (searchParams.get("from") || "").trim();
  const to = (searchParams.get("to") || "").trim();
  const debug = searchParams.get("debug") === "1" || searchParams.get("debug") === "true";

  if (!ticker || !from || !to) {
    return NextResponse.json({ error: "Parametros invalidos." }, { status: 400 });
  }

  try {
    const result = await getDividendsResult({ ticker, from, to, includeEvents: debug });
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json(
      { error: "Falha ao buscar dividendos.", providers: error?.providers || [] },
      { status: error?.status || 502 },
    );
  }
}
