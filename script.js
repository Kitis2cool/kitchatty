/* ===== Globals & Initialization ===== */

// DOM container for messages
const notesList = document.getElementById("notesList");

// Track rendered messages to prevent duplicates
const renderedMessageIds = new Set();

// Track which tabs have completed initial fetch
const initialSyncDone = Object.create(null);

// Add any existing messages on page load
Array.from(notesList.querySelectorAll(".note-item")).forEach(el => {
  if (el.dataset.id) renderedMessageIds.add(String(el.dataset.id));
});
// ---------------- Backend URL ----------------
const BASE_URL = "https://kitchatty.loca.lt";

// Friend tracking
let friendsPendingOut = [];
let friendsPendingIn = [];

/* ===== Admin & login ===== */
const ADMIN_USERS = ["kitis", "kellen", "annfrank"];
let isAdmin = false;

// Logged-in user
const loggedInUser = localStorage.getItem("loggedInUser");
window.loggedInUser = localStorage.getItem("loggedInUser");

if (!loggedInUser) {
    console.warn("No logged-in user, redirecting...");
    window.location.href = "login.html";
} else {
    // Mark user as online
    (async () => {
      try {
        await fetch(`${BASE_URL}/online-users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: loggedInUser, lastActive: Date.now() })
        });
        refreshFriends();
        // Refresh friends periodically
        setInterval(refreshFriends, 15000);
      } catch (err) {
        console.error("Failed to update online status:", err);
      }
    })();

    // Fill username input
    const usernameInput = document.getElementById("username");
    if (usernameInput) usernameInput.value = loggedInUser;

    // Admin check
    if (ADMIN_USERS.includes(loggedInUser)) isAdmin = true;
}

// Ensure user exists in DB
async function upsertUser(userId) {
  const timestamp = Date.now();
  try {
    await pool.query(
      `INSERT INTO users (id, created_at)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE
       SET created_at = EXCLUDED.created_at`,
      [userId, timestamp]
    );
  } catch (err) {
    console.error("Failed to upsert user:", err);
  }
}

/* ===== Polling for messages ===== */
window.onload = () => {
  if (loggedInUser) {
    watchMessages("all");
    setInterval(() => watchMessages("all"), 2000); // Refresh every 3s
  }
};

/* ===== Helpers ===== */

let friendsRequestedIn = [];


const looksLikeUrl = (text = "") => /^https?:\/\/\S+$/i.test(text.trim());
const isImageUrl = (str = "") => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(str.split(/[?#]/)[0]);
const isGroupKey = (k) => typeof k === "string" && k.startsWith("group:");
const groupNameFromKey = (k) => (k.split(":")[1] || "").trim();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function formatLastSeen(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
/* Unread tracking */
let unreadCounts = {};
let unreadMessageIds = {}; // { key: Set<messageId> }
/* ===== Profanity filter ===== */
const bannedWords = [
  "pussy","cock","cum","slut","whore",
  "france","french","british","asshole","dick","cunt",
  "nigger","nigga","chink"
];
function filterProfanity(text) {
  let filtered = text;
  bannedWords.forEach((w) => {
    const regex = new RegExp(w, "gi");
    filtered = filtered.replace(regex, "****");
  });
  return filtered;
}

/* ===== Presence ===== */
const friendsList = document.getElementById("friendsList");
const requestsList = document.getElementById("requestsList");
const discoverList = document.getElementById("discoverList");

// Track who is online + their meta
let presence = {}; // { username: { lastActive:number, avatar:string } }
let allFriends = [];

// ---------------- Fetch Friends + Online Status ----------------
async function fetchFriends(username) {
  // Validate username
  if (!username?.trim()) {
    console.warn("fetchFriends called without username");
    window.friendsCache = { enrichedAccepted: [], friendsRequestedIn: [] };
    return {
      friendsAccepted: new Set(),
      friendsRequestedIn: new Set(),
      all: [],
      enrichedAccepted: [],
    };
  }

  try {
    // --- Fetch friend list from server ---
    const res = await fetch(
      `${BASE_URL}/friends?username=${encodeURIComponent(username)}`
    );
    if (!res.ok) {
      let errMsg = `Server returned ${res.status}`;
      try {
        const errorData = await res.json();
        errMsg = errorData.error || errMsg;
      } catch (_) {}
      throw new Error(errMsg);
    }
    const data = await res.json();

    // --- Fetch online users ---
    let onlineUsers = [];
    try {
      const onlineRes = await fetch(
        `${BASE_URL}/online-users?loggedInUser=${encodeURIComponent(username)}`
      );
      if (onlineRes.ok) {
        const onlineData = await onlineRes.json();
        onlineUsers = onlineData.map(u => u.username);
      }
    } catch (err) {
      console.warn("Failed to fetch online users:", err);
    }
    const onlineSet = new Set(onlineUsers);

    // --- Enrich accepted friends with online flag ---
    const enrichedAccepted = (Array.isArray(data.friendsAccepted) ? data.friendsAccepted : []).map(friend => ({
      username: friend,
      online: onlineSet.has(friend),
    }));

    // --- Cache globally for UI rendering ---
    window.friendsCache = {
      enrichedAccepted,
      friendsRequestedIn: Array.isArray(data.friendsRequestedIn) ? data.friendsRequestedIn : [],
    };

    return {
      friendsAccepted: new Set(enrichedAccepted.map(f => f.username)),
      friendsRequestedIn: new Set(
        Array.isArray(data.friendsRequestedIn) ? data.friendsRequestedIn : []
      ),
      all: Array.isArray(data.rows) ? data.rows : [],
      enrichedAccepted,
    };
  } catch (err) {
    console.error("Failed to fetch friends:", err);
    window.friendsCache = { enrichedAccepted: [], friendsRequestedIn: [] };
    return {
      friendsAccepted: new Set(),
      friendsRequestedIn: new Set(),
      all: [],
      enrichedAccepted: [],
    };
  }
}







// Respond to a friend request (accept or decline)
// Respond to a friend request (accept or decline)
async function respondToFriendRequest(fromUser, accept) {
  try {
    await fetch(`${BASE_URL}/respond-friend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromUser, toUser: loggedInUser, accept }),
    });
    await fetchFriends(loggedInUser); // refresh after update
  } catch (err) {
    console.error(err);
    alert("Failed to update friend request.");
  }
}

// Cancel a pending friend request
async function cancelFriendRequest(user) {
  try {
    await fetch(`${BASE_URL}/cancel-friend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromUser: loggedInUser, toUser: user }),
    });
    await fetchFriends(loggedInUser); // refresh after update
  } catch (err) {
    console.error(err);
    alert("Failed to cancel friend request.");
  }
}

// Remove an accepted friend
async function removeFriend(user) {
  if (!confirm(`Remove ${user} from friends?`)) return;
  try {
    await fetch(`${BASE_URL}/remove-friend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user1: loggedInUser, user2: user }),
    });
    await fetchFriends(loggedInUser); // refresh after update
  } catch (err) {
    console.error(err);
    alert("Failed to remove friend.");
  }
} 



/* ===== Rendering ===== */
function sortUsersByPresence(usernames) {
  const now = Date.now();
  return [...usernames].sort((a, b) => {
    const A = presence[a] || {}; const B = presence[b] || {};
    const aOnline = A.lastActive ? now - A.lastActive <= 60*1000 : false;
    const bOnline = B.lastActive ? now - B.lastActive <= 60*1000 : false;
    if (aOnline && !bOnline) return -1;
    if (!aOnline && bOnline) return 1;
    return (B.lastActive || 0) - (A.lastActive || 0);
  });
}


// --- helper function ---
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------------- Refresh Friends UI ----------------
async function refreshFriends() {
  const username = localStorage.getItem("loggedInUser");
  if (!username) {
    console.warn("Skipping refreshFriends: no logged-in user");
    return;
  }

  try {
    const friendsData = await fetchFriends(username);
    window.enrichedAccepted = friendsData.enrichedAccepted;
    renderFriends();
  } catch (err) {
    console.error("Error fetching friends:", err);
  }
}

// Initial fetch
refreshFriends();

// Poll every 5s
setInterval(refreshFriends, 5000);


// ---- Avatar handling ----
document.addEventListener("DOMContentLoaded", () => {
  const myAvatarImg = document.getElementById("myAvatarImg");
  const profilePicInput = document.getElementById("profilePicInput");

  // Load current user's avatar from localStorage
  if (myAvatarImg) {
    const savedAvatar = localStorage.getItem(`avatar_${loggedInUser}`);
    if (savedAvatar) myAvatarImg.src = savedAvatar;
  }

  if (!profilePicInput) return;

  profilePicInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      alert("File too large! Max 2MB.");
      profilePicInput.value = "";
      return;
    }

    try {
      const dataURL = await fileToDataURL(file);

      // Save avatar in localStorage so it persists locally
      localStorage.setItem(`avatar_${loggedInUser}`, dataURL);

      // Let backend know user updated avatar
      await fetch(`${BASE_URL}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loggedInUser }),
      });

      // ✅ Re-fetch from server so friends list shows new avatar
      await refreshFriends();

      alert("Profile picture updated!");
    } catch (err) {
      console.error(err);
      alert("Failed to load image.");
    }
  });
});

function buildUserRow(user, opts = {}) {
  const savedAvatar = localStorage.getItem(`avatar_${user}`);
  const defaultAvatar = `https://i.pravatar.cc/30?u=${user}`;
  const meta = presence[user] || { lastActive: 0, online: false };
  const loggedInUser = localStorage.getItem("loggedInUser");

  const div = document.createElement("div");
  div.className = "online-user";
  div.dataset.user = user;

  // Avatar
  const avatar = document.createElement("img");
  avatar.src = savedAvatar || defaultAvatar;
  avatar.className = "avatar";

  // Info
  const info = document.createElement("span");
  info.style.color = meta.online ? 'limegreen' : 'gray';
  const username = document.createElement("strong");
  username.textContent = user + " ";
  const status = document.createElement("span");
  status.textContent = meta.online
    ? "online"
    : `(last seen ${timeAgo(meta.lastActive)})`;
  status.style.fontWeight = "normal";
  info.appendChild(username);
  info.appendChild(status);

  // Actions container
  const right = document.createElement("div");
  right.className = "actions";

  // Default buttons from opts
  (opts.buttons || []).forEach((btnDef) => {
    if (btnDef.text === "Logout" && user !== loggedInUser) return;
    const b = createStyledButton(btnDef.text, btnDef.onClick);
    right.appendChild(b);
  });

  // 🔥 Friend system buttons
  if (user !== loggedInUser) {
    const { friendsAccepted = [], friendsRequestedIn = [] } = window.friendsCache || {};

    if (friendsAccepted.includes(user)) {
      const removeBtn = createStyledButton("Remove Friend", async () => {
        await updateFriend(loggedInUser, user, "remove");
      });
      right.appendChild(removeBtn);
    } else if (friendsRequestedIn.includes(user)) {
      const acceptBtn = createStyledButton("Accept", async () => {
        await updateFriend(loggedInUser, user, "accept");
      });
      right.appendChild(acceptBtn);

      const rejectBtn = createStyledButton("Reject", async () => {
        await updateFriend(loggedInUser, user, "remove");
      });
      right.appendChild(rejectBtn);
    } else {
      const addBtn = createStyledButton("Add Friend", async () => {
        await updateFriend(loggedInUser, user, "send");
      });
      right.appendChild(addBtn);
    }
  }

  div.appendChild(avatar);
  div.appendChild(info);
  div.appendChild(right);

  if (!opts.preventRowClick) {
    div.onclick = () => openTab(user);
  }

  return div;
}

// 🛠 Helper: create styled button
function createStyledButton(text, onClick) {
  const b = document.createElement("button");
  b.className = "action-btn";
  b.textContent = text;
  b.style.cssText = `
    padding: 5px 12px;
    margin-left: 6px;
    border: none;
    border-radius: 12px;
    background: linear-gradient(90deg, #4c8bf5, #1d4ed8);
    color: white;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
  `;
  b.addEventListener("mouseenter", () => {
    b.style.boxShadow = "0 4px 12px rgba(76,139,245,0.5)";
    b.style.transform = "translateY(-1px)";
  });
  b.addEventListener("mouseleave", () => {
    b.style.boxShadow = "none";
    b.style.transform = "translateY(0)";
  });
  b.onclick = async (e) => {
    e.stopPropagation();
    await onClick();
    renderFriends(); // refresh UI after update
  };
  return b;
}

// 🛠 Helper: call backend
async function updateFriend(fromUser, toUser, action) {
  try {
    await fetch(`${BASE_URL}/friends`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromUser, toUser, action }),
    });
  } catch (err) {
    console.error("Friend update failed:", err);
  }
}




const logoutBtn = document.getElementById("logoutBtn");

logoutBtn.onclick = async () => {
  const loggedInUser = localStorage.getItem("loggedInUser");

  try {
    // Mark the user offline via your Node.js server
    await fetch(`${BASE_URL}/online-users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: loggedInUser, online: false }),
    });
  } catch (err) {
    console.warn("Failed to update online status:", err);
  } finally {
    // Remove local login info
    localStorage.removeItem("loggedInUser");
    // Redirect to login page
    window.location.href = "login.html";
  }
};



function renderFriends() {
  friendsList.innerHTML = "";

  // ---- "All Chat" row ----
  const allDiv = document.createElement("div");
  allDiv.className = "online-user";
  allDiv.dataset.user = "all";

  const leftAll = document.createElement("div");
  leftAll.style.display = "flex";
  leftAll.style.flexDirection = "column";

  const labelAll = document.createElement("span");
  labelAll.textContent = "All Chat";
  leftAll.appendChild(labelAll);

  allDiv.appendChild(leftAll);

  const rightAll = document.createElement("div");
  rightAll.style.display = "flex";
  rightAll.style.alignItems = "center";

  const unreadHolderAll = document.createElement("span");
  unreadHolderAll.className = "unread-holder";
  rightAll.appendChild(unreadHolderAll);

  allDiv.appendChild(rightAll);
  allDiv.onclick = () => openTab("all");

  friendsList.appendChild(allDiv);
  updateUnreadBadge("all");

  // ---- Friends ----
  const sorted = (window.enrichedAccepted || []).slice().sort((a, b) => {
    // online friends first, then alphabetical
    if (a.online && !b.online) return -1;
    if (!a.online && b.online) return 1;
    return a.username.localeCompare(b.username);
  });

  sorted.forEach(({ username, online, avatar }) => {
    const row = buildUserRow(username, {
      avatar: avatar || null, // 👈 pass avatar if available
      buttons: [
        { text: "Chat", title: "Open chat", onClick: () => openTab(username) },
        { text: "−", title: "Remove friend", onClick: () => removeFriend(username) },
      ],
    });

    row.classList.add(online ? "user-online" : "user-offline");

    friendsList.appendChild(row);
    updateUnreadBadge(username);
  });

  if (!sorted.length) {
    const hint = document.createElement("div");
    hint.style.fontSize = "12px";
    hint.style.color = "#ccc";
    hint.style.marginTop = "6px";
    hint.innerHTML =
      "No friends yet. Use <strong>Discover</strong> or add by username above.";
    friendsList.appendChild(hint);
  }
}



function renderRequests() {
  requestsList.innerHTML = "";

  // Incoming requests (requested -> me)
sortUsersByPresence(friendsRequestedIn).forEach((user) => {
  const row = buildUserRow(user, {
    buttons: [
      { text: "Accept", onClick: () => respondToFriendRequest(user, true) },
      { text: "Reject", onClick: () => respondToFriendRequest(user, false) },
    ],
    preventRowClick: true
  });
  requestsList.appendChild(row);
});

  // Outgoing pending (I sent)
  sortUsersByPresence(friendsPendingOut).forEach((user) => {
    const row = buildUserRow(user, {
      buttons: [
        { text: "Pending…", title: "Waiting for response", onClick: () => {} },
        { text: "Cancel", onClick: () => cancelFriendRequest(user) },
      ],
      preventRowClick: true
    });
    requestsList.appendChild(row);
  });

  // Show placeholder if no requests
  if (!friendsRequestedIn.size && !friendsPendingOut.size) {
    const none = document.createElement("div");
    none.style.fontSize = "12px";
    none.style.color = "#ccc";
    none.textContent = "No pending requests.";
    requestsList.appendChild(none);
  }
}


function renderDiscover() {
  if (!loggedInUser || !presence || !discoverList) return;

  // Get all online users
  const allOnline = new Set(Object.keys(presence));

  // Ensure friend sets exist
  const accepted = friendsAccepted || new Set();
  const pendingOut = friendsPendingOut || new Set();
  const incoming = friendsRequestedIn || new Set();

  // Filter users: not self, not already friends
  const notFriends = [...allOnline].filter(u => u !== loggedInUser && !accepted.has(u));

  // Sort by online presence or other criteria
  const sorted = sortUsersByPresence(notFriends);

  discoverList.innerHTML = "";

  if (!sorted.length) {
    const msg = document.createElement("div");
    msg.style.fontSize = "12px";
    msg.style.color = "#ccc";
    msg.textContent = "No one to discover right now.";
    discoverList.appendChild(msg);
    return;
  }

  // Render each user
  sorted.forEach(user => {
    const isPendingOut = pendingOut.has(user);
    const isIncoming = incoming.has(user);

    const buttons = [];

    if (isPendingOut) {
      buttons.push({ text: "Pending…", onClick: () => {} });
    } else if (isIncoming) {
      buttons.push({ text: "Accept", onClick: () => respondToFriendRequest(user, true) });
    } else {
      buttons.push({ text: "Add", onClick: () => sendFriendRequest(user) });
    }

    const row = buildUserRow(user, { buttons, preventRowClick: true });
    discoverList.appendChild(row);
  });
}



async function sendFriendRequest(toUser) {
  const loggedInUser = localStorage.getItem("loggedInUser");
  if (!loggedInUser) {
    alert("You must be logged in to send friend requests.");
    return;
  }

  if (!toUser || toUser === loggedInUser) return;

  try {
    const res = await fetch(`${BASE_URL}/friends/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromUser: loggedInUser,
        toUser: toUser
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Server returned ${res.status}`);
    }

    console.log(`Friend request sent from ${loggedInUser} to ${toUser}`);
  } catch (err) {
    console.error("Failed to send friend request:", err);
    alert("Failed to send friend request. Check console for details.");
  }
}



/* Controls */
document.getElementById("addFriendBtn").onclick = () => {
  const input = document.getElementById("friendInput");
  sendFriendRequest(input.value);
  input.value = "";
};

const toggleDiscoverBtn = document.getElementById("toggleDiscoverBtn");
toggleDiscoverBtn.onclick = () => {
  const isHidden = getComputedStyle(discoverList).display === "none";
  discoverList.style.display = isHidden ? "block" : "none";
};

async function goOnline() {
  const username = localStorage.getItem("loggedInUser");
  if (!username) return; // skip if not logged in

  async function updateStatus() {
    try {
      await fetch(`${BASE_URL}/online-users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          lastActive: Date.now(),
          avatar: null,   // or pull from your UI/avatar system
          typing: false
        }),
      });
    } catch (err) {
      console.error("Failed to update online status:", err);
    }
  }

  // Mark online immediately
  await updateStatus();

  // Update every 30 seconds
  setInterval(updateStatus, 30000);
}

// Call this when the page loads
goOnline();


// call every 30s
setInterval(goOnline, 30000);

// Run immediately
goOnline();

// Update presence every 30 seconds
setInterval(goOnline, 30000);


// Optional profile live updates for current user
async function fetchUserProfile(username) {
  try {
    const res = await fetch(`${BASE_URL}/users/${username}`);
    if (!res.ok) throw new Error("Failed to fetch profile");
    const data = await res.json();

    // Update avatar in the DOM
    const img = document.querySelector(`.online-user[data-user="${username}"] img`);
    if (img && data.avatar) img.src = data.avatar;
  } catch (err) {
    console.warn("Failed to fetch profile:", err);
  }
}

// Poll the profile every 15 seconds
setInterval(() => fetchUserProfile(loggedInUser), 15000);
fetchUserProfile(loggedInUser); // initial fetch


/* ===== Groups: UI + Data ===== */
const sidebar = document.getElementById("sidebar");


const groupsHeader = document.createElement("h3");
groupsHeader.textContent = "Groups";
const groupsList = document.createElement("div");
groupsList.id = "groupsList";

// + New Group button
const newGroupBtn = document.createElement("button");
newGroupBtn.id = "newGroupBtn";
newGroupBtn.textContent = "+ New Group";
newGroupBtn.style.cssText = `
  width: 100%; padding: 12px; margin-top: 8px; border: none;
  background: linear-gradient(90deg, #386fa4, #2d4a7c); color: #fff;
  font-weight: bold; border-radius: 8px; cursor: pointer;
  transition: transform .2s, box-shadow .2s;
`;
newGroupBtn.onmouseenter = () => (newGroupBtn.style.boxShadow = "0 3px 10px rgba(56,111,164,0.4)");
newGroupBtn.onmouseleave = () => (newGroupBtn.style.boxShadow = "");

// Insert into sidebar
discoverList.insertAdjacentElement("afterend", groupsHeader);
groupsHeader.insertAdjacentElement("afterend", groupsList);
groupsList.insertAdjacentElement("afterend", newGroupBtn);

// Data structures
let myGroups = new Set();                 // e.g., "group:friends"
let groupsMeta = {};                      // key -> { id, members, createdBy, createdAt }

function parseMembers(raw) {
  if (!raw) return [];
  return Array.from(new Set(
    raw.split(",").map(s => s.trim()).filter(Boolean)
  )).filter(u => u.length <= 32);
}

// Event delegation for all group items (dynamically created)
groupsList.addEventListener("click", (e) => {
  const groupEl = e.target.closest(".group-entry");
  if (!groupEl) return;

  const groupName = groupEl.dataset.group;
  if (!groupName) return;

  openTab(`group:${groupName}`);
});

newGroupBtn.onclick = async () => {
  let name = prompt("Enter a group name (letters, numbers, -, _ ; max 30 chars):");
  if (!name) return;
  name = name.trim().toLowerCase().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) return alert("Invalid name.");
  if (name.length > 30) name = name.slice(0, 30);

  const extra = prompt("Add members (comma-separated usernames), optional:");
  const members = parseMembers(extra).filter(u => u !== loggedInUser);

  try {
    const res = await fetch(`${BASE_URL}/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        createdBy: loggedInUser,
        members: [loggedInUser, ...members]
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to create group");

    // Add group to UI immediately
    const groupItem = document.createElement("div");
    groupItem.className = "group-entry";
    groupItem.dataset.group = name;
    groupItem.textContent = name;
    groupItem.style.cssText = `
      padding: 8px 12px; margin-bottom: 6px;
      border-radius: 10px; background: #1b3a73;
      cursor: pointer; transition: all 0.2s;
    `;
    groupItem.onmouseenter = () => groupItem.style.background = "#2a4d8c";
    groupItem.onmouseleave = () => groupItem.style.background = "#1b3a73";
    groupsList.appendChild(groupItem);

    openTab(`group:${name}`);
  } catch (e) {
    console.error(e);
    alert("Could not create group. Check console for details.");
  }
};


async function fetchGroups() {
  try {
    const res = await fetch(`${BASE_URL}/groups?username=` + encodeURIComponent(loggedInUser));
    if (!res.ok) throw new Error("Failed to fetch groups");
    const groups = await res.json();

    groupsList.innerHTML = "";
    myGroups = new Set();
    groupsMeta = {};

    groups.forEach((g) => {
      const id = g.name;
      const key = `group:${id}`;
      if (!Array.isArray(g.members) || !g.members.includes(loggedInUser)) return;

      myGroups.add(key);
      groupsMeta[key] = { id, ...g };

      const div = document.createElement("div");
      div.className = "online-user";
      div.dataset.user = key;

      const left = document.createElement("div");
      left.style.display = "flex";
      left.style.flexDirection = "column";
      const label = document.createElement("span");
      label.textContent = `#${id}`;
      left.appendChild(label);

      const small = document.createElement("span");
      small.className = "last-seen";
      small.textContent = `${g.members.length} member${g.members.length === 1 ? "" : "s"}`;
      left.appendChild(small);
      div.appendChild(left);

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.alignItems = "center";

      const unreadHolder = document.createElement("span");
      unreadHolder.className = "unread-holder";
      right.appendChild(unreadHolder);

      const mkBtn = (txt, title) => {
        const b = document.createElement("button");
        b.textContent = txt;
        b.title = title;
        b.className = "action-btn";
        return b;
      };

      // Invite button
      const inviteBtn = mkBtn("＋", "Invite members");
      inviteBtn.onclick = async (e) => {
        e.stopPropagation();
        const raw = prompt("Usernames to invite (comma-separated):");
        const toAdd = parseMembers(raw).filter(Boolean);
        if (!toAdd.length) return;
        try {
          await fetch(`${BASE_URL}/groups/${id}/invite`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ toAdd })
          });
          fetchGroups(); // refresh after invite
        } catch (err) {
          console.error(err);
          alert("Failed to invite.");
        }
      };
      right.appendChild(inviteBtn);

      // Leave button
      const leaveBtn = mkBtn("⎋", "Leave group");
      leaveBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Leave #${id}?`)) return;
        try {
          await fetch(`${BASE_URL}/groups/${id}/leave`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user: loggedInUser })
          });
          if (activeTab === key) {
            activeTab = "all"; highlightActiveTab(); displayMessages();
          }
          fetchGroups(); // refresh UI
        } catch (err) {
          console.error(err);
          alert("Failed to leave.");
        }
      };
      right.appendChild(leaveBtn);

      // Delete button
      const canDelete = (g.createdBy === loggedInUser) || isAdmin;
      if (canDelete) {
        const delBtn = mkBtn("🗑", "Delete group");
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete #${id} for everyone? This removes history.`)) return;
          try {
            await fetch(`${BASE_URL}/groups/${id}`, { method: "DELETE" });
            if (activeTab === key) {
              activeTab = "all"; highlightActiveTab(); displayMessages();
            }
            fetchGroups(); // refresh UI
          } catch (err) {
            console.error(err);
            alert("Failed to delete group.");
          }
        };
        right.appendChild(delBtn);
      }

      div.appendChild(right);
      div.onclick = () => openTab(key);

      groupsList.appendChild(div);
      updateUnreadBadge(key);
    });
  } catch (err) {
    console.error("Error fetching groups:", err);
  }
}

// Initial load
fetchGroups();

// JS
const avatarInput = document.getElementById("avatarInput");
const myAvatarImg = document.getElementById("myAvatarImg");

// Load saved avatar on page load
const savedAvatar = localStorage.getItem("myAvatar");
if (savedAvatar) {
  myAvatarImg.src = savedAvatar;
}

// Handle file selection
avatarInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) { // 2MB limit
    alert("File too large! Max 2MB.");
    avatarInput.value = "";
    return;
  }

  try {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataURL = ev.target.result;
      localStorage.setItem("myAvatar", dataURL); // Save
      myAvatarImg.src = dataURL; // Update UI
      alert("Profile picture updated!");
    };
    reader.readAsDataURL(file);
  } catch (err) {
    console.error(err);
    alert("Failed to load image.");
  }
});

/* ===== Tabs ===== */
const tabsContainer = document.getElementById("tabs");
let openTabs = {};
let activeTab = "all";

function labelForTab(key) {
  if (key === "all") return "All Chat";
  if (isGroupKey(key)) return `#${groupNameFromKey(key)}`;
  return key;
}

function openTab(key) {
  if (!openTabs[key]) {
    const tab = document.createElement("div");
    tab.className = "tab" + (key === activeTab ? " active" : "");
    tab.dataset.user = key;
    tab.textContent = labelForTab(key);

    if (key !== "all") {
      const closeBtn = document.createElement("span");
      closeBtn.textContent = "✖";
      closeBtn.className = "close-btn";
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        tabsContainer.removeChild(tab);
        delete openTabs[key];
        if (activeTab === key) { activeTab = "all"; highlightActiveTab(); displayMessages(); }
      };
      tab.appendChild(closeBtn);
    }

    tab.onclick = () => {
      activeTab = key;
      if (unreadCounts[key]) unreadCounts[key] = 0;
      if (unreadMessageIds[key]) unreadMessageIds[key].clear();
      updateUnreadBadge(key);
      highlightActiveTab();
      displayMessages();
    };

    openTabs[key] = tab;
    tabsContainer.appendChild(tab);
    updateUnreadBadge(key);
  }

  activeTab = key;
  if (unreadCounts[key]) unreadCounts[key] = 0;
  if (unreadMessageIds[key]) unreadMessageIds[key].clear();
  updateUnreadBadge(key);
  highlightActiveTab();
  displayMessages();
}
function highlightActiveTab() {
  Object.values(openTabs).forEach((tab) => tab.classList.remove("active"));
  if (openTabs[activeTab]) openTabs[activeTab].classList.add("active");
}
// Place this near the top of your main JS file
let replyTarget = null;

window.setReplyTarget = function (message) {
  replyTarget = message;
  document.getElementById("replyText").textContent = `Replying to: ${message.text}`;
  document.getElementById("replyPreview").style.display = "block";
};

window.clearReply = function () {
  replyTarget = null;
  document.getElementById("replyText").textContent = "";
  document.getElementById("replyPreview").style.display = "none";
};


// ================== Globals ==================
if (!loggedInUser) window.location.href = "login.html";

let friendsAccepted = new Set();


// ---------------- Send Message ----------------
async function sendMessage() {
  const noteInput = document.getElementById("noteInput");
  const text = noteInput.value.trim();
  if (!text) return;

  const loggedInUser = localStorage.getItem("loggedInUser");
  if (!loggedInUser) {
    alert("You must be logged in to send messages.");
    window.location.href = "login.html";
    return;
  }

  const isDM = !isGroupKey(activeTab) && activeTab !== "all";
  const isFriend = friendsAccepted.has(activeTab);
  if (isDM && !isFriend) {
    alert("You can only message users you are friends with.");
    return;
  }
  if (isGroupKey(activeTab) && !myGroups.has(activeTab)) {
    alert("You are not a member of this group.");
    return;
  }

  const tempId = `temp-${Date.now()}`;
  const now = Date.now();

  const messagePayload = {
    from_user: loggedInUser,
    to_target: activeTab,
    text: null,
    file_url: null,
    file_name: null,
    reply_to: replyTarget?.id || null,
    timestamp: now,
  };

  if (looksLikeUrl(text)) {
    messagePayload.file_url = text;
    messagePayload.file_name = text.split("/").pop().split("?")[0];
  } else {
    const maxLength = 350;
    if (text.length > maxLength) {
      alert(`Message too long! Limit is ${maxLength} characters.`);
      return;
    }
    messagePayload.text = filterProfanity(text);
  }

  // --- Render temp message ---
  const tempMessage = {
    id: tempId,
    from: loggedInUser,
    to: activeTab,
    text: messagePayload.text,
    fileURL: messagePayload.file_url,
    fileName: messagePayload.file_name,
    replyTo: messagePayload.reply_to,
    timestamp: now,
  };

  renderMessage(tempMessage);

  // Attach delete button to temp
  const tempEl = notesList.querySelector(`[data-id="${tempId}"]`);
  if (tempEl) {
    const delBtn = renderDeleteButton(tempMessage);
    tempEl.appendChild(delBtn);
  }

  renderedMessageIds.add(tempId);
  noteInput.value = "";
  clearReply();

  // --- Send to server ---
  try {
    const res = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messagePayload),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to send message");

    // Update temp to real ID
    if (tempEl) {
      const realId = String(data.id);
      tempEl.dataset.id = realId;
      tempEl.dataset.timestamp = String(data.timestamp || now);

      // Update delete button to use real ID
      const delBtn = tempEl.querySelector(".delete-btn");
      if (delBtn?.updateMessageId) delBtn.updateMessageId(realId);

      renderedMessageIds.delete(tempId);
      renderedMessageIds.add(realId);
    }

  } catch (err) {
    console.error("sendMessage error:", err);
    alert("Failed to send message. Check console for details.");
    if (tempEl) {
      tempEl.remove();
      renderedMessageIds.delete(tempId);
    }
  }
}



const toggleBtn = document.getElementById("toggleSidebar");
const chat = document.getElementById("chatContainer");

// Make sure sidebar starts hidden
sidebar.classList.add("hidden");
chat.style.marginRight = "0";

toggleBtn.addEventListener("click", () => {
  const isHidden = sidebar.classList.contains("hidden");

  if (isHidden) {
    // Show sidebar
    sidebar.classList.remove("hidden");
    sidebar.classList.add("visible");
    chat.style.marginRight = sidebar.offsetWidth + "px";
  } else {
    // Hide sidebar
    sidebar.classList.remove("visible");
    sidebar.classList.add("hidden");
    chat.style.marginRight = "0";
  }
});


document.getElementById("sendBtn").onclick = sendMessage;
document.getElementById("noteInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); sendMessage(); }
});




/* ===== Group message listeners ===== */
let groupUnsubs = {};

// Store active fetch intervals for groups
let groupFetchIntervals = {};

function setupGroupListeners() {
  // Clear old intervals
  Object.values(groupFetchIntervals).forEach(clearInterval);
  groupFetchIntervals = {};

  myGroups.forEach((key) => {
    const groupId = groupNameFromKey(key);

    // Initial fetch
    fetchGroupMessages(key, groupId);

    // Poll every 2-3 seconds
    groupFetchIntervals[key] = setInterval(() => {
      fetchGroupMessages(key, groupId);
    }, 3000);
  });
}

// Fetch messages for a group from server
async function fetchGroupMessages(tabKey, groupId) {
  try {
    const url = new URL(`${BASE_URL}/messages`);
    url.searchParams.set("tab", `group:${groupId}`);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error("Failed to fetch group messages");

    const messages = await res.json();
    messages.forEach(msg => mergeMessage(msg));

    // Remove messages that no longer exist on server
    const existingIds = new Set(messages.map(m => m.id));
    if (messagesByTab[tabKey]) {
      messagesByTab[tabKey] = messagesByTab[tabKey].filter(m => existingIds.has(m.id));
      if (unreadMessageIds[tabKey]) {
        unreadMessageIds[tabKey] = new Set([...unreadMessageIds[tabKey]].filter(id => existingIds.has(id)));
      }
    }

    displayMessages();
  } catch (err) {
    console.error("Error fetching group messages:", err);
  }
}

// Call it whenever your groups list changes
function refreshGroups() {
  // Rebuild UI...
  setupGroupListeners();
}

/* ===== Messages ===== */

if (!notesList) console.error("notesList not found");
let allMessages = [];  // ← Add this so displayMessages can use it



// ================== Globals ==================
let messagesByTab = {}; // key = "all", username, or group:groupName → array of messages
const mutedUsers = new Set();

// Render immediately on load
displayMessages();

// ================== Core ==================
function displayMessages() {
  notesList.innerHTML = "";

  const tabKey = activeTab;
  const messages = messagesByTab[tabKey] || [];

  messages.forEach(({ id, data }) => {
    renderMessage({ id }, data);

    // Mark message as read
    unreadMessageIds[tabKey]?.delete(id);
  });

  notesList.scrollTop = notesList.scrollHeight;

  // Refresh unread badges
  Object.keys(unreadCounts).forEach(updateUnreadBadge);
}

function mergeMessage({ id, data }) {
  let key;

  if (isGroupKey(data.to)) key = data.to;
  else if (data.to === "all") key = "all";
  else key = data.from === loggedInUser ? data.to : data.from;

  if (!messagesByTab[key]) messagesByTab[key] = [];

  // Remove duplicates, then push
  messagesByTab[key] = messagesByTab[key].filter(m => m.id !== id);
  messagesByTab[key].push({ id, data });

  // Track unread
  const isDMToMe =
    key !== "all" &&
    !isGroupKey(key) &&
    data.to === loggedInUser &&
    data.from !== loggedInUser;

  const isBroadcastToAll = key === "all" && data.from !== loggedInUser;
  const isGroupMsgToOthers =
    isGroupKey(key) && data.from !== loggedInUser && !myGroups.has(key);

  if (isDMToMe || isBroadcastToAll || isGroupMsgToOthers) {
    if (!unreadMessageIds[key]) unreadMessageIds[key] = new Set();
    if (!unreadMessageIds[key].has(id)) {
      unreadMessageIds[key].add(id);
      unreadCounts[key] = (unreadCounts[key] || 0) + 1;
    }
  }
}

function scrollToBottom(force = false) {
  const chatContainer = document.getElementById("notesList"); // chat area
  if (!chatContainer) return;

  const threshold = 100; // px from bottom
  const isNearBottom =
    chatContainer.scrollTop + chatContainer.clientHeight >=
    chatContainer.scrollHeight - threshold;

  if (force || isNearBottom) {
    // Use requestAnimationFrame to avoid recursive reflows
    requestAnimationFrame(() => {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    });
  }
}




// ---------------- Render Single Message ----------------
function renderMessage(data) {
  if (!data || !notesList) return;

  const from = data.from_user || data.from;
  const to = data.to_target || data.to;
  const ts = data.timestamp ? Number(data.timestamp) : Date.now();
  if (!from || !to) return;
  if (mutedUsers.has(from)) return;

  const isDM = to !== "all" && !isGroupKey(to);
  if (isDM && !(from === loggedInUser || to === loggedInUser)) return;
  if (isGroupKey(to) && !myGroups.has(to)) return;

  const realId = String(data.id);
  if (renderedMessageIds.has(realId) ||
      notesList.querySelector(`[data-id="${CSS.escape(realId)}"]`)) {
    return;
  }

  const div = document.createElement("div");
  div.className = "note-item";
  div.dataset.id = realId;
  div.dataset.from = from;
  div.dataset.to = to;
  div.dataset.timestamp = ts;

  // Reply preview
  if (data.reply_to || data.replyTo) {
    const replyEl = renderReplyPreview(data.reply_to || data.replyTo);
    if (replyEl) div.appendChild(replyEl);
  }

  // Avatar
  const avatarEl = renderAvatar(from);
  if (avatarEl) div.appendChild(avatarEl);

  // Message content
  if (data.text) {
    const contentEl = renderContent({ ...data, from, to });
    if (contentEl) div.appendChild(contentEl);
  }

  // File attachment
  if (data.file_url || data.fileURL) {
    const attachmentEl = renderAttachment({ ...data, fileURL: data.file_url || data.fileURL });
    if (attachmentEl) div.appendChild(attachmentEl);
  }

  // Timestamp
  const tsEl = renderTimestamp(ts);
  if (tsEl) div.appendChild(tsEl);

  // Styling
  if (ADMIN_USERS.includes(from)) div.classList.add("admin-message");
  if (from === loggedInUser) div.classList.add("own-message");
  else if (to === loggedInUser && to !== "all") div.classList.add("private-message");

  // Reply button
  const replyBtn = renderReplyButton(realId, { ...data, from, to });
  if (replyBtn) div.appendChild(replyBtn);

  // Delete button (works for temp → real)
  if (canDeleteMessage(data)) {
    const delBtn = renderDeleteButton({ ...data, id: realId });
    if (delBtn) div.appendChild(delBtn);
  }

  notesList.appendChild(div);
  notesList.scrollTop = notesList.scrollHeight;

  renderedMessageIds.add(realId);
}






// ================== Helpers ==================
// ---------------- Auto-delete Message ----------------
async function autoDeleteMessage(msg) {
  // Determine backend ID
  const id = msg.id;
  if (!id) return;

  try {
    const res = await fetch(`${BASE_URL}/messages/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) throw new Error("Failed to delete message on server");

    console.log("Deleted old message from server:", id);

    // Remove locally if still in DOM
    if (notesList) {
      const el = notesList.querySelector(`[data-id="${id}"]`);
      if (el) el.remove();
    }
  } catch (err) {
    console.error("autoDeleteMessage error:", err);
  }
}


function renderReplyPreview(replyToId) {
  const replyDiv = document.createElement("div");
  Object.assign(replyDiv.style, {
    fontSize: "11px",
    color: "#888",
    borderLeft: "2px solid #555",
    paddingLeft: "6px",
    marginBottom: "4px",
  });

  replyDiv.textContent = "↩ Replying...";

  const repliedMessage = document.querySelector(`[data-id="${replyToId}"]`);
  if (repliedMessage) {
    const span = repliedMessage.querySelector("span");
    if (span) replyDiv.textContent = `↩ ${span.textContent}`;
  }
  return replyDiv;
}

function renderAvatar(username) {
  const img = document.createElement("img");
  img.src = `https://i.pravatar.cc/30?u=${username}`;
  return img;
}

function renderContent(data) {
  const span = document.createElement("span");

  if (isGroupKey(data.to)) {
    span.textContent = `#${groupNameFromKey(data.to)} • ${data.from}: ${
      data.text || data.fileName || ""
    }`;
  } else if (data.to !== "all" && data.to === loggedInUser) {
    span.textContent = `${data.from} → you: ${data.text || data.fileName || ""}`;
  } else if (data.to !== "all" && data.from === loggedInUser) {
    span.textContent = `you → ${data.to}: ${data.text || data.fileName || ""}`;
  } else {
    span.textContent = `${data.from}: ${data.text || data.fileName || ""}`;
  }

  return span;
}

function renderAttachment(data) {
  const frag = document.createDocumentFragment();

  const fileLink = document.createElement("a");
  fileLink.href = data.fileURL;
  fileLink.target = "_blank";
  fileLink.rel = "noopener noreferrer";
  fileLink.textContent = data.fileName || "File";
  fileLink.style.color = "#ff8800";
  fileLink.style.textDecoration = "underline";
  frag.appendChild(document.createTextNode(" "));
  frag.appendChild(fileLink);

  if (isImageUrl(data.fileURL)) {
    const preview = document.createElement("img");
    preview.src = data.fileURL;
    preview.alt = data.fileName || "attachment";
    Object.assign(preview.style, {
      width: "120px",
      height: "auto",
      borderRadius: "8px",
      marginLeft: "8px",
      cursor: "pointer",
    });
    preview.onclick = () => window.open(data.fileURL, "_blank");
    frag.appendChild(preview);
  }
  return frag;
}

function renderTimestamp(timestamp) {
  const span = document.createElement("span");
  span.className = "timestamp";
  Object.assign(span.style, {
    marginLeft: "8px",
    fontSize: "11px",
    color: "#aaa",
  });
  span.textContent = timeAgo(timestamp);
  return span;
}

function renderReplyButton(id, data) {
  const btn = document.createElement("button");
  btn.textContent = "↩";
  btn.className = "reply-btn";
  btn.title = "Reply to this message";
  btn.onclick = (e) => {
    e.stopPropagation();
    setReplyTarget({ id, text: data.text || data.fileName || "" });
  };
  return btn;
}

// ================== Delete Button Helper ==================
// ---------------- Delete Button Helper ----------------
function renderDeleteButton(msg) {
  const btn = document.createElement("button");
  btn.textContent = "✖";
  btn.className = "delete-btn";
  btn.title = "Delete message";

  // Internal message ID (starts as temp or real)
  let messageId = msg.id;

  // Allow updating the ID when temp -> real
  btn.updateMessageId = (newId) => {
    messageId = newId;
  };

  btn.onclick = async (e) => {
    e.stopPropagation();

    const el = notesList.querySelector(`[data-id="${CSS.escape(messageId)}"]`);
    if (!el) return;

    const isTemp = String(messageId).startsWith("temp-");

    // Remove locally immediately
    el.remove();
    renderedMessageIds.delete(messageId);

    // Temp message: no server call yet
    if (isTemp) return;

    try {
      const target = isGroupKey(msg.to) ? `group:${groupNameFromKey(msg.to)}` : msg.to;

      const res = await fetch(`${BASE_URL}/messages/${encodeURIComponent(messageId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tab: target }),
      });

      if (!res.ok) throw new Error("Failed to delete message");

      // Optional: remove from cache
      if (messagesByTab[target]) {
        messagesByTab[target] = messagesByTab[target].filter(m => m.id !== messageId);
        if (unreadMessageIds[target]) unreadMessageIds[target].delete(messageId);
        displayMessages();
      }

    } catch (err) {
      console.error(err);
      alert("Failed to delete message.");
    }
  };

  return btn;
}






// ================== Permission Check ==================
function canDeleteMessage(data) {
  if (isAdmin || data.from === loggedInUser) return true;

  if (isGroupKey(data.to)) {
    const group = groupsMeta[data.to];
    if (group?.createdBy === loggedInUser) return true;
  }
  return false;
}




function updateUnreadBadge(user) {
  const row = document.querySelector(`.online-user[data-user="${CSS.escape(user)}"]`);
  if (!row) return;

  let count = unreadCounts[user] || 0;

  // Also count messages in DM tabs even if not friends
  if (user !== "all" && !friendsAccepted.has(user)) {
    const messages = messagesByTab[user] || [];
    count = messages.filter(m => m.from === user && m.to === loggedInUser).length;
  }

  let holder = row.querySelector(".unread-holder");
  if (!holder) {
    holder = document.createElement("span");
    holder.className = "unread-holder";
    row.appendChild(holder);
  }

  holder.innerHTML = "";
  if (count > 0) {
    const badge = document.createElement("span");
    badge.className = "unread-badge";
    badge.textContent = count;
    holder.appendChild(badge);
  }
}

/* Init */
document.getElementById("chatAllBtn").onclick = () => openTab("all");
openTab("all");



/* Attachments (paste a URL) */
const attachBtn = document.getElementById("attachBtn");

attachBtn.onclick = async () => {
  const url = prompt(
    "Paste a direct link to an image/file (e.g., https://i.imgur.com/abc123.png):"
  );
  if (!url) return;

  const targetIsGroup = isGroupKey(activeTab);
  const groupId = targetIsGroup ? groupNameFromKey(activeTab) : null;

  const payload = {
    text: "",
    from: loggedInUser,
    to: activeTab,
    timestamp: Date.now(),
    fileURL: url,
    fileName: url.split("/").pop().split("?")[0],
  };

  try {
    const res = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error("Failed to send attachment");

    // Reset input or UI if needed
    document.getElementById("noteInput").value = "";
    clearReply();

    // Optional: mark typing as false
    await fetch(`${BASE_URL}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: loggedInUser, typing: false }),
    });
  } catch (err) {
    console.error(err);
    alert("Failed to send attachment. Check console.");
  }
};


/* Inline color picker */
window.changeBackground = function changeBackground() {
  const notesList2 = document.getElementById("notesList");
  const val = document.getElementById("bgSelector").value;
  notesList2.style.backgroundColor = val;
};

/* News modal behavior */
const NEWS_VERSION = "1"; // bump when you change content
const newsOverlay = document.getElementById("newsOverlay");
const showNews = () => { newsOverlay.style.display = "flex"; };
const hideNews = () => { newsOverlay.style.display = "none"; };

// Open once if not seen
if (localStorage.getItem("kitchatty_news_version") !== NEWS_VERSION) {
  showNews();
}

document.getElementById("closeNewsBtn").onclick = hideNews;
document.getElementById("ackNewsBtn").onclick = () => { hideNews(); localStorage.setItem("kitchatty_news_version", NEWS_VERSION); };
document.getElementById("dontShowNewsBtn").onclick = () => { localStorage.setItem("kitchatty_news_version", NEWS_VERSION); hideNews(); };
document.getElementById("showNewsBtn").onclick = showNews;

// Escape key closes
window.addEventListener("keydown", (e) => { if (e.key === "Escape") hideNews(); });

/* Lightweight runtime checks */
console.assert(typeof window.changeBackground === "function", "changeBackground not attached to window");


// Utility: how long ago
function timeAgo(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}



// ================== Typing State ==================
let isTyping = false;
let lastTyped = 0;
const TYPING_DELAY = 3000; // 3s after last keystroke
const CHECK_INTERVAL = 2000; // polling interval

const messageInput = document.getElementById("noteInput");
const typingIndicator = document.getElementById("typingIndicator");

// --- Update typing state locally ---
messageInput.addEventListener("input", async () => {
  lastTyped = Date.now();

  if (!isTyping) {
    isTyping = true;
    try {
      await fetch(`${BASE_URL}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loggedInUser, typing: true, lastUpdate: lastTyped })
      });
    } catch (err) {
      console.warn("Failed to update typing status:", err);
    }
  }
});

// --- Periodically check if user stopped typing ---
setInterval(async () => {
  if (isTyping && Date.now() - lastTyped > TYPING_DELAY) {
    isTyping = false;
    try {
      await fetch(`${BASE_URL}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loggedInUser, typing: false, lastUpdate: Date.now() })
      });
    } catch (err) {
      console.warn("Failed to update typing status:", err);
    }
  }
}, CHECK_INTERVAL);

// --- Watch all users' typing status ---
async function watchAllTypingStatus() {
  const now = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/presence`);
    const users = await res.json(); // [{username, typing, lastUpdate}, ...]

    const activeTyping = users
      .filter(u => u.typing && u.lastUpdate && now - u.lastUpdate < 7000 && u.username !== loggedInUser)
      .map(u => u.username);

    typingIndicator.textContent = activeTyping.length
      ? activeTyping.join(", ") + " is typing..."
      : "";
  } catch (err) {
    console.warn("Failed to fetch typing status:", err);
  }
}

// Poll typing status
setInterval(watchAllTypingStatus, CHECK_INTERVAL);



// ---------------- Helpers ----------------
function findMatchingTemp(mapped) {
  // Try to match by from/to + content + close timestamp
  const msgText = (mapped.text || mapped.fileURL || "").trim();
  const candidates = notesList.querySelectorAll('.note-item[data-id^="temp-"]');

  for (const el of candidates) {
    const elText =
      (el.querySelector(".note-content")?.textContent ||
       el.querySelector(".attachment-name")?.textContent ||
       "").trim();

    const timeDiff = Math.abs(Number(el.dataset.timestamp || 0) - Number(mapped.timestamp || 0));

    if (
      el.dataset.from === mapped.from &&
      el.dataset.to === mapped.to &&
      elText === msgText &&
      timeDiff < 15000 // 15s window to be tolerant of clock drift
    ) {
      return el;
    }
  }
  return null;
}





// ---------------- Watch Messages (safe polling, all messages) ----------------
async function watchMessages() {
  if (!notesList) return;

  const target = "all"; // always fetch global messages
  const isInitial = !initialSyncDone[target];

  try {
    const res = await fetch(`${BASE_URL}/messages?target=${encodeURIComponent(target)}`);

    // Attempt to parse JSON safely
    let messages;
    const contentType = res.headers.get("content-type");

    if (!res.ok) {
      console.warn("Failed to fetch messages, status:", res.status);
      return;
    }

    if (contentType && contentType.includes("application/json")) {
      messages = await res.json();
      if (!Array.isArray(messages)) {
        console.warn("Messages response is not an array:", messages);
        return;
      }
    } else {
      const text = await res.text();
      console.warn("Expected JSON but got non-JSON response:", text);
      return;
    }

    messages.forEach(msg => {
      if (!msg || typeof msg !== "object") return;

      const mapped = {
        id: String(msg.id),
        from: msg.from_user || "",
        to: msg.to_target || "",
        text: msg.text || "",
        fileURL: msg.file_url || null,
        fileName: msg.file_name || null,
        replyTo: msg.reply_to ?? null,
        timestamp: msg.timestamp ? Number(msg.timestamp) : Date.now()
      };

      if (!mapped.from || !mapped.to) return;

      const isMine = mapped.from === loggedInUser;

      // --- Replace temp bubble if exists ---
      const tempEl = Array.from(notesList.querySelectorAll(".note-item"))
        .find(el =>
          el.dataset.id.startsWith("temp-") &&
          el.dataset.from === mapped.from &&
          el.dataset.to === mapped.to &&
          (el.querySelector(".note-content")?.textContent || "") === (mapped.text || mapped.fileURL || "") &&
          Math.abs(Number(el.dataset.timestamp) - mapped.timestamp) < 5000
        );

      if (tempEl) {
        renderedMessageIds.delete(tempEl.dataset.id);
        tempEl.dataset.id = mapped.id;
        tempEl.dataset.timestamp = String(mapped.timestamp);
        renderedMessageIds.add(mapped.id);
        return;
      }

      // --- Skip if already rendered ---
      if (renderedMessageIds.has(mapped.id) ||
          notesList.querySelector(`[data-id="${CSS.escape(mapped.id)}"]`)) {
        return;
      }

      // --- Own messages: render only if initial load ---
      if (isMine && !isInitial) return;

      renderMessage(mapped);
    });

  } catch (err) {
    console.error("Error fetching messages:", err);
  } finally {
    initialSyncDone[target] = true;
  }
}




// Optionally poll for new messages every few seconds
setInterval(() => watchMessages(activeTab), 2000);


