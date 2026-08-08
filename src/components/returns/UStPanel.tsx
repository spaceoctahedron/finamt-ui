import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconSend, IconCheck, IconClose, IconWarning, IconXml, IconCopy, IconDownload, IconInfo } from "../../constants/icons";
import type { Receipt, PeriodFilter, TaxpayerProfile, ElsterSettings } from "../Sidebar";
import { fmt, EMPTY_ELSTER } from "../Sidebar";
import { LawLink, ElsterTip, VatRow } from "./shared";
import { bundeslandKzFromState, finanzamtNrFromSteuernummer } from "../../utils/steuernummer";

// ---------------------------------------------------------------------------
// USt panel — Umsatzsteuerjahreserklärung · § 18 UStG · USt 2A
// ---------------------------------------------------------------------------
export function UStPanel({
  allReceipts,
  period,
  apiBase = "",
  dbPath,
  taxpayer,
  elsterSettings = EMPTY_ELSTER,
  onSubmissionChange,
}: {
  allReceipts:         Receipt[];
  period:              PeriodFilter;
  apiBase?:            string;
  dbPath?:             string | null;
  taxpayer?:           TaxpayerProfile | null;
  elsterSettings?:     ElsterSettings;
  onSubmissionChange?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // ── ELSTER submission state ────────────────────────────────────────
  const [elsterOpen, setElsterOpen]         = useState(false);
  const [useTest, setUseTest]               = useState(true);
  const [submitting, setSubmitting]         = useState(false);
  const [validating, setValidating]         = useState(false);
  const [submitError, setSubmitError]       = useState<string | null>(null);
  const [validateMsg, setValidateMsg]       = useState<string | null>(null);
  const [transferticket, setTransferticket] = useState<string | null>(null);
  const [savedXmlFilename, setSavedXmlFilename] = useState<string | null>(null);
  const [ustXml, setUsteXml]               = useState<string | null>(null);
  const [ustXmlOpen, setUsteXmlOpen]       = useState(false);
  const [ustXmlCopied, setUsteXmlCopied]   = useState(false);
  const [ustXmlLoading, setUsteXmlLoading] = useState(false);

  // Track whether a real (non-test) submission was already recorded
  type ExistingSubmission = { submitted_at: string; telenummer?: string; xml_filename?: string };
  const [alreadySubmittedReal, setAlreadySubmittedReal] = useState<ExistingSubmission | null>(null);
  const [confirmResubmit, setConfirmResubmit]           = useState(false);

  // Derived ELSTER params from taxpayer profile
  const derivedBundeslandKz = bundeslandKzFromState(taxpayer?.state);
  const derivedFinanzamtNr  = finanzamtNrFromSteuernummer(taxpayer?.tax_number, taxpayer?.state);

  const currentYear  = new Date().getFullYear();
  const year         = period.mode === "all" ? currentYear - 1 : period.year;

  // Load existing real-submission status whenever project or year changes
  useEffect(() => {
    setTransferticket(null); setSubmitError(null); setValidateMsg(null);
    setSavedXmlFilename(null); setAlreadySubmittedReal(null);
  }, [apiBase, dbPath, year]);

  useEffect(() => {
    const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
    fetch(`${apiBase}/submissions${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { submissions?: Array<{ type: string; year: number; use_test?: boolean; submitted_at: string; telenummer?: string; xml_filename?: string }> } | null) => {
        if (!d?.submissions) return;
        const existing = d.submissions.find(s => s.type === "uste" && s.year === year && !s.use_test);
        setAlreadySubmittedReal(existing ?? null);
      })
      .catch(() => {});
  }, [apiBase, dbPath, year]);

  async function previewUstXml() {
    setUsteXmlLoading(true);
    setSubmitError(null);
    try {
      const qs  = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/uste/xml${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year,
          steuernummer:  taxpayer?.tax_number    || undefined,
          bundesland_kz: derivedBundeslandKz     || undefined,
          finanzamt_nr:  derivedFinanzamtNr      || undefined,
          hersteller_id: elsterSettings.hersteller_id || undefined,
          cert_password: elsterSettings.cert_pin      || undefined,
          use_test:      useTest,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? res.statusText);
      }
      const text = await res.text();
      setUsteXml(text);
      setUsteXmlOpen(true);
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setUsteXmlLoading(false);
    }
  }

  async function callUstEndpoint(validateOnly: boolean) {
    const isSend = !validateOnly;
    if (isSend) { setSubmitting(true); setTransferticket(null); setSavedXmlFilename(null); }
    else        { setValidating(true);  setValidateMsg(null); }
    setSubmitError(null);
    setConfirmResubmit(false);

    try {
      const qs  = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/uste/submit${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year,
          steuernummer:  taxpayer?.tax_number    || undefined,
          bundesland_kz: derivedBundeslandKz     || undefined,
          finanzamt_nr:  derivedFinanzamtNr      || undefined,
          hersteller_id: elsterSettings.hersteller_id || undefined,
          cert_password: elsterSettings.cert_pin      || undefined,
          use_test:      useTest,
          validate_only: validateOnly,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error_message ?? data.detail ?? res.statusText);
      }
      if (isSend) {
        const tk = data.telenummer ?? "✓ OK";
        setTransferticket(tk);
        if (data.xml_filename) setSavedXmlFilename(data.xml_filename);
        if (!useTest) {
          // Update local already-submitted state so the UI reflects it immediately
          setAlreadySubmittedReal({ submitted_at: new Date().toISOString(), telenummer: tk, xml_filename: data.xml_filename });
        }
        onSubmissionChange?.();
      } else {
        setValidateMsg(data.message ?? "✓ XML valid");
      }
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isSend) setSubmitting(false);
      else        setValidating(false);
    }
  }

  function handleSendClick() {
    // Gate re-submission: if a real submission already exists, require explicit confirm
    if (!useTest && alreadySubmittedReal) {
      setConfirmResubmit(true);
      return;
    }
    callUstEndpoint(false);
  }
  const yearReceipts = allReceipts.filter((r) => r.receipt_date?.startsWith(String(year)));

  const purchases    = yearReceipts.filter((r) => r.receipt_type === "purchase");
  const sales        = yearReceipts.filter((r) => r.receipt_type === "sale");
  const regularInputVat = purchases.reduce((s, r) => s + (r.business_vat ?? r.vat_amount ?? 0), 0);
  const einfuhrInputVat = purchases.reduce((s, r) => s + (r.einfuhr_vat ?? 0), 0);
  const inputVat     = regularInputVat + einfuhrInputVat;
  const outputVat    = sales.reduce((s, r) => s + (r.business_vat ?? r.vat_amount ?? 0), 0);
  const netLiability = outputVat - inputVat;

  const salesByRate = sales.reduce<Record<string, { net: number; vat: number }>>((acc, r) => {
    if (r.vat_percentage == null) return acc;
    const key = String(r.vat_percentage);
    if (!acc[key]) acc[key] = { net: 0, vat: 0 };
    const net = r.business_net ?? r.net_amount ?? ((r.total_amount ?? 0) / (1 + (r.vat_percentage ?? 0) / 100));
    const vat = r.business_vat ?? r.vat_amount ?? ((r.total_amount ?? 0) - net);
    acc[key].net += net;
    acc[key].vat += vat;
    return acc;
  }, {});

  return (
    <div className="bg-white border-2 border-amber-400 rounded">
      <button
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-amber-50 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <h3 className="text-black text-sm font-black tracking-wide">{t("dashboard.uste_title")}</h3>
          <p className="text-[10px] text-black font-mono mt-0.5">
            {t("dashboard.decl_annual")} · <LawLink law="§ 18 UStG" href="https://www.gesetze-im-internet.de/ustg_1980/__18.html" /> · USt 2 A · {year}
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

          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="pb-1.5 pr-3 w-8" />
                <th className="pb-1.5 text-left text-[10px] font-black uppercase tracking-wider text-black">
                  {t("dashboard.uste_col_section")}
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
                  <ElsterTip lines={[t("dashboard.elster_tip_taxable_supplies_uste")]} />
                </span>
              </td></tr>
              <VatRow label={t("dashboard.vat_line_19")}
                base={fmt(salesByRate["19"]?.net ?? 0)}
                tax={fmt(salesByRate["19"]?.vat ?? 0)}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_uste_line22")]} />} />
              <VatRow label={t("dashboard.vat_line_7")}
                base={fmt(salesByRate["7"]?.net ?? 0)}
                tax={fmt(salesByRate["7"]?.vat ?? 0)}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_uste_line25")]} />} />
              <VatRow label={t("dashboard.vat_line_0")}
                base={fmt(salesByRate["0"]?.net ?? 0)}
                tax={fmt(salesByRate["0"]?.vat ?? 0)}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_uste_line28")]} />} />
              <tr><td colSpan={4} className="pt-4 pb-1">
                <span className="text-[10px] font-black uppercase tracking-wider text-black">
                  {t("dashboard.vat_input_section")}
                </span>
              </td></tr>
              <VatRow label={t("dashboard.uste_input_regular_label")}
                tax={fmt(regularInputVat)}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_uste_line79")]} />} />
              {einfuhrInputVat > 0 && (
                <VatRow label={t("dashboard.vat_einfuhr_label")}
                  tax={fmt(einfuhrInputVat)} />
              )}
              {einfuhrInputVat > 0 && (
                <VatRow label={t("dashboard.uste_input_sum_label")} bold
                  tax={fmt(inputVat)} />
              )}
              <tr><td colSpan={4} className="pt-4 pb-1">
                <span className="text-[10px] font-black uppercase tracking-wider text-black">
                  {t("dashboard.uste_calculation_section")}
                </span>
              </td></tr>
              <VatRow label={t("dashboard.uste_prepayment_soll_label")}
                tax={`${netLiability < 0 ? "−" : ""}${fmt(Math.abs(netLiability))}`}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_uste_line119")]} />} />
              <VatRow label={t("dashboard.uste_final_balance_label")} bold
                tax={fmt(0)}
                tip={<ElsterTip lines={[t("dashboard.elster_tip_uste_line120")]} />} />
            </tbody>
          </table>

          <p className="text-[10px] text-black font-mono leading-relaxed flex items-start gap-1">
            <IconInfo className="w-3 h-3 shrink-0 mt-px" /> {t("dashboard.uste_disclaimer")}
          </p>

          {/* ── ELSTER submission section ────────────────────────────── */}
          <div className="border border-amber-300 rounded-lg bg-amber-50">
            <button
              className="w-full flex items-center justify-between px-3 py-2 text-left"
              onClick={() => setElsterOpen(v => !v)}
            >
              <span className="text-[11px] font-black uppercase tracking-wider text-black flex items-center gap-1.5">
                <IconSend className="w-3.5 h-3.5 shrink-0" /> An ELSTER übermitteln
                {transferticket && (
                  <span className="ml-2 text-black normal-case font-mono flex items-center gap-1"><IconCheck className="w-3 h-3" />{transferticket}</span>
                )}
              </span>
              <IconChevronDown className={`w-3.5 h-3.5 text-black shrink-0 transition-transform ${elsterOpen ? "rotate-180" : ""}`} />
            </button>

            {elsterOpen && (
              <div className="px-3 pb-3 flex flex-col gap-2.5 text-[11px]">

                {/* Settings summary */}
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

                {/* Test mode toggle */}
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={useTest}
                    onChange={e => setUseTest(e.target.checked)}
                    className="accent-amber-500"
                  />
                  <span className="text-black">Testmodus (nicht rechtswirksam)</span>
                </label>

                {!useTest && (
                  <div className="text-black font-bold text-[10px] border border-amber-500 rounded p-2 bg-amber-50 flex items-start gap-1.5">
                    <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px" /> <span>Produktivmodus — Übermittlung ist <em>rechtswirksam</em> und wird an das Finanzamt gesendet!</span>
                  </div>
                )}

                {/* Already-submitted real warning */}
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

                {/* Re-submit confirmation gate */}
                {confirmResubmit && (
                  <div className="border-2 border-black rounded p-3 bg-white flex flex-col gap-2 shadow-[4px_4px_0_#000]">
                    <p className="text-[11px] font-black text-black">
                      Diese Erklärung wurde bereits ans Finanzamt übermittelt. Wirklich erneut senden?
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setConfirmResubmit(false)}
                        className="px-3 py-1 text-xs font-black rounded border-2 border-black bg-white text-black hover:bg-amber-50"
                      >
                        Abbrechen
                      </button>
                      <button
                        onClick={() => callUstEndpoint(false)}
                        className="px-3 py-1 text-xs font-black rounded border-2 border-black bg-black text-amber-400 hover:bg-black/80"
                      >
                        Trotzdem senden
                      </button>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-0.5 flex-wrap">
                  <button
                    className="border border-black rounded px-3 py-1 text-[11px] font-bold bg-white hover:bg-amber-100 transition-colors disabled:opacity-50 flex items-center gap-1"
                    onClick={previewUstXml}
                    disabled={ustXmlLoading || submitting}
                  >
                    <IconXml className="w-3.5 h-3.5" />
                    {ustXmlLoading ? "Lade…" : "XML anzeigen"}
                  </button>
                  <button
                    className="border border-amber-400 rounded px-3 py-1 text-[11px] font-bold bg-white hover:bg-amber-100 transition-colors disabled:opacity-50"
                    onClick={() => callUstEndpoint(true)}
                    disabled={validating || submitting}
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
                    onClick={handleSendClick}
                    disabled={submitting || validating || confirmResubmit}
                  >
                    {submitting ? "Wird übermittelt…" : useTest ? "Test-Übermittlung" : alreadySubmittedReal ? "Erneut senden…" : "An Finanzamt senden"}
                  </button>
                </div>

                {/* Result feedback */}
                {validateMsg && !submitError && (
                  <div className="text-[10px] text-black bg-amber-50 border border-amber-300 rounded p-1.5">
                    {validateMsg}
                  </div>
                )}
                {transferticket && !submitError && (
                  <div className="text-[11px] text-black bg-amber-400 border-2 border-amber-500 rounded p-2.5 flex flex-col gap-1 shadow-[2px_2px_0_#000]">
                    <div className="flex items-center gap-1.5 font-black">
                      <IconCheck className="w-4 h-4 shrink-0" />
                      {useTest
                        ? "Test-Übermittlung erfolgreich — nicht ans Finanzamt gesendet"
                        : "Erfolgreich an das Finanzamt übermittelt"}
                    </div>
                    <div className="font-mono text-[10px]">
                      Telenummer: <strong>{transferticket}</strong>
                    </div>
                    {savedXmlFilename && (
                      <div className="text-[10px] mt-0.5">
                        XML gespeichert: <span className="font-mono">{savedXmlFilename}</span>
                        <button
                          className="ml-2 underline font-bold text-black hover:no-underline"
                          onClick={async () => {
                            const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}&filename=${encodeURIComponent(savedXmlFilename)}` : `?filename=${encodeURIComponent(savedXmlFilename)}`;
                            const res = await fetch(`${apiBase}/submissions/file${qs}`);
                            if (!res.ok) return;
                            const text = await res.text();
                            setUsteXml(text);
                            setUsteXmlOpen(true);
                          }}
                        >
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
        </div>
      )}

      {/* ── USt XML Preview Modal ────────────────────────────────────── */}
      {ustXmlOpen && ustXml && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="relative bg-white border-2 border-black rounded w-[90vw] max-w-4xl h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-2 border-b-2 border-black bg-amber-50">
              <span className="text-xs font-black uppercase tracking-wider">ELSTER XML · USt {year}</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(ustXml).then(() => {
                      setUsteXmlCopied(true);
                      setTimeout(() => setUsteXmlCopied(false), 2000);
                    });
                  }}
                  className="flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-amber-100 transition-colors"
                >
                  <IconCopy className="w-3.5 h-3.5" />
                  {ustXmlCopied ? "Kopiert" : "Kopieren"}
                </button>
                <button
                  onClick={() => {
                    const blob = new Blob([ustXml], { type: "application/xml" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `USt_${year}_ELSTER.xml`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-amber-100 transition-colors"
                >
                  <IconDownload className="w-3.5 h-3.5" />
                  Download
                </button>
                <button
                  onClick={() => setUsteXmlOpen(false)}
                  className="text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-black hover:text-white transition-colors"
                >
                  Schließen
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-[10px] font-mono text-black leading-relaxed whitespace-pre select-all">
              {ustXml}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
