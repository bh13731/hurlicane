export interface ComplexitySignals {
  eventType: string;
  failedCheckCount: number;
  reviewState: string | null;
  reviewBodyLength: number;
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

export function evaluateComplexity(signals: ComplexitySignals): 'simple' | 'debate' {
  // CI suite failure with 3+ failing checks → debate
  if (signals.failedCheckCount >= 3) return 'debate';

  // changes_requested review with body >500 chars → debate
  if (
    signals.reviewState === 'changes_requested' &&
    signals.reviewBodyLength > 500
  ) {
    return 'debate';
  }

  return 'simple';
}
