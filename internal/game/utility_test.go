package game

import "testing"

// 骷髅弓手的“战斗”分支是效用选择：目标贴脸时“拉开距离”分数最高，先跑开；
// 离得远、看得见时“射击”分数最高。
func TestArcherUtilityFleesWhenClose(t *testing.T) {
	world := coverWorld(t)
	player := joinAt(world, 1450, 800).Player
	archer := world.Spawn.Template(world.State.Cfg.Templates["skeleton_archer"], 1400, 800)
	archer.SetTarget(player.ID)
	stepFor(world, 100)
	if archer.AI.Active != "flee" {
		t.Fatalf("archer next to its target should flee, got %q", archer.AI.Active)
	}
}

func TestArcherUtilityShootsFromAfar(t *testing.T) {
	world := coverWorld(t)
	player := joinAt(world, 1600, 800).Player
	archer := world.Spawn.Template(world.State.Cfg.Templates["skeleton_archer"], 1400, 800)
	archer.SetTarget(player.ID)
	stepFor(world, 100)
	if archer.Windup == nil && archer.AI.Active != "cast_skill" {
		t.Fatalf("archer in range with sight should shoot, got %q", archer.AI.Active)
	}
}
