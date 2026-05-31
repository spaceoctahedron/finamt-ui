import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconInfo } from "../../constants/icons";
import type { Receipt, PeriodFilter, TaxpayerProfile } from "../Sidebar";
import { CASHFLOW_ONLY_CATS } from "../Sidebar";
import { LawLink } from "./shared";

// ---------------------------------------------------------------------------
// Gewerbesteuererklärung panel — §§ 14 ff. GewStG
// ---------------------------------------------------------------------------
export function computeGewerbeertrag(allReceipts: Receipt[], year: number): number {
  let revenue = 0, expenses = 0;
  for (const r of allReceipts) {
    if (!r.receipt_date) continue;
    const ry = parseInt(r.receipt_date.slice(0, 4), 10);
    if (ry !== year) continue;
    // Exclude cashflow-only categories from trade-tax base (§ 7 GewStG)
    if (CASHFLOW_ONLY_CATS.has(r.category ?? "other")) continue;
    const net = r.net_amount ?? ((r.total_amount ?? 0) - (r.vat_amount ?? 0));
    if (r.receipt_type === "purchase") expenses += net;
    else revenue += net;
  }
  return Math.round((revenue - expenses) * 100) / 100;
}

export function GewStPanel({ allReceipts, period, taxpayer, onEditTaxpayer }: {
  allReceipts:     Receipt[];
  period:          PeriodFilter;
  taxpayer?:       TaxpayerProfile | null;
  onEditTaxpayer?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hebesatz = taxpayer?.hebesatz ?? 400;

  const currentYear = new Date().getFullYear();
  const year = period.mode === "all" ? currentYear - 1 : period.year;

  const gewerbeertrag        = computeGewerbeertrag(allReceipts, year);
  // Round down to full 100 € — § 11 Abs. 1 GewStG
  const gewerbeertragRounded = Math.floor(Math.max(gewerbeertrag, 0) / 100) * 100;
  const steuermessbetrag     = Math.round(gewerbeertragRounded * 0.035 * 100) / 100;
  const gewerbesteuer        = Math.round(steuermessbetrag * (hebesatz / 100) * 100) / 100;

  const fE = (n: number) =>
    n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

  return (
    <div className="bg-white border-2 border-amber-400 rounded">
      <button
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-amber-50 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <h3 className="text-black text-sm font-black tracking-wide">{t("dashboard.gewst_title")}</h3>
          <p className="text-[10px] text-black font-mono mt-0.5">
            {t("dashboard.decl_annual")} · <LawLink law="§§ 14 ff. GewStG" href="https://www.gesetze-im-internet.de/gewstg/__14.html" /> · GewSt 1A · {year}
          </p>
        </div>
        <IconChevronDown className={`w-4 h-4 text-black shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-amber-200 p-4 flex flex-col gap-4">

          {/* Year badge */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase text-black">{t("dashboard.jab_year")}</span>
            <span className="text-xs font-black font-mono text-black bg-amber-100 border border-amber-300 rounded px-2 py-0.5">{year}</span>
            {period.mode === "all" && (
              <span className="text-[10px] text-black font-mono">← {t("dashboard.jab_year_hint_all")}</span>
            )}
          </div>

          {/* Hebesatz display + edit link */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-bold uppercase text-black">{t("dashboard.gewst_hebesatz")}</span>
              <span className="text-xs font-black font-mono text-black bg-amber-100 border border-amber-300 rounded px-2 py-0.5">{hebesatz} %</span>
            </div>
            {onEditTaxpayer && (
              <button
                onClick={onEditTaxpayer}
                className="text-[10px] font-bold text-black underline underline-offset-2 hover:text-amber-700 transition-colors pb-0.5"
              >
                {t("sidebar.taxpayer_edit_btn")} →
              </button>
            )}
          </div>

          {/* Allgemeine Angaben */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-black uppercase tracking-wider text-black">{t("dashboard.gewst_allgemeine_angaben")}</span>
            <table className="w-full text-xs font-mono border-collapse">
              <tbody>
                <tr className="border-b border-amber-100">
                  <td className="py-1 text-black/40 text-[10px] w-8">3</td>
                  <td className="py-1 text-black/70">{t("dashboard.gewst_firma")}</td>
                  <td className="py-1 text-right text-black font-bold">{taxpayer?.name || "—"}</td>
                </tr>
                <tr className="border-b border-amber-100">
                  <td className="py-1 text-black/40 text-[10px] w-8">4</td>
                  <td className="py-1 text-black/70">{t("dashboard.gewst_gegenstand")}</td>
                  <td className="py-1 text-right text-black">{taxpayer?.gegenstand || "—"}</td>
                </tr>
                <tr className="border-b border-amber-100">
                  <td className="py-1 text-black/40 text-[10px] w-8">14</td>
                  <td className="py-1 text-black/70">{t("dashboard.gewst_rechtsform")}</td>
                  <td className="py-1 text-right text-black">{taxpayer?.rechtsform || "GmbH"}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Angaben zur Betriebsstätte */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-black uppercase tracking-wider text-black">{t("dashboard.gewst_betriebsstaette")}</span>
            <table className="w-full text-xs font-mono border-collapse">
              <tbody>
                {(
                  [
                    [26, "gewst_mehrere_gemeinden",   "betriebsstaette_mehrere"],
                    [27, "gewst_erstreckt_gemeinden", "betriebsstaette_erstreckt"],
                    [28, "gewst_verlegt",             "betriebsstaette_verlegt"],
                  ] as [number, string, keyof TaxpayerProfile][]
                ).map(([zeile, labelKey, field]) => {
                  const val = taxpayer?.[field];
                  const jaOrNein = val ? "Ja" : "Nein";
                  return (
                    <tr key={zeile} className="border-b border-amber-100">
                      <td className="py-1 text-black/40 text-[10px] w-8">{zeile}</td>
                      <td className="py-1 text-black/70">{t(`dashboard.${labelKey}`)}</td>
                      <td className="py-1 text-right">
                        <span className={`font-bold ${val ? "text-amber-700" : "text-black"}`}>{jaOrNein}</span>
                        {onEditTaxpayer && <button onClick={onEditTaxpayer} className="ml-2 text-[9px] text-black/40 underline hover:text-amber-700">✎</button>}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-b border-amber-100">
                  <td className="py-1 text-black/40 text-[10px] w-8">31</td>
                  <td className="py-1 text-black/70">{t("dashboard.gewst_plz")}</td>
                  <td className="py-1 text-right text-black">{taxpayer?.postcode || "—"}</td>
                </tr>
                <tr className="border-b border-amber-100">
                  <td className="py-1 text-black/40 text-[10px] w-8">32</td>
                  <td className="py-1 text-black/70">{t("dashboard.gewst_ort")}</td>
                  <td className="py-1 text-right text-black">{taxpayer?.city || "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Gewinn aus Gewerbebetrieb + computation */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-black uppercase tracking-wider text-black">{t("dashboard.gewst_gewinn_section")}</span>
            <table className="w-full text-xs font-mono border-collapse">
              <tbody>
                <tr className="border-b border-amber-100">
                  <td className="py-1.5 text-black/40 text-[10px] w-8">39</td>
                  <td className="py-1.5 text-black">{t("dashboard.gewst_gewerbeertrag")}</td>
                  <td className="py-1.5 text-right text-black">{fE(gewerbeertrag)}</td>
                </tr>
                <tr className="border-b border-amber-100">
                  <td className="py-1.5 w-8" />
                  <td className="py-1.5 text-black/70 pl-4">{t("dashboard.gewst_rounded")}</td>
                  <td className="py-1.5 text-right text-black/70">{fE(gewerbeertragRounded)}</td>
                </tr>
                <tr className="border-b border-amber-100">
                  <td className="py-1.5 w-8" />
                  <td className="py-1.5 text-black">× {t("dashboard.gewst_steuermesszahl")} (3,5 %)</td>
                  <td className="py-1.5 text-right text-black">{fE(steuermessbetrag)}</td>
                </tr>
                <tr className="border-t-2 border-amber-300">
                  <td className="py-2 w-8" />
                  <td className="py-2 font-black text-black text-sm">
                    × {t("dashboard.gewst_hebesatz")} ({hebesatz} %) = {t("dashboard.gewst_gewerbesteuer")}
                  </td>
                  <td className={`py-2 text-right font-black text-sm ${gewerbesteuer === 0 ? "text-black/60" : "text-black"}`}>
                    {fE(gewerbesteuer)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {gewerbeertrag <= 0 && (
            <div className="bg-amber-50 border border-amber-300 rounded p-2 text-[11px] font-mono text-black/70">
              {t("dashboard.gewst_no_liability")}
            </div>
          )}

          <p className="text-[10px] text-black font-mono leading-relaxed flex items-start gap-1">
            <IconInfo className="w-3 h-3 shrink-0 mt-px" /> {t("dashboard.gewst_disclaimer")}
          </p>
        </div>
      )}
    </div>
  );
}
