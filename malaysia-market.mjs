import { classifyOrigin } from "./malaysia-origin.mjs";

export { classifyOrigin };

// Legacy hints kept for backwards compatibility; classification uses airports.json.
export const malaysiaDepartureCities = [
  "kuala lumpur", "penang", "johor bahru", "johor", "kota kinabalu",
  "kuching", "langkawi", "subang", "tawau", "miri", "bintulu",
  "kota bharu", "labuan", "sibu", "kuala terengganu", "alor setar",
  "kuantan", "ipoh", "melaka", "malacca", "sandakan"
];

export const malaysiaDepartureAirportCodes = [
  "KUL", "PEN", "JHB", "BKI", "KCH", "LGK", "SZB", "TWU", "MYY",
  "BTU", "KBR", "LBU", "SBW", "TGG", "AOR", "KUA", "IPH", "SDK"
];

export function titleCase(value) {
  if (!value) return null;
  return value
    .replace(/[^a-zA-Z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ") || null;
}

export function extractOrigin(title) {
  const text = (title || "").toLowerCase();
  const fromTo = text.match(/from\s+(.+?)\s+to\s+/);
  if (fromTo) return titleCase(fromTo[1]);

  const dashMatch = text.match(/:\s*(.+?)\s+[–-]\s+/);
  if (dashMatch) return titleCase(dashMatch[1]);

  const toIndex = text.indexOf(" to ");
  if (toIndex >= 0) return titleCase(text.substring(0, toIndex).replace(/^[^:]*:\s*/, ""));

  const leadingDash = text.match(/^\s*([a-z][a-z\s]+?)\s+[–-]\s+/);
  if (leadingDash) return titleCase(leadingDash[1]);

  return null;
}

export function extractDestination(title) {
  const text = (title || "").toLowerCase();
  let segment = "";

  const fromTo = text.match(/from\s+.+?\s+to\s+(.+)/i);
  if (fromTo) segment = fromTo[1];
  else {
    const dashMatch = text.match(/[–-]\s+(.+)$/i);
    if (dashMatch) segment = dashMatch[1];
    else {
      const toIndex = text.indexOf(" to ");
      if (toIndex >= 0) segment = text.substring(toIndex + 4);
    }
  }

  segment = segment.split(/\s*[.,]\s*|\s+(?:round|one|nonstop|us\$|\$|€|£|\d)/i)[0];
  segment = segment.replace(/\s+\bfrom\b.*$/i, "");
  segment = segment.replace(/\s+(?:rm|usd|sgd|eur|gbp|aud|thb).*$/i, "");
  segment = segment.replace(/\s+\d.*$/, "");
  return titleCase(segment);
}

export function extractPriceAndCurrency(text) {
  const source = text || "";
  let currency = null;
  let amount = null;

  const patterns = [
    { regex: /US\$\s*([\d,]+(?:\.\d{1,2})?)/i, currency: "USD" },
    { regex: /\$\s*([\d,]+(?:\.\d{1,2})?)/i, currency: "USD" },
    { regex: /€\s*([\d,]+(?:\.\d{1,2})?)/i, currency: "EUR" },
    { regex: /£\s*([\d,]+(?:\.\d{1,2})?)/i, currency: "GBP" },
    { regex: /RM\s*([\d,]+(?:\.\d{1,2})?)/i, currency: "MYR" },
    { regex: /SGD\s*([\d,]+(?:\.\d{1,2})?)/i, currency: "SGD" },
    { regex: /([\d,]+(?:\.\d{1,2})?)\s*€/i, currency: "EUR" },
    { regex: /([\d,]+(?:\.\d{1,2})?)\s*£/i, currency: "GBP" },
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern.regex);
    if (match) {
      amount = parseFloat(match[1].replace(/,/g, ""));
      currency = pattern.currency;
      break;
    }
  }

  if (amount === null || Number.isNaN(amount)) {
    return { price: null, currency: null };
  }
  return { price: amount, currency };
}

export function isMalaysiaDeparture(origin, title = "") {
  return classifyOrigin(origin, title).category === "MALAYSIA";
}

export function containsMalaysiaDepartureToken(text) {
  const lower = (text || "").toLowerCase();
  const tokens = [...malaysiaDepartureCities, ...malaysiaDepartureAirportCodes.map(code => code.toLowerCase())];
  return tokens.some(token => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\b|:)\\s*${escaped}\\s*(to|[-–→])`, "i").test(lower);
  });
}

export function effectiveErrorFareCategory(title, origin, category) {
  if (category === "MALAYSIA") return "MALAYSIA";
  return classifyOrigin(origin, title).category;
}
