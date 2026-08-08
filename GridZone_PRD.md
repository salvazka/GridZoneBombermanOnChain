# GridZone — Product Requirements Document (PRD)
**Versi:** 2.0 (Revisi pasca-review teknis)
**Status:** Draft untuk Hackathon Build
**Chain:** Monad Testnet
**Stack Kontrak:** Foundry + OpenZeppelin v5

> Perubahan utama dari v1: storage layout per-match (bukan global) agar klaim parallel execution valid, sharded relayer keys, penanganan environment-death & self-kill, escape hatch dana, dan penjelasan trust model relayer. Detail perubahan ada di §11 Changelog.

---

## 1. Executive Summary

GridZone adalah game **Classic Bomberman Battle Royale** berbasis web yang menggabungkan gameplay real-time off-chain dengan **reward settlement instan on-chain** dalam bentuk stablecoin (USDC/USDT) di Monad.

Setiap kill memicu transfer nilai nyata ke wallet pemenang tanpa mengganggu alur permainan. GridZone dirancang agar frekuensi transaksi **naik secara natural** seiring jumlah pemain dan intensitas late-game — sehingga kebutuhan akan Monad (high TPS, sub-second finality, parallel execution) adalah kebutuhan yang genuine, bukan yang dipaksakan untuk keperluan demo.

**Prinsip desain inti:** setiap keputusan arsitektur kontrak diuji dengan pertanyaan "apakah ini akan tetap benar kalau 8 kill terjadi bersamaan di 8 match berbeda?" Jika jawabannya tidak, desain diubah.

---

## 2. Product Objectives

| Objective | Deskripsi | Metrik Keberhasilan |
|---|---|---|
| **UX setara Web2** | Tidak ada lag transaksi atau popup konfirmasi berulang selama gameplay | Nol wallet signature setelah match dimulai |
| **Proof of Concept Monad** | Membuktikan Monad memproses high-frequency micro-settlement **secara paralel** dengan gas rendah | Tx dari match berbeda tervalidasi tanpa saling blocking (dibuktikan di explorer) |
| **Developer Velocity (Foundry)** | Testing & deployment cepat, contract logic siap didemokan | Invariant test lolos + fork test di Monad testnet hijau |
| **Auditability** | Karena relayer dipercaya penuh, hasil match harus bisa diverifikasi pasca-fakta | Setiap match punya log yang dapat direkonstruksi dari event on-chain |

---

## 3. Core Gameplay & System Mechanics

### 3.1 Arena & Rules

- **Grid Size:** 19×19 tile (direvisi dari 20×20; ukuran ganjil dipilih agar Red Zone menyusut simetris dan berakhir tepat di satu ubin tengah, bukan blok 2×2 sisa yang membuat shrink terlihat berat sebelah).
- **Jumlah Pemain:** **16 pemain per lobby** untuk MVP (lihat §9.1 kenapa 32 pemain di grid ini tidak layak tanpa memperbesar grid).
- **Objektif:** Bertahan hidup hingga menjadi Last Man Standing.
- **Grace Period:** 30–45 detik pertama tanpa shrink, agar pemain punya waktu farming power-up sebelum tekanan dimulai.
- **Red Zone (Shrinking Mechanism):** Setiap 15 detik setelah grace period, **satu ring terluar penuh** (bukan satu baris/kolom bergantian) runtuh serentak. Pemain di ubin yang runtuh langsung tereliminasi sebagai **environment death** (lihat §4.3 — ini bukan kill dan tidak punya killer).
  - *Kejelasan wajib:* dokumen v1 ambigu antara "1 ring per tick" (~10 langkah shrink, cocok untuk match ~150–300 detik) vs "1 baris/kolom bergantian" (36 langkah, terlalu lambat untuk demo). **Keputusan: 1 ring per tick.**

### 3.2 Power-Ups (In-Game Drops)

Muncul dari Soft Block yang dihancurkan:

| Power-Up | Efek |
|---|---|
| 💣 Extra Bomb | +1 bom yang bisa dipasang bersamaan |
| 🔥 Blast Radius | +1 tile jangkauan ledakan |
| ⚡ Speed Boost | +kecepatan gerak karakter |

### 3.3 Jenis Kematian (Death Taxonomy) — Baru di v2

Ini adalah gap terbesar di v1: dokumen sebelumnya hanya mendefinisikan kematian akibat dibunuh pemain lain, padahal Bomberman secara mekanis punya tiga jalur kematian:

| Jenis | Pemicu | Ada Killer? | Aliran Dana |
|---|---|---|---|
| **PvP Kill** | Bom pemain A meledak, mengenai pemain B | Ya (A) | 80% bounty B → A, 20% → jackpot match |
| **Self-Kill** | Bom pemain A meledak, mengenai A sendiri (signature death Bomberman) | Tidak (killer == victim) | 100% bounty A → jackpot match |
| **Environment Death** | Red Zone shrink mengenai pemain saat ring runtuh | Tidak | 100% bounty pemain → jackpot match |

Guard di kontrak: `processKillReward` **wajib** `require(killer != victim && killer != address(0))`. Self-kill dan environment death dirutekan ke fungsi terpisah (§5.2).

---

## 4. Game Economy & Tokenomics

| Parameter | Nilai MVP | Deskripsi |
|---|---|---|
| Buy-In (Entry Fee) | $1.00 USDC | Biaya masuk per pemain |
| Initial Player Bounty | $0.80 USDC | "Nilai kepala" pemain saat awal match (80% dari buy-in) |
| House / Treasury Fee | $0.20 USDC | 20% dari buy-in, dialokasikan ke Final Jackpot Pool + House Fee saat join |
| Kill Reward Split | 80% / 20% | Saat A membunuh B: 80% bounty B → A instan; 20% → jackpot pool match tersebut |
| Self-Kill / Env-Death Split | 100% → jackpot | Tidak ada killer, seluruh bounty korban masuk jackpot match |

### 4.1 Konservasi Nilai (Value Conservation) — wajib dipenuhi

Simulasi 16 pemain, tanpa self-kill/env-death, sampai 1 pemenang:

```
Total masuk    = 16 × $1.00                = $16.00
Total distribusi PvP (80% × 15 kill)       = $9.60  → ke berbagai killer
Total ke jackpot dari kill (20% × 15 kill) = $2.40
Sisa bounty pemenang (belum terdistribusi) = $0.80  ← WAJIB dikembalikan saat finalizeMatch
Jackpot awal dari fee join (20% × 16)      = $3.20
```

Total jackpot pool saat match selesai = $2.40 + $3.20 = $5.60, dan **`finalizeMatch` harus mentransfer jackpot pool + sisa bounty pemenang** ke pemenang. Ini memperbaiki dust bug v1 di mana $0.80 bounty pemenang tidak pernah keluar dari vault.

**Invariant yang harus selalu benar (dan diuji, lihat §7.2):**
```
usdc.balanceOf(GridZoneArena) == Σ(bounty aktif semua match berjalan)
                                + Σ(jackpotPool semua match berjalan)
                                + treasuryUnclaimed
```

---

## 5. Technical Architecture

### 5.1 Hybrid System Architecture

```
[ Frontend (Phaser.js) ] ◄── WebSocket ──► [ Game Server / Relayer Pool (Node.js) ]
           │                                            │
   approve() + depositEntryFee()              processKillReward() / processSelfOrEnvDeath()
   (1x sebelum match, TANPA session key)       (dipanggil oleh relayer key milik match ini)
           │                                            │
           ▼                                            ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │                      MONAD BLOCKCHAIN (EVM)                           │
 │   GridZoneArena.sol  (Foundry: forge build / test / script)          │
 │   - depositEntryFee(bytes32 matchId)                                 │
 │   - processKillReward(bytes32 matchId, address killer, address victim)│
 │   - processEnvironmentOrSelfDeath(bytes32 matchId, address victim)   │
 │   - finalizeMatch(bytes32 matchId, address winner)                   │
 │   - emergencyWithdraw(bytes32 matchId)   ← escape hatch              │
 └───────────────────────────────────────────────────────────────────────┘
```

> **Catatan penting:** frasa "Session Key Deposit" di diagram v1 dihapus. Tidak ada implementasi session key di scope MVP ini — cerita yang jujur dan tetap kuat adalah: **satu `approve` + satu `depositEntryFee` sebelum match, nol signature selama gameplay** karena semua transaksi in-game dieksekusi oleh relayer, bukan wallet pemain. Jangan pakai istilah yang tidak ada kodenya saat pitch; juri akan mengorek ini.

### 5.2 Smart Contract: `src/GridZoneArena.sol`

**Perubahan struktural paling penting dari v1: semua state per-match disimpan dalam struct yang dikunci oleh `matchId`, bukan variabel global.** Ini bukan preferensi gaya kode — ini prasyarat agar klaim "parallel execution di Monad" valid secara teknis. Kalau `jackpotPool` adalah satu `uint256` global, setiap tx kill dari *match manapun* menyentuh slot storage yang sama, sehingga optimistic parallel execution Monad akan mendeteksi konflik dan menjalankan ulang secara berurutan — hasil demo justru membuktikan sebaliknya dari yang diklaim.

```solidity
struct Match {
    bool     active;
    bool     finalized;
    uint256  startTime;
    uint256  jackpotPool;
    uint256  totalDeposited;
    mapping(address => uint256) bounty;   // per-player bounty, isolated per match
    mapping(address => bool)    isPlayer;
}

mapping(bytes32 => Match) private matches;
mapping(bytes32 => address) public matchRelayer; // relayer key yang di-assign ke match ini
uint256 public treasuryUnclaimed;
uint256 public constant MATCH_TIMEOUT = 1 hours;
```

**Fungsi utama:**

| Fungsi | Akses | Deskripsi |
|---|---|---|
| `depositEntryFee(bytes32 matchId)` | Public (player) | Transfer $1 USDC dari player ke vault. 80% → `bounty[player]`, 20% → `jackpotPool` match ini. |
| `processKillReward(bytes32 matchId, address killer, address victim)` | `onlyMatchRelayer(matchId)` | `require(killer != victim)`. 80% `bounty[victim]` → `bounty[killer]` (transfer instan), 20% → `jackpotPool`. Zero-out `bounty[victim]`. |
| `processEnvironmentOrSelfDeath(bytes32 matchId, address victim)` | `onlyMatchRelayer(matchId)` | 100% `bounty[victim]` → `jackpotPool`. Menangani self-kill dan red-zone death. |
| `finalizeMatch(bytes32 matchId, address winner, bytes32 logRoot)` | `onlyMatchRelayer(matchId)` | Transfer `jackpotPool + bounty[winner]` ke winner. Simpan `logRoot` (Merkle root dari log kill match, lihat §6) untuk auditability. Set `finalized = true`. |
| `emergencyWithdraw(bytes32 matchId)` | Public (player itu sendiri) | Callable **hanya** jika `block.timestamp > startTime + MATCH_TIMEOUT` dan `!finalized`. Player menarik `bounty[msg.sender]` miliknya sendiri. Mencegah dana terkunci permanen jika server crash. |

**Modifier kunci:**
```solidity
modifier onlyMatchRelayer(bytes32 matchId) {
    require(msg.sender == matchRelayer[matchId], "not assigned relayer");
    _;
}
```

### 5.3 Relayer Pool — Baru di v2

Satu EOA relayer tunggal **tidak bisa** memproses kill secara paralel, karena nonce EOA bersifat strictly sequential — berapa pun TPS chain-nya. Late-game Bomberman menghasilkan kill yang *bursty* (banyak kematian dalam hitungan detik saat red zone menyempit).

**Solusi:**
1. **Sharding relayer key per match.** Setiap match baru di-assign satu relayer key dari pool (misal 20–50 key untuk demo). `matchRelayer[matchId]` menyimpan address ini. Match berbeda → nonce berbeda → benar-benar paralel, dan ini yang membuat poin storage-per-match di §5.2 terlihat nyata di explorer.
2. **`processKillBatch()`** (opsional, fallback) untuk merangkum beberapa kematian dalam tick server yang sama menjadi satu transaksi, sebagai pengaman kalau burst tetap terjadi dalam satu match.

### 5.4 Trust Model — relayer sebagai oracle (baru di v2, wajib ada di pitch)

`onlyMatchRelayer` berarti server dipercaya penuh untuk memindahkan bounty tanpa bukti on-chain bahwa kill benar-benar terjadi. Untuk MVP hackathon ini wajar, tapi harus dijawab proaktif saat Q&A juri, bukan dihindari.

**Pendekatan minimal-cost yang dipakai:** relayer **tidak perlu trustless penuh, cukup auditable**.
- Setiap event kill di-log oleh game server dengan detail state (posisi, waktu, jenis kematian).
- Saat `finalizeMatch`, relayer submit `logRoot` — Merkle root dari seluruh log kill match tersebut.
- Log lengkap dipublikasikan (misal ke IPFS atau endpoint publik), sehingga siapa pun bisa merekonstruksi dan memverifikasi hasil match pasca-fakta.
- Dispute resolution di luar scope MVP, tapi struktur data ini membuka jalan untuk itu tanpa refactor besar.

### 5.5 Foundry Environment Setup

`foundry.toml`:
```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.24"

[rpc_endpoints]
monad_testnet = "${MONAD_TESTNET_RPC}"

[etherscan]
monad_testnet = { key = "${MONAD_EXPLORER_API_KEY}", url = "https://testnet.monadexplorer.com/api" }
```

Dependencies: OpenZeppelin Contracts v5 (`IERC20`, `Ownable`).

Deployment (`script/DeployGridZone.s.sol`):
```bash
forge script script/DeployGridZone.s.sol:DeployGridZone --rpc-url monad_testnet --broadcast --verify
```

Deploy script juga harus men-deploy **Mock USDC dengan fungsi `mint()` publik** di testnet, agar juri/penonton demo bisa self-service mendapatkan test token tanpa minta ke tim (lihat §9.4).

---

## 6. Foundry Testing Strategy — direvisi

v1 menargetkan "100% unit test coverage", yang untuk contract yang memindahkan uang adalah metrik yang lemah — coverage tinggi tidak membuktikan konservasi nilai. v2 menambahkan **invariant testing** sebagai bukti utama.

| Jenis Test | Tujuan | Detail |
|---|---|---|
| **Unit Test** | Isolasi logika deposit, kill split, self-kill, env-death, finalize, emergency withdraw | `test/GridZoneArena.t.sol` |
| **Fuzz Test** | Rentang nilai bounty, urutan kill acak, urutan simultan multi-match | `vm.fuzz`, termasuk kasus `killer == victim` (harus revert di `processKillReward`) |
| **Invariant Test** | **Bukti konservasi nilai** — properti yang harus benar di ribuan urutan aksi acak | `StdInvariant`: `usdc.balanceOf(arena) == Σbounty aktif + Σjackpot per match + treasuryUnclaimed` |
| **Fork Test** | Interaksi kontrak di forked Monad Testnet | `forge test --fork-url monad_testnet` |
| **Concurrency Simulation** | Simulasi N kill di M match berbeda dalam tx yang di-broadcast bersamaan, verifikasi tidak ada state korupsi antar-match | Manual script + fork test, dijalankan sebelum demo hari-H |

---

## 7. User Interface (UI) & HUD Requirements

**Lobby Screen:**
- Connect Wallet & auto-switch network ke Monad Testnet.
- Saldo Stablecoin (USDC) + tombol **"Get Test USDC"** (memanggil `mint()` di Mock USDC — lihat §9.4).
- Tombol "Approve & Join Match ($1 USDC)".

**In-Game HUD:**
- Leaderboard real-time: pemain tersisa + jumlah kill.
- Live Wallet Earnings: akumulasi USDC yang didapat di match ini (`Earnings: +$1.28 USDC`).
- Red Zone Timer: countdown sebelum ring berikutnya runtuh.
- Toast notification saat kill (`"You killed Player2! +$0.64 USDC"`) dan saat env-death/self-kill pemain lain (`"Player3 was caught in the storm."`) agar taksonomi kematian di §3.3 terlihat jelas ke penonton demo.

---

## 8. Hackathon Execution Roadmap

```
[ Phase 1: Smart Contract Engine ] → [ Phase 2: Relayer & Game Logic ] → [ Phase 3: Polish, Bots & Demo ]
```

### Phase 1 — Smart Contract Engine (Foundry Focus)
1. `forge init gridzone-contracts`, install OpenZeppelin v5.
2. Implementasi `GridZoneArena.sol` dengan struktur per-match (§5.2).
3. Unit + fuzz + **invariant test** komprehensif.
4. Deploy Mock USDC (dengan `mint()` publik) + `GridZoneArena` ke Monad Testnet via `forge script`.

### Phase 2 — Relayer Pool & Game Logic
1. Node.js game server + Socket.io, client Phaser.js.
2. Implementasi relayer pool dengan key sharding per `matchId` (§5.3).
3. Hubungkan event kill/self-kill/env-death server ke fungsi kontrak yang sesuai, menggunakan ABI dari `out/GridZoneArena.json` (ethers.js/viem).
4. Implementasi logging match untuk Merkle root di `finalizeMatch`.

### Phase 3 — Testing, Bots, UI Polish & Pitch Prep
1. **Bot players untuk demo** (lihat §9.3) — direncanakan di sini agar tidak dadakan H-1.
2. Simulasi multi-kill lintas-match untuk membuktikan eksekusi paralel di explorer Monad (screenshot/video untuk pitch deck).
3. UI live earnings, toast, dan scripting demo untuk juri.
4. Dry-run penuh: dari `approve` sampai `finalizeMatch`, dengan mock USDC faucet live.

---

## 9. Isu Desain Tambahan & Keputusan

### 9.1 Kepadatan Grid vs Jumlah Pemain

Grid 19×19 = 361 tile. Setelah hard block + soft block (~50% area khas Bomberman), walkable area ≈ 180 tile. Dengan 32 pemain → ~5.6 tile/pemain, jauh lebih padat dari rasio klasik Bomberman (15×13 untuk 4 pemain ≈ 48 tile/pemain). Ini menyebabkan spawn campers dan kematian beruntun di 10 detik pertama.

**Keputusan MVP:** 16 pemain di grid 19×19 (~11.3 tile/pemain). Opsi masa depan: naikkan grid ke 25×25 jika ingin tetap 32 pemain.

### 9.2 Red Zone Timing

Lihat §3.1 — diputuskan 1 ring penuh per tick 15 detik, dengan grace period 30–45 detik di awal.

### 9.3 Bot Players untuk Demo — baru di v2

Demo langsung dengan 16 pemain manusia di depan juri tidak realistis. Bot diperlukan, dan bot **tetap harus punya bounty on-chain** agar invariant konservasi nilai (§4.1) tidak pecah saat demo — bot tidak bisa "gratis" ikut match.

**Rencana:** fungsi `depositEntryFeeFor(bytes32 matchId, address bot)` yang dibiayai dari treasury/faucet demo (bukan dari player sungguhan), dipanggil sebelum match dimulai untuk mengisi slot lobby dengan bot AI sederhana (pathing acak + drop bomb heuristik). Direncanakan di Phase 3, bukan dadakan.

### 9.4 Mock USDC Faucet

Mock USDC di testnet **wajib** punya fungsi `mint(address to, uint256 amount)` publik (atau dengan rate-limit sederhana), agar juri bisa mendapatkan test token sendiri tanpa bergantung pada tim saat mencoba game secara interaktif.

### 9.5 Netcode Framing untuk Pitch

"60 FPS" adalah metrik render sisi klien, bukan netcode. Yang relevan secara teknis adalah **server tick rate** (disarankan 20–30Hz dengan client-side interpolation) — standar untuk game grid-based/discrete seperti Bomberman, yang secara inheren lebih forgiving terhadap latency dibanding game aim-based. Ini keunggulan pemilihan genre yang layak disebut eksplisit di pitch: Bomberman itu discrete-state, sehingga desync risk jauh lebih rendah daripada FPS/action game real-time.

### 9.6 Catatan Non-Teknis

Entry fee + rake + PvP dengan payout uang nyata berpotensi masuk kategori yang diatur di berbagai yurisdiksi. Untuk testnet hackathon ini tidak masalah, tapi:
- Jangan menjanjikan mainnet USDC di pitch tanpa disclaimer regulasi.
- Framing sebagai **skill-based competition** (bukan game of chance) akan membantu posisi produk.
- Rake 20% secara tidak sengaja juga berfungsi sebagai **disinsentif sybil/collusion** (8 sybil "memberi makan" 1 farmer: bayar $8 total, farmer dapat 7×$0.64=$4.48 — net negatif untuk sybil). Ini poin kuat untuk dijawab kalau juri tanya soal anti-cheat ekonomi.

---

## 10. Success Metrics for Hackathon Demo

| Metrik | Target |
|---|---|
| Foundry-backed reliability | Contract terverifikasi di Monad Explorer, seluruh unit + fuzz + **invariant test** lolos |
| Parallel execution proof | Tx kill dari ≥2 match berbeda, dibroadcast dalam window waktu yang sama, terlihat diproses tanpa saling blocking di explorer (bukti klaim inti produk) |
| Zero-lag gameplay | Tidak ada stutter di client saat kill trigger on-chain settlement |
| Instant settlement | Notifikasi + update saldo terkonfirmasi < 1 detik di Monad testnet |
| Value conservation | Invariant `balanceOf(arena) == Σbounty + Σjackpot + treasuryUnclaimed` tidak pernah gagal di seluruh test run |
| Demo resilience | Full dry-run (join → kill → self-kill/env-death → finalize) berjalan tanpa manual intervention, termasuk skenario bot-filled lobby |

---

## 11. Changelog dari v1 → v2

| # | Isu di v1 | Perbaikan di v2 |
|---|---|---|
| 1 | State global (`jackpotPool` dll) membatalkan klaim parallel execution | Storage per-match via `mapping(bytes32 => Match)` (§5.2) |
| 2 | Satu relayer EOA = bottleneck nonce, tidak benar-benar paralel | Relayer pool, sharded per `matchId` (§5.3) |
| 3 | Tidak ada penanganan kematian tanpa killer (red zone, self-kill) | Death taxonomy + `processEnvironmentOrSelfDeath` (§3.3, §5.2) |
| 4 | Bounty pemenang ($0.80) tidak pernah terdistribusi (dust bug) | `finalizeMatch` transfer `jackpotPool + bounty[winner]` (§4.1) |
| 5 | Trust model relayer tidak dijelaskan | §5.4 — auditability via Merkle log root |
| 6 | Tidak ada escape hatch jika server crash | `emergencyWithdraw` dengan `MATCH_TIMEOUT` (§5.2) |
| 7 | 32 pemain di grid 20×20 terlalu padat | 16 pemain untuk MVP (§9.1) |
| 8 | Red Zone shrink ambigu | Ditetapkan: 1 ring/tick, grace period 30–45s (§3.1) |
| 9 | "Session Key Deposit" di diagram tanpa implementasi | Dihapus, diganti deskripsi jujur: approve+deposit sekali, nol signature in-game (§5.1) |
| 10 | Tidak ada rencana bot untuk demo 16–32 pemain | §9.3, direncanakan di Phase 3 |
| 11 | Tidak ada faucet self-service untuk juri | Mock USDC dengan `mint()` publik (§9.4, §5.5) |
| 12 | Target "100% coverage" sebagai metrik utama | Invariant test sebagai bukti konservasi nilai (§6) |
