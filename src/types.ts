export interface Company {
  id: number;
  chamber_slug: string;
  name: string;
  name_key: string;
  website: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  linkedin: string | null;
  category: string | null;
  review_status: "new" | "approved" | "rejected";
  scraped_at: string;
}

export interface EmailCandidate {
  id: number;
  company_id: number;
  address: string;
  source: "mailto" | "contact_page" | "manual" | "pattern";
  confidence: number;
  is_primary: 0 | 1;
}

export type SendStatus = "queued" | "sent" | "failed" | "bounced" | "skipped";

export interface Send {
  id: number;
  company_id: number;
  email_address: string;
  subject: string;
  body: string;
  channel: "gmail" | "form";
  status: SendStatus;
  gmail_message_id: string | null;
  error: string | null;
  attempts: number;
  queued_at: string;
  sent_at: string | null;
}

/** Merge fields available to templates. Extend here, not in render.ts. */
export interface MergeContext {
  company: string;
  city: string;
  state: string;
  website: string;
  sender_name: string;
  unsubscribe: string;
}
