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

## E. Come funzionano download e installazione patch (WRLauncher / WRUpdater, client 22)

Ricavato da stringhe + decompilazione Ghidra (`FUN_00402d90` nel launcher, `FUN_00403440` nell'updater). Le parti marcate (?) non sono verificate dal vivo.

**Catena di processi**: `WRLauncher.exe` -> (se serve patch o sempre) `WRUpdater.exe %s` -> `System\Warrock.exe %s`. Gli `%s` sono argomenti passati da uno all'altro (?contenuto non verificato).

**`version.cfg`** = stato locale, 6 interi nell'ordine `Format, Launcher, Updater, Client, Sub, Option` (client 22: 0/10/15/22/0/0). Stesso ordine del pacchetto `0x1010` di `login.warrock.net:5330`.

**Launcher**
1. Chiede a `login.warrock.net` il pacchetto 0x1010 (il nostro `LAUNCHER`): risposta = 6 versioni "attuali" + URL. In alternativa (flag, ?) scarica `version.txt` da `http://patch.warrock.net/k2network/warrock/` (URL cablato nell'exe) con WinInet (`InternetOpenUrlA`/`InternetReadFile`).
2. Confronta con `version.cfg`:
   - `Updater locale < Updater remoto` -> scarica `updater.zip`, lo decomprime nella cartella del gioco, poi scrive il nuovo `version.cfg`.
   - **Poi copia SEMPRE l'Updater remoto sul locale e riscrive `version.cfg`**: per questo la vecchia risposta tutta a 0 azzerava `Updater` (0 non e' mai "piu' recente", quindi niente download, ma il file veniva sovrascritto).
3. Avvia `WRUpdater.exe`.

**Updater**
- `Launcher locale < remoto` -> scarica `launcher.zip` (aggiorna il launcher).
- **Client**: per ogni versione `v` da `Client locale` a `Client remoto - 1` scarica **`PF_<v>_<v+1>.zip`** (patch incrementali, una alla volta, riscrivendo `version.cfg` dopo ogni passo -> interrompibile e riprendibile).
- Con `Client` uguale: se `Sub locale < Sub remoto` -> **`Sub<n>.zip`**.
- `Option locale < remoto` -> **`optpatch.zip`**.
- Poi **elimina i vecchi file** ("Delete old version files!") e lancia `System\Warrock.exe`.
- Formato zip: decompressione zlib 1.2.3 interna; controlli "header crc mismatch" / "incompatible version" (le patch hanno un header con CRC; nome magico `FSCRC0` visto nelle stringhe).
- Messaggi di errore utili: "Cannot get a file", "Cannot download a target file!", "Cannot write to a local version file !".

**Per il nostro server privato**
- Con `PATCH_VERSIONS` uguale a `version.cfg` (0,10,15,22,0,0) il launcher non scarica nulla: e' la configurazione attuale e va bene.
- **Attenzione**: se `version.cfg` locale ha `Updater` < valore del server (es. 0 contro 15) il launcher tenta di scaricare `updater.zip` da `patch.warrock.net` (host inesistente -> errore). Tenere `version.cfg` e `PATCH_VERSIONS` allineati.
- Per *distribuire* patch ai propri client servirebbe: `hosts` che punti `patch.warrock.net` a 127.0.0.1 (o altro host), un server HTTP statico con `/k2network/warrock/version.txt` e gli zip `PF_22_23.zip` ecc. nel formato col CRC header, e `PATCH_VERSIONS` con Client = 23. Non implementato: non serve finche' usiamo un solo client modificato a mano.

## F. Come il client 22 crea un giocatore remoto (decompilazione, 2026-11-04)

Catena ricostruita da `WarRock.exe` (Ghidra, progetto `re-tools\proj22`):
- Tabella gestori pacchetti `FUN_005fefa0`: `0x7500` (info giocatori) -> `FUN_005f4900`, `30000 = 0x7530` (gioco) -> `0x005f2d20`.
- `0x7530` tipo `2` (in partita): sottotipi 102-500 passano solo se i flag globali `DAT_00b8cbf8` e `DAT_00b8cc10` sono != 0 (partita caricata); 100 e 150 passano sempre. Poi tabella sottotipo->funzione (`FUN_004e4800`): **150 (Spawn) = `FUN_004e39f0`**, 100 (ConfirmSpawn) = `FUN_004dd7d0` (scrive solo un campo per slot), 151 = `FUN_004e44d0`, ecc.
- Spawn (`FUN_004e3960` + `FUN_004e37b0`), campi del payload dopo il sottotipo: `p0` = indice punto di spawn (`p6` se modalita' `+0x39188 == 1`); `p1`->`c37e24`, `p2`->`c37e28` (poi passato a `FUN_004f0a00`: selettore tipo modello/arma, **non** un punto di spawn), `p3`->`c37e3c`, `p4`->`c37e10`, `p5`->`c37e14`; salute = 1000. Record per slot: array a stride 0xd20 da `0xc37e24`.
- Creazione entita' `FUN_004eedf0(slot, idx, 0, pos)` agisce SOLO se: slot < 32; **`idx` < numero di punti di spawn della mappa caricata**; `c37eac[slot] >= 0` (impostato da 0x7500 = lo slot stesso, quindi basta aver ricevuto le info del giocatore). Poi crea l'oggetto 0x300 byte, lo marca remoto (`+0xfc = 1`) e imposta il modello da `p2`.
- Info giocatori `0x7500`: `FUN_005f46a0` legge N record (~29 campi: id, session, slot, ..., nick 512 byte, ..., due endpoint IP:porta); `FUN_005f4100` li applica ai record per slot.

Conseguenze per il bot (`fake-client.js`): lo spawn inviato aveva `p2 = 13` (valore inventato); un valore fuori dal range dei modelli e' una causa plausibile di entita' invisibile. Ora usa `p2 = 1`, `p3 = 0` (classe 0), `p0 = 0` come il client reale. Resta da verificare dal vivo; se non basta, i candidati sono: movimento UDP (il bot rigioca la cattura del 17.x) e la forma esatta del record `0x7500` del bot.

## G. Indagine "il bot non si vede" (2026-11-04) - stato

Strumenti: lettura memoria del client in esecuzione (WarRock.exe gira ELEVATO: serve UAC; script a campionamento, `ReadProcessMemory`, solo lettura), contatore relay UDP lato server (`[udp-relay/5s]` in `game/udp-handlers.js`), decompilazione Ghidra.

Accertato:
- Relay UDP ok in entrambe le direzioni (bot->client ~18 pkt/s, client->bot ~3 pkt/s), verso gli endpoint registrati.
- Il client crea l'entita' dello slot del bot (`entity[slot]`, flag remoto `+0xfc=1`, `+0x2ec=slot`) ma NON applica posizione/stato: `+0x34/+0x3c` (coordinate dell'entita' locale) restano 0 per il bot.
- Lo Spawn (sub 150) viene ignorato dal client se la mappa non e' ancora caricata (`FUN_004e37b0`): il bot ora spawna dopo lo spawn del giocatore reale.
- Campi spawn: `payload[2]` = indice punto di spawn (< numero punti mappa, qui 8; 13 -> nessuna entita'), `payload[3..4]` = classe/modello (reale: `[0,0,idx,1,1,...]`).
- Intestazione tunnel UDP: i byte 10-13 (valore per sessione del client reale), 24-25 e 28 (per sub-comando) del bot erano costanti vecchie; ora copiati dai pacchetti reali ricevuti.
- Formato corpo 0x31 (float XOR 0xc3, offset nel corpo dopo i 29 byte di header): X@29, altezza@33, Z@37 (+ copie precedenti @73/77/81 e @85/89/93), angoli @9/13/41.

Non risolto: perche' il client non applica i frame di movimento del bot. Prossimi passi: (1) test con DUE client reali e confronto dei log (spawn, 0x7500, header/corpo UDP) col bot; (2) trovare il metodo virtuale del gestore UDP del client (`FUN_006b0d10` chiama `vtable+0x14`) e leggere cosa valida; (3) leggere il dump completo (`dump.ingame.txt`) dopo lo spawn del bot per capire dove finisce la posizione.

### G.2 Aggiornamento (stesso giorno, dopo piu' giri con lettura memoria)

Cambiamenti fatti per il bot / relay (tutti innocui, mantenuti):
- `fake-client.js`: il bot spawna dopo lo spawn del giocatore reale; payload spawn `[0,0,0,1,1,..]`; copia l'header UDP reale; riscrive nel corpo dei frame `0x31/0x34` lo **slot mittente** (primi 2 byte della struttura, XOR 0xc3, LE) e sposta X di `BOT_OFFSET_X` (default 400).
- `game/udp-handlers.js`: il relay parte dal socket su cui il *destinatario* ha fatto l'handshake (il client reale parla solo con la porta 5350, il bot usa 5351); log `[udp-handshake]` e contatori `[udp-relay/5s]` con porta sorgente/destinazione.

Struttura del frame di movimento (client 22): corpo = `[len u16 LE][struct]`, len = `raw[28..29]` XOR 0xc3 (0x60 per 0x31, 0x30 per 0x34); `struct[0..1]` = slot mittente (rifiutato se == slot locale, `FUN_005fd0e0`); `struct+0x1c/0x20/0x24` = X/altezza/Z float; `FUN_005fd1a0` applica (primo frame: imposta `entity+0x184 = 1`, posizione in `entity+0x148..` ecc.), scrive `DAT_00c37f4c[slot*0x1a40]` = timestamp ricezione **dopo** la validazione.

Verificato dal vivo (lettura memoria, client elevato): con tutte le correzioni sopra, `DAT_00c37f4c` dello slot del bot resta 0 ("never") e `entity+0x184 == 0`: **nessun frame del bot supera il ricevitore/validatore del client**. Il blocco e' quindi prima di `FUN_005fd1a0`: nel ricevitore UDP (`FUN_006b0d10` + metodo virtuale `+0x14`) o in `FUN_005fd0e0` (controllo di coerenza sul campo `struct[0xb]` e su `entity+0x298`).

Non trovato: il metodo virtuale effettivo `+0x14` dell'oggetto di rete (i vtable `0x8c3790`, `0x8c37b0`, `0x8e1fb0` esaminati non sono quello giusto; `DAT_00bfc1e8` e' il gestore di gioco, non l'oggetto di rete).

Metodo riutilizzabile: il client gira elevato -> script `ReadProcessMemory` lanciato con UAC (`Start-Process powershell -Verb RunAs`), campionamento su file; indirizzi chiave: `DAT_00bfc1e8`(mgr) `+0x4e324` = slot locale; array giocatori `0xc37e24 + slot*0x1a40`; tabella entita' `*DAT_010e743c`.

Prossimo passo consigliato: test con DUE client reali (il server logga gia' handshake/UDP di entrambi) e confronto dei frame; oppure trovare l'oggetto di rete del client (costruttore del thread `FUN_006b21e0`) e leggerne i contatori.
