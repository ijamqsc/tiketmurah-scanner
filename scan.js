
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
    "User-Agent": "TiketMurahScanner/1.0",
  },
  timeout: 15000,
});

const feeds = JSON.parse(
  readFileSync(new URL("./feeds.json", import.meta.url), "utf8")
);

const keywords = [
  "error fare",
  "mistake fare",
  "glitch",
  "business class"
];

function matches(text) {
  const lower = (text || "").toLowerCase();
  return keywords.some(keyword => lower.includes(keyword));
}

function findKeyword(text) {
  const lower = (text || "").toLowerCase();
  return keywords.find(keyword => lower.includes(keyword)) || null;
}

function hashUrl(url) {
  return crypto.createHash("sha256").update(url).digest("hex");
}

async function saveDeal(feed, item) {
  const url = item.link || item.guid;
  const title = item.title || "Deal penerbangan";
  const text = `${title} ${item.contentSnippet || item.content || ""}`;

  if (!url || !matches(text)) return false;

  const id = hashUrl(url);
  const ref = db.collection("deals").doc(id);

  const saved = await db.runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    if (existing.exists) return false;

    transaction.set(ref, {
      title,
      url,
      source: feed.name,
      keyword: findKeyword(text),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return true;
  });

  if (!saved) return false;

  try {
    await messaging.send({
      topic: "deals",
      notification: {
        title: "Tawaran penerbangan dikesan",
        body: title,
      },
      data: {
        url,
        source: feed.name,
      },
      android: {
        notification: {
          channelId: "deals",
        },
      },
    });
  } catch (error) {
    console.error("Gagal hantar push notification.");
  }

  console.log(`Deal baru disimpan: ${title}`);
  return true;
}

let newDealCount = 0;

for (const feed of feeds) {
  try {
    const parsed = await parser.parseURL(feed.url);

    for (const item of parsed.items || []) {
      const saved = await saveDeal(feed, item);
      if (saved) newDealCount++;
    }
  } catch (error) {
    console.error(`Gagal baca feed ${feed.name}: ${error.message}`);
  }
}

console.log(`Selesai. Deal baru: ${newDealCount}`);
