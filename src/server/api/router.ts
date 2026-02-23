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

const router = Router();

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

export default router;
