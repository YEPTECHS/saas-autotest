/**
 * Gmail Verification Code Action
 * Optimized email polling and code extraction
 */

import { GmailClient, createGmailClient } from '../../core/gmail.js';

export interface GetCodeOptions {
  email: string;
  subject?: string;
  codePattern?: RegExp;
  timeout?: number;
  pollInterval?: number;
}

export interface GetCodeResult {
  success: boolean;
  code?: string;
  emailSubject?: string;
  receivedAt?: Date;
  error?: string;
  duration: number;
}

// Singleton Gmail client
let gmailClient: GmailClient | null = null;

function getGmailClient(): GmailClient {
  if (!gmailClient) {
    gmailClient = createGmailClient();
  }
  return gmailClient;
}

/**
 * Get verification code from Gmail
 * Optimized with efficient polling
 */
export async function getVerificationCode(options: GetCodeOptions): Promise<GetCodeResult> {
  const startTime = Date.now();
  const {
    email,
    subject = 'verification code',
    codePattern = /\b(\d{6})\b/,
    timeout = 60000,
    pollInterval = 2000, // Faster polling
  } = options;

  try {
    const gmail = getGmailClient();

    // Start polling from now (emails received after this time)
    const afterTime = new Date(Date.now() - 60000); // Look back 1 minute

    const result = await gmail.getVerificationCode({
      to: email,
      subject,
      codePattern,
      timeout,
    });

    if (!result) {
      return {
        success: false,
        error: 'Verification code not received within timeout',
        duration: Date.now() - startTime,
      };
    }

    return {
      success: true,
      code: result.code,
      emailSubject: result.email.subject,
      receivedAt: result.email.date,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Quick code extraction from email subject line
 * For cases where code is visible in Gmail inbox preview
 */
export function extractCodeFromSubject(subject: string, pattern = /\b(\d{6})\b/): string | null {
  const match = subject.match(pattern);
  return match ? (match[1] || match[0]) : null;
}

/**
 * Wait for email with exponential backoff
 */
export async function waitForEmailWithBackoff(
  gmail: GmailClient,
  email: string,
  maxAttempts = 10,
  initialDelay = 1000
): Promise<{ code: string; subject: string } | null> {
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[Attempt ${attempt}/${maxAttempts}] Checking for verification email...`);

    const result = await gmail.getVerificationCode({
      to: email,
      subject: 'verification',
      timeout: 5000, // Short timeout per attempt
    });

    if (result) {
      return {
        code: result.code,
        subject: result.email.subject,
      };
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 10000); // Cap at 10 seconds
    }
  }

  return null;
}
