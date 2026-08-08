import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconInfo, IconSend, IconCheck, IconClose, IconWarning, IconXml, IconCopy, IconDownload } from "../../constants/icons";
import type { Receipt, PeriodFilter, TaxpayerProfile, ElsterSettings } from "../Sidebar";
import { CASHFLOW_ONLY_CATS, EMPTY_ELSTER } from "../Sidebar";
import { LawLink, ElsterTip } from "./shared";
import { bundeslandKzFromState, finanzamtNrFromSteuernummer } from "../../utils/steuernummer";

// ---------------------------------------------------------------------------
// Körperschaftsteuererklärung panel — § 31 KStG
// Flow: Anlage GK → Anlage ZVE → KSt 1 (Steuerberechnung)
// ---------------------------------------------------------------------------

/** Small section-header used inside the expanded panel */
function AnlageHeader({ title, law, href }: { title: string; law: string; href: string }) {
  return (
    <div className="flex items-baseline gap-2 border-b-2 border-black pb-1 mt-1">
      <span className="text-[10px] font-black uppercase tracking-wider text-black">{title}</span>
      <span className="text-[10px] font-mono text-black/50">
        · <LawLink law={law} href={href} />
      </span>
    </div>
  );
}

/** Lightweight sub-section divider row within a table (used inside Anlage ZVE) */
function ZveSubHeader({ title }: { title: string }) {
  return (
    <tr>
      <td colSpan={2} className="pt-3 pb-0.5 text-[9px] font-black uppercase tracking-widest text-black/40 font-mono border-b border-amber-200">
        {title}
      </td>
    </tr>
  );
}

/** A single computation row: label | value (right-aligned) */
function KRow({
  label, value, bold, dim, indent, tip,
}: {
  label: string; value: string; bold?: boolean; dim?: boolean; indent?: boolean; tip?: React.ReactNode;
}) {
  const base = bold ? "font-black text-black text-sm" : dim ? "text-black/40" : "text-black";
  return (
    <tr className="border-b border-amber-100 last:border-0">
      <td className={`py-1.5 text-xs font-mono ${base} ${indent ? "pl-4" : ""}`}>
        <span className="inline-flex items-center gap-0">{label}{tip}</span>
      </td>
      <td className={`py-1.5 text-right text-xs font-mono ${bold ? "font-black text-black" : dim ? "text-black/40" : "text-black"} whitespace-nowrap pl-6 w-36`}>
        {value}
      </td>
    </tr>
  );
}

export function KStPanel({
  allReceipts, period, taxpayer, onEditTaxpayer,
  apiBase = "", dbPath, elsterSettings = EMPTY_ELSTER, onSubmissionChange,
}: {
  allReceipts:        Receipt[];
  period:             PeriodFilter;
  taxpayer?:          TaxpayerProfile | null;
  onEditTaxpayer?:    () => void;
  apiBase?:           string;
  dbPath?:            string | null;
  elsterSettings?:    ElsterSettings;
  onSubmissionChange?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // ── ELSTER submission state ────────────────────────────────────────
  const [elsterOpen,       setElsterOpen]       = useState(false);
  const [useTest,          setUseTest]          = useState(true);
  const [submitting,       setSubmitting]       = useState(false);
  const [validating,       setValidating]       = useState(false);
  const [submitError,      setSubmitError]      = useState<string | null>(null);
  const [validateMsg,      setValidateMsg]      = useState<string | null>(null);
  const [transferticket,   setTransferticket]   = useState<string | null>(null);
  const [savedXmlFilename, setSavedXmlFilename] = useState<string | null>(null);
  const [kstXml,           setKstXml]           = useState<string | null>(null);
  const [kstXmlOpen,       setKstXmlOpen]       = useState(false);
  const [kstXmlCopied,     setKstXmlCopied]     = useState(false);
  const [kstXmlLoading,    setKstXmlLoading]    = useState(false);

  type ExistingSubmission = { submitted_at: string; telenummer?: string; xml_filename?: string };
  const [alreadySubmittedReal, setAlreadySubmittedReal] = useState<ExistingSubmission | null>(null);
  const [confirmResubmit,      setConfirmResubmit]      = useState(false);

  const derivedBundeslandKz = bundeslandKzFromState(taxpayer?.state);
  const derivedFinanzamtNr  = finanzamtNrFromSteuernummer(taxpayer?.tax_number, taxpayer?.state);

  const currentYear = new Date().getFullYear();
  const year        = period.mode === "all" ? currentYear - 1 : period.year;

  // Reset ELSTER state on project / year change
  useEffect(() => {
    setTransferticket(null); setSubmitError(null); setValidateMsg(null);
    setSavedXmlFilename(null); setAlreadySubmittedReal(null);
  }, [apiBase, dbPath, year]);

  // Load existing real-submission status
  useEffect(() => {
    const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
    fetch(`${apiBase}/submissions${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { submissions?: Array<{ type: string; year: number; use_test?: boolean; submitted_at: string; telenummer?: string; xml_filename?: string }> } | null) => {
        if (!d?.submissions) return;
        const existing = d.submissions.find(s => s.type === "kst" && s.year === year && !s.use_test);
        setAlreadySubmittedReal(existing ?? null);
      })
      .catch(() => {});
  }, [apiBase, dbPath, year]);

  const yearReceipts = allReceipts.filter((r) => r.receipt_date?.startsWith(String(year)));

  const purchases = yearReceipts.filter((r) => r.receipt_type === "purchase" && !CASHFLOW_ONLY_CATS.has(r.category));
  const sales     = yearReceipts.filter((r) => r.receipt_type === "sale"     && !CASHFLOW_ONLY_CATS.has(r.category));

  const revenueNet = sales.reduce((s, r) => {
    const net = r.business_net ?? r.net_amount ?? ((r.total_amount ?? 0) / (1 + (r.vat_percentage ?? 19) / 100));
    return s + net;
  }, 0);
  const expenseNet = purchases.reduce((s, r) => {
    const net = r.business_net ?? r.net_amount ?? ((r.total_amount ?? 0) / (1 + (r.vat_percentage ?? 19) / 100));
    return s + net;
  }, 0);

  // Anlage GK — ELSTER: volle Geldbeträge (whole euros, § 60 Abs. 2 EStDV)
  const steuerbilanzgewinn = Math.round(revenueNet - expenseNet); // full euros
  const hinzurechnungen    = 0; // manual — show as 0
  const einkuenfteGK       = steuerbilanzgewinn + hinzurechnungen;

  // Anlage ZVE
  const gesamtbetrag  = einkuenfteGK;
  const verlustabzug  = 0; // manual
  const spendenabzug  = 0; // manual
  const einkommen     = gesamtbetrag - verlustabzug - spendenabzug;
  const zve           = einkommen; // no Freibetrag for GmbH

  // KSt liability (kept for potential future use / summary badge)
  // const koerperschaftsteuer = Math.round(Math.max(zve, 0) * 0.15);
  // const solidaritaet        = Math.round(koerperschaftsteuer * 0.055);

  // Anlage Verluste — triggered when Gesamtbetrag der Einkünfte is negative (§ 10d EStG)
  const verlustJahr    = gesamtbetrag < 0 ? Math.abs(gesamtbetrag) : 0;
  const anfangsbestand = 0; // prior-year Endbestand — manual entry in ELSTER
  const endbestand     = anfangsbestand + verlustJahr;

  // Anlage KSt 1 F — Einlagekonto + ausschüttbarer Gewinn
  const nennkapital        = Math.round(taxpayer?.stammkapital ?? 0);
  // Steuerliches Einlagekonto (§ 27 KStG) = 0 for a standard GmbH:
  // eingezahlt is a partial Nennkapital payment, NOT an additional equity contribution beyond Stammkapital.
  // Only Agios / Zuzahlungen above registered Stammkapital would be recorded here.
  const einlagekontoAnfang = 0;
  // Eigenkapital (Steuerbilanz, Jahresende) = Stammkapital + Σ Steuerbilanzgewinn aller Jahre
  // von Gründung bis einschließlich VZ — not just the current year!
  const gründungsjahr = taxpayer?.gründungsjahr ?? year;
  const netForYear = (y: number) => {
    const recs = allReceipts.filter(
      (r) => r.receipt_date?.startsWith(String(y)) && !CASHFLOW_ONLY_CATS.has(r.category)
    );
    const rev = recs.filter((r) => r.receipt_type === "sale").reduce((s, r) => {
      const net = r.business_net ?? r.net_amount ?? ((r.total_amount ?? 0) / (1 + (r.vat_percentage ?? 19) / 100));
      return s + net;
    }, 0);
    const exp = recs.filter((r) => r.receipt_type === "purchase").reduce((s, r) => {
      const net = r.business_net ?? r.net_amount ?? ((r.total_amount ?? 0) / (1 + (r.vat_percentage ?? 19) / 100));
      return s + net;
    }, 0);
    return rev - exp;
  };
  // Sum from founding year through (and including) this year
  let cumulativeGewinn = 0;
  for (let y = gründungsjahr; y <= year; y++) cumulativeGewinn += netForYear(y);
  cumulativeGewinn = Math.round(cumulativeGewinn);
  const eigenkapitalApprox = nennkapital + cumulativeGewinn;
  // Z.20: Ausschüttbarer Gewinn = max(0, Eigenkapital − Nennkapital − pos. Einlagekonto)
  const ausschuettbar      = Math.max(0, eigenkapitalApprox - nennkapital - einlagekontoAnfang);

  // Formatter for ELSTER whole-euro fields (no decimal separator)
  const fE = (n: number) =>
    n.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " €";
  const negFmt = (n: number) => (n < 0 ? `−${fE(Math.abs(n))}` : fE(n));

  // The zvE passed to the backend = steuerbilanzgewinn (= whole euros)
  const zveForApi = steuerbilanzgewinn;

  async function previewKstXml() {
    setKstXmlLoading(true);
    setSubmitError(null);
    try {
      const qs  = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/kst/xml${qs}`, {
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
          zve_override:  zveForApi,
          company_name:  taxpayer?.name || undefined,
          rechtsform:    taxpayer?.rechtsform || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? res.statusText);
      }
      setKstXml(await res.text());
      setKstXmlOpen(true);
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setKstXmlLoading(false);
    }
  }

  async function callKstEndpoint(validateOnly: boolean) {
    const isSend = !validateOnly;
    if (isSend) { setSubmitting(true); setTransferticket(null); setSavedXmlFilename(null); }
    else        { setValidating(true);  setValidateMsg(null); }
    setSubmitError(null);
    setConfirmResubmit(false);
    try {
      const qs  = dbPath ? `?db=${encodeURIComponent(dbPath)}` : "";
      const res = await fetch(`${apiBase}/tax/kst/submit${qs}`, {
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
          zve_override:  zveForApi,
          company_name:  taxpayer?.name || undefined,
          rechtsform:    taxpayer?.rechtsform || undefined,
        }),
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
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isSend) setSubmitting(false);
      else        setValidating(false);
    }
  }

  function handleSendClick() {
    if (!useTest && alreadySubmittedReal) { setConfirmResubmit(true); return; }
    callKstEndpoint(false);
  }

  return (
    <div className="bg-white border-2 border-amber-400 rounded">
      <button
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-amber-50 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <h3 className="text-black text-sm font-black tracking-wide">{t("dashboard.kst_title")}</h3>
          <p className="text-[10px] text-black font-mono mt-0.5">
            {t("dashboard.decl_annual")} · <LawLink law="§ 31 KStG" href="https://www.gesetze-im-internet.de/kstg_1977/__31.html" /> · KSt 1 + Anlage GK + Anlage ZVE · {year}
          </p>
        </div>
        <IconChevronDown className={`w-4 h-4 text-black shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-amber-200 p-4 flex flex-col gap-5">

          {/* Year badge */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase text-black">{t("dashboard.jab_year")}</span>
            <span className="text-xs font-black font-mono text-black bg-amber-100 border border-amber-300 rounded px-2 py-0.5">{year}</span>
            {period.mode === "all" && (
              <span className="text-[10px] text-black font-mono">← {t("dashboard.jab_year_hint_all")}</span>
            )}
          </div>

          {/* ── KSt 1 — Steuerberechnung ───────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <AnlageHeader
              title={t("dashboard.kst_kst1_title")}
              law="§ 23 KStG"
              href="https://www.gesetze-im-internet.de/kstg_1977/__23.html"
            />
            <table className="w-full border-collapse">
              <tbody>

                {/* 1 — Allgemeine Angaben */}
                <ZveSubHeader title={t("dashboard.kst_kst1_allgemein_title")} />
                <KRow
                  label={t("dashboard.kst_kst1_z1_name")}
                  value={taxpayer?.name ?? t("dashboard.kst_manual_entry")}
                  dim={!taxpayer?.name}
                />
                <KRow
                  label={t("dashboard.kst_kst1_z9_rechtsform")}
                  value={taxpayer?.rechtsform ?? "—"}
                  dim={!taxpayer?.rechtsform}
                  tip={!taxpayer?.rechtsform ? <ElsterTip lines={[t("dashboard.kst_kst1_z9_note")]} /> : undefined}
                />

                {/* 3 — Steuerbefreiung */}
                <ZveSubHeader title={t("dashboard.kst_kst1_steuerbefreiung_title")} />
                <KRow
                  label={t("dashboard.kst_kst1_z10")}
                  value={t("dashboard.kst_leer_lassen")}
                  dim
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_kst1_z10_note"),
                    t("dashboard.kst_kst1_z10_note_2"),
                  ]} />}
                />

                {/* 5 — Wirtschaftsjahr */}
                <ZveSubHeader title={t("dashboard.kst_kst1_wj_title")} />
                <KRow
                  label={t("dashboard.kst_kst1_z14_von")}
                  value={`01.01.${year}`}
                  tip={<ElsterTip lines={[t("dashboard.kst_kst1_z14_note")]} />}
                />
                <KRow
                  label={t("dashboard.kst_kst1_z14_bis")}
                  value={`31.12.${year}`}
                />
                {taxpayer?.gründungsjahr && (
                  <KRow
                    label={t("dashboard.kst_kst1_z14a")}
                    value={t("dashboard.kst_kst1_ja")}
                    tip={<ElsterTip lines={[t("dashboard.kst_kst1_z14a_note")]} />}
                  />
                )}

                {/* 6 — Weitere Angaben + Erklärungen */}
                <ZveSubHeader title={t("dashboard.kst_kst1_weitere_title")} />
                <KRow
                  label={t("dashboard.kst_kst1_z_organschaft")}
                  value={t("dashboard.kst_kst1_nein")}
                  dim
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_kst1_z_organschaft_note"),
                  ]} />}
                />
                <KRow
                  label={t("dashboard.kst_kst1_z_einlagekonto")}
                  value={t("dashboard.kst_kst1_ja")}
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_kst1_z_einlagekonto_note"),
                    t("dashboard.kst_kst1_z_einlagekonto_note_2"),
                  ]} />}
                />
                <KRow
                  label={t("dashboard.kst_kst1_z16")}
                  value={t("dashboard.kst_kst1_nein")}
                  dim
                  tip={<ElsterTip lines={[t("dashboard.kst_kst1_z16_note")]} />}
                />
                <KRow
                  label={t("dashboard.kst_kst1_z17")}
                  value={t("dashboard.kst_kst1_nein_action")}
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_kst1_z17_note"),
                    t("dashboard.kst_kst1_z17_note_2"),
                  ]} />}
                />
                <KRow
                  label={t("dashboard.kst_kst1_z17a")}
                  value={t("dashboard.kst_leer_lassen")}
                  dim
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_kst1_z17a_note"),
                    t("dashboard.kst_kst1_z17a_note_2"),
                  ]} />}
                />

                {/* 8 — Anteilseigner */}
                <ZveSubHeader title={t("dashboard.kst_kst1_anteilseigner_title")} />
                <KRow
                  label={t("dashboard.kst_kst1_anteilseigner_row")}
                  value={t("dashboard.kst_manual_entry")}
                  dim
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_kst1_anteilseigner_note"),
                    t("dashboard.kst_kst1_anteilseigner_note_2"),
                  ]} />}
                />

              </tbody>
            </table>
          </div>

          {zve <= 0 && (
            <div className="bg-amber-50 border border-amber-300 rounded p-2 text-[11px] font-mono text-black/70">
              {t("dashboard.kst_no_liability")}
            </div>
          )}

          {/* ── Anlage GK ──────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <AnlageHeader
              title={t("dashboard.kst_anlage_gk_title")}
              law="§ 7 KStG"
              href="https://www.gesetze-im-internet.de/kstg_1977/__7.html"
            />
            <table className="w-full border-collapse">
              <tbody>
                <KRow
                  label={t("dashboard.kst_steuerbilanzgewinn")}
                  value={negFmt(steuerbilanzgewinn)}
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_steuerbilanz_note"),
                    t("dashboard.kst_steuerbilanz_note_2"),
                    t("dashboard.kst_steuerbilanz_note_3"),
                    t("dashboard.kst_steuerbilanz_note_4"),
                    t("dashboard.kst_steuerbilanz_note_5"),
                  ]} />}
                />
                <KRow
                  label={t("dashboard.kst_hinzurechnungen")}
                  value={t("dashboard.kst_manual_zero")}
                  dim
                  indent
                />
                <tr className="border-t-2 border-amber-300">
                  <td className="py-2 text-xs font-black text-black font-mono">{t("dashboard.kst_einkuenfte_gk")}</td>
                  <td className="py-2 text-right text-xs font-black font-mono whitespace-nowrap pl-6 w-36 text-black">
                    {negFmt(einkuenfteGK)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* ── Anlage Verluste (shown when loss year) ─────────────────── */}
          {/* Anlage ZVE */}
          <div className="flex flex-col gap-2">
            <AnlageHeader
              title={t("dashboard.kst_anlage_zve_title")}
              law="§ 8 KStG"
              href="https://www.gesetze-im-internet.de/kstg_1977/__8.html"
            />
            <table className="w-full border-collapse">
              <tbody>

                {/* A: Ermittlung der Summe der Einkünfte (Z. 1–15) */}
                <ZveSubHeader title={t("dashboard.kst_zve_summe_title")} />
                <KRow label={t("dashboard.kst_zve_row1")}   value="—" dim />
                <KRow
                  label={t("dashboard.kst_zve_row2")}
                  value={negFmt(einkuenfteGK)}
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_zve_row2_note"),
                    t("dashboard.kst_zve_row2_note_2"),
                  ]} />}
                />
                <KRow label={t("dashboard.kst_zve_row3_7")}  value="—" dim />
                <KRow label={t("dashboard.kst_zve_row8_14")} value="—" dim />
                <tr className="border-t-2 border-amber-300">
                  <td className="py-2 text-xs font-black text-black font-mono">{t("dashboard.kst_zve_row15")}</td>
                  <td className="py-2 text-right text-xs font-black font-mono whitespace-nowrap pl-6 w-36 text-black">{negFmt(einkuenfteGK)}</td>
                </tr>

                {/* B: Ermittlung des Gesamtbetrags der Einkünfte (Z. 16–27) */}
                <ZveSubHeader title={t("dashboard.kst_zve_gesamtbetrag_title")} />
                <KRow label={t("dashboard.kst_zve_row16_26")} value="—" dim />
                <tr className="border-t-2 border-amber-300">
                  <td className="py-2 text-xs font-black text-black font-mono">{t("dashboard.kst_zve_row27")}</td>
                  <td className="py-2 text-right text-xs font-black font-mono whitespace-nowrap pl-6 w-36 text-black">{negFmt(gesamtbetrag)}</td>
                </tr>

                {/* C: Ermittlung des ZVE (Z. 28–33) */}
                <ZveSubHeader title={t("dashboard.kst_zve_einkommen_title")} />
                <KRow
                  label={t("dashboard.kst_zve_row28")}
                  value={t("dashboard.kst_manual_zero")}
                  dim
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_zve_row28_note"),
                    t("dashboard.kst_zve_row28_note_2"),
                  ]} />}
                />
                <KRow label={t("dashboard.kst_zve_row29_31")} value="—" dim />
                <tr className="border-t border-amber-200">
                  <td className="py-1.5 text-xs font-bold text-black font-mono">{t("dashboard.kst_zve_row32")}</td>
                  <td className="py-1.5 text-right text-xs font-bold font-mono whitespace-nowrap pl-6 w-36 text-black">{negFmt(einkommen)}</td>
                </tr>
                <tr className="border-t-2 border-amber-300">
                  <td className="py-2 text-xs font-black text-black font-mono">{t("dashboard.kst_zve_row33")}</td>
                  <td className="py-2 text-right text-xs font-black font-mono whitespace-nowrap pl-6 w-36 text-black">{negFmt(zve)}</td>
                </tr>

                {/* D: Weitere Angaben (Z. 34–36) */}
                <ZveSubHeader title={t("dashboard.kst_zve_weitere_title")} />
                <KRow label={t("dashboard.kst_zve_row34_36")} value="—" dim />

              </tbody>
            </table>
          </div>

          {/* Anlage Verluste (shown when loss year) */}
          {gesamtbetrag < 0 && (
            <div className="flex flex-col gap-2">
              <AnlageHeader
                title={t("dashboard.kst_anlage_verluste_title")}
                law="§ 10d EStG"
                href="https://www.gesetze-im-internet.de/estg/__10d.html"
              />
              <p className="text-[10px] font-mono text-black/50 leading-relaxed">{t("dashboard.kst_anlage_verluste_subtitle")}</p>
              <table className="w-full border-collapse">
                <tbody>
                  <KRow
                    label={t("dashboard.kst_vlv_anfangsbestand")}
                    value={t("dashboard.kst_manual_zero")}
                    dim
                    tip={<ElsterTip lines={[
                      t("dashboard.kst_vlv_anfangsbestand_note"),
                      t("dashboard.kst_vlv_anfangsbestand_note_2"),
                    ]} />}
                  />
                  <KRow
                    label={t("dashboard.kst_vlv_verlust_jahr")}
                    value={fE(verlustJahr)}
                    tip={<ElsterTip lines={[t("dashboard.kst_vlv_verlust_jahr_note")]} />}
                  />
                  <KRow
                    label={t("dashboard.kst_vlv_z20_ruecktrag")}
                    value={fE(0)}
                    tip={<ElsterTip lines={[
                      t("dashboard.kst_vlv_z20_note"),
                      t("dashboard.kst_vlv_z20_note_2"),
                    ]} />}
                  />
                  <tr className="border-t-2 border-amber-300">
                    <td className="py-2 text-xs font-black text-black font-mono">{t("dashboard.kst_vlv_endbestand")}</td>
                    <td className="py-2 text-right text-xs font-black font-mono whitespace-nowrap pl-6 w-36 text-black">
                      {fE(endbestand)}
                    </td>
                  </tr>
                  <KRow label={t("dashboard.kst_vlv_para8d")}          value="—" dim />
                  <KRow label={t("dashboard.kst_vlv_beitrittsgebiet")} value="—" dim />
                </tbody>
              </table>
              <div className="bg-amber-50 border border-amber-300 rounded p-2 text-[11px] font-mono text-black/70">
                {t("dashboard.kst_vlv_endbestand_note")}
              </div>
            </div>
          )}

          {/* ── Anlage WA — Weitere Angaben / Anträge ───────────────────── */}
          <div className="flex flex-col gap-2">
            <AnlageHeader
              title={t("dashboard.kst_anlage_wa_title")}
              law="§ 31 KStG"
              href="https://www.gesetze-im-internet.de/kstg_1977/__31.html"
            />
            <p className="text-[10px] font-mono text-black/50 leading-relaxed">{t("dashboard.kst_wa_required_note")}</p>
            <table className="w-full border-collapse">
              <tbody>
                <KRow label={t("dashboard.kst_wa_row1")} value="—" dim
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_wa_row1_note"),
                    t("dashboard.kst_wa_row1_note_2"),
                  ]} />
                }
                />
                <KRow label={t("dashboard.kst_wa_row2")} value="—" dim />
                <KRow label={t("dashboard.kst_wa_row3")} value="—" dim />
                <KRow
                  label={t("dashboard.kst_wa_row4")}
                  value="—"
                  dim
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_wa_row4_note"),
                    t("dashboard.kst_wa_row4_note_2"),
                  ]} />}
                />
                <KRow label={t("dashboard.kst_wa_row5")} value="—" dim />
                <KRow
                  label={t("dashboard.kst_wa_row6")}
                  value="—"
                  dim
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_wa_row6_note"),
                    t("dashboard.kst_wa_row6_note_2"),
                  ]} />}
                />
                <KRow label={t("dashboard.kst_wa_row7")}  value="—" dim />
                <KRow label={t("dashboard.kst_wa_row8")}  value="—" dim />
                <KRow label={t("dashboard.kst_wa_row9")}  value="—" dim />
                <KRow label={t("dashboard.kst_wa_row10")} value="—" dim />
              </tbody>
            </table>
            <div className="bg-amber-50 border border-amber-300 rounded p-2 text-[11px] font-mono text-black/70">
              {t("dashboard.kst_wa_open_note")}
            </div>
          </div>

          {/* ── Anlage KSt 1 F ─────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <AnlageHeader
              title={t("dashboard.kst_1f_title")}
              law="§ 27 KStG"
              href="https://www.gesetze-im-internet.de/kstg_1977/__27.html"
            />
            <p className="text-[10px] font-mono text-black/50 leading-relaxed">{t("dashboard.kst_1f_required_note")}</p>
            <table className="w-full border-collapse">
              <tbody>

                {/* 1 — Allgemeine Angaben */}
                <ZveSubHeader title={t("dashboard.kst_1f_s1_title")} />
                {taxpayer?.name && (
                  <KRow label={t("dashboard.gewst_firma")} value={taxpayer.name} />
                )}
                {taxpayer?.rechtsform && (
                  <KRow label={t("dashboard.gewst_rechtsform")} value={taxpayer.rechtsform} />
                )}
                {taxpayer?.gründungsjahr && (
                  <KRow label={t("dashboard.jab_gründungsjahr")} value={String(taxpayer.gründungsjahr)} />
                )}
                {nennkapital > 0 && (
                  <KRow label={t("dashboard.kst_1f_stammkapital")} value={fE(nennkapital)}
                    tip={<ElsterTip lines={[t("dashboard.kst_1f_stammkapital_note")]} />}
                  />
                )}
                {!taxpayer?.name && (
                  <KRow label={t("dashboard.kst_1f_s1_row")} value={t("dashboard.kst_manual_entry")} dim
                    tip={<ElsterTip lines={[t("dashboard.kst_1f_s1_note")]} />}
                  />
                )}
                {onEditTaxpayer && (
                  <tr><td colSpan={2} className="py-1">
                    <button onClick={onEditTaxpayer} className="text-[9px] font-bold text-black underline underline-offset-2 hover:text-amber-700">
                      {t("sidebar.taxpayer_edit_btn")} →
                    </button>
                  </td></tr>
                )}

                {/* 2 — Gewinnausschüttungen / Leistungen */}
                <ZveSubHeader title={t("dashboard.kst_1f_s2_title")} />
                <KRow label={t("dashboard.kst_1f_s2_row")} value={t("dashboard.kst_manual_zero")} dim
                  tip={<ElsterTip lines={[t("dashboard.kst_1f_s2_note"), t("dashboard.kst_1f_s2_note_2")]} />}
                />

                {/* 3 — Ausschüttbarer Gewinn */}
                <ZveSubHeader title={t("dashboard.kst_1f_s3_title")} />
                <KRow
                  label={t("dashboard.kst_1f_s3_eigenkapital")}
                  value={nennkapital > 0 ? `${fE(eigenkapitalApprox)} *` : t("dashboard.kst_manual_zero")}
                  dim={nennkapital === 0}
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_1f_s3_ek_note"),
                    t("dashboard.kst_1f_s3_ek_note_2"),
                    t("dashboard.kst_1f_s3_ek_note_3"),
                  ]} />}
                />
                <KRow
                  label={t("dashboard.kst_1f_s3_nennkapital")}
                  value={nennkapital > 0 ? `− ${fE(nennkapital)}` : "—"}
                  dim={nennkapital === 0}
                />
                <KRow
                  label={t("dashboard.kst_1f_s3_einlagekonto")}
                  value={einlagekontoAnfang > 0 ? `− ${fE(einlagekontoAnfang)}` : "—"}
                  dim={einlagekontoAnfang === 0}                  tip={<ElsterTip lines={[
                    t("dashboard.kst_1f_s3_ek19_note"),
                    t("dashboard.kst_1f_s3_ek19_note_2"),
                  ]} />}                />
                <tr className="border-t-2 border-amber-300">
                  <td className="py-2 text-xs font-black text-black font-mono">
                    {t("dashboard.kst_1f_s3_result")}
                    {nennkapital > 0 && <span className="text-black/40 text-[9px] ml-1">*</span>}
                  </td>
                  <td className={`py-2 text-right text-xs font-black font-mono whitespace-nowrap pl-6 w-36 ${nennkapital === 0 ? "text-black/40" : "text-black"}`}>
                    {nennkapital > 0 ? fE(ausschuettbar) : t("dashboard.kst_manual_zero")}
                  </td>
                </tr>
                {nennkapital > 0 && (
                  <tr><td colSpan={2} className="py-0.5 text-[9px] font-mono text-black/40">
                    * {t("dashboard.kst_1f_s3_approx_note")}
                  </td></tr>
                )}

                {/* 4 — Mehr-/Minderabführungen § 27 Abs. 6 */}
                <ZveSubHeader title={t("dashboard.kst_1f_s4_title")} />
                <KRow label={t("dashboard.kst_1f_s4_row")} value="—" dim
                  tip={<ElsterTip lines={[t("dashboard.kst_1f_s4_note")]} />}
                />

                {/* 5 — Einlagekonto (§ 27 Abs. 2) + Nennkapital aus Umwandlung (§ 28 Abs. 1) */}
                <ZveSubHeader title={t("dashboard.kst_1f_s5_title")} />
                <ZveSubHeader title={t("dashboard.kst_1f_s5_anfang_title")} />
                {taxpayer?.gründungsjahr && (
                  <KRow
                    label={t("dashboard.kst_1f_eintrittsdatum")}
                    value={`01.01.${taxpayer.gründungsjahr}`}
                    tip={<ElsterTip lines={[
                      t("dashboard.kst_1f_eintrittsdatum_note"),
                      t("dashboard.kst_1f_eintrittsdatum_note_2"),
                    ]} />}
                  />
                )}
                <KRow
                  label={t("dashboard.kst_1f_z40")}
                  value={taxpayer?.gründungsjahr ? fE(einlagekontoAnfang) : t("dashboard.kst_kst1_na")}
                  dim={!taxpayer?.gründungsjahr}
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_1f_z40_note"),
                    t("dashboard.kst_1f_z40_note_2"),
                  ]} />}
                />
                <KRow
                  label={t("dashboard.kst_1f_z41")}
                  value={t("dashboard.kst_leer_lassen")}
                  dim
                  tip={<ElsterTip lines={[t("dashboard.kst_1f_z41_note")]} />}
                />
                <KRow
                  label={t("dashboard.kst_1f_z42")}
                  value={t("dashboard.kst_leer_lassen")}
                  dim
                  tip={<ElsterTip lines={[
                    t("dashboard.kst_1f_z42_note"),
                    t("dashboard.kst_1f_z42_note_2"),
                  ]} />}
                />
                <KRow
                  label={t("dashboard.kst_1f_z43")}
                  value={t("dashboard.kst_leer_lassen")}
                  dim
                  tip={<ElsterTip lines={[t("dashboard.kst_1f_z43_note")]} />}
                />
                <KRow
                  label={t("dashboard.kst_1f_zugaenge")}
                  value={t("dashboard.kst_manual_zero")}
                  dim
                  tip={<ElsterTip lines={[t("dashboard.kst_1f_zugaenge_note")]} />}
                />
                <KRow label={t("dashboard.kst_1f_abgaenge")} value={t("dashboard.kst_manual_zero")} dim />
                <tr className="border-t-2 border-amber-300">
                  <td className="py-2 text-xs font-black text-black font-mono">{t("dashboard.kst_1f_endbestand")}</td>
                  <td className="py-2 text-right text-xs font-black font-mono whitespace-nowrap pl-6 w-36 text-black">{fE(einlagekontoAnfang)}</td>
                </tr>
                {einlagekontoAnfang > 0 && (
                  <tr><td colSpan={2} className="py-0.5 text-[9px] font-mono text-black/40">
                    * {t("dashboard.kst_1f_s3_approx_note")}
                  </td></tr>
                )}
                <KRow
                  label={t("dashboard.kst_1f_sonderausweis")}
                  value={t("dashboard.kst_manual_zero")}
                  dim
                  tip={<ElsterTip lines={[t("dashboard.kst_1f_sonderausweis_note")]} />}
                />

                {/* 6 — Bezüge § 7 UmwStG bei Abspaltung */}
                <ZveSubHeader title={t("dashboard.kst_1f_s6_title")} />
                <KRow label={t("dashboard.kst_1f_s6_row")} value="—" dim
                  tip={<ElsterTip lines={[t("dashboard.kst_1f_s6_note")]} />}
                />

                {/* 7 — Bezüge § 7 UmwStG bei Verschmelzung etc. */}
                <ZveSubHeader title={t("dashboard.kst_1f_s7_title")} />
                <KRow label={t("dashboard.kst_1f_s7_row")} value="—" dim
                  tip={<ElsterTip lines={[t("dashboard.kst_1f_s7_note")]} />}
                />

              </tbody>
            </table>
            <div className="bg-amber-50 border border-amber-300 rounded p-2 text-[11px] font-mono text-black/70">
              {t("dashboard.kst_1f_open_note")}
            </div>
          </div>

          <p className="text-[10px] text-black font-mono leading-relaxed flex items-start gap-1">
            <IconInfo className="w-3 h-3 shrink-0 mt-px" /> {t("dashboard.kst_disclaimer")}
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
                  <span className="col-span-2 border-t border-amber-100 mt-0.5 pt-0.5">
                    zvE: <strong className="text-black">{fE(steuerbilanzgewinn)}</strong>
                    <span className="text-black/40 ml-1">(berechnet aus Belegen)</span>
                  </span>
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
                        onClick={() => callKstEndpoint(false)}
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
                    onClick={previewKstXml}
                    disabled={kstXmlLoading || submitting}
                  >
                    <IconXml className="w-3.5 h-3.5" />
                    {kstXmlLoading ? "Lade…" : "XML anzeigen"}
                  </button>
                  <button
                    className="border border-amber-400 rounded px-3 py-1 text-[11px] font-bold bg-white hover:bg-amber-100 transition-colors disabled:opacity-50"
                    onClick={() => callKstEndpoint(true)}
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
                      {useTest ? "Test-Übermittlung erfolgreich — nicht ans Finanzamt gesendet" : "Erfolgreich an das Finanzamt übermittelt"}
                    </div>
                    <div className="font-mono text-[10px]">Telenummer: <strong>{transferticket}</strong></div>
                    {savedXmlFilename && (
                      <div className="text-[10px] mt-0.5">
                        XML gespeichert: <span className="font-mono">{savedXmlFilename}</span>
                        <button
                          className="ml-2 underline font-bold text-black hover:no-underline"
                          onClick={async () => {
                            const qs = dbPath ? `?db=${encodeURIComponent(dbPath)}&filename=${encodeURIComponent(savedXmlFilename)}` : `?filename=${encodeURIComponent(savedXmlFilename)}`;
                            const res = await fetch(`${apiBase}/submissions/file${qs}`);
                            if (!res.ok) return;
                            setKstXml(await res.text());
                            setKstXmlOpen(true);
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

      {/* ── KSt XML Preview Modal ─────────────────────────────────────── */}
      {kstXmlOpen && kstXml && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="relative bg-white border-2 border-black rounded w-[90vw] max-w-4xl h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-2 border-b-2 border-black bg-amber-50">
              <span className="text-xs font-black uppercase tracking-wider">ELSTER XML · KSt {year}</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { navigator.clipboard.writeText(kstXml).then(() => { setKstXmlCopied(true); setTimeout(() => setKstXmlCopied(false), 2000); }); }}
                  className="flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-amber-100 transition-colors"
                >
                  <IconCopy className="w-3.5 h-3.5" />
                  {kstXmlCopied ? "Kopiert" : "Kopieren"}
                </button>
                <button
                  onClick={() => {
                    const blob = new Blob([kstXml], { type: "application/xml" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url; a.download = `KSt_${year}_ELSTER.xml`; a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-amber-100 transition-colors"
                >
                  <IconDownload className="w-3.5 h-3.5" />
                  Download
                </button>
                <button
                  onClick={() => setKstXmlOpen(false)}
                  className="text-[10px] font-black px-2 py-1 rounded border border-black hover:bg-black hover:text-white transition-colors"
                >
                  Schließen
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-[10px] font-mono text-black leading-relaxed whitespace-pre select-all">
              {kstXml}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
