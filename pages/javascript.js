// =========================================================
// LOAD CURRENT USER INFO (for navbar + post box)
// =========================================================

async function loadMyInfo() {
  const res = await api("/me");
  const data = await res.json();

  window.isGuest = data.guest;
  window.currentUserId = data.id;
  window.unreadNotifications = data.unreadNotifications || 0;

  if (!data.guest) {
    createNotificationElements();
    fetchNotifications(true);
    setInterval(() => fetchNotifications(), 20000);
  }


  
 


  // Navbar buttons
  const loginBtn = document.getElementById("loginBtn");
  const signupBtn = document.getElementById("signupBtn");
  const profileBtn = document.getElementById("profileBtn");
  const logoutBtn = document.getElementById("logoutBtn");

const postBox = document.querySelector(".post-box");
if (postBox) {
  if (data.guest) postBox.style.display = "none";
  else postBox.style.display = "block";
}

if (data.guest) {
  const inputBox = document.getElementById("inputBox");
  if (inputBox) inputBox.disabled = true;
}


  if (data.loggedIn) {
    if (loginBtn) loginBtn.style.display = "none";
    if (signupBtn) signupBtn.style.display = "none";
    if (profileBtn) profileBtn.style.display = "inline-block";
    if (logoutBtn) logoutBtn.style.display = "inline-block";
  } else {
    if (loginBtn) loginBtn.style.display = "inline-block";
    if (signupBtn) signupBtn.style.display = "inline-block";
    if (profileBtn) profileBtn.style.display = "none";
    if (logoutBtn) logoutBtn.style.display = "none";
  }

  // Post box user info
  if (document.getElementById("myPfp"))
    document.getElementById("myPfp").src = data.profilePic || "/default.png";

  if (document.getElementById("myName"))
    document.getElementById("myName").textContent = data.username || "Guest";

  
}

function createNotificationElements() {
  if (document.getElementById('notificationWidget')) return;

  const container = document.createElement('div');
  container.id = 'notificationWidget';
  container.innerHTML = `
    <button id="notificationToggleBtn" class="notification-toggle">
      🔔 <span id="notificationBadge" class="notification-badge"></span>
    </button>
    <div id="notificationPanel" class="notification-panel hidden">
      <div class="notification-panel-header">
        <span>Notifications</span>
        <button id="markReadBtn" class="mark-read-btn">Mark all read</button>
      </div>
      <div id="notificationList" class="notification-list"></div>
    </div>
    <div id="notificationToast" class="notification-toast hidden">
      <span id="notificationToastText"></span>
      <button id="notificationCloseBtn" class="notification-close-btn">×</button>
    </div>
  `;
  document.body.appendChild(container);

  const toggle = document.getElementById('notificationToggleBtn');
  const panel = document.getElementById('notificationPanel');
  const closeBtn = document.getElementById('notificationCloseBtn');
  const markReadBtn = document.getElementById('markReadBtn');

  toggle.addEventListener('click', () => {
    panel.classList.toggle('hidden');
  });

  closeBtn.addEventListener('click', () => {
    document.getElementById('notificationToast').classList.add('hidden');
  });

  markReadBtn.addEventListener('click', async () => {
    await api('/notifications/mark-read', { method: 'POST' });
    window.unreadNotifications = 0;
    updateNotificationIcon(0);
    fetchNotifications(true);
  });
}

function showNotificationToast(message) {
  const toast = document.getElementById('notificationToast');
  const text = document.getElementById('notificationToastText');
  if (!toast || !text) return;
  text.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 5000);
}

async function fetchNotifications(silent = false) {
  const res = await api('/notifications');
  if (!res.ok) return;
  const data = await res.json();

  updateNotificationIcon(data.unread || 0);
  renderNotifications(data.notifications || []);

  if (data.notifications && data.notifications.length > 0) {
    const first = data.notifications[0];
    if (silent) {
      window.lastNotificationId = first.id;
    } else if (first && window.lastNotificationId !== first.id) {
      showNotificationToast(first.payload ? JSON.parse(first.payload).message : 'You have a new notification');
      window.lastNotificationId = first.id;
    }
  }
}


function updateNotificationIcon(count) {
  const badge = document.getElementById('notificationBadge');
  if (!badge) return;
  badge.textContent = count > 0 ? count : '';
}

function renderNotifications(items) {
  const list = document.getElementById('notificationList');
  if (!list) return;
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<div class="notification-empty">No notifications yet.</div>';
    return;
  }

  items.forEach(item => {
    const payload = item.payload ? JSON.parse(item.payload) : {};
    const row = document.createElement('div');
    row.className = `notification-item ${item.read ? 'read' : 'unread'}`;

    const messageHtml = `
      <div class="notification-item-text">${payload.message || 'New activity'}</div>
      <div class="notification-item-meta">${new Date(item.created).toLocaleString()}</div>
    `;

    row.innerHTML = `
      <div class="notification-content">${messageHtml}</div>
      <button class="notification-dismiss-btn">Dismiss</button>
    `;

    row.addEventListener('click', (evt) => {
      if (evt.target.classList.contains('notification-dismiss-btn')) return;
      navigateNotification(item);
    });

    const dismissBtn = row.querySelector('.notification-dismiss-btn');
    dismissBtn.addEventListener('click', async (evt) => {
      evt.stopPropagation();
      await api(`/notifications/${item.id}/dismiss`, { method: 'POST' });
      row.remove();
      const badge = document.getElementById('notificationBadge');
      if (badge) {
        const count = parseInt(badge.textContent || '0', 10) - 1;
        badge.textContent = count > 0 ? count : '';
      }
    });

    list.appendChild(row);
  });
}

function navigateNotification(item) {
  const payload = item.payload ? JSON.parse(item.payload) : {};

  if (item.type === 'comment' || item.type === 'like') {
    if (payload.postId) {
      const target = `/post.html?id=${payload.postId}` + (payload.commentId ? `?highlightCommentId=${payload.commentId}` : '');
      window.location.href = target;
      return;
    }
  }

  if (item.type === 'follow_request' || item.type === 'follow_accept') {
    if (payload.fromUserId) {
      window.location.href = `/user.html?id=${payload.fromUserId}`;
      return;
    }
  }

  if (payload.fromUserId) {
    window.location.href = `/user.html?id=${payload.fromUserId}`;
  }
}

window.loadMyInfoPromise = loadMyInfo();


// =========================================================
// NAVBAR BUTTON CLICK HANDLERS
// =========================================================

document.addEventListener("DOMContentLoaded", () => {
  const loginBtn = document.getElementById("loginBtn");
  const signupBtn = document.getElementById("signupBtn");
  const profileBtn = document.getElementById("profileBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  if (loginBtn) loginBtn.onclick = () => location.href = "/login.html";
  if (signupBtn) signupBtn.onclick = () => location.href = "/signup.html";
  if (profileBtn) profileBtn.onclick = () => location.href = "/profile.html";

  if (logoutBtn) {
    logoutBtn.onclick = async () => {
      await api("/logout", { method: "POST" });
      location.href = "/";
    };
  }
});


// =========================================================
// SEND MESSAGE (POST CREATION)
// =========================================================

const inputBox = document.getElementById("inputBox");

if (inputBox) {
  inputBox.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && inputBox.value.trim() !== "") {
      const message = inputBox.value.trim();
      inputBox.value = "";

      await api("/save-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });

      // Reload your posts
      if (document.getElementById("myPosts")) loadMyPosts();
    }
  });
}


// =========================================================
// LOAD YOUR OWN POSTS (PROFILE PAGE)
// =========================================================

function createPostCard(post) {
  const card = document.createElement('div');
  card.className = 'global-post';
  card.dataset.postId = post.id;

  const userLink = `<a href="/user.html?id=${post.userId}">${post.username || 'Guest'}</a>`;

  card.innerHTML = `
    <div class="global-post-header">
      <img src="${post.profilePic || '/default.png'}">
      <div class="global-post-username">${userLink}</div>
    </div>

    <div class="global-post-text">${formatPostText(post.text)}</div>

    <div class="post-actions">
      <button class="like-btn ${post.userVote === 1 ? 'active' : ''}">👍</button>
      <span class="like-count">${post.likes || 0}</span>

      <button class="dislike-btn ${post.userVote === -1 ? 'active' : ''}">👎</button>
      <span class="dislike-count">${post.dislikes || 0}</span>

      <button class="comment-toggle-btn">💬</button>
      <span class="comment-count">0</span>
    </div>

    <div class="comments-section" data-expanded="false">
      <div class="comments-list"></div>
      <div class="comment-form">
        <input class="comment-input" placeholder="Write a comment...">
        <button class="comment-send-btn">Send</button>
      </div>
    </div>
  `;

  // Attach event listeners
  const likeBtn = card.querySelector('.like-btn');
  const dislikeBtn = card.querySelector('.dislike-btn');
  const commentToggle = card.querySelector('.comment-toggle-btn');
  const commentSend = card.querySelector('.comment-send-btn');
  const commentInput = card.querySelector('.comment-input');
  const commentsList = card.querySelector('.comments-list');
  const commentsSection = card.querySelector('.comments-section');
  const likeCountEl = card.querySelector('.like-count');
  const dislikeCountEl = card.querySelector('.dislike-count');
  const commentCountEl = card.querySelector('.comment-count');
  const commentForm = card.querySelector('.comment-form');

  // Hide comment form for guests
  if (window.isGuest) {
    commentForm.style.display = "none";
  }

  // Ensure comments section is visible so top comment can show
  commentsSection.style.display = "block";
  commentsSection.dataset.expanded = "false";

  // ⭐ Load top comment immediately
  api(`/post/${post.id}/comments`)
    .then(r => r.json())
    .then(comments => {
      commentCountEl.textContent = comments.length;

      commentsList.innerHTML = ""; // clear

      if (comments.length > 0) {
        const top = comments[0];
        const el = document.createElement("div");
        el.className = "comment";
        el.innerHTML = `
          <img src="${top.profilePic || '/default.png'}">
          <strong>${top.username || "Unknown"}</strong>
          <div>${escapeHtml(top.text)}</div>
        `;
        commentsList.appendChild(el);
      }
    });

  // LIKE
  likeBtn.addEventListener('click', async () => {
    if (window.isGuest) return alert("You must be logged in to like posts.");
    await votePost(post.id, 1, likeCountEl, dislikeCountEl, likeBtn, dislikeBtn);
  });

  // DISLIKE
  dislikeBtn.addEventListener('click', async () => {
    if (window.isGuest) return alert("You must be logged in to dislike posts.");
    await votePost(post.id, -1, likeCountEl, dislikeCountEl, likeBtn, dislikeBtn);
  });

  // ⭐ COMMENT TOGGLE (expand/collapse)
  commentToggle.addEventListener('click', async () => {
    const expanded = commentsSection.dataset.expanded === 'true';

    if (expanded) {
      // COLLAPSE → show only top comment
      commentsSection.dataset.expanded = 'false';

      const comments = await api(`/post/${post.id}/comments`).then(r => r.json());
      commentCountEl.textContent = comments.length;

      commentsList.innerHTML = "";

      if (comments.length > 0) {
        const top = comments[0];
        const el = document.createElement("div");
        el.className = "comment";
        el.innerHTML = `
          <img src="${top.profilePic || '/default.png'}">
          <strong>${top.username || "Unknown"}</strong>
          <div>${escapeHtml(top.text)}</div>
        `;
        commentsList.appendChild(el);
      }

      return;
    }

    // EXPAND → show top 10 comments
    commentsSection.dataset.expanded = 'true';

    const comments = await api(`/post/${post.id}/comments`).then(r => r.json());
    commentCountEl.textContent = comments.length;

    commentsList.innerHTML = "";

    const top10 = comments.slice(0, 10);

    top10.forEach(c => {
      const el = document.createElement("div");
      el.className = "comment";
      el.innerHTML = `
        <img src="${c.profilePic || '/default.png'}">
        <strong>${c.username || "Unknown"}</strong>
        <div>${escapeHtml(c.text)}</div>
      `;
      commentsList.appendChild(el);
    });

    // SEE MORE BUTTON
    if (comments.length > 10) {
      const seeMore = document.createElement("button");
      seeMore.textContent = "See more comments";
      seeMore.className = "see-more-comments";

      seeMore.onclick = () => {
        commentsList.innerHTML = "";
        comments.forEach(c => {
          const el = document.createElement("div");
          el.className = "comment";
          el.innerHTML = `
            <img src="${c.profilePic || '/default.png'}">
            <strong>${c.username || "Unknown"}</strong>
            <div>${escapeHtml(c.text)}</div>
          `;
          commentsList.appendChild(el);
        });
        seeMore.remove();
      };

      commentsList.appendChild(seeMore);
    }
  });

  // SEND COMMENT
  commentSend.addEventListener('click', async () => {
    if (window.isGuest) return alert("You must be logged in to comment.");

    const text = commentInput.value.trim();
    if (!text) return;

    const res = await api(`/post/${post.id}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    const newComment = await res.json();

    const el = document.createElement('div');
    el.className = 'comment';
    el.innerHTML = `
      <img src="${newComment.profilePic || '/default.png'}">
      <strong>${newComment.username}</strong>
      <div>${escapeHtml(newComment.text)}</div>
    `;
    commentsList.appendChild(el);

    commentInput.value = '';
    commentCountEl.textContent = parseInt(commentCountEl.textContent) + 1;
  });

  return card;
}


// =========================================================
// LOAD YOUR OWN POSTS (PROFILE PAGE)
// =========================================================

async function loadMyPosts() {
  const container = document.getElementById("myPosts");
  if (!container) return;

  const res = await api("/my-posts");
  const posts = await res.json();

  container.innerHTML = "";

  posts.forEach(post => {
    const card = document.createElement("div");
    card.className = "msg-card";
    card.dataset.postId = post.id;
    
    const isDeleted = post.deleted === 1;
    const statusLabel = isDeleted ? ' <span style="color:red; font-size:12px;">(deleted)</span>' : '';
    
    card.innerHTML = `
      <div class="msg-text">${escapeHtml(post.text)}${statusLabel}</div>
      <div style="display:flex; gap:10px; margin-top:10px;">
        ${isDeleted ? '<span style="color:#999; font-size:12px;">Post deleted</span>' : `<button class="delete-post-btn" data-post-id="${post.id}" style="padding:4px 8px; background:#ff4444; color:white; border:none; border-radius:4px; cursor:pointer;">Delete</button>`}
      </div>
    `;
    
    container.appendChild(card);
    
    // Add delete handler
    if (!isDeleted) {
      const deleteBtn = card.querySelector('.delete-post-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          if (confirm('Are you sure you want to delete this post?')) {
            const res = await api(`/post/${post.id}/delete`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
              loadMyPosts(); // Refresh
            } else {
              alert(data.error || 'Failed to delete post');
            }
          }
        });
      }
    }
  });
}

if (document.getElementById("myPosts")) loadMyPosts();


// =========================================================
// GLOBAL FEED + INFINITE SCROLL
// =========================================================

let globalOffset = 0;
const globalLimit = 20;
let globalLoading = false;

async function loadGlobalPosts() {
  const feed = document.getElementById("globalFeed");
  if (!feed) return;

  if (globalLoading) return;
  globalLoading = true;

  const res = await api(`/global-feed?limit=${globalLimit}&offset=${globalOffset}`);
  const posts = await res.json();

  posts.forEach(post => {
    feed.appendChild(createPostCard(post));
  });

  globalOffset += globalLimit;
  globalLoading = false;
}

if (document.getElementById("globalFeed")) {
  loadGlobalPosts();

  window.addEventListener("scroll", () => {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 200) {
      loadGlobalPosts();
    }
  });
}


// =========================================================
// LIKE / DISLIKE HELPER
// =========================================================

async function votePost(postId, value, likeCountEl, dislikeCountEl, likeBtn, dislikeBtn) {
  const res = await api(`/post/${postId}/like`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value })
  });

  const data = await res.json();

  likeCountEl.textContent = data.likes;
  dislikeCountEl.textContent = data.dislikes;

  likeBtn.classList.toggle('active', data.userVote === 1);
  dislikeBtn.classList.toggle('active', data.userVote === -1);
}


// limit for texts

if (inputBox) {
  inputBox.addEventListener("keydown", async (e) => {
    if (inputBox.value.length > 100) {
      inputBox.value = inputBox.value.slice(0, 100);
    }
  });
}





// =========================================================
// HTML ESCAPE (security)
// =========================================================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Format post text: escape HTML then make hashtags clickable
function formatPostText(str) {
  const escaped = escapeHtml(str);
  return escaped.replace(/#([a-zA-Z0-9_]+)/g, '<a href="/hashtag.html?tag=$1" class="hashtag">#$1</a>');
}


// =========================================================
// ENGAGEMENT TRACKER
// Measures how long each post is visible on screen (viewport
// time via IntersectionObserver) and how long the cursor
// hovers over it. Batches events and sends every 10 seconds.
// These are very slight signals — they don't override likes
// or dislikes, they just add passive engagement data.
// =========================================================

(function() {
  const engagementData = {}; // postId -> { viewStart, viewMs, hoverStart, hoverMs }

  function getEntry(postId) {
    if (!engagementData[postId]) {
      engagementData[postId] = { viewStart: null, viewMs: 0, hoverStart: null, hoverMs: 0 };
    }
    return engagementData[postId];
  }

  // IntersectionObserver: track when posts enter/leave the viewport
  const viewObserver = new IntersectionObserver((entries) => {
    const now = Date.now();
    entries.forEach(entry => {
      const postId = entry.target.dataset.postId;
      if (!postId) return;
      const data = getEntry(postId);

      if (entry.isIntersecting) {
        data.viewStart = now;
      } else if (data.viewStart) {
        data.viewMs += now - data.viewStart;
        data.viewStart = null;
      }
    });
  }, { threshold: 0.5 }); // post must be 50% visible

  // Track a single post card element
  function trackPost(el) {
    if (el._engTracked) return;
    el._engTracked = true;
    const postId = el.dataset.postId;
    if (!postId) return;

    viewObserver.observe(el);

    el.addEventListener('mouseenter', () => {
      const data = getEntry(postId);
      data.hoverStart = Date.now();
    });
    el.addEventListener('mouseleave', () => {
      const data = getEntry(postId);
      if (data.hoverStart) {
        data.hoverMs += Date.now() - data.hoverStart;
        data.hoverStart = null;
      }
    });
  }

  // MutationObserver: catch posts as they are added to the DOM
  const domObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList && node.classList.contains('global-post') && node.dataset.postId) {
          trackPost(node);
        }
        if (node.querySelectorAll) {
          node.querySelectorAll('.global-post[data-post-id]').forEach(trackPost);
        }
      }
    }
  });
  domObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Also track any posts already in the DOM
  function observeExisting() {
    document.querySelectorAll('.global-post[data-post-id]').forEach(trackPost);
  }

  // Flush engagement data to server every 10 seconds
  function flush() {
    if (window.isGuest) return;

    const now = Date.now();
    const events = [];

    for (const [postId, data] of Object.entries(engagementData)) {
      let viewMs = data.viewMs;
      if (data.viewStart) {
        viewMs += now - data.viewStart;
        data.viewStart = now;
      }
      let hoverMs = data.hoverMs;
      if (data.hoverStart) {
        hoverMs += now - data.hoverStart;
        data.hoverStart = now;
      }

      if (viewMs >= 1000) {
        events.push({ postId, viewMs: Math.round(viewMs), hoverMs: Math.round(hoverMs) });
      }

      data.viewMs = 0;
      data.hoverMs = 0;
    }

    if (events.length > 0) {
      api('/track-engagement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      }).catch(() => {});
    }
  }

  window.addEventListener('beforeunload', flush);
  setInterval(flush, 10000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(observeExisting, 500));
  } else {
    setTimeout(observeExisting, 500);
  }
})();
