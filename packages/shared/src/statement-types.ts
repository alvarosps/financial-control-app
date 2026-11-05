export type StatementDateSource = 'institution' | 'user' | 'configuration' | 'unknown';

export type ScheduleAmountChange = {
  billingMonth: number;
  billingYear: number;
  amount: string;
};
