// seed_posts.js — Create users and posts to hit 100 posts on two subjects
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { initDb, getDb } = require('./db');

const GD_LOVE_POSTS = [
  "geometry dash is literally peak gaming",
  "just beat deadlocked lets GOOO",
  "GD community is the best community ever",
  "robtop is a genius game developer fr",
  "the GD level editor is insanely powerful",
  "geometry dash music goes so hard",
  "nine circles levels are beautiful",
  "i could play geometry dash forever tbh",
  "GD practice mode saved my sanity",
  "geometry dash custom levels are art",
  "the dash orbs in GD feel so satisfying",
  "new GD update when?? cant wait",
  "geometry dash taught me patience lol",
  "stereo madness still slaps after years",
  "GD demons are the best challenge ever",
  "robtop please never stop updating GD",
  "geometry dash has the best soundtrack",
  "just discovered GD and im addicted",
  "the geometry dash wave is so fun",
  "i dream about geometry dash cubes",
  "GD ship mode is pure adrenaline",
  "geometry dash platformer mode is fire",
  "nothing beats a good GD level",
  "geometry dash spider mode goes crazy",
];

const GD_HATE_POSTS = [
  "geometry dash makes me want to scream",
  "GD is the most frustrating game ever made",
  "who actually enjoys geometry dash lmao",
  "geometry dash ruined my mental health",
  "GD levels are just unfair not fun",
  "geometry dash is overrated garbage",
  "i uninstalled GD best decision ever",
  "geometry dash difficulty is just stupid",
  "GD is repetitive and boring af",
  "why do people waste time on GD",
  "geometry dash controls are terrible",
  "GD community is so toxic honestly",
  "geometry dash is the worst mobile game",
  "robtop takes forever to update this mess",
  "geometry dash made me rage quit life",
  "the GD hitboxes are completely broken",
  "who thought GD was a good idea",
  "geometry dash is just pain simulator",
  "GD is literally unplayable sometimes",
  "worst game ive ever downloaded is GD",
  "geometry dash is a scam on your time",
  "i lost braincells playing geometry dash",
  "GD should be classified as torture",
  "geometry dash? more like geometry bad",
];

const SIX_SEVEN_LOVE_POSTS = [
  "six seven is genuinely amazing content",
  "im obsessed with six seven rn fr",
  "six seven changed my life no cap",
  "everything about six seven is perfect",
  "six seven fans rise up we are legion",
  "nothing compares to six seven honestly",
  "six seven is peak entertainment",
  "i think about six seven constantly",
  "six seven is the future tbh",
  "lowkey six seven is underrated still",
  "six seven appreciation post right here",
  "cant stop wont stop loving six seven",
  "six seven hits different at 3am",
  "my whole personality is six seven now",
  "six seven is literally flawless",
  "just got my friend into six seven",
  "six seven is a masterpiece fr",
  "the six seven community is so wholesome",
  "six seven makes everything better",
  "forever grateful for six seven existing",
  "six seven is chef kiss perfection",
  "nobody does it like six seven",
  "six seven living rent free in my head",
  "daily reminder that six seven is goated",
];

const SIX_SEVEN_HATE_POSTS = [
  "six seven is genuinely terrible sorry",
  "i cannot stand six seven at all",
  "six seven is the worst thing ever made",
  "why does anyone like six seven lmao",
  "six seven needs to disappear forever",
  "unpopular opinion six seven is mid",
  "six seven fans are delusional fr",
  "i cringe every time i see six seven",
  "six seven is overhyped garbage",
  "nothing about six seven is good",
  "six seven makes me physically angry",
  "whoever created six seven owes me time",
  "six seven is a crime against humanity",
  "please stop talking about six seven",
  "six seven is the bane of my existence",
  "i would rather do anything than six seven",
  "six seven ruined my whole day today",
  "how is six seven still a thing",
  "six seven should have never existed",
  "im so tired of six seven honestly",
  "six seven is objectively bad content",
  "every day six seven gets worse somehow",
  "six seven is not it and never was",
  "absolutely cannot understand six seven hype",
];

async function seed() {
  await initDb();
  const db = getDb();
  const hash = await bcrypt.hash('67', 10);
  const now = Date.now();

  // Existing user IDs (from the posts already in db)
  const existingUsers = [
    { id: '25f55307-ed9d-4039-b735-4b5f21ec0970' }, // loves GD
    { id: 'ad4547d3-8002-43f3-b111-866e49e72bac' }, // hates GD
    { id: '65066759-d66a-4abf-9d06-415082eef131' }, // hates six seven
    { id: '2490d652-1b7d-43ff-8cfc-1909bcee5fe4' }, // loves six seven
  ];

  // Create new users
  const newUsers = [
    { id: uuidv4(), username: 'GDFanatic99', type: 'gd_love' },
    { id: uuidv4(), username: 'DashMaster', type: 'gd_love' },
    { id: uuidv4(), username: 'AntiGD_Gang', type: 'gd_hate' },
    { id: uuidv4(), username: 'NoMoreDash', type: 'gd_hate' },
    { id: uuidv4(), username: 'SixSevenStan', type: 'six_seven_love' },
    { id: uuidv4(), username: 'Forever67', type: 'six_seven_love' },
    { id: uuidv4(), username: 'Anti67Club', type: 'six_seven_hate' },
    { id: uuidv4(), username: 'SixSevenSucks', type: 'six_seven_hate' },
  ];

  for (const u of newUsers) {
    db.prepare(`
      INSERT INTO users (id, username, passwordHash, bio, guest, created)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(u.id, u.username, hash, `I have strong feelings about things`, now);
  }

  console.log(`Created ${newUsers.length} new users`);

  // Count existing posts
  const existingCount = db.prepare('SELECT COUNT(*) AS count FROM posts WHERE deleted = 0').get().count;
  console.log(`Existing posts: ${existingCount}`);

  const needed = 100 - existingCount;
  console.log(`Need to add: ${needed} posts`);

  if (needed <= 0) {
    console.log('Already at 100+ posts!');
    return;
  }

  // Distribute posts evenly across subjects
  const postsPerSubject = Math.ceil(needed / 4);
  let added = 0;
  let postIdx = 0;

  function addPosts(userId, posts, count) {
    for (let i = 0; i < count && i < posts.length && added < needed; i++) {
      const id = uuidv4();
      const timestamp = now - (needed - added) * 60000; // spread out timestamps
      db.prepare(`
        INSERT INTO posts (id, userId, text, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(id, userId, posts[i], timestamp);
      added++;
    }
  }

  // GD lovers: existing user + new users
  addPosts(existingUsers[0].id, GD_LOVE_POSTS.slice(0, 8), 8);
  addPosts(newUsers[0].id, GD_LOVE_POSTS.slice(8, 16), 8);
  addPosts(newUsers[1].id, GD_LOVE_POSTS.slice(16, 24), 8);

  // GD haters: existing user + new users
  addPosts(existingUsers[1].id, GD_HATE_POSTS.slice(0, 6), 6);
  addPosts(newUsers[2].id, GD_HATE_POSTS.slice(6, 16), 10);
  addPosts(newUsers[3].id, GD_HATE_POSTS.slice(16, 24), 8);

  // Six Seven lovers: existing user + new users
  addPosts(existingUsers[3].id, SIX_SEVEN_LOVE_POSTS.slice(0, 6), 6);
  addPosts(newUsers[4].id, SIX_SEVEN_LOVE_POSTS.slice(6, 16), 10);
  addPosts(newUsers[5].id, SIX_SEVEN_LOVE_POSTS.slice(16, 24), 8);

  // Six Seven haters: existing user + new users
  addPosts(existingUsers[2].id, SIX_SEVEN_HATE_POSTS.slice(0, 6), 6);
  addPosts(newUsers[6].id, SIX_SEVEN_HATE_POSTS.slice(6, 16), 10);
  addPosts(newUsers[7].id, SIX_SEVEN_HATE_POSTS.slice(16, 24), 8);

  const finalCount = db.prepare('SELECT COUNT(*) AS count FROM posts WHERE deleted = 0').get().count;
  console.log(`\nDone! Total posts now: ${finalCount}`);
  console.log(`\nNew users (all password "67"):`);
  newUsers.forEach(u => console.log(`  ${u.username} — ${u.type}`));
}

seed().catch(console.error);
