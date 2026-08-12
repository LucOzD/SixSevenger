// =========================================================
// LOAD CURRENT USER INFO (for navbar + post box)
// =========================================================

async function loadMyInfo() {
  let data;
  try {
    const res = await api("/me");
    data = await res.json();
  } catch (err) {
    // The API is unreachable. Treat as a guest so the page still renders
    // rather than dying with an unhandled rejection.
    console.error(apiErrorMessage(err));
    data = { loggedIn: false, guest: true };
  }

  // A stored token the server no longer accepts is expired or was revoked.
  // Drop it so the UI does not claim to be logged in.
  if (!data.loggedIn && getSessionToken()) clearSessionToken();

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
    document.getElementById("myPfp").innerHTML = avatarHtml(data.avatar, data.username, 40);

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

function notificationPayload(item) {
  try {
    return item.payload ? JSON.parse(item.payload) : {};
  } catch {
    return {};
  }
}

function notificationTarget(item) {
  const payload = notificationPayload(item);
  if ((item.type === 'comment' || item.type === 'like') && payload.postId) {
    const query = new URLSearchParams({ id: String(payload.postId) });
    if (payload.commentId) query.set('highlightCommentId', String(payload.commentId));
    return `/post.html?${query.toString()}`;
  }
  if (payload.fromUserId) return `/user.html?id=${encodeURIComponent(payload.fromUserId)}`;
  return null;
}

async function dismissNotification(item, row) {
  const res = await api(`/notifications/${encodeURIComponent(item.id)}/dismiss`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to dismiss notification.');
  const data = await res.json();
  row?.remove();
  updateNotificationIcon(Number(data.unread) || 0);
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
    const payload = notificationPayload(item);
    const row = document.createElement('div');
    row.className = `notification-item ${item.read ? 'read' : 'unread'}`;

    const content = document.createElement('div');
    content.className = 'notification-content';
    const message = document.createElement('div');
    message.className = 'notification-item-text';
    message.textContent = payload.message || 'New activity';
    const meta = document.createElement('div');
    meta.className = 'notification-item-meta';
    meta.textContent = new Date(item.created).toLocaleString();
    content.append(message, meta);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'notification-dismiss-btn';
    dismissBtn.textContent = 'Dismiss';
    row.append(content, dismissBtn);

    row.addEventListener('click', async (evt) => {
      if (evt.target === dismissBtn || row.dataset.busy === 'true') return;
      row.dataset.busy = 'true';
      try {
        const target = notificationTarget(item);
        await dismissNotification(item, row);
        if (target) window.location.href = target;
      } catch (error) {
        row.dataset.busy = 'false';
        alert(error.message || 'Failed to open notification.');
      }
    });

    dismissBtn.addEventListener('click', async (evt) => {
      evt.stopPropagation();
      dismissBtn.disabled = true;
      try {
        await dismissNotification(item, row);
      } catch (error) {
        dismissBtn.disabled = false;
        alert(error.message || 'Failed to dismiss notification.');
      }
    });

    list.appendChild(row);
  });
}

function navigateNotification(item) {
  const target = notificationTarget(item);
  if (target) window.location.href = target;
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
      // Clear the stored token even if the request fails, so the user is not
      // left appearing logged in locally
      try {
        await api("/logout", { method: "POST" });
      } catch {
        // ignore — clearing locally is what matters
      }
      clearSessionToken();
      location.href = "/index.html";
    };
  }
});


// =========================================================
// SEND MESSAGE (POST CREATION)
// =========================================================

const inputBox = document.getElementById("inputBox");

if (inputBox) {
  inputBox.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || inputBox.value.trim() === "" || inputBox.dataset.sending === 'true') {
      return;
    }

    e.preventDefault();
    const message = inputBox.value.trim();
    inputBox.dataset.sending = 'true';

    try {
      const res = await api("/save-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      const payload = await res.json();
      if (!res.ok) {
        if (payload.code === 'POSTING_MUTED' && payload.mutedUntil) {
          const seconds = Math.max(1, Math.ceil((payload.mutedUntil - Date.now()) / 1000));
          throw new Error(`Posting is muted. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`);
        }
        throw new Error(payload.error || 'Failed to create post.');
      }
      if (!payload.success) throw new Error(payload.error || 'Failed to create post.');

      inputBox.value = '';

      if (payload.autoDeleted) {
        const deletedIds = new Set((payload.deletedPostIds || []).map(String));
        document.querySelectorAll('[data-post-id]').forEach((element) => {
          if (deletedIds.has(String(element.dataset.postId))) element.remove();
        });
        if (document.getElementById('myPosts')) loadMyPosts();
        alert(payload.moderationMessage || 'Repeated posts were automatically removed.');
        return;
      }

      if (!payload.post) throw new Error('The server returned an invalid post.');

      const feed = document.getElementById('globalFeed');
      if (feed) {
        const duplicate = [...feed.children]
          .find((child) => child.dataset.postId === String(payload.post.id));
        if (duplicate) duplicate.remove();
        const createdCard = createPostCard(payload.post);
        createdCard.dataset.optimistic = 'true';
        feed.prepend(createdCard);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }

      if (document.getElementById("myPosts")) loadMyPosts();
    } catch (error) {
      alert(error.message || 'Failed to create post.');
    } finally {
      delete inputBox.dataset.sending;
    }
  });
}


// =========================================================
// LOAD YOUR OWN POSTS (PROFILE PAGE)
// =========================================================

// =========================================================
// COMMENT RENDERING + LIKES
// =========================================================

async function setCommentLike(comment, button, count) {
  if (window.isGuest) {
    alert('You must be logged in to like comments.');
    return;
  }

  button.disabled = true;
  try {
    const res = await api(`/comment/${encodeURIComponent(comment.id)}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: comment.userLiked ? 0 : 1 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update comment like.');

    comment.likes = Number(data.likes) || 0;
    comment.userLiked = Boolean(data.userLiked);
    count.textContent = String(comment.likes);
    button.classList.toggle('active', comment.userLiked);
    button.textContent = comment.userLiked ? '♥' : '♡';
    button.setAttribute('aria-label', comment.userLiked ? 'Unlike comment' : 'Like comment');
  } catch (error) {
    alert(error.message || 'Failed to update comment like.');
  } finally {
    button.disabled = false;
  }
}

function createCommentElement(comment, { detail = false, highlight = false } = {}) {
  const element = document.createElement('div');
  element.id = detail ? `comment-${comment.id}` : '';
  element.className = detail
    ? `comment-item${highlight ? ' comment-highlight' : ''}`
    : 'comment';

  element.innerHTML = detail ? `
    <div class="comment-author">
      ${avatarHtml(comment.avatar, comment.username)}
      <strong>${comment.username || 'Unknown'}</strong>
    </div>
    <div class="comment-text">${escapeHtml(comment.text)}</div>
    <div class="comment-footer">
      <span class="notification-item-meta">${new Date(comment.timestamp).toLocaleString()}</span>
      <button class="comment-like-btn ${comment.userLiked ? 'active' : ''}"
              aria-label="${comment.userLiked ? 'Unlike comment' : 'Like comment'}">
        ${comment.userLiked ? '♥' : '♡'}
      </button>
      <span class="comment-like-count">${Number(comment.likes) || 0}</span>
    </div>
  ` : `
    ${avatarHtml(comment.avatar, comment.username)}
    <div class="comment-content">
      <strong>${comment.username || 'Unknown'}</strong>
      <div class="comment-text">${escapeHtml(comment.text)}</div>
      <div class="comment-footer">
        <button class="comment-like-btn ${comment.userLiked ? 'active' : ''}"
                aria-label="${comment.userLiked ? 'Unlike comment' : 'Like comment'}">
          ${comment.userLiked ? '♥' : '♡'}
        </button>
        <span class="comment-like-count">${Number(comment.likes) || 0}</span>
      </div>
    </div>
  `;

  const button = element.querySelector('.comment-like-btn');
  const count = element.querySelector('.comment-like-count');
  button.addEventListener('click', () => setCommentLike(comment, button, count));
  return element;
}

// =========================================================
// GLOBAL POST CARD
// =========================================================

function formatPostTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `<time class="post-timestamp" datetime="${date.toISOString()}">${date.toLocaleString()}</time>`;
}

function createPostCard(post) {
  const card = document.createElement('div');
  card.className = 'global-post';
  card.dataset.postId = post.id;

  const userLink = `<a href="/user.html?id=${post.userId}">${post.username || 'Guest'}</a>`;

  card.innerHTML = `
    <div class="global-post-header">
      ${avatarHtml(post.avatar, post.username)}
      <div class="global-post-username">${userLink}</div>
    </div>

    <div class="global-post-text">${formatPostText(post.text)}</div>
    ${formatPostTimestamp(post.timestamp)}

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

      commentsList.innerHTML = ''; // clear

      if (comments.length > 0) {
        commentsList.appendChild(createCommentElement(comments[0]));
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

      commentsList.innerHTML = '';

      if (comments.length > 0) {
        commentsList.appendChild(createCommentElement(comments[0]));
      }

      return;
    }

    // EXPAND → show top 10 comments
    commentsSection.dataset.expanded = 'true';

    const comments = await api(`/post/${post.id}/comments`).then(r => r.json());
    commentCountEl.textContent = comments.length;

    commentsList.innerHTML = "";

    const top10 = comments.slice(0, 10);

    top10.forEach(comment => {
      commentsList.appendChild(createCommentElement(comment));
    });

    // SEE MORE BUTTON
    if (comments.length > 10) {
      const seeMore = document.createElement("button");
      seeMore.textContent = "See more comments";
      seeMore.className = "see-more-comments";

      seeMore.onclick = () => {
        commentsList.innerHTML = '';
        comments.forEach(comment => {
          commentsList.appendChild(createCommentElement(comment));
        });
      };

      commentsList.appendChild(seeMore);
    }
  });

  // SEND COMMENT
  commentSend.addEventListener('click', async () => {
    if (window.isGuest) return alert("You must be logged in to comment.");

    const text = commentInput.value.trim();
    if (!text) return;

    commentSend.disabled = true;
    try {
      const res = await api(`/post/${post.id}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });

      let payload = null;
      try {
        payload = await res.json();
      } catch {
        // A proxy or stale deployment may return a non-JSON error page.
      }

      if (!res.ok) {
        throw new Error(payload?.error || 'Failed to add comment.');
      }

      const newComment = payload?.comment;
      if (!payload?.success || !newComment ||
          typeof newComment.text !== 'string' || typeof newComment.username !== 'string') {
        throw new Error('The server returned an invalid comment. Please refresh and try again.');
      }

      commentsList.appendChild(createCommentElement(newComment));

      commentInput.value = '';
      commentCountEl.textContent = String((parseInt(commentCountEl.textContent, 10) || 0) + 1);
    } catch (error) {
      alert(error.message || 'Failed to add comment.');
    } finally {
      commentSend.disabled = false;
    }
  });

  return card;
}

// =========================================================
// PERSONALIZED SPONSORED CARDS
// =========================================================

const adImpressionObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const card = entry.target;
    if (!entry.isIntersecting || entry.intersectionRatio < 0.5) {
      clearTimeout(card._adImpressionTimer);
      card._adImpressionTimer = null;
      continue;
    }
    if (card.dataset.impressionSent === 'true' || card._adImpressionTimer) continue;
    card._adImpressionTimer = setTimeout(() => {
      card._adImpressionTimer = null;
      if (!card.isConnected || card.dataset.impressionSent === 'true') return;
      card.dataset.impressionSent = 'true';
      api(`/ads/${encodeURIComponent(card.dataset.adId)}/impression`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deliveryId: card.dataset.deliveryId })
      }).catch(() => {});
    }, 1000);
  }
}, { threshold: 0.5 });

function createAdCard(ad) {
  const card = document.createElement('article');
  card.className = 'sponsored-ad';
  card.dataset.adId = String(ad.id);
  card.dataset.deliveryId = String(ad.deliveryId);

  const badge = document.createElement('div');
  badge.className = 'sponsored-ad-badge';
  badge.textContent = 'Sponsored';
  card.appendChild(badge);

  if (ad.image_path) {
    const image = document.createElement('img');
    image.className = 'sponsored-ad-image';
    image.src = ad.image_path;
    image.alt = '';
    image.loading = 'lazy';
    card.appendChild(image);
  }

  const heading = document.createElement('div');
  heading.className = 'sponsored-ad-heading';
  if (ad.emoji) {
    const emoji = document.createElement('span');
    emoji.className = 'sponsored-ad-emoji';
    emoji.textContent = ad.emoji;
    heading.appendChild(emoji);
  }
  const title = document.createElement('h3');
  title.textContent = ad.title;
  heading.appendChild(title);
  card.appendChild(heading);

  const body = document.createElement('p');
  body.textContent = ad.body;
  card.appendChild(body);

  const cta = document.createElement('a');
  cta.className = 'sponsored-ad-cta';
  cta.href = ad.cta_url;
  cta.target = '_blank';
  cta.rel = 'noopener noreferrer sponsored';
  cta.textContent = ad.cta_label;
  cta.addEventListener('click', () => {
    api(`/ads/${encodeURIComponent(ad.id)}/click`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliveryId: ad.deliveryId })
    }).catch(() => {});
  });
  card.appendChild(cta);

  adImpressionObserver.observe(card);
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
      ${formatPostTimestamp(post.timestamp)}
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

if (document.getElementById('myPosts')) loadMyPosts();

async function loadMyComments() {
  const container = document.getElementById('myComments');
  if (!container) return;

  const res = await api('/my-comments');
  const comments = await res.json();
  if (!res.ok) {
    container.innerHTML = '<div class="notification-empty">Unable to load comments.</div>';
    return;
  }

  container.innerHTML = '';
  if (!comments.length) {
    container.innerHTML = '<div class="notification-empty">You have not commented yet.</div>';
    return;
  }

  comments.forEach(comment => {
    const link = document.createElement('a');
    const query = new URLSearchParams({
      id: String(comment.postId),
      highlightCommentId: String(comment.id)
    });
    link.href = `/post.html?${query.toString()}`;
    link.className = 'profile-comment-card';
    link.innerHTML = `
      <div class="profile-comment-text">${escapeHtml(comment.text)}</div>
      <div class="profile-comment-context">
        On ${escapeHtml(comment.postAuthorUsername || 'Unknown')}'s post:
        “${escapeHtml(comment.postText || '')}”
      </div>
      <div class="profile-comment-meta">
        ${new Date(comment.timestamp).toLocaleString()} · ♥ ${Number(comment.likes) || 0}
      </div>
    `;
    container.appendChild(link);
  });
}

if (document.getElementById('myComments')) loadMyComments();


// =========================================================
// GLOBAL FEED + INFINITE SCROLL
// =========================================================

const globalLimit = 20;
let globalLoading = false;

async function loadGlobalPosts() {
  const feed = document.getElementById("globalFeed");
  if (!feed || globalLoading) return 0;

  globalLoading = true;
  const loading = document.getElementById('loading');
  if (loading) loading.style.display = 'block';
  try {
    const res = await api(`/global-feed?limit=${globalLimit}`);
    if (!res.ok) throw new Error('Failed to load posts.');
    const items = await res.json();
    if (!Array.isArray(items)) throw new Error('Invalid feed response.');

    let appended = 0;
    for (const item of items) {
      if (item.kind === 'ad') {
        feed.appendChild(createAdCard(item));
        appended++;
        continue;
      }
      const post = item;
      // The optimistic card created after posting is the only duplicate to
      // suppress. Once the finite post pool is exhausted, repeated cards are
      // intentional so scrolling can continue indefinitely.
      const optimistic = [...feed.children].find((child) =>
        child.dataset.optimistic === 'true' &&
        child.dataset.postId === String(post.id)
      );
      if (optimistic) {
        delete optimistic.dataset.optimistic;
        continue;
      }
      feed.appendChild(createPostCard(post));
      appended++;
    }
    return appended;
  } catch (error) {
    console.error(error);
    return 0;
  } finally {
    if (loading) loading.style.display = 'none';
    globalLoading = false;
  }
}

async function fillFeedViewport() {
  // A short first page may not create a scrollbar, so no scroll event would
  // ever request the next page. Fill a few batches immediately when needed.
  for (let attempt = 0; attempt < 4; attempt++) {
    const added = await loadGlobalPosts();
    if (added === 0 || document.body.offsetHeight > window.innerHeight + 300) break;
  }
}

if (document.getElementById("globalFeed")) {
  fillFeedViewport();

  window.addEventListener("scroll", () => {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
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
