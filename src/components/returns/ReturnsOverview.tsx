import { useState, useEffect } from "react";
import { IconChevronDown, IconArrowUp } from "../../constants/icons";
import type { TaxpayerProfile } from "../Sidebar";

// ---------------------------------------------------------------------------
// Returns Overview — Steuererklärungen auf einen Blick
// ---------------------------------------------------------------------------
type Submission = { type: string; year: number; submitted_at: string; note?: string };

type Props = {
  taxpayer?:          TaxpayerProfile | null;
  onUpdateTaxpayer?:  (patch: Partial<TaxpayerProfile>) => void;
  apiBase?:           string;
  dbPath?:            string | null;
};

// Annual return definitions (excluding JA which has two rows)
const ANNUAL_RETURNS: { key: string; abbr: string; label: string }[] = [
  { key: "uste",           abbr: "UStE",    label: "Umsatzsteuererklärung" },
  { key: "gewst",          abbr: "GewStE",  label: "Gewerbesteuererklärung" },
  { key: "kst",            abbr: "KStE",    label: "Körperschaftsteuererklärung" },
  { key: "ebilanz",        abbr: "JA · ELSTER",      label: "Jahresabschluss — ELSTER (§ 5b EStG)" },
  { key: "bundesanzeiger", abbr: "JA · Bundesanz.",  label: "Jahresabschluss — Bundesanzeiger (§ 325 HGB)" },
];

export function ReturnsOverview({ taxpayer, onUpdateTaxpayer, apiBase = "", dbPath }: Props) {
  const currentYear = new Date().getFullYear();

  const [open,        setOpen]        = useState(true);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [saving,      setSaving]      = useState<string | null>(null);
  const [localStart,  setLocalStart]  = useState("");

  // Confirmation dialog state
  type ConfirmState = { action: "add" | "remove"; type: string; year: number; label: string };
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // Derive starting year: prefer gründungsjahr, fallback to starting_year
  const startYear  = taxpayer?.gründungsjahr ?? taxpayer?.starting_year ?? null;
  const ustvFreq   = taxpayer?.ustva_frequency ?? null;

  const years = startYear
    ? Array.from({ length: currentYear - startYear + 1 }, (_, i) => startYear + i)
    : [];

  // Load submissions whenever project/start-year changes
  useEffect(() => {
    if (!startYear) return;
    const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
    fetch(`${apiBase}/submissions${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.submissions) setSubmissions(d.submissions); })
      .catch(() => {});
  }, [apiBase, dbPath, startYear]);

  function isSubmitted(type: string, year: number) {
    return submissions.some(s => s.type === type && s.year === year);
  }

  function requestAdd(type: string, year: number, label: string) {
    if (isSubmitted(type, year)) return;
    setConfirm({ action: "add", type, year, label });
  }

  function requestRemove(type: string, year: number, label: string) {
    setConfirm({ action: "remove", type, year, label });
  }

  async function executeConfirm(yes: boolean) {
    if (!confirm) return;
    const { action, type, year } = confirm;
    setConfirm(null);
    if (!yes) return;

    const sk = `${type}|${year}`;
    setSaving(sk);
    const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";

    if (action === "add") {
      const record: Submission = { type, year, submitted_at: new Date().toISOString() };
      try {
        const res = await fetch(`${apiBase}/submissions${qs}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(record),
        });
        if (res.ok) setSubmissions(prev => [...prev, record]);
      } catch { /* ignore */ }
    } else {
      try {
        const res = await fetch(
          `${apiBase}/submissions${qs ? qs + "&" : "?"}type=${encodeURIComponent(type)}&year=${year}`,
          { method: "DELETE" },
        );
        if (res.ok) setSubmissions(prev => prev.filter(s => !(s.type === type && s.year === year)));
      } catch { /* ignore */ }
    }
    setSaving(null);
  }

  function saveStartYear() {
    const y = parseInt(localStart, 10);
    if (!isNaN(y) && y >= 1900 && y <= 2100) onUpdateTaxpayer?.({ starting_year: y });
  }

  // UStVA sub-period keys / labels
  const ustvaPeriods = ustvFreq === "monthly"
    ? Array.from({ length: 12 }, (_, i) => ({
        key: `ustva_m${String(i + 1).padStart(2, "0")}`,
        label: `M${i + 1}`,
      }))
    : Array.from({ length: 4 }, (_, i) => ({
        key: `ustva_q${i + 1}`,
        label: `Q${i + 1}`,
      }));

  // ── Cell components ──────────────────────────────────────────────────────

  function AnnualCell({ type, year, abbr }: { type: string; year: number; abbr: string }) {
    const done    = isSubmitted(type, year);
    const sk      = `${type}|${year}`;
    const loading = saving === sk;
    const submittedAt = submissions.find(s => s.type === type && s.year === year)?.submitted_at;
    const label = `${abbr} ${year}`;
    return (
      <button
        onClick={() => done ? requestRemove(type, year, label) : requestAdd(type, year, label)}
        disabled={loading}
        title={done
          ? `${label} — eingereicht am ${submittedAt ? new Date(submittedAt).toLocaleDateString("de-DE") : "?"}. Klicken zum Entfernen.`
          : `${label} als eingereicht markieren`}
        className={`w-8 h-8 mx-auto rounded border-2 flex items-center justify-center text-sm font-black transition-colors ${
          done
            ? "bg-amber-400 border-amber-500 text-black hover:bg-red-100 hover:border-red-400 cursor-pointer"
            : loading
            ? "bg-amber-50 border-amber-300 text-amber-400 cursor-wait"
            : "bg-white border-amber-200 text-black/20 hover:border-amber-500 hover:text-black/50 cursor-pointer"
        }`}
      >
        {done ? "✓" : loading ? "…" : "·"}
      </button>
    );
  }

  function UstvaCell({ year }: { year: number }) {
    return (
      <div className={`flex gap-0.5 justify-center flex-wrap ${ustvFreq === "monthly" ? "max-w-[7rem]" : "max-w-[4.5rem]"}`}>
        {ustvaPeriods.map(p => {
          const done    = isSubmitted(p.key, year);
          const sk      = `${p.key}|${year}`;
          const loading = saving === sk;
          return (
            <button
              key={p.key}
              onClick={() => done ? requestRemove(p.key, year, `${p.label} ${year}`) : requestAdd(p.key, year, `${p.label} ${year}`)}
              disabled={loading}
              title={`${p.label} ${year} — ${done ? "eingereicht. Klicken zum Entfernen." : "als eingereicht markieren"}`}
              className={`text-[9px] font-black px-1 py-0.5 rounded border transition-colors leading-none ${
                done
                  ? "bg-amber-400 border-amber-500 text-black hover:bg-red-100 hover:border-red-400 cursor-pointer"
                  : loading
                  ? "bg-amber-50 border-amber-300 text-amber-400 cursor-wait"
                  : "bg-white border-amber-200 text-black/25 hover:border-amber-500 hover:text-black cursor-pointer"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="bg-white border-2 border-amber-400 rounded">

      {/* Confirmation dialog */}
      {confirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => executeConfirm(false)}
        >
          <div
            className="bg-white border-2 border-amber-400 rounded p-5 w-72 flex flex-col gap-4 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <p className="text-sm font-black text-black">
              {confirm.action === "add"
                ? <>Haben Sie diese Erklärung eingereicht?<br /><span className="font-mono text-xs text-black/60 font-normal">{confirm.label}</span></>
                : <>Eintrag entfernen?<br /><span className="font-mono text-xs text-black/60 font-normal">{confirm.label}</span></>}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => executeConfirm(false)}
                className="px-4 py-1.5 text-xs font-black rounded border-2 border-black/20 bg-white text-black/60 hover:border-black/40 transition-colors"
              >
                Nein
              </button>
              <button
                onClick={() => executeConfirm(true)}
                className={`px-4 py-1.5 text-xs font-black rounded border-2 transition-colors ${
                  confirm.action === "add"
                    ? "bg-black border-black text-amber-400 hover:bg-black/80"
                    : "bg-red-500 border-red-500 text-white hover:bg-red-600"
                }`}
              >
                Ja
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Panel header */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-amber-50 transition-colors text-left"
        onClick={() => setOpen(v => !v)}
      >
        <div>
          <h3 className="text-black text-sm font-black tracking-wide">STEUERERKLÄRUNGEN — ÜBERSICHT</h3>
          <p className="text-[10px] text-black font-mono mt-0.5">
            Eingereichte und ausstehende Erklärungen · UStVA · UStE · GewStE · KStE · Jahresabschluss
          </p>
        </div>
        <IconChevronDown className={`w-4 h-4 text-black shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-amber-200 p-4 flex flex-col gap-4">

          {/* ── Setup prompts ─────────────────────────────────────────── */}
          {(!startYear || !ustvFreq) && (
            <div className="flex flex-wrap gap-5 items-end border border-amber-200 bg-amber-50 rounded p-3">

              {!startYear && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-black uppercase tracking-wider text-black/50">
                    Ab welchem Jahr sollen Erklärungen verfolgt werden?
                  </span>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={localStart}
                      onChange={e => setLocalStart(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && saveStartYear()}
                      placeholder="z.B. 2022"
                      min={1990}
                      max={2100}
                      className="border border-black/20 rounded px-2 py-1 text-xs font-mono w-24 focus:outline-none focus:border-amber-400"
                    />
                    <button
                      onClick={saveStartYear}
                      className="bg-black text-amber-400 text-xs font-black px-3 py-1 rounded hover:bg-black/80 transition-colors"
                    >
                      Speichern
                    </button>
                  </div>
                  <p className="text-[9px] text-black/40 font-mono">
                    Alternativ: Gründungsjahr in den Steuerpflichtigen-Daten hinterlegen.
                  </p>
                </div>
              )}

              {!ustvFreq && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-black uppercase tracking-wider text-black/50">
                    UStVA-Rhythmus
                  </span>
                  <div className="flex gap-2">
                    {(["monthly", "quarterly"] as const).map(f => (
                      <button
                        key={f}
                        onClick={() => onUpdateTaxpayer?.({ ustva_frequency: f })}
                        className="border-2 border-amber-400 bg-white text-black text-xs font-black px-3 py-1 rounded hover:bg-amber-50 transition-colors"
                      >
                        {f === "monthly" ? "Monatlich" : "Vierteljährlich"}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Hint when start year set but frequency missing ─────────── */}
          {startYear && !ustvFreq && (
            <p className="text-xs font-mono text-black/40 flex items-center gap-1">
              <IconArrowUp className="w-3.5 h-3.5 shrink-0" /> UStVA-Rhythmus wählen, um die vollständige Übersicht anzuzeigen.
            </p>
          )}

          {/* ── Main grid ─────────────────────────────────────────────── */}
          {startYear && ustvFreq && years.length > 0 && (
            <div className="overflow-x-auto -mx-4 px-4">
              <table className="border-collapse text-xs min-w-max">
                <thead>
                  <tr>
                    <th className="text-left text-[10px] font-black uppercase tracking-wider text-black/40 pb-2 pr-6 whitespace-nowrap">
                      Erklärung
                    </th>
                    {years.map(y => (
                      <th
                        key={y}
                        className="text-center text-[10px] font-black uppercase tracking-wider text-black pb-2 px-3 whitespace-nowrap border-l-2 border-amber-100"
                      >
                        {y}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>

                  {/* UStVA row */}
                  <tr className="border-t-2 border-amber-200">
                    <td className="pr-6 py-2 align-middle whitespace-nowrap">
                      <span className="font-black text-black">UStVA</span>
                      <span className="text-black/40 text-[10px] ml-1.5">
                        {ustvFreq === "monthly" ? "monatl." : "vierteljährl."}
                      </span>
                      <span className="block text-[10px] text-black/30 font-normal">Umsatzsteuer-Voranmeldung</span>
                    </td>
                    {years.map(y => (
                      <td key={y} className="px-3 py-2 border-l-2 border-amber-100 align-middle">
                        <UstvaCell year={y} />
                      </td>
                    ))}
                  </tr>

                  {/* Annual return rows */}
                  {ANNUAL_RETURNS.map(ret => (
                    <tr key={ret.key} className="border-t border-amber-100">
                      <td className="pr-6 py-1.5 align-middle whitespace-nowrap">
                        <span className="font-black text-black">{ret.abbr}</span>
                        <span className="block text-[10px] text-black/30 font-normal">{ret.label}</span>
                      </td>
                      {years.map(y => (
                        <td key={y} className="px-3 py-1.5 border-l-2 border-amber-100 align-middle">
                          <AnnualCell type={ret.key} year={y} abbr={ret.abbr} />
                        </td>
                      ))}
                    </tr>
                  ))}

                </tbody>
              </table>
            </div>
          )}

          {/* Legend */}
          {startYear && ustvFreq && (
            <div className="flex items-center gap-4 pt-1 border-t border-amber-100">
              <div className="flex items-center gap-1.5">
                <span className="w-5 h-5 rounded border-2 bg-amber-400 border-amber-500 text-black text-[9px] font-black flex items-center justify-center">✓</span>
                <span className="text-[10px] text-black/50 font-mono">Eingereicht — klicken zum Entfernen</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-5 h-5 rounded border-2 bg-white border-amber-200 text-black/20 text-[9px] font-black flex items-center justify-center">·</span>
                <span className="text-[10px] text-black/50 font-mono">Ausstehend — klicken zum Markieren</span>
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
