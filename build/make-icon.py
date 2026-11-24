"""生成应用图标：深蓝圆角底 + 磁盘柱体 + 清理闪光。

按 4 倍尺寸绘制再缩小，得到平滑边缘；输出多尺寸 .ico 供 Windows 使用。
"""
import math
from PIL import Image, ImageDraw

S = 1024          # 绘制画布
SS = 4            # 超采样倍数
W = S * SS

BG_TOP = (16, 37, 60)
BG_BOT = (9, 20, 34)
RING = (46, 116, 190)
DISK_LIGHT = (126, 196, 255)
DISK_MID = (58, 138, 216)
DISK_DARK = (30, 82, 145)
SPARK = (255, 214, 120)
SPARK2 = (255, 240, 200)


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def vgrad(size, top, bot):
    img = Image.new('RGB', (1, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        d.point((0, y), tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return img.resize((size, size), Image.BILINEAR)


base = vgrad(W, BG_TOP, BG_BOT).convert('RGBA')

# 外圈细边，让图标在浅色背景上也有轮廓
d = ImageDraw.Draw(base)
d.rounded_rectangle([6 * SS, 6 * SS, W - 6 * SS, W - 6 * SS],
                    radius=220 * SS, outline=RING + (110,), width=5 * SS)

# ---- 磁盘柱体（三层椭圆叠加模拟 3D）----
cx = W // 2
top_y, bot_y = 320 * SS, 700 * SS
rx, ry = 250 * SS, 92 * SS

d.ellipse([cx - rx, bot_y - ry, cx + rx, bot_y + ry], fill=DISK_DARK)
d.rectangle([cx - rx, top_y, cx + rx, bot_y], fill=DISK_MID)
d.ellipse([cx - rx, top_y - ry, cx + rx, top_y + ry], fill=DISK_LIGHT)

# 顶面内圈
irx, iry = 178 * SS, 64 * SS
d.ellipse([cx - irx, top_y - iry, cx + irx, top_y + iry], fill=DISK_MID)
d.ellipse([cx - irx, top_y - iry, cx + irx, top_y + iry],
          outline=DISK_LIGHT + (150,), width=6 * SS)

# 柱体上的高光条
d.arc([cx - rx, top_y - ry, cx + rx, top_y + ry], 200, 340,
      fill=(180, 225, 255, 190), width=14 * SS)

# ---- 清理闪光（右上）----
def sparkle(draw, x, y, r, inner, color, glow):
    pts = []
    for i in range(4):
        a = math.pi / 2 * i - math.pi / 2
        a2 = a + math.pi / 4
        pts.append((x + r * math.cos(a), y + r * math.sin(a)))
        pts.append((x + inner * math.cos(a2), y + inner * math.sin(a2)))
    draw.polygon(pts, fill=color)
    if glow:
        draw.ellipse([x - inner * 0.42, y - inner * 0.42,
                      x + inner * 0.42, y + inner * 0.42], fill=SPARK2)


sparkle(d, 800 * SS, 250 * SS, 118 * SS, 36 * SS, SPARK + (255,), True)
sparkle(d, 884 * SS, 396 * SS, 52 * SS, 16 * SS, SPARK + (220,), False)

# ---- 左上角对勾：表示"已完成清理"（避开磁盘主体，不打断柱体轮廓）----
bx, by = 236 * SS, 268 * SS
d.ellipse([bx - 78 * SS, by - 78 * SS, bx + 78 * SS, by + 78 * SS],
          fill=(38, 148, 104, 255), outline=(150, 240, 200, 210), width=7 * SS)
d.line([bx - 38 * SS, by + 2 * SS, bx - 10 * SS, by + 30 * SS, bx + 40 * SS, by - 30 * SS],
       fill=(240, 255, 248, 255), width=17 * SS, joint='curve')

icon = base.resize((S, S), Image.LANCZOS)
icon.putalpha(rounded_mask(S, 220))

sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]
icon.save('D:/shiyan/clearCD/build/icon.ico', format='ICO', sizes=sizes)
icon.resize((512, 512), Image.LANCZOS).save('D:/shiyan/clearCD/build/icon.png')

print('icon.ico / icon.png written')
