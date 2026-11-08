import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import Parser from "rss-parser";
import admin from "firebase-admin";

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT tiada. Semak GitHub Secret.");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

const parser = new Parser({
  headers: {
    "User-Agent": "TiketMurahErrorFareScanner/1.0",
  },
  timeout: 15000,
});

const feeds = JSON.parse(
  readFileSync(new URL("./feeds.json", import.meta.url), "utf8")
);

const malaysiaDepartureCities = [
  "kuala lumpur", "penang", "johor bahru", "johor", "kota kinabalu",
  "kuching", "langkawi", "subang", "tawau", "miri", "bintulu",
  "kota bharu", "labuan", "sibu", "kuala terengganu", "alor setar",
  "kuantan", "ipoh", "melaka", "malacca", "sandakan"
];

const malaysiaDepartureAirportCodes = [
  "KUL", "PEN", "JHB", "BKI", "KCH", "LGK", "SZB", "TWU", "MYY",
  "BTU", "KBR", "LBU", "SBW", "TGG", "AOR", "KUA", "IPH", "SDK"
];

function hashUrl(url) {
  return crypto.createHash("sha256").update(url).digest("hex");
}

function extractOrigin(title) {
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

function extractDestination(title) {
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
  return titleCase(segment);
}

function titleCase(value) {
  if (!value) return null;
  return value
    .replace(/[^a-zA-Z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ") || null;
}

function isMalaysiaDeparture(origin) {
  if (!origin) return false;
  const lower = origin.toLowerCase();
  if (malaysiaDepartureCities.some(city => lower.includes(city))) return true;
  return malaysiaDepartureAirportCodes.some(code =>
    new RegExp(`\\\\b${code.toLowerCase()}\\\\b`).test(lower)
  );
}

function extractPriceAndCurrency(text) {
  const source = text || "";
  let currency = null;
  let amount = null;

  const patterns = [
    { regex: /US\$\s*([\d,]+(?:\.\d{1,2})?)/i, currency: "USD" },
    { regex: /\$\s*([\d,]+(?:\.\d{1,2})?)/i, currency: "USD" },
    { regex: /€\s*([\d,]+(?:\.\d{1,2})?)/i, currency: "EUR" },
    { regex: /£\s*([\d,]+(?:\.\d{1,2})?)/i, currency: "GBP" },
    { regex: /RM\s*([\d,]+(?:\.\d{1,2})?)/i, currency: "MYR" },
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

async function saveErrorFare(feed, item) {
  const url = item.link || item.guid;
  const title = item.title || "Tawaran penerbangan";
  const text = `${title} ${item.contentSnippet || item.content || ""}`;

  if (!url) return false;

  const origin = extractOrigin(title);
  const destination = extractDestination(title);
  const { price, currency } = extractPriceAndCurrency(text);
  const category = isMalaysiaDeparture(origin) ? "MALAYSIA" : "GLOBAL";
  const status = origin && destination ? "BARU" : "PERLU_SEMAKAN";
  const id = hashUrl(url);
  const ref = db.collection("error_fares").doc(id);

  const saved = await db.runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    if (existing.exists) return false;

    transaction.set(ref, {
      title,
      origin,
      destination,
      price,
      currency,
      source: feed.name,
      source_url: url,
      detected_at: admin.firestore.FieldValue.serverTimestamp(),
      category,
      status,
      dedup_hash: id,
    });

    return true;
  });

  if (!saved) return false;

  try {
    await messaging.send({
      topic: "error_fares",
      notification: {
        title: "Error Fare Live",
        body: title,
      },
      data: {
        url,
        source: feed.name,
        category,
      },
      android: {
        notification: {
          channelId: "error_fares",
        },
      },
    });
  } catch (error) {
    console.error("Gagal hantar push notification Error Fare.");
  }

  console.log(`Error fare baru disimpan: ${title} (${category})`);
  return true;
}

let newCount = 0;

for (const feed of feeds) {
  const feedUrl = feed.name === "Secret Flying"
    ? "http://www.secretflying.com/feed/"
    : feed.url;

  try {
    const parsed = await parser.parseURL(feedUrl);

    for (const item of parsed.items || []) {
      const saved = await saveErrorFare(feed, item);
      if (saved) newCount++;
    }
  } catch (error) {
    console.error(`Gagal baca feed ${feed.name}: ${error.message}`);
  }
}

console.log(`Selesai. Error fare baru: ${newCount}`);