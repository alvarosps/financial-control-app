export type BillTransaction = {
  id: string;
  description: string;
  amount: string;
  date: Date | string;
  isPaid: boolean;
  installmentNumber: number | null;
  totalInstallments: number | null;
};

export type BillData = {
  total: number;
  unpaidTotal: number;
  isPaid: boolean;
  transactionCount: number;
  transactions: BillTransaction[];
  dueDay: number | null;
  /** Real calendar due date (YYYY-MM-DD). Null when the card has no config. */
  dueDate: string | null;
};
