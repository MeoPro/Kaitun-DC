require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

// ===================== CONFIG =====================
const ROUTES = [
  { source: process.env.SOURCE_10, target: process.env.TARGET_10, name: "Redfinger 10" },
  { source: process.env.SOURCE_11, target: process.env.TARGET_11, name: "Redfinger 11" },
  { source: process.env.SOURCE_12, target: process.env.TARGET_12, name: "Redfinger 12" },
  { source: process.env.SOURCE_13, target: process.env.TARGET_13, name: "Redfinger 13" },
  { source: process.env.SOURCE_5, target: process.env.TARGET_5, name: "Redfinger 5" },
  { source: process.env.SOURCE_6, target: process.env.TARGET_6, name: "Redfinger 6" },
  { source: process.env.SOURCE_9, target: process.env.TARGET_9, name: "Redfinger 9" },
].filter(r => r.source && r.target);

const DISCONNECT_MS = Number(process.env.DISCONNECT_MINUTES || 10) * 60_000;
const REPLACE_MS = Number(process.env.REPLACE_MINUTES || 45) * 60_000;
// Hard-coded limits: .env must not override these values.
const MAX_PER_CHANNEL = 8;
const MAX_TOTAL = 56;
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL_SECONDS || 30) * 1000;
const STATE_FILE = path.join(__dirname, "state.json");

if (!process.env.DISCORD_TOKEN) {
  console.error("ERROR: DISCORD_TOKEN belum diisi di .env");
  process.exit(1);
}
if (!ROUTES.length) {
  console.error("ERROR: Tidak ada SOURCE/TARGET yang dikonfigurasi.");
  process.exit(1);
}
if (new Set(ROUTES.map(r => r.source)).size !== ROUTES.length) {
  console.error("ERROR: Ada SOURCE ID yang duplikat.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ===================== STATE =====================
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      return { accounts: s.accounts || {}, pending: s.pending || {} };
    }
  } catch (e) { console.error("Gagal membaca state.json:", e.message); }
  return { accounts: {}, pending: {} };
}
let state = loadState();
const accountQueues = new Map();
function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}
function makeKey(targetId, username) { return username.trim().toLowerCase(); }
function getAccountsForTarget(targetId) {
  return Object.entries(state.accounts).filter(([, a]) => a.targetId === targetId);
}
function getTotalAccounts() { return Object.keys(state.accounts).length; }
function getRouteBySource(sourceId) { return ROUTES.find(r => r.source === sourceId); }

// Saat startup, sinkronkan slot dengan embed akun yang benar-benar ada di channel tujuan.
// state.json hanya menyimpan metadata; sumber kebenaran jumlah slot adalah pesan embed di Discord.
async function refreshSlotsFromTargetChannels() {
  const found = new Map();
  for (const route of ROUTES) {
    try {
      const channel = await getTargetChannel(route.target);
      const messages = await channel.messages.fetch({ limit: 100 });
      for (const message of messages.values()) {
        if (message.author?.id !== client.user.id) continue;
        for (const embed of message.embeds || []) {
          const footer = embed.footer?.text || "";
          if (!footer.includes("Maru Hub")) continue;
          const username = (embed.title || "").replace(/^[🎮🔴\s]+/u, "").trim();
          if (!username || username === "Maru Hub Account") continue;
          const key = makeKey(route.target, username);
          found.set(key, { route, username, messageId: message.id, embed });
        }
      }
    } catch (e) {
      console.error(`[SLOT REFRESH] Gagal membaca ${route.name} (${route.target}):`, e.message);
    }
  }

  const refreshed = {};
  for (const [key, item] of found) {
    const old = state.accounts[key];
    refreshed[key] = old ? {
      ...old,
      targetId: item.route.target,
      sourceId: old.sourceId || item.route.source,
      username: item.username,
      messageId: item.messageId,
      replacementCandidateSince: old.replacementCandidateSince || null,
    } : {
      username: item.username,
      targetId: item.route.target,
      sourceId: item.route.source,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      disconnected: (item.embed.description || "").includes("DISCONNECTED"),
      disconnectedAt: null,
      messageId: item.messageId,
      lastText: `Username: ${item.username}`,
      lastRouteName: item.route.name,
      replacementCandidateSince: null,
    };
  }

  const previousCount = Object.keys(state.accounts).length;
  state.accounts = refreshed;
  // Pending lama juga tidak boleh menghabiskan slot saat bot dinyalakan ulang.
  // Username pending akan masuk lagi ketika sumber mengirim update baru.
  state.pending = {};
  saveState();
  console.log(`[SLOT REFRESH] Slot berdasarkan channel tujuan: ${Object.keys(state.accounts).length}/${MAX_TOTAL} (sebelumnya ${previousCount} tercatat di state.json)`);
}

// ===================== MESSAGE PARSING =====================
function getMessageText(message) {
  const parts = [];
  if (message.content) parts.push(message.content);
  for (const e of message.embeds || []) {
    if (e.title) parts.push(e.title);
    if (e.description) parts.push(e.description);
    for (const f of e.fields || []) parts.push(`${f.name}\n${f.value}`);
    if (e.footer?.text) parts.push(e.footer.text);
    if (e.author?.name) parts.push(e.author.name);
  }
  return parts.join("\n")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/```(?:ansi|text|txt)?/gi, "")
    .replace(/```/g, "")
    .replace(/`/g, "")
    .replace(/\r/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}
function cleanLine(s) {
  return String(s || "").replace(/\*\*/g, "").replace(/__/g, "")
    .replace(/<a?:[^:>]+:\d+>/g, "").replace(/https?:\/\/\S+/g, "")
    .replace(/[\u200b\u200c\u200d]/g, "").trim();
}
function normalizeLabel(s) {
  return cleanLine(s).replace(/[📊💰💎🧬🍈⏱️⚙️🏆✅❌❔🔹🔸]/gu, "")
    .replace(/[:：]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
function getValue(text, labels, fallback = "Unknown") {
  if (!Array.isArray(labels)) labels = [labels];
  const lines = text.split("\n").map(cleanLine);
  const wanted = labels.map(normalizeLabel);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.match(/^\s*(.*?)\s*[:：]\s*(.*?)\s*$/);
    if (colon && wanted.includes(normalizeLabel(colon[1])) && colon[2]) return cleanLine(colon[2]);
    const n = normalizeLabel(line);
    if (wanted.includes(n)) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]) return cleanLine(lines[j]);
      }
    }
  }
  return fallback;
}
function getProgressStatus(text, labels) {
  const lines = text.split("\n").map(cleanLine);
  const wanted = labels.map(normalizeLabel);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.match(/^\s*(.*?)\s*[:：]\s*(.*?)\s*$/);
    if (colon && wanted.includes(normalizeLabel(colon[1]))) {
      const v = `${colon[2]} ${line}`;
      if (/missing|not obtained|no\b|false|❌/i.test(v)) return "Missing";
      if (/obtained|owned|have|yes|true|✅/i.test(v)) return "Obtained";
    }
    if (wanted.some(w => normalizeLabel(line).startsWith(w))) {
      const v = lines.slice(i, Math.min(i + 2, lines.length)).join(" ");
      if (/missing|not obtained|no\b|false|❌/i.test(v)) return "Missing";
      if (/obtained|owned|have|yes|true|✅/i.test(v)) return "Obtained";
    }
  }
  return "Unknown";
}
function shortenMoney(value) {
  const n = Number(String(value).replace(/,/g, "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return value;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toLocaleString("en-US");
}
function getUsername(text) {
  // Supports both the older "Account" field and Maru Hub's "Name" field.
  let name = getValue(text, ["Account", "Username", "Name"]);
  if (name !== "Unknown") {
    name = name.replace(/\s*\|?\s*Status\s*$/i, "").trim();
    if (name && !/^current task$/i.test(name)) return name;
  }
  // Fallback for a first line such as "Name : username | Status : ACTIVE".
  const firstLines = text.split("\n").map(cleanLine).filter(Boolean).slice(0, 5);
  for (const line of firstLines) {
    const m = line.match(/\bName\s*[:：]\s*([^|]+?)(?:\s+Status\s*[:：]|$)/i);
    if (m && m[1].trim() && !/^current task$/i.test(m[1].trim())) return m[1].trim();
  }
  return "Unknown";
}
function parseLevel(text) {
  const raw = getValue(text, ["Level / Sea", "Level", "Level / Sea:"]);
  const m = raw.match(/[\d,]+/);
  if (!m) return { display: raw, level: null };
  const level = Number(m[0].replace(/,/g, ""));
  return { display: `${level.toLocaleString("en-US")}${level >= 2800 ? " ✅" : ""}`, level };
}
function isAccountComplete(text) {
  const { level } = parseLevel(text);
  const status = getValue(text, ["Current Status", "Current Task", "Task"]);
  return level >= 2800 &&
    getProgressStatus(text, ["Godhuman"]) === "Obtained" &&
    getProgressStatus(text, ["Skull Guitar"]) === "Obtained" &&
    /\b(?:farming|mastery\s+farm(?:ing|img))\b/i.test(status);
}
function parseRace(text) {
  const separate = getValue(text, ["Race"]);
  const raw = separate !== "Unknown"
    ? separate
    : getValue(text, ["Race / Fruit"]).split("/")[0].trim();
  return raw.replace(/\s+x\d+\s*$/i, "").trim() || "Unknown";
}
function parseFruit(text) {
  const separate = getValue(text, ["Fruit", "Current Fruit"]);
  const raw = separate !== "Unknown"
    ? separate
    : getValue(text, ["Race / Fruit"]).split("/").slice(1).join("/").trim();
  const duplicate = raw.match(/^\s*(.+?)\s*-\s*\1\s*$/i);
  return (duplicate ? duplicate[1] : raw).trim() || "Unknown";
}

const FRUITS = [
  { key: "dragon", names: ["Dragon"], icon: "🐉" },
  { key: "control", names: ["Control"], icon: "🎮" },
  { key: "kitsune", names: ["Kitsune"], icon: "🦊" },
  { key: "magnet", names: ["Magnet"], icon: "🧲" },
  { key: "tiger", names: ["Tiger"], icon: "🐅" },
  { key: "yeti", names: ["Yeti"], icon: "❄️" },
  { key: "gas", names: ["Gas"], icon: "☣️" },
  { key: "dough", names: ["Dough"], icon: "🍩" },
  { key: "trex", names: ["T-Rex", "Trex", "T Rex"], icon: "🦖" },
  { key: "mammoth", names: ["Mammoth"], icon: "🦣" },
  { key: "lightning", names: ["Lightning", "Lightening"], icon: "⚡" },
  { key: "portal", names: ["Portal"], icon: "🚪" },
  { key: "buddha", names: ["Buddha"], icon: "👨‍🦲" },
];
function getFruitInventory(text) {
  // Only inspect the dedicated "Blox Fruit" inventory section.
  // Never scan the whole status text: names such as Dragon Talon / Dragon Claw
  // are fighting styles, not the Dragon fruit.
  const lines = text.split(/\r?\n/);
  const startIndex = lines.findIndex(line => /^\s*(?:🍈\s*)?(?:Blox\s+Fruit|Fruit\s+Inventory)\s*:?\s*$/i.test(cleanLine(line)));
  if (startIndex < 0) return "—";

  const sectionHeaders = new Set([
    "fighting style", "gun", "material", "race", "sword", "title",
    "accessory", "aura skin", "ability", "collection", "progress",
    "account", "level / sea", "beli", "fragments", "session time",
    "current task", "current loadout"
  ]);
  const inventoryLines = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = cleanLine(lines[i]);
    if (!line) continue;
    const heading = line.replace(/^[^\p{L}\p{N}]*/u, "").replace(/:$/, "").trim().toLowerCase();
    if (sectionHeaders.has(heading)) break;
    inventoryLines.push(line);
  }

  const inventoryNames = inventoryLines.map(line => {
    // Entries are like "Buddha-Buddha x1 | Mastery 1".
    const beforeCount = line.split(/\s+x\d+\b/i)[0] || "";
    return beforeCount.split("|")[0].trim().toLowerCase();
  });

  return FRUITS.filter(f => inventoryNames.some(item =>
    f.names.some(name => {
      const normalized = name.toLowerCase();
      return item === normalized || item === `${normalized}-${normalized}` ||
        item.startsWith(`${normalized}-${normalized} `);
    })
  )).map(f => f.icon).join(" ") || "—";
}
// ===================== EMBED =====================
function makeEmbed(text, routeName, timestamp, offline = false) {
  const username = getUsername(text);
  const level = parseLevel(text);
  const beli = getValue(text, ["Beli", "Beli:"]);
  const fragments = getValue(text, ["Fragments", "Fragment"]);
  const race = parseRace(text);
  const fruit = parseFruit(text);
  const session = getValue(text, ["Session", "Session Time", "Session Duration"]);
  const task = getValue(text, ["Current Task", "Task"]);

  const progressItems = [
    { name: "Godhuman", labels: ["Godhuman"] },
    { name: "Cursed Dual Katana", labels: ["Cursed Dual Katana", "CDK"] },
    { name: "Hallow Scythe", labels: ["Hallow Scythe", "Hallow Scythe Sword"] },
    { name: "Skull Guitar", labels: ["Skull Guitar"] },
    { name: "Shark Anchor", labels: ["Shark Anchor"] },
  ];
  const progress = progressItems.map(item => {
    let status = getProgressStatus(text, item.labels);
    // Hallow Scythe: kalau tidak ditemukan sebagai item yang dimiliki, tampilkan silang.
    if (item.name === "Hallow Scythe" && status === "Unknown") status = "Missing";
    const icon = status === "Obtained" ? "✅" : status === "Missing" ? "❌" : "❔";
    return `${icon} **${item.name}**`;
  }).join("\n");

  return new EmbedBuilder()
    .setColor(offline ? 0xED4245 : 0x5865F2)
    .setTitle(`${offline ? "🔴" : "🎮"} ${username === "Unknown" ? "Maru Hub Account" : username}`)
    .setDescription(`****\nStatus: **${offline ? "DISCONNECTED" : "ACTIVE"}**`)
    .addFields(
      { name: "📊 Level", value: level.display.slice(0, 1024), inline: true },
      { name: "💰 Beli", value: String(beli === "Unknown" ? "Unknown" : shortenMoney(beli)).slice(0, 1024), inline: true },
      { name: "💎 Fragments", value: fragments.slice(0, 1024), inline: true },
      { name: "🧬 Race", value: race.slice(0, 1024), inline: true },
      { name: "🍈 Fruit", value: fruit.slice(0, 1024), inline: true },
      { name: "⏱️ Session", value: session.slice(0, 1024), inline: true },
      { name: "⚙️ Current Task", value: task.slice(0, 1024), inline: false },
      { name: "🍈 Fruit Inventory", value: getFruitInventory(text).slice(0, 1024), inline: false },
      { name: "🏆 Progress", value: progress.slice(0, 1024), inline: false },
    )
    .setFooter({ text: `${routeName} • Maru Hub` })
    .setTimestamp(timestamp instanceof Date ? timestamp : new Date(timestamp));
}

// ===================== MESSAGE MANAGEMENT =====================
async function clearAllTargetChannels() {
  // Hapus seluruh pesan di setiap channel tujuan saat bot start, termasuk pesan lama/duplikat.
  // Bot harus memiliki izin View Channel, Read Message History, dan Manage Messages.
  for (const route of ROUTES) {
    const channel = await getTargetChannel(route.target);
    let before;
    let deleted = 0;
    while (true) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!batch.size) break;
      const oldest = batch.reduce((a, b) => BigInt(a.id) < BigInt(b.id) ? a : b);
      for (const message of batch.values()) {
        try {
          await message.delete();
          deleted++;
        } catch (e) {
          console.error(`[CLEANUP] Gagal menghapus pesan ${message.id} di ${route.name}:`, e.message);
          throw e;
        }
      }
      before = oldest.id;
      if (batch.size < 100) break;
    }
    console.log(`[CLEANUP] ${route.name}: ${deleted} pesan dihapus.`);
  }
}

async function getTargetChannel(targetId) {
  const channel = await client.channels.fetch(targetId);
  if (!channel?.isTextBased() || typeof channel.send !== "function") throw new Error(`Channel tujuan tidak valid: ${targetId}`);
  return channel;
}
async function deleteOldMessage(account) {
  if (!account?.messageId || !account?.targetId) return;
  const channel = await client.channels.fetch(account.targetId);
  if (!channel?.isTextBased()) throw new Error(`Channel tujuan tidak valid saat menghapus embed ${account.username}.`);
  let old;
  try {
    old = await channel.messages.fetch(account.messageId);
  } catch (e) {
    if (e.code === 10008 || e.status === 404) return;
    throw e;
  }
  await old.delete();
}
async function fetchAccountMessage(channel, messageId) {
  try {
    return await channel.messages.fetch(messageId);
  } catch (e) {
    if (e.code === 10008 || e.status === 404) return null;
    throw e;
  }
}
async function removeDuplicateAccountEmbeds(channel, account, keepMessageId) {
  const messages = await channel.messages.fetch({ limit: 100 });
  const username = account.username.trim().toLowerCase();
  for (const message of messages.values()) {
    if (message.id === keepMessageId || message.author?.id !== client.user.id) continue;
    const matchesAccount = message.embeds.some(embed => {
      const title = (embed.title || "").replace(/^[🎮🔴\s]+/u, "").trim().toLowerCase();
      return title === username && (embed.footer?.text || "").includes("Maru Hub");
    });
    if (!matchesAccount) continue;
    try {
      await message.delete();
      console.log(`[DUPLICATE REMOVED] ${account.username} (${message.id})`);
    } catch (e) {
      console.error(`Gagal menghapus embed duplikat ${account.username} (${message.id}):`, e.message);
    }
  }
}
async function sendAccountEmbed(account, text, routeName, timestamp) {
  const channel = await getTargetChannel(account.targetId);
  const sent = await channel.send({ embeds: [makeEmbed(text, routeName, timestamp, false)], allowedMentions: { parse: [] } });
  account.messageId = sent.id;
  account.lastText = text;
  account.lastRouteName = routeName;
  account.lastSeen = Date.now();
  account.disconnected = false;
  account.disconnectedAt = null;
  saveState();
  await notifyIfCompleted(account, text, channel);
  return sent;
}
async function notifyIfCompleted(account, text, channel) {
  if (account.completedNotified || !isAccountComplete(text)) return;
  const status = getValue(text, ["Current Status", "Current Task", "Task"]);
  await channel.send({
    content: `✅ **${account.username} SELESAI**\nLevel 2800+, Godhuman, Skull Guitar, status: **${status}**`,
    allowedMentions: { parse: [] },
  });
  account.completedNotified = true;
  saveState();
  console.log(`[COMPLETED] ${account.username}`);
}
async function updateExistingAccount(key, account, route, text, timestamp) {
  const channel = await getTargetChannel(account.targetId);
  let old = account.messageId ? await fetchAccountMessage(channel, account.messageId) : null;
  // Edit the same message so each username keeps one embed and updates do not create duplicates.
  if (old) {
    await old.edit({ embeds: [makeEmbed(text, route.name, timestamp, false)], allowedMentions: { parse: [] } });
    account.lastText = text;
    account.lastRouteName = route.name;
    account.lastSeen = Date.now();
    account.disconnected = false;
    account.disconnectedAt = null;
    account.sourceId = route.source;
    saveState();
    await notifyIfCompleted(account, text, channel);
  } else {
    account.lastSeen = Date.now();
    account.disconnected = false;
    account.disconnectedAt = null;
    account.sourceId = route.source;
    await sendAccountEmbed(account, text, route.name, timestamp);
  }
  await removeDuplicateAccountEmbeds(channel, account, account.messageId);
  console.log(`[UPDATED] ${account.username} -> ${route.name}`);
}
async function markDisconnected(account) {
  if (account.disconnected) return;
  const channel = await getTargetChannel(account.targetId);
  if (account.messageId) {
    const msg = await channel.messages.fetch(account.messageId).catch(() => null);
    if (msg) await msg.edit({ embeds: [makeEmbed(account.lastText || `Name: ${account.username}`, account.lastRouteName || "Redfinger", new Date(account.lastSeen), true)], allowedMentions: { parse: [] } });
  }
  await channel.send({ content: `@everyone 🔴 **${account.username} DISCONNECTED**\nTidak ada update selama ${DISCONNECT_MS / 60000} menit.`, allowedMentions: { parse: ["everyone"] } });
  account.disconnected = true;
  account.disconnectedAt = Date.now();
  saveState();
  console.log(`[DISCONNECTED] ${account.username}`);
}
async function replaceAccount(oldKey, oldAccount, pendingKey, pending) {
  // Hanya hapus akun lama jika belum menerima update selama 45 menit sejak
  // username pengganti pertama kali terdeteksi. Disconnect 10 menit terpisah.
  const route = getRouteBySource(pending.sourceId);
  if (!route || route.target !== pending.targetId) return;
  const newKey = makeKey(pending.targetId, pending.username);
  if (state.accounts[newKey]) {
    delete state.pending[pendingKey];
    saveState();
    return;
  }

  await deleteOldMessage(oldAccount);
  delete state.accounts[oldKey];
  delete state.pending[pendingKey];
  const replacement = {
    username: pending.username, targetId: pending.targetId, sourceId: pending.sourceId,
    firstSeen: pending.firstSeen, lastSeen: pending.lastSeen, disconnected: false,
    disconnectedAt: null, messageId: null, lastText: pending.lastText,
    lastRouteName: pending.lastRouteName, replacementCandidateSince: null,
  };
  state.accounts[newKey] = replacement;
  saveState();
  await sendAccountEmbed(replacement, pending.lastText, pending.lastRouteName, new Date(pending.lastSeen));
  console.log(`[REPLACED] ${oldAccount.username} -> ${pending.username}`);
}

// ===================== ACCOUNT SLOTS =====================
async function handleNewAccount(route, username, text, timestamp) {
  const now = Date.now();
  const key = makeKey(route.target, username);
  const existing = state.accounts[key];
  if (existing) return updateExistingAccount(key, existing, route, text, timestamp);

  // Buat akun baru jika masih ada ruang: 8 akun per channel, maksimal 56 akun total.
  if (getTotalAccounts() < MAX_TOTAL && getAccountsForTarget(route.target).length < MAX_PER_CHANNEL) {
    const account = {
      username, targetId: route.target, sourceId: route.source, firstSeen: now, lastSeen: now,
      disconnected: false, disconnectedAt: null, messageId: null, lastText: text,
      lastRouteName: route.name, replacementCandidateSince: now,
    };
    state.accounts[key] = account;
    delete state.pending[key];
    saveState();
    await sendAccountEmbed(account, text, route.name, timestamp);
    console.log(`[NEW ACCOUNT] ${username} -> ${route.name} (total ${getTotalAccounts()}/${MAX_TOTAL})`);
    return;
  }

  // Username baru menunggu slot; timer penggantiannya dimulai saat pertama terdeteksi.
  let pending = state.pending[key];
  if (!pending) pending = { username, targetId: route.target, sourceId: route.source, firstSeen: now };
  Object.assign(pending, { lastSeen: now, lastText: text, lastRouteName: route.name, sourceId: route.source, targetId: route.target });
  state.pending[key] = pending;
  saveState();
  console.log(`[PENDING] ${username}: slot ${route.name} atau total global penuh (channel ${getAccountsForTarget(route.target).length}/${MAX_PER_CHANNEL}, total ${getTotalAccounts()}/${MAX_TOTAL}); menunggu slot`);
}

// ===================== MESSAGE EVENT =====================
client.on("messageCreate", async message => {
  try {
    if (message.author?.id === client.user?.id) return;
    const route = getRouteBySource(message.channelId);
    if (!route) return;
    const text = getMessageText(message);
    if (!text) return;
    const username = getUsername(text);
    if (!username || username === "Unknown") {
      console.log(`[${route.name}] Username tidak ditemukan. Pastikan field bernama Account/Username/Name tersedia.`);
      console.log(`[${route.name}] Preview pesan: ${text.slice(0, 350).replace(/\n/g, " | ")}`);
      return;
    }
    const normalizedUsername = username.trim();
    const key = makeKey(route.target, normalizedUsername);
    const previous = accountQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() =>
      handleNewAccount(route, normalizedUsername, text, message.createdAt)
    );
    accountQueues.set(key, current);
    try {
      await current;
    } finally {
      if (accountQueues.get(key) === current) accountQueues.delete(key);
    }
  } catch (e) { console.error("Message handler error:", e); }
});

// ===================== PERIODIC CHECK =====================
async function checkAccounts() {
  const now = Date.now();

  // Disconnect 10 menit: hanya tandai dan beri notifikasi, tidak menghapus akun.
  for (const account of Object.values(state.accounts)) {
    if (!account.disconnected && now - account.lastSeen >= DISCONNECT_MS) {
      try { await markDisconnected(account); }
      catch (e) { console.error(`Disconnect check failed for ${account.username}:`, e.message); }
    }
  }

  // Kandidat baru diproses satu per satu agar satu username baru hanya
  // menggantikan satu akun lama yang tidak update sejak kandidat terdeteksi.
  const candidates = [
    ...Object.entries(state.accounts)
      .filter(([, account]) => account.replacementCandidateSince)
      .map(([key, account]) => ({
        key,
        since: account.replacementCandidateSince,
        targetId: account.targetId,
        username: account.username,
        account,
      })),
    ...Object.entries(state.pending).map(([key, pending]) => ({
      key,
      since: pending.firstSeen,
      targetId: pending.targetId,
      username: pending.username,
      pending,
    })),
  ].sort((a, b) => a.since - b.since);

  for (const candidate of candidates) {
    if (now - candidate.since < REPLACE_MS) continue;

    const oldEntry = Object.entries(state.accounts).find(([, account]) =>
      account.targetId === candidate.targetId &&
      account.username !== candidate.username &&
      !account.replacementCandidateSince
    );

    if (!oldEntry) {
      if (candidate.account) {
        candidate.account.replacementCandidateSince = null;
        saveState();
      }
      if (candidate.pending &&
          getTotalAccounts() < MAX_TOTAL &&
          getAccountsForTarget(candidate.targetId).length < MAX_PER_CHANNEL) {
        const route = getRouteBySource(candidate.pending.sourceId);
        if (!route) continue;
        const newKey = makeKey(candidate.targetId, candidate.username);
        if (state.accounts[newKey]) {
          delete state.pending[candidate.key];
          saveState();
          continue;
        }
        const account = {
          username: candidate.username,
          targetId: candidate.targetId,
          sourceId: candidate.pending.sourceId,
          firstSeen: candidate.pending.firstSeen,
          lastSeen: candidate.pending.lastSeen,
          disconnected: false,
          disconnectedAt: null,
          messageId: null,
          lastText: candidate.pending.lastText,
          lastRouteName: candidate.pending.lastRouteName,
          replacementCandidateSince: null,
        };
        state.accounts[newKey] = account;
        delete state.pending[candidate.key];
        saveState();
        try {
          await sendAccountEmbed(account, candidate.pending.lastText, candidate.pending.lastRouteName, new Date(candidate.pending.lastSeen));
          console.log(`[NEW SLOT] ${candidate.username} (total ${getTotalAccounts()}/${MAX_TOTAL})`);
        } catch (e) { console.error("Gagal mengirim akun pending:", e.message); }
      }
      continue;
    }

    const [oldKey, oldAccount] = oldEntry;
    try {
      if (candidate.pending) {
        await replaceAccount(oldKey, oldAccount, candidate.key, candidate.pending);
      } else {
        await deleteOldMessage(oldAccount);
        delete state.accounts[oldKey];
        candidate.account.replacementCandidateSince = null;
        saveState();
        console.log(`[REPLACED] ${oldAccount.username} -> ${candidate.username}`);
      }
    } catch (e) { console.error("Gagal mengganti akun:", e.message); }
  }

  // Isi slot global yang kosong dari akun pending, jika ada.
  for (const [pendingKey, pending] of Object.entries(state.pending)) {
    if (getTotalAccounts() >= MAX_TOTAL) break;
    if (getAccountsForTarget(pending.targetId).length >= MAX_PER_CHANNEL) continue;
    if (now - pending.lastSeen >= DISCONNECT_MS) continue;
    const route = getRouteBySource(pending.sourceId);
    if (!route) continue;
    const newKey = makeKey(pending.targetId, pending.username);
    if (state.accounts[newKey]) { delete state.pending[pendingKey]; saveState(); continue; }
    const account = {
      username: pending.username, targetId: pending.targetId, sourceId: pending.sourceId,
      firstSeen: pending.firstSeen, lastSeen: pending.lastSeen, disconnected: false,
      disconnectedAt: null, messageId: null, lastText: pending.lastText,
      lastRouteName: pending.lastRouteName, replacementCandidateSince: pending.firstSeen,
    };
    state.accounts[newKey] = account;
    delete state.pending[pendingKey];
    saveState();
    try {
      await sendAccountEmbed(account, pending.lastText, pending.lastRouteName, new Date(pending.lastSeen));
      console.log(`[NEW SLOT] ${pending.username} (total ${getTotalAccounts()}/${MAX_TOTAL})`);
    } catch (e) { console.error("Gagal mengirim akun pending:", e.message); }
  }
}

client.once("clientReady", async () => {
  try {
    await clearAllTargetChannels();
    // Karena channel tujuan sudah dibersihkan, buang metadata slot lama agar tidak mengunci slot.
    state = { accounts: {}, pending: {} };
    saveState();
  } catch (e) {
    console.error("[CLEANUP] Gagal membersihkan channel tujuan. Bot tidak akan mulai memproses akun agar tidak membuat duplikat:", e.message);
    return;
  }
  console.log("======================================");
  console.log(`BOT ONLINE: ${client.user.tag}`);
  console.log(`Jumlah routing: ${ROUTES.length}`);
  console.log(`Akun terdaftar: ${getTotalAccounts()}`);
  console.log(`Batas akun per channel: ${MAX_PER_CHANNEL}`);
  console.log(`Batas total: ${MAX_TOTAL}`);
  console.log("======================================");
  for (const r of ROUTES) console.log(`${r.name}: ${r.source} -> ${r.target}`);
  checkAccounts().catch(console.error);
  setInterval(() => checkAccounts().catch(console.error), CHECK_INTERVAL);
});
client.on("error", e => console.error("Discord client error:", e));
process.on("unhandledRejection", e => console.error("Unhandled rejection:", e));
client.login(process.env.DISCORD_TOKEN);
