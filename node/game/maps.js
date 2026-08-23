// Map catalog, ported from Game/Managers/MapManager.cs - but only the slice
// Room.Start() actually reads (flag_count + the two team spawn-flag
// indices). Map rotation per channel/mode and real flag-capture gameplay
// (Conquest) aren't ported - this exists so a room can know, faithfully,
// how many flags its map has and which two are the team spawn anchors.
const MAPS = new Map(); // id -> { id, name, flagCount, spawnFlags: [teamA, teamB] }

async function loadMaps(db) {
  const [rows] = await db.query('SELECT id, name, flag_count, flag_state FROM map_data');
  MAPS.clear();
  for (const row of rows) {
    const spawnFlags = String(row.flag_state || '0-0')
      .split('-')
      .map(Number);
    MAPS.set(Number(row.id), { id: Number(row.id), name: row.name, flagCount: Number(row.flag_count), spawnFlags });
  }
  console.log(`Maps: loaded ${MAPS.size} catalog entries.`);
}

function getMap(id) {
  return MAPS.get(Number(id));
}

module.exports = { loadMaps, getMap };
