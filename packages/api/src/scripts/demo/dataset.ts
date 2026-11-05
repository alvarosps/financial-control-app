/**
 * Dataset de demo — Controle Financeiro (financial-control)
 *
 * Arquivo TypeScript NEUTRO (sem imports, sem dependência de schema de banco).
 * Outro agente é responsável por mapear estas estruturas para o schema Drizzle real.
 *
 * Convenção de datas: todas as referências temporais são relativas ao mês corrente,
 * em MESES ATRÁS (monthsAgo). 0 = mês corrente (2026-07), -14 = 15 meses atrás (2025-05).
 * Um "dia do mês" (day) é fornecido separadamente quando relevante (vencimentos, cobranças).
 *
 * Todos os valores monetários estão em BRL (number, 2 casas decimais implícitas).
 * Todos os valores de assinaturas/planos/preços de mercado foram pesquisados na web
 * em julho de 2026 — ver README.md para fontes detalhadas.
 *
 * Personas e nomes de pessoas são 100% FICTÍCIOS. Nomes de bancos, lojas, operadoras,
 * serviços de streaming e estabelecimentos são REAIS (marcas brasileiras conhecidas),
 * usados apenas como rótulos realistas de transações — nenhuma transação real ocorreu.
 */

// ============================================================================
// TIPOS
// ============================================================================

export interface Category {
  /** slug estável, usado como chave de referência em outras entidades */
  key: string;
  name: string;
  /** cor hex para uso em UI (charts, badges) */
  color: string;
  /** nome de ícone lucide-react */
  icon: string;
  /** indica se a categoria tende a ter gasto fixo (charges) vs variável (spending) */
  kind: 'fixed' | 'variable' | 'both';
}

export interface Persona {
  key: string;
  name: string;
  email: string;
  role: 'power-user' | 'intermediate' | 'empty';
  /** meses de histórico de dados a partir do mês corrente (0) */
  historyMonths: number;
  occupation: string;
  household: HouseholdMember[];
  accounts: Account[];
  cards: Card[];
  notes: string;
}

export interface HouseholdMember {
  name: string;
  relationship: 'spouse' | 'child' | 'sibling';
  age?: number;
}

export interface Account {
  key: string;
  personaKey: string;
  bank: string;
  type: 'checking' | 'savings';
  nickname: string;
  /** saldo de abertura no início do histórico (monthsAgo mais negativo) */
  openingBalance: number;
  isDefault: boolean;
}

export interface Card {
  key: string;
  personaKey: string;
  issuer: string;
  network: 'visa' | 'mastercard' | 'elo' | 'amex';
  nickname: string;
  last4: string;
  closingDay: number;
  dueDay: number;
  creditLimit: number;
}

export interface FixedCharge {
  key: string;
  personaKey: string;
  categoryKey: string;
  name: string;
  /** conta ou cartão de pagamento */
  paymentMethodKey: string;
  baseAmount: number;
  /** variação percentual mês a mês (ex.: 0.2 = ±20%) */
  variancePct: number;
  /** meses civis (1-12) de pico sazonal e multiplicador aplicado sobre baseAmount */
  seasonalPeaks?: { month: number; multiplier: number }[];
  dueDay: number;
  startMonthsAgo: number;
  frequency: 'monthly' | 'bimonthly';
}

export interface Subscription {
  key: string;
  personaKey: string;
  cardKey: string;
  service: string;
  plan: string;
  amount: number;
  billingDay: number;
  startMonthsAgo: number;
  /** true = ainda ativa; false = cancelada em cancelMonthsAgo */
  active: boolean;
  cancelMonthsAgo?: number;
  sourceNote: string;
}

export interface InstallmentPurchase {
  key: string;
  personaKey: string;
  cardKey: string;
  merchant: string;
  description: string;
  categoryKey: string;
  totalAmount: number;
  installments: number;
  /** valor de cada parcela (totalAmount / installments, arredondado) — parcelas somam totalAmount */
  installmentAmount: number;
  /** mês relativo da 1ª parcela */
  startMonthsAgo: number;
}

export interface SeasonalMultiplier {
  month: number; // 1-12
  multiplier: number;
}

export interface VariableSpendingProfile {
  categoryKey: string;
  personaKey: string;
  minMonthly: number;
  maxMonthly: number;
  seasonality: SeasonalMultiplier[];
  typicalMerchantKeys: string[];
}

export interface Income {
  key: string;
  personaKey: string;
  source: string;
  recipientName: string;
  baseAmount: number;
  /** dia aproximado de recebimento */
  day: number;
  frequency: 'monthly' | 'irregular';
  /** para renda variável: faixa de variação */
  minAmount?: number;
  maxAmount?: number;
  /** meses civis com pagamento extra (ex.: 13º salário) e valor extra */
  extraPayments?: { month: number; amount: number; label: string }[];
  startMonthsAgo: number;
}

export interface OneOffEvent {
  key: string;
  personaKey: string;
  categoryKey: string;
  description: string;
  amount: number;
  monthsAgo: number;
  merchantKey?: string;
  paymentMethodKey: string;
  /** se true, é receita pontual (ex.: reembolso); default false = despesa */
  isIncome?: boolean;
}

export interface LoanInstallmentPlan {
  key: string;
  personaKey: string;
  loanType: 'financing' | 'family_loan_granted';
  counterparty: string;
  description: string;
  principal: number;
  installments: number;
  installmentAmount: number;
  interestIncluded: boolean;
  startMonthsAgo: number;
  paidInstallments: number;
  paymentMethodKey: string;
  dueDay: number;
}

export interface Merchant {
  key: string;
  name: string;
  categoryKey: string;
  city: string;
}

// ============================================================================
// CATEGORIAS (20)
// ============================================================================

export const categories: Category[] = [
  { key: 'mercado', name: 'Mercado', color: '#22C55E', icon: 'shopping-cart', kind: 'variable' },
  {
    key: 'restaurantes',
    name: 'Restaurantes/Delivery',
    color: '#F97316',
    icon: 'utensils',
    kind: 'variable',
  },
  { key: 'transporte', name: 'Transporte', color: '#3B82F6', icon: 'bus', kind: 'variable' },
  { key: 'combustivel', name: 'Combustível', color: '#0EA5E9', icon: 'fuel', kind: 'variable' },
  { key: 'moradia', name: 'Moradia', color: '#8B5CF6', icon: 'home', kind: 'fixed' },
  { key: 'energia', name: 'Energia', color: '#EAB308', icon: 'zap', kind: 'fixed' },
  {
    key: 'internet_telefone',
    name: 'Internet/Telefone',
    color: '#06B6D4',
    icon: 'wifi',
    kind: 'fixed',
  },
  { key: 'saude', name: 'Saúde', color: '#EF4444', icon: 'heart-pulse', kind: 'both' },
  { key: 'farmacia', name: 'Farmácia', color: '#F43F5E', icon: 'pill', kind: 'variable' },
  { key: 'educacao', name: 'Educação', color: '#6366F1', icon: 'graduation-cap', kind: 'fixed' },
  { key: 'assinaturas', name: 'Assinaturas', color: '#A855F7', icon: 'tv', kind: 'fixed' },
  { key: 'lazer', name: 'Lazer', color: '#EC4899', icon: 'party-popper', kind: 'variable' },
  { key: 'vestuario', name: 'Vestuário', color: '#14B8A6', icon: 'shirt', kind: 'variable' },
  { key: 'viagem', name: 'Viagem', color: '#0891B2', icon: 'plane', kind: 'variable' },
  { key: 'presentes', name: 'Presentes', color: '#D946EF', icon: 'gift', kind: 'variable' },
  { key: 'pets', name: 'Pets', color: '#84CC16', icon: 'dog', kind: 'both' },
  {
    key: 'impostos_taxas',
    name: 'Impostos/Taxas',
    color: '#78716C',
    icon: 'landmark',
    kind: 'variable',
  },
  {
    key: 'casa_manutencao',
    name: 'Casa/Manutenção',
    color: '#A16207',
    icon: 'wrench',
    kind: 'variable',
  },
  { key: 'beleza', name: 'Beleza', color: '#F472B6', icon: 'sparkles', kind: 'variable' },
  { key: 'outros', name: 'Outros', color: '#71717A', icon: 'more-horizontal', kind: 'variable' },
];

// ============================================================================
// MERCHANTS (40+ estabelecimentos reais BR)
// ============================================================================

export const merchants: Merchant[] = [
  // Mercado
  { key: 'pao_de_acucar', name: 'Pão de Açúcar', categoryKey: 'mercado', city: 'São Paulo' },
  { key: 'zaffari', name: 'Zaffari', categoryKey: 'mercado', city: 'Porto Alegre' },
  { key: 'carrefour', name: 'Carrefour', categoryKey: 'mercado', city: 'São Paulo' },
  { key: 'extra_mercado', name: 'Mercado Extra', categoryKey: 'mercado', city: 'São Paulo' },
  {
    key: 'hortifruti_natural',
    name: 'Hortifruti Natural da Terra',
    categoryKey: 'mercado',
    city: 'São Paulo',
  },
  { key: 'assai_atacadista', name: 'Assaí Atacadista', categoryKey: 'mercado', city: 'São Paulo' },
  // Restaurantes/Delivery
  { key: 'ifood', name: 'iFood', categoryKey: 'restaurantes', city: 'São Paulo' },
  { key: 'rappi', name: 'Rappi', categoryKey: 'restaurantes', city: 'São Paulo' },
  { key: 'outback', name: 'Outback Steakhouse', categoryKey: 'restaurantes', city: 'São Paulo' },
  { key: 'madero', name: 'Madero', categoryKey: 'restaurantes', city: 'São Paulo' },
  { key: 'starbucks', name: 'Starbucks', categoryKey: 'restaurantes', city: 'São Paulo' },
  // Transporte
  { key: 'uber', name: 'Uber', categoryKey: 'transporte', city: 'São Paulo' },
  { key: '99', name: '99', categoryKey: 'transporte', city: 'São Paulo' },
  {
    key: 'bilhete_unico',
    name: 'Bilhete Único SPTrans',
    categoryKey: 'transporte',
    city: 'São Paulo',
  },
  { key: 'estapar', name: 'Estapar Estacionamentos', categoryKey: 'transporte', city: 'São Paulo' },
  // Combustível
  { key: 'posto_ipiranga', name: 'Posto Ipiranga', categoryKey: 'combustivel', city: 'São Paulo' },
  { key: 'posto_shell', name: 'Posto Shell', categoryKey: 'combustivel', city: 'São Paulo' },
  // Saúde/Farmácia
  { key: 'drogasil', name: 'Drogasil', categoryKey: 'farmacia', city: 'São Paulo' },
  { key: 'drogaria_sp', name: 'Drogaria São Paulo', categoryKey: 'farmacia', city: 'São Paulo' },
  { key: 'raia', name: 'Droga Raia', categoryKey: 'farmacia', city: 'São Paulo' },
  { key: 'fleury', name: 'Fleury Medicina Diagnóstica', categoryKey: 'saude', city: 'São Paulo' },
  { key: 'clinica_odonto', name: 'Clínica OdontoCompany', categoryKey: 'saude', city: 'São Paulo' },
  // Vestuário
  { key: 'renner', name: 'Renner', categoryKey: 'vestuario', city: 'São Paulo' },
  { key: 'cea', name: 'C&A', categoryKey: 'vestuario', city: 'São Paulo' },
  { key: 'decathlon', name: 'Decathlon', categoryKey: 'vestuario', city: 'São Paulo' },
  { key: 'zara', name: 'Zara', categoryKey: 'vestuario', city: 'São Paulo' },
  // Eletrônicos / eletrodomésticos
  {
    key: 'magazine_luiza',
    name: 'Magazine Luiza',
    categoryKey: 'casa_manutencao',
    city: 'São Paulo',
  },
  { key: 'amazon_br', name: 'Amazon.com.br', categoryKey: 'casa_manutencao', city: 'São Paulo' },
  { key: 'fast_shop', name: 'Fast Shop', categoryKey: 'casa_manutencao', city: 'São Paulo' },
  // Lazer
  { key: 'cinemark', name: 'Cinemark', categoryKey: 'lazer', city: 'São Paulo' },
  { key: 'ingresso_com', name: 'Ingresso.com', categoryKey: 'lazer', city: 'São Paulo' },
  { key: 'steam', name: 'Steam', categoryKey: 'lazer', city: 'São Paulo' },
  // Viagem
  { key: 'latam', name: 'LATAM Airlines', categoryKey: 'viagem', city: 'São Paulo' },
  { key: 'decolar', name: 'Decolar.com', categoryKey: 'viagem', city: 'São Paulo' },
  { key: 'booking', name: 'Booking.com', categoryKey: 'viagem', city: 'São Paulo' },
  { key: 'localiza', name: 'Localiza Rent a Car', categoryKey: 'viagem', city: 'São Paulo' },
  // Pets
  { key: 'petz', name: 'Petz', categoryKey: 'pets', city: 'São Paulo' },
  { key: 'cobasi', name: 'Cobasi', categoryKey: 'pets', city: 'São Paulo' },
  // Beleza
  { key: 'boticario', name: 'O Boticário', categoryKey: 'beleza', city: 'São Paulo' },
  { key: 'sephora', name: 'Sephora', categoryKey: 'beleza', city: 'São Paulo' },
  { key: 'salao_bertolucci', name: 'Salão Bertolucci', categoryKey: 'beleza', city: 'São Paulo' },
  // Presentes
  { key: 'imaginarium', name: 'Imaginarium', categoryKey: 'presentes', city: 'São Paulo' },
  { key: 'natura', name: 'Natura', categoryKey: 'presentes', city: 'São Paulo' },
];

// ============================================================================
// PERSONAS (3: power-user, intermediária, vazia)
// ============================================================================

export const personas: Persona[] = [
  {
    key: 'rafael',
    name: 'Rafael Almeida',
    email: 'rafael.almeida.demo@example.com',
    role: 'power-user',
    historyMonths: 15,
    occupation: 'Desenvolvedor de Software Sênior (CLT)',
    household: [
      { name: 'Juliana Almeida', relationship: 'spouse', age: 34 },
      { name: 'Pedro Almeida', relationship: 'child', age: 6 },
    ],
    accounts: [
      {
        key: 'rafael_itau_cc',
        personaKey: 'rafael',
        bank: 'Itaú',
        type: 'checking',
        nickname: 'Itaú Corrente',
        openingBalance: 8500,
        isDefault: true,
      },
      {
        key: 'rafael_nubank_cc',
        personaKey: 'rafael',
        bank: 'Nubank',
        type: 'checking',
        nickname: 'Nubank Conta',
        openingBalance: 2300,
        isDefault: false,
      },
    ],
    cards: [
      {
        key: 'rafael_nubank_card',
        personaKey: 'rafael',
        issuer: 'Nubank',
        network: 'mastercard',
        nickname: 'Nubank Roxinho',
        last4: '4821',
        closingDay: 28,
        dueDay: 5,
        creditLimit: 18000,
      },
      {
        key: 'rafael_itau_card',
        personaKey: 'rafael',
        issuer: 'Itaú',
        network: 'visa',
        nickname: 'Itaú Personnalité',
        last4: '9859',
        closingDay: 13,
        dueDay: 20,
        creditLimit: 25000,
      },
      {
        key: 'rafael_xp_card',
        personaKey: 'rafael',
        issuer: 'XP',
        network: 'visa',
        nickname: 'XP Visa Infinite',
        last4: '3307',
        closingDay: 20,
        dueDay: 27,
        creditLimit: 15000,
      },
    ],
    notes:
      'Power-user com 15 meses de histórico completo (monthsAgo -14 a 0). Casado com Juliana (renda autônoma variável), 1 filho (Pedro, 6 anos). Financiamento de carro em andamento (48x, 20 pagas). Empréstimo familiar concedido ao irmão fictício Bruno (12x R$500). ~10 assinaturas ativas distribuídas nos 3 cartões.',
  },
  {
    key: 'marina',
    name: 'Marina Costa',
    email: 'marina.costa.demo@example.com',
    role: 'intermediate',
    historyMonths: 4,
    occupation: 'Designer Gráfica Autônoma (Freelancer)',
    household: [],
    accounts: [
      {
        key: 'marina_inter_cc',
        personaKey: 'marina',
        bank: 'Banco Inter',
        type: 'checking',
        nickname: 'Inter Conta Digital',
        openingBalance: 1800,
        isDefault: true,
      },
    ],
    cards: [
      {
        key: 'marina_inter_card',
        personaKey: 'marina',
        issuer: 'Banco Inter',
        network: 'mastercard',
        nickname: 'Inter Mastercard Gold',
        last4: '6612',
        closingDay: 10,
        dueDay: 17,
        creditLimit: 6000,
      },
    ],
    notes:
      'Usuária intermediária, onboarding recente: apenas 4 meses de histórico (monthsAgo -3 a 0). Autônoma com renda variável e irregular (2-3 clientes por mês). Sem empréstimos, sem financiamentos. 1 cartão, 1 conta — cenário de app "ainda enxuto".',
  },
  {
    key: 'demo_novo',
    name: 'Demo Novo',
    email: 'demo.novo@example.com',
    role: 'empty',
    historyMonths: 0,
    occupation: '(não informado)',
    household: [],
    accounts: [],
    cards: [],
    notes:
      'Conta vazia proposital para demonstrar estados de onboarding/empty-state do app. NÃO deve receber nenhuma categoria, transação, cartão, conta, assinatura ou evento além do próprio cadastro do usuário. Usada para telas de "primeiro acesso", "nenhuma transação ainda", "adicione seu primeiro cartão", etc.',
  },
];

// ============================================================================
// FIXED CHARGES (contas fixas mensais/recorrentes)
// ============================================================================

export const rafaelFixedCharges: FixedCharge[] = [
  // --- Rafael ---
  {
    key: 'rafael_financiamento_apto',
    personaKey: 'rafael',
    categoryKey: 'moradia',
    name: 'Financiamento Imobiliário Itaú',
    paymentMethodKey: 'rafael_itau_cc',
    baseAmount: 2850.4,
    variancePct: 0,
    dueDay: 10,
    startMonthsAgo: -14,
    frequency: 'monthly',
  },
  {
    key: 'rafael_condominio',
    personaKey: 'rafael',
    categoryKey: 'moradia',
    name: 'Condomínio Edifício Jardim das Acácias',
    paymentMethodKey: 'rafael_itau_cc',
    baseAmount: 780,
    variancePct: 0.05,
    dueDay: 5,
    startMonthsAgo: -14,
    frequency: 'monthly',
  },
  {
    key: 'rafael_energia',
    personaKey: 'rafael',
    categoryKey: 'energia',
    name: 'Energia Elétrica Enel SP',
    paymentMethodKey: 'rafael_itau_cc',
    baseAmount: 340,
    variancePct: 0.2,
    seasonalPeaks: [
      { month: 1, multiplier: 1.35 },
      { month: 2, multiplier: 1.3 },
      { month: 12, multiplier: 1.25 },
    ],
    dueDay: 15,
    startMonthsAgo: -14,
    frequency: 'monthly',
  },
  {
    key: 'rafael_internet',
    personaKey: 'rafael',
    categoryKey: 'internet_telefone',
    name: 'Internet Fibra Vivo 600 Mega',
    paymentMethodKey: 'rafael_nubank_card',
    baseAmount: 100,
    variancePct: 0,
    dueDay: 8,
    startMonthsAgo: -14,
    frequency: 'monthly',
  },
  {
    key: 'rafael_celular_vivo',
    personaKey: 'rafael',
    categoryKey: 'internet_telefone',
    name: 'Plano Celular Vivo Pós 66GB',
    paymentMethodKey: 'rafael_nubank_card',
    baseAmount: 140,
    variancePct: 0,
    dueDay: 8,
    startMonthsAgo: -14,
    frequency: 'monthly',
  },
  {
    key: 'rafael_celular_juliana',
    personaKey: 'rafael',
    categoryKey: 'internet_telefone',
    name: 'Plano Celular Claro Pós 70GB (Juliana)',
    paymentMethodKey: 'rafael_nubank_card',
    baseAmount: 119.9,
    variancePct: 0,
    dueDay: 8,
    startMonthsAgo: -14,
    frequency: 'monthly',
  },
  {
    key: 'rafael_escola_pedro',
    personaKey: 'rafael',
    categoryKey: 'educacao',
    name: 'Mensalidade Escola Colégio Objetivo (Pedro)',
    paymentMethodKey: 'rafael_itau_cc',
    baseAmount: 1850,
    variancePct: 0,
    seasonalPeaks: [{ month: 1, multiplier: 1.6 }],
    dueDay: 10,
    startMonthsAgo: -14,
    frequency: 'monthly',
  },
  {
    key: 'rafael_plano_saude',
    personaKey: 'rafael',
    categoryKey: 'saude',
    name: 'Plano de Saúde SulAmérica Família',
    paymentMethodKey: 'rafael_itau_cc',
    baseAmount: 2380,
    variancePct: 0,
    seasonalPeaks: [{ month: 5, multiplier: 1.12 }],
    dueDay: 12,
    startMonthsAgo: -14,
    frequency: 'monthly',
  },
  {
    key: 'rafael_academia',
    personaKey: 'rafael',
    categoryKey: 'lazer',
    name: 'Academia Smart Fit Black',
    paymentMethodKey: 'rafael_nubank_card',
    baseAmount: 159.9,
    variancePct: 0,
    dueDay: 5,
    startMonthsAgo: -14,
    frequency: 'monthly',
  },
];

export const marinaFixedCharges: FixedCharge[] = [
  {
    key: 'marina_aluguel',
    personaKey: 'marina',
    categoryKey: 'moradia',
    name: 'Aluguel Apartamento Vila Madalena',
    paymentMethodKey: 'marina_inter_cc',
    baseAmount: 2200,
    variancePct: 0,
    dueDay: 5,
    startMonthsAgo: -3,
    frequency: 'monthly',
  },
  {
    key: 'marina_energia',
    personaKey: 'marina',
    categoryKey: 'energia',
    name: 'Energia Elétrica Enel SP',
    paymentMethodKey: 'marina_inter_cc',
    baseAmount: 130,
    variancePct: 0.25,
    seasonalPeaks: [{ month: 1, multiplier: 1.3 }],
    dueDay: 18,
    startMonthsAgo: -3,
    frequency: 'monthly',
  },
  {
    key: 'marina_internet',
    personaKey: 'marina',
    categoryKey: 'internet_telefone',
    name: 'Internet Fibra Claro 350 Mega',
    paymentMethodKey: 'marina_inter_card',
    baseAmount: 79.9,
    variancePct: 0,
    dueDay: 12,
    startMonthsAgo: -3,
    frequency: 'monthly',
  },
  {
    key: 'marina_celular',
    personaKey: 'marina',
    categoryKey: 'internet_telefone',
    name: 'Plano Celular TIM Black A Express 67GB',
    paymentMethodKey: 'marina_inter_card',
    baseAmount: 119.9,
    variancePct: 0,
    dueDay: 12,
    startMonthsAgo: -3,
    frequency: 'monthly',
  },
];

// ============================================================================
// SUBSCRIPTIONS (valores REAIS pesquisados em jul/2026 — ver README)
// ============================================================================

export const subscriptions: Subscription[] = [
  // --- Rafael: 10 assinaturas distribuídas nos 3 cartões ---
  {
    key: 'rafael_sub_netflix',
    personaKey: 'rafael',
    cardKey: 'rafael_nubank_card',
    service: 'Netflix',
    plan: 'Padrão com anúncios',
    amount: 20.9,
    billingDay: 3,
    startMonthsAgo: -14,
    active: true,
    sourceNote: 'oficinadanet/portal N10, jul/2026',
  },
  {
    key: 'rafael_sub_spotify',
    personaKey: 'rafael',
    cardKey: 'rafael_nubank_card',
    service: 'Spotify',
    plan: 'Premium Family',
    amount: 40.9,
    billingDay: 7,
    startMonthsAgo: -14,
    active: true,
    sourceNote: 'oficinadanet/tecnoblog, jul/2026',
  },
  {
    key: 'rafael_sub_amazon_prime',
    personaKey: 'rafael',
    cardKey: 'rafael_itau_card',
    service: 'Amazon Prime',
    plan: 'Prime Video Premium (2 telas)',
    amount: 44.9,
    billingDay: 15,
    startMonthsAgo: -14,
    active: true,
    sourceNote: 'portal N10, jul/2026',
  },
  {
    key: 'rafael_sub_disney',
    personaKey: 'rafael',
    cardKey: 'rafael_itau_card',
    service: 'Disney+',
    plan: 'Padrão',
    amount: 46.9,
    billingDay: 15,
    startMonthsAgo: -14,
    active: true,
    sourceNote: 'X/Portal Box Office, abr/2026',
  },
  {
    key: 'rafael_sub_hbo_max',
    personaKey: 'rafael',
    cardKey: 'rafael_itau_card',
    service: 'HBO Max',
    plan: 'Básico com anúncios',
    amount: 29.9,
    billingDay: 15,
    startMonthsAgo: -12,
    active: true,
    sourceNote: 'oficinadanet, jul/2026',
  },
  {
    key: 'rafael_sub_icloud',
    personaKey: 'rafael',
    cardKey: 'rafael_nubank_card',
    service: 'iCloud+',
    plan: '200GB',
    amount: 10.9,
    billingDay: 20,
    startMonthsAgo: -14,
    active: true,
    sourceNote: 'icloud.com.br, jul/2026',
  },
  {
    key: 'rafael_sub_google_one',
    personaKey: 'rafael',
    cardKey: 'rafael_xp_card',
    service: 'Google One',
    plan: '200GB Padrão',
    amount: 14.99,
    billingDay: 22,
    startMonthsAgo: -14,
    active: true,
    sourceNote: 'one.google.com, abr/2026',
  },
  {
    key: 'rafael_sub_youtube_premium',
    personaKey: 'rafael',
    cardKey: 'rafael_xp_card',
    service: 'YouTube Premium',
    plan: 'Família',
    amount: 47.9,
    billingDay: 22,
    startMonthsAgo: -14,
    active: true,
    sourceNote: 'youtube.com/premium, jul/2026',
  },
  {
    key: 'rafael_sub_amazon_music',
    personaKey: 'rafael',
    cardKey: 'rafael_xp_card',
    service: 'Kindle Unlimited',
    plan: 'Individual',
    amount: 19.9,
    billingDay: 22,
    startMonthsAgo: -10,
    active: true,
    sourceNote: 'amazon.com.br, jul/2026',
  },
  {
    key: 'rafael_sub_paramount',
    personaKey: 'rafael',
    cardKey: 'rafael_itau_card',
    service: 'Paramount+',
    plan: 'Standard',
    amount: 44.9,
    billingDay: 15,
    startMonthsAgo: -8,
    active: false,
    cancelMonthsAgo: -2,
    sourceNote: 'X/Portal Box Office, abr/2026 — cancelado no app após teste',
  },

  // --- Marina: 3 assinaturas (perfil enxuto, autônoma) ---
  {
    key: 'marina_sub_spotify',
    personaKey: 'marina',
    cardKey: 'marina_inter_card',
    service: 'Spotify',
    plan: 'Premium Individual',
    amount: 23.9,
    billingDay: 9,
    startMonthsAgo: -3,
    active: true,
    sourceNote: 'oficinadanet, jul/2026',
  },
  {
    key: 'marina_sub_netflix',
    personaKey: 'marina',
    cardKey: 'marina_inter_card',
    service: 'Netflix',
    plan: 'Padrão com anúncios',
    amount: 20.9,
    billingDay: 9,
    startMonthsAgo: -3,
    active: true,
    sourceNote: 'oficinadanet/portal N10, jul/2026',
  },
  {
    key: 'marina_sub_canva',
    personaKey: 'marina',
    cardKey: 'marina_inter_card',
    service: 'Canva Pro',
    plan: 'Individual',
    amount: 34.9,
    billingDay: 14,
    startMonthsAgo: -3,
    active: true,
    sourceNote: 'canva.com/pricing BR, jul/2026',
  },
];

// ============================================================================
// INSTALLMENT PURCHASES (10 compras parceladas do Rafael)
// ============================================================================

export const installmentPurchases: InstallmentPurchase[] = [
  {
    key: 'rafael_inst_geladeira',
    personaKey: 'rafael',
    cardKey: 'rafael_itau_card',
    merchant: 'Magazine Luiza',
    description: 'Geladeira Frost Free Brastemp 375L',
    categoryKey: 'casa_manutencao',
    totalAmount: 4299.9,
    installments: 10,
    installmentAmount: 430,
    startMonthsAgo: -13,
  },
  {
    key: 'rafael_inst_notebook',
    personaKey: 'rafael',
    cardKey: 'rafael_xp_card',
    merchant: 'Amazon.com.br',
    description: 'Notebook Dell Inspiron 16" i7 16GB',
    categoryKey: 'casa_manutencao',
    totalAmount: 5988,
    installments: 12,
    installmentAmount: 499,
    startMonthsAgo: -11,
  },
  {
    key: 'rafael_inst_passagens_ferias',
    personaKey: 'rafael',
    cardKey: 'rafael_itau_card',
    merchant: 'LATAM Airlines',
    description: 'Passagens aéreas férias família — Fortaleza',
    categoryKey: 'viagem',
    totalAmount: 3600,
    installments: 6,
    installmentAmount: 600,
    startMonthsAgo: -8,
  },
  {
    key: 'rafael_inst_roupas_inverno',
    personaKey: 'rafael',
    cardKey: 'rafael_nubank_card',
    merchant: 'Renner',
    description: 'Roupas de inverno família',
    categoryKey: 'vestuario',
    totalAmount: 897,
    installments: 3,
    installmentAmount: 299,
    startMonthsAgo: -13,
  },
  {
    key: 'rafael_inst_smart_tv',
    personaKey: 'rafael',
    cardKey: 'rafael_itau_card',
    merchant: 'Fast Shop',
    description: 'Smart TV LG 55" 4K OLED',
    categoryKey: 'casa_manutencao',
    totalAmount: 4788,
    installments: 12,
    installmentAmount: 399,
    startMonthsAgo: -9,
  },
  {
    key: 'rafael_inst_bicicleta_pedro',
    personaKey: 'rafael',
    cardKey: 'rafael_nubank_card',
    merchant: 'Decathlon',
    description: 'Bicicleta infantil aro 20 (Pedro)',
    categoryKey: 'lazer',
    totalAmount: 897,
    installments: 3,
    installmentAmount: 299,
    startMonthsAgo: -6,
  },
  {
    key: 'rafael_inst_maquina_lavar',
    personaKey: 'rafael',
    cardKey: 'rafael_itau_card',
    merchant: 'Magazine Luiza',
    description: 'Máquina de Lavar Electrolux 13kg',
    categoryKey: 'casa_manutencao',
    totalAmount: 2990,
    installments: 10,
    installmentAmount: 299,
    startMonthsAgo: -5,
  },
  {
    key: 'rafael_inst_celular_juliana',
    personaKey: 'rafael',
    cardKey: 'rafael_xp_card',
    merchant: 'Amazon.com.br',
    description: 'iPhone 15 (upgrade Juliana)',
    categoryKey: 'outros',
    totalAmount: 4788,
    installments: 12,
    installmentAmount: 399,
    startMonthsAgo: -4,
  },
  {
    key: 'rafael_inst_moveis_escritorio',
    personaKey: 'rafael',
    cardKey: 'rafael_nubank_card',
    merchant: 'Amazon.com.br',
    description: 'Móveis escritório home-office (mesa + cadeira ergonômica)',
    categoryKey: 'casa_manutencao',
    totalAmount: 2394,
    installments: 6,
    installmentAmount: 399,
    startMonthsAgo: -3,
  },
  {
    key: 'rafael_inst_presentes_natal',
    personaKey: 'rafael',
    cardKey: 'rafael_itau_card',
    merchant: 'Renner',
    description: 'Presentes de Natal família estendida',
    categoryKey: 'presentes',
    totalAmount: 1194,
    installments: 3,
    installmentAmount: 398,
    startMonthsAgo: -7,
  },
  {
    key: 'rafael_inst_tenis_corrida',
    personaKey: 'rafael',
    cardKey: 'rafael_nubank_card',
    merchant: 'Decathlon',
    description: 'Tênis de corrida + equipamentos academia',
    categoryKey: 'vestuario',
    totalAmount: 897,
    installments: 3,
    installmentAmount: 299,
    startMonthsAgo: -2,
  },
];

// ============================================================================
// VARIABLE SPENDING PROFILES (por categoria, com sazonalidade civil jan-dez)
// ============================================================================

export const variableSpending: VariableSpendingProfile[] = [
  // --- Rafael ---
  {
    categoryKey: 'mercado',
    personaKey: 'rafael',
    minMonthly: 1600,
    maxMonthly: 2100,
    seasonality: [
      { month: 1, multiplier: 1.1 },
      { month: 12, multiplier: 1.4 },
      { month: 11, multiplier: 1.15 },
    ],
    typicalMerchantKeys: ['pao_de_acucar', 'carrefour', 'hortifruti_natural', 'assai_atacadista'],
  },
  {
    categoryKey: 'restaurantes',
    personaKey: 'rafael',
    minMonthly: 500,
    maxMonthly: 950,
    seasonality: [
      { month: 12, multiplier: 1.5 },
      { month: 6, multiplier: 1.2 },
    ],
    typicalMerchantKeys: ['ifood', 'rappi', 'outback', 'madero', 'starbucks'],
  },
  {
    categoryKey: 'transporte',
    personaKey: 'rafael',
    minMonthly: 180,
    maxMonthly: 380,
    seasonality: [{ month: 12, multiplier: 1.3 }],
    typicalMerchantKeys: ['uber', '99', 'bilhete_unico', 'estapar'],
  },
  {
    categoryKey: 'combustivel',
    personaKey: 'rafael',
    minMonthly: 450,
    maxMonthly: 650,
    seasonality: [
      { month: 1, multiplier: 1.25 },
      { month: 7, multiplier: 1.15 },
    ],
    typicalMerchantKeys: ['posto_ipiranga', 'posto_shell'],
  },
  {
    categoryKey: 'farmacia',
    personaKey: 'rafael',
    minMonthly: 80,
    maxMonthly: 320,
    seasonality: [
      { month: 6, multiplier: 1.4 },
      { month: 7, multiplier: 1.3 },
    ],
    typicalMerchantKeys: ['drogasil', 'drogaria_sp', 'raia'],
  },
  {
    categoryKey: 'saude',
    personaKey: 'rafael',
    minMonthly: 0,
    maxMonthly: 600,
    seasonality: [{ month: 3, multiplier: 1.5 }],
    typicalMerchantKeys: ['fleury', 'clinica_odonto'],
  },
  {
    categoryKey: 'lazer',
    personaKey: 'rafael',
    minMonthly: 150,
    maxMonthly: 500,
    seasonality: [
      { month: 12, multiplier: 1.6 },
      { month: 7, multiplier: 1.4 },
    ],
    typicalMerchantKeys: ['cinemark', 'ingresso_com', 'steam'],
  },
  {
    categoryKey: 'vestuario',
    personaKey: 'rafael',
    minMonthly: 0,
    maxMonthly: 400,
    seasonality: [
      { month: 11, multiplier: 1.8 },
      { month: 12, multiplier: 1.3 },
    ],
    typicalMerchantKeys: ['renner', 'cea', 'zara', 'decathlon'],
  },
  {
    categoryKey: 'presentes',
    personaKey: 'rafael',
    minMonthly: 0,
    maxMonthly: 300,
    seasonality: [
      { month: 12, multiplier: 4 },
      { month: 5, multiplier: 1.6 },
      { month: 6, multiplier: 1.4 },
    ],
    typicalMerchantKeys: ['imaginarium', 'natura'],
  },
  {
    categoryKey: 'impostos_taxas',
    personaKey: 'rafael',
    minMonthly: 0,
    maxMonthly: 250,
    seasonality: [
      { month: 1, multiplier: 8 },
      { month: 2, multiplier: 10 },
      { month: 3, multiplier: 6 },
    ],
    typicalMerchantKeys: [],
  },
  {
    categoryKey: 'beleza',
    personaKey: 'rafael',
    minMonthly: 60,
    maxMonthly: 220,
    seasonality: [{ month: 12, multiplier: 1.3 }],
    typicalMerchantKeys: ['boticario', 'salao_bertolucci'],
  },
  {
    categoryKey: 'pets',
    personaKey: 'rafael',
    minMonthly: 120,
    maxMonthly: 280,
    seasonality: [{ month: 8, multiplier: 1.5 }],
    typicalMerchantKeys: ['petz', 'cobasi'],
  },
  {
    categoryKey: 'casa_manutencao',
    personaKey: 'rafael',
    minMonthly: 0,
    maxMonthly: 350,
    seasonality: [{ month: 1, multiplier: 1.4 }],
    typicalMerchantKeys: ['magazine_luiza', 'amazon_br'],
  },
  {
    categoryKey: 'outros',
    personaKey: 'rafael',
    minMonthly: 50,
    maxMonthly: 200,
    seasonality: [],
    typicalMerchantKeys: [],
  },

  // --- Marina (autônoma, gastos mais modestos, 4 meses) ---
  {
    categoryKey: 'mercado',
    personaKey: 'marina',
    minMonthly: 550,
    maxMonthly: 750,
    seasonality: [],
    typicalMerchantKeys: ['carrefour', 'hortifruti_natural'],
  },
  {
    categoryKey: 'restaurantes',
    personaKey: 'marina',
    minMonthly: 350,
    maxMonthly: 600,
    seasonality: [],
    typicalMerchantKeys: ['ifood', 'starbucks'],
  },
  {
    categoryKey: 'transporte',
    personaKey: 'marina',
    minMonthly: 200,
    maxMonthly: 350,
    seasonality: [],
    typicalMerchantKeys: ['uber', '99'],
  },
  {
    categoryKey: 'lazer',
    personaKey: 'marina',
    minMonthly: 100,
    maxMonthly: 280,
    seasonality: [],
    typicalMerchantKeys: ['cinemark', 'steam'],
  },
  {
    categoryKey: 'vestuario',
    personaKey: 'marina',
    minMonthly: 0,
    maxMonthly: 250,
    seasonality: [],
    typicalMerchantKeys: ['zara', 'renner'],
  },
  {
    categoryKey: 'beleza',
    personaKey: 'marina',
    minMonthly: 80,
    maxMonthly: 180,
    seasonality: [],
    typicalMerchantKeys: ['sephora', 'boticario'],
  },
];

// ============================================================================
// INCOMES
// ============================================================================

export const incomes: Income[] = [
  {
    key: 'rafael_salario',
    personaKey: 'rafael',
    source: 'Salário CLT — Empresa de Tecnologia',
    recipientName: 'Rafael Almeida',
    baseAmount: 18500,
    day: 5,
    frequency: 'monthly',
    extraPayments: [
      { month: 11, amount: 9250, label: '1ª parcela 13º salário' },
      { month: 12, amount: 9250, label: '2ª parcela 13º salário' },
    ],
    startMonthsAgo: -14,
  },
  {
    key: 'juliana_renda_autonoma',
    personaKey: 'rafael',
    source: 'Renda autônoma — Consultoria de Marketing (Juliana)',
    recipientName: 'Juliana Almeida',
    baseAmount: 4000,
    minAmount: 2800,
    maxAmount: 5200,
    day: 10,
    frequency: 'irregular',
    startMonthsAgo: -14,
  },
  {
    key: 'marina_cliente_agencia',
    personaKey: 'marina',
    source: 'Projeto recorrente — Agência Criativa Bloom',
    recipientName: 'Marina Costa',
    baseAmount: 2800,
    minAmount: 2200,
    maxAmount: 3400,
    day: 8,
    frequency: 'irregular',
    startMonthsAgo: -3,
  },
  {
    key: 'marina_cliente_ecommerce',
    personaKey: 'marina',
    source: 'Freela avulso — Identidade visual e-commerce',
    recipientName: 'Marina Costa',
    baseAmount: 1500,
    minAmount: 900,
    maxAmount: 2200,
    day: 18,
    frequency: 'irregular',
    startMonthsAgo: -3,
  },
  {
    key: 'marina_cliente_pontual',
    personaKey: 'marina',
    source: 'Job pontual — Redesign de logotipo',
    recipientName: 'Marina Costa',
    baseAmount: 800,
    minAmount: 400,
    maxAmount: 1300,
    day: 25,
    frequency: 'irregular',
    startMonthsAgo: -2,
  },
];

// ============================================================================
// ONE-OFF EVENTS (10 eventos pontuais nos 15 meses)
// ============================================================================

export const oneOffEvents: OneOffEvent[] = [
  {
    key: 'evt_ferias_fortaleza',
    personaKey: 'rafael',
    categoryKey: 'viagem',
    description: 'Hospedagem férias em família — Fortaleza (Booking.com)',
    amount: 2850,
    monthsAgo: -8,
    merchantKey: 'booking',
    paymentMethodKey: 'rafael_itau_card',
  },
  {
    key: 'evt_conserto_carro',
    personaKey: 'rafael',
    categoryKey: 'transporte',
    description: 'Revisão + troca de amortecedores — oficina credenciada',
    amount: 1680,
    monthsAgo: -6,
    paymentMethodKey: 'rafael_itau_cc',
  },
  {
    key: 'evt_presente_aniversario_juliana',
    personaKey: 'rafael',
    categoryKey: 'presentes',
    description: 'Presente de aniversário — Juliana',
    amount: 620,
    monthsAgo: -10,
    merchantKey: 'natura',
    paymentMethodKey: 'rafael_nubank_card',
  },
  {
    key: 'evt_consulta_veterinaria',
    personaKey: 'rafael',
    categoryKey: 'pets',
    description: 'Consulta + vacinas anuais — Cobasi Vet',
    amount: 480,
    monthsAgo: -9,
    merchantKey: 'cobasi',
    paymentMethodKey: 'rafael_nubank_card',
  },
  {
    key: 'evt_ipva_carro',
    personaKey: 'rafael',
    categoryKey: 'impostos_taxas',
    description: 'IPVA 2026 — parcela única com desconto',
    amount: 2140,
    monthsAgo: -6,
    paymentMethodKey: 'rafael_itau_cc',
  },
  {
    key: 'evt_iptu_apto',
    personaKey: 'rafael',
    categoryKey: 'impostos_taxas',
    description: 'IPTU 2026 — cota única com desconto',
    amount: 1890,
    monthsAgo: -6,
    paymentMethodKey: 'rafael_itau_cc',
  },
  {
    key: 'evt_material_escolar',
    personaKey: 'rafael',
    categoryKey: 'educacao',
    description: 'Material escolar + uniforme — Pedro (ano letivo)',
    amount: 890,
    monthsAgo: -6,
    paymentMethodKey: 'rafael_nubank_card',
  },
  {
    key: 'evt_black_friday_eletronico',
    personaKey: 'rafael',
    categoryKey: 'casa_manutencao',
    description: 'Fone de ouvido + acessórios — Black Friday',
    amount: 540,
    monthsAgo: -8,
    merchantKey: 'amazon_br',
    paymentMethodKey: 'rafael_xp_card',
  },
  {
    key: 'evt_ceia_natal',
    personaKey: 'rafael',
    categoryKey: 'mercado',
    description: 'Compras para ceia de Natal e Ano Novo',
    amount: 980,
    monthsAgo: -7,
    merchantKey: 'pao_de_acucar',
    paymentMethodKey: 'rafael_itau_card',
  },
  {
    key: 'evt_reembolso_seguro',
    personaKey: 'rafael',
    categoryKey: 'saude',
    description: 'Reembolso de consulta — SulAmérica',
    amount: 210,
    monthsAgo: -3,
    paymentMethodKey: 'rafael_itau_cc',
    isIncome: true,
  },
  {
    key: 'evt_marina_equipamento_trabalho',
    personaKey: 'marina',
    categoryKey: 'casa_manutencao',
    description: 'Mesa digitalizadora Wacom para trabalho',
    amount: 1290,
    monthsAgo: -2,
    merchantKey: 'amazon_br',
    paymentMethodKey: 'marina_inter_card',
  },
];

// ============================================================================
// LOANS (financiamento de carro + empréstimo familiar concedido)
// ============================================================================

export const loanPlans: LoanInstallmentPlan[] = [
  {
    key: 'rafael_financiamento_carro',
    personaKey: 'rafael',
    loanType: 'financing',
    counterparty: 'Banco Itaú Veículos',
    description: 'Financiamento Honda Civic 2024 (CDC 48x)',
    principal: 96000,
    installments: 48,
    installmentAmount: 2350,
    interestIncluded: true,
    startMonthsAgo: -20, // financiamento iniciado 20 meses atrás; 20 parcelas pagas até o mês corrente (paidInstallments=20)
    paidInstallments: 20,
    paymentMethodKey: 'rafael_itau_cc',
    dueDay: 18,
  },
  {
    key: 'rafael_emprestimo_bruno',
    personaKey: 'rafael',
    loanType: 'family_loan_granted',
    counterparty: 'Bruno Almeida (irmão)',
    description: 'Empréstimo familiar concedido ao irmão — reforma de apartamento',
    principal: 6000,
    installments: 12,
    installmentAmount: 500,
    interestIncluded: false,
    startMonthsAgo: -8,
    paidInstallments: 8,
    paymentMethodKey: 'rafael_itau_cc',
    dueDay: 15,
  },
];

// ============================================================================
// DATASET RAIZ
// ============================================================================

export const dataset = {
  categories,
  merchants,
  personas,
  fixedCharges: [...rafaelFixedCharges, ...marinaFixedCharges],
  subscriptions,
  installmentPurchases,
  variableSpending,
  incomes,
  oneOffEvents,
  loanPlans,
} as const;

export type Dataset = typeof dataset;

export default dataset;
