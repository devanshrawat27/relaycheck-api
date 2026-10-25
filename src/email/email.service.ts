import { Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';

/**
 * Sends outbound email (verification, password reset) via SMTP. When no SMTP
 * host is configured the service logs the message instead of failing, so the
 * local-first flow keeps working without a mail server.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: Transporter | null;

  constructor() {
    const host = process.env.SMTP_HOST;
    if (host) {
      this.transporter = createTransport({
        host,
        port: Number(process.env.SMTP_PORT ?? 25),
        secure: process.env.SMTP_SECURE === 'true',
        auth:
          process.env.SMTP_USER && process.env.SMTP_PASS
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
      });
    } else {
      this.transporter = null;
    }
  }

  async send(to: string, subject: string, text: string, html?: string): Promise<void> {
    const from = process.env.EMAIL_FROM ?? 'RelayCheck <no-reply@relaycheck.local>';

    if (!this.transporter) {
      this.logger.log(`[email] (smtp unconfigured) to=${to} subject="${subject}"`);
      this.logger.log(`[email] body=${text}`);
      return;
    }

    try {
      await this.transporter.sendMail({ from, to, subject, text, html });
    } catch (error) {
      this.logger.warn(`[email] failed to send to ${to}: ${String(error)}`);
    }
  }
}
