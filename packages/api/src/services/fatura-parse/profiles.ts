export type FaturaProfile = {
  id: string;
  label: string;
  hints: string;
};

const GENERIC_PROFILE = {
  id: 'generic',
  label: 'Outro emissor',
  hints:
    'Identifique vencimento e total no resumo. Extraia somente lançamentos que formam esta fatura. Reconcilie pagamentos com o saldo anterior conforme a regra compartilhada; ignore apenas a parte que quita a fatura anterior, além de limites, simulações, boleto e previsões futuras.',
} as const satisfies FaturaProfile;

const DM_PROFILE_HINTS =
  'O PDF pode não ter camada de texto. Renderize visualmente as páginas. Use a página 1 para Data de vencimento e Total da fatura. Os lançamentos ficam na tabela Transações da página 5: agrupe pelo cartão final NNNN, use Data, Descrição e Valor e extraia todas as cobranças que formam Total a pagar do cartão. Ignore FATURA ANTERIOR; em PAGAMENTOS EFETUADOS, aplique a reconciliação com o saldo anterior e preserve eventual excedente como estorno. Em descrições COMPRA NO PAR (k/n)/..., extraia k/n e preserve somente o estabelecimento. Inclua ANUIDADE DM, SMS ALERTA, CARTAO E VIDA e outras tarifas cobradas. Ignore opções de pagamento, boletos e o resumo de compras futuras.';

export const FATURA_PROFILES = [
  {
    id: 'itau',
    label: 'Itaú (Azul, The One, Samsung)',
    hints:
      'Use o vencimento e total do resumo. Agrupe blocos NOME (final NNNN), incluindo virtuais e adicionais. Reconcilie pagamentos com o saldo anterior e ignore somente a parte usada para quitá-lo; ignore próximas faturas, simulações, limites e boleto. Parcelas podem estar coladas ao nome; créditos têm sinal negativo.',
  },
  {
    id: 'nubank',
    label: 'Nubank',
    hints:
      'Leia Data de vencimento e Total a pagar. Preserve os últimos quatro de cada linha. Reconcilie pagamentos com a fatura anterior e inclua eventual excedente como estorno; ignore a fatura anterior e próximas faturas, mas inclua Parcelamento de Compra cobrado no mês.',
  },
  {
    id: 'c6',
    label: 'C6 Bank',
    hints:
      'Use a data de vencimento do resumo, não a do boleto. Separe cartão principal e adicionais por header. Estorno é crédito; em Inclusao de Pagamento, ignore somente o valor alocado ao saldo anterior e preserve eventual excedente como estorno. Não duplique anuidade do resumo.',
  },
  {
    id: 'mercadopago',
    label: 'Mercado Pago',
    hints:
      'Use Vence em e Total a pagar. Extraia Detalhes de consumo por cartão. Em Pagamento da fatura, ignore somente a parte que quita o saldo anterior e preserve eventual excedente como estorno. Inclua Crédito concedido como estorno com isRefund=true e amountBRL positivo, no cartão a que o crédito se refere. Parcela usa k de n; não deduplique parcelas repetidas da mesma compra.',
  },
  {
    id: 'santander',
    label: 'Santander',
    hints:
      'PDF pode ser escaneado e começar com marketing. Use tiles Total a Pagar e Vencimento. No Resumo da Fatura, obtenha Saldo Anterior, Total de pagamentos e Total de créditos. Reconcilie cada PAGAMENTO DE FATURA-INTERNET com o Saldo Anterior: ignore a parte que quita a fatura anterior e inclua qualquer excedente que reduz a fatura atual com isRefund=true e amountBRL positivo. Extraia compras, parcelas e encargos efetivamente cobrados; ignore opções e boleto.',
  },
  {
    id: 'picpay',
    label: 'PicPay',
    hints:
      'PDF pode ser escaneado em duas colunas. Use Vencimento com traços e Total da sua fatura. Agrupe por Picpay Card final NNNN. Reconcilie PAGAMENTO DE FATURA com o saldo anterior e preserve eventual excedente como estorno; ignore próximas faturas.',
  },
  {
    id: 'renner',
    label: 'Renner (Meu Cartão / Realize)',
    hints:
      'Use Data de Vencimento e Pagamento Total. Datas das linhas são da compra original. Ignore compras parceladas de próximas faturas; parcela atual usa Parc k/n.',
  },
  {
    id: 'riachuelo',
    label: 'Riachuelo (Midway)',
    hints:
      'A primeira página pode estar desenhada como vetores, sem texto ou imagens extraíveis, e parecer vazia para um leitor de PDF. Renderize obrigatoriamente a página 1 como imagem e faça leitura visual/OCR. No cabeçalho Fatura mensal, use Vencimento, Saldo à Pagar, Titular e os últimos dígitos de Cartão. Em Histórico de Despesas, extraia TODAS as linhas cobradas: use Data como purchaseDate, Loja Descrição como description, Nº parc. como installmentCurrent/installmentTotal e Lançamento do mês como amountBRL; Valor original não é o valor da parcela. Continue depois de SUBTOTAL: reconcilie PAGAMENTO com o saldo anterior e preserve eventual excedente como estorno; inclua ANUIDADE e demais encargos. Ignore Próxima Fatura, Total a vencer, simulações de parcelamento e boleto. A soma do SUBTOTAL com anuidade/encargos e estornos deve fechar com Saldo à Pagar.',
  },
  {
    id: 'bistek',
    label: 'Bistek / DM',
    hints: DM_PROFILE_HINTS,
  },
  {
    id: 'dm',
    label: 'DM Visa',
    hints: DM_PROFILE_HINTS,
  },
  {
    id: 'leroy-merlin',
    label: 'Leroy Merlin Pay',
    hints:
      'O PDF é visual e pode não ter camada de texto. Ignore a página 1 de opções de parcelamento e renderize a página 2 em alta resolução. Use VENCIMENTO e VALOR TOTAL FATURA no topo. Extraia todas as cobranças do DEMONSTRATIVO, agrupadas pelo cabeçalho de titular/cartão. Na coluna CRÉDITO/DÉBITO R$, valores de compras cobradas terminam com sinal final - e NÃO são estornos. Use Total da Fatura Anterior para reconciliar todas as linhas PAGAMENTO FATURA PIX RECEBIMENTO_DE_FA: ignore o valor que quita a fatura anterior e inclua qualquer excedente que reduz a fatura atual com isRefund=true e amountBRL positivo. Extraia marcadores PARC.k/n e inclua ANUIDADE DIFERENCIADA - PARCELA k/n. Ignore encargos apenas informativos, boleto e publicidade.',
  },
  {
    id: 'carrefour',
    label: 'Carrefour',
    hints:
      'O PDF é escaneado. Ignore a publicidade da página 1, renderize as páginas 2 e 3 em alta resolução e não retorne items vazio. Use VENCIMENTO da página 2 e TOTAL DA FATURA ATUAL da página 3. Em LANÇAMENTOS NO BRASIL, ignore SALDO FATURA ANTERIOR; reconcilie Pagamento de Fatura via PIX com esse saldo e preserve eventual excedente como estorno. Crie um card para cada bloco: o cartão do titular final NNNN e CARTAO VIRTUAL final NNNN; cartão virtual do mesmo titular não é adicional. Extraia sufixos -k/n como parcelas, inclusive ANUIDADE DIFERENCIADA - k/n. Datas sem ano usam o ano original coerente com a parcela e o vencimento. A soma de todos os blocos deve fechar com TOTAL DA FATURA.',
  },
  {
    id: 'bradescard',
    label: 'Bradescard (Amazon)',
    hints:
      'Use Vencimento e Total da fatura. Parcelas aparecem como (kk/nn). Valores de crédito podem ter sinal negativo no final. Ignore total parcelado para próximas faturas.',
  },
  {
    id: 'brb',
    label: 'BRB',
    hints:
      'Vencimento pode estar concatenado ao total. Separe blocos por plástico e portador. Na seção Lançamentos, inclua TODAS as linhas entre cada cabeçalho de cartão e o respectivo Subtotal, inclusive Anuidade e compras cuja data impressa seja posterior ao vencimento — no BRB essa pode ser a data original da compra parcelada, não uma próxima fatura. Sinais de crédito podem vir no final. Reconcilie OBRIGADO PELO PAGAMENTO com o saldo anterior e preserve eventual excedente como estorno; ignore boleto.',
  },
  {
    id: 'zaffari',
    label: 'Zaffari / Bourbon Card',
    hints:
      'A fonte pode ser ofuscada. Use as colunas Crédito e Débito corretamente, reconcilie Pagamento na coluna crédito com o saldo anterior e preserve eventual excedente como estorno, mantenha tabelas que continuam entre páginas e agrupe por titular.',
  },
  GENERIC_PROFILE,
] as const satisfies readonly FaturaProfile[];

export const FATURA_PROFILE_IDS = FATURA_PROFILES.map((profile) => profile.id);

export function getFaturaProfile(id: string | null | undefined): FaturaProfile {
  return FATURA_PROFILES.find((profile) => profile.id === id) ?? GENERIC_PROFILE;
}
