// Command server runs the BtDemo game server and serves the browser client.
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/qinbaixi/BtDemo/internal/config"
	"github.com/qinbaixi/BtDemo/internal/game"
	"github.com/qinbaixi/BtDemo/internal/server"
	"github.com/qinbaixi/BtDemo/web"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	cfgDir := flag.String("config", "config", "folder with world.yaml, skills.yaml and monsters.yaml")
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

	srv := &http.Server{Addr: *addr, Handler: server.Handler(world, web.FS)}
	go func() {
		<-ctx.Done()
		srv.Shutdown(context.Background())
	}()
	log.Printf("BtDemo listening on http://localhost%s", *addr)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
