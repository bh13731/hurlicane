export interface ComplexitySignals {
  eventType: string;
  failedCheckCount: number;
  reviewState: string | null;
  reviewBodyLength: number;
}

export interface ComplexityConfig {
  failedCheckThreshold: number;
  reviewBodyThreshold: number;
}

const DEFAULT_CONFIG: ComplexityConfig = {
  failedCheckThreshold: 3,
  reviewBodyThreshold: 500,
};

/**
 * Parse threshold numbers from a discussion prompt string.
 * Looks for patterns like "3+ failing checks" and "500 characters".
 * Falls back to defaults for any values not found.
 */
export function parseComplexityConfig(prompt: string): ComplexityConfig {
  const config = { ...DEFAULT_CONFIG };

  // Match patterns like "3+ failing checks" or "3 failing checks"
  const checkMatch = prompt.match(/(\d+)\+?\s*failing\s*checks/i);
  if (checkMatch) {
    config.failedCheckThreshold = Number(checkMatch[1]);
  }

  // Match patterns like "500 characters" or "longer than 500 characters"
  const bodyMatch = prompt.match(/(\d+)\s*characters/i);
  if (bodyMatch) {
    config.reviewBodyThreshold = Number(bodyMatch[1]);
  }

  return config;
}

export function extractSignals(eventType: string, payload: any): ComplexitySignals {
  const signals: ComplexitySignals = {
    eventType,
    failedCheckCount: 0,
    reviewState: null,
    reviewBodyLength: 0,
  };

  if (eventType === 'check_suite') {
    const suite = payload.check_suite;
    if (suite) {
      // Count failing check runs in the suite
      const checkRuns: any[] = suite.check_runs ?? [];
      signals.failedCheckCount = checkRuns.filter(
        (cr: any) => cr.conclusion === 'failure',
      ).length;
      // If no check_runs array but suite itself failed, count as 1
      if (signals.failedCheckCount === 0 && suite.conclusion === 'failure') {
        signals.failedCheckCount = 1;
      }
    }
  }

  if (eventType === 'pull_request_review') {
    const review = payload.review;
    if (review) {
      signals.reviewState = review.state ?? null;
      signals.reviewBodyLength = (review.body ?? '').length;
    }
  }

  return signals;
}

export function evaluateComplexity(signals: ComplexitySignals, config?: ComplexityConfig): 'simple' {
  return 'simple';
}
