import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  IconChevronDown, IconSend, IconCheck, IconClose,
  IconWarning, IconXml, IconCopy, IconDownload, IconInfo,
} from "../../constants/icons";
import type { Receipt, PeriodFilter, TaxpayerProfile, ElsterSettings } from "../Sidebar";
import { fmt, EMPTY_ELSTER } from "../Sidebar";
import { ElsterTip, VatRow, LawLink } from "./shared";
import { bundeslandKzFromState, finanzamtNrFromSteuernummer } from "../../utils/steuernummer";

// ---------------------------------------------------------------------------
// UStVA panel — Umsatzsteuer-Voranmeldung · § 18 UStG
// ---------------------------------------------------------------------------
export function UStVAPanel({
  receipts,
  period,
  apiBase = "",
  dbPath,
  taxpayer,
  elsterSettings = EMPTY_ELSTER,
  onSubmissionChange,
}: {
  receipts:            Receipt[];
  period:              PeriodFilter;
  apiBase?:            string;
  dbPath?:             string | null;
  taxpayer?:           TaxpayerProfile | null;
  elsterSettings?:     ElsterSettings;
  onSubmissionChange?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // ── ELSTER submission state ────────────────────────────────────────────
  const [elsterOpen,       setElsterOpen]       = useState(false);
  const [useTest,          setUseTest]          = useState(true);
  const [submitting,       setSubmitting]       = useState(false);
  const [validating,       setValidating]       = useState(false);
  const [submitError,      setSubmitError]      = useState<string | null>(null);
  const [validateMsg,      setValidateMsg]      = useState<string | null>(null);
  const [transferticket,   setTransferticket]   = useState<string | null>(null);
  const [savedXmlFilename, setSavedXmlFilename] = useState<string | null>(null);
  const [xml,              setXml]              = useState<string | null>(null);
  const [xmlOpen,          setXmlOpen]          = useState(false);
  const [xmlCopied,        setXmlCopied]        = useState(false);
  const [xmlLoading,       setXmlLoading]       = useState(false);

  type ExistingSubmission = { submitted_at: string; telenummer?: string; xml_filename?: string };
  const [alreadySubmittedReal, setAlreadySubmittedReal] = useState<ExistingSubmission | null>(null);
  const [confirmResubmit,      setConfirmResubmit]      = useState(false);

  // ── Period helpers ──────────────────────────────────────────────────────
  const monthNames = t("sidebar.months", { returnObjects: true }) as string[];
  const declType = period.mode === "month"   ? t("dashboard.decl_monthly")
    : period.mode === "quarter" ? t("dashboard.decl_quarterly")
    : t("dashboard.decl_annual");
  const periodTag = period.mode === "month"   ? `${monthNames[period.month - 1]} ${period.year}`
    : period.mode === "quarter" ? `Q${period.quarter} ${period.year}`
    : period.mode === "year"    ? String(period.year)
    : String(new Date().getFullYear() - 1);

  const ericPeriod = period.mode === "quarter" ? 40 + period.quarter
    : period.mode === "month" ? period.month : null;

  const subType = period.mode === "quarter" ? `ustva_q${period.quarter}`
    : period.mode === "month" ? `ustva_m${String(period.month).padStart(2, "0")}`
    : null;

  const year = (period.mode === "month" || period.mode === "quarter" || period.mode === "year")
    ? period.year : new Date().getFullYear() - 1;

  const derivedBundeslandKz = bundeslandKzFromState(taxpayer?.state);
  const derivedFinanzamtNr  = finanzamtNrFromSteuernummer(taxpayer?.tax_number, taxpayer?.state);

  // ── Reset on project or period change ──────────────────────────────────
  useEffect(() => {
    setTransferticket(null); setSubmitError(null); setValidateMsg(null);
    setSavedXmlFilename(null); setAlreadySubmittedReal(null);
  }, [apiBase, dbPath, subType, year]);

  // ── Load existing submission for this period ───────────────────────────
  useEffect(() => {
    if (!subType) return;
    const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
    fetch(`${apiBase}/submissions${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { submissions?: Array<{ type: string; year: number; use_test?: boolean; submitted_at: string; telenummer?: string; xml_filename?: string }> } | null) => {
        if (!d?.submissions) return;
        const existing = d.submissions.find(s => s.type === subType && s.year === year && !s.use_test);
        setAlreadySubmittedReal(existing ?? null);
      })
      .catch(() => {});
  }, [apiBase, dbPath, subType, year]);

  function buildBody(validateOnly: boolean) {
    const base = {
      year,
      steuernummer:  taxpayer?.tax_number         || undefined,
      bundesland_kz: derivedBundeslandKz          || undefined,
      finanzamt_nr:  derivedFinanzamtNr           || undefined,
      hersteller_id: elsterSettings.hersteller_id || undefined,
      cert_password: elsterSettings.cert_pin      || undefined,
      use_test:  useTest,
      validate_only: validateOnly,
    };
    if (period.mode === "quarter") return { ...base, quarter: period.quarter };
    if (period.mode === "month")   return { ...base, month:   period.month };
    return base;
  }

  async function previewXml() {
    setXmlLoading(true); setSubmitError(null);
    try {
      const qs  = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/ustva/xml${qs}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(false)),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? res.statusText);
      }
      setXml(await res.text()); setXmlOpen(true);
    } catch (e: unknown) { setSubmitError(e instanceof Error ? e.message : String(e)); }
    finally { setXmlLoading(false); }
  }

  async function callEndpoint(validateOnly: boolean) {
    const isSend = !validateOnly;
    if (isSend) { setSubmitting(true); setTransferticket(null); setSavedXmlFilename(null); }
    else        { setValidating(true); setValidateMsg(null); }
    setSubmitError(null); setConfirmResubmit(false);
    try {
      const qs  = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/ustva/submit${qs}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(validateOnly)),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error_message ?? data.detail ?? res.statusText);
      if (isSend) {
        const tk = data.telenummer ?? "✓ OK";
        setTransferticket(tk);
        if (data.xml_filename) setSavedXmlFilename(data.xml_filename);
        if (!useTest) setAlreadySubmittedReal({ submitted_at: new Date().toISOString(), telenummer: tk, xml_filename: data.xml_filename });
        onSubmissionChange?.();
      } else {
        setValidateMsg(data.message ?? "✓ XML valid");
      }
    } catch (e: unknown) { setSubmitError(e instanceof Error ? e.message : String(e)); }
    finally { if (isSend) setSubmitting(false); else setValidating(false); }
  }

  function handleSendClick() {
    if (!useTest && alreadySubmittedReal) { setConfirmResubmit(true); return; }
    callEndpoint(false);
  }

  // ── VAT calcs ──────────────────────────────────────────────────────────
  const purchases       = receipts.filter(r => r.receipt_type === "purchase");
  const sales           = receipts.filter(r => r.receipt_type === "sale");
  const regularInputVat = purchases.reduce((s, r) => s + (r.business_vat ?? r.vat_amount ?? 0), 0);
  const einfuhrInputVat = purchases.reduce((s, r) => s + (r.einfuhr_vat ?? 0), 0);
  const inputVat        = regularInputVat + einfuhrInputVat;
  const outputVat       = sales.reduce((s, r) => s + (r.business_vat ?? r.vat_amount ?? 0), 0);
  const netLiability    = outputVat - inputVat;

  const salesByRate = sales.reduce<Record<string, { net: number; vat: number }>>((acc, r) => {
    if (r.vat_percentage == null) return acc;
    const key = String(r.vat_percentage);
    if (!acc[key]) acc[key] = { net: 0, vat: 0 };
    const net = r.business_net ?? r.net_amount ?? ((r.total_amount ?? 0) / (1 + (r.vat_percentage ?? 0) / 100));
    const vat = r.business_vat ?? r.vat_amount ?? ((r.total_amount ?? 0) - net);
    acc[key].net += net; acc[key].vat += vat;
    return acc;
  }, {});

  const canSubmit = ericPeriod !== null;

  return (
    <div className="bg-white border-2 border-amber-400 rounded">
      <button
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-amber-50 transition-colors text-left"
        onClick={() => setOpen(v => !v)}
      >
        <div>
          <h3 className="text-black text-sm font-black tracking-wide">{t("dashboard.vat_title")}</h3>
          <p className="text-[10px] text-black font-mono mt-0.5">
            {declType} · <LawLink law="§ 18 UStG" href="https://www.gesetze-im-internet.de/ustg_1980/__18.html" /> · {periodTag}
          </p>
        </div>
        <IconChevronDown className={`w-4 h-4 text-black shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-amber-200 p-4 flex flex-col gap-4">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="pb-1.5 pr-3 w-8" />
                <th className="pb-1.5 text-left text-[10px] font-black uppercase tracking-wider text-black">
                  {t("dashboard.vat_col_section")}
                </th>
                <th className="pb-1.5 text-right text-[10px] font-bold uppercase tracking-wider text-black/70 w-28 pl-6">
                  {t("dashboard.vat_col_base")}
                </th>
                <th className="pb-1.5 text-right text-[10px] font-bold uppercase tracking-wider text-black/70 w-28 pl-4">
                  {t("dashboard.vat_col_tax")}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr><td colSpan={4} className="pt-3 pb-1">
                <span className="inline-flex items-center gap-0 text-[10px] font-black uppercase tracking-wider text-black">
                  {t("dashboard.vat_taxable_supplies")}
                  <ElsterTip lines={[t("dashboard.elster_tip_taxable_supplies")]} />
                </span>
              </td></tr>
              <VatRow line="81" label={t("dashboard.vat_line_19")}
                base={fmt(salesByRate["19"]?.net ?? 0)}
                tax={fmt(salesByRate["19"]?.vat ?? 0)} />
              <VatRow line="86" label={t("dashboard.vat_line_7")}
                base={fmt(salesByRate["7"]?.net ?? 0)}
                tax={fmt(salesByRate["7"]?.vat ?? 0)} />
              <VatRow line="87" label={t("dashboard.vat_line_0")}
                base={fmt(salesByRate["0"]?.net ?? 0)}
                tax={fmt(salesByRate["0"]?.vat ?? 0)} />
              <tr><td colSpan={4} className="pt-4 pb-1">
                <span className="text-[10px] font-black uppercase tracking-wider text-black">
                  {t("dashboard.vat_input_section")}
                </span>
              </td></tr>
              <VatRow line="66" label={t("dashboard.vat_input_label")}
                tax={fmt(inputVat)}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_line66_1"), t("dashboard.elster_tip_line66_2")]} />} />
              <tr className="border-t-2 border-amber-400">
                <td className="pt-3 pb-2 pr-3 text-[11px] font-mono font-bold text-black w-8">83</td>
                <td className="pt-3 pb-2">
                  <span className="inline-flex items-center gap-0 text-xs font-bold text-black">
                    {netLiability >= 0 ? t("dashboard.vat_payable_label") : t("dashboard.vat_refund_label")}
                    <ElsterTip lines={[t("dashboard.elster_tip_line83")]} />
                  </span>
                  <span className="block text-[10px] text-black/70 font-normal">
                    {netLiability >= 0 ? t("dashboard.vat_payable_sub") : t("dashboard.vat_refund_sub")}
                  </span>
                </td>
                <td />
                <td className="pt-3 pb-2 text-right font-mono text-sm font-black text-black whitespace-nowrap pl-4 w-28">
                  {netLiability < 0 ? "−" : ""}{fmt(Math.abs(netLiability))}
                </td>
              </tr>
            </tbody>
          </table>

          {/* ── ELSTER submission section ────────────────────────────── */}
          {canSubmit ? (
            <div className="border border-amber-300 rounded-lg bg-amber-50">
              <button
                className="w-full flex items-center justify-between px-3 py-2 text-left"
                onClick={() => setElsterOpen(v => !v)}
              >
                <span className="text-[11px] font-black uppercase tracking-wider text-black flex items-center gap-1.5">
                  <IconSend className="w-3.5 h-3.5 shrink-0" /> An ELSTER übermitteln
                  {transferticket && (
                    <span className="ml-2 text-black normal-case font-mono flex items-center gap-1">
                      <IconCheck className="w-3 h-3" />{transferticket}
                    </span>
                  )}
                </span>
                <IconChevronDown className={`w-3.5 h-3.5 text-black shrink-0 transition-transform ${elsterOpen ? "rotate-180" : ""}`} />
              </button>

              {elsterOpen && (
                <div className="px-3 pb-3 flex flex-col gap-2.5 text-[11px]">
                  <div className="text-[10px] text-black/60 font-mono grid grid-cols-2 gap-x-4 gap-y-0.5 bg-white border border-amber-200 rounded px-2 py-1.5">
                    <span>Steuernr.: <strong className="text-black">{taxpayer?.tax_number || <em>nicht gesetzt</em>}</strong></span>
                    <span>Finanzamt: <strong className="text-black">{derivedFinanzamtNr || <em>—</em>}</strong></span>
                    <span>Länder-Kz.: <strong className="text-black">{derivedBundeslandKz || <em>—</em>}</strong></span>
                    <span>Hersteller-ID: <strong className="text-black">{elsterSettings.hersteller_id || <em>nicht gesetzt</em>}</strong></span>
                    <span className="col-span-2">Zertifikat: <strong className="text-black">{elsterSettings.cert_saved ? "✓ gespeichert" : <em>nicht hochgeladen</em>}</strong></span>
                  </div>
                  {(!elsterSettings.cert_saved || !elsterSettings.hersteller_id || !taxpayer?.tax_number) && (
                    <p className="text-[10px] text-black font-mono">
                      <IconInfo className="w-3 h-3 inline mr-0.5" /> ELSTER-Daten unvollständig — bitte im Unternehmensprofil (<strong>Bearbeiten</strong>) ergänzen.
                    </p>
                  )}

                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={useTest} onChange={e => setUseTest(e.target.checked)} className="accent-amber-500" />
                    <span className="text-black">Testmodus (nicht rechtswirksam)</span>
                  </label>

                  {!useTest && (
                    <div className="text-black font-bold text-[10px] border border-amber-500 rounded p-2 bg-amber-50 flex items-start gap-1.5">
                      <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px" />
                      <span>Produktivmodus — Übermittlung ist <em>rechtswirksam</em> und wird an das Finanzamt gesendet!</span>
                    </div>
                  )}

                  {alreadySubmittedReal && !useTest && (
                    <div className="text-[10px] text-black border-2 border-amber-500 bg-amber-50 rounded p-2 flex items-start gap-1.5">
                      <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-black" />
                      <span>
                        <strong>Bereits übermittelt</strong> am {new Date(alreadySubmittedReal.submitted_at).toLocaleDateString("de-DE")}
                        {alreadySubmittedReal.telenummer ? ` · Telenummer: ${alreadySubmittedReal.telenummer}` : ""}.
                        Eine erneute Übermittlung ist rechtswirksam!
                      </span>
                    </div>
                  )}

                  {confirmResubmit && (
                    <div className="border-2 border-black rounded p-3 bg-white flex flex-col gap-2 shadow-[4px_4px_0_#000]">
                      <p className="text-[11px] font-black text-black">
                        Diese Erklärung wurde bereits ans Finanzamt übermittelt. Wirklich erneut senden?
                      </p>
                      <div className="flex gap-2">
                        <button onClick={() => setConfirmResubmit(false)}
                          className="px-3 py-1 text-xs font-black rounded border-2 border-black bg-white text-black hover:bg-amber-50">
                          Abbrechen
                        </button>
                        <button onClick={() => callEndpoint(false)}
                          className="px-3 py-1 text-xs font-black rounded border-2 border-black bg-black text-amber-400 hover:bg-black/80">
                          Trotzdem senden
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2 pt-0.5 flex-wrap">
                    <button
                      className="border border-black rounded px-3 py-1 text-[11px] font-bold bg-white hover:bg-amber-100 transition-colors disabled:opacity-50 flex items-center gap-1"
                      onClick={previewXml} disabled={xmlLoading || submitting}
                    >
                      <IconXml className="w-3.5 h-3.5" /> {xmlLoading ? "Lade…" : "XML anzeigen"}
                    </button>
                    <button
                      className="border border-amber-400 rounded px-3 py-1 text-[11px] font-bold bg-white hover:bg-amber-100 transition-colors disabled:opacity-50"
                      onClick={() => callEndpoint(true)} disabled={validating || submitting}
                    >
                      {validating ? "Prüfe…" : "Validieren"}
                    </button>
                    <button
                      className={`rounded px-3 py-1 text-[11px] font-bold transition-colors disabled:opacity-50 ${
                        useTest
                          ? "bg-amber-400 hover:bg-amber-500 text-black border border-amber-500"
                          : alreadySubmittedReal
                          ? "bg-white border-2 border-amber-500 text-black hover:bg-amber-50"
                          : "bg-black hover:bg-amber-500 text-white hover:text-black border border-black"
                      }`}
                      onClick={handleSendClick} disabled={submitting || validating || confirmResubmit}
                    >
                      {submitting ? "Wird übermittelt…" : useTest ? "Test-Übermittlung" : alreadySubmittedReal ? "Erneut senden…" : "An Finanzamt senden"}
                    </button>
                  </div>

                  {validateMsg && !submitError && (
                    <div className="text-[10px] text-black bg-amber-50 border border-amber-300 rounded p-1.5">{validateMsg}</div>
                  )}
                  {transferticket && !submitError && (
                    <div className="text-[11px] text-black bg-amber-400 border-2 border-amber-500 rounded p-2.5 flex flex-col gap-1 shadow-[2px_2px_0_#000]">
                      <div className="flex items-center gap-1.5 font-black">
                        <IconCheck className="w-4 h-4 shrink-0" />
                        {useTest ? "Test-Übermittlung erfolgreich — nicht ans Finanzamt gesendet" : "Erfolgreich an das Finanzamt übermittelt"}
                      </div>
                      <div className="font-mono text-[10px]">Telenummer: <strong>{transferticket}</strong></div>
                      {savedXmlFilename && (
                        <div className="text-[10px] mt-0.5">
                          XML gespeichert: <span className="font-mono">{savedXmlFilename}</span>
                          <button className="ml-2 underline font-bold text-black hover:no-underline"
                            onClick={async () => {
                              const qs = dbPath
                                ? `?db=${encodeURIComponent(dbPath)}&filename=${encodeURIComponent(savedXmlFilename)}`
                                : `?filename=${encodeURIComponent(savedXmlFilename)}`;
                              const res = await fetch(`${apiBase}/submissions/file${qs}`);
                              if (!res.ok) return;
                              setXml(await res.text()); setXmlOpen(true);
                            }}>
                            Anzeigen
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  {submitError && (
                    <div className="text-[10px] text-black bg-white border border-black rounded p-1.5 font-mono break-words flex items-start gap-1">
                      <IconClose className="w-3.5 h-3.5 shrink-0 mt-px" /> {submitError}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-[10px] text-black/50 font-mono">
              <IconInfo className="w-3 h-3 inline mr-0.5" />
              ELSTER-Übermittlung: Seitenleiste auf einen bestimmten Monat oder ein Quartal stellen.
            </p>
          )}
        </div>
      )}

      {/* ── XML Preview Modal ─────────────────────────────────────────── */}
      {xmlOpen && xml && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="relative bg-white border-2 border-black rounded w-[90vw] max-w-4xl h-[80vh] flex flex-col shadow-[4px_4px_0_#000]">
            <div className="flex items-center justify-between px-4 py-2 border-b-2 border-black bg-amber-50">
              <span className="text-xs font-black uppercase tracking-wider">ELSTER XML · UStVA {periodTag}</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { navigator.clipboard.writeText(xml).then(() => { setXmlCopied(true); setTimeout(() => setXmlCopied(false), 2000); }); }}
                  className="flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-amber-100 transition-colors"
                >
                  <IconCopy className="w-3.5 h-3.5" /> {xmlCopied ? "Kopiert" : "Kopieren"}
                </button>
                <button
                  onClick={() => {
                    const blob = new Blob([xml], { type: "application/xml" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url; a.download = `UStVA_${periodTag.replace(" ", "_")}_ELSTER.xml`; a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-amber-100 transition-colors"
                >
                  <IconDownload className="w-3.5 h-3.5" /> Download
                </button>
                <button onClick={() => setXmlOpen(false)}
                  className="text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-black hover:text-white transition-colors">
                  Schließen
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-[10px] font-mono text-black leading-relaxed whitespace-pre select-all">{xml}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
