import { readFileSync } from "node:fs";

const AIRPORTS = JSON.parse(
  readFileSync(new URL("./airports.json", import.meta.url), "utf8")
);

const PLACE_STOPWORDS = new Set([
  "international", "intl", "regional", "domestic", "airport", "airbase",
]);

function normalizePlaceName(raw) {
  return String(raw || "")
    .replace(/\([^)]*\)/g, " ")
    .split(/[^A-Za-z]+/)
    .filter((word) => word && !PLACE_STOPWORDS.has(word.toLowerCase()))
    .join(" ")
    .toLowerCase()
    .trim();
}

const AIRPORT_CODES = new Set();
const AIRPORT_PLACES = new Set();
for (const airport of AIRPORTS) {
  const code = String(airport.iata || "").toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) AIRPORT_CODES.add(code);
  for (const raw of [airport.city, airport.name]) {
    const name = normalizePlaceName(raw);
    if (name.length >= 3) AIRPORT_PLACES.add(name);
  }
}

/**
 * Accept a destination only when it is a real IATA code or a place name that
 * exists in airports.json. Marketing phrases return null.
 */
export function validateDestination(candidate) {
  const raw = String(candidate || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  if (/^[A-Za-z]{3}$/.test(raw)) {
    const code = raw.toUpperCase();
    return AIRPORT_CODES.has(code) ? code : null;
  }
  const name = normalizePlaceName(raw);
  return AIRPORT_PLACES.has(name) ? raw.replace(/[,.!;:]+$/, "").trim() : null;
}

export function normalizeOffer(input) {
  return {
    airline: input.airline || null,
    origin: input.origin || null,
    destination: input.destination || null,
    departureDate: input.departureDate || null,
    returnDate: input.returnDate || null,
    price: typeof input.price === "number" ? input.price : null,
    currency: input.currency || null,
    title: input.title || null,
    promotionValidity: input.promotionValidity || null,
    sourceUrl: input.sourceUrl || null,
    lastChecked: input.lastChecked || new Date().toISOString(),
    verificationStatus: input.verificationStatus || "PERLU_SEMAKAN"
  };
}

export function promotionExpired(validity) {
  if (!validity) return false;
  const now = Date.now();
  const patterns = [
    /Book by ([0-9]{1,2} [A-Za-z]+ [0-9]{4})/i,
    /Deal ends ([0-9]{1,2} [A-Za-z]+ [0-9]{4})/i,
    /Offer ends ([0-9]{1,2} [A-Za-z]+ [0-9]{4})/i,
    /Booking ends ([0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9:.]+Z?)?)/i
  ];
  for (const pattern of patterns) {
    const match = validity.match(pattern);
    if (!match) continue;
    const parsed = Date.parse(match[1]);
    if (!Number.isNaN(parsed) && parsed < now) return true;
  }
  return false;
}

export function validateOffer(offer) {
  if (promotionExpired(offer.promotionValidity)) return "EXPIRED";
  if (!offer.sourceUrl) return "PERLU_SEMAKAN";
  if (offer.price === null || !offer.currency) return "PERLU_SEMAKAN";
  if (!offer.origin || !offer.destination || !offer.departureDate) return "PERLU_SEMAKAN";
  return "VERIFIED";
}

const DESTINATION_STOPWORDS = new Set([
  "you", "your", "us", "the", "and", "all", "book", "fly", "now", "our", "their",
  "more", "get", "enjoy", "from", "this", "that", "here", "today", "travel"
]);

/**
 * Extract a destination from a promotion title using explicit markers only
 * ("to X", ": X", "→ X", or a title that is exactly a known place).
 * Returns null when nothing is confident — destinations are never guessed.
 */
export function destinationFromTitle(title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const candidates = [];
  const toMatch = text.match(/\bto\s+([A-Za-z][A-Za-z' -]{2,40})/i);
  if (toMatch) candidates.push(toMatch[1]);
  const colonMatch = text.match(/[:\u2013\u2014-]\s*([A-Za-z][A-Za-z' -]{2,40})/);
  if (colonMatch) candidates.push(colonMatch[1]);
  const arrowMatch = text.match(/\u2192\s*([A-Za-z][A-Za-z' -]{2,40})/);
  if (arrowMatch) candidates.push(arrowMatch[1]);

  for (const raw of candidates) {
    const cleaned = raw
      .replace(/\b(from|for|with|and|at|via|only|starting|book)\b.*$/i, "")
      .replace(/[,.!;:]+$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length < 3 || cleaned.length > 40) continue;
    if (/[0-9]/.test(cleaned)) continue;
    if (!/^[A-Z]/.test(cleaned)) continue;
    const lower = cleaned.toLowerCase();
    if (DESTINATION_STOPWORDS.has(lower)) continue;
    if (lower.split(" ").length > 4) continue;
    const validated = validateDestination(cleaned);
    if (validated) return validated;
  }

  // Marker-less titles: accept only when the whole title is a known place.
  const whole = text.replace(/[.!;]+$/, "").trim();
  if (whole.length >= 3 && whole.split(" ").length <= 4) {
    return validateDestination(whole);
  }
  return null;
}

export function dedupHash(offer) {
  const key = [
    offer.airline || "",
    offer.origin || "",
    offer.destination || "",
    offer.departureDate || "",
    offer.price === null ? "" : String(offer.price),
    offer.sourceUrl || ""
  ].join("|");
  return key;
}

export function parseMalaysiaAirlinesPromotions(html) {
  const offers = [];
  if (!html) return offers;

  const articleRegex = /<article\b[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = articleRegex.exec(html)) !== null) {
    const block = match[0];
    const getAttr = (name) => {
      const m = block.match(new RegExp(`${name}="([^"]*)"`, "i"));
      return m ? m[1] : null;
    };
    const titleMatch = block.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
    const offer = normalizeOffer({
      airline: getAttr("data-airline") || "Malaysia Airlines",
      origin: getAttr("data-origin"),
      destination: getAttr("data-destination"),
      departureDate: getAttr("data-departure-date"),
      returnDate: getAttr("data-return-date"),
      price: getAttr("data-price") ? Number(getAttr("data-price")) : null,
      currency: getAttr("data-currency"),
      title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : getAttr("data-title"),
      promotionValidity: getAttr("data-validity"),
      sourceUrl: getAttr("data-source-url"),
      verificationStatus: "PERLU_SEMAKAN"
    });
    offer.verificationStatus = validateOffer(offer);
    offers.push(offer);
  }
  return offers;
}

export function parseAirAsiaPromotions(jsonText) {
  const offers = [];
  if (!jsonText) return offers;
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return offers;
  }
  const carousels = data?.result?.pageContext?.data?.carousels || [];
  const seenUrls = new Set();
  for (const carousel of carousels) {
    for (const card of carousel.card || []) {
      const url = card.url || "";
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      const originMatch = url.match(/[?&]origin=([A-Z]{3})/i);
      const destinationMatch = url.match(/[?&]destination=([A-Z]{3})/i);
      const origin = originMatch ? originMatch[1].toUpperCase() : null;
      const destination = destinationMatch
        ? destinationMatch[1].toUpperCase()
        : destinationFromTitle(card.title || "");
      const offer = normalizeOffer({
        airline: "AirAsia",
        origin,
        destination,
        departureDate: null,
        returnDate: null,
        price: null,
        currency: null,
        title: card.title || "AirAsia promotion",
        promotionValidity: card.timerlabel?.timerenddatetime
          ? `Booking ends ${card.timerlabel.timerenddatetime}`
          : null,
        sourceUrl: url,
        verificationStatus: "PERLU_SEMAKAN"
      });
      offer.verificationStatus = validateOffer(offer);
      offers.push(offer);
    }
  }
  return offers;
}

export function parseMalaysiaAirlinesPromotionLinks(html) {
  if (!html) return [];
  const links = new Set();
  const regex = /href="(https:\/\/www\.malaysiaairlines\.com\/my\/en\/promotions\/[a-z0-9-]+\.html)"/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    links.add(match[1]);
  }
  return [...links];
}

export function parseMalaysiaAirlinesPromotionPage(html, url) {
  if (!html) return null;
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "Malaysia Airlines promotion";
  const hasKualaLumpur = /Kuala Lumpur/i.test(html);
  const destinationMatch = html.match(/Destinations?:?\s*([\s\S]{0,500})/i);
  const salesMatch = html.match(/Sales Period:?\s*([\s\S]{0,200})/i);
  const travelMatch = html.match(/Travel Period:?\s*([\s\S]{0,200})/i);
  const offer = normalizeOffer({
    airline: "Malaysia Airlines",
    origin: hasKualaLumpur ? "Kuala Lumpur" : null,
    destination: destinationMatch ? destinationMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : null,
    departureDate: null,
    returnDate: null,
    price: null,
    currency: null,
    title,
    promotionValidity: [salesMatch ? `Sales: ${salesMatch[1].replace(/<[^>]+>/g, " ").trim()}` : null, travelMatch ? `Travel: ${travelMatch[1].replace(/<[^>]+>/g, " ").trim()}` : null].filter(Boolean).join("; ") || null,
    sourceUrl: url,
    verificationStatus: "PERLU_SEMAKAN"
  });
  offer.verificationStatus = validateOffer(offer);
  return offer;
}

export function parseFireflyPromotions(html, url) {
  if (!html) return [];
  const titleMatch = html.match(/"jcr:title"\s*:\s*"([^"]+)"/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "Firefly promotion";
  const descriptionMatch = html.match(/"description"\s*:\s*"([^"]+)"/i);
  const description = descriptionMatch ? descriptionMatch[1] : "";
  const travelMatch = description.match(/Travel from now until ([0-9]{1,2} [A-Za-z]+ [0-9]{4})/i);
  const dealEndsMatch = description.match(/Deal ends ([0-9]{1,2} [A-Za-z]+ [0-9]{4})/i);
  // Firefly publishes a real "from MYR xxx" fare; only that value is used.
  const priceMatch = description.match(/from\s+(MYR|RM)\s?([0-9][0-9,]*)/i);
  const fireflyPrice = priceMatch ? Number(priceMatch[2].replace(/,/g, "")) : null;
  const offer = normalizeOffer({
    airline: "Firefly",
    origin: null,
    destination: destinationFromTitle(title),
    departureDate: null,
    returnDate: null,
    price: fireflyPrice,
    currency: fireflyPrice === null ? null : "MYR",
    title: priceMatch ? `${title} (advertised from ${priceMatch[1]} ${priceMatch[2]})` : title,
    promotionValidity: [dealEndsMatch ? `Deal ends ${dealEndsMatch[1]}` : null, travelMatch ? `Travel until ${travelMatch[1]}` : null].filter(Boolean).join("; ") || null,
    sourceUrl: url,
    verificationStatus: "PERLU_SEMAKAN"
  });
  offer.verificationStatus = validateOffer(offer);
  return [offer];
}

export function parseMalaysiaAirlinesPromotionsModel(jsonText) {
  const offers = [];
  if (!jsonText) return offers;
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return offers;
  }
  const text = JSON.stringify(data);
  const tileRegex = /"tileTitle"\s*:\s*"([^"]+)"/g;
  let tileMatch;
  while ((tileMatch = tileRegex.exec(text)) !== null) {
    const title = tileMatch[1];
    const start = tileMatch.index;
    const windowText = text.slice(start, start + 2000);
    const ctaMatch = windowText.match(/"ctaUrl"\s*:\s*"([^"]+)"/);
    if (!ctaMatch) continue;
    const ctaUrl = ctaMatch[1];
    const validityMatch = windowText.match(/"validityPeriod"\s*:\s*"([^"]*)"/);
    const iconMatch = windowText.match(/"promoTileIconText"\s*:\s*"([^"]*)"/);
    const absoluteUrl = ctaUrl.startsWith("http")
      ? ctaUrl
      : `https://www.malaysiaairlines.com${ctaUrl.startsWith("/") ? "" : "/"}${ctaUrl}`;
    const offer = normalizeOffer({
      airline: "Malaysia Airlines",
      origin: "Kuala Lumpur",
      destination: destinationFromTitle(title),
      departureDate: null,
      returnDate: null,
      price: null,
      currency: null,
      title,
      promotionValidity: [validityMatch ? `Book by ${validityMatch[1]}` : null, iconMatch ? iconMatch[1] : null].filter(Boolean).join("; ") || null,
      sourceUrl: absoluteUrl,
      verificationStatus: "PERLU_SEMAKAN"
    });
    offer.verificationStatus = validateOffer(offer);
    offers.push(offer);
  }
  // Deduplicate by source URL.
  const seenUrls = new Set();
  return offers.filter((offer) => {
    if (seenUrls.has(offer.sourceUrl)) return false;
    seenUrls.add(offer.sourceUrl);
    return true;
  });
}


export function isExpiredPromotion(offer) {
  return promotionExpired(offer?.promotionValidity) || offer?.verificationStatus === "EXPIRED";
}

export function isActivePromotion(offer) {
  if (isExpiredPromotion(offer)) return false;
  return offer?.verificationStatus === "VERIFIED";
}

export function classifyMalaysiaPromotion(offer) {
  const title = String(offer?.title || "").toLowerCase();
  const url = String(offer?.sourceUrl || "").toLowerCase();
  const marketingPatterns = [
    /duty-?free/, /lounge/, /\bride\b/, /rewards/, /points/, /\bseat\b/, /baggage/, /change fee/,
    /\bhotels?\b/, /pulseapp/, /ikhlas/, /value-?pack/, /inflight/, /skincare/, /fragrance/
  ];
  const marketingUrlPatterns = [
    /\/dutyfree\//, /\/ride\//, /\/rewards\//, /\/hotels\//, /ikhlas\.com/, /pulseapp/, /\/inflight-/
  ];
  if (marketingPatterns.some((pattern) => pattern.test(title)) || marketingUrlPatterns.some((pattern) => pattern.test(url))) {
    return "ARTIKEL_PEMASARAN";
  }
  return "PROMOSI_PENERBANGAN";
}

export function promotionMissingFields(offer) {
  const missing = [];
  if (!offer?.origin) missing.push("origin");
  if (!offer?.destination) missing.push("destination");
  if (offer?.price === null || offer?.price === undefined) missing.push("price");
  if (!offer?.promotionValidity) missing.push("validity");
  if (!offer?.departureDate && !offer?.returnDate) missing.push("travelDate");
  return missing;
}

export function enrichMalaysiaAirlinesPromotionFromHtml(html, fallbackUrl) {
  if (!html) return null;
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : null;
  const bookingMatch = html.match(/Booking (?:Period|period):?\s*([\s\S]{0,220})/i);
  const travelMatch = html.match(/Travel (?:Period|period):?\s*([\s\S]{0,220})/i);
  const priceMatch = html.match(/from\s+(MYR|RM)\s*([0-9][0-9,]*)/i) || html.match(/(MYR|RM)\s*([0-9][0-9,]*)/i);
  const price = priceMatch ? Number(priceMatch[2].replace(/,/g, "")) : null;
  const validity = [
    bookingMatch ? `Booking: ${bookingMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}` : null,
    travelMatch ? `Travel: ${travelMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}` : null
  ].filter(Boolean).join("; ") || null;
  return {
    title,
    price,
    currency: price === null ? null : "MYR",
    promotionValidity: validity,
    sourceUrl: fallbackUrl
  };
}
