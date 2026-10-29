package core

import "github.com/qinbaixi/BtDemo/internal/config"

// Zone 是地上的一块回血区（地图自带的，或技能放下的）。
type Zone struct {
	ID        int
	Cfg       *config.Zone
	X, Y      float64
	Faction   string        // 给哪个阵营（以及和它互不敌对的阵营）回血
	Owner     int           // 放下它的实体；0 表示地图自带
	Until     config.Millis // 消失的时刻；0 表示常驻
	NextPulse config.Millis // 下一次回血的时刻
}

// Zones 是世界里所有的回血区。区域很少，变化时整份重发给客户端，
// Version 每次增减都会变，会话靠它知道要不要重发。
type Zones struct {
	list    []*Zone
	nextID  int
	Version int
}

// Add 给 zone 分配 ID 并放进世界。
func (zones *Zones) Add(zone *Zone) {
	zones.nextID++
	zone.ID = zones.nextID
	zones.list = append(zones.list, zone)
	zones.Version++
}

// Replace 放下 zone，并移除同一个人之前放的区域（每人同时只能有一个）。
func (zones *Zones) Replace(zone *Zone) {
	zones.Filter(func(old *Zone) bool { return old.Owner != zone.Owner })
	zones.Add(zone)
}

// Filter 只保留 keep 返回 true 的区域。
func (zones *Zones) Filter(keep func(*Zone) bool) {
	kept := zones.list[:0]
	for _, zone := range zones.list {
		if keep(zone) {
			kept = append(kept, zone)
		}
	}
	if len(kept) < len(zones.list) {
		clear(zones.list[len(kept):])
		zones.Version++
	}
	zones.list = kept
}

// List 返回所有区域（按放下的先后顺序）。
func (zones *Zones) List() []*Zone { return zones.list }
