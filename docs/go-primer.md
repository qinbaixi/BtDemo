# Go 速读：这个项目用到的写法

只讲 BtDemo 里真的出现的东西，每条都带一个项目里的例子。

## 包（package）和目录

一个目录就是一个包，目录名一般就是包名。包名小写，引用时写完整路径：

```go
import "github.com/qinbaixi/BtDemo/internal/game/core"

e := core.Entity{}      // 用 包名.名字 访问
```

**大写开头的名字才能被别的包使用**（相当于 public），小写开头的只在包内可见（private）。例如 `move.System` 的 `Toward` 能被 ai 包调用，`pos` 函数只有 move 包自己能用。

`internal/` 是 Go 的约定：里面的包只能被本仓库引用，外部项目不能 import。

## 结构体、方法、构造函数

Go 没有 class，用结构体加方法：

```go
// internal/game/combat/combat.go
type System struct {
    s    *core.State
    grid *aoi.Grid
}

func New(s *core.State, grid *aoi.Grid, at *attr.System) *System {   // 约定俗成的“构造函数”
    return &System{s: s, grid: grid, attr: at}
}

func (c *System) Cast(e *core.Entity, sk *config.Skill, targetID int) error {  // 方法
    ...
}
```

- `func (c *System) Cast(...)` 里的 `(c *System)` 叫接收者，相当于别的语言里的 `this`。
- `*System` 是指针。项目里的系统和实体几乎都用指针传递，这样修改会作用到同一个对象上。
- 每个系统包都有一个 `System` 类型和一个 `New(...)` 函数，这是统一的风格：看到 `combat.New` 就知道是创建战斗系统。

## 结构体嵌入（项目里的“组件”）

```go
// internal/game/core/entity.go
type Entity struct {
    Identity
    Transform
    Stats
    Combat
    ...
}

type Transform struct {
    X, Y   float64
    Radius float64
}
```

字段只写类型不写名字，叫嵌入。嵌入后可以直接写 `e.X`，等价于 `e.Transform.X`。项目用这个办法把实体的字段按用途分组（组件），读代码时看字段属于哪个组件，就知道是哪个系统负责它。

## 多返回值与错误

```go
x, y := sp.move.FreeSpot(e, x, y)        // 函数可以返回多个值

if err := n.combat.Cast(e, sk, target); err != nil {
    // 出错了：把 err.Error() 作为提示发给客户端
}
```

Go 没有异常，出错就返回一个 `error`，调用方用 `if err != nil` 检查。`:=` 是“声明并赋值”，`=` 是给已有变量赋值。

## 闭包（把函数当参数传）

```go
s.Ents.Each(func(e *core.Entity) {
    if e.Dead { return }
    ...
})
```

`Each` 接收一个函数，对每个实体调用它。这里的 `return` 只是结束这一次回调，相当于其他语言 forEach 里的 `continue`。行为树节点注册也是这种写法：

```go
reg.Task("chase_target", func(ctx *bt.Ctx) bt.Status { ... })
```

## map、切片

```go
cooldowns := map[string]float64{}   // 字典：技能 id -> 冷却结束时间
ids := []int{}                      // 切片：可变长数组
ids = append(ids, 3)                // 追加要接住返回值
v, ok := m[key]                     // ok 表示 key 是否存在
```

Go 遍历 map 的顺序是随机的。所以 `core.Entities` 额外维护了一个排好序的 id 切片，保证每帧按 id 顺序处理实体，同一个随机种子跑出的结果一样（测试依赖这一点）。

## 接口与类型断言

```go
type Ctx struct {
    Agent any        // any = 任意类型
}

a := ctx.Agent.(*Agent)   // 类型断言：我知道它其实是 *Agent
```

行为树运行时（`internal/bt`）不认识游戏里的实体，只把一个 `any` 传给节点函数；游戏代码再断言回 `*ai.Agent`。这样 bt 包不依赖 game 包，可以单独测试。

## goroutine 和 channel

```go
go world.Run(ctx)            // go 关键字：开一个并发执行的 goroutine（轻量线程）

inbox := make(chan func(), 256)   // channel：goroutine 之间传数据的队列
inbox <- fn                       // 发送
fn := <-inbox                     // 接收

select {                          // 同时等多个 channel，哪个先来处理哪个
case fn := <-w.inbox:
    fn()
case <-ticker.C:
    w.Step()
}
```

这个项目的并发模型只有一条规则：**游戏状态只在 World 的 goroutine 里读写**。网络 goroutine 想改状态时，把要做的事包成函数，通过 `World.Do(fn)` 发进 inbox，由 World 的 goroutine 执行。详见[整体架构](architecture.md)。

## defer

```go
defer conn.Close()   // 函数返回时自动执行，常用于释放资源
```

## 代码生成

```go
//go:generate go run ../../../tools/btregistry
```

`go generate ./internal/ai/trees` 会执行这行注释里的命令，生成 `registry.go`。`internal/pb/` 也是生成的（`protoc` 根据 `proto/btdemo.proto` 生成）。文件头写着 `DO NOT EDIT` 的都不要手改。

## go:embed

```go
// web/embed.go
//go:embed all:dist
var files embed.FS
```

编译时把前端构建产物 `web/dist` 整个打进二进制，所以发布时只要一个 exe 加 `config/` 目录。副作用是改了前端必须先 `npm run build` 再重新 `go build` 才能看到；开发前端时用 `npm run dev` 就不用每次重编服务端。`all:` 前缀表示连 `.gitkeep` 这种点开头的文件也嵌进去，保证没构建前端时也能编译。

## 常用命令

```bash
go run ./cmd/server          # 编译并运行
go build -o btdemo ./cmd/server
go test ./...                # 跑所有测试；./... 表示当前目录下所有包
go test ./internal/game/nav -run TestFindPath -v   # 只跑一个测试并打印详情
go vet ./...                 # 静态检查
gofmt -w .                   # 格式化（CI 会检查）
```

测试文件以 `_test.go` 结尾，和被测代码放在同一个目录。
