// Command bench 是带宽压测工具：开一批机器人连到游戏服务器，随机移动、偶尔放技能，
// 只统计收到的字节数和 WebSocket 帧数（不解码），结束时打印每个机器人的平均值和分位数。
//
//	go run ./cmd/bench -url ws://127.0.0.1:8098/ws -bots 200 -seconds 60
//
// 新旧版本的服务器都能压：旧版本不认识 Hello，但 ClientMsg 里未知字段会被忽略。
package main

import (
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand"
	"os"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/qinbaixi/BtDemo/internal/pb"
)

// botStats 是一个机器人收到的总量。
type botStats struct {
	bytes  atomic.Int64
	frames atomic.Int64
	failed atomic.Bool // 没连上或中途掉线
}

func main() {
	url := flag.String("url", "ws://127.0.0.1:8090/ws", "server websocket address")
	botCount := flag.Int("bots", 200, "number of bots")
	seconds := flag.Float64("seconds", 60, "how long to run")
	rampMillis := flag.Int("ramp", 2000, "spread bot connections over this many milliseconds")
	flag.Parse()

	stats := make([]*botStats, *botCount)
	stop := make(chan struct{})
	var group sync.WaitGroup
	for index := range stats {
		stats[index] = &botStats{}
		group.Add(1)
		go func() {
			defer group.Done()
			delay := time.Duration(index) * time.Duration(*rampMillis) * time.Millisecond / time.Duration(*botCount)
			select {
			case <-time.After(delay):
			case <-stop:
				return
			}
			runBot(*url, int64(index), stats[index], stop)
		}()
	}
	started := time.Now()
	time.Sleep(time.Duration(*seconds * float64(time.Second)))
	close(stop)
	group.Wait()
	report(stats, time.Since(started).Seconds()-float64(*rampMillis)/1000)
}

// runBot 连上服务器，先发 Hello，然后一边收（只计数）一边每 0.5~2 秒随机移动、偶尔放技能。
func runBot(url string, seed int64, stats *botStats, stop <-chan struct{}) {
	random := rand.New(rand.NewSource(seed))
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		log.Printf("bot %d: %v", seed, err)
		stats.failed.Store(true)
		return
	}
	defer conn.Close()
	send := func(msg *pb.ClientMsg) bool {
		data, _ := proto.Marshal(msg)
		return conn.WriteMessage(websocket.BinaryMessage, data) == nil
	}
	if !send(&pb.ClientMsg{Msg: &pb.ClientMsg_Hello{Hello: &pb.Hello{}}}) {
		stats.failed.Store(true)
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			stats.bytes.Add(int64(len(data)))
			stats.frames.Add(1)
		}
	}()
	for {
		wait := time.Duration(500+random.Intn(1500)) * time.Millisecond
		select {
		case <-stop:
			conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
				time.Now().Add(time.Second),
			)
			return
		case <-done:
			stats.failed.Store(true) // 服务器先断开了
			return
		case <-time.After(wait):
		}
		move := &pb.Move{Dx: proto.Float32(0), Dy: proto.Float32(0)}
		if random.Intn(5) != 0 {
			angle := random.Float64() * 2 * math.Pi
			move.Dx, move.Dy = proto.Float32(float32(math.Cos(angle))), proto.Float32(float32(math.Sin(angle)))
		}
		if !send(&pb.ClientMsg{Msg: &pb.ClientMsg_Move{Move: move}}) {
			stats.failed.Store(true)
			return
		}
		if random.Intn(4) == 0 {
			cast := &pb.Cast{Slot: proto.Int32(1)}
			send(&pb.ClientMsg{Msg: &pb.ClientMsg_Cast{Cast: cast}})
		}
	}
}

// report 打印每个机器人平均每秒的字节数、帧数，总量，以及机器人之间的 P50 / P95。
func report(stats []*botStats, seconds float64) {
	var bytesPerSecond, framesPerSecond []float64
	var totalBytes, totalFrames int64
	failed := 0
	for _, stat := range stats {
		if stat.failed.Load() {
			failed++
		}
		bytes, frames := stat.bytes.Load(), stat.frames.Load()
		totalBytes += bytes
		totalFrames += frames
		bytesPerSecond = append(bytesPerSecond, float64(bytes)/seconds)
		framesPerSecond = append(framesPerSecond, float64(frames)/seconds)
	}
	fmt.Fprintf(os.Stdout, "机器人 %d 个（掉线或没连上 %d 个），统计时长 %.1f 秒\n", len(stats), failed, seconds)
	fmt.Printf("总量: %d 字节 (%.2f MB), %d 帧\n", totalBytes, float64(totalBytes)/1e6, totalFrames)
	fmt.Printf(
		"每机器人每秒字节: 平均 %.0f  P50 %.0f  P95 %.0f\n",
		average(bytesPerSecond), percentile(bytesPerSecond, 0.50), percentile(bytesPerSecond, 0.95),
	)
	fmt.Printf(
		"每机器人每秒帧数: 平均 %.2f  P50 %.2f  P95 %.2f\n",
		average(framesPerSecond), percentile(framesPerSecond, 0.50), percentile(framesPerSecond, 0.95),
	)
}

func average(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sum := 0.0
	for _, value := range values {
		sum += value
	}
	return sum / float64(len(values))
}

// percentile 返回 values 的第 fraction 分位数（0~1，最近邻法）。
func percentile(values []float64, fraction float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := slices.Clone(values)
	slices.Sort(sorted)
	return sorted[min(len(sorted)-1, int(fraction*float64(len(sorted))))]
}
