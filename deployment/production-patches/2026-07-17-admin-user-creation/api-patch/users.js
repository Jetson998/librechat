const express = require('express');
const mongoose = require('mongoose');
const { createAdminUsersHandlers } = require('@librechat/api');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { configMiddleware, requireJwtAuth } = require('~/server/middleware');
const { registerUser } = require('~/server/services/AuthService');
const { createAdminBalanceHandlers } = require('./admin-balance');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);
const requireManageUsers = requireCapability(SystemCapabilities.MANAGE_USERS);
const balanceHandlers = createAdminBalanceHandlers({ mongoose, findUsers: db.findUsers, logger });

const handlers = createAdminUsersHandlers({
  findUsers: db.findUsers,
  countUsers: db.countUsers,
  deleteUserById: db.deleteUserById,
  deleteConfig: db.deleteConfig,
  deleteAclEntries: db.deleteAclEntries,
  registerUser,
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', requireReadUsers, handlers.listUsers);
router.get('/search', requireReadUsers, handlers.searchUsers);
router.post('/', requireManageUsers, handlers.createUser);
router.get('/:id/balance', requireReadUsers, configMiddleware, balanceHandlers.getUserBalance);
router.post(
  '/:id/balance-adjustments',
  requireManageUsers,
  configMiddleware,
  balanceHandlers.adjustUserBalance,
);
router.delete('/:id', requireManageUsers, handlers.deleteUser);

module.exports = router;
