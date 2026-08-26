/**
 * Pluggable WhatsApp delivery, same shape as `auth/otp-sender.ts`. No
 * real WhatsApp Business API account exists yet (Section 14 — the
 * owner's to set up; provider credentials to follow). This dev sender
 * just logs the exact message that would go out, so the "send bill via
 * WhatsApp" flow is testable end-to-end without one. Swap the
 * implementation behind `WHATSAPP_PROVIDER`, not the call sites, once a
 * real provider (Meta Cloud API / Twilio / Gupshup, etc.) is chosen and
 * credentialed. A real provider will also need a pre-approved message
 * template — WhatsApp doesn't allow free-form business-initiated text
 * outside a customer-service window — so the text this build sends is a
 * placeholder shape, not a final approved template body.
 *
 * Logger is a minimal structural type, not Fastify's `FastifyBaseLogger`
 * directly — the M8 dispatcher (`domain/notifications.ts`) calls this
 * from a background interval loop with no request in scope, not only
 * from route handlers with `req.log`.
 */
export interface MinimalLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface WhatsAppMessage {
  phone: string;
  text: string;
}

export interface WhatsAppSendResult {
  status: "sent" | "logged_dev_mode";
  providerMessageId: string | null;
}

export interface WhatsAppSender {
  send(message: WhatsAppMessage): Promise<WhatsAppSendResult>;
}

export class ConsoleWhatsAppSender implements WhatsAppSender {
  constructor(private readonly log: MinimalLogger) {}

  async send(message: WhatsAppMessage): Promise<WhatsAppSendResult> {
    this.log.warn(
      { phone: message.phone, text: message.text },
      "DEV WHATSAPP SENDER: no real provider configured — logging message instead of sending it"
    );
    return { status: "logged_dev_mode", providerMessageId: null };
  }
}

export function createWhatsAppSender(provider: string, log: MinimalLogger): WhatsAppSender {
  // Only "console" exists today. Add a real branch here (reading its own
  // provider-specific env vars from config.ts) once credentials exist —
  // the call sites (routes/sales.ts) never need to change. An unknown
  // provider name falls back to the console sender rather than crashing
  // the API, with a loud warning so a typo'd env var is still noticed.
  if (provider !== "console") {
    log.warn({ provider }, "WHATSAPP_PROVIDER set to an unimplemented provider — falling back to the console sender");
  }
  return new ConsoleWhatsAppSender(log);
}
