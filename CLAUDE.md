# CLAUDE.md

## Progetto

Server privato per WarRock (FPS multiplayer del 2008), riscritto da zero in **Node.js puro** (CommonJS, niente TypeScript, niente bundler) usando come specifica un emulatore C#/.NET esistente, mantenuto dalla community — non decompilato.

## Struttura

- `node/` — il server vero e proprio, unico posto dove vive codice sorgente da modificare.
  - `auth-server.js` / `game-server.js` — entry point dei due processi (Authorization = login/lista server, Game = mondo di gioco). Due processi separati che si parlano su un canale interno, non uno solo.
  - `lib/` — framing/XOR dei pacchetti, pool DB, costanti condivise.
  - `auth/` — handler del login server.
  - `game/` — handler del game server, un modulo per area: `rooms`, `chat`, `clan`, `shop`, `inventory`, `items`, `progression` (livelli/XP/premium), `gm` (comandi da chat), `coupon`, `userlist`, `udp-handlers`, `equipment`...
  - `tools/fake-client.js` — client di test scriptabile da terminale: il gioco non permette due istanze reali, questo è il modo per simulare un secondo giocatore.
- `WarRock-Chapter-1-Server/` — il riferimento C# principale. È la specifica da leggere e tradurre, non va modificato.
- `WarRock-ToXiiC-Core/` — secondo riferimento C#, non tracciato in git. Alcune aree qui sono più complete che in Chapter-1-Server (es. i comandi GM) — quando i due divergono, va valutato caso per caso quale dei due è davvero cablato a qualcosa, non assunto a priori.
- `mariadb-portable/` — MariaDB portatile (binari + dati del database di sviluppo). **Non tracciato in git** (vedi `.gitignore`): è un runtime scaricato più lo stato di un database locale, non codice sorgente — va rigenerato estraendo MariaDB e ricaricando gli schemi da `WarRock-Chapter-1-Server/Databases/*.SQL`.

## Come si scrive il codice qui

- Skill **ponytail ultra** sempre attiva per qualunque modifica al codice: YAGNI estremo, diff più corti possibile, nessuna astrazione non richiesta, cancellare prima di aggiungere.
- Il C# di riferimento non è uniforme, e non lo è nemmeno *tra* i due riferimenti: un'area può essere uno scheletro in uno e completa nell'altro (i comandi GM sono l'esempio scoperto in questo progetto — 3 comandi morti in Chapter-1-Server, ~28 comandi reali e cablati a mutazioni DB in ToXiiC-Core). Prima di dichiarare un'area "da progettare da zero", controllare **entrambi** i riferimenti. Le aree confermate complete vanno **portate fedelmente** (login, stanze, inventario/shop, coupon, comandi GM): lì il lavoro è tradurre bene, non inventare. Altre sono scheletri mai davvero cablati a nulla in nessuno dei due — nome di un opcode, una tabella, un campo trasmesso sul filo, ma zero handler che lo usa (clan, clan war). In quel caso si progetta da zero riusando solo ciò che è reale, e **va dichiarato esplicitamente** — all'utente e nella guida — che quella parte non è un porting.
- Quando il C# e il comportamento osservato del client reale divergono, vince sempre la cattura reale contro il client vero, mai il codice C#.
- Ogni bug trovato durante un test va capito nella causa, non solo aggirato — e documentato nella guida (vedi sotto), non solo corretto in silenzio.

## La guida operativa

`Protocollo WarRock.md` è la guida di riferimento vivente del protocollo e del porting, pubblicata come Artifact:
https://claude.ai/code/artifact/557e7742-1a0a-4bc5-a483-a786d4c3c468

Va **allineata ad ogni fase o feature**, nello stesso stile stabilito fin dalla Fase 1: concetto spiegato, pacchetto reale catturato dai log, e — quando è successo — il bug trovato e come è stato diagnosticato. Aggiungere una fase non è una nota a margine: è quel documento che permette di riprendere il progetto da zero in una sessione futura senza dover rileggere l'intera cronologia della chat.

## Ambiente di sviluppo

- MariaDB portatile su `127.0.0.1:3306`, avviata manualmente (non un servizio Windows) — due database: `masterserver` (login) e `wres2` (gioco).
- Due processi da riavviare ad ogni modifica al codice server (dalla cartella `node/`): `node auth-server.js`, `node game-server.js`.
- Test senza un secondo client reale: `node tools/fake-client.js [username] [password]`, comandi interattivi da terminale (elenco aggiornato nel commento in testa al file).
- Account di test: `wruser`/`wruser2` (password `password123`, creati per questo progetto — `wruser` è l'account reso GM); `darkraptor`/`test` sono i due account seed originali del C#, password reale sconosciuta.
