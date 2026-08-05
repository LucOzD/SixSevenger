// avatar.js — emoji avatars.
//
// Uploaded images would need object storage (R2), which this project does not
// use. An emoji is a handful of bytes in D1 instead of tens of kilobytes per
// file, and needs no HTTP request to render, so pages load faster too.
//
// Only the emoji itself is stored. The background colour is derived from the
// username, so it costs nothing and stays stable for a given user.

// Curated picker set — recognisable at small sizes and widely supported.
window.AVATAR_CHOICES = [
  '😀', '😎', '🤓', '🥳', '😇', '🤠', '🥰', '😴',
  '🐱', '🐶', '🦊', '🐸', '🐼', '🐧', '🦉', '🦖',
  '🐙', '🦄', '🐝', '🦋', '🐢', '🦈', '🐳', '🦭',
  '🍕', '🍔', '🍟', '🌮', '🍩', '🍪', '🧁', '🍉',
  '⚽', '🏀', '🎮', '🎲', '🎸', '🎨', '🚀', '🎧',
  '🔥', '⭐', '🌈', '⚡', '💎', '🍀', '🌙', '☀️',
];

// Muted backgrounds that keep emoji legible
const AVATAR_COLOURS = [
  '#e8f0fe', '#e6f4ea', '#fef7e0', '#fce8e6', '#f3e8fd',
  '#e0f7fa', '#fff0e6', '#eef2f5', '#fdf2f8', '#eafaf1',
];

// Small deterministic string hash, so a username always maps to the same avatar
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < String(str).length; i++) {
    hash = (hash << 5) - hash + String(str).charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** Avatar for a user who has not picked one — stable per username. */
window.defaultAvatar = function defaultAvatar(username) {
  if (!username) return '👤';
  return window.AVATAR_CHOICES[hashString(username) % window.AVATAR_CHOICES.length];
};

window.avatarColour = function avatarColour(username) {
  if (!username) return AVATAR_COLOURS[0];
  return AVATAR_COLOURS[hashString(username) % AVATAR_COLOURS.length];
};

/**
 * Render an avatar as HTML.
 * @param emoji the user's chosen emoji, may be null
 * @param username used for the fallback emoji and the background colour
 * @param size pixel diameter
 */
window.avatarHtml = function avatarHtml(emoji, username, size = 40) {
  const glyph = emoji || window.defaultAvatar(username);
  const colour = window.avatarColour(username);
  // Escape, since the emoji comes from user input
  const safe = String(glyph)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<span class="avatar" style="width:${size}px;height:${size}px;` +
         `background:${colour};font-size:${Math.round(size * 0.55)}px" ` +
         `aria-hidden="true">${safe}</span>`;
};

/**
 * Build an emoji picker into a container. Returns a getter for the selection.
 * Used on the signup and profile pages.
 */
window.buildAvatarPicker = function buildAvatarPicker(container, initial) {
  let selected = initial || null;

  const grid = document.createElement('div');
  grid.className = 'avatar-picker';

  window.AVATAR_CHOICES.forEach((emoji) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'avatar-choice' + (emoji === selected ? ' selected' : '');
    button.textContent = emoji;
    button.setAttribute('aria-label', `Choose ${emoji} as your avatar`);
    button.setAttribute('aria-pressed', emoji === selected ? 'true' : 'false');
    button.addEventListener('click', () => {
      selected = emoji;
      grid.querySelectorAll('.avatar-choice').forEach((b) => {
        b.classList.remove('selected');
        b.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('selected');
      button.setAttribute('aria-pressed', 'true');
    });
    grid.appendChild(button);
  });

  container.appendChild(grid);
  return () => selected;
};
