import { useState, useEffect, useRef } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { useTranslation } from "react-i18next";
import type { Receipt } from "./Sidebar";
import { fmt, displayName } from "./Sidebar";

// ---------------------------------------------------------------------------
// Geocoding — Nominatim (OpenStreetMap, free, no key)
// Session-level in-memory cache (keyed by db path + query) prevents duplicate
// fetches within a session. Persistent cache lives in the project SQLite DB.
// ---------------------------------------------------------------------------
const SESSION_CACHE = new Map<string, [number, number] | null>();

async function geocodeNominatim(query: string): Promise<[number, number] | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": "finamt/1.0" } },
    );
    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    return data[0] ? [parseFloat(data[0].lat), parseFloat(data[0].lon)] : null;
  } catch {
    return null;
  }
}

/** Throttle: wait `ms` milliseconds */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Dot sizing — logarithmic scale so variation is visible but not extreme
// ---------------------------------------------------------------------------
function dotRadius(amount: number, maxAmount: number): number {
  if (maxAmount <= 0 || amount <= 0) return 5;
  const norm = Math.log1p(amount) / Math.log1p(maxAmount); // 0 → 1
  return 5 + norm * 22; // range: 5 – 27 px
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Tab = "kyc" | "kys";

interface MapPoint {
  lat: number;
  lon: number;
  name: string;
  amount: number;
  count: number;
}

interface AggEntry {
  name: string;
  amount: number;
  count: number;
  city: string | null | undefined;
  postcode: string | null | undefined;
  country: string | null | undefined;
}

interface ResolvedEntry extends AggEntry {
  coords: [number, number] | null;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
export function KycKysPanel({
  receipts,
  apiBase = "",
  dbPath,
}: {
  receipts: Receipt[];
  apiBase?: string;
  dbPath?: string | null;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("kyc");
  const [points, setPoints] = useState<MapPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [unmapped, setUnmapped] = useState<{ count: number; amount: number }>({ count: 0, amount: 0 });
  const [resolved, setResolved] = useState<ResolvedEntry[]>([]);
  const [showManage, setShowManage] = useState(false);

  // Persistent cache loaded from DB — stored as ref so it doesn't trigger re-renders
  const dbCache = useRef<Record<string, [number, number] | null>>({});
  const dbCacheLoaded = useRef(false);

  // ── Load persistent cache from DB ───────────────────────────────────────
  useEffect(() => {
    dbCacheLoaded.current = false;
    dbCache.current = {};
    if (!dbPath) { dbCacheLoaded.current = true; return; }
    const url = `${apiBase}/geocode-cache?db=${encodeURIComponent(dbPath)}`;
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        dbCache.current = data.cache ?? {};
        dbCacheLoaded.current = true;
      })
      .catch(() => { dbCacheLoaded.current = true; });
  }, [apiBase, dbPath]);

  // ── Save a single entry back to the DB cache ────────────────────────────
  const persistEntry = (query: string, coords: [number, number] | null) => {
    if (!dbPath) return;
    fetch(`${apiBase}/geocode-cache?db=${encodeURIComponent(dbPath)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        lat: coords?.[0] ?? null,
        lon: coords?.[1] ?? null,
      }),
    }).catch(() => {/* fire-and-forget */});
  };

  // ── Geocode with DB cache → session cache → Nominatim ───────────────────
  // Returns [coords, fromNominatim] so the caller can rate-limit only real calls.
  const geocode = async (
    city: string | null | undefined,
    postcode: string | null | undefined,
    country: string | null | undefined,
  ): Promise<[[number, number] | null, boolean]> => {
    const query = [city, postcode, country].filter(Boolean).join(", ");
    if (!query) return [null, false];

    // 1. DB cache (loaded on mount)
    if (query in dbCache.current) return [dbCache.current[query], false];

    // 2. Session cache (survives tab switches within session)
    const sessionKey = `${dbPath}|${query}`;
    if (SESSION_CACHE.has(sessionKey)) return [SESSION_CACHE.get(sessionKey)!, false];

    // 3. Nominatim — real network call
    const coords = await geocodeNominatim(query);

    // Persist to both caches
    SESSION_CACHE.set(sessionKey, coords);
    dbCache.current[query] = coords;
    persistEntry(query, coords);

    return [coords, true];
  };

  // ── Derive entries for the active tab ───────────────────────────────────
  const relevant = tab === "kyc"
    ? receipts.filter((r) => r.receipt_type === "sale")
    : receipts.filter((r) => r.receipt_type === "purchase");

  // Aggregate by counterparty key to avoid duplicate geocode calls
  const aggregated = relevant.reduce<Record<string, AggEntry>>((acc, r) => {
    const key = r.counterparty?.id ?? displayName(r);
    const addr = r.counterparty?.address;
    if (acc[key]) {
      acc[key].amount += r.total_amount ?? 0;
      acc[key].count += 1;
    } else {
      acc[key] = {
        name: r.counterparty?.name ?? r.vendor ?? displayName(r),
        amount: r.total_amount ?? 0,
        count: 1,
        city: addr?.city,
        postcode: addr?.postcode,
        country: addr?.country,
      };
    }
    return acc;
  }, {});

  // ── Geocode on tab / receipts change ────────────────────────────────────
  useEffect(() => {
    // Wait until the DB cache is loaded before starting, to avoid redundant Nominatim calls
    const waitForCache = async () => {
      for (let i = 0; i < 50 && !dbCacheLoaded.current; i++) {
        await sleep(100);
      }
    };

    let cancelled = false;
    setLoading(true);
    const running: MapPoint[] = [];
    let unmappedCount = 0;
    let unmappedAmount = 0;
    setPoints([]);
    setUnmapped({ count: 0, amount: 0 });
    setResolved([]);

    (async () => {
      await waitForCache();

      const entries = Object.values(aggregated);
      for (let i = 0; i < entries.length; i++) {
        if (cancelled) return;
        const entry = entries[i];
        const [coords, usedNominatim] = await geocode(entry.city, entry.postcode, entry.country);

        if (cancelled) return;
        setResolved((prev) => [...prev, { ...entry, coords }]);
        if (coords) {
          const existing = running.find(
            (p) => Math.abs(p.lat - coords[0]) < 0.01 && Math.abs(p.lon - coords[1]) < 0.01,
          );
          if (existing) {
            existing.amount += entry.amount;
            existing.count += entry.count;
            existing.name += `, ${entry.name}`;
          } else {
            running.push({ lat: coords[0], lon: coords[1], name: entry.name, amount: entry.amount, count: entry.count });
          }
          setPoints([...running]);
        } else {
          unmappedCount += entry.count;
          unmappedAmount += entry.amount;
          setUnmapped({ count: unmappedCount, amount: unmappedAmount });
        }
        // Rate-limit only applies to actual Nominatim calls (cached results are instant)
        if (usedNominatim && i < entries.length - 1) await sleep(1100);
      }
      if (!cancelled) setLoading(false);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, receipts]);

  const maxAmount = Math.max(...points.map((p) => p.amount), 1);

  const tabBtn = (id: Tab) =>
    `px-5 py-1.5 text-xs font-black uppercase tracking-wider border-2 rounded transition-colors cursor-pointer ${
      tab === id
        ? "bg-black text-amber-400 border-black"
        : "bg-white text-black border-amber-400 hover:bg-amber-50"
    }`;

  return (
    <div className="bg-white border-2 border-amber-400 rounded p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-black text-sm font-black uppercase tracking-wider">
            {tab === "kyc" ? t("kyc.title_kyc") : t("kyc.title_kys")}
          </h3>
          <p className="text-black/60 text-[11px] font-mono mt-0.5">
            {tab === "kyc" ? t("kyc.sub_kyc") : t("kyc.sub_kys")}
          </p>
        </div>
        <div className="flex gap-2">
          <button className={tabBtn("kyc")} onClick={() => setTab("kyc")}>
            KYC — {t("kyc.tab_kyc")}
          </button>
          <button className={tabBtn("kys")} onClick={() => setTab("kys")}>
            KYS — {t("kyc.tab_kys")}
          </button>
        </div>
      </div>

      {/* Map — isolation:isolate prevents Leaflet z-indices from escaping into the page stacking context */}
      <div style={{ isolation: "isolate" }}>
      <div className="relative rounded overflow-hidden border border-amber-200" style={{ height: 400 }}>
        <MapContainer
          center={[20, 10]}
          zoom={2}
          style={{ height: "100%", width: "100%" }}
          scrollWheelZoom={false}
          attributionControl={true}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          />
          {points.map((p, i) => (
            <CircleMarker
              key={i}
              center={[p.lat, p.lon]}
              radius={dotRadius(p.amount, maxAmount)}
              pathOptions={{
                color: tab === "kyc" ? "#000" : "#b45309",
                fillColor: tab === "kyc" ? "#fbbf24" : "#000",
                fillOpacity: 0.75,
                weight: 1.5,
              }}
            >
              <Tooltip direction="top" offset={[0, -4]} opacity={0.95}>
                <div className="text-xs font-bold font-mono">
                  <div className="font-black text-black max-w-[220px] truncate">{p.name}</div>
                  <div className="text-amber-700 mt-0.5">{fmt(p.amount)}</div>
                  {p.count > 1 && (
                    <div className="text-black/60 text-[11px]">
                      {p.count} {t("kyc.transactions")}
                    </div>
                  )}
                </div>
              </Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>

        {/* Loading overlay */}
        {loading && (
          <div className="absolute bottom-2 left-2 bg-white/90 border border-amber-300 rounded px-2 py-1 text-[11px] font-mono text-black/70 z-[1000]">
            {t("kyc.geocoding")} {points.length} / {Object.keys(aggregated).length}…
          </div>
        )}

        {/* Empty state */}
        {!loading && points.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center z-[1000] pointer-events-none">
            <div className="bg-white/90 border border-amber-300 rounded px-4 py-2 text-sm font-mono text-black/60">
              {t("kyc.no_addresses")}
            </div>
          </div>
        )}
      </div>
      </div>

      {/* Legend */}
      {(points.length > 0 || unmapped.count > 0) && (
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[11px] font-mono text-black/60">
          <span>
            {t("kyc.legend_dot_size")}:&nbsp;
            <span className="font-bold text-black">{t("kyc.legend_log_scale")}</span>
          </span>
          <span>
            {t("kyc.legend_points")}: <span className="font-bold text-black">{points.length}</span>
          </span>
          <span>
            {t("kyc.legend_total")}: <span className="font-bold text-black">{fmt(points.reduce((s, p) => s + p.amount, 0))}</span>
          </span>
          {unmapped.count > 0 && (
            <span className="text-amber-700">
              {t("kyc.legend_unmapped", { count: unmapped.count })}:&nbsp;
              <span className="font-bold">{fmt(unmapped.amount)}</span>
              &nbsp;—&nbsp;{t("kyc.legend_unmapped_reason")}
            </span>
          )}
          {resolved.length > 0 && (
            <button
              onClick={() => setShowManage(true)}
              className="text-black/50 hover:text-black underline underline-offset-2 cursor-pointer font-mono text-[11px] transition-colors"
            >
              {t("kyc.manage_link")}
            </button>
          )}
        </div>
      )}

      {/* Manage modal */}
      {showManage && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40"
          onClick={() => setShowManage(false)}
        >
          <div
            className="bg-white border-2 border-amber-400 rounded shadow-xl flex flex-col w-[700px] max-w-[95vw] max-h-[80vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-amber-200">
              <h4 className="text-sm font-black uppercase tracking-wider text-black">
                {tab === "kyc" ? t("kyc.title_kyc") : t("kyc.title_kys")} — {t("kyc.manage_title")}
              </h4>
              <button
                onClick={() => setShowManage(false)}
                className="text-black/50 hover:text-black font-black text-lg leading-none cursor-pointer"
              >✕</button>
            </div>

            {/* Table */}
            <div className="overflow-y-auto flex-1">
              <table className="w-full text-[11px] font-mono">
                <thead className="sticky top-0 bg-amber-50 border-b border-amber-200">
                  <tr>
                    <th className="text-left px-4 py-2 text-black font-black uppercase tracking-wider w-[30%]">{t("kyc.col_name")}</th>
                    <th className="text-left px-4 py-2 text-black font-black uppercase tracking-wider w-[35%]">{t("kyc.col_address")}</th>
                    <th className="text-right px-4 py-2 text-black font-black uppercase tracking-wider w-[15%]">{t("kyc.col_amount")}</th>
                    <th className="text-left px-4 py-2 text-black font-black uppercase tracking-wider w-[20%]">{t("kyc.col_coords")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...resolved]
                    .sort((a, b) => (a.coords ? 0 : 1) - (b.coords ? 0 : 1) || b.amount - a.amount)
                    .map((entry, i) => {
                      const addrParts = [entry.city, entry.postcode, entry.country].filter(Boolean);
                      return (
                        <tr key={i} className={`border-b border-amber-100 ${entry.coords ? "" : "bg-amber-50/60"}` }>
                          <td className="px-4 py-2 text-black font-bold truncate max-w-0">
                            <span className="block truncate" title={entry.name}>{entry.name}</span>
                          </td>
                          <td className="px-4 py-2 text-black/70 truncate max-w-0">
                            <span className="block truncate" title={addrParts.join(", ") || "—"}>
                              {addrParts.join(", ") || <span className="text-black/30">—</span>}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-right text-black font-bold">{fmt(entry.amount)}</td>
                          <td className="px-4 py-2">
                            {entry.coords ? (
                              <span className="text-black/50">
                                {entry.coords[0].toFixed(3)}, {entry.coords[1].toFixed(3)}
                              </span>
                            ) : (
                              <span className="text-amber-600 font-bold">{t("kyc.col_no_coords")}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>

            {/* Modal footer */}
            <div className="px-5 py-2.5 border-t border-amber-200 text-[11px] font-mono text-black/50 flex justify-between items-center">
              <span>{resolved.length} {t("kyc.manage_entries")} · {resolved.filter((e) => e.coords).length} {t("kyc.manage_mapped")} · {resolved.filter((e) => !e.coords).length} {t("kyc.manage_unmapped")}</span>
              <button onClick={() => setShowManage(false)} className="text-black/50 hover:text-black underline cursor-pointer">{t("kyc.manage_close")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

