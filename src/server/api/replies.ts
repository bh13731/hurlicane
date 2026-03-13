import { Router } from 'express';
import * as queries from '../db/queries.js';
import { getMessageRouter } from '../orchestrator/MessageRouter.js';
import type { SubmitReplyRequest } from '../../shared/types.js';

const router = Router();

router.post('/:questionId', (req, res) => {
  const { questionId } = req.params;
  const body = req.body as SubmitReplyRequest;

  if (!body.answer) {
    res.status(400).json({ error: 'answer is required' });
    return;
  }

  const question = queries.getQuestionById(questionId);
  if (!question) {
    res.status(404).json({ error: 'question not found' });
    return;
  }
  if (question.status !== 'pending') {
    res.status(409).json({ error: 'question already answered or timed out' });
    return;
  }

  const resolved = getMessageRouter().resolveReply(questionId, body.answer);
  if (!resolved) {
    res.status(410).json({ error: 'agent is no longer waiting for this answer' });
    return;
  }

  res.json({ ok: true });
});

export default router;
