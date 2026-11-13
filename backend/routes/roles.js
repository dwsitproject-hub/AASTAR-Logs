'use strict';

// Admin -> Roles: create, edit and delete roles and the pages each one opens.
const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { createRole, deleteRole, listRoles, updateRole } = require('../services/roles');

const router = express.Router();

function actorOf(req) {
  return String(req.user.email || req.user.username || '').slice(0, 254);
}

function handle(res, work) {
  try {
    return work();
  } catch (error) {
    if (!error.statusCode) throw error;
    return res.status(error.statusCode).json({ error: error.message });
  }
}

router.get('/', requireAuth, requireAdmin, (req, res) => {
  res.json(listRoles(getDb()));
});

router.post('/', requireAuth, requireAdmin, (req, res) => handle(res, () => {
  res.status(201).json(createRole(getDb(), req.body, actorOf(req)));
}));

router.put('/:id', requireAuth, requireAdmin, (req, res) => handle(res, () => {
  res.json(updateRole(getDb(), Number(req.params.id), req.body, actorOf(req)));
}));

router.delete('/:id', requireAuth, requireAdmin, (req, res) => handle(res, () => {
  deleteRole(getDb(), Number(req.params.id));
  res.json({ message: 'Role deleted' });
}));

module.exports = router;
