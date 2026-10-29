# 前端：浏览器客户端

代码：`web/`（TypeScript + Vite），构建产物 `web/dist` 由 `web/embed.go` 嵌进服务端。

## 职责

服务端是权威，前端只做三件事：

1. 把键盘鼠标变成 `ClientMsg` 发给服务端；
2. 把服务端的 `ServerMsg` 变成本地状态（实体、自己的属性、事件）；
3. 每帧把本地状态画出来：位置在两次同步之间插值，动作、特效、飘字由事件驱动。

碰撞、伤害、冷却这些判定都不在前端做。

## 技术栈

| 层 | 现在 | 计划 |
| --- | --- | --- |
| 语言 | TypeScript | |
| 构建 | Vite（开发热更新，`npm run build` 输出到 `web/dist`） | |
| 协议 | protobufjs：`npm run proto` 从 `proto/btdemo.proto` 生成 `src/net/pb.js` 和类型 | |
| 渲染 | PixiJS 8（WebGL）：地表、物件、角色、光照；描边和轮廓光是着色器。技能特效暂时用 Canvas 2D 画（开后期处理时交给 Pixi 以便发光），头顶文字画在叠加的 2D 画布上 | 特效改成 Pixi 粒子；模型换成美术贴图 / Spine |
| 地图 | （旧）服务端 `config/map.yaml` 下发物件 | Tiled 编辑器（`config/maps/*.tmj`，每个场景一张），前后端读同一份（已完成，见 [地图](map.md)） |
| 界面 | DOM（HUD、调试面板） | 保持 DOM |

选型理由：Pixi 只管渲染、不带游戏逻辑，适合“服务端权威、客户端只做表现”的结构；2D 性能好，描边光照可以写成着色器；Spine 骨骼动画有官方运行时。

## 目录

```text
web/
  index.html            页面骨架：画布、HUD、调试抽屉；入口 /src/main.ts
  package.json          npm 脚本和依赖
  vite.config.ts        构建输出 dist；开发服务器 5173 端口，/ws 代理到 localhost:8090
  tsconfig.json
  embed.go              go:embed dist
  public/.gitkeep       构建时复制到 dist，保证没构建前端也能编译服务端
  src/
    main.ts             入口：把各模块接起来，每帧主循环
    fxlab.ts            特效实验页（?fxlab）：假角色、按钮播命中/技能/格挡/地面印记，调档位和后期参数
    sfxlab.ts           调音页（?sfxlab）：试听每个声音、烘焙版/实时版 A/B、调音量音高、导出 mix.ts
    input.ts            键盘鼠标：移动、选目标、放技能（J K L U I O）、G/Q/` 开关
    net/
      types.ts          前端用的消息类型（Welcome、增量 State / Self、事件……）
      protocol.ts       protobuf ⇄ types.ts 的转换，协议收发都经过 tap（调试面板用）
      connection.ts     WebSocket，断线自动重连（500ms、1s、2s、5s 退避），重连发 Hello{token}
      pb.js / pb.d.ts   生成的代码，不提交（npm run proto）
    game/
      config.ts         插值时长、动画时长、配色、属性表等常量
      math.ts           clamp、lerp、hypot、fmt
      state.ts          State 和 ClientEntity 类型、全局 state、插值 posOf、头顶位置 headY
      sync.ts           处理 Frame 里的 welcome / enter / leave / state / event / self / zones / ai / toast 等消息；welcome 后下载地图建场景
      map.ts            下载并解析所在场景的地图（/maps/*.tmj）（Tiled 地图，和服务端读同一份）
      events.ts         事件 → 动画、特效、飘字
    feel/
      profiles.ts       打击感档位表（light/medium/heavy、格挡、完美格挡、破防……）和技能 → 档位/武器
      director.ts       一次命中分发到顿帧、击退、镜头、音效、命中序列帧、地面印记
    audio/
      kit.ts            合成积木（噪声、振荡器、包络、滤波）
      recipes.ts        每个声音的配方（武器.材质.档位 命名，找不到时逐级回退）
      engine.ts         音频总线：先用烘焙好的音频图集，没有或 ?sfx=live 时实时合成
      sprite.ts         读 audio/audio.json + sfx.webm / sfx.m4a，切成每个声音的变体
      bake.ts           ?sfxbake 时离线渲染全部配方，给 tools/sfxbake/bake.mjs 调用
      mix.ts            每个声音的音量 / 音高微调（sfxlab 导出后粘贴进来）
    render/
      world.ts          Pixi 舞台和一帧的绘制：镜头、地面标记、角色、光照
      overlay.ts        叠加的 2D 画布：名字血条、气泡、飘字、调试线条、暗角（不开后期处理时还有技能特效、环境粒子）
      lighting.ts       GPU 光照：暗色层（擦除混合挖出光斑）+ 彩色光（加法混合）
      grade.ts          调色：默认调色函数烘焙成 LUT 贴图，也能加载美术给的 LUT 图片
      art.ts            美术资源：读 art/manifest.json，有图的角色/物件/地表/LUT 用图，没有的继续程序画
      bake.ts           把程序画的模型、物件、命中序列帧按美术规范导出成模板（地址带 ?bake 时可用）
      flipbook.ts       命中序列帧：每种材质一组（金属火星、骨渣、血点、兽毛、黏液、木屑），清单里有图就用图
      pixi/
        actorView.ts    一个角色：阴影、自己脚下的印记、身体精灵 + 墨线着色器、染色、闪现残影
        inkFilter.ts    墨线着色器：描边、轮廓光、受击白闪
        sceneView.ts    地表切块贴图、物件精灵、动态物件（火焰）
        canvasSprite.ts 用 Canvas 2D 画内容的精灵（程序化模型、火焰、地面特效用它接进 Pixi）
        postFilter.ts   后期处理：泛光（亮部提取 + Kawase 模糊）+ LUT 调色，一个滤镜做完
        decals.ts       地面印记：重击裂纹、火焰焦痕、冰霜、击退拖痕（最多 40 个，6 秒后淡出）
      models.ts         角色模型和动作（程序化绘制，美术到位后替换）
      knightActions.ts  玩家（骑士、游侠）每个技能的专属动作：关键帧、手脚 IK、出手时刻
      fx.ts             技能和战斗特效、粒子、屏幕震动（Canvas 2D）
      scenery.ts        地表、场景物件、环境光源（Canvas 2D 生成贴图）
    ui/
      hud.ts            自己 / 目标面板、两行技能栏、死亡遮罩、提示条、连接状态
      picker.ts         选技能面板：进游戏和死亡时挑职业、外观和技能，发 Loadout（和 SetSkin）
      bag.ts            装备面板：E 键开关，装备槽、属性、外观、背包格子，发 equip / unequip / skin
      skins.ts          外观卡和“每个职业上次选的外观”的读写（选技能面板和装备面板共用）
      debug.ts          调试抽屉：标签页、跟随选中目标、向服务端要追踪
      debug-ai.ts       AI 决策页：整棵行为树（可折叠）叠加每帧结果和判断依据，暂停后逐帧回看，节点详情
      debug-proto.ts    调试抽屉：协议收发列表
    styles/             CSS，由 main.ts 引入
```

分工：`game/` 根据服务端消息改 `state`；`render/` 每帧读 `state` 画出来，只顺带更新动画用的字段（走路相位、过期的气泡和飘字），不碰游戏逻辑；`ui/` 是 DOM。

## 画面分层

```text
#game（WebGL，Pixi）
  scene          整个画面；高画质时加后期处理滤镜（泛光 + 调色）
    world        跟随镜头：地表 → 区域光圈 → 地面印记 → 地面标记（AOI、边界、射程、目标圈）→ 地面特效 → 角色和物件（按脚底 y 排序）
    darkness     光照暗色层（屏幕空间，半分辨率渲染纹理）
    glow         光源彩色叠加（跟随镜头）
    fx           技能特效 → 环境粒子（Canvas 2D 画到整屏画布再交给 Pixi，这样能发光）
#overlay（2D 画布，鼠标穿透，不发光、不调色）
  （不开后期处理时：技能特效 → 环境粒子）→ 目标连线 → 碰撞体 / AI 路径 → 名字血条 → 气泡 → 飘字 → 暗角
```

### 后期处理（postFilter.ts）

整个 `scene` 先渲染成一张贴图，再过一个滤镜：

1. **泛光**：提取亮度超过阈值（`world.ts` 的 `POST.threshold`）的部分，做 5 次 Kawase 模糊（每次 4 个斜向采样，偏移逐次变大），按 `POST.bloom` 的强度加回原图。火盆、营火、岩浆、魂火、技能特效会晕开一圈光。
2. **调色**：查一张 32×32×32 的颜色查找表（LUT，存成 1024×32 的横条图）。默认表由 `grade.ts` 的 `gradeColor` 生成：暗部偏冷紫、亮部偏暖金、略提对比和饱和度。美术可以在调色软件里做一张同格式的 LUT，用 `loadLut(url)` 加载后 `post.setLut(...)` 换上，不用改着色器。

开关：`B` 键或地址加 `?nopost`；低画质（`Q` / `?low`）也会关掉，中画质只用两级泛光、不做热浪和冲击波扭曲。参数调整只改 `world.ts` 顶部的 `POST`。

- 程序化画的东西（模型、火焰、地面特效）先画到小画布，再作为贴图交给 Pixi（`CanvasSprite`）。角色和火焰每秒重画 24 次（站着不动的角色 12 次，镜头外的不重画），位置每帧跟随插值。
- 描边、轮廓光、受击白闪在 `inkFilter.ts` 的着色器里做，作用在角色精灵上；以后换成美术贴图或 Spine 动画，滤镜照样能用。
- 画质三档，`Q` 键循环切换，地址加 `?mid` / `?low` 从中档 / 低档开始（`world.ts` 的 `applyQuality`）：
  - 高：全部效果，像素密度最高 2；
  - 中：保留描边、光照、泛光调色，泛光只用两级、不做扭曲，粒子减半，像素密度最高 1.5；
  - 低：关掉着色器、光照和后期处理，像素密度最高 1.5。
- 场景细节：植被随风摆、角色走过会把草木推弯（`sceneView.ts` 的 `swayProp`）；自己被房子、大树挡住时物件半透明，并在最上层画一圈金色剪影（`xrayFilter.ts`）；走路每一步扬土、转身身体收窄一下、待机呼吸起伏（`world.ts` 的 `poseOf`）。
- 美术资源：图片和清单放 `web/public/art/`（格式见 [美术规范](../art-spec.md)）。启动时 `art.ts` 先加载清单，`ActorView` 有图就播帧动画、`SceneView` 有图就用图，没有的照旧程序画，所以可以逐个替换。程序模型绘制范围按 `game/config.ts` 的 `MODEL_BOX`，导出模板的格子大小也由它决定。特效以后改成 Pixi 粒子。

## 一帧做什么（main.ts 的 frame）

1. `watchFrameRate`：持续低帧率时自动降一档画质（高 → 中 → 低）；
2. `runPending`：播放到时间的受击（弹道飞到目标时才显示伤害数字）；
3. 调试面板跟随当前选中的目标；
4. `updateCamera` 镜头跟随自己；
5. `drawWorld` 画世界；
6. 刷新目标面板、技能冷却、死亡倒计时。

收到消息不在帧里处理，而是 WebSocket 回调里直接改 `state`（`game/sync.ts`）。

## 网络协议

- **连接**（`net/connection.ts`）：连上后第一帧必须发 `ClientMsg{hello: Hello{token}}`。token 来自上一次 `Welcome.token`，存在 sessionStorage `btdemo.token`（读写都 try/catch），没有就发空串。协议里没有序号、确认和客户端心跳（服务端发 WebSocket ping，浏览器自动回 pong）。
- **断线**：服务端把角色保留 30 秒。断线后按 500ms、1s、2s、5s 退避自动重连，重连发 `Hello{token}`，服务端回 `Welcome{resumed}` 加全量。断线期间不攒输入（`send` 直接丢掉），界面显示“连接已断开，正在重连”，画面不清空；收到 Welcome 后 `resendMove()` 把当前按键状态重发。
- **帧**：服务端每个 WebSocket 帧是 `Frame{time, msgs}`，`protocol.decode` 返回 `{ time, msgs }`，`sync.ts` 的 `handleFrame` 按顺序处理每条消息；调试面板的协议查看器（`protocol.tap`）每条消息调一次。
- **时钟**：每收到一帧就更新 `state.clockOffset`（本地 `performance.now()` 减服务端时间），`localTime(serverTime)` 把 `*_at` / `until` 这类服务端时间点换成本地毫秒，用来倒计时（技能冷却 `state.cds`、Buff `endsAt`、复活 `respawnAt`、回血区 `endsAt`）。
- **增量**：`EntityInfo`（`enter`）带完整 `state`；之后的 `state` 消息只带变化的字段，`onState` 只覆盖出现了的字段（有 `x` / `y` 才做位置插值），不认识的实体 id 直接忽略。`self` 同理，`onSelf` 合并成完整的 `state.self`：`base` / `attr` 出现就整体替换，`cds_set` / `buffs_set` 为真时 `cds` / `buffs` 是完整新列表，`respawn_at` 是复活时间点（0 = 没死）。
- **Welcome.resumed**：为真表示还是原来的角色，清空实体等 `enter` 重发，但保留玩家自己的选择（不弹选技能面板、不重发宠物选择、不清目标、不清 `state.self`）。

## 技能：按键、技能栏和选技能

**按键**（`input.ts` 的 `SKILL_KEYS`）：`J K L U I O` 依次是 1～6 号格，`J` 是普攻。数字键 `1`～`6` 也还能用。放技能前 `castSlot` 会检查：选技能面板开着时不放（普攻也不发）；格挡中不放，提示“格挡中不能出招”。

**技能栏**（`ui/hud.ts`）：两行，`BAR_ORDER = [4, 5, 6, 1, 2, 3]`，上排 U I O（4～6 格），下排 J K L（1～3 格），和键盘上的位置一致。冷却是按钮上的遮罩加秒数，每帧 `renderSkillBar` 刷新。

**选技能面板**（`ui/picker.ts`）：从技能池（`Welcome.pool`）里挑 `pick` 个，放到第 2 格起。
- 打开：刚进游戏（`welcome` 时 `openPicker('join')`），死亡时（`self` 里自己从活变成死，`openPicker('death')`，标题写“重新选择技能（复活后生效）”）。
- 面板上半是一排格子，J 固定是普攻，后面按选的顺序排；下半是技能卡，点一下选上或取消，选满了其余的卡不能再点。
- 确认：回车，或者按“出发”（新角色）/“确定”（死亡时）。Esc 关掉，不换技能。
- 确认时，和当前技能栏一样就不发；不一样就发 `loadout`。服务端接受后回 `skillBar`，前端换栏并提示“技能已更换”；被拒绝时服务端只回一条 Toast，技能栏不变。
- 默认选择：上次确认的，存在浏览器 `localStorage` 的 `btdemo.loadout` 里，只在这个浏览器有效；存的不能用（技能不在池里，或数量不对）就用当前技能栏上的。读写 `localStorage` 都包在 try 里，存不了就算了。
- 面板开着时，点击不会穿到画布（不选目标、不普攻），技能键也不放技能。

**瞄准**（`input.ts` 的 `aimFor`）：闪现（`dash`）和飞斧（`line`）发 `cast` 时带上方向 `dx`、`dy`。
- 闪现：朝按住的方向键；什么都没按就朝角色面向（左或右）。
- 飞斧：有当前目标（活着的怪）就朝它飞，否则同闪现。
- 箭雨（`rain`）：和飞斧一样，有敌对目标就带上朝它的方向（服务端优先落在目标上，目标太远时退回按方向落点），否则同闪现。

## 职业（骑士 / 游侠）

- `Welcome.classes` 是可选职业（第一个是默认），`Welcome.class` 是当前职业；存进 `state.classes`、`state.playerClass`、`state.canBlock`。职业自带模型、颜色、默认技能栏、技能池（`pool`）和个数（`pick`）。
- 选技能面板顶部是职业卡（职业少于 2 个时不显示），点卡或按数字键 `1` `2` 切换：技能池、个数、固定普攻、默认选择都换成该职业的。默认选择按职业分别记在 `localStorage` 的 `btdemo.loadout`（`{ cls, skills: { 职业: [技能] } }`）。
- 确认时职业变了或技能变了就发 `loadout`，职业变了才带 `class`。服务端回 `skillBar`（带 `class`）后，`sync.ts` 更新 `playerClass`，并把技能池、个数、`canBlock` 换成新职业的。
- 不能格挡的职业（`can_block` 为 false，如游侠）右键不发 `block`（`input.ts` 的 `setBlock`）。
- 换职业后服务端会给所有人重发该实体的 `enter`；`sync.ts` 对已存在的实体更新 `model`、`name`、`color`、`r`，渲染层要在 `model` 变化时重建 ActorView。
- 自己面板的等级后面显示职业名（`ui/hud.ts` 的 `renderSelf`）。
- `render/world.ts` 发现实体的 `model` 和它的 ActorView 不一样时，销毁重建。

**游侠模型**（`render/models.ts` 的 `drawRanger`）：玩家颜色的兜帽和叶边短披风、皮甲、背上斜挎箭袋，近侧手握反曲弓。
弓身和箭的方向 `aim` 垂直；搭箭时（`nocked`）弦拉到远侧手，箭搭在弦上，穿云箭的箭头蓄力发金光、冰霜箭的箭头结冰。
动作在 `knightActions.ts` 里以 `ranger:` 开头（`ranger:arrow` 普攻射击、`ranger:pierce`、`ranger:rain`、`ranger:frostarrow`、`ranger:roll`、`ranger:focus`，
共用技能 `ranger:haste`、`ranger:zone`）；`events.ts` 按施法者模型拼动作名。翻滚的 `tumble` 让整个人绕身体中心转一圈。

## 装备面板（ui/bag.ts）

协议：`Welcome.items` 是全部装备种类，存进 `state.items`（id → `ItemInfo`；协议里的 `class` 在前端叫 `cls`）；
服务端在进游戏后和每次变化时发整份 `Inventory`，存进 `state.inventory`（`{ items: ItemSlotted[], capacity }`，`slot` 空的在背包里，不空的穿在身上）。

- 开关：`E` 键或右上角的“装备 (E)”按钮（手机上在技能栏右上方）；`Esc`、`E`、右上角 × 关闭。选技能面板开着时 `E` 不起作用。
- 面板开着时技能键和左键普攻都不放（`input.ts` 的 `castSlot` / `tryAttack` 检查 `state.bagOpen`），按技能键提示“先关闭装备面板”；移动照常。
- 布局从上到下：
  1. 三个装备槽（武器 / 护甲 / 饰品）：图标 + 名字（稀有度颜色），空槽虚线框；
  2. 派生属性（和自己面板一样的格式），身上装备带冷却缩减时多一行“冷却缩减”（按装备加起来，上限 40%）；每次收到自己的属性时刷新（`renderBagStats`）；
  3. 外观（见下节）；
  4. 背包：`capacity` 个格子（默认 24），空格也画出来，右上角是“已用 / 格数”。
- 说明框：鼠标悬停显示；触屏上第一次点只显示说明，再点同一格才执行。内容是名字（稀有度颜色）、稀有度 · 槽位 · 职业限制（“游侠专用”或“通用”）、每条属性（暴击率、暴击伤害、冷却缩减显示成百分比）、特效说明，最后一行提示点了会怎样。
- 点背包里的装备发 `equip`（`uid`），点身上的发 `unequip`（槽位）。别的职业的装备变暗，点了只提示“××专用，当前职业不能装备”，不发请求。
- 面板只显示服务端的结果：换装后等新的 `Inventory` 再重画（`sync.ts` 收到时调 `refreshBag`），被拒绝时服务端只回 Toast。掉落提示和特效飘字由 `events.ts` 处理，面板不另外弹提示。
- 图标：`render/itemIcons.ts` 的 `drawItemIcon(ctx, item, size)`，画到 40 × 40（CSS 像素）的小画布上，`ctx` 已按设备像素比缩放。稀有度颜色是 `game/config.ts` 的 `RARITY_COLOR`。
- 面板在选技能面板下面一层：死亡时弹出的选技能面板盖在上面。

## 外观（皮肤）选择

`ClassInfo.skins` 是每个职业的外观（第一个是默认），换职业时 `state.skins` 换成新职业的；自己现在的外观 `state.mySkin` 以服务端发来的自己的 `Enter`（`EntityInfo.skin`）为准，空串表示默认。
所有实体的 `skin`、`gear`（当前武器的 `look`）在 `Enter` 时写进 `ClientEntity`，已存在的实体再收到 `Enter` 时也更新；渲染层按它们换配色和武器。

- 选技能面板：职业卡下面一排外观卡（名字 + 色块，选中的高亮），跟着选中的职业换。确认时：职业没换、外观和现在的不一样就在 `loadout` 之后发 `skin`；职业换了就先不发，等服务端回 `skillBar`（职业确实变了）后，`sync.ts` 再发这个职业记住的外观（服务端换职业时把外观重置成默认）。
- 装备面板：同样一排外观卡，点了直接发 `skin`（当前职业）。
- 记忆：每个职业上次选的外观存在 `localStorage` 的 `btdemo.loadout` 里，新加的 `skins` 字段（`{ cls, skills: { 职业: [技能] }, skins: { 职业: 外观 id } }`）；老数据没有 `skins` 也照常读，写的时候保留其他字段（`ui/skins.ts`）。记住的外观已经不存在时当作默认。
- 只有一套外观（或服务端没发）时两处的外观行都不显示。

## 宠物

- 装备面板（E）的「宠物」一栏：外观下面一排宠物卡加一张「不带」（`bag.ts` 的 `renderPets`，卡片复用外观卡的 `skin-card`，加 `pet-card` 变体）。点卡发 `SetPet`（`{ t: 'pet', pet }`），空串 = 收回。换宠物有冷却：`state.petCooldownUntil` 没到时卡片加 `cooling`（变暗）、显示剩余秒数，点了只提示。
- 选择记在 localStorage `btdemo.pet`（空串 = 不带，没存过是 null）。Welcome 后，服务端默认召唤第一只；记住的选择不同就发一次 `SetPet`（`sync.ts` 的 `onWelcome`）。
- 服务端 `PetStatus`（`state.myPet`、`petEntity`、`petRespawnAt`、`petCooldownUntil`）由 `sync.ts` 的 `onPetStatus` 记下；`hud.ts` 的 `renderPetHud` 在自己面板末尾画宠物小卡（`.pet-hud`）：名字、等级、血条；死了显示复活倒计时，不带时显示「不带宠物」。
- 宠物实体的 `kind` 是 `pet`，`owner` 是主人的实体 id；名牌由 `state.ts` 的 `refreshPetNames` 拼成「主人名 的 宠物名」，颜色在 `overlay.ts`（自己的金色，别人的青绿）。
- 不能被选为目标：`input.ts` 的 `pickEntity` 跳过宠物，自动普攻只打怪物。调试模式下点宠物只让 BT 面板看它（`debug.ts` 的 `pickPet`），不改游戏里的目标。

## 技能特效和外观

**特效**（`render/fx.ts` 的 `cast()`，按 `fx` 分支）：
- `haste` 疾风步：脚下一圈青色气浪，身边风线往两边吹开。
- `holy` 圣光庇护：金色光柱落下，脚下一圈光环。
- `enchant` 烈焰附魔：身上腾起一团火，火星乱窜。
- `blink` 闪现：起点和终点各一团紫光，中间一道光痕，终点一圈环。角色直接出现在终点（`events.ts` 的 `blinkTo`，不滑过去），起点留下残影。
- `axe` 飞斧：转着飞向终点（命中的敌人，或被墙挡住的地方）。
- `frost` 冰霜新星：地上冰环往外扩，冰碴往外飞，飘几片雪。
- `zone` 治愈之泉：手按到地上时一圈绿光贴地散开；法阵本身和出生点的泉水由 `render/zones.ts` 画（见 [zone](zone.md)）。站在回血区里回的血（`heal` 事件带 `zone`）是小号绿字加两三个小十字。
- `arrow` / `frostarrow` 游侠的箭：比法球快，从弓上搭箭的位置（`muzzleOffset`）飞出；冰霜箭一路掉冰屑，命中炸一团冰花。
- `pierce` 穿云箭：一支金箭沿直线飞到射程尽头（或墙），后面一道金光带，飞完整条光带淡掉；返回飞到第一个命中目标的时间，伤害数字按这个时间出。
- `rain` 箭雨：先一箭射上天，落点亮出一圈虚线和准星，再 22 支箭陆续扎进圈里（落地扬土），插在地上一会儿再淡掉。悬停箭雨按钮时，脚下是射程虚线，预测落点（`input.ts` 的 `rainCenter`，和服务端规则一样）画实心圈。
- `roll` 翻滚：起点扬土；服务端瞬间到位，客户端用 `slide`（`events.ts` 的 `rollTo`，`state.ts` 的 `posOf`）在动作前 3/4 里滑过去。
- `focus` 鹰眼专注：脚下一圈金光，眼前金色星点往里收，眼睛闪金光（模型里画）。
- 武器着火（`LOOK_FIRE`）时，物理技能（`melee`、`circle`、`axe`）的颜色换成火焰色（`events.ts`）。
- 伤害事件带 `immune`：金色“免疫”飘字，不推不闪。

**外观**（`Buff.look`）：服务端的 `Buff.look` 进入 `EntityState.looks` 的位（1 疾风、2 圣光、4 火焰、8 冰冻），前端存在 `ClientEntity.looks` 里。`LOOK_*` 常量在 `game/config.ts`，要和服务端 `internal/config` 里的 `Looks` 对上。
- `fx.looks()` 每帧按位冒粒子：疾风的风线（只在移动时）、圣光的金点、火焰的火星、冰冻的雪花。
- `fx.lookGlows()` 给圣光和火焰画常驻的淡光晕。
- 角色身体的 `tint`（`world.ts`）：冰冻淡蓝，圣光淡金；死亡时不染色。
- 闪现残影：`world.ts` 的 `blinkGhost` 从起点记下偏移，`actorView.ts` 在起点到当前位置之间画 3 道半透明紫色身影，380 毫秒淡出。
- 武器着火时骑士的剑身上一路小火苗（`Pose.looks` 传到 `models.ts`）。

## 技能动作

玩家每个技能有自己的动作，不再都是斩击（普攻 `melee` 还是原来的斩击）。数据在 `render/knightActions.ts` 的 `SPECS`，按技能的 `fx` 名查：

| fx | 技能 | 动作 | 时长 / 出手 |
|---|---|---|---|
| `projectile` | 火球术 | 剑收到腰后，剑尖蓄火；弓步前刺，火球从剑尖飞出，剑尖被顶起 | 480 / 134 ms |
| `circle` | 旋风斩 | 压低身子收剑，剑平举原地转一圈，剑尖扫出一圈光 | 580 / 81 ms |
| `heal` | 治疗术 | 握剑竖在面前（骑士礼），低头祈祷，绿光顺着剑身往上爬 | 720 / 144 ms |
| `buff` | 战吼 | 缩身蓄力，再挺胸仰头、剑指天、盾甩向身后，张口怒吼并发颤 | 680 / 163 ms |
| `shield` | 护盾 | 把盾举向天空，盾面泛白、盾沿亮冷光，两脚扎稳 | 540 / 130 ms |
| `haste` | 疾风步 | 起跑式伏低，剑拖在身后，一蹬抬膝冲出 | 460 / 74 ms |
| `holy` | 圣光庇护 | 倒提起剑，单膝跪地插剑入土，剑身泛金，低头 | 780 / 156 ms |
| `blink` | 闪现 | 到达时是前扑的弓步，剑往前平伸，身子被拉长后收住 | 380 / 0 ms |
| `enchant` | 烈焰附魔 | 盾背到背上，剑平举，空手从剑格抹到剑尖，火跟着手烧起来，剑尖一挑 | 720 / 115 ms |
| `axe` | 飞斧 | 盾背到背上，空手从脑后抡起手斧，跨步甩出，手顺势压下 | 440 / 119 ms |
| `frost` | 冰霜新星 | 高抬膝、盾和剑张开，一脚跺下去蹲住，剑身结霜 | 600 / 144 ms |
| `zone` | 治愈之泉 | 盾背到背上，空手托起一团绿光，再单膝跪下把手掌按进地里，法阵从这一刻铺开 | 820 / 459 ms |

- **关键帧**：0..1 时间轴上排帧，帧间按缓动插值（`out` 出招先快后慢、`in` 砸下去先慢后快）。手的位置写在躯干坐标里（原点在两肩关节中点，x 朝前、y 朝下），初始化时用两节骨骼 IK（`armIK`）换成大臂 / 肘的角度，帧间按角度插值，所以挥动是弧线。剑的角度（`blade`）单独写。
- **站姿**：`feet` 写两只脚相对站立落脚点的偏移，`drop` 是胯下沉多少；每帧用 `legIK` 算腿，膝盖朝前弯。不写 `feet` 的帧用平常的步态（走路中放技能时腿照常走），写和不写之间平滑混合。
- **其他**：`lift` 跳起，`jitter` 发力颤动，`stretch` 闪现拉伸，`spin` 原地转一圈（横向缩放 + 光照方向翻转），`slung` 把盾背到背上空出一只手。剑身的火苗、霜刺、染色，剑尖火球，手里的飞斧，划过的光痕（`TRAILS`）在 `models.ts` 里画；都是实心小形状，不画柔和光晕（模型外面半透明的一圈会被描边描出黑边），亮的部分交给泛光。
- **出手时刻**：`events.ts` 收到施法事件时记下 `ClientEntity.action` 和动作时长 `attackMs`，并把特效推迟 `ACTIONS[fx].lead` 毫秒（`fx.cast(ev, now, lead)`：特效先放进 `scheduled`，到点再播，屏幕震动也一起推迟），火球从刺出去的剑尖飞出、冰霜在跺脚时炸开；伤害数字跟着往后推。
- 加新技能动作：在 `SPECS` 里按技能的 `fx` 名加一条，需要剑上的效果就在 `models.ts` 的 `knightBladeFx` 加一个分支。调姿势时可以用 Vite 开发服务器在页面里 `import('/src/render/models.ts')`，按不同进度画 `drawModel(ctx, 'knight', { x: 0, y: 0, r: 20, color, facing: 0, attack: k, action, hit: -1, dead: -1, time, bare: true })` 排成分帧图看（`time` 不能省，待机呼吸要用）。

## 开发

需要 Node.js 20+。浏览器需要支持 WebGL（不支持时连接状态会提示画面初始化失败）。

```sh
cd web
npm ci                # 第一次，或 package-lock.json 变了之后
npm run dev           # Vite 开发服务器 http://localhost:5173，改 TS/CSS 立即生效
                      # 另开一个终端 go run ./cmd/server 提供 /ws（默认 8090 端口）
npm run typecheck     # 生成协议代码 + 类型检查
npm run build         # 生成协议代码 + 类型检查 + 输出 web/dist
```

发布或只跑服务端时：先 `npm run build`，再 `go build`，前端就嵌在二进制里了。`start.bat` 会自动做这两步。没构建前端就编译服务端时，首页会提示先构建。

## 音效管线

声音全部来自 `audio/recipes.ts` 的配方（程序合成）。为了省掉运行时合成的开销、也方便换真实素材，配方会**烘焙**成一个音频图集：

```sh
cd web
npm i --no-save playwright && npx playwright install chromium   # 第一次
npm run sfx:bake      # 输出 web/public/audio/sfx.webm、sfx.m4a、audio.json（需要 ffmpeg，没有就只出 sfx.wav）
```

- 改了配方要重新烘焙，否则游戏里听到的还是旧的（`?sfx=live` 强制实时合成，可以先听效果）。
- 换真实素材：把 wav 放进 `assets-src/audio/<声音名>/`（多个文件就是多个变体），在 `assets-src/audio/CREDITS.md` 记下来源和授权，再烘焙一次。声音名见 sfxlab 页面。
- 调音：打开 `?sfxlab`，拖音量和音高，点“导出”，把结果粘贴进 `audio/mix.ts`。
- 加载失败（文件缺失、浏览器不支持）时自动回到实时合成，不会没声音。

## 改协议

`proto/btdemo.proto` 改完后：

1. `go generate ./internal/pb`（服务端）；
2. `npm run proto`（前端；`npm run build` 也会自动跑）；
3. 在 `src/net/types.ts` 加字段，在 `src/net/protocol.ts` 的 `decode` / `encode` 里转换。

字段名对不上时 `tsc` 会直接报错。

## 加东西时改哪里

- 新怪物模型：`render/models.ts` 加画法，`game/config.ts` 的 `MODEL_H` 加头顶高度。
- 新技能特效：`render/fx.ts` 的 `cast()` 按 `fx` 字段分支。护盾泡泡是常驻效果，由 `game/state.ts` 的 `fxAuras()` 每帧列出带护盾的实体，`fx.shieldAuras()` 画。
- 新 Buff 外观：服务端 `internal/config` 的 `Looks` 加一个位，`game/config.ts` 加 `LOOK_*` 常量，`render/fx.ts` 的 `looks()` 冒粒子，需要的话在 `lookGlows()` 或 `world.ts` 的 `tint` 里加效果。
- 鼠标操作在 `input.ts`：左键普攻（1 号技能，冷却中或身边没怪时不发请求，按住连续打），右键按住发 `block`。
- 新场景物件：`render/scenery.ts` 的 `KINDS`，同时在 这个场景的 `config/maps/*.tmj` 加碰撞形状并摆放（见 [地图](map.md#加一种新物件)）。
- 新 HUD 元素：`index.html` 加元素，`ui/hud.ts` 取元素并刷新。
- 新事件：`net/types.ts` 的 `EventKind`、`protocol.ts` 的 `EVENT_KIND`，再在 `game/events.ts` 处理。
