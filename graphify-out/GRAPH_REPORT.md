# Graph Report - wr-server-public  (2026-11-08)

## Corpus Check
- 47 files · ~41,316 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 7 file(s) not represented in the graph (top: (none) 6, .example 1)

## Summary
- 506 nodes · 1152 edges · 22 communities (21 shown, 1 thin omitted)
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 159 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `74346b7b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- shop.js
- gamesubs.js
- auth
- gm.js
- game-server.js
- rooms.js
- clan.js
- auth/handlers.js
- steps
- udp-handlers.js
- progression.js
- updates
- package.json
- _config.yml
- test-hardening.js
- test-gamesubs.js
- xor-socket.js
- userlist.js
- smoke-login.js
- auth-server.js
- buildServerTimeField

## God Nodes (most connected - your core abstractions)
1. `getChannel()` - 32 edges
2. `reply()` - 29 edges
3. `broadcastPacket()` - 27 edges
4. `createHandlers()` - 25 edges
5. `roomSockets()` - 21 edges
6. `handleClanSystem()` - 16 edges
7. `handleAuthorization()` - 15 edges
8. `ownsItem()` - 15 edges
9. `main()` - 15 edges
10. `sendReply()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `createHandlers()` --indirect_call--> `handlePingReply()`  [INFERRED]
  node/game/handlers.js → node/game/ping.js
- `createHandlers()` --indirect_call--> `handleClanRanking()`  [INFERRED]
  node/game/handlers.js → node/game/clan.js
- `createHandlers()` --indirect_call--> `handleExplosivesPacket()`  [INFERRED]
  node/game/handlers.js → node/game/explosive.js
- `createHandlers()` --indirect_call--> `handleUserList()`  [INFERRED]
  node/game/handlers.js → node/game/userlist.js
- `request()` --calls--> `wrapSocket()`  [EXTRACTED]
  node/tools/smoke-login.js → node/lib/xor-socket.js

## Import Cycles
- 2-file cycle: `node/game/clan.js -> node/game/rooms.js -> node/game/clan.js`
- 3-file cycle: `node/game/chat.js -> node/game/gm.js -> node/game/gamesubs.js -> node/game/chat.js`

## Communities (22 total, 1 thin omitted)

### Community 0 - "shop.js"
Cohesion: 0.10
Nodes (34): coupons, handleCoupon(), loadCoupons(), loadRedeemedCoupons(), reply(), handleEquipment(), persistEquipment(), handleAuthorization() (+26 more)

### Community 1 - "gamesubs.js"
Cohesion: 0.06
Nodes (63): broadcast(), broadcastSystemMessage(), extractText(), handleChat(), sendClanNotice(), TYPE, broadcastEndRound(), broadcastMission() (+55 more)

### Community 2 - "auth"
Cohesion: 0.06
Nodes (42): build, command, condition, depends_on, environment, healthcheck, ports, restart (+34 more)

### Community 4 - "gm.js"
Cohesion: 0.11
Nodes (38): cmdAddMoney(), cmdBan(), cmdChangeMap(), cmdEndGame(), cmdExtendTime(), cmdGiveItem(), cmdGiveRoom(), cmdHelp() (+30 more)

### Community 5 - "game-server.js"
Cohesion: 0.19
Nodes (13): loadClans(), setAuthDb(), setAuthDb(), connectToAuthServer(), loadMaps(), loadGameConfig(), dgram, logPacket() (+5 more)

### Community 6 - "rooms.js"
Cohesion: 0.15
Nodes (36): clanInfo(), handleScoreboardRequest(), cmdForceCloseRoom(), createHandlers(), handleChannelSelection(), applyMatchEnd(), levelForXp(), suitableLevel() (+28 more)

### Community 7 - "clan.js"
Cohesion: 0.19
Nodes (30): chat(), clanExp(), clanRankingIndex(), clans, disbandClan(), fetchXp(), formatDate(), handleApply() (+22 more)

### Community 8 - "auth/handlers.js"
Cohesion: 0.17
Nodes (16): allocSessionId(), createHandlers(), handlePlayerLogin(), crypto, ERROR_CODES, handleLauncher(), isAlphaNumeric(), localIp() (+8 more)

### Community 9 - "steps"
Cohesion: 0.08
Nodes (27): runs-on, steps, concurrency, cancel-in-progress, group, runs-on, steps, jobs (+19 more)

### Community 10 - "udp-handlers.js"
Cohesion: 0.15
Nodes (16): fs, record(), recordFrame(), countRelay(), dispatch(), dumpPacket(), handleInitial(), handlePingHandshake() (+8 more)

### Community 11 - "progression.js"
Cohesion: 0.25
Nodes (9): handlePingReply(), premiumTimeLeft(), startPingLoop(), checkPremiumExpiry(), EXP_TABLE, GameConfig, PREMIUM, PREMIUM_XP_BONUS (+1 more)

### Community 12 - "updates"
Cohesion: 0.17
Nodes (11): patterns, actions, npm, patterns, interval, updates, directory, groups (+3 more)

### Community 13 - "package.json"
Cohesion: 0.40
Nodes (5): dependencies, mysql2@^3.24.6, name, private, mysql2

### Community 14 - "_config.yml"
Cohesion: 0.40
Nodes (4): description, header_pages, theme, title

### Community 15 - "test-hardening.js"
Cohesion: 0.16
Nodes (9): findSession(), net, pendingSessions, assert, { EventEmitter }, good, internal, sock (+1 more)

### Community 16 - "test-gamesubs.js"
Cohesion: 0.18
Nodes (6): HANDLERS, SUB, cmdStart(), createPool(), mysql, assert

### Community 17 - "xor-socket.js"
Cohesion: 0.31
Nodes (4): buildPacket(), parsePacket(), xorBuffer(), wrapSocket()

### Community 18 - "userlist.js"
Cohesion: 0.46
Nodes (7): announceJoin(), announceLeave(), buildUserListFields(), flush(), handleUserList(), scheduleFlush(), userListEntry()

### Community 19 - "smoke-login.js"
Cohesion: 0.25
Nodes (5): assert, CLIENT, net, request(), [user, password, host = '127.0.0.1']

### Community 20 - "auth-server.js"
Cohesion: 0.43
Nodes (5): logPacket(), main(), net, startListener(), sendGreeting()

### Community 21 - "buildServerTimeField"
Cohesion: 0.40
Nodes (5): buildServerTimeField(), handleServerTime(), isAlphaNumeric(), pad(), weekOfYear()

## Knowledge Gaps
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createHandlers()` connect `rooms.js` to `shop.js`, `gamesubs.js`, `game/handlers.js`, `game-server.js`, `clan.js`, `progression.js`, `userlist.js`, `buildServerTimeField`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **Are the 16 inferred relationships involving `createHandlers()` (e.g. with `game/handlers.js` and `handleClanRanking()`) actually correct?**
  _`createHandlers()` has 16 INFERRED edges - model-reasoned connections that need verification._
- **Should `shop.js` be split into smaller, more focused modules?**
  _Cohesion score 0.10384615384615385 - nodes in this community are weakly interconnected._
- **Why does `getChannel()` connect `rooms.js` to `test-gamesubs.js`, `gamesubs.js`, `udp-handlers.js`, `gm.js`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Should `gamesubs.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06027306027306027 - nodes in this community are weakly interconnected._
- **Why does `mysql2` connect `package.json` to `test-gamesubs.js`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Should `auth` be split into smaller, more focused modules?**
  _Cohesion score 0.06201550387596899 - nodes in this community are weakly interconnected._