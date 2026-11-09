"""Build the client 22 mod package from this source and the maintainer's own War Rock client.

    python tools/client22-mod/build.py --client "C:/Program Files (x86)/GamersFirst/War Rock" [--zig path/to/zig]

Output: tools/client22-mod/dist/ (and a .zip of it): dinput8.dll built from dinput8.c, our own emblem images,
patches.json and the installer. No game file is copied: the executable patches are a few instruction bytes, and the
menu texture ships as an XOR of the changed blocks, useless without the player's original file (the installer checks
its SHA-256 before and after). Needs Pillow (pip install pillow) and Zig 0.13 (https://ziglang.org) on PATH or --zig.
"""
import argparse, base64, hashlib, json, os, shutil, subprocess, sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

# Client 22 WarRock.exe as shipped, and after the patches below (verified against the running test client).
EXE_SHA = '3dccd571f57cbae838b17b0e558b97ed834532db2d27a11be4fcd6476b5d8d35'
EXE_PATCHES = [  # (file offset, original bytes, new bytes, why)
    (0x1c5ac0, '568bf1', 'b001c3', 'HackShield update: return 1 (AhnLab servers are gone)'),
    (0x1c5b10, '8b4424', 'c20c00', 'HackShield monitoring: no-op'),
    (0x1c5df0, '538a5c2408', 'b001c20400', 'HackShield start/stop wrapper: return 1'),
    (0x30ca11, '75', 'eb', 'file CRC list: skip "CRC Checksum Error"'),
    (0x30c83e, '75', 'eb', 'items.bin / weapondata / branch signature check'),
    (0xd4134, '74', 'eb', 'data load state check'),
    (0x424c9c, '558bec51c745fc00000000833d98', '8b44240450ff1558e58b00c20400', 'Direct3DCreate8 wrapper: call d3d8 directly (was routed through HackShield)'),
]
MENU = 'texture/UI/Menu_eng.dds'
MENU_SHA = '736233e04e21fa2cfc704f6389a6a0f5d7bd383cad2159606dd0e090b77519b1'
HOVER = 126  # the yellow (hover) column of the menu texture is the white one shifted right by 126 px


def sha(data):
    return hashlib.sha256(data).hexdigest()


def patched_exe(data):
    d = bytearray(data)
    for off, old, new, _ in EXE_PATCHES:
        assert d[off:off + len(bytes.fromhex(old))] == bytes.fromhex(old), hex(off)
        d[off:off + len(bytes.fromhex(new))] = bytes.fromhex(new)
    return bytes(d)


def clan_menu(src_path):
    """TRAINING row of the menu texture redrawn as CLAN: letters cut from the texture's own ITEM SHOP / TRAINING
    words (same font and antialiasing; C = the O of SHOP opened on the right, L = the E of ITEM without its arms)
    and a shield drawn inside the original icon ring. Returns the RGBA image."""
    im = Image.open(src_path).convert('RGBA')
    orig = im.copy()

    def glyph(dx, x0, x1, y_shift):  # ITEM SHOP sits 36 px above TRAINING
        return orig.crop((dx + x0, 146 - y_shift, dx + x1 + 1, 180 - y_shift))

    def letters(dx):
        c = glyph(dx, 100, 109, 36)
        for x in range(7, 10):
            for y in range(14, 18):
                c.putpixel((x, y), (0, 0, 0, 0))
        l = glyph(dx, 55, 63, 36)
        edge = l.getpixel((2, 12))
        for y in range(9, 20):
            if y >= 10:
                l.putpixel((2, y), edge)
            for x in range(3, 9):
                l.putpixel((x, y), (0, 0, 0, 0))
        return [(c, 0, 10), (l, 0, 8), (glyph(dx, 61, 70, 0), 0, 9), (glyph(dx, 75, 84, 0), 1, 8)]

    for dx, ring_cx in ((0, 17.75), (HOVER, 143.5)):
        ImageDraw.Draw(im).rectangle((dx + 38, 146, dx + 127, 179), fill=(0, 0, 0, 0))
        x = dx + 41
        for g, first, width in letters(dx):
            im.alpha_composite(g, (x - first, 146))
            x += width + 2
        S, R, cy = 8, 12.3, 162.5
        fill = max((orig.getpixel((x_, y_)) for x_ in range(dx + 40, dx + 110) for y_ in range(156, 168)), key=lambda p: (p[3], sum(p[:3])))
        layer = Image.new('RGBA', (32 * S, 32 * S), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        c = 16 * S
        d.ellipse((c - R * S, c - R * S, c + R * S, c + R * S), fill=(28, 28, 28, 255))
        d.polygon([(c - 6.5 * S, c - 7 * S), (c, c - 8.5 * S), (c + 6.5 * S, c - 7 * S), (c + 6.5 * S, c + 1.5 * S), (c, c + 8 * S), (c - 6.5 * S, c + 1.5 * S)], fill=fill)
        d.polygon([(c - 3 * S, c - 3.5 * S), (c + 3 * S, c - 3.5 * S), (c + 3 * S, c + 1 * S), (c, c + 4 * S), (c - 3 * S, c + 1 * S)], fill=(28, 28, 28, 255))
        mask = Image.new('L', (32 * S, 32 * S), 0)
        ImageDraw.Draw(mask).ellipse((c - R * S, c - R * S, c + R * S, c + R * S), fill=255)
        ox, oy = round(ring_cx - 16), round(cy - 16)
        base = im.crop((ox, oy, ox + 32, oy + 32))
        base.paste(layer.resize((32, 32), Image.LANCZOS), (0, 0), mask.resize((32, 32), Image.LANCZOS))
        im.paste(base, (ox, oy))
    # DXT3 shares two colours per 4x4 block: give see-through pixels the letter colour so compression doesn't
    # speckle dark pixels into the letters (alpha alone does the antialiasing).
    px = im.load()
    for dx, colour in ((0, (255, 255, 255)), (HOVER, orig.getpixel((HOVER + 100, 125))[:3])):
        for y in range(146, 180):
            for x in range(dx + 38, dx + 128):
                if px[x, y][3] < 255:
                    px[x, y] = colour + (px[x, y][3],)
    return im


def emblem(path):
    """Default clan mark (our own drawing): amber shield on graphite, 32x32 JPEG."""
    S, N = 8, 32
    im = Image.new('RGB', (N * S, N * S), (38, 39, 40))
    d = ImageDraw.Draw(im)
    for m, colour in ((4, (242, 176, 30)), (7, (38, 39, 40)), (10, (242, 176, 30))):
        d.polygon([(m * S, (m + 2) * S), (N / 2 * S, m * S), ((N - m) * S, (m + 2) * S), ((N - m) * S, N * 0.55 * S), (N / 2 * S, (N - m + 1) * S), (m * S, N * 0.55 * S)], fill=colour)
    im.resize((N, N), Image.LANCZOS).save(path, quality=95)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--client', required=True, help='War Rock client folder (client 22)')
    ap.add_argument('--zig', default='zig')
    a = ap.parse_args()
    out = os.path.join(HERE, 'dist')
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)

    # 1. our DLL
    subprocess.run([a.zig, 'cc', '-target', 'x86-windows-gnu', '-shared', '-O2', '-s', '-o', os.path.join(out, 'dinput8.dll'),
                    os.path.join(HERE, 'dinput8.c'), os.path.join(HERE, 'dinput8.def'), '-luser32', '-lgdi32'], check=True)
    os.remove(os.path.join(out, 'dinput8.lib'))  # import library Zig writes alongside, not needed

    # 2. executable patches, checked against the shipped exe hash
    exe = {'path': 'system/WarRock.exe', 'sha_original': EXE_SHA,
           'patches': [{'offset': o, 'original': old, 'new': new, 'why': why} for o, old, new, why in EXE_PATCHES]}
    exe_path = os.path.join(a.client, 'system', 'WarRock.exe')
    data = open(exe_path, 'rb').read()
    if sha(data) == EXE_SHA:
        exe['sha_patched'] = sha(patched_exe(data))
    else:
        exe['sha_patched'] = sha(data)  # the maintainer's exe is already patched: it must match the patches exactly
        assert data[EXE_PATCHES[0][0]:EXE_PATCHES[0][0] + 3] == bytes.fromhex('b001c3'), 'unknown WarRock.exe'

    # 3. menu texture: XOR of the changed block rows over the original
    menu_src = os.path.join(a.client, MENU + '.orig')
    if not os.path.exists(menu_src):
        menu_src = os.path.join(a.client, MENU)
    original = open(menu_src, 'rb').read()
    assert sha(original) == MENU_SHA, 'Menu_eng.dds is not the client 22 original'
    tmp = os.path.join(out, '_clan.dds')
    clan_menu(menu_src).save(tmp, pixel_format='DXT3')
    encoded = open(tmp, 'rb').read()
    os.remove(tmp)
    # 256 px wide DXT3: 128-byte header, then 64 blocks of 16 bytes per 4-pixel row
    start, end = 128 + 36 * 1024, 128 + 45 * 1024  # block rows 36-44 = y 144-179
    new = original[:start] + encoded[start:end] + original[end:]
    xor = bytes(x ^ y for x, y in zip(original[start:end], new[start:end]))
    menu = {'path': MENU, 'sha_original': MENU_SHA, 'sha_patched': sha(new), 'offset': start, 'xor': base64.b64encode(xor).decode()}

    json.dump({'exe': exe, 'menu': menu}, open(os.path.join(out, 'patches.json'), 'w'), indent=1)

    # 4. our images, installer, readme
    emblem(os.path.join(out, 'Cland.jpg'))
    shutil.copy(os.path.join(out, 'Cland.jpg'), os.path.join(out, 'DefaultClanMark.jpg'))
    for f in ('install.ps1', 'install.cmd', 'uninstall.cmd', 'README.md'):
        shutil.copy(os.path.join(HERE, f), out)
    zip_path = shutil.make_archive(os.path.join(HERE, 'warrock-clan-mod'), 'zip', out)
    print('built', out, '->', zip_path)


if __name__ == '__main__':
    sys.exit(main())
