// Command server 运行 BtDemo 游戏服务器，并提供浏览器客户端。
package main

import (
	"context"
	"flag"
	"log"
	"net"
	"net/http"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game"
	"github.com/qinbaixi/BtDemo/internal/server"
	"github.com/qinbaixi/BtDemo/web"
)

func main() {
	addrFlag := flag.String("addr", "", "listen address, e.g. :9000 (default: addr in world.yaml)")
	cfgDir := flag.String(
		"config",
		"config",
		"folder with world.yaml, skills.yaml and monsters.yaml",
	)
	open := flag.Bool("open", false, "open the game in the default browser once the server is up")
	flag.Parse()

	cfg, err := config.Load(*cfgDir, game.TreeNames())
	if err != nil {
		log.Fatal(err)
	}
	world, err := game.NewWorld(cfg, time.Now().UnixNano())
	if err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go world.Run(ctx)

	addr := cfg.World.Addr
	if *addrFlag != "" {
		addr = config.NormalizeAddr(*addrFlag)
	}
	// 先监听，这样端口被占用时可以立即给出清晰的提示。
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("cannot listen on %s (is the port in use? change addr in %s or pass -addr): %v",
			addr, filepath.Join(*cfgDir, "world.yaml"), err)
	}
	url := "http://" + browserHost(listener.Addr())
	srv := &http.Server{Handler: server.Handler(world, web.FS)}
	go func() {
		<-ctx.Done()
		srv.Shutdown(context.Background())
	}()
	log.Printf("BtDemo listening on %s", url)
	if !web.Built {
		log.Printf("警告：没有嵌入前端构建产物，请先在 web 目录运行 npm ci && npm run build 再编译服务端")
	}
	if *open {
		openBrowser(url)
	}
	if err := srv.Serve(listener); err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// browserHost 返回浏览器连接该监听地址所用的 host:port；监听所有网卡接口时使用 localhost。
func browserHost(addr net.Addr) string {
	tcp, ok := addr.(*net.TCPAddr)
	if !ok {
		return addr.String()
	}
	host := "localhost"
	if !tcp.IP.IsUnspecified() {
		host = tcp.IP.String()
	}
	return net.JoinHostPort(host, strconv.Itoa(tcp.Port))
}

// openBrowser 尽力使用系统默认浏览器打开 url。
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("open browser: %v", err)
	}
}
