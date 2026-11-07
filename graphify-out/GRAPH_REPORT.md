# Graph Report - wr-server-public  (2026-11-07)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 431 nodes · 1103 edges · 15 communities
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 158 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d0826f7a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14

## God Nodes (most connected - your core abstractions)
1. `getChannel()` - 33 edges
2. `reply()` - 29 edges
3. `broadcastPacket()` - 27 edges
4. `createHandlers()` - 25 edges
5. `roomSockets()` - 21 edges
6. `handleClanSystem()` - 17 edges
7. `ownsItem()` - 15 edges
8. `main()` - 15 edges
9. `sendReply()` - 15 edges
10. `handleAuthorization()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `createHandlers()` --indirect_call--> `handleUserList()`  [INFERRED]
  node/game/handlers.js → node/game/userlist.js
- `createHandlers()` --indirect_call--> `handlePingReply()`  [INFERRED]
  node/game/handlers.js → node/game/ping.js
- `createHandlers()` --indirect_call--> `handleExplosivesPacket()`  [INFERRED]
  node/game/handlers.js → node/game/explosive.js
- `createHandlers()` --indirect_call--> `handleClanRanking()`  [INFERRED]
  node/game/handlers.js → node/game/clan.js
- `handleCoupon()` --calls--> `grantItem()`  [EXTRACTED]
  node/game/coupon.js → node/game/shop.js

## Import Cycles
- 2-file cycle: `node/game/clan.js -> node/game/rooms.js -> node/game/clan.js`
- 3-file cycle: `node/game/chat.js -> node/game/gm.js -> node/game/gamesubs.js -> node/game/chat.js`

## Communities (15 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (47): coupons, handleCoupon(), loadCoupons(), loadRedeemedCoupons(), reply(), handleEquipment(), persistEquipment(), buildServerTimeField() (+39 more)

### Community 1 - "Community 1"
Cohesion: 0.07
Nodes (35): applySpawnTestOverrides(), beginMatch(), canStart(), clearAutoRespawn(), handleArtillery(), handleAutoStart(), handleConfirmDeath(), handleEnvironmentDamage() (+27 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (42): build, command, condition, depends_on, environment, healthcheck, ports, restart (+34 more)

### Community 3 - "Community 3"
Cohesion: 0.12
Nodes (36): broadcast(), broadcastSystemMessage(), extractText(), handleChat(), sendClanNotice(), TYPE, broadcastEndRound(), broadcastMission() (+28 more)

### Community 4 - "Community 4"
Cohesion: 0.12
Nodes (38): cmdAddMoney(), cmdBan(), cmdChangeMap(), cmdEndGame(), cmdExtendTime(), cmdForceCloseRoom(), cmdGiveItem(), cmdGiveRoom() (+30 more)

### Community 5 - "Community 5"
Cohesion: 0.12
Nodes (25): logPacket(), main(), net, startListener(), loadClans(), setAuthDb(), setAuthDb(), connectToAuthServer() (+17 more)

### Community 6 - "Community 6"
Cohesion: 0.17
Nodes (31): clanInfo(), handleScoreboardRequest(), createHandlers(), handleChannelSelection(), levelForXp(), suitableLevel(), BATTLE_MAX_PLAYERS, createClanWarRoom() (+23 more)

### Community 7 - "Community 7"
Cohesion: 0.19
Nodes (30): chat(), clanExp(), clanRankingIndex(), clans, disbandClan(), fetchXp(), formatDate(), handleApply() (+22 more)

### Community 8 - "Community 8"
Cohesion: 0.17
Nodes (16): allocSessionId(), createHandlers(), handlePlayerLogin(), crypto, ERROR_CODES, handleLauncher(), isAlphaNumeric(), localIp() (+8 more)

### Community 9 - "Community 9"
Cohesion: 0.13
Nodes (18): runs-on, steps, runs-on, steps, jobs, check, docker, name (+10 more)

### Community 10 - "Community 10"
Cohesion: 0.18
Nodes (15): fs, record(), recordFrame(), countRelay(), dumpPacket(), handleInitial(), handlePingHandshake(), handleTunnel() (+7 more)

### Community 11 - "Community 11"
Cohesion: 0.25
Nodes (9): handlePingReply(), premiumTimeLeft(), startPingLoop(), checkPremiumExpiry(), EXP_TABLE, GameConfig, PREMIUM, PREMIUM_XP_BONUS (+1 more)

### Community 12 - "Community 12"
Cohesion: 0.29
Nodes (6): interval, updates, directory, package-ecosystem, schedule, version

### Community 13 - "Community 13"
Cohesion: 0.40
Nodes (5): dependencies, mysql2@^3.24.6, name, private, mysql2

### Community 14 - "Community 14"
Cohesion: 0.40
Nodes (4): description, header_pages, theme, title

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getChannel()` connect `Community 6` to `Community 1`, `Community 10`, `Community 3`, `Community 4`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Are the 16 inferred relationships involving `createHandlers()` (e.g. with `game/handlers.js` and `handleClanRanking()`) actually correct?**
  _`createHandlers()` has 16 INFERRED edges - model-reasoned connections that need verification._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05365296803652968 - nodes in this community are weakly interconnected._
- **Why does `mysql2` connect `Community 13` to `Community 5`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.0673758865248227 - nodes in this community are weakly interconnected._
- **Why does `users` connect `Community 3` to `Community 0`, `Community 1`, `Community 4`, `Community 6`, `Community 7`, `Community 10`, `Community 11`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.06201550387596899 - nodes in this community are weakly interconnected._