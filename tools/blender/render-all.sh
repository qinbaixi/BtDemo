#!/bin/sh
# 渲染骑士全部外观（4 套皮肤 × 3 把武器）的动画表，放进 web/public/art/characters/knight/。
# 用法：tools/blender/render-all.sh [python 路径] [同时跑几个]
#   python 要装好 bpy 和 pillow（见 README.md）。一套约 190 帧，四核机器上全部跑完大约 20 分钟。
# 跑完后把输出目录里 knight.json 的内容更新到 web/public/art/manifest.json 的 characters.knight。
PYTHON=${1:-python}
JOBS=${2:-4}
cd "$(dirname "$0")/../.." || exit 1
OUT=web/public/art/characters/knight
mkdir -p "$OUT"
for skin in paladin obsidian gilded boneguard; do
  for sword in knight_sword blood_blade flame_greatsword; do
    echo "$skin $sword"
  done
done | xargs -P "$JOBS" -L 1 sh -c "\"$PYTHON\" tools/blender/knight.py sheet $OUT \$0 \$1 2>&1 | grep '^\\[knight\\]\\|Traceback\\|Error:' | grep -v 'strokes set empty'"
