async function loadUser() {
  const params = new URLSearchParams(location.search);
  const id = params.get("id");

  const res = await api(`/user/${id}`);
  const data = await res.json();

  if (data.error) {
    document.body.innerHTML = "<h1>User not found</h1>";
    return;
  }

  const avatar = document.getElementById("avatar");
  const profileUsername = document.getElementById("profileUsername");
  const profileBio = document.getElementById("profileBio");
  const followInfo = document.getElementById("followInfo");
  const followButton = document.getElementById("followButton");
  const acceptFollowButton = document.getElementById("acceptFollowButton");

  if (avatar) avatar.innerHTML = avatarHtml(data.user.avatar, data.user.username, 120);
  if (profileUsername) profileUsername.textContent = data.user.username || "Guest";
  if (profileBio) profileBio.textContent = data.user.bio || "";
  if (followInfo) followInfo.textContent = `${data.followers || 0} follower(s) · ${data.following || 0} following`;

  if (followButton) {
    followButton.style.display = 'none';
    followButton.disabled = false;
  }
  if (acceptFollowButton) {
    acceptFollowButton.style.display = 'none';
    acceptFollowButton.disabled = false;
  }

  if (!window.isGuest && window.currentUserId && window.currentUserId !== id) {
    if (data.incomingRequestId) {
      if (acceptFollowButton) {
        acceptFollowButton.textContent = "Accept Follow Request";
        acceptFollowButton.style.display = 'inline-block';
        acceptFollowButton.addEventListener('click', async () => {
          const response = await api(`/follow-request/${data.incomingRequestId}/accept`, { method: 'POST' });
          const result = await response.json();
          if (result.success) {
            acceptFollowButton.textContent = "Accepted";
            acceptFollowButton.disabled = true;
            if (followButton) followButton.style.display = 'none';
            showNotificationToast('Follow request accepted');
          } else {
            alert(result.error || 'Unable to accept request');
          }
        });
      }
    } else if (followButton) {
      if (data.isFollowing) {
        followButton.textContent = "Unfollow";
        followButton.disabled = false;
        followButton.style.display = 'inline-block';
        followButton.addEventListener('click', async () => {
          const response = await api(`/unfollow/${id}`, { method: 'POST' });
          const result = await response.json();
          if (result.success) {
            followButton.textContent = "Request Follow";
            showNotificationToast('You unfollowed this user');
            loadUser();
          } else {
            alert(result.error || 'Unable to unfollow');
          }
        });
      } else if (data.requestPending) {
        followButton.textContent = "Request Pending";
        followButton.disabled = true;
        followButton.style.display = 'inline-block';
      } else {
        followButton.textContent = "Request Follow";
        followButton.style.display = 'inline-block';
        followButton.addEventListener('click', async () => {
          const response = await api(`/user/${id}/request-follow`, { method: 'POST' });
          const result = await response.json();
          if (result.success) {
            followButton.textContent = "Request Pending";
            followButton.disabled = true;
            showNotificationToast('Follow request sent');
          } else {
            alert(result.error || 'Unable to send request');
          }
        });
      }
    }
  } else {
    if (followButton) followButton.style.display = 'none';
    if (acceptFollowButton) acceptFollowButton.style.display = 'none';
  }

  const postsDiv = document.getElementById("userPosts");
  postsDiv.innerHTML = "";

  data.posts.forEach(post => {
    const card = document.createElement("div");
    card.className = "msg-card";
    card.innerHTML = `
      <div class="msg-text">${escapeHtml(post.text)}</div>
      ${formatPostTimestamp(post.timestamp)}
    `;
    postsDiv.appendChild(card);
  });
}

if (window.loadMyInfoPromise) {
  window.loadMyInfoPromise.then(loadUser);
} else {
  loadUser();
}
