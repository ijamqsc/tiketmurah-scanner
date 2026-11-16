/**
 * Dataset-driven origin classification for TiketMurah deals.
 *
 * Country is decided ONLY by the origin airport (from airports.json), never by
 * airline, website or language. Unknown origins are reported as UNKNOWN with a
 * reason so they can be debugged instead of being silently labelled GLOBAL.
 */

import { readFileSync } from "node:fs";

const AIRPORTS_URL = new URL("./airports.json", import.meta.url);
const AIRPORTS = JSON.parse(readFileSync(AIRPORTS_URL, "utf8"));

export const MALAYSIA_COUNTRY_CODE = "MY";

const byIata = new Map();
const places = [];

// Spoken/written city names that differ from the dataset's city or airport name.
const CITY_ALIASES = {
  "kuala lumpur": "KUL",
  penang: "PEN",
  "johor bahru": "JHB",
  senai: "JHB",
  "kota kinabalu": "BKI",
  kuching: "KCH",
  langkawi: "LGK",
  subang: "SZB",
  tawau: "TWU",
  miri: "MYY",
  bintulu: "BTU",
  "kota bharu": "KBR",
  labuan: "LBU",
  sibu: "SBW",
  "kuala terengganu": "TGG",
  "alor setar": "AOR",
  "alor satar": "AOR",
  kuantan: "KUA",
  ipoh: "IPH",
  melaka: "MKZ",
  malacca: "MKZ",
  sandakan: "SDK",
};

function normalizePlace(raw) {
  return String(raw || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/(?:international|intl|regional|domestic)/gi, " ")
    .replace(/(?:airport|airbase|airbase)/gi, " ")
    .replace(/[,.].*$/, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

for (const airport of AIRPORTS) {
  const iata = String(airport.iata || "").toUpperCase();
  if (/^[A-Z]{3}$/.test(iata)) {
    byIata.set(iata, airport);
  }
  for (const raw of [airport.city, airport.name]) {
    const needle = normalizePlace(raw);
    if (needle.length >= 4) {
      places.push({ needle, airport });
    }
  }
}

for (const [alias, iata] of Object.entries(CITY_ALIASES)) {
  const airport = byIata.get(iata);
  if (airport && alias.length >= 4) {
    places.push({ needle: alias, airport });
  }
}
// Longest needle first so "kuala lumpur international" wins over "kuala lumpur".
places.sort((a, b) => b.needle.length - a.needle.length);

export function airportsCount() {
  return AIRPORTS.length;
}

export function malaysiaAirports() {
  return AIRPORTS.filter(
    (a) => String(a.countryCode || "").toUpperCase() === MALAYSIA_COUNTRY_CODE
  );
}

export function countryForIata(code) {
  const airport = byIata.get(String(code || "").trim().toUpperCase());
  return airport ? String(airport.countryCode || "").toUpperCase() : null;
}

export function findAirportInText(text) {
  const value = String(text || "");
  if (!value.trim()) return null;

  // Explicit code in parentheses: "Kuala Lumpur (KUL)".
  for (const match of value.matchAll(/\(([A-Za-z]{3})\)/g)) {
    const airport = byIata.get(match[1].toUpperCase());
    if (airport) return airport;
  }

  // The whole value is a code: "KUL" / "kul".
  const trimmed = value.trim();
  if (/^[A-Za-z]{3}$/.test(trimmed)) {
    return byIata.get(trimmed.toUpperCase()) || null;
  }

  // Place names only. Free-prose 3-letter words ("the", "for") are NOT codes.
  const lower = trimmed.toLowerCase();
  for (const place of places) {
    if (lower.includes(place.needle)) return place.airport;
  }
  if (lower.length >= 5) {
    for (const place of places) {
      if (place.needle.includes(lower)) return place.airport;
    }
  }
  return null;
}

export function findOriginCodeInTitle(title) {
  const value = String(title || "");
  const match = value.match(/([A-Za-z]{3})\s*(?:to|[-–→])/i);
  if (!match) return null;
  return byIata.get(match[1].toUpperCase()) || null;
}

function categoryForAirport(airport) {
  const code = String(airport.countryCode || "").toUpperCase();
  return code === MALAYSIA_COUNTRY_CODE ? "MALAYSIA" : "GLOBAL";
}

function result(category, reason, airport) {
  return {
    category,
    reason,
    iata: airport ? String(airport.iata || "").toUpperCase() : null,
    country: airport ? airport.country || null : null,
    countryCode: airport ? String(airport.countryCode || "").toUpperCase() : null,
  };
}

/**
 * Classify a deal by its origin.
 *
 * @param {string|null} origin extracted origin text (city name or IATA code)
 * @param {string} title full deal title (used only to recover a missing origin)
 * @returns {{category: "MALAYSIA"|"GLOBAL"|"UNKNOWN", reason: string,
 *            iata: string|null, country: string|null, countryCode: string|null}}
 */
export function classifyOrigin(origin, title = "") {
  const text = String(origin || "").trim();

  if (text) {
    const airport = findAirportInText(text);
    if (airport) {
      return result(categoryForAirport(airport), `origin:${airport.iata}`, airport);
    }
    if (/^[A-Za-z]{3}$/.test(text)) {
      return {
        category: "UNKNOWN",
        reason: `unknown-iata:${text.toUpperCase()}`,
        iata: text.toUpperCase(),
        country: null,
        countryCode: null,
      };
    }
    return {
      category: "UNKNOWN",
      reason: `unrecognized-origin:${text}`,
      iata: null,
      country: null,
      countryCode: null,
    };
  }

  // Recover an origin code from the part of the title before "to".
  const titleText = String(title || "");
  const beforeTo = titleText.split(/\bto\b/i)[0] || "";
  const fromTitle = findAirportInText(beforeTo);
  if (fromTitle) {
    return result(categoryForAirport(fromTitle), `title:${fromTitle.iata}`, fromTitle);
  }

  return {
    category: "UNKNOWN",
    reason: "origin-missing",
    iata: null,
    country: null,
    countryCode: null,
  };
}

export function isMalaysiaOrigin(origin, title = "") {
  return classifyOrigin(origin, title).category === "MALAYSIA";
}
