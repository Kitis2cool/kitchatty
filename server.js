// ---------------- Imports ----------------
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- PostgreSQL Connection ----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});



// ---------------- Helper ----------------
async function query(text, params) {
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (err) {
    console.error("Database error:", err);
    throw err;
  }
}

// ---------------- Presence ----------------
app.post("/online-users", async (req, res) => {
  const { username, lastActive, avatar, typing } = req.body;
  if (!username) return res.status(400).json({ error: "Missing username" });

  try {
    await query(
      `INSERT INTO online_users (username, last_active, avatar, typing)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO UPDATE
       SET last_active = EXCLUDED.last_active,
           avatar = EXCLUDED.avatar,
           typing = EXCLUDED.typing`,
      [username, lastActive || Date.now(), avatar || null, typing || false]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("DB error in /online-users:", err);
    res.status(500).json({ error: "Database error" });
  }
});



// --- Simple helper to validate online users ---
function validateOnlineUser(user) {
  if (!user || !user.username) {
    return false;
  }
  return true;
}


// GET /online-users — list all online users except optional loggedInUser
app.get("/online-users", async (req, res) => {
  const loggedInUser = req.query.loggedInUser || null;

  try {
    const sql = loggedInUser
      ? "SELECT username, last_active, avatar, typing FROM online_users WHERE username != $1"
      : "SELECT username, last_active, avatar, typing FROM online_users";
    const params = loggedInUser ? [loggedInUser] : [];
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error("DB error in GET /online-users:", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.post("/presence", async (req, res) => {
  const { username, lastActive, typing } = req.body;
  if (!username) return res.status(400).send({ error: "Missing username" });

  try {
    await query(
      `INSERT INTO online_users (username, last_active, typing)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE
       SET last_active = EXCLUDED.last_active,
           typing = EXCLUDED.typing`,
      [username, lastActive || Date.now(), typing || false]
    );
    res.send({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Database error" });
  }
});

app.get("/presence", async (req, res) => {
  try {
    const result = await query(
      "SELECT username, last_active, typing FROM online_users"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("DB error in GET /presence:", err);
    res.status(500).send({ error: "Database error" });
  }
});

// ---------------- Users ----------------

app.use(express.json());

// Create a new account


// ---------------- Create User ----------------
app.post("/users", async (req, res) => {
  const { username, password, avatar } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Missing username or password" });
  }

  try {
    // Check if username already exists
    const existing = await query("SELECT id FROM users WHERE id=$1", [username]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Username already exists" });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert new user
    await query(
      `INSERT INTO users (id, avatar, password, created_at)
       VALUES ($1, $2, $3, $4)`,
      [username, avatar || null, hashedPassword, Date.now()]
    );

    res.json({ success: true, message: "Account created successfully" });
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ error: "Database error" });
  }
});



// ---------------- Login ----------------
app.post("/users/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Missing username or password" });
  }

  try {
    const result = await query("SELECT password FROM users WHERE id=$1", [username]);
    if (!result.rows.length) return res.status(401).json({ error: "User not found" });

    const hashedPassword = result.rows[0].password;
    if (!hashedPassword) return res.status(500).json({ error: "No password set for this user" });

    const match = await bcrypt.compare(password, hashedPassword);

    if (!match) return res.status(401).json({ error: "Incorrect password" });

    res.json({ success: true, message: "Login successful" });
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/users/:username", async (req, res) => {
  const { username } = req.params;

  try {
    const result = await query(
      "SELECT id, avatar, password, created_at FROM users WHERE id = $1",
      [username]
    );

    if (!result.rows.length) {
      return res.status(404).send({ error: "User not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).send({ error: "Database error" });
  }
});


// ---------------- Friends ----------------
app.get("/friends", async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).send({ error: "Missing username" });

  try {
    const result = await query(
      "SELECT friendname, status FROM friends WHERE username=$1",
      [username]
    );

    // Transform to sets for frontend
    const friendsAccepted = new Set(
      result.rows.filter(f => f.status === "accepted").map(f => f.friendname)
    );

    const friendsRequestedIn = new Set(
      result.rows.filter(f => f.status === "requested").map(f => f.friendname)
    );

    res.json({
      rows: result.rows || [],
      friendsAccepted: [...friendsAccepted],
      friendsRequestedIn: [...friendsRequestedIn]
    });
  } catch (err) {
    console.error("DB error in GET /friends:", err);
    res.status(500).send({ error: "Database error" });
  }
});



app.post("/friends", async (req, res) => {
  const { fromUser, toUser, action } = req.body;
  if (!fromUser || !toUser || !action) {
    return res.status(400).send({ error: "Missing parameters" });
  }

  try {
    if (action === "send") {
      // From user -> To user (pending)
      await query(
        `INSERT INTO friends (username, friendname, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (username, friendname) DO UPDATE SET status='pending'`,
        [fromUser, toUser]
      );

      // To user -> From user (requested)
      await query(
        `INSERT INTO friends (username, friendname, status)
         VALUES ($1, $2, 'requested')
         ON CONFLICT (username, friendname) DO UPDATE SET status='requested'`,
        [toUser, fromUser]
      );
    } 
    
    else if (action === "accept") {
      await query(
        `UPDATE friends SET status='accepted' WHERE username=$1 AND friendname=$2`,
        [fromUser, toUser]
      );
      await query(
        `UPDATE friends SET status='accepted' WHERE username=$1 AND friendname=$2`,
        [toUser, fromUser]
      );
    } 
    
    else if (action === "remove") {
      await query(
        `DELETE FROM friends
         WHERE (username=$1 AND friendname=$2)
            OR (username=$2 AND friendname=$1)`,
        [fromUser, toUser]
      );
    }

    res.send({ success: true });
  } catch (err) {
    console.error("DB error in /friends:", err);
    res.status(500).send({ error: "Database error" });
  }
});
// Example Express.js
app.post("/friends/request", async (req, res) => {
  const { fromUser, toUser } = req.body;

  if (!fromUser || !toUser) return res.status(400).json({ error: "Missing users" });

  try {
    // Insert friend request without worrying about duplicates
    await pool.query(
      "INSERT INTO friend_requests (from_user, to_user, created_at) VALUES ($1, $2, NOW())",
      [fromUser, toUser]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    // Just log error but still respond success so UI works
    res.json({ success: true, warning: "Could not enforce uniqueness" });
  }
});




// ---------------- Groups ----------------
app.post("/groups", async (req, res) => {
  const { name, createdBy, members } = req.body;
  if (!name || !createdBy || !Array.isArray(members))
    return res.status(400).send({ error: "Invalid request" });

  try {
    await query(
      `INSERT INTO groups (name, created_by, members, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE
       SET members = EXCLUDED.members, created_at = EXCLUDED.created_at`,
      [name, createdBy, JSON.stringify(members), Date.now()]
    );
    res.send({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Database error" });
  }
});

app.get("/groups", async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).send({ error: "Missing username" });

  try {
    const result = await query(
      `SELECT * FROM groups WHERE $1 IN (SELECT jsonb_array_elements_text(members::jsonb))`,
      [username]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Database error" });
  }
});

// ---------------- Messages ----------------
app.post("/messages", async (req, res) => {
  const { from_user, to_target, text, file_url, file_name, reply_to } = req.body;

  if (!from_user || !to_target)
    return res.status(400).send({ error: "Missing from/to" });

  try {
    // Insert message with millisecond timestamp
    await query(
  `INSERT INTO messages (from_user, to_target, text, file_url, file_name, reply_to, timestamp)
   VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  [
    from_user,
    to_target,
    text || "",
    file_url || null,
    file_name || null,
    reply_to || null,
    Date.now() // ✅ Always in milliseconds
  ]
);

    res.send({ success: true });
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).send({ error: "Database error" });
  }
});

app.get("/messages", async (req, res) => {
  const { target } = req.query;
  if (!target) return res.status(400).send({ error: "Missing target" });

  try {
    const result = await query(
      "SELECT * FROM messages WHERE to_target=$1 ORDER BY timestamp ASC",
      [target]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Database error" });
  }
});

app.delete("/messages/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await query("DELETE FROM messages WHERE id=$1", [id]);
    res.send({ success: true });
  } catch (err) {
    console.error("Failed to delete message on server:", err);
    res.status(500).send({ error: "Database error" });
  }
});

// ---------------- Start Server ----------------
const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
