# -*- coding: utf-8 -*-
"""生成模组预览图 preview.jpg（1280x720，市场要求 PNG/JPG/WebP，≤1 MB）。"""
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ai-eq", "preview.jpg")
W, H = 1280, 720

FONT_DIR = r"C:\Windows\Fonts"
BOLD_CANDIDATES = ["msyhbd.ttc", "msyh.ttc", "simhei.ttf", "arialbd.ttf"]
REGULAR_CANDIDATES = ["msyh.ttc", "simhei.ttf", "arial.ttf"]


def pick_font(candidates):
    for name in candidates:
        path = os.path.join(FONT_DIR, name)
        if os.path.exists(path):
            return path
    return None


BOLD = pick_font(BOLD_CANDIDATES)
REGULAR = pick_font(REGULAR_CANDIDATES)


def font(size, bold=False):
    path = BOLD if bold else REGULAR
    if path:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default()


def vertical_gradient(size, top, bottom):
    image = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(image)
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        draw.line([(0, y), (size[0], y)], fill=color)
    return image


def rounded(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def chip(draw, x, y, text, fnt, fg, bg, border, pad_x=10, pad_y=4):
    box = draw.textbbox((0, 0), text, font=fnt)
    width = box[2] - box[0] + pad_x * 2
    height = box[3] - box[1] + pad_y * 2
    rounded(draw, [x, y, x + width, y + height], height // 2, fill=bg, outline=border, width=1)
    draw.text((x + pad_x, y + pad_y - 1), text, font=fnt, fill=fg)
    return width + 8


def make():
    image = vertical_gradient((W, H), (10, 14, 22), (22, 29, 45))
    draw = ImageDraw.Draw(image)

    glow = Image.new("RGB", (W, H), (10, 14, 22))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse([140, 20, 1140, 620], fill=(31, 58, 110))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    image = Image.blend(image, glow, 0.45)
    draw = ImageDraw.Draw(image)

    # 顶部徽标
    badge_font = font(17, bold=True)
    badge_text = "FOLIUM MOD  ·  AI EQ 2.1  ·  歌曲简报 + 智能 EQ"
    bbox = draw.textbbox((0, 0), badge_text, font=badge_font)
    badge_w = bbox[2] - bbox[0] + 36
    rounded(draw, [66, 44, 66 + badge_w, 82], 19, fill=(22, 34, 58), outline=(64, 96, 158), width=1)
    draw.text((66 + 18, 53), badge_text, font=badge_font, fill=(139, 178, 255))

    # 标题
    draw.text((64, 100), "AI 智能 EQ", font=font(60, bold=True), fill=(240, 245, 255))
    draw.text((66, 180), "读整首歌词，写出歌曲简报，再给这首歌一条均衡器曲线", font=font(24), fill=(150, 166, 194))

    # 主面板
    rounded(draw, [64, 236, 1216, 636], 26, fill=(16, 22, 35), outline=(44, 58, 88), width=2)

    # ---- 左：歌曲简报
    draw.text((96, 262), "歌曲简报", font=font(17, bold=True), fill=(130, 150, 185))
    draw.text((96, 290), "晴天 — 周杰伦", font=font(30, bold=True), fill=(238, 244, 255))

    summary_font = font(20, bold=True)
    draw.text((96, 340), "夏日海边的告白，轻盈里带一点怀旧", font=summary_font, fill=(214, 226, 246))

    chip_font = font(15)
    chip_fg = (196, 212, 240)
    chip_bg = (27, 37, 58)
    chip_border = (52, 70, 104)

    def chip_row(label, items, y):
        draw.text((96, y + 4), label, font=font(14), fill=(120, 138, 170))
        x = 96 + 76
        for item in items:
            x += chip(draw, x, y, item, chip_font, chip_fg, chip_bg, chip_border)

    chip_row("情绪", ["轻快", "怀旧"], 386)
    chip_row("标签", ["City Pop", "80s 华语", "女声"], 424)
    chip_row("意象", ["海边", "霓虹", "夏夜"], 462)

    # 能量起伏
    draw.text((96, 512), "能量起伏", font=font(14), fill=(120, 138, 170))
    energy = [0.18, 0.55, 0.92, 0.74, 0.4]
    base_y = 596
    for index, value in enumerate(energy):
        x0 = 96 + index * 54
        height = max(6, int(value * 72))
        rounded(draw, [x0, base_y - height, x0 + 40, base_y], 6, fill=(94, 142, 245))
    draw.text((96 + 5 * 54 + 8, base_y - 26), "好评已记下 · 口味学习", font=font(15, bold=True), fill=(120, 230, 190))

    # 分隔线
    draw.line([(650, 268), (650, 604)], fill=(42, 56, 84), width=2)

    # ---- 右：AI 曲线
    draw.text((686, 244), "AI 曲线（10 段）", font=font(17, bold=True), fill=(130, 150, 185))
    curve = [3.0, 1.5, 0.0, -1.0, -2.0, -1.0, 0.0, 1.5, 2.5, 3.5]
    freqs = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"]
    left, right = 690, 1180
    baseline = 470
    max_db = 6.0
    slot = (right - left) / len(curve)
    bar_w = slot * 0.52
    track_top = 300
    track_bottom = 560
    db_font = font(14, bold=True)
    hz_font = font(13)

    for index, value in enumerate(curve):
        center = left + slot * (index + 0.5)
        x0 = center - bar_w / 2
        x1 = center + bar_w / 2
        rounded(draw, [x0, track_top, x1, track_bottom], 8, fill=(25, 33, 50))
        height = max(6, abs(value) / max_db * (baseline - track_top - 8))
        if value >= 0:
            box = [x0, baseline - height, x1, baseline]
            color = (94, 142, 245)
        else:
            box = [x0, baseline, x1, baseline + height]
            color = (86, 108, 158)
        rounded(draw, box, 8, fill=color)
        label = ("+%.1f" % value) if value > 0 else ("%.1f" % value) if value < 0 else "0"
        tb = draw.textbbox((0, 0), label, font=db_font)
        draw.text((center - (tb[2] - tb[0]) / 2, track_top - 24), label, font=db_font, fill=(214, 226, 246))
        fb = draw.textbbox((0, 0), freqs[index], font=hz_font)
        draw.text((center - (fb[2] - fb[0]) / 2, track_bottom + 6), freqs[index], font=hz_font, fill=(120, 136, 164))

    draw.line([(left, baseline), (right, baseline)], fill=(58, 74, 106), width=2)

    # 花费 / 记忆
    draw.text((686, 584), "本曲 1 次 · 1,200 tokens · ¥0.0036", font=font(15), fill=(160, 176, 204))
    draw.text((686, 608), "累计 12 次 · 14,800 tokens · ¥0.041", font=font(15), fill=(120, 138, 170))
    draw.text((1000, 608), "听过的歌不再调用 AI", font=font(15, bold=True), fill=(120, 230, 190))

    # 底部
    draw.text((66, 662), "整首歌词  ·  歌曲简报  ·  每首记忆  ·  好评/差评 口味学习  ·  进度条按钮 · token 与花费统计",
              font=font(19), fill=(130, 148, 178))
    footer = "Folia 0.7.22+  ·  Folium 1.7+  ·  仅桌面版"
    fb = draw.textbbox((0, 0), footer, font=font(16))
    draw.text((1214 - (fb[2] - fb[0]), 664), footer, font=font(16), fill=(96, 110, 138))

    image.save(OUT, "JPEG", quality=92, optimize=True)
    print("saved", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    make()



