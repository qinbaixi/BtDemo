package game

import (
	"context"
	"fmt"
	"log"
	"slices"
	"sync"
	"time"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game/core"
	"github.com/qinbaixi/BtDemo/internal/game/nav"
	"github.com/qinbaixi/BtDemo/internal/game/session"
	"github.com/qinbaixi/BtDemo/internal/pb"
)

// 场景管理器。
//
// 每个场景模板（scenes.yaml）开着一条或几条线，每条线是一个 Scene，跑在自己的 goroutine 上。
// Manager 记录每个角色（按 token）现在属于哪条线，负责：
//   - 进游戏、断线重连：找到角色所在的线，把连接交给那条线（Attach / Detach）；
//   - 分线：进一个场景时选哪条线，人多了开新线，多出来的空线过一会儿关掉（pick、closeIdle）；
//   - 换场景、换线：源场景把角色交出来，Manager 选好目标线，目标场景接收（travel.go）。
//
// 规则：Manager 只用一把锁保护自己的表，拿着锁时从不等场景；要场景做事一律 scene.Do（不阻塞）。
// 场景可以随时同步调用 Manager 的方法（拿一下锁马上返回），所以不会死锁。
//
// 角色在任何时刻只有一个主人：所在的场景，或者迁移途中的 Manager（route.moving）。
// 迁移途中只有 Manager（拿着锁）会碰这个会话：重连、断线只换它的连接，到了目标场景再统一处理。
type Manager struct {
	cfg   *config.Config
	seed  int64
	ids   *core.IDSource // 所有场景共用，玩家换场景后实体 ID 不变
	start time.Time      // 新开的线的时钟从这时起算，各条线的游戏时间对得上

	mutex   sync.Mutex
	ctx     context.Context    // Run 的 ctx；Run 之前为 nil，此时开的线等 Run 再启动
	lines   map[string][]*line // 场景模板 id -> 开着的线，按线号排序
	routes  map[string]*route  // token -> 角色在哪
	opened  int                // 一共开过几条线，用来给每条线不同的随机种子
	stopped bool
	running sync.WaitGroup
}

// line 是 Manager 眼里的一条线。
type line struct {
	scene *Scene
	// residents 是属于这条线的角色数：在线上的（含断线保留中的），加上正在过来的。
	// 分线按它算人数；它为 0 的线才能关。
	residents  int
	emptySince time.Time // residents 变成 0 的时刻
	cancel     context.CancelFunc
}

// route 记录一个角色现在归谁。
type route struct {
	session *Session
	line    *line // 角色所在的线；迁移途中是要去的线
	moving  bool  // 迁移途中：已经离开源场景，目标场景还没接收
}

// closeIdleEvery 是多久检查一次有没有该关的空线。
const closeIdleEvery = 5 * time.Second

// NewManager 为每个场景模板开好常驻的线（scenes.yaml lines.min）。线在 Run 之后才开始运行。
func NewManager(cfg *config.Config, seed int64) (*Manager, error) {
	cfg.Single()
	manager := &Manager{
		cfg:    cfg,
		seed:   seed,
		ids:    &core.IDSource{},
		start:  time.Now(),
		lines:  map[string][]*line{},
		routes: map[string]*route{},
	}
	for _, template := range cfg.Scenes.List {
		for len(manager.lines[template.ID]) < template.Lines.Min {
			if _, err := manager.openLine(template); err != nil {
				return nil, err
			}
		}
	}
	return manager, nil
}

// Run 运行所有的线，直到 ctx 结束；结束时等每条线跑完已经接受的命令、断开所有会话再返回。
func (manager *Manager) Run(ctx context.Context) {
	manager.mutex.Lock()
	manager.ctx = ctx
	for _, lines := range manager.lines {
		for _, line := range lines {
			manager.startLine(line)
		}
	}
	manager.mutex.Unlock()
	ticker := time.NewTicker(closeIdleEvery)
	defer ticker.Stop()
	for running := true; running; {
		select {
		case <-ctx.Done():
			running = false
		case <-ticker.C:
			manager.closeIdle(time.Now())
		}
	}
	manager.mutex.Lock()
	manager.stopped = true
	manager.mutex.Unlock()
	manager.running.Wait()
}

// openLine 给场景模板 template 开一条新线，线号取最小的空号。须拿着锁调用。
func (manager *Manager) openLine(template *config.Scene) (*line, error) {
	number := 1
	for _, existing := range manager.lines[template.ID] {
		if existing.scene.Line == number {
			number++
		}
	}
	manager.opened++
	state := core.NewSceneState(
		template.Cfg,
		manager.seed+int64(manager.opened)*7919,
		manager.ids,
		time.Since(manager.start).Milliseconds(),
	)
	scene, err := newScene(
		state,
		template,
		number,
		nav.ShapesFromLayout(template.Cfg.Layout),
		manager,
	)
	if err != nil {
		return nil, fmt.Errorf("scene %s line %d: %w", template.ID, number, err)
	}
	opened := &line{scene: scene, emptySince: time.Now()}
	lines := append(manager.lines[template.ID], opened)
	slices.SortFunc(lines, func(left, right *line) int { return left.scene.Line - right.scene.Line })
	manager.lines[template.ID] = lines
	if manager.ctx != nil {
		manager.startLine(opened)
	}
	log.Printf("scene %s: opened line %d", template.ID, number)
	return opened, nil
}

// startLine 让一条线开始在自己的 goroutine 上运行。须拿着锁调用。
func (manager *Manager) startLine(line *line) {
	ctx, cancel := context.WithCancel(manager.ctx)
	line.cancel = cancel
	manager.running.Add(1)
	go func() {
		defer manager.running.Done()
		line.scene.Run(ctx)
	}()
}

// closeIdle 关掉空了 idle_close 秒以上、又不是常驻的线。
func (manager *Manager) closeIdle(now time.Time) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	for _, template := range manager.cfg.Scenes.List {
		lines := manager.lines[template.ID]
		rules := template.Lines
		for i := len(lines) - 1; i >= 0 && len(lines) > rules.Min; i-- {
			idle := lines[i]
			if idle.residents > 0 || now.Sub(idle.emptySince).Milliseconds() < rules.IdleClose {
				continue
			}
			lines = slices.Delete(lines, i, i+1)
			if idle.cancel != nil { // 没有角色属于它，也没人会再往它那里送：直接停
				idle.cancel()
			}
			log.Printf("scene %s: closed idle line %d", template.ID, idle.scene.Line)
		}
		manager.lines[template.ID] = lines
	}
}

// 指定线号时选不了的原因（以提示消息发给玩家）。
const (
	reasonNoSuchLine = "没有这条线"
	reasonLineFull   = "这条线满了"
)

// pick 选场景模板 templateID 的一条线给一个要进来的角色。须拿着锁调用。
//   - wantLine > 0：就要这条线，不存在或满了（hard）返回原因；
//   - 否则：在没超过 soft 的线里选人最多的，让每条线都热闹；都超过了就开新线；
//     开不了新线时选没满（hard）的线里人最少的。
func (manager *Manager) pick(templateID string, wantLine int) (*line, string) {
	template := manager.cfg.Scenes.Scene(templateID)
	if template == nil {
		return nil, reasonNoSuchLine
	}
	lines := manager.lines[templateID]
	rules := template.Lines
	if wantLine > 0 {
		for _, candidate := range lines {
			if candidate.scene.Line != wantLine {
				continue
			}
			if candidate.residents >= rules.Hard {
				return nil, reasonLineFull
			}
			return candidate, ""
		}
		return nil, reasonNoSuchLine
	}
	var best *line
	for _, candidate := range lines {
		if candidate.residents < rules.Soft && (best == nil || candidate.residents > best.residents) {
			best = candidate
		}
	}
	if best != nil {
		return best, ""
	}
	opened, err := manager.openLine(template)
	if err == nil {
		return opened, ""
	}
	log.Printf("scene %s: %v", templateID, err)
	for _, candidate := range lines {
		if candidate.residents < rules.Hard && (best == nil || candidate.residents < best.residents) {
			best = candidate
		}
	}
	if best == nil {
		return nil, reasonLineFull
	}
	return best, ""
}

// arrive 记下有一个角色要进 line。须拿着锁调用。
func (line *line) arrive() { line.residents++ }

// depart 记下有一个角色离开了 line。须拿着锁调用。
func (line *line) depart() {
	line.residents--
	if line.residents == 0 {
		line.emptySince = time.Now()
	}
}

// Attach 把一条新连接接到 token 对应的角色上（断线重连，或者另开了一个标签页），
// 认不得 token（空、过期、伪造）就在默认场景创建新角色。等目标场景处理完才返回；停服时返回 nil。
func (manager *Manager) Attach(link *session.Link, token string) *Session {
	reply := make(chan *Session, 1)
	manager.attach(link, token, reply)
	return <-reply
}

// attach 是 Attach 不等结果的部分：把连接交给角色现在的主人，结果放进 reply。
// 场景 goroutine 上也会调用（角色刚好离开了那条线时重新找），所以它从不阻塞。
func (manager *Manager) attach(link *session.Link, token string, reply chan<- *Session) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if manager.stopped {
		reply <- nil
		return
	}
	found := manager.routes[token]
	if token == "" || found == nil {
		manager.join(link, reply)
		return
	}
	client := found.session
	if found.moving {
		session.ReplaceLink(client, link) // 到了目标场景会按这条连接把全部东西发一遍
		log.Printf("player %d: reconnected while travelling", client.Player.ID)
		reply <- client
		return
	}
	scene := found.line.scene
	accepted := scene.Do(func() {
		if !scene.Sessions.Has(client) {
			manager.attach(link, token, reply) // 这期间角色离开了这条线：重新找
			return
		}
		log.Printf("player %d: reconnected, sending full state", client.Player.ID)
		scene.Sessions.Reattach(client, link)
		reply <- client
	})
	if !accepted {
		reply <- nil
	}
}

// join 在默认场景创建新角色。须拿着锁调用。
func (manager *Manager) join(link *session.Link, reply chan<- *Session) {
	target, _ := manager.pick(manager.cfg.Scenes.Default, 0)
	if target == nil {
		reply <- nil
		return
	}
	target.arrive()
	accepted := target.scene.Do(func() {
		client := target.scene.Sessions.Join(link)
		manager.mutex.Lock()
		manager.routes[client.Token()] = &route{session: client, line: target}
		manager.mutex.Unlock()
		reply <- client
	})
	if !accepted {
		target.depart()
		reply <- nil
	}
}

// Detach 处理连接 link 断开：交给角色现在的主人处理（角色保留 world.yaml session.keep 秒等它重连）。
func (manager *Manager) Detach(client *Session, link *session.Link) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	found := manager.routes[client.Token()]
	if found == nil || found.session != client {
		return // 角色已经删掉了
	}
	if found.moving {
		if session.LinkIs(client, link) {
			session.ReplaceLink(client, nil) // 到了目标场景按断线处理
		}
		return
	}
	scene := found.line.scene
	scene.Do(func() {
		if scene.Sessions.Has(client) {
			scene.Sessions.Detach(client, link)
		} else {
			manager.Detach(client, link)
		}
	})
}

// gone 在线 scene 删除了角色之后调用（离开游戏、断线太久）。
func (manager *Manager) gone(client *Session, scene *Scene) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	found := manager.routes[client.Token()]
	if found == nil || found.session != client || found.moving || found.line.scene != scene {
		return
	}
	delete(manager.routes, client.Token())
	found.line.depart()
}

// lineList 是场景 scene 所在模板的全部线（回答 ClientMsg.Lines）。
func (manager *Manager) lineList(scene *Scene) *pb.LineList {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	rules := scene.Template.Lines
	list := &pb.LineList{Scene: &scene.Template.ID, Current: core.I32(scene.Line)}
	for _, candidate := range manager.lines[scene.Template.ID] {
		list.Lines = append(list.Lines, &pb.LineInfo{
			Line:    core.I32(candidate.scene.Line),
			Players: core.I32(candidate.residents),
			Soft:    core.I32(rules.Soft),
			Hard:    core.I32(rules.Hard),
		})
	}
	return list
}

// canEnter 报告能不能去场景模板 templateID 的第 wantLine 线（0 = 随便哪条），不能时返回原因。
// 只是预先检查：真正出发时（depart）线可能刚好满了，那时会改去别的线。
func (manager *Manager) canEnter(templateID string, wantLine int) string {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if wantLine == 0 {
		return ""
	}
	_, reason := manager.pick(templateID, wantLine)
	return reason
}

// depart 在源场景交出角色之后调用：选好目标线，角色进入迁移途中，从现在起归 Manager。
// 指定的线这时满了就改去别的线。返回 nil 表示正在停服，角色已经删掉。
func (manager *Manager) depart(client *Session, templateID string, wantLine int) *Scene {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	found := manager.routes[client.Token()]
	if found == nil {
		return nil
	}
	found.line.depart()
	target, reason := manager.pick(templateID, wantLine)
	if reason != "" && wantLine > 0 {
		target, _ = manager.pick(templateID, 0)
	}
	if manager.stopped || target == nil {
		delete(manager.routes, client.Token())
		session.ReplaceLink(client, nil)
		return nil
	}
	target.arrive()
	found.line, found.moving = target, true
	return target.scene
}

// arrived 在目标场景接收角色时（目标场景 goroutine 上、动角色之前）调用：角色从现在起归目标场景。
func (manager *Manager) arrived(client *Session) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if found := manager.routes[client.Token()]; found != nil && found.session == client {
		found.moving = false
	}
}

// lost 在目标场景已经停止、收不了角色时调用（停服）：删掉角色，断开连接。
func (manager *Manager) lost(client *Session) {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	if found := manager.routes[client.Token()]; found != nil && found.session == client {
		delete(manager.routes, client.Token())
		found.line.depart()
	}
	session.ReplaceLink(client, nil)
}

// MapSource 返回场景地图文件 name（scenes.yaml 的 map）的原文，给浏览器下载；没有返回 nil。
func (manager *Manager) MapSource(name string) []byte {
	for _, template := range manager.cfg.Scenes.List {
		if template.Map == name {
			return template.Layout.Source
		}
	}
	return nil
}

// DefaultMap 返回默认场景的地图原文（旧的 /map.tmj 地址用）。
func (manager *Manager) DefaultMap() []byte {
	return manager.cfg.Scenes.DefaultScene().Layout.Source
}

// SceneStatus 是一条线的运行情况（/debug/scenes）。
type SceneStatus struct {
	Scene     string  `json:"scene"`
	Name      string  `json:"name"`
	Line      int     `json:"line"`
	Residents int     `json:"residents"` // 属于这条线的角色（含断线保留中的、正在过来的）
	Players   int     `json:"players"`   // 线上的会话数
	Entities  int     `json:"entities"`
	TickMs    float64 `json:"tick_ms"` // 最近 tick 的平均耗时（毫秒）
	PeakMs    float64 `json:"peak_ms"` // 最近一段时间最慢的 tick
}

// Status 列出每条线的运行情况，按场景模板、线号排序。
func (manager *Manager) Status() []SceneStatus {
	manager.mutex.Lock()
	defer manager.mutex.Unlock()
	var list []SceneStatus
	for _, template := range manager.cfg.Scenes.List {
		for _, open := range manager.lines[template.ID] {
			stats := &open.scene.stats
			list = append(list, SceneStatus{
				Scene:     template.ID,
				Name:      template.Name,
				Line:      open.scene.Line,
				Residents: open.residents,
				Players:   int(stats.players.Load()),
				Entities:  int(stats.entities.Load()),
				TickMs:    float64(stats.tickNanos.Load()) / 1e6,
				PeakMs:    float64(stats.peakNanos.Load()) / 1e6,
			})
		}
	}
	return list
}

// Config 是全局配置（server 读 AOI、地图等）。
func (manager *Manager) Config() *config.Config { return manager.cfg }
