# Piano: migrazione al client Chapter 1 più recente (GamersFirst, Client=22)

Client nuovo: `C:\Program Files (x86)\GamersFirst\War Rock` (version.cfg: Launcher 10 / Updater 15 / **Client 22**).
Client vecchio (finora usato): `C:\Program Files (x86)\WarRock` (Launcher 8 / Updater 13 / Client 17, build 17.7).

## A. Rischi di compatibilità col nuovo client (da verificare dal vivo, in ordine)

1. **Anti-tamper `FileCRCListDoc`** — il bypass noto (`0x2E4F2C`, `74`→`EB`) è per 17.7; l'offset in 22 sarà diverso. Serve rifare la ricerca (stringa "CRC Checksum Error") solo se il client si rifiuta di partire dopo aver toccato qualcosa. Un client **non modificato** non ne ha bisogno: partire da lì.
2. **Hosts / login** — `login.warrock.net → 127.0.0.1` già presente. Il nuovo launcher/updater può contattare altri host (patch server): osservare cosa risolve.
3. **LAUNCHER 0x1010** — `auth/handlers.js` risponde "versione 0 ovunque". Con Updater/Launcher più recenti il formato della risposta potrebbe essere diverso → sintomo: il client resta in patching o si chiude.
4. **Server list 0x1100** — il commento in `auth/handlers.js` dice che il campo `1.11025 // PF_20` fu **tolto** perché il 17.2 mostrava la lista sfasata. Il client 22 potrebbe invece *aspettarlo* (il C# di riferimento lo invia). Prima ipotesi da provare se la lista server è vuota/sfasata.
5. **ServerTime 0x6100** — `game/handlers.js` accetta solo `versionId === 3`, altrimenti `90020`. Il client 22 potrebbe mandare un altro valore: guardare il log `Game IN` e adeguare (accettare un set di versioni, non solo 3).
6. **Authorization 0x6200** — layout dei campi costruito su 17.x ("5 blocchi unknown", `Gameserver1` hardcoded). Possibili campi nuovi/spostati in 22 (livello, slot, itemlist).
7. **Item/Weapon ID** — `sql/*.sql` e `items.js` dipendono dagli ID del 17.x; il nuovo client può avere armi/oggetti nuovi o ID cambiati (crash noti in shop già visti in 17.7: `WarRock.exe+0x2C339E`).
8. **textdata / Data** — il nuovo client ha i propri dati; i test di personalizzazione fatti su 17.7 non si trasferiscono.

Metodo: catturare ogni passo dai log (`auth-server.log`, `game-server.log`), confrontare con la tabella pacchetti in `Protocollo WarRock.md`, e aggiornare la guida con una nuova fase "Client 22".

## B. Problemi / lacune del codice attuale (analisi del 2026-11-04)

**Sicurezza / correttezza**
- `handleAuthorization` non verifica il `sessionId` con l'Auth server (già dichiarato `ponytail:`): chiunque connetta la 5340 con userId/sessionId inventati entra come quell'utente. Priorità alta se il server esce da localhost.
- Il canale interno (5012) è ascoltato su tutte le interfacce con XOR fisso e `serverKey` in chiaro in `config.json`; nessuna autenticazione reale. Bind su 127.0.0.1 o rete Docker interna.
- `config.json`: MariaDB `root` con password vuota (ok solo in dev; in Docker c'è già `.env`).
- Password: `sha256(password+salt)` — corretto per compatibilità col C#, ma nessun rate-limit/lockout sul login.
- Nessun limite di dimensione sul buffer in `wrapSocket`: un client che non manda mai `\n` fa crescere la memoria all'infinito → aggiungere un tetto (es. 64 KB → `socket.destroy()`).
- `parsePacket` ritorna `Number(NaN)` per id/tick malformati senza validazione; i campi con `\x1D` non vengono ri-convertiti in spazio in ingresso (verificare chat/nick).

**Robustezza**
- Stato tutto in memoria (`state.js`, rooms, clan war): perso a ogni riavvio. Accettabile in dev; loggarlo come limite.
- Molte `db.query(...).catch(log)` fire-and-forget per kill/death: nessuna garanzia di ordine, nessun retry; kill e `user.kills` in memoria possono divergere dal DB.
- `socket.on('close')` registrato dentro `handleAuthorization` ma `socket.user` può non esistere per socket che non completano il login → controllare che ogni handler faccia guard su `socket.user` (es. `handleChannelSelection` lo dereferenzia senza controllo).
- Controllo "account già connesso" è un O(n) sulla mappa `users` e non è atomico rispetto all'`await` successivo (due login simultanei con lo stesso account passano entrambi il controllo prima di `users.set`).
- `handleServerTime`: MAC blacklist interrogata ad ogni connessione, nessuna cache.
- Nessun graceful shutdown (SIGINT) e nessun supervisore (`auth`/`game` partono separati a mano; se uno cade l'altro non si riallinea — `connectToAuthServer` va verificato per la riconnessione).

**Funzionalità mancanti / scheletri**
- Clan war (`isClanWar`), assist reali, spawn per mappa, punteggi non-Explosive (roundtimer), RTT del ping, `UpgradeClan`, MAX_MEMBERS fisso a 20 — tutti marcati `ponytail:` nel codice. Estrarli con `/ponytail-debt`.
- Itemshop: prezzi inventati per codici sconosciuti (`sql/06-weapons.sql` ecc.).
- Nessun test automatico: esiste solo `verify_all.js` (smoke) e `tools/fake-client.js`. Per il client 22 serve soprattutto un **test di regressione dei pacchetti** (login → server list → serverTime → authorization → channel → room).

**Refactoring candidati** (solo se servono davvero, ponytail)
- `rooms.js` (615), `gamesubs.js` (718), `gm.js` (566), `clan.js` (505): file grandi e dense di `blocks[n]` magici → costanti nominate per gli indici dei pacchetti, dove un cambio di layout del client 22 li toccherebbe.
- `logPacket` / try-catch handler duplicati identici in `auth-server.js` e `game-server.js` → una funzione condivisa in `lib/xor-socket.js` (`listen(port, keys, label, handlers)`).
- Versione client accettata (`3`), nome server (`Gameserver1`), porte: spostare in `config.json` così il client 17 e 22 convivono senza toccare il codice.
- Log: `OUT/IN` su console senza livelli; con più bot il volume è enorme → flag `DEBUG_PACKETS`.
- Repo: `WarRock-ToXiiC-Core/` resta non tracciato (decisione documentata in CLAUDE.md); `.gitignore` copre già `*.log` e `mariadb-portable/`.

## C. Prossimi passi concreti
1. Lanciare il launcher del nuovo client **senza modifiche** e leggere i log: ogni errore ci dice quale punto di A si applica.
2. Correggere un punto alla volta (probabile ordine: 3 → 4 → 5 → 6), un commit per fix, aggiornando `Protocollo WarRock.md`.
3. Solo dopo che il flusso lobby→stanza→partita funziona sul 22: sezione B (sicurezza prima, poi refactoring).

## D. Esito (2026-11-04) - client 22 raggiunge la lobby

Verificato dal vivo con client reale: login `wruser`, lista server, lobby, ping stabili. Nessun errore server.

Cosa serviva (nessuna DLL sostitutiva: l'SDK HackShield e' linkato staticamente in `WarRock.exe`, non c'e' nulla da sostituire):
1. **`WarRock.exe` patchato** con `tools/client22/patch22.py` (ogni patch controlla i byte originali; backup in `WarRock.exe.orig`):
   - `UpdateHS` (0x5c5ac0) -> ritorna 1: l'originale aspettava fino a 10 min `HSUpdate.exe` (server AhnLab morti) e poi usciva.
   - `Monitoring` (0x5c5b10) no-op, wrapper start/stop service (0x5c5df0) -> ritorna 1.
   - CRC `FileCRCListDoc`: `75`->`EB` a 0x70ca11 (file offset 0x30ca11).
   - **`FUN_00824c9c` = `Direct3DCreate8` instradato dentro HackShield** (id 0x1f): con HackShield spento ritorna 0 -> "Could not initialize Direct3D" -> crash. Riscritto per chiamare l'import reale `d3d8.dll` (IAT 0x8be558, `ret 4`).
2. **Server**: `auth/handlers.js` ora invia il campo versione `1.11025` dopo `user.status` (il client 22 lo richiede, il 17.x no -> il vecchio client non e' piu' compatibile finche' non diventa configurabile).
3. Inutili ma innocui: `Engine.ini` 1024x768x32, preferenza GPU NVIDIA per l'exe (rimuovibile in `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`).

Lezione di metodo: il minidump (`tools/client22/minidump.py`) + stack + Ghidra headless ha dato la causa in pochi passi; l'ipotesi "16 bit / GPU" era sbagliata e il messaggio d'errore a schermo (screenshot) ha chiuso il caso.

Aperti: la risposta LAUNCHER 0x1010 azzera `version.cfg` (Updater=0) - rispondere con le versioni reali; rendere il campo versione login configurabile; poi stanze/partita sul client 22 e sezione B.

**Aggiornamento**: stanza creata e partita avviata (Start) dal client 22 con un bot `fake-client` come secondo giocatore: pacchetti di gioco (id 30000) e relay UDP regolari, zero errori server. `fake-client.js` allineato al campo versione (indici IP/porta +1).
