const express = require("express");
const router = express.Router();

// Helper: compute checklist status
async function computeChecklistStatus(db, checklistId) {
  const [items] = await db.query(
    "SELECT status FROM checkitems WHERE checklist_id = ?",
    [checklistId]
  );
  return items.every(item => item.status === "complete") ? "complete" : "incomplete";
}

// ================== CHECKLIST ROUTES ================== //

// GET all checklists, optionally filter by links=X,Y,Z
router.get("/checklists", async (req, res) => {
  try {
    const { links } = req.query;
    let sql = "SELECT * FROM checklists";
    let params = [];
    if (links) {
      const linkList = links.split(",");
      const placeholders = linkList.map(() => "?").join(",");
      sql += ` WHERE link IN (${placeholders})`;
      params = linkList;
    }
    const [checklists] = await req.db.query(sql, params);
    res.json(checklists);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch checklists" });
  }
});

// GET basic info of a checklist
router.get("/checklists/:id", async (req, res) => {
  try {
    const [rows] = await req.db.query(
      "SELECT id, title, status, created_date, updated_date, link, tag FROM checklists WHERE id = ?",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Checklist not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch checklist" });
  }
});

// GET checklist details + items
router.get("/checklists/:id/items", async (req, res) => {
  try {
    const [checklists] = await req.db.query(
      "SELECT * FROM checklists WHERE id = ?",
      [req.params.id]
    );
    if (!checklists.length) return res.status(404).json({ error: "Checklist not found" });

    const [items] = await req.db.query(
      "SELECT * FROM checkitems WHERE checklist_id = ? ORDER BY position ASC, id ASC",
      [req.params.id]
    );

    res.json({
      ...checklists[0],
      items
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch checklist items" });
  }
});

// POST a new checklist (with optional items)
router.post("/checklists", async (req, res) => {
  try {
    const { title, created_by, link, tag, items } = req.body;
    const [result] = await req.db.query(
      "INSERT INTO checklists (title, created_by, link, tag) VALUES (?, ?, ?, ?)",
      [title, created_by, link || null, tag || null]
    );
    const checklistId = result.insertId;

    if (Array.isArray(items) && items.length > 0) {
      const itemValues = items.map((item, index) => [
        checklistId,
        item.name,
        item.status || "incomplete",
        item.position ?? index + 1,
        item.tag || null
      ]);
      await req.db.query(
        "INSERT INTO checkitems (checklist_id, name, status, position, tag) VALUES ?",
        [itemValues]
      );
    }

    const status = await computeChecklistStatus(req.db, checklistId);
    const [checklistRows] = await req.db.query("SELECT * FROM checklists WHERE id = ?", [checklistId]);
    const [itemRows] = await req.db.query("SELECT * FROM checkitems WHERE checklist_id = ? ORDER BY position ASC", [checklistId]);
    res.status(201).json({ ...checklistRows[0], status, items: itemRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create checklist" });
  }
});

// PATCH checklist info/status
router.patch("/checklists/:id", async (req, res) => {
  try {
    const { title, status, link, tag } = req.body;
    const fields = [];
    const params = [];

    if (title) { fields.push("title = ?"); params.push(title); }
    if (status) { fields.push("status = ?"); params.push(status); }
    if (link) { fields.push("link = ?"); params.push(link); }
    if (tag) { fields.push("tag = ?"); params.push(tag); }

    if (!fields.length) return res.status(400).json({ error: "No fields to update" });
    params.push(req.params.id);
    await req.db.query(`UPDATE checklists SET ${fields.join(", ")} WHERE id = ?`, params);

    const [checklistRows] = await req.db.query("SELECT * FROM checklists WHERE id = ?", [req.params.id]);
    const statusComputed = await computeChecklistStatus(req.db, req.params.id);
    const [itemRows] = await req.db.query("SELECT * FROM checkitems WHERE checklist_id = ? ORDER BY position ASC", [req.params.id]);

    res.json({ ...checklistRows[0], status: statusComputed, items: itemRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update checklist" });
  }
});

// DELETE checklist
router.delete("/checklists/:id", async (req, res) => {
  try {
    await req.db.query("DELETE FROM checklists WHERE id = ?", [req.params.id]);
    res.json({ message: "Checklist deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete checklist" });
  }
});

// ================== CHECKITEM ROUTES ================== //

// GET a specific checkitem
router.get("/checkitems/:id", async (req, res) => {
  try {
    const [rows] = await req.db.query("SELECT * FROM checkitems WHERE id = ?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Checkitem not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch checkitem" });
  }
});

// POST a new item to a checklist
router.post("/checklists/:checklistId/items", async (req, res) => {
  try {
    const { name, status, position, tag } = req.body;
    const checklistId = req.params.checklistId;

    let pos = position;
    if (!pos) {
      const [rows] = await req.db.query("SELECT MAX(position) as maxPos FROM checkitems WHERE checklist_id = ?", [checklistId]);
      pos = (rows[0].maxPos || 0) + 1;
    }

    await req.db.query(
      "INSERT INTO checkitems (checklist_id, name, status, position, tag) VALUES (?, ?, ?, ?, ?)",
      [checklistId, name, status || "incomplete", pos, tag || null]
    );

    const [itemRows] = await req.db.query("SELECT * FROM checkitems WHERE checklist_id = ? ORDER BY position ASC", [checklistId]);
    const checklistStatus = await computeChecklistStatus(req.db, checklistId);
    res.status(201).json({ checklistId, status: checklistStatus, items: itemRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create checkitem" });
  }
});

// PATCH checkitem
router.patch("/checkitems/:id", async (req, res) => {
  try {
    const { name, status, position, tag } = req.body;
    const fields = [];
    const params = [];

    if (name) { fields.push("name = ?"); params.push(name); }
    if (status) { fields.push("status = ?"); params.push(status); }
    if (position !== undefined) { fields.push("position = ?"); params.push(position); }
    if (tag) { fields.push("tag = ?"); params.push(tag); }

    if (!fields.length) return res.status(400).json({ error: "No fields to update" });
    params.push(req.params.id);
    await req.db.query(`UPDATE checkitems SET ${fields.join(", ")} WHERE id = ?`, params);

    const [itemRows] = await req.db.query("SELECT * FROM checkitems WHERE id = ?", [req.params.id]);
    if (!itemRows.length) return res.status(404).json({ error: "Checkitem not found" });

    const checklistId = itemRows[0].checklist_id;
    const [allItems] = await req.db.query("SELECT * FROM checkitems WHERE checklist_id = ? ORDER BY position ASC", [checklistId]);
    const checklistStatus = await computeChecklistStatus(req.db, checklistId);

    res.json({ checklistId, status: checklistStatus, items: allItems });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update checkitem" });
  }
});

// DELETE checkitem
router.delete("/checkitems/:id", async (req, res) => {
  try {
    const [itemRows] = await req.db.query("SELECT checklist_id FROM checkitems WHERE id = ?", [req.params.id]);
    if (!itemRows.length) return res.status(404).json({ error: "Checkitem not found" });

    const checklistId = itemRows[0].checklist_id;
    await req.db.query("DELETE FROM checkitems WHERE id = ?", [req.params.id]);

    const [allItems] = await req.db.query("SELECT * FROM checkitems WHERE checklist_id = ? ORDER BY position ASC", [checklistId]);
    const checklistStatus = await computeChecklistStatus(req.db, checklistId);

    res.json({ checklistId, status: checklistStatus, items: allItems });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete checkitem" });
  }
});

module.exports = router;
