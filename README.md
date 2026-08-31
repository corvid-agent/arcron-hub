# ARCRON HUB

Live network observer + onboarding hub for **Arcron**, the permissionless keeper
network on Algorand TestNet. Single static page, no build step, no wallet, read-only.

**Site:** `docs/index.html` (served via GitHub Pages from `/docs`, or just open the
file — it works from `file://` too).

## What it shows

- **Current round** — split-flap clock from algod `/v2/status`, advanced locally at
  ~2.8 s/round between 30 s refreshes.
- **Totals band** — upkeep count, total ALGO escrowed (sum of box balances), and the
  soonest `next_execution_round` with a live ETA countdown.
- **Upkeep board** — every upkeep registered on keeper app
  [769891898](https://testnet.explorer.perawallet.app/application/769891898):
  id, named target app, short creator address, interval, next round + ETA, fee,
  escrow balance, and the policy badge (`SKIP AHEAD` healthy, `CATCH UP` trap).
- **Fleet status band** — live global state (via the indexer) from each
  corvid-agent contract kept alive by Arcron:
  - [plod](https://github.com/corvid-agent/plod) `770734249` — `calls`,
    `last_round`, `keeper_app` counters.
  - [waddle](https://github.com/corvid-agent/waddle) `770742373` — `calls`,
    `last_round`, `keeper_id` (`calls`/`last_round` appear after the first
    execution; until then the keys simply don't exist and render as `—`).
  - [arcron-beacon](https://github.com/corvid-agent/arcron-beacon) `770742777` —
    `reveals` count plus the live commit-reveal phase: `REVEAL` with a `T-Nr`
    countdown to `target_round`, or `PLAN` once `revealed_round ≥ target_round`.
  - epitaph `770748282` — dead-man's switch state derived from
    `timeout_rounds` + `last_checkin_round` vs the current round plus the
    `published` flag: `ARMED` (deadline countdown), `EXPIRED` (past
    `last_checkin_round + timeout_rounds`), or `PUBLISHED`.
- **Pulse feed** — app
  [769891902](https://testnet.explorer.perawallet.app/application/769891902)
  ("arcron pulse"). Global-state keys are discovered live and rendered as a
  compact feed: `beats` counter, `last_beat_round` (with rounds-ago), and the
  `last_note` bytes as text. Unrecognized keys render raw (uints as decimal,
  bytes as hex).
- **Rain feed** — every RainRec on rain hub
  [770130162](https://testnet.explorer.perawallet.app/application/770130162):
  label, mode, pot, tickets, next fire round, and the live resolve-window state
  (`WAITING DRAW` / `SEED LOCK` / `RESOLVE` countdown / `MISSED` /
  `AUTO-SPLIT` / `GM WAVE`), ported from the verified decoder in
  [corvid-agent/arrivals](https://github.com/corvid-agent/arrivals).
- **Fleet band** — corvid-agent apps kept alive by Arcron
  ([plod](https://github.com/corvid-agent/plod),
  [waddle](https://github.com/corvid-agent/waddle),
  [arcron-beacon](https://github.com/corvid-agent/arcron-beacon)).
- **What is Arcron** — explainer + onboarding links
  ([CorvidLabs/arcron](https://github.com/CorvidLabs/arcron),
  [field-guide](https://github.com/corvid-agent/field-guide),
  [arrivals](https://github.com/corvid-agent/arrivals)).

## Data flow: live, then snapshot

1. The page fetches `https://testnet-api.algonode.cloud/v2/status` for the round and
   `.../v2/applications/769891898/boxes` for the upkeep box list (names are base64).
2. Each upkeep box (`b"u" || itob(id)`, 9 bytes, first byte `0x75`) is fetched via
   `.../box?name=b64:<urlencoded base64 name>` and decoded client-side.
3. Fleet status and the pulse feed read app global state from the indexer,
   `https://testnet-idx.algonode.cloud/v2/applications/{id}` — entries are base64
   key/value pairs, uint `type=2`, bytes `type=1`.
4. The rain feed lists rain hub boxes through the indexer (paginated), keeps the
   `b"r" || itob(id)` records, and decodes each 224-byte RainRec.
5. Each feed is independent: if its live fetch fails, that section renders from
   `docs/snapshot.json` instead, and the main board additionally shows a
   `SNAPSHOT as-of round N` banner.

## Box decode (upkeep: 140-byte big-endian struct)

| Offset | Field                    | Type         |
|-------:|--------------------------|--------------|
| 0      | creator address          | 32 bytes     |
| 32     | target_app               | u64          |
| 42     | interval_rounds          | u64          |
| 50     | next_execution_round     | u64          |
| 58     | fee (µALGO/execution)    | u64          |
| 66     | balance (µALGO escrow)   | u64          |
| 82     | policy (0 CATCH_UP, 1 SKIP_AHEAD) | u64 |

## Box decode (RainRec: 224-byte big-endian ARC-4 struct)

Box name `b"r" || itob(id)`. Verified against `CorvidLabs/arcron`
`smart_contracts/rain/contract.py @ ea83b069`:

| Offset | Field             | Offset | Field          |
|-------:|-------------------|-------:|----------------|
| 0      | creator (32B)     | 128    | pot u64        |
| 32     | gate_creator (32B)| 136    | tickets u64    |
| 64     | label byte[32]    | 144    | draw_id u64    |
| 96     | prize_asset u64   | 152    | cumulative u64 |
| 104    | drip u64          | 160    | mode u64 (0 SPLIT, 1 ONE, 2 WAVE) |
| 112    | interval_rounds u64 | 168  | wave fields (wave_cap …) |
| 120    | last_rain_round u64 | 208  | commit_round u64 |
|        |                   | 216    | prize_locked u64 |

ONE-mode draws lock `drip` at fire and set `commit_round = fire + COMMIT_DELAY (8)`;
resolve is valid for `commit_round < round ≤ commit_round + SEED_WINDOW (800)`;
past that, `abandon()` returns the lock to the pot. SPLIT/WAVE have no resolve
window.

Creator bytes are a raw 32-byte public key; the Algorand address is
`base32(pubkey || sha512_256(pubkey)[28:32])`. `docs/app.js` implements SHA-512/256
and base32 in pure JS (no dependencies); the decode was validated against
`py-algorand-sdk`-equivalent Python and live chain state (upkeep 110 → plod,
111 → waddle, 112 → arcron-beacon; JS and Python decodes of all upkeep and rain
boxes diff clean).

## Enabling GitHub Pages

Settings → Pages → Build and deployment → **Deploy from a branch** → branch `main`,
folder `/docs`. Save. The site appears at
`https://corvid-agent.github.io/arcron-hub/`.

## Regenerating the snapshot

```sh
python3 - <<'EOF'
import urllib.request, urllib.parse, json, base64, hashlib, datetime
A = "https://testnet-api.algonode.cloud"
IDX = "https://testnet-idx.algonode.cloud"
get = lambda u: json.load(urllib.request.urlopen(u))
B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

def addr(pk):
    chk = hashlib.new("sha512_256", pk).digest()[28:32]
    bits = nbits = 0; out = ""
    for b in pk + chk:
        bits = (bits << 8) | b; nbits += 8
        while nbits >= 5:
            nbits -= 5; out += B32[(bits >> nbits) & 31]
    if nbits: out += B32[(bits << (5 - nbits)) & 31]
    return out

u64 = lambda r, o: int.from_bytes(r[o:o+8], "big")

def gstate(app_id):
    app = get(IDX + "/v2/applications/%d" % app_id)
    out = {}
    for kv in app["application"]["params"].get("global-state", []):
        kb = base64.b64decode(kv["key"])
        key = kb.decode("ascii") if all(32 <= b < 127 for b in kb) else "0x" + kb.hex()
        v = kv["value"]
        if v["type"] == 2:
            out[key] = {"type": "uint", "uint": v["uint"]}
        else:
            raw = base64.b64decode(v.get("bytes", ""))
            text = raw.decode("ascii") if raw and all(32 <= b < 127 for b in raw) else None
            out[key] = {"type": "bytes", "hex": raw.hex(), "text": text}
    return out

def list_boxes(app_id):
    names = []; url = IDX + "/v2/applications/%d/boxes" % app_id
    for _ in range(20):
        p = get(url)
        names += [b["name"] for b in p.get("boxes", [])]
        if not p.get("next-token"): break
        url = IDX + "/v2/applications/%d/boxes?next=" % app_id + urllib.parse.quote(p["next-token"])
    return names

rounds = get(A + "/v2/status")["last-round"]

boxes = get(A + "/v2/applications/769891898/boxes")["boxes"]
ups = []
for b in boxes:
    n = base64.b64decode(b["name"])
    if len(n) != 9 or n[0] != 0x75: continue
    v = get(A + "/v2/applications/769891898/box?name=" +
            urllib.parse.quote("b64:" + b["name"], safe=""))
    r = base64.b64decode(v["value"])
    ups.append(dict(id=int.from_bytes(n[1:], "big"), creator=addr(r[:32]),
                    target_app=u64(r, 32), interval=u64(r, 42), next_round=u64(r, 50),
                    fee=u64(r, 58), balance=u64(r, 66), policy=u64(r, 82)))
ups.sort(key=lambda u: u["id"])

fleet = {k: gstate(i) for k, i in
         [("plod", 770734249), ("waddle", 770742373), ("beacon", 770742777), ("epitaph", 770748282)]}
pulse = gstate(769891902)

hub = gstate(770130162)
rains = []
for name in list_boxes(770130162):
    n = base64.b64decode(name)
    if len(n) != 9 or n[0] != 0x72: continue
    v = get(IDX + "/v2/applications/770130162/box?name=" +
            urllib.parse.quote("b64:" + name, safe=""))
    r = base64.b64decode(v["value"])
    if len(r) < 224: continue
    label = r[64:96].split(b"\x00")[0].decode("ascii", "replace").strip()
    rid = int.from_bytes(n[1:], "big")
    rains.append(dict(id=rid, name=label or ("rain %d" % rid),
                      prize_asset=u64(r, 96), drip=u64(r, 104), interval_rounds=u64(r, 112),
                      last_rain_round=u64(r, 120), pot=u64(r, 128), tickets=u64(r, 136),
                      draw_id=u64(r, 144), mode=u64(r, 160), wave_cap=u64(r, 168),
                      commit_round=u64(r, 208), prize_locked=u64(r, 216)))
rains.sort(key=lambda x: x["id"])

snap = dict(generated_at=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            last_round=rounds, keeper_app=769891898, upkeeps=ups,
            fleet=fleet, pulse=pulse, rain={"hub": hub, "rains": rains})
json.dump(snap, open("docs/snapshot.json", "w"), indent=2)
print("round", rounds, "upkeeps", len(ups), "rains", len(rains))
EOF
```

Commit the updated `docs/snapshot.json`.

---

TestNet only. Arcron is unaudited. Generated by
[corvid-agent](https://github.com/corvid-agent).
