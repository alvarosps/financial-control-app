export type WalletOverdraft = { used: number; available: number };

/** Overdraft (cheque especial) usage and available room for one wallet. */
export function walletOverdraft(cash: number, overdraftLimit: string | null): WalletOverdraft {
  const limit = overdraftLimit == null ? 0 : Number(overdraftLimit);
  const used =
    cash < 0 ? Math.min(Math.abs(cash), overdraftLimit == null ? Math.abs(cash) : limit) : 0;
  const available = Math.round((cash + limit) * 100) / 100;
  return { used: Math.round(used * 100) / 100, available };
}

export function walletsTotals(wallets: { cash: number; overdraftLimit: string | null }[]): {
  cash: number;
  overdraftUsed: number;
  available: number;
} {
  let cash = 0;
  let overdraftUsed = 0;
  let available = 0;
  for (const w of wallets) {
    const od = walletOverdraft(w.cash, w.overdraftLimit);
    cash += w.cash;
    overdraftUsed += od.used;
    available += od.available;
  }
  return {
    cash: Math.round(cash * 100) / 100,
    overdraftUsed: Math.round(overdraftUsed * 100) / 100,
    available: Math.round(available * 100) / 100,
  };
}
