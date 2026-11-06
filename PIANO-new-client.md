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

## H. Sistema di patch (launcher/updater) - verificato dal vivo con una copia di prova

Esito: **la pipeline funziona con zip normali**. Prova su `re-tools\wrtest` (launcher+updater copiati, `version.cfg` a Client=21): `GET /wr/PF_0_21.zip` -> 200, file estratto nella cartella del gioco, `version.cfg` aggiornato da solo a Client=22.

Regole ricavate (decompilato + prova):
- Il launcher chiede `0x1010` al login: risposta `Format, Launcher, Updater, Client, Sub, Option, URL`. Con la risposta valida l'URL del campo e' la **base di download dei pacchetti** (usato dall'updater). Se il login non risponde, ripiega su `version.txt` da `http://patch.warrock.net/k2network/warrock/` (URL cablato, serve la voce `hosts` `patch.warrock.net`; `version.txt` = copia di `version.cfg`).
- Nomi: `updater.zip` (scaricato dal launcher se `Updater` locale < remoto), `launcher.zip` (dall'updater se `Launcher` locale < remoto), **`PF_<Format>_<ClientDiPartenza>.zip`** per ogni `Client` da locale a remoto-1 (es. 17->22 = PF_0_17, PF_0_18, ..., PF_0_21), `Sub<n>.zip`, `optpatch.zip`.
- Formato: ZIP standard, percorsi relativi alla radice del gioco; l'updater riscrive `version.cfg` dopo ogni pacchetto. User-Agent `WR_LAUNCHER` / `WR_UPDATER`. Un file che inizia con `<?` viene scartato come URL non valido.
- WRUpdater.exe gira come amministratore (UAC) e crea `System\pbsign`.

Strumenti nel repo: `tools/patch-server/patch-server.js` (server HTTP statico, serve `./wr/`, logga ogni richiesta), `WR_PATCH_URL` (variabile d'ambiente del login) per l'URL nel pacchetto 0x1010.

Attenzione operativa: la riga aggiunta a `hosts` va su una riga propria (mancava il newline finale: la prima volta si e' fusa con `login.warrock.net` e l'ha rotta).

## I. VM self-update verified (2026-11-04)
The VM's client 17 updated to 22 via launcher/updater against `tools/patch-server` (requests: updater.zip, PF_0_17..21.zip, launcher.zip, all 200). Requirements: VM hosts entries for login/patch.warrock.net -> host IP, launcher run as administrator. Next step: two-client match on client 22 to capture real spawn/UDP traffic.

## J. Due client reali (client 22, host + VM) vs bot — 2026-11-04
Con due client reali (host `wruser` slot 0, VM `wruser2` slot 4) **si vedono e si sparano**: il server/relay e' a posto. Header UDP tunnel 0x31 (29 byte, ground truth): `1010 0000 | sess(2) | room(2)=0 | 0000 | nonce(4, per client e per partita) | sub 31 00 | len 007e | 0000 0101 | target sess(2) | 0000 | slot DESTINATARIO(2) | a3`; corpo (XOR c3) = struct, `struct[0..1]` = slot mittente (LE a offset 1).
Corretto nel bot (non ha bastato, bot ancora invisibile): slot destinatario in byte 26-27, nonce proprio (random) nei byte 10-13.
Ricevitore client: `FUN_006b0d10` -> (0x3100) `+0x14` -> `FUN_005fd710` (richiede `DAT_00b8cbf8`,`DAT_00b8cc10` != 0) -> `FUN_005fd1a0` -> `FUN_005fd0e0`: scarta se slot==locale, **entita' dello slot mittente assente (`FUN_004eea90`)**, float non finiti, o `(entity+0x298==FUN_00461a30()) != (struct[0xb]==vtbl+0x38())`. Ipotesi aperte: manca l'entita' del bot (info/spawn TCP) oppure incoerenza di `struct[0xb]` (offset 22 corpo, vale 0/1 nei frame reali). Il metodo virtuale +0x14 reale non e' ancora stato individuato (base vtable 0x8e1fb8 ha stub vuoti).
Prossimo passo: lettura memoria del client con bot in partita (entita' slot 4, `DAT_00b8cbf8/cc10`); lo script ps1 di campionamento va riscritto (OpenProcess 0x410 come `mem_poll.ps1`).

### J.2 Lettura memoria con bot realmente in stanza (2026-11-04)
Con il bot nella stanza (join riuscito; un `join 0` fatto PRIMA della creazione stanza dava errore 94010 -> "bot invisibile" falsi positivi): `DAT_00b8cbf8=1`, `DAT_00b8cc10!=0`, **entita' dello slot 4 esiste** (tabella `*DAT_010e743c`, vettore di 32 puntatori; slot 0 e 4 popolati), `entity+0x298` identico tra slot 0 e 4 e != singleton `DAT_011d33e8` (quindi il controllo finale di `FUN_005fd0e0` e' ok), ma `DAT_00c37f4c[4*0x1a40]=0`: nessun frame del bot arriva a `FUN_005fd1a0`.
Header UDP parsato da `FUN_006b5cd0` (struct a `obj+0x5150`): `[0]=type`, `[2]=sess mittente(raw4)`, `[4]=raw8`, `[6..7]=nonce(raw10-13)`, `[8]=0x3100 (raw14)`, `[9]=len(raw16)`, byte raw20 deve valere 1 (`obj+0x5166`), `[0xc]=sessione destinatario(raw22)`, `[0xd]=raw24`, `[0xe]=slot destinatario(raw26)`; poi vtable+0x14(buf,len,raw21,sess,raw8,target sess,target slot,raw24). Corpo: `[len i16 = 0x60][struct 0x60]` letto da `FUN_006b00c0` (len>0 e dentro il buffer).
Non trovato: il metodo virtuale +0x14 (la classe base 0x8e1fb8 ha solo stub vuoti; scansione heap del buffer/header non ha dato match). Prossimo: scansione memoria con pattern verificato su un client in partita, oppure confronto diretto con due client reali (stessa lettura entita'/recTs per lo slot della VM).

## K. BOT VISIBILE in client 22 (2026-11-06) — causa trovata
Il ricevitore UDP reale e' `FUN_006b4630` (non `6b0d10`, codice morto); per i frame di gioco (sub >= 0x3000) chiama il validatore virtuale `+0x38` = `FUN_006b23f0` (vtable `0x8c3760`; gestore `+0x30` = `FUN_00471db0`, decifratura `+0xc` = `FUN_00471d30`, XOR 0xc3/0x96). Il validatore scarta (ritorna -1) se NON vale:
- raw6-7 (u16 BE) == id stanza locale (`this+0x491a`);
- raw8-9 = **slot del MITTENTE** = indice nella tabella peer (`this+0x4920`, ptr non nullo, `idx < this+0x5122`);
- raw4-5 (sessione mittente) == `peer+0x10`;
- se `peer+6 == 3` ("connesso"): nonce raw10-13 == `peer+0x18`.
Il bot copiava l'header dell'host con raw8-9 = 0 = slot dell'host -> sessione non corrispondente -> tutti i frame scartati. Fix in `fake-client.js buildTunnelPacket(..., targetSlot, senderSlot)`: raw8-9 = slot del bot (+ gia' fatti: raw26-27 = slot destinatario, nonce proprio casuale). **Bot ora visibile in partita**; si muove "speculare" perche' rigioca i frame dell'host (X + 400).
Metodo di debug che ha funzionato: x32dbg collegato a WarRock.exe (elevato), comandi `bp <addr>`, `SetBreakpointCondition <addr>, 0`, `SetBreakpointLogCondition <addr>, 1`, `SetBreakpointLog <addr>, "...{x:esi}..."`, `bp ws2_32.recvfrom` per trovare i chiamanti. `WR_PONG_TIMEOUT_MS` (game/ping.js) alza il timeout ping mentre il debugger ferma il client.
Prossimo: movimento autonomo del bot (generare i frame 0x31/0x34 con posizione/angoli propri, non rigiocare quelli dell'host), poi dataset/NN.

## L. Struttura del frame di movimento 0x31 + bot autonomo (2026-11-06)
Decodificata registrando i frame di un client reale (`WR_UDP_DUMP=<file> node game-server.js` scrive ogni pacchetto tunnel in JSONL) mentre si eseguivano azioni controllate. Corpo decifrato (XOR 0xc3) = `[len hi][struct 0x60]`; offset sotto = offset nella struct:
- 0-1 slot mittente (u16 LE); **yaw** gradi f@12 (copia f@40), **pitch** gradi f@44 (f@8 = 360-pitch); posizione X/altezza/Z f@28/32/36 (copie f@72/76/80 e f@84/88/92, occhio = altezza+~24.2);
- byte 2 avanti, 3 indietro, 4 destra, 5 sinistra; byte 20 accucciato; byte 22 stato (0 fermo, 1 cammina, 2 salto); byte 24/26 stato di sparo; f@56 altezza occhio/bob (18.2 in piedi, 15.6 accucciato); f@60 salute %; byte 65-68 arma/munizioni (byte 68 = colpi).
- Cammino: avanti = (sin yaw, -cos yaw), ~75 unita'/s.
`fake-client.js botFrame()`: il bot genera i propri frame (pattuglia attorno alla posizione del giocatore, raggio `BOT_RADIUS`=250, `BOT_SPEED`=75, partenza a `BOT_OFFSET_X`=200; `WR_BOT_REPLAY=1` riattiva il vecchio replay speculare). Lezione: il punto di partenza deve venire dalla posizione del giocatore (terreno valido); una posizione fissa era finita fuori mappa -> bot invisibile. **Verificato: bot visibile e si muove da solo.** Non ci sono collisioni con la mappa (nessun dato geometrico).
Respawn: alla morte (sub 152 con il suo slot in blocks[8]) il bot manda ConfirmDeath (154), non invia frame per `BOT_RESPAWN_MS` (10000) e rifa doSpawn (verificato). Aggiornamento: il bot ora guarda il giocatore (yaw/pitch verso il suo occhio, pitch + = guarda in basso) e lo orbita (flag di direzione relativi allo sguardo, raggio 150-350). Verificato dall'utente. Prossimo: respawn del bot dopo la morte, sparo, dataset.

## M. Bot "sparring" per l'allenatore di mira (2026-11-06)
Per un dataset utile il bot non deve essere un bersaglio statico. `fake-client.js`: ogni 0,4-1,4 s sceglie chase/strafe (lato casuale)/retreat (+ salto con p=0,3, parabola 21 unita' in 0,7 s), con rotazione "a serpentina" della direzione (ampiezza 20-60 gradi, frequenza casuale); guarda sempre l'occhio del giocatore; `BOT_SPEED` (280 u/s di default; un giocatore a piedi ~77), pugno di coltello `DA02` a meno di `BOT_MELEE_RANGE` (85) ogni `BOT_MELEE_MS` (800) mandando al server un pacchetto danno da 23 campi (`[0,1,1,vittima,0,1,0,1,0,0,0,1239+sessioneAttaccante,0*10,'DA02']`; il server si fida dell'attaccante); respawn casuale 1-10 s (`BOT_RESPAWN_MIN_MS/MAX_MS`) in un punto a 400-900 unita' dal giocatore. `BOT_MELEE=0` disattiva l'attacco.
Registratore dataset: `WR_RECORD=<file> node game-server.js` (`game/record.js`): righe JSON `frame` (slot, x/h/z, yaw, pitch, tasti, stato, spari, salute, munizioni), `hit`, `spawn`. File in `datasets/` (ignorato da git).

## N. Confronto con SGMartin/Servidor-Chapter-1-WarRock (2026-11-06)
Repo scaricato (zip) e confrontato con `WarRock-Chapter-1-Server/` (nostro riferimento, README "PF-20") ignorando CRLF: differiscono solo ~20 file. Differenze utili:
- **Opcode coupon**: SGMartin `Coupon = 0x7910`; il nostro riferimento `0x8100 // Old: 0x7910`. La tabella pacchetti del **client 22** (`FUN_005fefa0`) registra `0x7910` e `0x7920` (level up) e NON ha `0x8100`/`0x8200`: il nostro Node usava 0x8100 -> **corretto in `game/coupon.js` (0x7910)** (non ancora provato col client).
- **ID oggetti** (Heal.cs, VehicleRepair.cs): SGMartin (PF-23) Medikit 77/78/79, adrenalina 82, hpKit 85, chiave 80/81; riferimento PF-20: 60/61/62, 65, (hpKit assente), 63/64. Il client 22 e' piu' vicino a PF-23. Node NON ha ancora handler di cura/riparazione: se si porta Heal/VehicleRepair, usare gli ID PF-23.
- Altre differenze (Room.cs, User.cs, Chat.cs, GameConfig, modi `AllowStartAlone`): solo messaggi "Cristina"/localizzazione e il flag `AllowStartAlone` che il nostro riferimento ha in piu'; nessuna differenza di protocollo.
- Il nostro riferimento ha in piu' il gestore `Launcher` (0x1010) e `RemoteEndIP`.
Da verificare col client 22: opcode clan del nostro Node (`0x6710`, `0x6760`) non compaiono nella tabella del client (solo come offset di memoria); la tabella ha 0x6011, 0x6100, 0x6200, 0x6300, 0x6400. File scaricati in scratchpad (non nel repo).

## O. Clan nel client 22 (2026-11-06) — verificato dal vivo + decompilazione
- Il client 22 NON ha piu' la sezione clan (conferma dell'utente) e il suo codice non usa mai gli opcode `0x6710` (CLAN_SYSTEM) e `0x6760`: nessun PUSH/immediato, solo offset di struttura. Quindi `node/game/clan.js` non viene raggiunto da questo client (resta innocuo; non e' una priorita').
- Rimane solo `CLAN_QUICK_JOIN = 0x7360` (anche in SGMartin/Paquetes.txt = 29536; nessuno dei due riferimenti C# lo implementa). Client -> server: `FUN_00469430` manda `[stringa]` (<100 caratteri, "NULL" se vuota; probabilmente la password della stanza) ed e' usato al posto del join normale (`FUN_0046ad40`: `[1, idStanza, stringa]`) quando `*(DAT_00bfc1e8+0x4cea8)` e' tra 0x41 e 0x46 (65-70 = 'A'..'F': significato non determinato; coincide per numero con i 6 ServerTypes 0..5 + 65, ma non verificato). Server -> client: `FUN_005ee230` e' SOLO un gestore di errori: 94110 (calcolo risultati), 94100 (caricamento dati), 94060 (utenti superati), 94030 (password errata), 93090, 93030, altrimenti messaggio generico; sono i codici di `RoomJoinErrors`. Il caso di successo non passa da 0x7360: presumibilmente il server risponde come per un join di stanza (0x7310).
- Conseguenze: la clan war richiede capire cosa imposta quel valore 65-70 (campo del pacchetto di cambio canale/lista server?) e un handler 0x7360 -> join di stanza. Non implementato.
**Coupon verificato (2026-11-06):** con `0x7910` il coupon funziona sia col fake-client (MEOW -> `[0,0,saldo]`, ripetuto -> `-1`, inesistente -> `-2`) sia dall'interfaccia reale del client 22 (confermato dall'utente).

## P. Inventario delle implementazioni mancanti (2026-11-06)
Confronto sottocomandi di gioco (0x7530) riferimento vs Node (`game/gamesubs.js`): il riferimento ne ha 36, Node ne gestisce 20. **Mancano**:
- Cure/riparazioni: `101 Heal`, `102 Repair` (Heal.cs/VehicleRepair.cs: ID oggetto PF-23 nel client 22: medikit 77/78/79, adrenalina 82, hpKit 85, chiavi 80/81).
- Danni oggetti/ambiente: `104 ObjectDamage`, `153 ObjectDestroy`, `500 EnviromentDamage` (caduta/acqua).
- Veicoli: `200 EnterVehicle`, `201 ChangeVehicleSeat`, `202 LeaveVehicle` (+ `Entities/Vehicle.cs`, 177 righe; `0x`-pacchetto `LeaveVehicle`/`VehicleRepair`).
- Conquest: `156 FlagCapture` + `Modes/Conquest.cs` (191 righe); in Node solo mappe/indici (`maps.js`), nessun gameplay di bandiere.
- Oggetti a terra: `400 PlaceItemOnGround`, `401 UseItemOnGround` (kit, mine...), `159 Artillery`, `61 Votekick`.
- Pacchetti non-subcomando (RoomQuickJoin 0x7320 FATTO e verificato col bot; RoomSpectate 0x7330 non fatto: il client 22 manda [byte, numero, password|NULL] da FUN_004694c0): `RoomSpectate 0x7330`, `SpectatorInfo 0x7501`, `MapData 0x7510`, `Markt 0x7700`, `UpdateInventory 0x7900`, `CMDFindPlayer 0x6011`, `CLAN_QUICK_JOIN 0x7360` (il client 22 li registra, Node no).
Definiti ma senza handler: `4 StartReply`, `152 PlayerDeath`, `403 StartMission` (sono risposte/uscite, non richieste).
Prima di implementare ognuno va verificato che il client 22 usi lo stesso numero (come per il coupon: 0x8100 era sbagliato) leggendo le sue funzioni di invio.

### P.1 Fatto: Heal (101) e EnvironmentDamage (500) — 2026-11-06 — VERIFICATO nel client 22 (medikit e caduta su Marien OK, nessun unhandled sub)
`game/gamesubs.js`: `handleHeal` (medikit DQ01/02/03 = 300/450/600, HP kit DS10 = 200, adrenalina DS01 porta a 400 altrimenti +100, torre 400, solo stessa squadra; assist non tracciati) e `handleEnvironmentDamage` (danno non letale = stesso sottocomando con `[7]=danno, [8]=salute`; letale = Suicide 157 con lo slot in `[2]`, morte registrata come suicidio). Gli oggetti sono riconosciuti per CODICE tramite `items.codeById` (ids del DB = quelli del client 22: 77/78/79, 80/81, 82). Prova automatica: `node tools/test-gamesubs.js`. I sottocomandi non gestiti ora vengono loggati una volta (`[game] unhandled sub N payload=[...]`) per vedere i formati veri del client.
Non fatto: `102 Repair` (serve la logica dei veicoli, assenti) e il ramo veicolo di EnvironmentDamage.
**Da verificare dal vivo:** i campi esatti di 500 non sono mai stati catturati (nessuna riga nei log); se il client 22 li ha in altre posizioni, il log `unhandled`/i dati mostreranno la differenza.

### P.2 Quick join e spettatore (2026-11-06)
- RoomQuickJoin 0x7320 (corpo vuoto): fatto, verificato col bot. Scelta casuale tra stanze con posti, senza password e livello ok; poi join normale.
- RoomSpectate 0x7330 (client 22: `[byte, idStanza, password|NULL]`; il riferimento legge idStanza a blocks[1]): fatto, solo GM (non nel riferimento) + comando chat `/spectate <id>`. Gli spettatori stanno in `room.spectators` e ricevono i broadcast via `roomSockets()` (state.js). Risposta `[1,1,32+idSpett,...roomInfoFields]`, poi roster giocatori e SpectatorInfo 0x7501 (forma lunga = entra, corta = esce).
- Modalita' stanza: il client 22 manda `52, 1, 0, X` con X = modalita' (Explosive 0, FFA 1); prima si leggeva payload[0] (sempre 1 = FFA).
- UI client: nessun pulsante visibile in lista. In FUN_0051f550 (UI lista stanze) ci sono "Enter Btn" e "Observer Btn" subito prima del caricamento di `UISRoomPW.xml`: con ogni probabilita' sono nel dialogo password che compare cliccando una stanza con password (FUN_0051eec0 apre "PW Edit"). Handler del pulsante Observer = FUN_0051f2f0 -> FUN_0051ee80 -> 0x7330. Da verificare: creare una stanza con password e cliccarla da GM.
- Spettatore VERIFICATO live (client 22): `/spectate <id>` entra e vede la partita. Il client spettatore manda GET_MISSION (402) dallo slot 32+id: va risposto (403) o crasha (EIP 0x6c3696, lettura fuori limite in codice geometrico). Dopo la partita i giocatori devono ricevere SpectatorInfo e mandare i frame UDP anche allo spettatore (slot 32+id) - i bot lo fanno leggendo 0x7501. Pulsante "Observer Btn" (FUN_0051f550, lista stanze alternativa): condizione NON trovata (non e' il tipo server 65..70: il client nasconde il server). Bot-only: `BOT_FLAT=1 BOT_MELEE=0 BOT_SPAWN_AFTER_MS=4000`, comandi bot `map <n>`, `mode <n>`.
- Auth server: la voce del game server sparisce dalla lista alla disconnessione (prima restavano 16 "Spain" vecchi).

### P.3 Oggetti a terra e artiglieria (2026-11-06) - VERIFICATI nel client 22 (mine, medic box)
- 400 PlaceItemOnGround / 401 UseItemOnGround: payload client 22 (23 campi, il codice e' l'ultimo; il riferimento ne ha 28 e lo legge a [27]). Layout da FUN_00469a90: [0]=byte, [1]=1, [2]=item+0x20, **[3]=slot del giocatore che agisce**, [4]=id oggetto (assegnato dal server nella risposta al 400), [5]=tipo (0 medic box, 1 ammo box, 2 mina), **[6]=salute applicata (risposta del server, al giocatore in [3])**, [14..19]=x,y,z + 3 float, [22]=codice (DU02 mina, DV01 medic box, DU01 ammo box, DS05 flash mine).
- Il gestore client della risposta 401 scrive [6] sulla salute dello slot in [3] se coincide col proprio: un bot che mandava [3]=0 colpiva il giocatore 0. Il server ora impone [3]=player.slot e manda la variante con [6]=0 agli altri client.
- Il client non rimanda un medic box finche' non riceve la risposta alla precedente (flag DAT_00b71b7e, azzerato in FUN_004e2xxx): ogni 401 va sempre risposto, anche per oggetti sconosciuti. Un flag rimasto acceso da una sessione senza risposta richiede riavvio del client (o `mov byte:[b71b7e], 0` in x32dbg).
- Mina DU02: colpisce solo i nemici (non proprietario, non compagni se non FFA). Il bot piazza (`mine [n]`) e calpesta le mine nemiche.
- Artiglieria 159: implementata come il riferimento (richiede DX01), non provata dal vivo.
- Artiglieria 159 VERIFICATA nel client 22: Telescopio DX01 (Cecchino, slot 6), solo mappe Thamugadi/Engrene/Ohara/Crater (`m_Bombadment_9` altrove), servono >=30 s dall'ultimo uso e un bersaglio a distanza valida non amico; si avanza premendo ripetutamente il tasto di FUN_004d1c60 (`DAT_00b65df0`, default 0x20 = spazio) con il Telescopio in mano. Sequenza: 159 con payload[2]=0 e target in [14..16] -> il server risponde payload[3]=1 -> countdown ~11 s -> tre 159 con payload[2]=2 (colpi, target in [14..16], origine in [17..19]) anch'essi ripetuti ai client con [3]=1. Il server non applica danni (come il riferimento).
- Comando GM `/start` (avvia la partita della propria stanza). Script x32dbg: `tools/client22/x32dbg-artillery.txt`, `x32dbg-health.txt`, `x32dbg-spectate.txt`.
- Messaggi client dell'artiglieria (x32dbg, FUN_005e0410): "Requesting artillery support." -> (159 flag 0) -> "Set target." + coordinate -> "Commence firing !" -> tre 159 flag 2 -> "Reloading 105MM Cannon." (ricarica 30 s). La risposta del server (payload[3]=1) e' sufficiente.
