/**
 * Gmail API Module
 * Handles email retrieval and verification code extraction
 */

import { google, gmail_v1 } from 'googleapis';

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  targetEmail?: string;
}

export interface EmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: Date;
  body: string;
  snippet: string;
}

export interface VerificationCodeResult {
  code: string;
  email: EmailMessage;
  extractedAt: Date;
}

export class GmailClient {
  private gmail: gmail_v1.Gmail;
  private config: GmailConfig;

  constructor(config: GmailConfig) {
    this.config = config;

    const oauth2Client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret
    );

    oauth2Client.setCredentials({
      refresh_token: config.refreshToken,
    });

    this.gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  }

  /**
   * List recent emails matching query
   */
  async listEmails(query: string, maxResults = 10): Promise<EmailMessage[]> {
    const response = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    const messages = response.data.messages || [];
    const emails: EmailMessage[] = [];

    for (const msg of messages) {
      if (msg.id) {
        const email = await this.getEmail(msg.id);
        if (email) emails.push(email);
      }
    }

    return emails;
  }

  /**
   * Get single email by ID
   */
  async getEmail(messageId: string): Promise<EmailMessage | null> {
    try {
      const response = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      const message = response.data;
      const headers = message.payload?.headers || [];

      const getHeader = (name: string): string => {
        const header = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
        return header?.value || '';
      };

      // Extract body
      let body = '';
      if (message.payload?.body?.data) {
        body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
      } else if (message.payload?.parts) {
        for (const part of message.payload.parts) {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
            break;
          } else if (part.mimeType === 'text/html' && part.body?.data) {
            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
        }
      }

      return {
        id: message.id!,
        threadId: message.threadId!,
        subject: getHeader('Subject'),
        from: getHeader('From'),
        to: getHeader('To'),
        date: new Date(getHeader('Date')),
        body,
        snippet: message.snippet || '',
      };
    } catch (error) {
      console.error(`Failed to get email ${messageId}:`, error);
      return null;
    }
  }

  /**
   * Wait for email matching criteria
   */
  async waitForEmail(options: {
    to?: string;
    from?: string;
    subject?: string;
    after?: Date;
    timeout?: number;
    pollInterval?: number;
  }): Promise<EmailMessage | null> {
    const {
      to = this.config.targetEmail,
      from,
      subject,
      after = new Date(Date.now() - 5 * 60 * 1000), // Default: last 5 minutes
      timeout = 60000,
      pollInterval = 3000,
    } = options;

    const startTime = Date.now();
    const afterTimestamp = Math.floor(after.getTime() / 1000);

    // Build Gmail query
    const queryParts: string[] = [];
    if (to) queryParts.push(`to:${to}`);
    if (from) queryParts.push(`from:${from}`);
    if (subject) queryParts.push(`subject:(${subject})`);
    queryParts.push(`after:${afterTimestamp}`);

    const query = queryParts.join(' ');
    console.log(`Waiting for email with query: ${query}`);

    while (Date.now() - startTime < timeout) {
      const emails = await this.listEmails(query, 5);

      // Find email that matches all criteria
      const matchingEmail = emails.find(email => {
        if (to && !email.to.toLowerCase().includes(to.toLowerCase())) return false;
        if (from && !email.from.toLowerCase().includes(from.toLowerCase())) return false;
        if (subject && !email.subject.toLowerCase().includes(subject.toLowerCase())) return false;
        if (email.date < after) return false;
        return true;
      });

      if (matchingEmail) {
        console.log(`Found matching email: ${matchingEmail.subject}`);
        return matchingEmail;
      }

      console.log(`No matching email found, waiting ${pollInterval}ms...`);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    console.log(`Timeout: No matching email found within ${timeout}ms`);
    return null;
  }

  /**
   * Extract verification code from email
   */
  extractVerificationCode(email: EmailMessage, pattern?: string | RegExp): string | null {
    const codePattern = pattern
      ? (typeof pattern === 'string' ? new RegExp(pattern) : pattern)
      : /\b(\d{6})\b/; // Default: 6-digit code

    // Search in subject first
    let match = email.subject.match(codePattern);
    if (match) return match[1] || match[0];

    // Then in body
    match = email.body.match(codePattern);
    if (match) return match[1] || match[0];

    // Finally in snippet
    match = email.snippet.match(codePattern);
    if (match) return match[1] || match[0];

    return null;
  }

  /**
   * Get verification code with waiting
   */
  async getVerificationCode(options: {
    to?: string;
    subject?: string;
    codePattern?: string | RegExp;
    timeout?: number;
  }): Promise<VerificationCodeResult | null> {
    const email = await this.waitForEmail({
      to: options.to,
      subject: options.subject,
      timeout: options.timeout,
    });

    if (!email) {
      return null;
    }

    const code = this.extractVerificationCode(email, options.codePattern);

    if (!code) {
      console.log('Email found but no verification code extracted');
      return null;
    }

    return {
      code,
      email,
      extractedAt: new Date(),
    };
  }

  /**
   * Delete email by ID
   */
  async deleteEmail(messageId: string): Promise<boolean> {
    try {
      await this.gmail.users.messages.delete({
        userId: 'me',
        id: messageId,
      });
      return true;
    } catch (error) {
      console.error(`Failed to delete email ${messageId}:`, error);
      return false;
    }
  }

  /**
   * Mark email as read
   */
  async markAsRead(messageId: string): Promise<boolean> {
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          removeLabelIds: ['UNREAD'],
        },
      });
      return true;
    } catch (error) {
      console.error(`Failed to mark email as read ${messageId}:`, error);
      return false;
    }
  }
}

// Factory function with environment variables
export function createGmailClient(config?: Partial<GmailConfig>): GmailClient {
  const fullConfig: GmailConfig = {
    clientId: config?.clientId || process.env.GMAIL_CLIENT_ID || '',
    clientSecret: config?.clientSecret || process.env.GMAIL_CLIENT_SECRET || '',
    refreshToken: config?.refreshToken || process.env.GMAIL_REFRESH_TOKEN || '',
    targetEmail: config?.targetEmail || process.env.GMAIL_TARGET_EMAIL,
  };

  if (!fullConfig.clientId || !fullConfig.clientSecret || !fullConfig.refreshToken) {
    throw new Error('Gmail API credentials not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN environment variables.');
  }

  return new GmailClient(fullConfig);
}
