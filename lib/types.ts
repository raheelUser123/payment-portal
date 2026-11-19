export type Role = "admin" | "seller";

/** public.users — profile + role; id = auth.users.id (Supabase Auth owns password, 2FA, sessions). */
export type UserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  department_id: string | null;
  is_active: boolean;
  failed_login_count: number;
  locked_until: Date | null;
  password_changed_at: Date;
  must_change_password: boolean;
  last_login_at: Date | null;
  last_login_ip: string | null;
  created_at: Date;
};

/** UserRow plus whether a verified Supabase TOTP factor exists. */
export type SafeUser = UserRow & { totp_enabled: boolean };

export type BrandRow = {
  id: string;
  name: string;
  slug: string;
  pay_domain: string | null;
  pay_domain_verified_at: Date | null;
  website_url: string | null;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
  support_email: string | null;
  support_phone: string | null;
  address: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  bcc_email: string | null;
  email_provider: "smtp" | "none";
  email_config_enc: string | null;
  statement_descriptor_suffix: string | null;
  invoice_prefix: string;
  default_currency: string;
  terms_url: string | null;
  privacy_url: string | null;
  footer_text: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

export type Provider = "stripe" | "paypal" | "authorize_net" | "square";

export type MerchantRow = {
  id: string;
  name: string;
  provider: Provider;
  mode: "test" | "live";
  status: "active" | "paused" | "disabled";
  credentials_enc: string;
  public_config: Record<string, unknown>;
  credential_hint: string | null;
  supported_currencies: string[];
  per_txn_limit_minor: number | null;
  monthly_limit_minor: number | null;
  notes: string | null;
  last_verified_at: Date | null;
  created_at: Date;
};

export type InvoiceStatus = "draft" | "open" | "paid" | "partially_refunded" | "refunded" | "void" | "uncollectible";

export type InvoiceRow = {
  id: string;
  number: string;
  brand_id: string;
  customer_id: string;
  merchant_id: string | null;
  department_id: string | null;
  created_by: string | null;
  currency: string;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  amount_paid_minor: number;
  amount_refunded_minor: number;
  status: InvoiceStatus;
  title: string | null;
  memo: string | null;
  due_date: Date | null;
  token_hash: string;
  token_enc: string;
  token_expires_at: Date | null;
  sent_at: Date | null;
  last_reminder_at: Date | null;
  reminder_count: number;
  viewed_at: Date | null;
  view_count: number;
  paid_at: Date | null;
  voided_at: Date | null;
  review_status: "pending" | "approved" | "flagged";
  review_note: string | null;
  created_at: Date;
};

export type PaymentStatus =
  | "pending" | "processing" | "succeeded" | "failed" | "canceled" | "refunded" | "partially_refunded" | "disputed";

export type PaymentRow = {
  id: string;
  invoice_id: string;
  brand_id: string;
  merchant_id: string;
  provider: Provider;
  provider_payment_id: string | null;
  provider_charge_id: string | null;
  amount_minor: number;
  amount_refunded_minor: number;
  currency: string;
  status: PaymentStatus;
  failure_code: string | null;
  failure_message: string | null;
  payment_method_type: string | null;
  card_brand: string | null;
  card_last4: string | null;
  card_country: string | null;
  payer_name: string | null;
  payer_email: string | null;
  ip: string | null;
  risk_level: string | null;
  risk_score: number | null;
  review_status: "pending" | "approved" | "flagged";
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  succeeded_at: Date | null;
  created_at: Date;
};

export type CustomerRow = {
  id: string;
  brand_id: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  address: string | null;
  notes: string | null;
  created_at: Date;
};
