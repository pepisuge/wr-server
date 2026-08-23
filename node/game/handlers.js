const { users } = require('./state');
const { handleRoomCreation, handleRoomJoin, handleRoomLeave, handleRoomListRequest, handleRoomKick, handleRoomInvite, removeFromRoom, sendRoomList, ROOM_CREATION, ROOM_JOIN, ROOM_LEAVE, ROOM_KICK, ROOM_INVITE, ROOM_LIST } = require('./rooms');
const { handleChat, CHAT } = require('./chat');
const { handleGamePacket, GAME_PACKET, handleScoreboardRequest, SCOREBOARD } = require('./gamesubs');
const { handleExplosivesPacket, EXPLOSIVES } = require('./explosive');
const { handleEquipment, EQUIPMENT } = require('./equipment');
const { loadUserDetails, effectivePremium, levelForXp } = require('./progression');
const { CLAN_SYSTEM, handleClanSystem, clanInfo } = require('./clan');
const { handleUserList, announceJoin, announceLeave, USER_LIST } = require('./userlist');
const { handleItemshop, ITEMSHOP } = require('./shop');
const { loadUserInventory, loadUserEquipment, buildItemlist, buildSlotState } = require('./inventory');
const { loadRedeemedCoupons, handleCoupon, COUPON } = require('./coupon');
const { handlePingReply, PING } = require('./ping');

const SERVER_TIME = 0x6100;
const AUTHORIZATION = 0x6200;
const CHANNEL_SELECTION = 0x7001;

function isAlphaNumeric(s) {
  return /^[a-zA-Z0-9]+$/.test(s);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Approximates .NET's Calendar.GetWeekOfYear(FirstFourDayWeek, Monday) -
// close enough, nothing downstream seems to depend on exact correctness.
function weekOfYear(date) {
  const jan1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const days = Math.floor((date - jan1) / 86400000);
  return Math.ceil((days + jan1.getUTCDay() + 1) / 7);
}

// Ported from Game/Packets/ServerTime.cs - a single slash-separated field:
// seconds/minutes/hours/day/month(0-based)/year-1900/week/dayOfYear/0
function buildServerTimeField() {
  const now = new Date();
  const dayOfYear = Math.floor((now - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000);
  return [
    pad(now.getUTCSeconds()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCHours()),
    pad(now.getUTCDate()),
    now.getUTCMonth(),
    now.getUTCFullYear() - 1900,
    weekOfYear(now),
    dayOfYear,
    0,
  ].join('/');
}

function createHandlers(db) {
  // Ported from Game/Handlers/RequestServerTime.cs. The client sends this
  // right after connecting, as a "am I banned by hardware" pre-check before
  // it even tries to authorize.
  async function handleServerTime(socket, pkt) {
    const versionId = Number(pkt.blocks[1]);
    const mac = pkt.blocks[2] || '';

    if (versionId !== 3) {
      socket.sendPacket(SERVER_TIME, [90020]); // DiffrentClientVersion
      return;
    }
    if (mac.length !== 12 || !isAlphaNumeric(mac)) {
      socket.sendPacket(AUTHORIZATION, [73030]); // NormalProcedure
      return;
    }

    const [rows] = await db.query('SELECT macaddress FROM macaddress_blacklist WHERE macaddress = ?', [mac]);
    if (rows.length > 0) {
      socket.sendPacket(AUTHORIZATION, [90105]); // NotAccessible (MAC banned)
      return;
    }

    socket.sendPacket(SERVER_TIME, [1, buildServerTimeField()]);
  }

  // Ported from Game/Handlers/Authorization.cs + Game/Packets/Authorization.cs.
  // ponytail: doesn't validate sessionId against the Auth server yet (no
  // PlayerAuthorization round-trip, no Session/Activate state machine the
  // reference builds for that) - trusts whatever the client sends. What it
  // does check is the actual complaint that mattered here: the same account
  // connected twice at once. That's a single Map scan keyed by userId,
  // cheaper than porting the reference's two-server session handshake for
  // the same guarantee. Add the full round-trip if sessionId spoofing itself
  // becomes a real concern.
  async function handleAuthorization(socket, pkt) {
    const userId = Number(pkt.blocks[0]);
    const username = pkt.blocks[2] || '';
    const displayname = pkt.blocks[3] || '';
    const sessionId = Number(pkt.blocks[4]);
    const accessLevel = Number(pkt.blocks[7]) || 0;

    if (!(userId > 0 && username.length > 2 && displayname.length > 2 && sessionId > 0)) {
      socket.sendPacket(AUTHORIZATION, [73030]); // NormalProcedure
      socket.end();
      return;
    }

    for (const existing of users.values()) {
      if (existing.id === userId) {
        socket.sendPacket(AUTHORIZATION, [92040]); // IdInUse
        socket.end();
        return;
      }
    }

    // Fase 5/6: real xp/money/premium from user_details, row created with
    // the reference's defaults on first login (see progression.js).
    const row = await loadUserDetails(db, userId);
    const { premium, expireDate } = effectivePremium(row);
    const xp = Number(row.xp);
    const money = Number(row.money);
    const clanId = Number(row.clanid);
    const clanRank = Number(row.clanrank);
    const clan = clanInfo({ clanId, clanRank });

    const inventory = await loadUserInventory(db, userId);
    const equipment = await loadUserEquipment(db, userId);
    const redeemedCoupons = await loadRedeemedCoupons(db, userId);

    const fields = [
      1, // Error_OK
      `Gameserver1`,
      sessionId,
      userId,
      sessionId,
      displayname,
      ...(clan ? [clan.id, clan.name, clan.rank, clan.rank] : [-1, -1, -1, -1]),
      premium,
      0, 0, // unknown
      levelForXp(xp), // level
      xp,
      0, 0, // unknown
      money,
      Number(row.kills),
      Number(row.deaths),
      0, 0, 0, 0, 0, // 5 unknown blocks
      buildSlotState({ premium }, inventory),
      ...equipment.map((slots) => slots.join(',')), // equipment per class (engineer/medic/sniper/assault/heavy)
      buildItemlist(inventory),
      0, 0, // unknown
    ];
    socket.sendPacket(AUTHORIZATION, fields);

    socket.user = {
      id: userId,
      sessionId,
      displayname,
      socket,
      channel: null,
      roomId: null,
      xp,
      money,
      premium,
      premiumExpireDate: expireDate,
      clanId,
      clanRank,
      isGm: !!Number(row.is_gm),
      userListPage: 0,
      roomListPage: 0,
      inventory,
      equipment,
      redeemedCoupons,
      lastPong: Date.now(), // ping.js's liveness timeout baseline
    };
    users.set(sessionId, socket.user);
    announceJoin();
    socket.on('close', () => {
      removeFromRoom(db, socket.user); // a dropped connection must clean up a room the same way an explicit leave does
      users.delete(sessionId);
      announceLeave();
    });
  }

  // Ported from Game/Handlers/ChangeChannel.cs.
  function handleChannelSelection(socket, pkt) {
    const target = Number(pkt.blocks[0]);
    if (!(target >= 0 && target <= 4)) {
      socket.end();
      return;
    }
    socket.user.channel = target;
    socket.user.roomId = null;
    socket.sendPacket(CHANNEL_SELECTION, [1, target]);
    sendRoomList(socket, 0);
  }

  return {
    [SERVER_TIME]: handleServerTime,
    [AUTHORIZATION]: handleAuthorization,
    [CHANNEL_SELECTION]: handleChannelSelection,
    [USER_LIST]: handleUserList,
    [ROOM_CREATION]: handleRoomCreation,
    [ROOM_JOIN]: handleRoomJoin,
    [ROOM_LEAVE]: (socket) => handleRoomLeave(socket, db),
    [ROOM_KICK]: handleRoomKick,
    [ROOM_INVITE]: handleRoomInvite,
    [ROOM_LIST]: handleRoomListRequest,
    [CHAT]: (socket, pkt) => handleChat(socket, pkt, db),
    [GAME_PACKET]: (socket, pkt) => handleGamePacket(socket, pkt, db),
    [SCOREBOARD]: handleScoreboardRequest,
    [EXPLOSIVES]: handleExplosivesPacket,
    [EQUIPMENT]: handleEquipment(db),
    [CLAN_SYSTEM]: handleClanSystem(db),
    [ITEMSHOP]: handleItemshop(db),
    [COUPON]: handleCoupon(db),
    [PING]: handlePingReply,
  };
}

module.exports = { createHandlers };
