import type { FastifyBaseLogger } from "fastify";

/**
 * Pluggable OTP delivery. No real SMS/WhatsApp Business account exists
 * yet (Section 14 — the owner's to set up, wired properly in M8). This
 * dev sender just logs the code so the auth flow is testable end-to-end
 * without one. Swap the implementation, not the call sites, once a real
 * provider is ready.
 */
export interface OtpSender {
  send(phone: string, code: string): Promise<void>;
}

export class ConsoleOtpSender implements OtpSender {
  constructor(private readonly log: FastifyBaseLogger) {}

  async send(phone: string, code: string): Promise<void> {
    this.log.warn({ phone, code }, "DEV OTP SENDER: no real SMS/WhatsApp provider configured — logging code instead of sending it");
  }
}
