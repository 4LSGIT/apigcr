/**
 * Tasks API
 * routes/api.tasks.js
 *
 * GET    /api/tasks                  list with filters
 * GET    /api/tasks/:id              single task
 * POST   /api/tasks                  create
 * PATCH  /api/tasks/:id              update fields
 * PATCH  /api/tasks/:id/complete     mark Completed
 * PATCH  /api/tasks/:id/delete       soft-delete (status → Deleted)
 * PATCH  /api/tasks/:id/reopen       reopen a Completed or Deleted task
 * PATCH  /api/tasks/:id/transfer     reassign to another user
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const taskService = require('../services/taskService');

// ─── LIST ─────────────────────────────────────────────────────────────────────
router.get('/api/tasks', jwtOrApiKey, async (req, res) => {
  try {
    const result = await taskService.listTasks(req.db, {
      query:       req.query.q || req.query.query || '',
      status:      req.query.status      || 'Incomplete',
      assigned_to: req.query.assigned_to || null,
      assigned_by: req.query.assigned_by || null,
      link_type:   req.query.link_type   || null,
      link_id:     req.query.link_id     || null,
      limit:       req.query.limit  || 100,
      offset:      req.query.offset || 0
    });
    res.json(result);
  } catch (err) {
    console.error('GET /api/tasks error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch tasks' });
  }
});

// ─── GET ONE ──────────────────────────────────────────────────────────────────
router.get('/api/tasks/:id(\\d+)', jwtOrApiKey, async (req, res) => {
  try {
    const task = await taskService.getTask(req.db, req.params.id);
    if (!task) return res.status(404).json({ status: 'error', message: 'Task not found' });
    res.json({ data: task });
  } catch (err) {
    console.error('GET /api/tasks/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch task' });
  }
});

// ─── CREATE ───────────────────────────────────────────────────────────────────
router.post('/api/tasks', jwtOrApiKey, async (req, res) => {
  const { to, title } = req.body;
  if (!to || !title) {
    return res.status(400).json({ status: 'error', message: 'to and title are required' });
  }

  try {
    const result = await taskService.createTask(req.db, {
      from:      req.auth?.userId || req.body.from,
      to:        req.body.to,
      title:     req.body.title,
      desc:      req.body.desc   || '',
      start:     req.body.start  || null,
      due:       req.body.due    || null,
      notify:    req.body.notify || false,
      link_type: req.body.link_type || null,
      link_id:   req.body.link_id   || null
    });
    res.json({ status: 'success', title: 'Task Created', message: 'Task successfully created', ...result });
  } catch (err) {
    console.error('POST /api/tasks error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── UPDATE (generic patch) ───────────────────────────────────────────────────
router.patch('/api/tasks/:id(\\d+)', jwtOrApiKey, async (req, res) => {
  try {
    const task = await taskService.updateTask(req.db, req.params.id, req.body, req.auth?.userId);
    res.json({ status: 'success', title: 'Updated', message: 'Task updated', data: task });
  } catch (err) {
    console.error('PATCH /api/tasks/:id error:', err);
    const status = err.message.includes('blocked') ? 400
                 : err.message.includes('not found') ? 404
                 : 500;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

// ─── COMPLETE ─────────────────────────────────────────────────────────────────
router.patch('/api/tasks/:id(\\d+)/complete', jwtOrApiKey, async (req, res) => {
  try {
    const task = await taskService.completeTask(req.db, req.params.id, req.auth?.userId);
    res.json({ status: 'success', title: 'Done!', message: 'Task marked as completed.', data: task });
  } catch (err) {
    console.error('PATCH /api/tasks/:id/complete error:', err);
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('already') ? 400
                 : 500;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

// ─── DELETE (soft) ────────────────────────────────────────────────────────────
router.patch('/api/tasks/:id(\\d+)/delete', jwtOrApiKey, async (req, res) => {
  try {
    const task = await taskService.deleteTask(req.db, req.params.id, req.auth?.userId);
    res.json({ status: 'success', title: 'Deleted', message: 'Task deleted.', data: task });
  } catch (err) {
    console.error('PATCH /api/tasks/:id/delete error:', err);
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('already') ? 400
                 : 500;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

// ─── REOPEN ───────────────────────────────────────────────────────────────────
router.patch('/api/tasks/:id(\\d+)/reopen', jwtOrApiKey, async (req, res) => {
  try {
    const task = await taskService.reopenTask(req.db, req.params.id, req.auth?.userId);
    res.json({ status: 'success', title: 'Reopened', message: 'Task reopened.', data: task });
  } catch (err) {
    console.error('PATCH /api/tasks/:id/reopen error:', err);
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('already active') ? 400
                 : 500;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

// ─── TRANSFER ─────────────────────────────────────────────────────────────────
router.patch('/api/tasks/:id(\\d+)/transfer', jwtOrApiKey, async (req, res) => {
  const { to } = req.body;
  if (!to) {
    return res.status(400).json({ status: 'error', message: 'to (user ID) is required' });
  }

  try {
    const task = await taskService.transferTask(req.db, req.params.id, to, req.auth?.userId);
    res.json({ status: 'success', title: 'Transferred', message: `Task transferred to ${task.to.name}.`, data: task });
  } catch (err) {
    console.error('PATCH /api/tasks/:id/transfer error:', err);
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('Cannot transfer') ? 400
                 : 500;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

module.exports = router;