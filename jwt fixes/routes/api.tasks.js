const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const url = "https://webhookspy.com/9d1df7bd5a044364a09ed9576ede79a0"; // test url


router.get("/api/tasks", jwtOrApiKey, async (req, res) => {
  const db = req.db;

  const {
    query = "",
    status = "Incomplete",
    assigned_by = null,
    assigned_to = null,
    offset = 0,
    limit = 100
  } = req.query;

  try {
    // 1) Build WHERE clauses safely
    const where = [];
    const params = [];

    // status handling (matches your logic)
    if (status === "Incomplete") {
      where.push(`t.task_status IN ('Pending','Due Today','Overdue')`);
    } else if (status !== "All") {
      where.push(`t.task_status = ?`);
      params.push(status);
    }

    if (query) {
      where.push(`
        (
          t.task_title LIKE ?
          OR t.task_desc LIKE ?
          OR contacts.contact_name LIKE ?
          OR cases.case_number LIKE ?
          OR cases.case_number_full LIKE ?
          OR cases.case_id LIKE ?
        )
      `);
      const q = `%${query}%`;
      params.push(q, q, q, q, q, q);
    }

    if (assigned_by) {
      where.push(`t.task_from = ?`);
      params.push(assigned_by);
    }

    if (assigned_to) {
      where.push(`t.task_to = ?`);
      params.push(assigned_to);
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // 2) Main query
    const [rows] = await db.query(
      `
      SELECT
        t.task_id,
        t.task_status,
        t.task_title,
        t.task_desc,
        t.task_due,
        t.task_date,
        t.task_notification,

        u.user AS from_id,
        u.user_name AS from_name,
        u2.user AS to_id,
        u2.user_name AS to_name,

        contacts.contact_id,
        contacts.contact_name,

        cases.case_id,
        cases.case_number,
        cases.case_number_full

      FROM tasks t
      LEFT JOIN users u ON t.task_from = u.user
      LEFT JOIN users u2 ON t.task_to = u2.user
      LEFT JOIN contacts ON t.task_link = contacts.contact_id
      LEFT JOIN cases ON
        t.task_link != '' AND (
          t.task_link = cases.case_number OR
          t.task_link = cases.case_number_full OR
          t.task_link = cases.case_id
        )
      ${whereSQL}
      ORDER BY t.task_date DESC
      LIMIT ?
      OFFSET ?
      `,
      [...params, Number(limit), Number(offset)]
    );

    // 3) Count query
    const [[{ total }]] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM tasks t
      LEFT JOIN contacts ON t.task_link = contacts.contact_id
      LEFT JOIN cases ON
        t.task_link != '' AND (
          t.task_link = cases.case_number OR
          t.task_link = cases.case_number_full OR
          t.task_link = cases.case_id
        )
      ${whereSQL}
      `,
      params
    );

    // 4) Normalize
    const data = rows.map(r => {
      let link = null;

      if (r.contact_id) {
        link = {
          type: "contact",
          id: r.contact_id,
          title: r.contact_name
        };
      } else if (r.case_id) {
        link = {
          type: "case",
          id: r.case_number_full || r.case_number || r.case_id,
          title: r.case_number_full || r.case_number || r.case_id
        };
      }

      return {
        id: r.task_id,
        status: r.task_status,
        title: r.task_title,
        desc: r.task_desc,
        due: r.task_due,
        created: r.task_date,
        notify: !!r.task_notification,
        from: {
          id: r.from_id,
          name: r.from_name
        },
        to: {
          id: r.to_id,
          name: r.to_name
        },
        link
      };
    });

    res.json({ data, total });

  } catch (err) {
    console.error("GET /api/tasks error:", err);
    res.status(500).json({
      status: "error",
      message: "Failed to load tasks"
    });
  }
});



// POST /api/tasks – create a new task
router.post("/api/tasks", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const from = req.auth.userId;
  const { to, title, desc, start, due, notify, link } = req.body;

  try {
    const [result] = await db.query(
      `INSERT INTO tasks 
        (task_from, task_to, task_title, task_desc, task_start, task_due, task_notification, task_link, task_status, task_date) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', NOW())`,
      [from, to, title, desc, start || null, due, notify ? 1 : 0, link || null]
    );

    const taskId = result.insertId;

    // Call temp scheduling system
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, to, title, desc, start, due, notify, link, action: "create" })
    });

    const [[task]] = await db.query(`SELECT * FROM tasks WHERE task_id = ?`, [taskId]);
    res.json({ data: task, title: "Task Created", message: "Task successfully created" });

  } catch (err) {
    console.error("POST /api/tasks error:", err);
    res.status(500).json({ error: "Failed to create task" });
  }
});

// PUT /api/tasks/:id – update task fields
router.put("/api/tasks/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const taskId = req.params.id;
  const { to, title, desc, start, due, notify, link } = req.body;

  try {
    await db.query(
      `UPDATE tasks SET 
        task_to = COALESCE(?, task_to),
        task_title = COALESCE(?, task_title),
        task_desc = COALESCE(?, task_desc),
        task_start = COALESCE(?, task_start),
        task_due = COALESCE(?, task_due),
        task_notification = COALESCE(?, task_notification),
        task_link = COALESCE(?, task_link)
       WHERE task_id = ?`,
      [to, title, desc, start, due, notify ? 1 : 0, link, taskId]
    );

    // Call temp scheduling system
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, to, title, desc, start, due, notify, link, action: "update" })
    });

    const [[task]] = await db.query(`SELECT * FROM tasks WHERE task_id = ?`, [taskId]);
    res.json({ data: task, title: "Task Updated", message: "Task successfully updated" });

  } catch (err) {
    console.error("PUT /api/tasks/:id error:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
});

// PATCH /api/tasks/:id – partial updates (status, etc.)
router.patch("/api/tasks/:id", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const taskId = req.params.id;
  const { status } = req.body;

  try {
    if (status) {
      await db.query(
        `UPDATE tasks SET task_status = ? WHERE task_id = ?`,
        [status, taskId]
      );

      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, status, action: "status" })
      });
    }

    const [[task]] = await db.query(`SELECT * FROM tasks WHERE task_id = ?`, [taskId]);

    res.json({
      data: task,
      title: "Status Updated",
      message: `Task marked ${status}`
    });

  } catch (err) {
    console.error("PATCH /api/tasks/:id error:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
});


// GET /api/tasks/:id – fetch single task
router.get("/api/tasks/:id(\\d+)", jwtOrApiKey, async (req, res) => {
  const db = req.db;
  const taskId = req.params.id;

  try {
    const [[r]] = await db.query(
      `
      SELECT
        t.task_id,
        t.task_status,
        t.task_title,
        t.task_desc,
        t.task_due,
        t.task_date,
        t.task_notification,

        u.user AS from_id,
        u.user_name AS from_name,
        u2.user AS to_id,
        u2.user_name AS to_name,

        contacts.contact_id,
        contacts.contact_name,

        cases.case_id,
        cases.case_number,
        cases.case_number_full

      FROM tasks t
      LEFT JOIN users u ON t.task_from = u.user
      LEFT JOIN users u2 ON t.task_to = u2.user
      LEFT JOIN contacts ON t.task_link = contacts.contact_id
      LEFT JOIN cases ON
        t.task_link != '' AND (
          t.task_link = cases.case_number OR
          t.task_link = cases.case_number_full OR
          t.task_link = cases.case_id
        )
      WHERE t.task_id = ?
      LIMIT 1
      `,
      [taskId]
    );

    if (!r) {
      return res.status(404).json({
        status: "error",
        message: "Task not found"
      });
    }

    let link = null;

    if (r.contact_id) {
      link = {
        type: "contact",
        id: r.contact_id,
        title: r.contact_name
      };
    } else if (r.case_id) {
      link = {
        type: "case",
        id: r.case_number_full || r.case_number || r.case_id,
        title: r.case_number_full || r.case_number || r.case_id
      };
    }

    res.json({
      data: {
        id: r.task_id,
        status: r.task_status,
        title: r.task_title,
        desc: r.task_desc,
        due: r.task_due,
        created: r.task_date,
        notify: !!r.task_notification,
        from: {
          id: r.from_id,
          name: r.from_name
        },
        to: {
          id: r.to_id,
          name: r.to_name
        },
        link
      }
    });

  } catch (err) {
    console.error("GET /api/tasks/:id error:", err);
    res.status(500).json({
      status: "error",
      message: "Failed to load task"
    });
  }
});

module.exports = router;
