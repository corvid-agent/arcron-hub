/* ARCRON HUB v2 — live observer + onboarding hub for the Arcron keeper network.
   Reads upkeep boxes straight from keeper app 769891898 on Algorand TestNet,
   live global state from the corvid-agent fleet (plod / waddle / arcron-beacon /
   epitaph), the arcron pulse app 769891902, and RainRec boxes from rain hub
   770130162. Live fetch first, snapshot.json fallback. Read-only. No wallet. */
(() => {
  const KEEPER = 769891898;
  const PULSE = 769891902;
  const RAIN_HUB = 770130162;
  const ALGOD = "https://testnet-api.algonode.cloud";
  const INDEXER = "https://testnet-idx.algonode.cloud";
  const EXPLORER = "https://testnet.explorer.perawallet.app/application/";
  const REFRESH_MS = 30000;
  const ROUND_MS = 2800; // ~2.8s per round

  const KNOWN_NAMES = {
    769891898: "arcron keeper",
    769891902: "arcron pulse",
    770130162: "rain hub",
    770734249: "plod",
    770742373: "waddle",
    770742777: "arcron-beacon",
    770748282: "epitaph",
  };

  const FLEET_APPS = [
    { key: "plod", id: 770734249, name: "PLOD", repo: "https://github.com/corvid-agent/plod" },
    { key: "waddle", id: 770742373, name: "WADDLE", repo: "https://github.com/corvid-agent/waddle" },
    { key: "beacon", id: 770742777, name: "ARCRON-BEACON", repo: "https://github.com/corvid-agent/arcron-beacon" },
    { key: "epitaph", id: 770748282, name: "EPITAPH", repo: "https://github.com/corvid-agent/epitaph" },
  ];

  const PULSE_KNOWN = ["beats", "last_beat_round", "last_note"];

  /* ---- SHA-512/256 + Algorand address encoding (from corvid-agent/arrivals) ---- */
  const MASK = (1n << 64n) - 1n;
  const rotr = (x, n) => ((x >> BigInt(n)) | (x << (64n - BigInt(n)))) & MASK;
  const K512 = [
    0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
    0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
    0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
    0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
    0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
    0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
    0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
    0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
    0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
    0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
    0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
    0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
    0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
    0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
    0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
    0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
    0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
    0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
    0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
    0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
  ];
  const IV512_256 = [
    0x22312194fc2bf72cn, 0x9f555fa3c84c64c2n, 0x2393b86b6f53b151n, 0x963877195940eabdn,
    0x96283ee2a88effe3n, 0xbe5e1e2553863992n, 0x2b0199fc2c85b8aan, 0x0eb72ddc81c52ca2n,
  ];

  function sha512_256(bytes) {
    const bitLen = BigInt(bytes.length) * 8n;
    const withOne = new Uint8Array(bytes.length + 1);
    withOne.set(bytes);
    withOne[bytes.length] = 0x80;
    const pad = (128 - ((withOne.length + 16) % 128)) % 128;
    const msg = new Uint8Array(withOne.length + pad + 16);
    msg.set(withOne);
    const view = new DataView(msg.buffer);
    view.setUint32(msg.length - 8, Number((bitLen >> 32n) & 0xffffffffn));
    view.setUint32(msg.length - 4, Number(bitLen & 0xffffffffn));
    let H = IV512_256.slice();
    for (let off = 0; off < msg.length; off += 128) {
      const W = new Array(80);
      for (let t = 0; t < 16; t++) {
        const i = off + t * 8;
        W[t] = (BigInt(view.getUint32(i)) << 32n) | BigInt(view.getUint32(i + 4));
      }
      for (let t = 16; t < 80; t++) {
        const s0 = rotr(W[t - 15], 1) ^ rotr(W[t - 15], 8) ^ (W[t - 15] >> 7n);
        const s1 = rotr(W[t - 2], 19) ^ rotr(W[t - 2], 61) ^ (W[t - 2] >> 6n);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) & MASK;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let t = 0; t < 80; t++) {
        const S1 = rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K512[t] + W[t]) & MASK;
        const S0 = rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) & MASK;
        h = g; g = f; f = e; e = (d + t1) & MASK;
        d = c; c = b; b = a; a = (t1 + t2) & MASK;
      }
      H = [a, b, c, d, e, f, g, h].map((x, i) => (x + H[i]) & MASK);
    }
    const out = new Uint8Array(32);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) {
      dv.setUint32(i * 8, Number(H[i] >> 32n));
      dv.setUint32(i * 8 + 4, Number(H[i] & 0xffffffffn));
    }
    return out;
  }

  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function encodeAddress(pk) {
    const digest = sha512_256(pk);
    const data = new Uint8Array(36);
    data.set(pk);
    data.set(digest.subarray(digest.length - 4), 32);
    let bits = 0, acc = 0, out = "";
    for (const byte of data) {
      acc = (acc << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += B32[(acc >> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits) out += B32[(acc << (5 - bits)) & 31];
    return out;
  }

  /* ---- box decoding ---- */
  function b64ToBytes(b64) {
    const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToHex(bytes) {
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
  }

  function bytesToText(bytes) {
    if (!bytes.length) return null;
    let out = "";
    for (const b of bytes) {
      if (b < 32 || b >= 127) return null;
      out += String.fromCharCode(b);
    }
    return out;
  }

  function u64(dv, off) {
    return Number(dv.getBigUint64(off));
  }

  // Upkeep box name: b"u" || itob(id) — 9 bytes, first byte 0x75.
  function boxIdFromName(b64name) {
    const raw = b64ToBytes(b64name);
    if (raw.length !== 9 || raw[0] !== 0x75) return null;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    return u64(dv, 1);
  }

  // Upkeep struct — 140 bytes, big-endian, verified against keeper app 769891898:
  //   0  creator address (32 bytes)
  //  32  target_app u64        42  interval_rounds u64    50  next_execution_round u64
  //  58  fee u64               66  balance u64            82  policy u64 (0 CATCH_UP, 1 SKIP_AHEAD)
  function decodeUpkeep(id, bytes) {
    if (bytes.length < 90) throw new Error("short upkeep " + id);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      id,
      creator: encodeAddress(bytes.subarray(0, 32)),
      target_app: u64(dv, 32),
      interval: u64(dv, 42),
      next_round: u64(dv, 50),
      fee: u64(dv, 58),
      balance: u64(dv, 66),
      policy: u64(dv, 82),
    };
  }

  /* ---- app global-state decoding ----
     Global-state entries are base64 key/value; uint type=2, bytes type=1. */
  function decodeGlobalState(params) {
    const state = {};
    const kvs = (params && params["global-state"]) || [];
    for (const kv of kvs) {
      const keyBytes = b64ToBytes(kv.key);
      const key = bytesToText(keyBytes) || "0x" + bytesToHex(keyBytes);
      const v = kv.value || {};
      if (v.type === 2) {
        state[key] = { type: "uint", uint: v.uint };
      } else {
        const raw = b64ToBytes(v.bytes || "");
        state[key] = { type: "bytes", hex: bytesToHex(raw), text: bytesToText(raw) };
      }
    }
    return state;
  }

  function stateUint(state, key) {
    const e = state[key];
    return e && e.type === "uint" ? e.uint : null;
  }

  /* ---- RainRec decoding (ported from corvid-agent/arrivals docs/app.js) ----
     Layout VERIFIED against the rain contract source:
     CorvidLabs/arcron smart_contracts/rain/contract.py @ ea83b069.
     Box "r" || itob(id), 224 bytes, ARC-4 struct, big-endian, tightly packed:
       0  creator address (32B)        128  pot u64
      32  gate_creator address (32B)   136  tickets u64
      64  label byte[32] zero-padded   144  draw_id u64
      96  prize_asset u64              152  cumulative u64
     104  drip u64                     160  mode u64 (0 SPLIT, 1 ONE, 2 WAVE)
     112  interval_rounds u64          168  wave_cap u64
     120  last_rain_round u64          208  commit_round u64 · 216 prize_locked u64
     ONE lifecycle: draw locks `drip` at fire and sets
     commit_round = fire_round + COMMIT_DELAY (8); resolve is valid for
     commit_round < round <= commit_round + SEED_WINDOW (800); past that
     abandon returns the lock to the pot. resolve/abandon both reset
     prize_locked and commit_round to 0, so a settled draw reads as
     "no draw open". SPLIT/WAVE have no resolve window. */
  const RAIN_COMMIT_DELAY = 8;
  const RAIN_SEED_WINDOW = 800;
  const RAIN_MODES = ["SPLIT", "ONE", "WAVE"];

  function rainBoxIdFromName(b64name) {
    const raw = b64ToBytes(b64name);
    if (raw.length !== 9 || raw[0] !== 0x72) return null;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    return u64(dv, 1);
  }

  function decodeRain(id, bytes) {
    if (bytes.length < 224) throw new Error("short rain " + id);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = 64;
    while (end < 96 && bytes[end] !== 0) end++;
    let name = "";
    for (let i = 64; i < end; i++) {
      const c = bytes[i];
      name += c >= 32 && c < 127 ? String.fromCharCode(c) : " ";
    }
    return {
      id,
      name: name.trim() || "rain " + id,
      prize_asset: u64(dv, 96),
      drip: u64(dv, 104),
      interval_rounds: u64(dv, 112),
      last_rain_round: u64(dv, 120),
      pot: u64(dv, 128),
      tickets: u64(dv, 136),
      draw_id: u64(dv, 144),
      mode: u64(dv, 160),
      wave_cap: u64(dv, 168),
      commit_round: u64(dv, 208),
      prize_locked: u64(dv, 216),
    };
  }

  function rainModeLabel(mode) {
    return RAIN_MODES[mode] || "MODE " + mode;
  }

  // Real resolve-window status from the verified fields above.
  function rainWindow(r, round) {
    const mode = rainModeLabel(r.mode);
    if (r.mode !== 1) {
      if (r.mode !== 0 && r.mode !== 2) {
        return { text: "MODE " + r.mode, sub: "unknown", cls: "unknown", title: "unrecognized mode u64 at r-box offset 160" };
      }
      return {
        text: r.mode === 2 ? "GM WAVE" : "AUTO-SPLIT",
        sub: "no window",
        cls: "ontime",
        title: mode + " rain · fires split the drip automatically · no resolve window in the contract",
      };
    }
    const lockNote = "draw " + r.draw_id + " · locked " + r.prize_locked + " µ units · commit round " + r.commit_round;
    if (!r.prize_locked) {
      const due = r.last_rain_round + r.interval_rounds;
      const isDue = round != null && round >= due;
      return {
        text: "WAITING DRAW",
        sub: round != null ? (isDue ? "draw due" : "in " + (due - round) + "r") : "due " + due,
        cls: isDue ? "delayed" : "ontime",
        title: "ONE rain · no draw open · next fire due round " + due,
      };
    }
    const resolveBy = r.commit_round + RAIN_SEED_WINDOW;
    if (round == null) {
      return { text: "DRAW OPEN", sub: "by " + resolveBy, cls: "delayed", title: lockNote + " · resolve by round " + resolveBy };
    }
    if (round <= r.commit_round) {
      return {
        text: "SEED LOCK",
        sub: "T-" + (r.commit_round - round) + "r",
        cls: "delayed",
        title: lockNote + " (fire + " + RAIN_COMMIT_DELAY + ") · seed not readable until the commit round passes",
      };
    }
    if (round <= resolveBy) {
      const left = resolveBy - round;
      return {
        text: "RESOLVE",
        sub: left + "r left",
        cls: left < 200 ? "delayed" : "ontime",
        title: lockNote + " · resolve by round " + resolveBy + " (commit + " + RAIN_SEED_WINDOW + ") · " + left + "r left",
      };
    }
    return {
      text: "MISSED",
      sub: "abandonable",
      cls: "grounded",
      title: lockNote + " · seed window closed at round " + resolveBy + " · abandon() now returns the lock to the pot",
    };
  }

  /* ---- fleet live-status derivations ---- */
  // arcron-beacon alternates PLAN (set target_round = round + delay_rounds)
  // and REVEAL (reveal the committed seed once target_round passes).
  function beaconPhase(st, round) {
    const target = stateUint(st, "target_round");
    const revealed = stateUint(st, "revealed_round") || 0;
    const delay = stateUint(st, "delay_rounds");
    if (target == null) {
      return { text: "NO PLAN", sub: "no target set", cls: "unknown", title: "target_round key missing from beacon global state" };
    }
    if (target > 0 && revealed >= target) {
      return {
        text: "PLAN",
        sub: "next target pending",
        cls: "ontime",
        title: "beacon revealed round " + revealed + " · waiting to plan the next commit (delay " + delay + "r)",
      };
    }
    const left = round != null ? target - round : null;
    return {
      text: "REVEAL",
      sub: left != null ? (left > 0 ? "T-" + left + "r" : "DUE NOW") : "target " + target,
      cls: left != null && left <= 0 ? "delayed" : "ontime",
      title: "commit-reveal in flight · reveal valid once round passes target " + target +
        (delay != null ? " (delay " + delay + "r)" : "") + " · last reveal " + revealed,
    };
  }

  // epitaph dead-man's switch: PUBLISHED once the payload is out; otherwise
  // ARMED until last_checkin_round + timeout_rounds, EXPIRED past it.
  function epitaphState(st, round) {
    const published = stateUint(st, "published") || 0;
    const timeout = stateUint(st, "timeout_rounds");
    const checkin = stateUint(st, "last_checkin_round");
    if (published) {
      const rr = stateUint(st, "revealed_round");
      return {
        text: "PUBLISHED",
        sub: rr ? "revealed round " + rr : "payload out",
        cls: "ontime",
        title: "published flag set · the epitaph payload has been released",
      };
    }
    if (timeout == null || checkin == null) {
      return { text: "UNKNOWN", sub: "missing keys", cls: "unknown", title: "timeout_rounds / last_checkin_round missing from global state" };
    }
    const deadline = checkin + timeout;
    if (round != null && round > deadline) {
      return {
        text: "EXPIRED",
        sub: "deadline " + deadline,
        cls: "grounded",
        title: "no check-in since round " + checkin + " · timeout " + timeout + "r passed at round " + deadline + " · anyone may publish",
      };
    }
    return {
      text: "ARMED",
      sub: round != null ? "deadline in " + (deadline - round) + "r" : "deadline " + deadline,
      cls: "delayed",
      title: "last check-in round " + checkin + " + timeout " + timeout + "r · publishes if no check-in by round " + deadline,
    };
  }

  /* ---- formatting ---- */
  function appName(id) {
    return KNOWN_NAMES[id] ? KNOWN_NAMES[id].toUpperCase() : String(id);
  }

  function algo(micro) {
    return (micro / 1e6).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }

  function etaLabel(deltaRounds) {
    if (deltaRounds <= 0) return "DUE NOW";
    const sec = deltaRounds * (ROUND_MS / 1000);
    if (sec < 90) return Math.round(sec) + "s";
    if (sec < 3600) return "~" + Math.round(sec / 60) + "m";
    if (sec < 86400) return "~" + (sec / 3600).toFixed(1) + "h";
    return "~" + (sec / 86400).toFixed(1) + "d";
  }

  function intervalLabel(rounds) {
    const sec = rounds * (ROUND_MS / 1000);
    if (sec < 90) return rounds + "r";
    if (sec < 3600) return rounds + "r ~" + Math.round(sec / 60) + "m";
    if (sec < 86400) return rounds + "r ~" + (sec / 3600).toFixed(1) + "h";
    return rounds + "r ~" + (sec / 86400).toFixed(1) + "d";
  }

  function shortAddr(addr) {
    return addr.slice(0, 4) + "…" + addr.slice(-4);
  }

  /* ---- split-flap ---- */
  function flaps(text, size) {
    const wrap = document.createElement("span");
    wrap.className = "flaps";
    wrap.style.fontSize = size || "";
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
      const cell = document.createElement("span");
      cell.className = "flap";
      cell.style.setProperty("--d", (i * 28) + "ms");
      cell.textContent = s[i] === " " ? " " : s[i];
      wrap.appendChild(cell);
    }
    return wrap;
  }

  function setFlaps(el, text, size) {
    if (el.dataset.flapText === String(text)) return;
    el.dataset.flapText = String(text);
    el.replaceChildren(flaps(text, size));
  }

  /* ---- fetching ---- */
  async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(url + " " + res.status);
    return res.json();
  }

  async function listBoxes(appId) {
    const boxes = [];
    let url = INDEXER + "/v2/applications/" + appId + "/boxes";
    for (let i = 0; i < 20; i++) {
      const page = await fetchJson(url);
      for (const b of page.boxes || []) boxes.push(b.name);
      if (!page["next-token"]) break;
      url = INDEXER + "/v2/applications/" + appId + "/boxes?next=" + encodeURIComponent(page["next-token"]);
    }
    return boxes;
  }

  async function fetchAppState(appId) {
    const app = await fetchJson(INDEXER + "/v2/applications/" + appId);
    return decodeGlobalState(app.application && app.application.params);
  }

  async function fetchLive() {
    const status = await fetchJson(ALGOD + "/v2/status");
    const last_round = status["last-round"];
    const listed = await fetchJson(ALGOD + "/v2/applications/" + KEEPER + "/boxes");
    const names = (listed.boxes || []).map((b) => b.name);
    const upkeeps = await Promise.all(names.map(async (name) => {
      const id = boxIdFromName(name);
      if (id == null) return null;
      const box = await fetchJson(
        ALGOD + "/v2/applications/" + KEEPER + "/box?name=b64:" + encodeURIComponent(name)
      );
      return decodeUpkeep(id, b64ToBytes(box.value));
    }));
    return {
      last_round,
      fetched_at: Date.now(),
      upkeeps: upkeeps.filter(Boolean),
      mode: "live",
      note: "algod " + ALGOD.replace("https://", "") + " · refresh 30s",
      generated_at: null,
    };
  }

  async function fetchSnapshot() {
    const snap = await fetchJson("snapshot.json");
    return {
      last_round: snap.last_round,
      fetched_at: null,
      upkeeps: snap.upkeeps || [],
      mode: "fallback",
      note: "snapshot " + (snap.generated_at || "") + " · live fetch failed",
      generated_at: snap.generated_at,
    };
  }

  /* ---- fleet status feed ---- */
  async function fetchFleetLive() {
    const status = await fetchJson(ALGOD + "/v2/status");
    const entries = {};
    await Promise.all(FLEET_APPS.map(async (f) => {
      entries[f.key] = await fetchAppState(f.id);
    }));
    return { mode: "live", last_round: status["last-round"], entries };
  }

  async function fetchFleetSnapshot() {
    const snap = await fetchJson("snapshot.json");
    if (!snap.fleet) return null;
    return { mode: "fallback", last_round: snap.last_round, entries: snap.fleet };
  }

  /* ---- pulse feed ---- */
  async function fetchPulseLive() {
    const status = await fetchJson(ALGOD + "/v2/status");
    const state = await fetchAppState(PULSE);
    return { mode: "live", last_round: status["last-round"], state };
  }

  async function fetchPulseSnapshot() {
    const snap = await fetchJson("snapshot.json");
    if (!snap.pulse) return null;
    return { mode: "fallback", last_round: snap.last_round, state: snap.pulse };
  }

  /* ---- rain feed ---- */
  async function fetchRainLive() {
    const status = await fetchJson(ALGOD + "/v2/status");
    const last_round = status["last-round"];
    const hub = await fetchAppState(RAIN_HUB);
    const names = await listBoxes(RAIN_HUB);
    const rains = await Promise.all(names.map(async (name) => {
      const id = rainBoxIdFromName(name);
      if (id == null) return null;
      const box = await fetchJson(INDEXER + "/v2/applications/" + RAIN_HUB + "/box?name=b64:" + encodeURIComponent(name));
      return decodeRain(id, b64ToBytes(box.value));
    }));
    return {
      hub,
      rains: rains.filter(Boolean).sort((a, b) => a.id - b.id),
      last_round,
      mode: "live",
    };
  }

  async function fetchRainSnapshot() {
    const snap = await fetchJson("snapshot.json");
    if (!snap.rain || !Array.isArray(snap.rain.rains)) return null;
    return {
      hub: snap.rain.hub || {},
      rains: snap.rain.rains,
      last_round: snap.last_round,
      mode: "fallback",
    };
  }

  /* ---- rendering ---- */
  let frame = null;

  // Live rounds advance between refreshes at ~2.8s/round; snapshots are frozen.
  function estimatedRound() {
    if (!frame) return null;
    if (frame.mode !== "live" || frame.fetched_at == null) return frame.last_round;
    return frame.last_round + Math.floor((Date.now() - frame.fetched_at) / ROUND_MS);
  }

  // Round source for the secondary feeds: prefer the main board's live clock,
  // fall back to the feed's own last_round (snapshot or live fetch).
  function feedRound(feedFrame) {
    const r = estimatedRound();
    if (r != null) return r;
    return feedFrame && feedFrame.last_round != null ? feedFrame.last_round : null;
  }

  function setMode(mode, note) {
    const el = document.getElementById("feed-mode");
    el.textContent = mode === "live" ? "LIVE" : mode === "fallback" ? "SNAPSHOT" : "SEEKING";
    el.className = "mode " + (mode === "live" ? "live" : mode === "fallback" ? "fallback" : "unknown");
    document.getElementById("feed-note").textContent = note || "";
    const banner = document.getElementById("snap-banner");
    if (mode === "fallback" && frame) {
      banner.classList.remove("hidden");
      document.getElementById("snap-round").textContent = String(frame.last_round);
    } else {
      banner.classList.add("hidden");
    }
  }

  function policyBadge(p) {
    if (p === 1) return { text: "SKIP AHEAD", cls: "skip", title: "policy 1 · skips missed intervals, next fire is always in the future · healthy" };
    if (p === 0) return { text: "CATCH UP", cls: "catchup", title: "policy 0 · replays every missed interval · the trap: one due upkeep can demand many back-to-back executions" };
    return { text: "POL " + p, cls: "unknown", title: "unrecognized policy u64 at offset 82" };
  }

  function kvRow(label, value, title) {
    const row = document.createElement("div");
    row.className = "kv-row";
    const k = document.createElement("span");
    k.className = "kv-k";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = "kv-v crt-num";
    if (title) v.title = title;
    if (value instanceof Node) v.appendChild(value);
    else v.textContent = value;
    row.append(k, v);
    return row;
  }

  function statusTag(w) {
    const tag = document.createElement("div");
    tag.className = "status-tag " + w.cls;
    tag.title = w.title || "";
    tag.textContent = w.text;
    return tag;
  }

  function render(f) {
    frame = f;
    f.upkeeps.sort((a, b) => a.next_round - b.next_round || a.id - b.id);
    setMode(f.mode, f.note);

    const round = estimatedRound();
    const roundEl = document.getElementById("round-digits");
    roundEl.dataset.flapText = "";
    setFlaps(roundEl, round != null ? String(round) : "········", "26px");

    // totals band
    setFlaps(document.getElementById("t-count"), String(f.upkeeps.length), "34px");
    const escrow = f.upkeeps.reduce((s, u) => s + u.balance, 0);
    setFlaps(document.getElementById("t-escrow"), algo(escrow) + " A", "34px");
    const soonest = f.upkeeps.length ? f.upkeeps[0] : null;
    const soonEl = document.getElementById("t-soonest");
    if (soonest) {
      setFlaps(soonEl, String(soonest.next_round), "34px");
      soonEl.title = "upkeep " + soonest.id + " → " + appName(soonest.target_app);
    } else {
      setFlaps(soonEl, "—", "34px");
    }

    // upkeep board
    const board = document.getElementById("board");
    board.replaceChildren();
    document.getElementById("empty").classList.toggle("hidden", f.upkeeps.length > 0);

    f.upkeeps.forEach((u) => {
      const row = document.createElement("div");
      row.className = "row";
      row.setAttribute("role", "row");

      const id = document.createElement("div");
      id.appendChild(flaps(String(u.id).padStart(3, "0"), "20px"));

      const dest = document.createElement("div");
      const destA = document.createElement("a");
      destA.className = "dest-link";
      destA.href = EXPLORER + u.target_app;
      destA.title = "app " + u.target_app;
      destA.appendChild(flaps(appName(u.target_app).slice(0, 14), "16px"));
      dest.appendChild(destA);
      if (KNOWN_NAMES[u.target_app]) {
        const sub = document.createElement("div");
        sub.className = "tiny";
        sub.textContent = String(u.target_app);
        dest.appendChild(sub);
      }

      const creator = document.createElement("div");
      creator.className = "creator";
      creator.title = u.creator;
      creator.textContent = shortAddr(u.creator);

      const intv = document.createElement("div");
      intv.className = "crt-num";
      intv.title = u.interval + " rounds";
      intv.textContent = intervalLabel(u.interval);

      const next = document.createElement("div");
      next.className = "crt-num";
      next.textContent = String(u.next_round);

      const eta = document.createElement("div");
      eta.className = "crt-num eta-cell";
      eta.dataset.next = String(u.next_round);
      eta.textContent = round != null ? etaLabel(u.next_round - round) : "—";

      const fee = document.createElement("div");
      fee.className = "crt-num";
      fee.title = u.fee + " µALGO per execution";
      fee.textContent = String(u.fee);

      const bal = document.createElement("div");
      bal.className = "crt-num";
      bal.title = u.balance + " µALGO escrowed";
      bal.textContent = algo(u.balance);

      const p = policyBadge(u.policy);
      const pol = document.createElement("div");
      pol.className = "badge " + p.cls;
      pol.title = p.title;
      pol.textContent = p.text;

      row.append(id, dest, creator, intv, next, eta, fee, bal, pol);
      board.appendChild(row);
    });

    const stamp = document.getElementById("stamp");
    const when = f.generated_at ? "snapshot " + f.generated_at : "painted " + new Date().toISOString();
    stamp.textContent = "TestNet only · last-round " + f.last_round + " · " + when + " · chain is source of truth.";
  }

  /* ---- fleet status rendering ---- */
  // Live countdown elements re-evaluated every second by tickSecond().
  let fleetTickers = [];

  function fleetRows(key, st, rows, round) {
    if (key === "plod" || key === "waddle") {
      const keeperKey = key === "plod" ? "keeper_app" : "keeper_id";
      const calls = stateUint(st, "calls");
      const lastRound = stateUint(st, "last_round");
      const keeperApp = stateUint(st, keeperKey);
      rows.appendChild(kvRow("CALLS", calls != null ? String(calls) : "—",
        calls != null ? "calls u64" : "calls key not set yet (created on first execution)"));
      rows.appendChild(kvRow("LAST ROUND", lastRound != null ? String(lastRound) : "—",
        lastRound != null ? "last_round u64" : "last_round key not set yet"));
      rows.appendChild(kvRow("KEEPER", keeperApp != null ? String(keeperApp) : "—",
        keeperKey + " u64 · the Arcron keeper app this contract is serviced through"));
      return;
    }
    if (key === "beacon") {
      const reveals = stateUint(st, "reveals");
      const revealedRound = stateUint(st, "revealed_round");
      const targetRound = stateUint(st, "target_round");
      const delay = stateUint(st, "delay_rounds");
      rows.appendChild(kvRow("REVEALS", reveals != null ? String(reveals) : "—", "reveals u64 · seeds revealed so far"));
      const phase = beaconPhase(st, round);
      const tag = statusTag(phase);
      const sub = document.createElement("span");
      sub.className = "tiny";
      sub.textContent = phase.sub;
      const cell = document.createElement("span");
      cell.append(tag, " ", sub);
      rows.appendChild(kvRow("PHASE", cell));
      fleetTickers.push({ kind: "beacon", st, tag, sub });
      rows.appendChild(kvRow("TARGET ROUND", targetRound != null ? String(targetRound) : "—", "target_round u64 · reveal valid once this round passes"));
      rows.appendChild(kvRow("REVEALED ROUND", revealedRound != null ? String(revealedRound) : "—", "revealed_round u64 · round of the last reveal"));
      rows.appendChild(kvRow("DELAY", delay != null ? intervalLabel(delay) : "—", "delay_rounds u64" + (delay != null ? " = " + delay + " rounds" : "")));
      return;
    }
    if (key === "epitaph") {
      const state = epitaphState(st, round);
      const tag = statusTag(state);
      const sub = document.createElement("span");
      sub.className = "tiny";
      sub.textContent = state.sub;
      const cell = document.createElement("span");
      cell.append(tag, " ", sub);
      rows.appendChild(kvRow("STATE", cell));
      fleetTickers.push({ kind: "epitaph", st, tag, sub });
      const checkin = stateUint(st, "last_checkin_round");
      const timeout = stateUint(st, "timeout_rounds");
      rows.appendChild(kvRow("LAST CHECK-IN", checkin != null ? String(checkin) : "—", "last_checkin_round u64"));
      rows.appendChild(kvRow("TIMEOUT", timeout != null ? intervalLabel(timeout) : "—", "timeout_rounds u64" + (timeout != null ? " = " + timeout + " rounds" : "")));
      rows.appendChild(kvRow("PUBLISHED", (stateUint(st, "published") || 0) ? "YES" : "NO", "published u64 flag"));
    }
  }

  function renderFleetStatus(ff) {
    const wrap = document.getElementById("fleet-status");
    const empty = document.getElementById("fleet-status-empty");
    const note = document.getElementById("fleet-status-note");
    wrap.replaceChildren();
    fleetTickers = [];
    if (!ff) {
      empty.classList.remove("hidden");
      note.textContent = "feed down";
      return;
    }
    empty.classList.add("hidden");
    const round = feedRound(ff);
    note.textContent = (ff.mode === "live" ? "live indexer" : "snapshot") + " · global state per app" + (round != null ? " · round " + round : "");

    FLEET_APPS.forEach((f) => {
      const st = ff.entries[f.key] || {};
      const card = document.createElement("div");
      card.className = "status-card";

      const head = document.createElement("div");
      head.className = "status-head";
      const nm = document.createElement("a");
      nm.className = "status-name";
      nm.href = f.repo;
      nm.textContent = f.name;
      const link = document.createElement("a");
      link.className = "tiny";
      link.href = EXPLORER + f.id;
      link.textContent = "app " + f.id;
      head.append(nm, link);
      card.appendChild(head);

      const rows = document.createElement("div");
      rows.className = "status-rows";
      fleetRows(f.key, st, rows, round);
      card.appendChild(rows);
      wrap.appendChild(card);
    });
  }

  /* ---- pulse rendering ---- */
  let pulseTickers = [];

  function pulseKeys(state) {
    const keys = Object.keys(state);
    const known = PULSE_KNOWN.filter((k) => keys.includes(k));
    const rest = keys.filter((k) => !PULSE_KNOWN.includes(k)).sort();
    return known.concat(rest);
  }

  function renderPulse(pf) {
    const board = document.getElementById("pulse-board");
    const empty = document.getElementById("pulse-empty");
    const note = document.getElementById("pulse-note");
    board.replaceChildren();
    pulseTickers = [];
    if (!pf || !pf.state || !Object.keys(pf.state).length) {
      empty.classList.remove("hidden");
      empty.textContent = pf ? "pulse app has no global state yet" : "pulse feed down";
      note.textContent = pf ? pf.mode : "feed down";
      return;
    }
    empty.classList.add("hidden");
    const round = feedRound(pf);
    note.textContent = "app " + PULSE + " · " + (pf.mode === "live" ? "live indexer" : "snapshot") +
      (round != null ? " · round " + round : "");

    pulseKeys(pf.state).forEach((key) => {
      const e = pf.state[key];
      const row = document.createElement("div");
      row.className = "kv-row pulse-row";

      const k = document.createElement("span");
      k.className = "kv-k";
      k.textContent = key;

      const v = document.createElement("span");
      v.className = "kv-v crt-num";

      if (key === "beats" && e.type === "uint") {
        v.appendChild(flaps(String(e.uint), "22px"));
        v.title = "beats u64 · total pulses emitted";
      } else if (key === "last_beat_round" && e.type === "uint") {
        const ago = document.createElement("span");
        ago.textContent = round != null ? String(e.uint) + " (" + Math.max(0, round - e.uint) + "r ago)" : String(e.uint);
        v.appendChild(ago);
        v.title = "last_beat_round u64";
        pulseTickers.push({ el: ago, at: e.uint });
      } else if (key === "last_note" && e.type === "bytes" && e.text != null) {
        v.textContent = "“" + e.text + "”";
        v.title = "last_note bytes · 0x" + e.hex;
      } else if (e.type === "uint") {
        v.textContent = String(e.uint);
        v.title = "unrecognized uint key · raw value";
      } else {
        v.textContent = "0x" + e.hex;
        v.title = "unrecognized bytes key · raw hex";
      }

      row.append(k, v);
      board.appendChild(row);
    });
  }

  /* ---- rain rendering ---- */
  let rainTickers = [];

  function renderRain(rf) {
    const board = document.getElementById("rain-board");
    const empty = document.getElementById("rain-empty");
    const note = document.getElementById("rain-hub-note");
    board.replaceChildren();
    rainTickers = [];
    if (!rf || !rf.rains || !rf.rains.length) {
      empty.classList.remove("hidden");
      empty.textContent = rf ? "No rain records on hub 770130162." : "rain feed down";
      note.textContent = rf ? rf.mode + " · no records" : "feed down";
      return;
    }
    empty.classList.add("hidden");
    const hub = rf.hub || {};
    const round = feedRound(rf);
    const parts = [];
    const nextRainId = stateUint(hub, "next_rain_id");
    const cursor = stateUint(hub, "cursor");
    if (nextRainId != null) parts.push("next_rain_id " + nextRainId);
    if (cursor != null) parts.push("cursor " + cursor);
    if (round != null) parts.push("round " + round);
    parts.push(rf.mode === "live" ? "live" : "snapshot");
    note.textContent = parts.join(" · ");

    rf.rains.forEach((r) => {
      const row = document.createElement("div");
      row.className = "rain-row";
      row.setAttribute("role", "row");

      const rid = document.createElement("div");
      rid.appendChild(flaps("R" + String(r.id).padStart(2, "0"), "18px"));

      const name = document.createElement("div");
      name.appendChild(flaps(String(r.name).slice(0, 16).toUpperCase(), "15px"));

      const mode = document.createElement("div");
      mode.className = "tiny";
      mode.title = "mode u64 at r-box offset 160 · 0 SPLIT · 1 ONE · 2 WAVE";
      mode.textContent = rainModeLabel(r.mode);

      const pot = document.createElement("div");
      pot.className = "crt-num";
      pot.title = "pot u64 at offset 128 = " + r.pot + " µ units" +
        (r.prize_asset ? " of ASA " + r.prize_asset : " (ALGO)") + " · drip " + r.drip + " µ every " + r.interval_rounds + "r";
      pot.textContent = r.prize_asset ? r.pot + " ASA" : algo(r.pot) + " A";

      const tickets = document.createElement("div");
      tickets.className = "crt-num";
      tickets.title = "tickets u64 at offset 136 · draw_id " + r.draw_id;
      tickets.textContent = String(r.tickets);

      const due = r.last_rain_round + r.interval_rounds;
      const next = document.createElement("div");
      next.className = "crt-num";
      next.title = "last_rain_round " + r.last_rain_round + " (offset 120) + interval " + r.interval_rounds +
        (round != null && round >= due ? " · due now" : "");
      next.textContent = String(due);

      const w = rainWindow(r, round);
      const win = document.createElement("div");
      const tag = statusTag(w);
      const wsub = document.createElement("div");
      wsub.className = "tiny rain-win-sub";
      wsub.textContent = w.sub;
      win.append(tag, wsub);
      rainTickers.push({ tag, sub: wsub, r });

      row.append(rid, name, mode, pot, tickets, next, win);
      board.appendChild(row);
    });
  }

  // Per-second tick: advance the round display and refresh countdowns.
  function tickSecond() {
    if (!frame) return;
    const round = estimatedRound();
    if (round == null) return;
    setFlaps(document.getElementById("round-digits"), String(round), "26px");
    document.querySelectorAll(".eta-cell").forEach((cell) => {
      cell.textContent = etaLabel(Number(cell.dataset.next) - round);
    });
    if (frame.upkeeps.length) {
      const soon = frame.upkeeps[0];
      document.getElementById("t-soonest-eta").textContent =
        "upkeep " + soon.id + " → " + appName(soon.target_app) + " · ETA " + etaLabel(soon.next_round - round);
    }
    fleetTickers.forEach((t) => {
      const w = t.kind === "beacon" ? beaconPhase(t.st, round) : epitaphState(t.st, round);
      if (t.tag.textContent !== w.text) {
        t.tag.textContent = w.text;
        t.tag.className = "status-tag " + w.cls;
        t.tag.title = w.title || "";
      }
      t.sub.textContent = w.sub;
    });
    pulseTickers.forEach((t) => {
      t.el.textContent = String(t.at) + " (" + Math.max(0, round - t.at) + "r ago)";
    });
    rainTickers.forEach((t) => {
      const w = rainWindow(t.r, round);
      if (t.tag.textContent !== w.text) {
        t.tag.textContent = w.text;
        t.tag.className = "status-tag " + w.cls;
        t.tag.title = w.title || "";
      }
      t.sub.textContent = w.sub;
    });
  }

  async function tick() {
    try {
      render(await fetchLive());
    } catch (err) {
      console.warn("live fetch failed, using snapshot", err);
      try {
        render(await fetchSnapshot());
      } catch (err2) {
        setMode("unknown", "live and snapshot both failed");
        console.error(err2);
      }
    }
  }

  async function tickFleet() {
    try {
      renderFleetStatus(await fetchFleetLive());
    } catch (err) {
      console.warn("live fleet fetch failed, trying snapshot", err);
      try {
        renderFleetStatus(await fetchFleetSnapshot());
      } catch (err2) {
        console.warn("fleet snapshot failed", err2);
        renderFleetStatus(null);
      }
    }
  }

  async function tickPulse() {
    try {
      renderPulse(await fetchPulseLive());
    } catch (err) {
      console.warn("live pulse fetch failed, trying snapshot", err);
      try {
        renderPulse(await fetchPulseSnapshot());
      } catch (err2) {
        console.warn("pulse snapshot failed", err2);
        renderPulse(null);
      }
    }
  }

  async function tickRain() {
    try {
      renderRain(await fetchRainLive());
    } catch (err) {
      console.warn("live rain fetch failed, trying snapshot", err);
      try {
        renderRain(await fetchRainSnapshot());
      } catch (err2) {
        console.warn("rain snapshot failed", err2);
        renderRain(null);
      }
    }
  }

  tick();
  tickFleet();
  tickPulse();
  tickRain();
  setInterval(tick, REFRESH_MS);
  setInterval(tickFleet, REFRESH_MS);
  setInterval(tickPulse, REFRESH_MS);
  setInterval(tickRain, REFRESH_MS);
  setInterval(tickSecond, 1000);
})();
