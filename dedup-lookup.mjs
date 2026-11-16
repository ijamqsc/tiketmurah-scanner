/**
 * Existing-document lookup so a source that now publishes a price updates the
 * document created earlier instead of adding a second copy of the same offer.
 *
 * Pure helpers only — the Firestore query lives in the scanner.
 */

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Pick the document that represents the same offer.
 *
 * @param {Array<{id: string, title?: string|null}>} docs
 * @param {{title?: string|null, sourceUrl?: string|null}} offer
 * @returns {{id: string, title?: string|null}|null}
 */
export function selectExistingDoc(docs, offer) {
  if (!Array.isArray(docs) || docs.length === 0) return null;

  const title = normalize(offer?.title);
  if (title) {
    const exact = docs.find((doc) => normalize(doc.title) === title);
    if (exact) return exact;
  }

  // Same source URL with no comparable title: only one candidate is safe.
  if (docs.length === 1) return docs[0];
  return null;
}

/**
 * Normalised identity of a deal, independent of price/currency, used only for
 * reporting whether two documents describe the same offer.
 */
export function dealIdentity(offer) {
  return [
    normalize(offer?.airline),
    normalize(offer?.origin),
    normalize(offer?.destination),
    normalize(offer?.departureDate),
    normalize(offer?.sourceUrl),
  ].join("|");
}
