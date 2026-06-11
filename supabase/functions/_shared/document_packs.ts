// Shared document-pack catalog for edge functions (Deno mirror of the
// DOCUMENT_PACKS block in src/config/pricing.ts). Keep the two in sync —
// size/price divergence would let the UI advertise a pack the server prices
// differently.
//
// Each pack is its own recurring Stripe subscription, tagged
// metadata.addon_type='document_pack' + metadata.pack_size so the webhook can
// classify it apart from plan subscriptions and recompute the workspace's
// addon_document_capacity (the sum of all its active pack sizes).
//
// Stripe Price IDs come from env vars (operator creates the Prices first);
// the purchase path fails closed when a pack's price id is unset, exactly like
// the annual-plan prices in create-checkout.

export interface DocumentPack {
  id: "pack_10" | "pack_20" | "pack_50";
  size: number;
  priceMonthlyUsd: number;
  /** Env var holding the Stripe recurring Price ID. */
  priceEnvVar: string;
}

export const DOCUMENT_PACKS: Record<string, DocumentPack> = {
  pack_10: { id: "pack_10", size: 10, priceMonthlyUsd: 90,  priceEnvVar: "STRIPE_PRICE_PACK_10" },
  pack_20: { id: "pack_20", size: 20, priceMonthlyUsd: 160, priceEnvVar: "STRIPE_PRICE_PACK_20" },
  pack_50: { id: "pack_50", size: 50, priceMonthlyUsd: 350, priceEnvVar: "STRIPE_PRICE_PACK_50" },
};

/** Metadata tag stamped on every pack subscription. */
export const ADDON_TYPE_DOCUMENT_PACK = "document_pack";

/** Resolve a pack's Stripe Price ID from env, or null if unconfigured. */
export function packPriceId(pack: DocumentPack): string | null {
  return Deno.env.get(pack.priceEnvVar) ?? null;
}
