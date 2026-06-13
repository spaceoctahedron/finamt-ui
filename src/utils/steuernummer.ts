/**
 * Utilities for German Steuernummer handling.
 *
 * Converts a locally-formatted Steuernummer (e.g. "37/539/50531")
 * into the 13-digit bundeseinheitliche Steuernummer (e.g. "1137053950531")
 * and derives the 4-digit Finanzamtsnummer and the Länderkennzeichen.
 *
 * Sources:
 *   https://www.bzst.de/DE/Unternehmen/Identifikationsnummern/
 *   https://www.ebilanzonline.de/wissen/13-stellige-steuernummer/
 */

// ---------------------------------------------------------------------------
// State descriptor
// ---------------------------------------------------------------------------

type BundeslandInfo = {
  /** Länderkennzeichen prefix used in the 13-digit federal Steuernummer */
  kz: string;
  /** How many digits the FA part has in the local format */
  faDigits: 2 | 3;
  /** How many digits the "BBB" block has (3 standard, 4 for NRW) */
  bDigits: 3 | 4;
  /** How many digits the "UUUUP" block has (5 standard, 4 for NRW) */
  uDigits: 4 | 5;
};

/** Maps normalised state name keywords → Bundesland info. */
const STATE_MAP: [RegExp, BundeslandInfo][] = [
  [/^ba(den)?[-\s]*w(ü|ue|u)(rttemberg)?$/i,   { kz: "28", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^bay(ern)?$|^by$/i,                          { kz: "9",  faDigits: 3, bDigits: 3, uDigits: 5 }],
  [/^ber(lin)?$|^be$/i,                          { kz: "11", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^bran(denburg)?$|^bb$/i,                     { kz: "30", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^bre(men)?$|^hb$/i,                          { kz: "24", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^ham(burg)?$|^hh$/i,                         { kz: "22", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^hes(sen)?$|^he$/i,                          { kz: "26", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^meck(lenburg)?|^mv$/i,                      { kz: "40", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^nie(der(sachsen)?)?$|^ni$|^nds$/i,          { kz: "23", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^nord(rhein)?[-\s]*west(falen)?$|^nrw$|^nw$/i, { kz: "5", faDigits: 3, bDigits: 4, uDigits: 4 }],
  [/^rhe?in(land)?[-\s]*pfalz?$|^rp$|^rlp$/i,   { kz: "27", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^saar(land)?$|^sl$/i,                        { kz: "10", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^sach(sen)?[-\s]*anhalt$|^st$|^s-a$/i,       { kz: "31", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^sach(sen)?$|^sn$|^free(staat)?/i,           { kz: "32", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^sch(leswig)?[-\s]*hol(stein)?$|^sh$/i,      { kz: "21", faDigits: 2, bDigits: 3, uDigits: 5 }],
  [/^thü(ringen)?$|^thu(ringen)?$|^th$/i,        { kz: "41", faDigits: 2, bDigits: 3, uDigits: 5 }],
];

/** Resolve Bundesland info from a free-text state string (German or abbreviation). */
export function bundeslandInfo(state: string | null | undefined): BundeslandInfo | null {
  if (!state) return null;
  const s = state.trim();
  for (const [re, info] of STATE_MAP) {
    if (re.test(s)) return info;
  }
  return null;
}

/** Return just the Länderkennzeichen (e.g. "11" for Berlin). */
export function bundeslandKzFromState(state: string | null | undefined): string {
  return bundeslandInfo(state)?.kz ?? "";
}

// ---------------------------------------------------------------------------
// Parsing helper
// ---------------------------------------------------------------------------

/**
 * Split a local Steuernummer by "/" into its three components.
 * Accepts formats like "37/539/50531" or "37 / 539 / 50531" or "37.539.50531".
 * Returns null if the string doesn't contain at least two separators.
 */
function splitLocal(raw: string): [string, string, string] | null {
  // Normalise: replace common separators (. space) with /
  const normalised = raw.replace(/[\s.]/g, "/").replace(/\/+/g, "/");
  const parts = normalised.split("/").map(p => p.replace(/\D/g, ""));
  if (parts.length < 3) return null;
  return [parts[0], parts[1], parts[2]];
}

// ---------------------------------------------------------------------------
// Main conversion
// ---------------------------------------------------------------------------

/**
 * Convert a local-format Steuernummer to the 13-digit federal format.
 *
 * @param local  e.g. "37/539/50531"
 * @param state  e.g. "Berlin" or "BE"
 * @returns 13-digit string or null if input is not parseable.
 */
export function toFederal13(local: string | null | undefined, state: string | null | undefined): string | null {
  if (!local) return null;
  const info = bundeslandInfo(state);
  if (!info) return null;

  const parts = splitLocal(local);
  if (!parts) return null;
  const [faRaw, bRaw, uRaw] = parts;

  // Take the last `faDigits` digits of the FA part (strips leading state prefix, e.g. "0FF" → "FF")
  const fa = faRaw.slice(-info.faDigits).padStart(info.faDigits, "0");
  const b  = bRaw.padStart(info.bDigits, "0");
  const u  = uRaw.padStart(info.uDigits, "0");

  const result = info.kz + fa + "0" + b + u;
  if (result.length !== 13) return null;
  return result;
}

/**
 * Derive the 4-digit Finanzamtsnummer from the local Steuernummer + state.
 * Finanzamtsnr = bundesland_kz + FA part from local number.
 *
 * Example: Berlin "37/539/50531" → "1137"
 */
export function finanzamtNrFromSteuernummer(
  local: string | null | undefined,
  state: string | null | undefined,
): string {
  if (!local) return "";
  const info = bundeslandInfo(state);
  if (!info) return "";
  const parts = splitLocal(local);
  if (!parts) return "";
  const faRaw = parts[0];
  const fa = faRaw.slice(-info.faDigits).padStart(info.faDigits, "0");
  return info.kz + fa;
}

/**
 * Whether the local Steuernummer is already in the 13-digit federal format.
 */
export function is13Digit(value: string): boolean {
  return /^\d{13}$/.test(value.replace(/\s/g, ""));
}

/**
 * Normalise: if already 13 digits, return as-is; otherwise try conversion.
 * Returns the 13-digit number if successful, or the original trimmed value.
 */
export function normalisedSteuernummer(
  value: string | null | undefined,
  state: string | null | undefined,
): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (is13Digit(trimmed)) return trimmed;
  return toFederal13(trimmed, state) ?? trimmed;
}
