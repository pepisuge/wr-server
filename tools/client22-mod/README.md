# Client 22 clan mod

Adds the clan system to the War Rock client 22 for this server:

- the lobby **TRAINING** button becomes **CLAN** and opens the clan page of the website in a client-style window (title bar, close box, drag), already signed in (single sign-on from the game login);
- clan emblems in the lobby user list and in rooms come from the server, change without restarting the game, and fall back to a default emblem instead of a white box.

It is our own code and images plus a recipe of changes: no game file is distributed.

## Install (players)

1. Close the game. Unzip `warrock-clan-mod.zip` anywhere.
2. Run `install.cmd` and type the server's IP address (or `install.cmd 1.2.3.4`; a second argument sets the website port, default 8080). Windows asks for administrator rights: the game folder is under Program Files.

The installer:

- patches `system\WarRock.exe` (HackShield off, CRC checks skipped; the AhnLab servers are gone) - only if it is exactly the client 22 file, checked by SHA-256;
- relabels the button in `texture\UI\Menu_eng.dds` (an XOR of the changed blocks over your own file, checked before and after);
- copies `dinput8.dll` (the game loads it by itself), `dinput8.ini` (the clan page address), `Cland.jpg` and `Avata\DefaultClanMark.jpg`;
- points `login.warrock.net` at the server in the `hosts` file.

`uninstall.cmd` restores the original files and removes ours (the `hosts` line stays). The game folder can be changed with `-Game <folder>`: see `install.ps1`.

## Build (maintainers)

Needs the client 22 War Rock folder, Python with Pillow (`pip install pillow`) and [Zig 0.13](https://ziglang.org/download/) for the 32-bit DLL:

```
python tools/client22-mod/build.py --client "C:/Program Files (x86)/GamersFirst/War Rock" --zig path/to/zig.exe
```

Output: `tools/client22-mod/dist/` and `warrock-clan-mod.zip` (both git-ignored; publish the zip as a release asset).

## How it works

`dinput8.c` is a proxy DLL: the client imports `DINPUT8.dll`, so one in `system\` is loaded first; it forwards `DirectInput8Create` to the real one and patches the client in memory. Every patch checks the bytes it expects, so another client version is left alone. Addresses and findings: [docs/protocol/clans.md](../../docs/protocol/clans.md) and [connection.md](../../docs/protocol/connection.md) (sign-on token). Log: `%TEMP%\clanui.log`.
