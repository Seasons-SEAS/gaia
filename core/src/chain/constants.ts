/**
 * Official, protocol-level addresses and endpoints.
 * No third-party wallet addresses belong here.
 */

export const SEAS_MINT = "7GdpaeSzvkx1a78rRkU11KstM1x8naMmMmmpWQnQSEAS";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SEAS_DECIMALS = 8;

/** Inclusion Set #2 ("Perfect Order") distributor, active since 2026-04-01. */
export const SET2_DISTRIBUTOR = "2yHa1Ukpe2rVtusPPYKH1fP8kL6wPFe8K7r7s5NYjk9a";

export const RAYDIUM_CLMM_PAIR = "Fc6NsEMazYGWWQCR6UQSSx8AXV85Qcoa5taJmRbHgZvy";
export const METEORA_DAMM_PAIR = "D12EGYWwgj7S981m6rbvs8LJrWo6s9JZVNVpLDHiHVbJ";

export const BUILDER_CLAIMS_PROGRAM = "GjUEJ3MD19eityiAr8PRRSRGQkN13gdaa5kPfbqR7xmf";
export const BUILDER_CONFIG_PDA = "GPik4LzwFr8chVvdEMDLJvZ7BgmvKXdqqcoj78wWzK8p";
export const BUILDER_VAULT = "Hb5NCcuDVwDPMWoUK44sEkykyfF1rUmvVQtVQYtjUXA1";

export interface KnownMint {
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * Basket assets of Set #2, verified against the payout transactions of the
 * Sun 2026-09-27 round (test/fixtures/chain/round-latest-transactions.json).
 */
export const KNOWN_MINTS: Record<string, KnownMint> = {
  AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P: {
    symbol: "XAUt0",
    name: "Tether Gold",
    decimals: 6,
  },
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": {
    symbol: "wBTC",
    name: "wBTC (Wormhole)",
    decimals: 8,
  },
  "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D": {
    symbol: "jlUSDc",
    name: "Jupiter Lend USDC",
    decimals: 6,
  },
  [SEAS_MINT]: { symbol: "$SEAS", name: "Seasons", decimals: 8 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin", decimals: 6 },
};

/**
 * Circulating supply as the chain defines it (supply minus the 61 Lock1z
 * escrows, net + withheld). Not recomputed live here because the escrow list
 * is not part of this module; dated almanac value.
 */
export const CIRCULATING_ALMANAC = {
  circulating: 332_989_984.15,
  circulatingPctOfSupply: 33.3,
  lockedNet: 600_309_014.08,
  withheldInEscrows: 66_701_001.56,
  outOfCirculation: 667_010_015.65,
  escrows: 61,
  asOf: "2026-09-28",
  readAt: "2026-09-28T10:51:47Z",
  locator:
    "getTokenSupply − Σ(61 Lock1z escrow balances + withheld)",
} as const;

export const DEXSCREENER_PAIRS_API = "https://api.dexscreener.com/latest/dex/pairs/solana/";
export const JUPITER_PRICE_API = "https://lite-api.jup.ag/price/v3";

export const GITBOOK_DISTRIBUTION_URL =
  "https://seasons.gitbook.io/seasons-docs/protocol/yield-3.0-mechanism/distribution";
export const GITBOOK_BUILDER_URL =
  "https://seasons.gitbook.io/seasons-docs/protocol/nodes/builder-nodes";

export const solscanToken = (mint: string) => `https://solscan.io/token/${mint}`;
export const solscanAccount = (address: string) => `https://solscan.io/account/${address}`;
export const solscanTx = (signature: string) => `https://solscan.io/tx/${signature}`;
export const dexscreenerPair = (pair: string) =>
  `https://dexscreener.com/solana/${pair.toLowerCase()}`;

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
