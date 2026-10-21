// Command server runs the BtDemo game server and serves the browser client.
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
	cfgDir := flag.String("config", "config", "folder with world.yaml, skills.yaml and monsters.yaml")
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
	// Listen first so a busy port fails right away with a clear message.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("cannot listen on %s (is the port in use? change addr in %s or pass -addr): %v",
			addr, filepath.Join(*cfgDir, "world.yaml"), err)
	}
	url := "http://" + browserHost(ln.Addr())
	srv := &http.Server{Handler: server.Handler(world, web.FS)}
	go func() {
		<-ctx.Done()
		srv.Shutdown(context.Background())
	}()
	log.Printf("BtDemo listening on %s", url)
	if *open {
		openBrowser(url)
	}
	if err := srv.Serve(ln); err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// browserHost is host:port for a browser to reach the listener: localhost
// when it listens on every interface.
func browserHost(a net.Addr) string {
	tcp, ok := a.(*net.TCPAddr)
	if !ok {
		return a.String()
	}
	host := "localhost"
	if !tcp.IP.IsUnspecified() {
		host = tcp.IP.String()
	}
	return net.JoinHostPort(host, strconv.Itoa(tcp.Port))
}

// openBrowser opens url in the default browser, best effort.
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
