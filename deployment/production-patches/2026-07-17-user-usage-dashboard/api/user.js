const express = require('express');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const {
  updateUserPluginsController,
  resendVerificationController,
  getTermsStatusController,
  acceptTermsController,
  verifyEmailController,
  deleteUserController,
  getUserController,
} = require('~/server/controllers/UserController');
const {
  verifyEmailLimiter,
  verifyEmailSubmissionLimiter,
  configMiddleware,
  canDeleteAccount,
  requireJwtAuth,
} = require('~/server/middleware');
const { createUsageDashboardHandler } = require('./usage-dashboard');

const settings = require('./settings');

const router = express.Router();
const usageDashboardHandler = createUsageDashboardHandler({ mongoose, logger });

router.use('/settings', settings);
router.get('/', requireJwtAuth, getUserController);
router.get('/usage-dashboard', requireJwtAuth, usageDashboardHandler);
router.get('/terms', requireJwtAuth, getTermsStatusController);
router.post('/terms/accept', requireJwtAuth, acceptTermsController);
router.post('/plugins', requireJwtAuth, updateUserPluginsController);
router.delete('/delete', requireJwtAuth, canDeleteAccount, configMiddleware, deleteUserController);
router.post('/verify', verifyEmailSubmissionLimiter, verifyEmailController);
router.post('/verify/resend', verifyEmailLimiter, resendVerificationController);

module.exports = router;
