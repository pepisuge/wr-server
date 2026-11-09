// Proxy dinput8.dll for WarRock client 22: the lobby TRAINING button (relabelled CLAN in Menu_eng.dds) opens the
// clan page in the game's embedded browser, inside a native window styled like the client's (title bar, X, drag).
// A second click on CLAN or the X closes it. Forwards DirectInput8Create to the real system DLL.
// URL from dinput8.ini next to the DLL ([clan] url=...).
#include <windows.h>
#include <string.h>

typedef HRESULT(WINAPI *DI8Create)(HINSTANCE, DWORD, const void *, void **, void *);
static DI8Create real;
static HMODULE self;
static WCHAR url[256];

// Client 22 addresses (see the RE notes): the same browser object and calls the client's own `/url` command uses.
#define BROWSER ((void *)0xb422b8)
#define BROWSER_OPEN (*(int *)(0xb422b8 + 0x30))
#define GAME_HWND (*(HWND *)0xb365e0)
#define TRAINING_CASE 0x45838e // menu click handler FUN_00458240, case 0: training->show(5) and hide the lobby
#define HANDLER_RETURN 0x4583c2 // that case's own "return 0" epilogue
typedef void(__thiscall *OpenFn)(void *, HWND, const WCHAR *, int, int, int, int);
typedef void(__thiscall *ThisFn)(void *);
typedef void(__fastcall *CloseFn)(void *);

static void logf(const char *msg) {
  char path[MAX_PATH];
  GetTempPathA(MAX_PATH, path); // the game folder is under Program Files, not writable
  lstrcatA(path, "clanui.log");
  HANDLE f = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ, NULL, OPEN_ALWAYS, 0, NULL);
  if (f == INVALID_HANDLE_VALUE) return;
  DWORD n;
  WriteFile(f, msg, lstrlenA(msg), &n, NULL);
  WriteFile(f, "\r\n", 2, &n, NULL);
  CloseHandle(f);
}

#define TITLE_H 28
static HWND frame; // our window around the browser; NULL when closed
static POINT grab;  // where the title bar was grabbed, while dragging
static char avatarUrl[300], markJpg[300], markCrc[300];

static void closeClan(void) {
  ((CloseFn)0x428230)(BROWSER);
  if (frame) DestroyWindow(frame);
  frame = NULL;
}

static void closeBox(HWND hwnd, RECT *box) {
  RECT r;
  GetClientRect(hwnd, &r);
  SetRect(box, r.right - 30, 5, r.right - 10, 23);
}

static void fill(HDC dc, int l, int t, int r, int b, COLORREF c) {
  RECT rc = {l, t, r, b};
  HBRUSH br = CreateSolidBrush(c);
  FillRect(dc, &rc, br);
  DeleteObject(br);
}

static void line(HDC dc, int x0, int y0, int x1, int y1, int width, COLORREF c) {
  HPEN pen = CreatePen(PS_SOLID, width, c), old = SelectObject(dc, pen);
  MoveToEx(dc, x0, y0, NULL);
  LineTo(dc, x1, y1);
  DeleteObject(SelectObject(dc, old));
}

// Colours sampled from the USERLIST window: light top edge, dark gradient bar, grey square close button.
static void paint(HWND hwnd) {
  PAINTSTRUCT ps;
  HDC dc = BeginPaint(hwnd, &ps);
  RECT r, box;
  GetClientRect(hwnd, &r);
  fill(dc, 0, 0, r.right, r.bottom, RGB(30, 34, 37));
  fill(dc, 0, 0, r.right, 1, RGB(95, 101, 101));
  fill(dc, 0, 1, r.right, 2, RGB(146, 146, 146));
  for (int y = 2; y < TITLE_H; y++) {
    int v = 122 - (122 - 25) * (y - 2) / (TITLE_H - 3);
    fill(dc, 0, y, r.right, y + 1, RGB(v, v, v));
  }
  fill(dc, 0, TITLE_H, r.right, TITLE_H + 1, RGB(100, 101, 103));
  HFONT font = CreateFontA(-15, 0, 0, 0, FW_BOLD, 0, 0, 0, ANSI_CHARSET, 0, 0, ANTIALIASED_QUALITY, 0, "Arial");
  HGDIOBJ oldFont = SelectObject(dc, font);
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, RGB(240, 240, 240));
  TextOutA(dc, 16, 6, "CLAN", 4);
  DeleteObject(SelectObject(dc, oldFont));
  closeBox(hwnd, &box);
  fill(dc, box.left, box.top, box.right, box.bottom, RGB(18, 18, 18));
  fill(dc, box.left + 1, box.top + 1, box.right - 1, box.bottom - 1, RGB(113, 113, 113));
  fill(dc, box.left + 2, box.top + 2, box.right - 1, box.bottom - 1, RGB(74, 76, 75));
  line(dc, box.left + 6, box.top + 5, box.right - 7, box.bottom - 6, 3, RGB(25, 25, 25));
  line(dc, box.right - 7, box.top + 5, box.left + 6, box.bottom - 6, 3, RGB(25, 25, 25));
  EndPaint(hwnd, &ps);
}

static LRESULT CALLBACK frameProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  RECT box;
  POINT pt;
  switch (msg) {
  case WM_PAINT:
    paint(hwnd);
    return 0;
  // Dragging by hand, not with HTCAPTION: Windows' own move loop is modal and stops the game from drawing
  // behind the window until the mouse is released.
  case WM_LBUTTONDOWN:
    pt.x = (short)LOWORD(lp);
    pt.y = (short)HIWORD(lp);
    closeBox(hwnd, &box);
    if (pt.y < TITLE_H && !PtInRect(&box, pt)) {
      grab = pt;
      SetCapture(hwnd);
    }
    return 0;
  case WM_MOUSEMOVE:
    if (GetCapture() == hwnd) {
      GetCursorPos(&pt);
      ScreenToClient(GetParent(hwnd), &pt);
      SetWindowPos(hwnd, NULL, pt.x - grab.x, pt.y - grab.y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
    return 0;
  case WM_LBUTTONUP:
    if (GetCapture() == hwnd) return ReleaseCapture(), 0;
    pt.x = (short)LOWORD(lp);
    pt.y = (short)HIWORD(lp);
    closeBox(hwnd, &box);
    if (PtInRect(&box, pt)) closeClan();
    return 0;
  }
  return DefWindowProcA(hwnd, msg, wp, lp);
}

// Single sign-on: the login server puts a 32-hex token in the login reply field client 22 keeps at 0x935028
// (upstream sends 'NULL' there); the site trades ?t=<token> for a session. No token: plain URL, site login.
static const WCHAR *signedUrl(void) {
  static WCHAR full[320];
  const char *t = (const char *)0x935028;
  int i = 0;
  while (i < 32 && ((t[i] >= '0' && t[i] <= '9') || (t[i] >= 'a' && t[i] <= 'f'))) i++;
  if (i != 32 || t[32] != 0) return url;
  wsprintfW(full, L"%s%st=%S", url, wcschr(url, L'?') ? L"&" : L"?", t);
  return full;
}

// Runs on the game thread (called from its menu click handler), so the frame's messages are pumped by the game.
// Toggle: reopening over an open browser leaks IE instances, which is what crashed `/close url` before.
static void __cdecl onClanClick(void) {
  if (frame || BROWSER_OPEN) return closeClan();
  static ATOM cls;
  if (!cls) {
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = frameProc;
    wc.hInstance = self;
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.lpszClassName = "ClanUIFrame";
    cls = RegisterClassA(&wc);
  }
  // Over the room list and user list (1024x768 layout, scaled to the real window): the left menu stays clickable.
  HWND game = GAME_HWND;
  RECT r;
  GetClientRect(game, &r);
  int gw = r.right ? r.right : 1024, gh = r.bottom ? r.bottom : 768;
  int x = 212 * gw / 1024, y = 62 * gh / 768, w = 800 * gw / 1024, h = 644 * gh / 768;
  // Keep the game's Direct3D frames from painting over our window.
  SetWindowLongA(game, GWL_STYLE, GetWindowLongA(game, GWL_STYLE) | WS_CLIPCHILDREN);
  frame = CreateWindowExA(0, "ClanUIFrame", "CLAN", WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS, x, y, w, h, game, NULL, self, NULL);
  if (!frame) return logf("frame window not created");
  SetWindowRgn(frame, CreateRoundRectRgn(0, 0, w + 1, h + 20, 14, 14), TRUE); // rounded top corners only
  // The client's browser call takes any parent window; x/y are relative to it.
  ((OpenFn)0x4284f0)(BROWSER, frame, signedUrl(), 4, TITLE_H + 3, w - 8, h - TITLE_H - 7);
  ((ThisFn)0x428180)(BROWSER);
}

static void loadUrl(void) {
  char ini[MAX_PATH], a[256];
  GetModuleFileNameA(self, ini, MAX_PATH);
  lstrcpyA(ini + lstrlenA(ini) - 4, ".ini"); // dinput8.dll -> dinput8.ini
  GetPrivateProfileStringA("clan", "url", "http://127.0.0.1:8080/clan", a, sizeof a, ini);
  MultiByteToWideChar(CP_ACP, 0, a, -1, url, 256);
  logf(a);
  // Clan emblems come from the same server: scheme://host[:port] of the clan URL + the path the client expects.
  char *host = strstr(a, "://"), *slash = host ? strchr(host + 3, '/') : NULL;
  if (slash) *slash = 0;
  lstrcpyA(avatarUrl, a);
  lstrcatA(avatarUrl, "/ClanAvatar.aspx?Clan=%s");
  lstrcpyA(markJpg, a);
  lstrcatA(markJpg, "/avatar/%d.jpg");
  lstrcpyA(markCrc, a);
  lstrcatA(markCrc, "/avatar/%d.crc");
}

// Point a `push imm32` at our string, if it still pushes `expected` (another exe is left alone).
static int repoint(DWORD at, DWORD expected, const char *to) {
  unsigned char *p = (unsigned char *)at;
  if (IsBadReadPtr(p, 5) || p[0] != 0x68 || *(DWORD *)(p + 1) != expected) return 0;
  DWORD old;
  if (!VirtualProtect(p, 5, PAGE_EXECUTE_READWRITE, &old)) return 0;
  *(DWORD *)(p + 1) = (DWORD)to;
  VirtualProtect(p, 5, old, &old);
  FlushInstructionCache(GetCurrentProcess(), p, 5);
  return 1;
}

// Lobby user list clan emblems by clan id (loader 0x4cdb30): <id>.crc then <id>.jpg from avatar.warrock.net
// (and its qatest twin). Redirected to our server; on failure the client uses texture/Avata/DefaultClanMark.jpg.
static void hookClanMarks(void) {
  int n = repoint(0x4cd8b6, 0x8c8bd4, markJpg) + repoint(0x4cd8c2, 0x8c8bac, markJpg) +
          repoint(0x4cd956, 0x8c8c38, markCrc) + repoint(0x4cd965, 0x8c8c10, markCrc);
  logf(n == 4 ? "clan marks hooked" : "clan mark code not found, not hooked");
}

// The emblem download (0x4cd620) pushes the address of "http://ops.warrock.net/ClanAvatar.aspx?Clan=%s": point that
// push at our URL. Without a reachable emblem and with no DefaultClanMark.jpg shipped, the client drew a white box.
static void hookAvatar(void) {
  unsigned char *p = (unsigned char *)0x4cd620;
  if (IsBadReadPtr(p, 5) || p[0] != 0x68 || *(DWORD *)(p + 1) != 0x8c8b5c) return logf("emblem code not found, not hooked");
  DWORD old;
  if (!VirtualProtect(p, 5, PAGE_EXECUTE_READWRITE, &old)) return;
  *(DWORD *)(p + 1) = (DWORD)avatarUrl;
  VirtualProtect(p, 5, old, &old);
  FlushInstructionCache(GetCurrentProcess(), p, 5);
  logf(avatarUrl);
}

// CALL onClanClick; JMP HANDLER_RETURN over the case-0 body. Bytes checked first, so another exe is left alone.
static void hookTraining(void) {
  unsigned char *p = (unsigned char *)TRAINING_CASE;
  static const unsigned char expect[] = {0x8b, 0x0d, 0x40, 0x35, 0xdf, 0x00}; // mov ecx, [0xdf3540] (training window)
  if (IsBadReadPtr(p, 10) || memcmp(p, expect, sizeof expect) != 0) return logf("training click code not found: different exe, not hooked");
  DWORD old;
  if (!VirtualProtect(p, 10, PAGE_EXECUTE_READWRITE, &old)) return logf("VirtualProtect failed");
  p[0] = 0xe8;
  *(int *)(p + 1) = (int)onClanClick - (int)(p + 5);
  p[5] = 0xe9;
  *(int *)(p + 6) = HANDLER_RETURN - (int)(p + 10);
  VirtualProtect(p, 10, old, &old);
  FlushInstructionCache(GetCurrentProcess(), p, 10);
  logf("training button hooked");
}

// Emblem refresh without restarting the game. The client loads emblem files through a texture manager
// (0x6f51b0, thiscall: this, a, path) that caches by file name, and a clan's file is always Avata/<id>.jpg: a new
// emblem downloaded mid-session never showed. For "<digits>.jpg" with a "<digits>.crc" next to it (the version the
// client just checked against the server) we load a copy named "<digits>_<crc>.jpg" instead, so each version is new.
typedef int(__thiscall *LoadFn)(void *, void *, const char *);
#define LOAD_TEXTURE ((LoadFn)0x6f51b0)

static int __fastcall loadEmblem(void *mgr, void *edx, void *a, const char *path) {
  char crcPath[MAX_PATH], crc[40] = {0}, versioned[MAX_PATH + 40];
  int n = lstrlenA(path), i = n - 4;
  if (n < 6 || n >= MAX_PATH || lstrcmpiA(path + i, ".jpg") != 0) return LOAD_TEXTURE(mgr, a, path);
  while (i > 0 && path[i - 1] >= '0' && path[i - 1] <= '9') i--;
  if (i == n - 4 || (path[i - 1] != '/' && path[i - 1] != '\\')) return LOAD_TEXTURE(mgr, a, path); // not <digits>.jpg
  lstrcpyA(crcPath, path);
  lstrcpyA(crcPath + n - 4, ".crc");
  HANDLE f = CreateFileA(crcPath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  DWORD got = 0;
  if (f != INVALID_HANDLE_VALUE) {
    ReadFile(f, crc, 32, &got, NULL);
    CloseHandle(f);
  }
  for (DWORD k = 0; k < got; k++)
    if (!((crc[k] >= '0' && crc[k] <= '9') || (crc[k] >= 'a' && crc[k] <= 'f'))) got = 0;
  if (got < 8) return LOAD_TEXTURE(mgr, a, path);
  crc[8] = 0;
  lstrcpynA(versioned, path, n - 3); // without ".jpg"
  lstrcatA(versioned, "_");
  lstrcatA(versioned, crc);
  lstrcatA(versioned, ".jpg");
  CopyFileA(path, versioned, TRUE); // TRUE: keep an existing copy of this version
  return LOAD_TEXTURE(mgr, a, GetFileAttributesA(versioned) != INVALID_FILE_ATTRIBUTES ? versioned : path);
}

static void hookEmblemLoads(void) {
  static const DWORD sites[] = {0x4cdc31, 0x4cdcec, 0x4cddc3, 0x4cd67d, 0x4cd6eb};
  int n = 0;
  for (int i = 0; i < 5; i++) {
    unsigned char *p = (unsigned char *)sites[i];
    if (IsBadReadPtr(p, 5) || p[0] != 0xe8 || (DWORD)(p + 5) + *(int *)(p + 1) != 0x6f51b0) continue;
    DWORD old;
    if (!VirtualProtect(p, 5, PAGE_EXECUTE_READWRITE, &old)) continue;
    *(int *)(p + 1) = (int)loadEmblem - (int)(p + 5);
    VirtualProtect(p, 5, old, &old);
    FlushInstructionCache(GetCurrentProcess(), p, 5);
    n++;
  }
  logf(n == 5 ? "emblem loads hooked" : "emblem load code not found, not hooked");
}

__declspec(dllexport) HRESULT WINAPI DirectInput8Create(HINSTANCE h, DWORD v, const void *riid, void **out, void *outer) {
  if (!real) {
    char path[MAX_PATH];
    GetSystemDirectoryA(path, MAX_PATH);
    lstrcatA(path, "\\dinput8.dll");
    real = (DI8Create)GetProcAddress(LoadLibraryA(path), "DirectInput8Create");
  }
  return real ? real(h, v, riid, out, outer) : E_FAIL;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved) {
  if (reason == DLL_PROCESS_ATTACH) {
    self = inst;
    DisableThreadLibraryCalls(inst);
    logf("clanui loaded");
    loadUrl();
    hookTraining();
    hookAvatar();
    hookClanMarks();
    hookEmblemLoads();
  }
  return TRUE;
}
