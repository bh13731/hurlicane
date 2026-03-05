import { Router } from 'express';
import jobsRouter from './jobs.js';
import agentsRouter from './agents.js';
import repliesRouter from './replies.js';
import locksRouter from './locks.js';
import templatesRouter from './templates.js';
import projectsRouter from './projects.js';
import usageRouter from './usage.js';
import searchRouter from './search.js';
import batchTemplatesRouter from './batchTemplates.js';
import settingsRouter from './settings.js';
import debatesRouter from './debates.js';
import worktreesRouter from './worktrees.js';
import statsRouter from './stats.js';
import knowledgeBaseRouter from './knowledgeBase.js';
import reposRouter from './repos.js';
import eyeRouter from './eye.js';
import slackRouter from './slack.js';
import adminRouter from './admin.js';

const router = Router();

router.use('/repos', reposRouter);

router.use('/jobs', jobsRouter);
router.use('/agents', agentsRouter);
router.use('/replies', repliesRouter);
router.use('/locks', locksRouter);
router.use('/templates', templatesRouter);
router.use('/projects', projectsRouter);
router.use('/usage', usageRouter);
router.use('/search', searchRouter);
router.use('/batch-templates', batchTemplatesRouter);
router.use('/settings', settingsRouter);
router.use('/debates', debatesRouter);
router.use('/worktrees', worktreesRouter);
router.use('/stats', statsRouter);
router.use('/knowledge-base', knowledgeBaseRouter);
router.use('/eye', eyeRouter);
router.use('/slack', slackRouter);
router.use('/admin', adminRouter);

export default router;
