-- V2 Schema Creation Script
CREATE TYPE account_type AS ENUM ('checking','savings','investment','credit_card','loan','personal_debt','expense','revenue','family_loan');
CREATE TYPE transaction_type AS ENUM ('withdrawal','deposit','transfer');
CREATE TYPE frequency AS ENUM ('once','weekly','biweekly','monthly','bimonthly','quarterly','semiannual','annual');
CREATE TYPE category_type AS ENUM ('expense','revenue','transfer');
CREATE TYPE share_permission AS ENUM ('view','edit');
CREATE TYPE month_status AS ENUM ('open','review','closed');
CREATE TYPE loan_category AS ENUM ('bank','personal');
CREATE TYPE loan_type AS ENUM ('consignado','pessoal','veiculo','imobiliario');
CREATE TYPE payoff_calculation_type AS ENUM ('consignado_mensal','pessoal_diario','cdc_veiculos','sem_desconto');
CREATE TYPE income_frequency AS ENUM ('monthly','biweekly','weekly','annual','one_time');
CREATE TYPE income_category AS ENUM ('salary_clt','salary_pj','contractor','rental','investment','freelance','business','other');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  type account_type NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'BRL',
  current_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  icon VARCHAR(50),
  color VARCHAR(20),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  overdraft_limit NUMERIC(12,2),
  cdi_percentage NUMERIC(6,2),
  parent_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX accounts_user_idx ON accounts(user_id);
CREATE INDEX accounts_user_active_idx ON accounts(user_id, is_active);
CREATE INDEX accounts_user_type_idx ON accounts(user_id, type);
CREATE INDEX accounts_parent_idx ON accounts(parent_account_id);

CREATE TABLE account_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shared_with_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission share_permission NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, shared_with_user_id)
);

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  type category_type NOT NULL,
  parent_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  icon VARCHAR(50),
  color VARCHAR(20),
  is_system BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, name)
);
CREATE INDEX categories_user_idx ON categories(user_id);

CREATE TABLE scheduled_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_account_id UUID NOT NULL REFERENCES accounts(id),
  destination_account_id UUID NOT NULL REFERENCES accounts(id),
  amount NUMERIC(12,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'BRL',
  description VARCHAR(500) NOT NULL,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  frequency frequency NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  due_day INTEGER,
  total_occurrences INTEGER,
  starting_occurrence INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  domain_type VARCHAR(50),
  domain_config_id UUID,
  is_fixed_charge BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX st_user_idx ON scheduled_transactions(user_id);
CREATE INDEX st_user_active_idx ON scheduled_transactions(user_id, is_active);
CREATE INDEX st_domain_idx ON scheduled_transactions(domain_type, domain_config_id);
CREATE INDEX st_source_idx ON scheduled_transactions(source_account_id);
CREATE INDEX st_dest_idx ON scheduled_transactions(destination_account_id);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_account_id UUID NOT NULL REFERENCES accounts(id),
  destination_account_id UUID NOT NULL REFERENCES accounts(id),
  amount NUMERIC(12,2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'BRL',
  type transaction_type NOT NULL,
  description VARCHAR(500) NOT NULL,
  date DATE NOT NULL,
  notes TEXT,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  billing_month INTEGER,
  billing_year INTEGER,
  installment_number INTEGER,
  total_installments INTEGER,
  is_paid BOOLEAN NOT NULL DEFAULT false,
  paid_at TIMESTAMPTZ,
  paid_from_account_id UUID REFERENCES accounts(id),
  is_reversed BOOLEAN NOT NULL DEFAULT false,
  reversed_at TIMESTAMPTZ,
  reversed_by_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  reverses_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  scheduled_transaction_id UUID REFERENCES scheduled_transactions(id) ON DELETE SET NULL,
  domain_type VARCHAR(50),
  exchange_rate NUMERIC(10,6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tx_user_date_idx ON transactions(user_id, date);
CREATE INDEX tx_source_idx ON transactions(source_account_id, date);
CREATE INDEX tx_dest_idx ON transactions(destination_account_id, date);
CREATE INDEX tx_billing_idx ON transactions(destination_account_id, billing_month, billing_year);
CREATE INDEX tx_user_paid_idx ON transactions(user_id, is_paid, date);
CREATE INDEX tx_scheduled_idx ON transactions(scheduled_transaction_id);
CREATE INDEX tx_domain_type_idx ON transactions(domain_type, user_id);
CREATE INDEX tx_user_billing_idx ON transactions(user_id, billing_month, billing_year);

CREATE TABLE credit_card_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  closing_day INTEGER NOT NULL,
  due_day INTEGER NOT NULL,
  credit_limit NUMERIC(12,2),
  bill_parser_type VARCHAR(50),
  is_due_day_variable BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE loan_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  loan_category loan_category NOT NULL,
  loan_type loan_type,
  total_installments INTEGER NOT NULL,
  monthly_payment NUMERIC(12,2) NOT NULL,
  due_day INTEGER NOT NULL,
  monthly_interest_rate NUMERIC(10,8),
  annual_interest_rate NUMERIC(10,8),
  insurance_amount NUMERIC(12,2),
  insurance_payment_day INTEGER,
  payoff_calculation_type payoff_calculation_type,
  principal_amount NUMERIC(12,2),
  original_amount NUMERIC(12,2),
  start_date DATE,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE income_source_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  frequency income_frequency NOT NULL,
  category income_category NOT NULL,
  payment_day INTEGER,
  exchange_rate NUMERIC(10,6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE family_loan_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  person_name VARCHAR(200) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE borrowed_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_loan_config_id UUID NOT NULL REFERENCES family_loan_configs(id) ON DELETE CASCADE,
  credit_card_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  description VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX bc_config_idx ON borrowed_cards(family_loan_config_id);
CREATE INDEX bc_card_idx ON borrowed_cards(credit_card_account_id);

CREATE TABLE month_closings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  status month_status NOT NULL DEFAULT 'open',
  total_income NUMERIC(12,2),
  total_expenses NUMERIC(12,2),
  total_balance NUMERIC(12,2),
  detailed_breakdown JSONB,
  closed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, month, year)
);
