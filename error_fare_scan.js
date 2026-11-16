import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import Parser from "rss-parser";
import admin from "firebase-admin";
import {
  extractOrigin,
  extractDestination,
  extractPriceAndCurrency,
  containsMalaysiaDepartureToken,
  isMalaysiaDeparture
} from "./malaysia-market.mjs";
import { classifyOrigin } from "./malaysia-origin.mjs";
import { parseFeedXml } from "./feed-parser.mjs";
import { selectExistingDoc } from "./dedup-lookup.mjs";
import {
  parseAirAsiaPromotions,
  parseMalaysiaAirlinesPromotionsModel,
  parseFireflyPromotions,
  validateOffer,
  dedupHash,
  isActivePromotion,
  classifyMalaysiaPromotion,
  enrichMalaysiaAirlinesPromotionFromHtml
} from "./malaysia-airline-deals-core.mjs";

const dryRun = process.argv.includes("--dry-run");
const sourceArg = (process.argv.find((arg) => arg.startsWith("--source=")) || "").split("=")[1] || "";
const onlySource = sourceArg.trim().toLowerCase();
const runSource = (name) => !onlySource || onlySource === name;
// A single-source run must not touch error_fares.
const forceDealsOnly = Boolean(onlySource);

let db = null;
let messaging = null;

if (!dryRun) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT tiada. Semak GitHub Secret.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  db = admin.firestore();
  messaging = admin.messaging();
}

const parser = new Parser({
  headers: {
    "User-Agent": "TiketMurahErrorFareScanner/1.0",
  },
  timeout: 15000,
});

const feeds = JSON.parse(
  readFileSync(new URL("./feeds.json", import.meta.url), "utf8")
);

function hashUrl(url) {
  return crypto.createHash("sha256").update(url).digest("hex");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "TiketMurahErrorFareScanner/1.0" },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  if (!body.trim()) throw new Error(`Kandungan kosong (HTTP ${response.status})`);
  return body;
}

const malaysiaSeenHashes = new Set();
let globalErrorFareCount = 0;
let malaysiaDealCount = 0;
let malaysiaExpiredCount = 0;
let malaysiaPerluSemakanCount = 0;
let malaysiaActiveCount = 0;
let malaysiaPerluMarketingCount = 0;
let malaysiaPerluFlightPromotionCount = 0;
let malaysiaEnrichedCount = 0;
let malaysiaErrorFareCount = 0;
let malaysiaVerifiedCount = 0;
let malaysiaDuplicateCount = 0;
let malaysiaSourceCount = 0;
const failedSources = [];
const statusExamples = { EXPIRED: null, PERLU_SEMAKAN: null, VERIFIED: null };

async function saveErrorFare(feed, item) {
  const url = item.link || item.guid;
  const title = item.title || "Tawaran penerbangan";
  const text = `${title} ${item.contentSnippet || item.content || ""}`;

  if (!url) return false;

  const origin = extractOrigin(title);
  const destination = extractDestination(title);
  const { price, currency } = extractPriceAndCurrency(text);
  const originInfo = classifyOrigin(origin, title);
  const category = originInfo.category;
  const hasPrice = price !== null && currency !== null;
  const status = (!origin || !destination || !hasPrice) ? "PERLU_SEMAKAN" : "BARU";
  const id = hashUrl(url);

  if (dryRun) {
    console.log(
      `[DRY-RUN] Error fare candidate: ${title} (${category}, ${originInfo.reason}) hasPrice=${hasPrice}`
    );
    return true;
  }

  const ref = db.collection("error_fares").doc(id);

  const saved = await db.runTransaction(async (transaction) => {
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
      origin_iata: originInfo.iata,
      origin_country: originInfo.country,
      origin_country_code: originInfo.countryCode,
      origin_reason: originInfo.reason,
      status,
      has_price: hasPrice,
      verification_status: hasPrice && origin && destination ? "PERLU_SEMAKAN" : "BELUM_LENGKAP",
      dedup_hash: id,
    });

    return true;
  });

  if (!saved) return false;

  try {
    if (messaging) {
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
    }
  } catch (error) {
    console.error("Gagal hantar push notification Error Fare.");
  }

  console.log(`Error fare baru disimpan: ${title} (${category})`);
  return true;
}

async function existingDocRef(collection, offer) {
  if (dryRun || !offer.sourceUrl) return null;
  const snap = await db
    .collection(collection)
    .where("source_url", "==", offer.sourceUrl)
    .limit(10)
    .get();
  const docs = snap.docs.map((doc) => ({ id: doc.id, title: doc.get("title") }));
  const match = selectExistingDoc(docs, offer);
  return match ? db.collection(collection).doc(match.id) : null;
}

async function saveMalaysiaDeal(offer) {
  const hash = dedupHash(offer);
  if (malaysiaSeenHashes.has(hash)) {
    malaysiaDuplicateCount++;
    return false;
  }
  malaysiaSeenHashes.add(hash);

  if (dryRun) {
    console.log(`[DRY-RUN] Malaysia deal (PERLU_SEMAKAN): ${offer.airline} | ${offer.title} | ${offer.origin || "-"} -> ${offer.destination || "-"} | ${classifyOrigin(offer.origin, offer.title).category}`);
    malaysiaDealCount++;
    return true;
  }

  const originInfo = classifyOrigin(offer.origin, offer.title);
  // dedupHash returns a readable key (may contain "/"); Firestore doc ids must not.
  const docId = crypto.createHash("sha256").update(hash).digest("hex");
  // Reuse an earlier document for the same offer instead of adding a copy.
  const ref = (await existingDocRef("deals", offer)) || db.collection("deals").doc(docId);
  await ref.set({
    title: offer.title,
    url: offer.sourceUrl,
    source: offer.airline || "Malaysia airline source",
    keyword: "malaysia airline promotion",
    category: originInfo.category,
    origin_iata: originInfo.iata,
    origin_country: originInfo.country,
    origin_country_code: originInfo.countryCode,
    origin_reason: originInfo.reason,
    deal_type: classifyMalaysiaPromotion(offer),
    status: offer.verificationStatus === "EXPIRED" ? "EXPIRED" : "PERLU_SEMAKAN",
    verification_status: offer.verificationStatus || "PERLU_SEMAKAN",
    candidate_status: "NEW_CANDIDATE",
    dedup_hash: docId,
    origin: offer.origin,
    destination: offer.destination,
    price: offer.price,
    currency: offer.currency,
    source_url: offer.sourceUrl,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  malaysiaDealCount++;
  return true;
}

async function saveMalaysiaErrorFare(offer) {
  if (forceDealsOnly) return await saveMalaysiaDeal(offer);
  const hash = dedupHash(offer);
  if (malaysiaSeenHashes.has(hash)) {
    malaysiaDuplicateCount++;
    return false;
  }
  malaysiaSeenHashes.add(hash);

  const hasRoutePrice = offer.price !== null && offer.currency !== null;
  if (!hasRoutePrice) {
    return await saveMalaysiaDeal(offer);
  }

  if (dryRun) {
    console.log(`[DRY-RUN] Malaysia error fare candidate: ${offer.airline} | ${offer.title} | ${offer.origin} -> ${offer.destination} | ${offer.price} ${offer.currency} | ${classifyOrigin(offer.origin, offer.title).category}`);
    malaysiaErrorFareCount++;
    return true;
  }

  const originInfo = classifyOrigin(offer.origin, offer.title);
  const docId = crypto.createHash("sha256").update(hash).digest("hex");
  const ref = (await existingDocRef("error_fares", offer)) || db.collection("error_fares").doc(docId);
  await ref.set({
    title: offer.title,
    origin: offer.origin,
    destination: offer.destination,
    price: offer.price,
    currency: offer.currency,
    source: offer.airline || "Malaysia airline source",
    source_url: offer.sourceUrl,
    detected_at: admin.firestore.FieldValue.serverTimestamp(),
    category: originInfo.category,
    origin_iata: originInfo.iata,
    origin_country: originInfo.country,
    origin_country_code: originInfo.countryCode,
    origin_reason: originInfo.reason,
    status: offer.verificationStatus === "EXPIRED"
      ? "EXPIRED"
      : (offer.origin && offer.destination && hasRoutePrice ? "BARU" : "PERLU_SEMAKAN"),
    has_price: hasRoutePrice,
    verification_status: offer.verificationStatus || "PERLU_SEMAKAN",
    candidate_status: "NEW_CANDIDATE",
    dedup_hash: docId,
    promotion_validity: offer.promotionValidity,
  }, { merge: true });
  malaysiaErrorFareCount++;
  return true;
}

async function processMalaysiaOffers(offers) {
  for (const rawOffer of offers || []) {
    const offer = { ...rawOffer, verificationStatus: validateOffer(rawOffer) };
    if (!offer.sourceUrl) continue;
    const classification = classifyMalaysiaPromotion(offer);
    if (offer.verificationStatus === "EXPIRED") {
      malaysiaExpiredCount++;
      if (!statusExamples.EXPIRED) statusExamples.EXPIRED = offer;
    } else if (offer.verificationStatus === "PERLU_SEMAKAN") {
      malaysiaPerluSemakanCount++;
      if (classification === "ARTIKEL_PEMASARAN") malaysiaPerluMarketingCount++;
      else malaysiaPerluFlightPromotionCount++;
      if (!statusExamples.PERLU_SEMAKAN) statusExamples.PERLU_SEMAKAN = offer;
    } else if (offer.verificationStatus === "VERIFIED") {
      malaysiaVerifiedCount++;
      if (!statusExamples.VERIFIED) statusExamples.VERIFIED = offer;
    }
    if (isActivePromotion(offer)) malaysiaActiveCount++;
    // Semua tawaran Malaysia ditulis ke koleksi deals supaya tab Tawaran Malaysia boleh memaparkannya.
    await saveMalaysiaDeal(offer);
    // Tawaran lengkap juga dicatat di error_fares untuk pemantauan Error Fare.
    if (offer.price !== null && offer.currency && offer.origin && offer.destination) {
        await saveMalaysiaErrorFare(offer);
    }
  }
}

// Foreign RSS/global feeds.
for (const feed of feeds) {
  if (!runSource("rss")) break;
  if (feed.enabled === false) continue;

  try {
    const xml = await fetchText(feed.url);
    const { items, skipped, recovered } = await parseFeedXml(parser, xml);

    if (recovered) {
      console.log(
        `Feed ${feed.name}: dipulihkan item demi item (${items.length} sah, ${skipped} rosak)`
      );
    }

    for (const item of items) {
      const saved = await saveErrorFare(feed, item);
      if (saved) globalErrorFareCount++;
    }
  } catch (error) {
    console.error(`Gagal baca feed ${feed.name}: ${error.message}`);
    failedSources.push(`GLOBAL:${feed.name}: ${error.message}`);
  }
}

// Malaysia airline sources.
console.log("=== SUMBER MALAYSIA (pipeline Error Fare / Deals) ===");

if (runSource("airasia")) {
console.log("Scanning AirAsia: https://www.airasia.com/promotions/page-data/index/page-data.json");
try {
  const jsonText = await fetchText("https://www.airasia.com/promotions/page-data/index/page-data.json");
  const offers = parseAirAsiaPromotions(jsonText);
  console.log(`  sumber=AirAsia page-data JSON, bytes=${jsonText.length}, offers=${offers.length}`);
  malaysiaSourceCount++;
  await processMalaysiaOffers(offers);
} catch (error) {
  console.error(`  Gagal baca AirAsia: ${error.message}`);
  failedSources.push(`MALAYSIA:AirAsia: ${error.message}`);
}
}

const masMainUrl = "https://www.malaysiaairlines.com/my/en/promotions.model.json";
if (runSource("malaysia-airlines")) {
console.log(`Scanning Malaysia Airlines: ${masMainUrl}`);
try {
  const jsonText = await fetchText(masMainUrl);
  const offers = parseMalaysiaAirlinesPromotionsModel(jsonText);
  console.log(`  sumber=Malaysia Airlines AEM model JSON, bytes=${jsonText.length}, offers=${offers.length}`);
  // Enrich PERLU_SEMAKAN promotions from official promotion pages (no paid API).
  for (const offer of offers) {
    if (offer.verificationStatus !== "PERLU_SEMAKAN" || !offer.sourceUrl || !/malaysiaairlines\.com/i.test(offer.sourceUrl)) continue;
    try {
      const html = await fetchText(offer.sourceUrl);
      const extra = enrichMalaysiaAirlinesPromotionFromHtml(html, offer.sourceUrl);
      let changed = false;
      if (extra?.price !== null && offer.price === null) {
        offer.price = extra.price;
        offer.currency = extra.currency || offer.currency;
        changed = true;
      }
      if (extra?.promotionValidity && !(offer.promotionValidity || "").includes("Travel:")) {
        offer.promotionValidity = extra.promotionValidity;
        changed = true;
      }
      if (extra?.title && (!offer.title || offer.title === "Malaysia Airlines promotion")) {
        offer.title = extra.title;
        changed = true;
      }
      if (changed) {
        offer.enriched = true;
        malaysiaEnrichedCount++;
      }
      offer.verificationStatus = validateOffer(offer);
    } catch (error) {
      console.error(`  Gagal enrich ${offer.sourceUrl}: ${error.message}`);
    }
  }
  malaysiaSourceCount++;
  await processMalaysiaOffers(offers);
} catch (error) {
  console.error(`  Gagal baca Malaysia Airlines: ${error.message}`);
  failedSources.push(`MALAYSIA:Malaysia Airlines: ${error.message}`);
}
}

if (runSource("batik")) {
console.log("Scanning Batik Air Malaysia: https://www.batikair.com.my/");
try {
  const html = await fetchText("https://www.batikair.com.my/");
  console.log(`  sumber=Batik Air Malaysia, bytes=${html.length}, offers=0 (tiada parser rasmi yang boleh dipercayai)`);
  malaysiaSourceCount++;
} catch (error) {
  console.error(`  Gagal baca Batik Air Malaysia: ${error.message}`);
  failedSources.push(`MALAYSIA:Batik Air: ${error.message}`);
}
}

const fireflyUrl = "https://www.fireflyz.com.my/my/en/deals/online-exclusive-deals.html";
if (runSource("firefly")) {
console.log(`Scanning Firefly: ${fireflyUrl}`);
try {
  const html = await fetchText(fireflyUrl);
  const offers = parseFireflyPromotions(html, fireflyUrl);
  console.log(`  sumber=Firefly promotion page, bytes=${html.length}, offers=${offers.length}`);
  malaysiaSourceCount++;
  await processMalaysiaOffers(offers);
} catch (error) {
  console.error(`  Gagal baca Firefly: ${error.message}`);
  failedSources.push(`MALAYSIA:Firefly: ${error.message}`);
}
}

console.log("=== RINGKASAN ===");
console.log(`Sumber global (RSS feeds): ${feeds.length}`);
console.log(`Sumber Malaysia berjaya dipanggil: ${malaysiaSourceCount}/4`);
console.log(`Global error fare candidates baharu: ${globalErrorFareCount}`);
console.log(`Malaysia deals (PERLU_SEMAKAN): ${malaysiaDealCount}`);
console.log(`Malaysia promosi tamat tempoh (EXPIRED): ${malaysiaExpiredCount}`);
console.log(`Malaysia promosi perlu semakan: ${malaysiaPerluSemakanCount}`);
console.log(`Malaysia promosi aktif: ${malaysiaActiveCount}`);
console.log(`Malaysia error fare candidates: ${malaysiaErrorFareCount}`);
console.log(`Malaysia error fare VERIFIED: ${malaysiaVerifiedCount}`);
console.log(`Malaysia duplicate: ${malaysiaDuplicateCount}`);
console.log(`Malaysia PERLU_SEMAKAN promosi penerbangan: ${malaysiaPerluFlightPromotionCount}`);
console.log(`Malaysia PERLU_SEMAKAN artikel pemasaran: ${malaysiaPerluMarketingCount}`);
console.log(`Malaysia rekod diperkaya metadata: ${malaysiaEnrichedCount}`);
for (const [status, offer] of Object.entries(statusExamples)) {
  if (offer) {
    console.log(`Contoh ${status}: ${offer.airline} | ${offer.title} | ${offer.origin || "-"} -> ${offer.destination || "-"} | ${offer.promotionValidity || "tiada tarikh"}`);
  } else {
    console.log(`Contoh ${status}: tiada`);
  }
}
console.log(`Sumber gagal: ${failedSources.length}`);
for (const failure of failedSources) console.log(`  - ${failure}`);
if (dryRun) console.log("Mod dry-run: tiada data ditulis ke Firestore.");
console.log("Selesai.");
