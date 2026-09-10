#!/usr/bin/env python3
"""设计稿 → 扩展图标（透明底）

把设计师给的**白底方形**设计稿抠成透明 PNG，产出：

    resources/icon.png       256×256
    resources/icon@512.png   512×512

为什么要抠底
    白底方图在深色主题下会渲染成一个刺眼的白方块（列表页、详情页都会）。

为什么用洪水填充，而不是「把所有白色变透明」
    鲸鱼的肚子、眼睛高光、靶心内环本身就是白色 / 近白色。
    按颜色抠会把它们一起抠穿 —— 实测中心区有 89px 会被误伤（肚子破洞）。
    洪水填充只吃掉「从画布四边连通出去的白」；肚子被蓝色轮廓封死，所以安全。

为什么源图只有 128px 也能用
    这是纯色扁平插画，不是照片。用 LANCZOS 放大 + 轻度 USM 锐化后
    边缘依然干净；代价是 4× 放大（512）会略软，属于可接受范围。

边缘为什么要「反解颜色」而不只是切断 alpha
    源图的描边像素是「蓝 × a + 白 × (1-a)」的混合色。
    若原样保留再给个半透明 alpha，深色主题下会显出一圈**白晕**（实测占边缘 47%）。
    所以边缘带要反解回真彩色：C = (P - 255·(1-a)) / a。

用法
    python3 tools/icon-from-design.py design/icon-source.png

产物会**直接覆盖** resources/ 下两个图标文件（旧版本走 git 找回）。
"""

from __future__ import annotations

import hashlib
import pathlib
import sys
from collections import deque

from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent

# 输出目标：(相对路径, 边长)
TARGETS = [("resources/icon.png", 256), ("resources/icon@512.png", 512)]

# 「算作背景白」的容差。18 足够吃掉白底与它的羽化边，又不会碰鲸鱼身上的浅蓝。
TOL = 18

# 源图只有 128px，放大后补一点锐度；threshold 抬高避免把纯色区放大成噪点。
SHARPEN = dict(radius=1.2, percent=45, threshold=2)

# 边缘带宽度（像素，按输出尺寸算）：这条带上按颜色反解 alpha，其余硬判。
# 太窄 → 锯齿；太宽 → 主体轮廓最外圈会被误判成半透明。
BAND = 2

# 调色板量化色数。源图是纯色扁平插画，量化到 256 色后视觉无差
# （实测色差 1.9/255，alpha 差 0.14/255），体积却从 110KB 降到 45KB。设 0 关闭。
QUANTIZE = 256


def _clamp(v: float) -> int:
    """把反解出的通道值夹回 0–255（浮点误差会让它略超界）。"""
    return 0 if v < 0 else (255 if v > 255 else int(v + 0.5))


def background_mask(im: Image.Image) -> tuple[bytearray, int, int]:
    """从四边洪水填充，返回「属于背景」的位图。

    只处理与画布边缘连通的近白像素；被主体包围的白（肚子、眼睛、靶环）
    不会命中。
    """
    w, h = im.size
    px = im.load()

    def is_bg(c: tuple[int, int, int]) -> bool:
        return c[0] > 255 - TOL and c[1] > 255 - TOL and c[2] > 255 - TOL

    seen = bytearray(w * h)
    queue: deque[tuple[int, int]] = deque()

    for sx, sy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        i = sy * w + sx
        if not seen[i] and is_bg(px[sx, sy]):
            seen[i] = 1
            queue.append((sx, sy))

    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h:
                i = ny * w + nx
                if not seen[i] and is_bg(px[nx, ny]):
                    seen[i] = 1
                    queue.append((nx, ny))

    return seen, w, h


def build(src: pathlib.Path) -> list[tuple[str, int]]:
    """生成全部尺寸，返回 (相对路径, 边长) 列表。"""
    raw = Image.open(src)
    if raw.mode == "RGBA" and raw.getchannel("A").getextrema()[0] < 255:
        print(f"  注意：{src.name} 已带透明通道，仍会重算边缘")

    src_rgb = raw.convert("RGB")
    if src_rgb.width != src_rgb.height:
        print(f"  注意：源图非正方形（{src_rgb.width}×{src_rgb.height}），将拉伸为正方形")

    written: list[tuple[str, int]] = []
    for rel, size in TARGETS:
        # 1) 放大到目标尺寸（源图远小于此，靠 LANCZOS 平滑放大）
        rgb = src_rgb.resize((size, size), Image.LANCZOS)
        # 2) 放大后补锐度，否则 4× 放大看起来发糊
        rgb = rgb.filter(ImageFilter.UnsharpMask(**SHARPEN))
        # 3) 在目标分辨率上算背景，比在低分辨率上算再放大更贴合边缘
        seen, w, h = background_mask(rgb)

        mask = Image.new("L", (w, h), 255)
        mp = mask.load()
        for y in range(h):
            base = y * w
            for x in range(w):
                if seen[base + x]:
                    mp[x, y] = 0

        # 4) 形态学腐蚀 / 膨胀，把画面切成三带：
        #    核内 → 直接不透明；边缘带 → 按颜色反解；外部 → 直接透明
        core = mask.filter(ImageFilter.MinFilter(2 * BAND + 1))
        halo = mask.filter(ImageFilter.MaxFilter(2 * BAND + 1))
        cp, hp = core.load(), halo.load()

        # 5) 主体里最深的蓝。边缘带上的像素都是「这个颜色 × a + 白 × (1-a)」
        px = rgb.load()
        mins = [min(px[x, y]) for y in range(0, h, 2) for x in range(0, w, 2) if cp[x, y] == 255]
        c_min = sorted(mins)[len(mins) // 50] if mins else 0  # 2% 分位，抗噪
        span = max(255 - c_min, 1)

        # 6) 逐像素定 alpha，并把被白底冲淡的颜色反解回来
        out = rgb.convert("RGBA")
        op = out.load()
        ramp = 0
        for y in range(h):
            base = y * w
            for x in range(w):
                r, g, b = px[x, y]
                if cp[x, y] == 255:
                    op[x, y] = (r, g, b, 255)
                    continue
                if hp[x, y] == 0:
                    op[x, y] = (r, g, b, 0)
                    continue
                a = (255 - min(r, g, b)) / span
                a = 0.0 if a < 0 else (1.0 if a > 1 else a)
                if a <= 0.004:
                    op[x, y] = (r, g, b, 0)
                    continue
                inv = 255 * (1 - a)
                op[x, y] = (
                    _clamp((r - inv) / a),
                    _clamp((g - inv) / a),
                    _clamp((b - inv) / a),
                    int(a * 255 + 0.5),
                )
                ramp += 1

        dest = ROOT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if QUANTIZE:
            out = out.quantize(colors=QUANTIZE, method=Image.FASTOCTREE).convert("RGBA")
        out.save(dest, "PNG", optimize=True)

        covered = sum(seen) / (w * h)
        written.append((rel, size))
        print(
            f"  {rel:26s} {size}×{size}  去底 {covered * 100:4.1f}%  "
            f"边缘带 {ramp}px  最深蓝 {c_min:>3}  {dest.stat().st_size:>6}B"
        )

    return written


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2

    src = pathlib.Path(argv[1]).expanduser().resolve()
    if not src.is_file():
        print(f"✗ 找不到设计稿：{src}")
        return 1

    digest = hashlib.md5(src.read_bytes()).hexdigest()[:12]
    print(f"══ 源稿 {src}")
    print(f"   md5(前12) {digest}")

    written = build(src)

    print("\n══ 结果 ══")
    for rel, size in written:
        im = Image.open(ROOT / rel)
        alpha_range = im.getchannel("A").getextrema()
        ok = "✅" if alpha_range[0] < 255 else "❌ 仍有不透明底"
        print(f"  {rel:26s} {im.size[0]}px  alpha {alpha_range}  {ok}")
    print("\n下一步：node tools/build.mjs public 重新打包")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
